/** src/modules/mantenimiento/mantenimiento.planes.routes.ts
 *
 * `/mantenimiento/planes`: los planes de mantenimiento preventivo (M9). Mismas reglas de acceso que el resto del
 * ecosistema: el módulo asignado deja mirar; escriben admin y operador. */
import { Router, type Request, type Response } from "express";

import { withTenant } from "../../server/config/database";
import { validate } from "../../server/middleware/validate";
import {
  actualizarPlanSchema,
  crearPlanSchema,
  type ActualizarPlanInput,
  type CrearPlanInput,
} from "../../server/schemas/mantenimientoPlanes.schema";
import { registrarAuditoria } from "../../server/services/platformAudit.service";
import { AppError } from "../../server/shared/middlewares/error.middleware";
import { requireRole } from "../../server/shared/middlewares/roles.middleware";
import { asyncHandler } from "../../server/shared/utils/asyncHandler";
import { contextoAuditoriaModulo } from "../../server/shared/utils/moduleAudit";
import { getTenantId } from "../../server/shared/utils/request";
import { actualizarPlan, crearPlan, listarPlanes, quitarPlan } from "./mantenimiento.planes";

const router = Router();
const escribe = requireRole("admin", "operador");

const MENSAJE_REPETIDO = "Ya hay un plan para ese tipo de equipo";

/** Un plan por tipo: la segunda alta (o un cambio de tipo que choca) la corta el índice único. */
async function unoPorTipo<T>(trabajo: () => Promise<T>): Promise<T> {
  try {
    return await trabajo();
  } catch (error) {
    if ((error as { code?: string }).code === "23505") throw new AppError(409, MENSAJE_REPETIDO);
    throw error;
  }
}

/** Un id que no cabe en la base no es un plan: 404 y no un 500. */
function idDe(req: Request) {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id)) throw new AppError(404, "El plan no existe");
  return id;
}

const auditar = (req: Request, accion: string, planId: number) =>
  registrarAuditoria({
    accion,
    tenantId: getTenantId(req),
    usuarioId: req.usuario!.id,
    detalle: { planId },
    contexto: contextoAuditoriaModulo(req),
  });

router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    res.json(await withTenant(tenantId, (client) => listarPlanes(client, tenantId)));
  })
);

router.post(
  "/",
  escribe,
  validate(crearPlanSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    const data = req.validatedBody as CrearPlanInput;
    const plan = await unoPorTipo(() =>
      withTenant(tenantId, (client) => crearPlan(client, tenantId, req.usuario!.id, data))
    );
    await auditar(req, "mantenimiento.plan_crear", plan.id);
    res.status(201).json(plan);
  })
);

router.put(
  "/:id(\\d+)",
  escribe,
  validate(actualizarPlanSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    const data = req.validatedBody as ActualizarPlanInput;
    const id = idDe(req);
    const plan = await unoPorTipo(() =>
      withTenant(tenantId, (client) => actualizarPlan(client, tenantId, req.usuario!.id, id, data))
    );
    await auditar(req, "mantenimiento.plan_actualizar", plan.id);
    res.json(plan);
  })
);

router.delete(
  "/:id(\\d+)",
  escribe,
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    const id = idDe(req);
    await withTenant(tenantId, (client) => quitarPlan(client, tenantId, id));
    await auditar(req, "mantenimiento.plan_quitar", id);
    res.json({ ok: true });
  })
);

export default router;
