import type { Request, Response } from "express";
import { withTenant } from "../../server/config/database";
import { getTenantId } from "../../server/shared/utils/request";
import { contextoAuditoriaModulo } from "../../server/shared/utils/moduleAudit";
import { registrarAuditoria } from "../../server/services/platformAudit.service";
import { publicarEventoTenant } from "../../server/services/realtimeEvents.service";
import { pestanaPermitida } from "../../server/services/permisosPestanas.service";
import type {
  AnularViajeInput,
  CerrarViajeInput,
  CrearLugarInput,
  CrearViajeInput,
  EditarViajeInput,
  IniciarViajeInput,
  ListarViajesQuery,
} from "../../server/schemas/combustible.schema";
import { ambitoDe } from "./alcance";
import * as viajes from "./viajes.service";

const EVENTO = "combustible.viaje_actualizado";

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
      viajes.cargasDelViaje(c, tenantId, id, ambitoDe(req))
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
        cuenta_como: antes.cuenta_como,
        conductor_nombre: antes.conductor_nombre,
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
