/** src/modules/equipos/equipos.routes.ts */

import { Router } from "express";
import { validate } from "../../server/middleware/validate";
import { requireRole } from "../../server/shared/middlewares/roles.middleware";
import { asyncHandler } from "../../server/shared/utils/asyncHandler";
import {
  crearEquipoSchema,
  actualizarEquipoSchema,
  cargaMasivaEquiposSchema,
  eliminarMasivoEquiposSchema,
} from "../../server/schemas/equipos.schema";
import { moverDeGrifoSchema } from "../../server/schemas/sedes.schema";
import { EquiposController } from "./equipos.controller";

const router = Router();

router.get("/", asyncHandler(EquiposController.getAll));

// 📊 exportar a Excel -- ANTES de "/:id" (si no, "export" matchea como id).
router.get("/export/xlsx", asyncHandler(EquiposController.exportXlsx));

router.post(
  "/",
  requireRole("admin", "operador"),
  validate(crearEquipoSchema),
  asyncHandler(EquiposController.create)
);

// 📦 importación masiva -- el límite de tamaño del cuerpo para esta ruta ya
// lo amplía app.ts de forma genérica (esRutaDeCargaMasiva() matchea
// cualquier ruta que termine en /bulk), mismo criterio que repuestos.
router.post(
  "/bulk",
  requireRole("admin", "operador"),
  validate(cargaMasivaEquiposSchema),
  asyncHandler(EquiposController.bulk)
);

// 🗑 eliminación masiva -- ANTES de "/:id" por el mismo motivo que /export.
router.delete(
  "/bulk",
  requireRole("admin"),
  validate(eliminarMasivoEquiposSchema),
  asyncHandler(EquiposController.deleteMany)
);

router.put(
  "/:id",
  requireRole("admin", "operador"),
  validate(actualizarEquipoSchema),
  asyncHandler(EquiposController.update)
);
router.delete("/:id", requireRole("admin"), asyncHandler(EquiposController.delete));

// Grifo interno del equipo (0097): mover es solo admin y con motivo.
router.post(
  "/:id/mover-grifo",
  requireRole("admin"),
  validate(moverDeGrifoSchema),
  asyncHandler(EquiposController.moverDeGrifo)
);
router.get("/:id/movimientos-grifo", asyncHandler(EquiposController.listarMovimientosDeGrifo));

export default router;
