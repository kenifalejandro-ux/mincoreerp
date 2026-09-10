/** src/server/routes/index.ts**/

import { Router } from "express";

import { MODULOS } from "../../modules/registry";
import { authMiddleware } from "../shared/middlewares/auth.middleware";
import { tenantMiddleware } from "../shared/middlewares/tenant.middleware";
import { requireModulo } from "../shared/middlewares/modulo.middleware";
import { requireCuota } from "../shared/middlewares/cuota.middleware";
import erpRateLimiter from "../middleware/erpRateLimiter";
import { tenantMetricsMiddleware } from "../shared/middlewares/tenantMetrics.middleware";
import { createUsuariosTenantRouter } from "./usuariosTenant";
// Se activa solo con importarse (setInterval + .unref()). Va acá y no en
// las rutas de plataforma porque quien LLENA idempotency_keys son los
// módulos de negocio que se montan abajo (migración 0044).
import "../services/idempotencyKeysRetention.worker";

export function createApiRouter() {
  const router = Router();

  // Toda ruta de negocio del ERP exige sesión válida y queda con
  // req.tenantId listo para que cada repository filtre por tenant.
  // tenantMetricsMiddleware va después de tenantMiddleware (necesita
  // req.tenantId) y antes de requireModulo (un 403 por módulo también
  // cuenta como tráfico real — ver platformTenantHealth.service.ts).
  router.use(authMiddleware, tenantMiddleware, tenantMetricsMiddleware);

  // Rate limit de todo el ERP. Va después de tenantMetricsMiddleware por el
  // mismo motivo que requireModulo: un 429 es tráfico real y tiene que
  // contarse en las métricas del tenant. Y antes de las rutas de módulo,
  // porque frena por FRECUENCIA — un abuso no debe llegar siquiera a
  // resolver la cuota de volumen ni a tocar la base.
  router.use(erpRateLimiter);

  // La gente de la empresa NO es un módulo: no se contrata ni se factura,
  // y un tenant sin ningún módulo habilitado igual tiene que poder dar de
  // alta y de baja a su personal. Por eso va antes del loop y fuera de
  // requireModulo/requireCuota -- pero adentro de authMiddleware,
  // tenantMiddleware y el rate limit, como cualquier ruta de negocio.
  router.use("/usuarios", createUsuariosTenantRouter());

  // Cada módulo se monta bajo /<id> — agregar un módulo nuevo es agregarlo
  // al registry (ver docs/adr/0002-contrato-de-modulo.md), no tocar este
  // archivo.
  //
  // requireCuota va DESPUÉS de requireModulo: a un tenant que no tiene el
  // módulo contratado hay que responderle "no disponible" (403 de módulo),
  // no "te quedaste sin cupo" — el segundo mensaje admitiría que el módulo
  // existe y solo está lleno. Es passthrough para los módulos que no
  // declaran `cuota` en el registry.
  for (const modulo of MODULOS) {
    router.use(`/${modulo.id}`, requireModulo(modulo.id), requireCuota(modulo.id), modulo.router);
  }

  return router;
}
