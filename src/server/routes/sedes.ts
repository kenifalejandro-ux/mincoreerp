/** src/server/routes/sedes.ts
 *
 * GET /api/erp/sedes -- las sedes de la empresa con sus grifos internos
 * (migración 0097). Lo lee CUALQUIER usuario: los formularios de tanque y de
 * equipo arman su selector con esto, y el alta de equipo funciona sin red
 * (por eso el service worker lo cachea, ver vite.config.js).
 *
 * Va fuera del loop de módulos, como /usuarios: la sede es de la empresa, no
 * de un módulo que se contrate. Las escrituras viven en /administracion, que
 * exige rol admin.
 */
import { Router } from "express";

import { asyncHandler } from "../shared/utils/asyncHandler";
import { getTenantId } from "../shared/utils/request";
import { listarSedesService } from "../services/sedes.service";

export function createSedesRouter() {
  const router = Router();
  router.get(
    "/",
    asyncHandler(async (req, res) => {
      res.json({ sedes: await listarSedesService(getTenantId(req)) });
    })
  );
  return router;
}
