/** src/server/routes/events.ts
 *
 * Igual que facturacion.ts: no es un módulo del ADR-0002 (no se activa/
 * desactiva por tenant desde el panel de plataforma) -- es infraestructura
 * transversal, visible para cualquier tenant autenticado. Se monta
 * directo en app.ts, no vía MODULOS/registry.
 */
import { Router } from "express";
import { authMiddleware } from "../shared/middlewares/auth.middleware";
import { tenantMiddleware } from "../shared/middlewares/tenant.middleware";
import erpRateLimiter from "../middleware/erpRateLimiter";
import { asyncHandler } from "../shared/utils/asyncHandler";
import { getTenantId } from "../shared/utils/request";
import { manejarConexionSSE } from "../shared/utils/sse";
import { withTenant } from "../config/database";
import { resolverAlcance, vaciarEventoDeCombustible } from "../../modules/combustible/alcance";
import {
  canalDeTenant,
  reponerEventosTenant,
  suscribirCanal,
} from "../services/realtimeEvents.service";
import "../services/eventosTiempoRealRetention.worker"; // se activa solo con importarse (setInterval + .unref())

export const eventosRouter = Router();

// Mismo motivo que facturacion.ts: post-auth, lee la base tras
// autenticar, mismo perfil de riesgo que cualquier ruta de negocio.
eventosRouter.use(authMiddleware, tenantMiddleware, erpRateLimiter);

eventosRouter.get(
  "/stream",
  asyncHandler(async (req, res) => {
    const tenantId = getTenantId(req);
    // Quien ve solo algunas plantas (alcance de Combustible, 0100) recibe el
    // aviso de que algo cambió, SIN el contenido: el cliente solo lo usa para
    // recargar, y lo que recarga ya viene filtrado. Se resuelve al conectar;
    // un cambio de alcance rige desde la próxima conexión.
    const alcance = await withTenant(tenantId, (client) =>
      resolverAlcance(client, tenantId, req.usuario!)
    );
    await manejarConexionSSE(req, res, {
      canal: canalDeTenant(tenantId),
      reponer: (desdeId) => reponerEventosTenant(tenantId, desdeId),
      suscribir: suscribirCanal,
      adaptar: alcance.todo ? undefined : vaciarEventoDeCombustible,
    });
  })
);
