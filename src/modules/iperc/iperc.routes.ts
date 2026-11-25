/** src/modules/iperc/iperc.routes.ts */

import { Router } from "express";
import { validate } from "../../server/middleware/validate";
import { requireRole } from "../../server/shared/middlewares/roles.middleware";
import { asyncHandler } from "../../server/shared/utils/asyncHandler";
import {
  crearIpercSchema,
  cambiarEstadoIpercSchema,
  crearLineaBaseSchema,
} from "../../server/schemas/iperc.schema";
import { IpercController } from "./iperc.controller";
import { listarUnidadesParaElegir } from "../equipos/unidadesParaElegir";

const router = Router();

// Línea Base
router.get("/lineas-base", asyncHandler(IpercController.getLineasBase));
router.get("/lineas-base/:id", asyncHandler(IpercController.getLineaBase));
router.post(
  "/lineas-base",
  requireRole("admin", "operador"),
  validate(crearLineaBaseSchema),
  asyncHandler(IpercController.crearLineaBase)
);
router.patch(
  "/lineas-base/:id/estado",
  requireRole("admin"),
  validate(cambiarEstadoIpercSchema),
  asyncHandler(IpercController.cambiarEstadoLineaBase)
);
router.delete(
  "/lineas-base/:id",
  requireRole("admin"),
  asyncHandler(IpercController.eliminarLineaBase)
);

// Las unidades para elegir en el formulario: vienen del maestro (Flota o Mantenimiento), no de
// `/api/erp/equipos`. ANTES de "/:id" para que "unidades" no se tome por un id.
router.get("/unidades", asyncHandler(listarUnidadesParaElegir));

// Continuo / Específico (ver campo `tipo`)
router.get("/", asyncHandler(IpercController.getAll));
router.get("/:id", asyncHandler(IpercController.getById));
router.post(
  "/",
  requireRole("admin", "operador"),
  validate(crearIpercSchema),
  asyncHandler(IpercController.crear)
);

// Aprobar/rechazar: solo admin — se reutiliza el rol existente en vez de
// sumar un rol "supervisor" nuevo (decisión documentada desde que se armó
// este módulo; si en la práctica hace falta un rol intermedio, se ajusta
// después sin tocar el resto del sistema de auth).
router.patch(
  "/:id/estado",
  requireRole("admin"),
  validate(cambiarEstadoIpercSchema),
  asyncHandler(IpercController.cambiarEstado)
);

router.delete("/:id", requireRole("admin"), asyncHandler(IpercController.eliminar));

export default router;
