/** src/server/routes/administracion.ts
 *
 * El menú **Administración** de cada empresa, tal como Kenif lo pidió sobre
 * el telebanking de su banco:
 *
 *   Administración de usuarios  ->  /api/erp/usuarios      (usuariosTenant.ts)
 *   Configuración (autonomías)  ->  /api/erp/usuarios/:id/permisos
 *   Log de eventos              ->  acá
 *   Órdenes                     ->  acá (entrega 5)
 *
 * Todo exige rol admin. Es el menú que decide quién entra al sistema y con
 * qué: ni `operador` ni `lectura` lo ven siquiera en el sidebar.
 */
import { Router } from "express";

import { requireRole } from "../shared/middlewares/roles.middleware";
import { asyncHandler } from "../shared/utils/asyncHandler";
import { getTenantId } from "../shared/utils/request";
import {
  listarBitacoraTenantService,
  accionesDeBitacoraService,
} from "../services/bitacoraTenant.service";

export function createAdministracionRouter() {
  const router = Router();

  router.use(requireRole("admin"));

  // ── Log de eventos ───────────────────────────────────────────────────

  router.get(
    "/eventos",
    asyncHandler(async (req, res) => {
      res.json(
        await listarBitacoraTenantService(getTenantId(req), {
          desde: req.query.desde as string | undefined,
          hasta: req.query.hasta as string | undefined,
          accion: req.query.accion as string | undefined,
          usuarioId: req.query.usuarioId as string | undefined,
          antesDe: req.query.antesDe as string | undefined,
          // Un tope duro además del que manda la pantalla: sin él, un
          // `?limite=999999` se trae media tabla en una sola consulta.
          limite: Math.min(Number(req.query.limite) || 100, 500),
        })
      );
    })
  );

  router.get(
    "/eventos/acciones",
    asyncHandler(async (req, res) => {
      res.json({ acciones: await accionesDeBitacoraService(getTenantId(req)) });
    })
  );

  return router;
}
