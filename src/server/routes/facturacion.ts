/** src/server/routes/facturacion.ts
 *
 * Facturación no es un módulo del ADR-0002 (no se activa/desactiva por
 * tenant desde el panel de plataforma como equipos/checklists/etc.) -- es
 * infraestructura de cuenta, visible para cualquier tenant autenticado
 * siempre. Por eso se monta directo en app.ts, no vía MODULOS/registry.
 */
import { Router } from "express";
import { authMiddleware } from "../shared/middlewares/auth.middleware";
import { requirePestana } from "../shared/middlewares/pestana.middleware";
import { tenantMiddleware } from "../shared/middlewares/tenant.middleware";
import erpRateLimiter from "../middleware/erpRateLimiter";
import { asyncHandler } from "../shared/utils/asyncHandler";
import { getTenantId } from "../shared/utils/request";
import {
  listarComprobantesTenantService,
  generarComprobantePagoPdfService,
} from "../services/facturacion.service";

export const facturacionRouter = Router();

// Mismo rate limiter que /api/erp (post-auth, por usuario y por tenant) --
// CodeQL marcó estas rutas como "Missing rate limiting" al no tenerlo
// (leen la base tras autenticar, mismo perfil de riesgo que cualquier
// ruta de negocio).
facturacionRouter.use(
  authMiddleware,
  tenantMiddleware,
  erpRateLimiter,
  requirePestana("facturacion", "principal")
);

facturacionRouter.get(
  "/comprobantes",
  asyncHandler(async (req, res) => {
    const tenantId = getTenantId(req);
    const comprobantes = await listarComprobantesTenantService(tenantId);
    res.json({ comprobantes });
  })
);

facturacionRouter.get(
  "/comprobantes/:id/pdf",
  asyncHandler(async (req, res) => {
    const tenantId = getTenantId(req);
    const pdf = await generarComprobantePagoPdfService(tenantId, req.params.id);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="comprobante-${req.params.id}.pdf"`);
    res.send(pdf);
  })
);
