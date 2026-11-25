/** src/modules/checklists/checklists.routes.ts */

import { Router } from "express";
import { validate } from "../../server/middleware/validate";
import { requireRole } from "../../server/shared/middlewares/roles.middleware";
import { asyncHandler } from "../../server/shared/utils/asyncHandler";
import { crearPlantillaSchema, crearChecklistSchema } from "../../server/schemas/checklists.schema";
import { ChecklistsController } from "./checklists.controller";
import { listarUnidadesParaElegir } from "../equipos/unidadesParaElegir";

const router = Router();

// Plantillas
router.get("/plantillas", asyncHandler(ChecklistsController.getPlantillas));
router.get("/plantillas/:id", asyncHandler(ChecklistsController.getPlantilla));
router.post(
  "/plantillas",
  requireRole("admin", "operador"),
  validate(crearPlantillaSchema),
  asyncHandler(ChecklistsController.crearPlantilla)
);
router.delete(
  "/plantillas/:id",
  requireRole("admin"),
  asyncHandler(ChecklistsController.eliminarPlantilla)
);

// Las unidades para elegir en el formulario: vienen del maestro (Flota o Mantenimiento), no de
// `/api/erp/equipos`. ANTES de "/:id" para que "unidades" no se tome por un id.
router.get("/unidades", asyncHandler(listarUnidadesParaElegir));

// Checklists llenados
router.get("/", asyncHandler(ChecklistsController.getAll));
router.get("/:id", asyncHandler(ChecklistsController.getById));
router.post(
  "/",
  requireRole("admin", "operador"),
  validate(crearChecklistSchema),
  asyncHandler(ChecklistsController.crear)
);
router.delete("/:id", requireRole("admin"), asyncHandler(ChecklistsController.eliminar));

export default router;
