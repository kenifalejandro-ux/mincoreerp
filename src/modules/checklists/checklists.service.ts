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
import { crearOrdenDeHallazgo } from "../ordenes_trabajo/ordenDeHallazgo";
import { ChecklistsRepository } from "./checklists.repository";
import { preguntasCriticas } from "./checklists.criticas";

/** El checklist y lo que arrastra, en la misma transacción: la lectura del medidor y, si falló un punto
 *  crítico, la orden de trabajo. Ninguna de las dos puede hacer que se pierda el checklist: lo que no se
 *  pueda hacer queda escrito en `aviso_registro`. */
async function registrarChecklist(
  client: PoolClient,
  tenantId: string,
  usuarioId: string,
  data: CrearChecklistInput
) {
  const criticas = await preguntasCriticas(
    client,
    tenantId,
    data.plantilla_id,
    data.plantilla_version
  );
  const items = data.items.map((i) => ({ ...i, critica: criticas.has(i.descripcion) }));
  const fila = await ChecklistsRepository.crear(client, tenantId, usuarioId, { ...data, items });
  let aviso: string | null = null;
  if (data.lectura && data.equipo_id !== undefined) {
    aviso = await dejarLectura(client, tenantId, usuarioId, data.equipo_id, data.lectura);
    if (aviso) await ChecklistsRepository.guardarAviso(client, tenantId, fila.id, aviso);
  }

  let ordenId: number | null = null;
  const fallas = items.filter((i) => i.critica && i.estado === "malo");
  if (fallas.length > 0) {
    ordenId = await crearOrdenDeHallazgo(client, tenantId, usuarioId, {
      checklistId: fila.id,
      equipoId: data.equipo_id ?? null,
      activoTexto: data.activo_texto || null,
      nombreActivo: await ChecklistsRepository.nombreDelActivo(client, tenantId, data),
      fallas,
    });
  }

  return { ...fila, aviso_registro: aviso, orden_trabajo_id: ordenId };
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
  getAll(client: PoolClient, tenantId: string, paginacion: CursorPaginacion, conUnidades = true) {
    return ChecklistsRepository.findAll(client, tenantId, paginacion, conUnidades);
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
    conUnidades = true
  ) {
    return idempotentInsert({
      client,
      tenantId,
      modulo: "checklists",
      clienteUuid: data.cliente_uuid,
      insertar: async () => {
        const fila = await registrarChecklist(client, tenantId, usuarioId, data);
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
