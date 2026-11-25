/** src/modules/ordenes_trabajo/ordenes_trabajo.routes.ts */

import { Router } from "express";
import { validate } from "../../server/middleware/validate";
import { requireRole } from "../../server/shared/middlewares/roles.middleware";
import { asyncHandler } from "../../server/shared/utils/asyncHandler";
import {
  crearOrdenTrabajoSchema,
  actualizarOrdenTrabajoSchema,
  cambiarEstadoOrdenTrabajoSchema,
} from "../../server/schemas/ordenes_trabajo.schema";
import { OrdenesTrabajoController } from "./ordenes_trabajo.controller";
import { listarUnidadesParaElegir } from "../equipos/unidadesParaElegir";

const router = Router();

// Las unidades para elegir en el formulario: vienen del maestro (Flota o Mantenimiento), no de
// `/api/erp/equipos`. ANTES de "/:id" para que "unidades" no se tome por un id.
router.get("/unidades", asyncHandler(listarUnidadesParaElegir));

router.get("/", asyncHandler(OrdenesTrabajoController.getAll));
// Va ANTES que GET /:id a propósito -- si no, Express matchea
// "usuarios-asignables" como si fuera un :id.
router.get(
  "/usuarios-asignables",
  requireRole("admin", "operador"),
  asyncHandler(OrdenesTrabajoController.getUsuariosAsignables)
);
router.get("/:id", asyncHandler(OrdenesTrabajoController.getById));

router.post(
  "/",
  requireRole("admin", "operador"),
  validate(crearOrdenTrabajoSchema),
  asyncHandler(OrdenesTrabajoController.crear)
);

router.put(
  "/:id",
  requireRole("admin", "operador"),
  validate(actualizarOrdenTrabajoSchema),
  asyncHandler(OrdenesTrabajoController.actualizar)
);

// Transición de estado (iniciar/completar/cancelar): admin y operador,
// mismo criterio que Equipos -- a diferencia de IPERC, esto no es una
// aprobación que exija segregación de funciones, es la ejecución del
// trabajo por quien lo hace.
router.patch(
  "/:id/estado",
  requireRole("admin", "operador"),
  validate(cambiarEstadoOrdenTrabajoSchema),
  asyncHandler(OrdenesTrabajoController.cambiarEstado)
);

router.delete("/:id", requireRole("admin"), asyncHandler(OrdenesTrabajoController.eliminar));

export default router;
