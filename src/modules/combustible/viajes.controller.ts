import type { Request, Response } from "express";
import { withTenant } from "../../server/config/database";
import { getTenantId } from "../../server/shared/utils/request";
import { contextoAuditoriaModulo } from "../../server/shared/utils/moduleAudit";
import { registrarAuditoria } from "../../server/services/platformAudit.service";
import { publicarEventoTenant } from "../../server/services/realtimeEvents.service";
import { pestanaPermitida } from "../../server/services/permisosPestanas.service";
import type {
  AnularViajeInput,
  CerrarMiViajeInput,
  CerrarViajeInput,
  CorregirMandoInput,
  CrearLugarInput,
  CrearViajeInput,
  EditarViajeInput,
  HistorialMioQuery,
  IniciarMiViajeInput,
  IniciarViajeInput,
  ListarViajesQuery,
} from "../../server/schemas/combustible.schema";
import { ambitoDe } from "./alcance";
import * as viajes from "./viajes.service";

const EVENTO = "combustible.viaje_actualizado";

type CuerpoMarca = {
  medidor?: number | null;
  orden?: number;
  marcado_en?: string;
  cliente_uuid?: string;
  llegada_en?: string;
  salida_en?: string;
  motivo?: string;
};

type CuerpoDescanso = {
  motivo?: string | null;
  marcado_en?: string;
  cliente_uuid?: string;
  inicio_en?: string;
  fin_en?: string;
};

/** Empezar o terminar un descanso: el del propio conductor (por su DNI, con uuid y hora del
 *  celular) o el de la oficina por él (motivo obligatorio al empezar). */
function marcaDeDescanso(que: "inicio" | "fin", delConductor: boolean) {
  return async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    const id = Number(req.params.viajeId);
    const b = req.validatedBody as CuerpoDescanso;
    const marca = {
      motivo: b.motivo,
      marcado_en: b.marcado_en,
      cliente_uuid: b.cliente_uuid,
      hora: que === "inicio" ? b.inicio_en : b.fin_en,
    };
    const dni = delConductor ? (req.usuario!.dni ?? "") : undefined;
    const r = await withTenant(tenantId, (c) =>
      que === "inicio"
        ? viajes.iniciarDescanso(c, tenantId, req.usuario!.id, id, marca, dni)
        : viajes.terminarDescanso(c, tenantId, req.usuario!.id, id, marca, dni)
    );
    if (!r.repetido) {
      await auditar(req, `viaje_descanso_${que === "inicio" ? "iniciar" : "terminar"}`, {
        viajeId: id,
        numero: r.antes.numero,
        por: delConductor ? "conductor" : "oficina",
        motivo: b.motivo ?? null,
        manual: marca.hora !== undefined,
      });
    }
    res.json(r.despues);
  };
}

/** Llegada o salida de una parada: la del propio conductor (por su DNI, con
 *  uuid y hora del celular) o la de la oficina por él (hora a mano y motivo). */
function marcaDeParada(que: "llegada" | "salida", delConductor: boolean) {
  return async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    const id = Number(req.params.viajeId);
    const b = req.validatedBody as CuerpoMarca;
    const marca = {
      medidor: b.medidor,
      orden: b.orden,
      marcado_en: b.marcado_en,
      cliente_uuid: b.cliente_uuid,
      hora: que === "llegada" ? b.llegada_en : b.salida_en,
    };
    const dni = delConductor ? (req.usuario!.dni ?? "") : undefined;
    const r = await withTenant(tenantId, (c) =>
      que === "llegada"
        ? viajes.llegarAParada(c, tenantId, req.usuario!.id, id, marca, dni)
        : viajes.salirDeParada(c, tenantId, req.usuario!.id, id, marca, dni)
    );
    if (!r.repetido) {
      await auditar(req, r.cierra ? "viaje_cerrar" : `viaje_${que}`, {
        viajeId: id,
        numero: r.antes.numero,
        parada: r.orden,
        por: delConductor ? "conductor" : "oficina",
        medidor: b.medidor ?? null,
        motivo: b.motivo,
        manual: marca.hora !== undefined,
      });
    }
    res.json(r.despues);
  };
}

/** Entregar, aceptar o retirar el mando: siempre lo hace el conductor, por su DNI. */
function marcaDeMando(que: "entregar" | "aceptar" | "retirar") {
  return async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    const id = Number(req.params.viajeId);
    const b = (req.validatedBody ?? {}) as { medidor?: number | null; lugar?: string | null } & {
      marcado_en?: string;
      cliente_uuid?: string;
    };
    const dni = req.usuario!.dni ?? "";
    const usuarioId = req.usuario!.id;
    const r = await withTenant(tenantId, (c) =>
      que === "entregar"
        ? viajes.entregarMando(c, tenantId, usuarioId, id, b, dni)
        : que === "aceptar"
          ? viajes.aceptarMando(c, tenantId, usuarioId, id, b, dni)
          : viajes.retirarEntrega(c, tenantId, usuarioId, id, dni)
    );
    if (!r.repetido) {
      await auditar(req, `viaje_mando_${que}`, {
        viajeId: id,
        numero: r.antes.numero,
        por: "conductor",
        medidor: b.medidor ?? null,
        lugar: b.lugar ?? null,
      });
    }
    res.json(r.despues);
  };
}

async function auditar(req: Request, accion: string, detalle: Record<string, unknown>) {
  const tenantId = getTenantId(req);
  await registrarAuditoria({
    accion: `combustible.${accion}`,
    tenantId,
    usuarioId: req.usuario!.id,
    detalle,
    contexto: contextoAuditoriaModulo(req),
  });
  await publicarEventoTenant(tenantId, EVENTO, {});
}

export const viajesController = {
  async listarLugares(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    res.json({ data: await withTenant(tenantId, (c) => viajes.listarLugares(c, tenantId)) });
  },

  async crearLugar(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    const { nombre } = req.validatedBody as CrearLugarInput;
    const lugar = await withTenant(tenantId, (c) =>
      viajes.crearLugar(c, tenantId, req.usuario!.id, nombre)
    );
    await auditar(req, "lugar_crear", { lugarId: lugar.id, nombre: lugar.nombre });
    res.status(201).json(lugar);
  },

  /** GET /viajes (panel de gestión) y GET /viajes/consumo (Histórico): la
   *  misma consulta, con permisos distintos. */
  async listar(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    const q = req.validatedQuery as ListarViajesQuery;
    const filas = await withTenant(tenantId, (c) =>
      viajes.listarViajes(c, tenantId, q, ambitoDe(req))
    );
    res.json({ data: filas });
  },

  /** El resumen de cada conductor en un período (km, horas al volante, puntualidad y consumo). */
  async resumenConductores(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    const q = req.validatedQuery as ListarViajesQuery;
    const filas = await withTenant(tenantId, (c) =>
      viajes.resumenPorConductor(c, tenantId, q, ambitoDe(req))
    );
    res.json({ data: filas });
  },

  /** El Histórico de cada producto tiene su propio permiso: combustible pide
   *  la vista "Por viaje", urea la consulta de Urea. */
  async listarConsumo(req: Request, res: Response) {
    const q = req.validatedQuery as ListarViajesQuery;
    const pestana = q.producto === "urea" ? "urea:vista" : "historico:por_viaje";
    const u = req.usuario!;
    if (
      !pestanaPermitida(
        { rol: u.rol, permisosPestanas: u.permisosPestanas },
        "combustible",
        pestana
      )
    ) {
      res.status(403).json({ ok: false, message: "Pestaña no disponible para este perfil" });
      return;
    }
    return viajesController.listar(req, res);
  },

  async detalle(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    const id = Number(req.params.viajeId);
    const r = await withTenant(tenantId, (c) =>
      viajes.cargasDelViaje(c, tenantId, id, ambitoDe(req), true)
    );
    if (!r) {
      res.status(404).json({ error: "El viaje no existe" });
      return;
    }
    res.json(r);
  },

  async crear(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    const data = req.validatedBody as CrearViajeInput;
    const viaje = await withTenant(tenantId, (c) =>
      viajes.crearViaje(c, tenantId, req.usuario!.id, data)
    );
    await auditar(req, "viaje_crear", { viajeId: viaje.id, numero: viaje.numero, ...data });
    res.status(201).json(viaje);
  },

  async medidorPrevio(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    const id = Number(req.params.viajeId);
    const r = await withTenant(tenantId, async (c) => {
      const v = await viajes.getViaje(c, tenantId, id);
      return v ? viajes.medidorPrevio(c, tenantId, v.equipo_id) : null;
    });
    if (!r) {
      res.status(404).json({ error: "El viaje no existe" });
      return;
    }
    res.json(r);
  },

  async iniciar(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    const id = Number(req.params.viajeId);
    const data = req.validatedBody as IniciarViajeInput;
    const { antes, despues } = await withTenant(tenantId, (c) =>
      viajes.iniciarViaje(c, tenantId, req.usuario!.id, id, data)
    );
    await auditar(req, "viaje_iniciar", {
      viajeId: id,
      numero: antes.numero,
      manual: data.inicio_en !== undefined,
      ...data,
      medidor_previo: despues?.medidor_previo ?? null,
    });
    res.json(despues);
  },

  /** GET /viajes/mios: lo que ve el conductor en "Mi viaje", por su DNI. */
  async mios(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    const dni = req.usuario!.dni ?? "";
    const data = await withTenant(tenantId, (c) => viajes.viajesDelConductor(c, tenantId, dni));
    res.json({ data, sinDni: !dni.trim() });
  },

  /** GET /viajes/mios/historial: sus viajes cerrados, por páginas. */
  async historialMio(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    const dni = req.usuario!.dni ?? "";
    const { limite, antes } = req.validatedQuery as HistorialMioQuery;
    const r = await withTenant(tenantId, (c) =>
      viajes.historialDelConductor(c, tenantId, dni, limite, antes)
    );
    res.json({ ...r, sinDni: !dni.trim() });
  },

  /** GET /viajes/mi-unidad: la unidad del viaje del conductor, para precargar
   *  la compra en ruta. Sin viaje (o sin DNI) devuelve data: null y todo sigue manual. */
  async miUnidad(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    const dni = req.usuario!.dni ?? "";
    const data = await withTenant(tenantId, (c) => viajes.unidadDelViajeActivo(c, tenantId, dni));
    res.json({ data });
  },

  async conductores(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    res.json({ data: await withTenant(tenantId, (c) => viajes.listarConductores(c, tenantId)) });
  },

  async iniciarMio(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    const id = Number(req.params.viajeId);
    const data = req.validatedBody as IniciarMiViajeInput;
    const r = await withTenant(tenantId, (c) =>
      viajes.iniciarViaje(c, tenantId, req.usuario!.id, id, data, req.usuario!.dni ?? "")
    );
    if (!r.repetido) {
      await auditar(req, "viaje_iniciar", {
        viajeId: id,
        numero: r.antes.numero,
        por: "conductor",
        origen_hora: r.despues?.inicio_origen_hora,
        ...data,
        medidor_previo: r.despues?.medidor_previo ?? null,
      });
    }
    res.json(r.despues);
  },

  async cerrarMio(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    const id = Number(req.params.viajeId);
    const data = req.validatedBody as CerrarMiViajeInput;
    const r = await withTenant(tenantId, (c) =>
      viajes.cerrarViaje(c, tenantId, req.usuario!.id, id, data, req.usuario!.dni ?? "")
    );
    if (!r.repetido) {
      await auditar(req, "viaje_cerrar", {
        viajeId: id,
        numero: r.antes.numero,
        por: "conductor",
        origen_hora: r.despues?.fin_origen_hora,
        ...data,
      });
    }
    res.json(r.despues);
  },

  descansoMio: marcaDeDescanso("inicio", true),
  terminarDescansoMio: marcaDeDescanso("fin", true),
  descanso: marcaDeDescanso("inicio", false),
  terminarDescanso: marcaDeDescanso("fin", false),
  entregarMando: marcaDeMando("entregar"),
  aceptarMando: marcaDeMando("aceptar"),
  retirarEntrega: marcaDeMando("retirar"),

  /** La oficina corrige un cambio de mando que nadie marcó (con motivo). */
  async corregirMando(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    const id = Number(req.params.viajeId);
    const data = req.validatedBody as CorregirMandoInput;
    const r = await withTenant(tenantId, (c) =>
      viajes.corregirMando(c, tenantId, req.usuario!.id, id, data)
    );
    await auditar(req, "viaje_mando_corregir", {
      viajeId: id,
      numero: r.antes.numero,
      por: "oficina",
      a_dni: data.a_dni,
      cambio_en: data.cambio_en,
      medidor: data.medidor ?? null,
      motivo: data.motivo,
    });
    res.json(r.despues);
  },
  llegadaMia: marcaDeParada("llegada", true),
  salidaMia: marcaDeParada("salida", true),
  llegada: marcaDeParada("llegada", false),
  salida: marcaDeParada("salida", false),

  async cerrar(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    const id = Number(req.params.viajeId);
    const data = req.validatedBody as CerrarViajeInput;
    const { antes, despues } = await withTenant(tenantId, (c) =>
      viajes.cerrarViaje(c, tenantId, req.usuario!.id, id, data)
    );
    await auditar(req, "viaje_cerrar", {
      viajeId: id,
      numero: antes.numero,
      manual: data.fin_en !== undefined,
      ...data,
    });
    res.json(despues);
  },

  async editar(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    const id = Number(req.params.viajeId);
    const data = req.validatedBody as EditarViajeInput;
    const { antes, despues } = await withTenant(tenantId, (c) =>
      viajes.editarViaje(c, tenantId, id, data)
    );
    const { motivo, ...cambios } = data;
    await auditar(req, "viaje_editar", {
      viajeId: id,
      numero: antes.numero,
      motivo,
      antes: {
        origen_id: antes.origen_id,
        destino_id: antes.destino_id,
        inicio_en: antes.inicio_en,
        fin_en: antes.fin_en,
        medidor_inicio: antes.medidor_inicio,
        medidor_fin: antes.medidor_fin,
        conductor_nombre: antes.conductor_nombre,
        salida_programada_en: antes.salida_programada_en,
        desfase_tolerancia_min: antes.desfase_tolerancia_min,
      },
      cambios,
    });
    res.json(despues);
  },

  async anular(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    const id = Number(req.params.viajeId);
    const { motivo } = req.validatedBody as AnularViajeInput;
    const antes = await withTenant(tenantId, (c) =>
      viajes.anularViaje(c, tenantId, req.usuario!.id, id, motivo)
    );
    await auditar(req, "viaje_anular", { viajeId: id, numero: antes.numero, motivo });
    res.json({ ok: true });
  },
};
