/** src/modules/checklists/checklists.service.ts */

import type { PoolClient } from "pg";
import type { Paginacion, CursorPaginacion } from "../../server/shared/utils/pagination";
import type {
  CrearPlantillaInput,
  CrearChecklistInput,
} from "../../server/schemas/checklists.schema";
import { idempotentInsert } from "../../server/shared/utils/idempotentInsert";
import { AppError } from "../../server/shared/middlewares/error.middleware";
import { CuotaExcedidaError, verificarCuota } from "../../server/services/platformCuotas.service";
import { registrarLectura } from "../equipos/equipos.lecturas";
import { ordenarFallas, pideOrdenAutomatica } from "../ordenes_trabajo/ordenDeHallazgo";
import { ChecklistsRepository } from "./checklists.repository";
import { preguntasCriticas } from "./checklists.criticas";

/** El checklist y lo que arrastra, en la misma transacción: la lectura del medidor y, si falló un punto
 *  crítico, la orden de trabajo. Ninguna de las dos puede hacer que se pierda el checklist: lo que no se
 *  pueda hacer queda escrito en `aviso_registro`. */
async function registrarChecklist(
  client: PoolClient,
  tenantId: string,
  usuarioId: string,
  data: CrearChecklistInput,
  puedeOmitir: boolean
) {
  const criticas = await preguntasCriticas(
    client,
    tenantId,
    data.plantilla_id,
    data.plantilla_version
  );
  // Toda pregunta crítica se responde. Quien tiene el permiso puede dejarla: queda «N/A», anotado.
  const respondidas = new Set(data.items.map((i) => i.descripcion));
  const sinResponder = [...criticas].filter((c) => !respondidas.has(c));
  if (sinResponder.length > 0 && !puedeOmitir) {
    throw new AppError(400, `Falta responder: ${sinResponder.join(", ")}`);
  }
  const items = [
    ...data.items,
    ...sinResponder.map((descripcion) => ({
      descripcion,
      estado: "na" as const,
      observacion: "Sin responder",
    })),
  ].map((i) => ({ ...i, critica: criticas.has(i.descripcion) }));
  if (items.length === 0) throw new AppError(400, "El checklist necesita al menos un ítem");
  const fila = await ChecklistsRepository.crear(client, tenantId, usuarioId, { ...data, items });
  const avisos: string[] = [];
  if (sinResponder.length > 0) {
    avisos.push(`Preguntas críticas sin responder: ${sinResponder.join(", ")}.`);
  }
  if (data.lectura && data.equipo_id !== undefined) {
    const deLectura = await dejarLectura(client, tenantId, usuarioId, data.equipo_id, data.lectura);
    if (deLectura) avisos.push(deLectura);
  }
  const aviso = avisos.length > 0 ? avisos.join(" ").slice(0, 600) : null;
  if (aviso) await ChecklistsRepository.guardarAviso(client, tenantId, fila.id, aviso);

  let ordenNueva: number | null = null;
  const fallas = items.filter((i) => i.critica && i.estado === "malo");
  if (fallas.length > 0 && (await pideOrdenAutomatica(client, tenantId))) {
    ordenNueva = await ordenarFallas(
      client,
      tenantId,
      usuarioId,
      {
        checklistId: fila.id,
        equipoId: data.equipo_id ?? null,
        activoTexto: data.activo_texto || null,
        nombreActivo: await ChecklistsRepository.nombreDelActivo(client, tenantId, data),
        fallas,
      },
      { titulo: "Falla crítica en checklist", prioridad: "urgente", noOpera: true }
    );
  }

  const guardado = await ChecklistsRepository.findById(
    client,
    tenantId,
    fila.id,
    data.equipo_id !== undefined
  );
  // `orden_nueva_id`: la que nació ahora (se audita); las demás ya existían y cubren la misma falla.
  return {
    ...fila,
    aviso_registro: aviso,
    orden_trabajo_id: guardado!.orden_trabajo_id,
    ordenes_trabajo: guardado!.ordenes_trabajo,
    orden_nueva_id: ordenNueva,
  };
}

/** Devuelve por qué no se pudo dejar la lectura, o null si quedó registrada. */
async function dejarLectura(
  client: PoolClient,
  tenantId: string,
  usuarioId: string,
  equipoId: number,
  lectura: NonNullable<CrearChecklistInput["lectura"]>
): Promise<string | null> {
  try {
    await verificarCuota(tenantId, "equipo_lecturas", 1, client);
    await registrarLectura(client, tenantId, usuarioId, equipoId, lectura, "checklist");
    return null;
  } catch (err) {
    if (err instanceof CuotaExcedidaError) {
      return "No se registró la lectura: la empresa llegó a su límite de lecturas.";
    }
    // 400 = la regla del medidor (retrocede, o la unidad no lo tiene configurado). Se lanza antes de
    // escribir nada, así que la transacción sigue sana.
    if (err instanceof AppError && err.statusCode === 400) {
      return `No se registró la lectura. ${err.message}.`.slice(0, 600);
    }
    throw err;
  }
}

export const ChecklistsService = {
  getPlantillas(client: PoolClient, tenantId: string, paginacion: Paginacion) {
    return ChecklistsRepository.findPlantillas(client, tenantId, paginacion);
  },

  getPlantilla(client: PoolClient, tenantId: string, id: number) {
    return ChecklistsRepository.findPlantillaConItems(client, tenantId, id);
  },

  crearPlantilla(client: PoolClient, tenantId: string, data: CrearPlantillaInput) {
    return ChecklistsRepository.crearPlantilla(client, tenantId, data);
  },

  eliminarPlantilla(client: PoolClient, tenantId: string, id: number) {
    return ChecklistsRepository.eliminarPlantilla(client, tenantId, id);
  },

  /** `conUnidades`: el usuario tiene un módulo que mantiene unidades (Flota o Mantenimiento). Sin él no se lee `equipos` (ver `opcionales`). */
  getAll(
    client: PoolClient,
    tenantId: string,
    paginacion: CursorPaginacion,
    conUnidades = true,
    soloPorAutorizar = false
  ) {
    return ChecklistsRepository.findAll(
      client,
      tenantId,
      paginacion,
      conUnidades,
      soloPorAutorizar
    );
  },

  getById(client: PoolClient, tenantId: string, id: number, conUnidades = true) {
    return ChecklistsRepository.findById(client, tenantId, id, conUnidades);
  },

  /** Devuelve `creado: false` cuando el checklist ya se había creado con
   *  este mismo `cliente_uuid` — o sea, cuando esto es el reintento de un
   *  envío cuya respuesta se perdió. El controller usa ese flag para no
   *  auditar ni publicar el evento dos veces. Sin `cliente_uuid` en el
   *  body, se comporta igual que antes: siempre crea. */
  crear(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    data: CrearChecklistInput,
    conUnidades = true,
    puedeOmitir = false
  ) {
    return idempotentInsert({
      client,
      tenantId,
      modulo: "checklists",
      clienteUuid: data.cliente_uuid,
      insertar: async () => {
        const fila = await registrarChecklist(client, tenantId, usuarioId, data, puedeOmitir);
        return { id: fila.id as number, fila };
      },
      // findById devuelve un superset de lo que devuelve crear() (suma
      // placa_codigo y usuario_nombre por los JOIN) — así el reintento
      // nunca responde con MENOS datos que el intento original.
      recuperar: (filaId) => ChecklistsRepository.findById(client, tenantId, filaId, conUnidades),
    });
  },

  eliminar(client: PoolClient, tenantId: string, id: number) {
    return ChecklistsRepository.eliminar(client, tenantId, id);
  },
};
