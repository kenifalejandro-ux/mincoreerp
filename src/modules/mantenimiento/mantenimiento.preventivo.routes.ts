/** src/modules/mantenimiento/mantenimiento.preventivo.routes.ts
 *
 * `/mantenimiento/preventivo`: el resumen, los servicios realizados y las lecturas del medidor, para que una
 * empresa con solo este módulo pueda mantenerlas al día. El módulo asignado deja mirar; escriben admin y
 * operador. */
import { Router, type Request, type Response } from "express";

import { withTenant } from "../../server/config/database";
import { validate } from "../../server/middleware/validate";
import type { RegistrarLecturaInput } from "../../server/schemas/equipos.schema";
import {
  anularServicioSchema,
  lecturaDeMantenimientoSchema,
  registrarServicioSchema,
  type AnularServicioInput,
  type RegistrarServicioInput,
} from "../../server/schemas/mantenimientoServicios.schema";
import { registrarAuditoria } from "../../server/services/platformAudit.service";
import { AppError } from "../../server/shared/middlewares/error.middleware";
import { requireRole } from "../../server/shared/middlewares/roles.middleware";
import { asyncHandler } from "../../server/shared/utils/asyncHandler";
import { contextoAuditoriaModulo } from "../../server/shared/utils/moduleAudit";
import { getTenantId } from "../../server/shared/utils/request";
import { anularLectura, listarLecturas } from "../equipos/equipos.lecturas";
import {
  anularServicio,
  exigirLecturaSinServicio,
  registrarLecturaDeMantenimiento,
  registrarServicio,
  resumenPreventivo,
  serviciosDeEquipo,
} from "./mantenimiento.preventivo";

const router = Router();
const escribe = requireRole("admin", "operador");

/** Un id que no cabe en la base es algo que no existe: 404 y no un 500. */
function idDe(valor: string | string[], mensaje: string) {
  const id = Number(valor);
  if (!Number.isInteger(id) || id > 2_147_483_647) throw new AppError(404, mensaje);
  return id;
}
const equipoDe = (req: Request) => idDe(req.params.id, "El equipo no existe");

const auditar = (req: Request, accion: string, detalle: Record<string, unknown>) =>
  registrarAuditoria({
    accion,
    tenantId: getTenantId(req),
    usuarioId: req.usuario!.id,
    detalle,
    contexto: contextoAuditoriaModulo(req),
  });

router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    res.json(await withTenant(tenantId, (client) => resumenPreventivo(client, tenantId)));
  })
);

router.post(
  "/servicios",
  escribe,
  validate(registrarServicioSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    const data = req.validatedBody as RegistrarServicioInput;
    const { fila, creado } = await withTenant(tenantId, (client) =>
      registrarServicio(client, tenantId, req.usuario!.id, data)
    );
    if (creado) {
      await auditar(req, "mantenimiento.servicio_registrar", {
        servicioId: fila.id,
        equipoId: data.equipo_id,
      });
    }
    res.status(creado ? 201 : 200).json(fila ?? { ok: true });
  })
);

router.patch(
  "/servicios/:id(\\d+)/anular",
  escribe,
  validate(anularServicioSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    const { motivo } = req.validatedBody as AnularServicioInput;
    const id = idDe(req.params.id, "El servicio no existe");
    const servicio = await withTenant(tenantId, (client) =>
      anularServicio(client, tenantId, req.usuario!.id, id, motivo)
    );
    await auditar(req, "mantenimiento.servicio_anular", { servicioId: id, motivo });
    res.json(servicio);
  })
);

router.get(
  "/equipos/:id(\\d+)/servicios",
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    const equipoId = equipoDe(req);
    res.json({
      servicios: await withTenant(tenantId, (client) =>
        serviciosDeEquipo(client, tenantId, equipoId)
      ),
    });
  })
);

router.get(
  "/equipos/:id(\\d+)/lecturas",
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    const equipoId = equipoDe(req);
    res.json({
      lecturas: await withTenant(tenantId, (client) =>
        listarLecturas(client, tenantId, equipoId, 50)
      ),
    });
  })
);

router.post(
  "/equipos/:id(\\d+)/lecturas",
  escribe,
  validate(lecturaDeMantenimientoSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    const equipoId = equipoDe(req);
    const data = req.validatedBody as RegistrarLecturaInput;
    const { fila, creado } = await withTenant(tenantId, (client) =>
      registrarLecturaDeMantenimiento(client, tenantId, req.usuario!.id, equipoId, data)
    );
    if (creado) {
      await auditar(req, "mantenimiento.lectura_registrar", { equipoId, lecturaId: fila.id });
    }
    res.status(creado ? 201 : 200).json(fila ?? { ok: true });
  })
);

router.patch(
  "/equipos/:id(\\d+)/lecturas/:lecturaId(\\d+)/anular",
  escribe,
  validate(anularServicioSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    const equipoId = equipoDe(req);
    const lecturaId = idDe(req.params.lecturaId, "La lectura no existe");
    const { motivo } = req.validatedBody as AnularServicioInput;
    const lectura = await withTenant(tenantId, async (client) => {
      await exigirLecturaSinServicio(client, tenantId, lecturaId);
      return anularLectura(client, tenantId, req.usuario!.id, equipoId, lecturaId, motivo);
    });
    await auditar(req, "mantenimiento.lectura_anular", { equipoId, lecturaId, motivo });
    res.json(lectura);
  })
);

export default router;
