/** src/modules/ordenes_trabajo/ordenes_trabajo.routes.ts */

import { Router } from "express";
import { validate, validateQuery } from "../../server/middleware/validate";
import { requirePestana } from "../../server/shared/middlewares/pestana.middleware";
import { requireRole } from "../../server/shared/middlewares/roles.middleware";
import { asyncHandler } from "../../server/shared/utils/asyncHandler";
import {
  crearOrdenTrabajoSchema,
  actualizarOrdenTrabajoSchema,
  cambiarEstadoOrdenTrabajoSchema,
  cambiarTareasSchema,
  asignarOrdenSchema,
  filtrosDeOrdenesSchema,
} from "../../server/schemas/ordenes_trabajo.schema";
import { OrdenesTrabajoController } from "./ordenes_trabajo.controller";
import { listarUnidadesParaElegir } from "../equipos/unidadesParaElegir";

const router = Router();

// Las unidades para elegir en el formulario: vienen del maestro (Flota o Mantenimiento), no de
// `/api/erp/equipos`. ANTES de "/:id" para que "unidades" no se tome por un id.
router.get("/unidades", asyncHandler(listarUnidadesParaElegir));

router.get(
  "/",
  validateQuery(filtrosDeOrdenesSchema),
  asyncHandler(OrdenesTrabajoController.getAll)
);
// «resumen» y «mecanicos» van ANTES de "/:id" para que no se tomen por un id.
router.get("/resumen", asyncHandler(OrdenesTrabajoController.getResumen));
router.get(
  "/mecanicos",
  requireRole("admin", "operador"),
  asyncHandler(OrdenesTrabajoController.getMecanicos)
);
// Va ANTES que GET /:id a propósito -- si no, Express matchea
// "usuarios-asignables" como si fuera un :id.
router.get(
  "/usuarios-asignables",
  requireRole("admin", "operador"),
  asyncHandler(OrdenesTrabajoController.getUsuariosAsignables)
);
router.get(
  "/conformidad/personas",
  requireRole("admin"),
  asyncHandler(OrdenesTrabajoController.getQuienesConforman)
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

// Agregar, marcar y quitar tareas (solo con señal). PATCH: no cuenta contra la cuota de órdenes.
router.patch(
  // Hasta 9 cifras: un id mayor no cabe en la columna y debe dar 404, no un 500 de la base.
  "/:id(\\d{1,9})/tareas",
  requireRole("admin", "operador"),
  validate(cambiarTareasSchema),
  asyncHandler(OrdenesTrabajoController.cambiarTareas)
);

// Asignar o quitar el mecánico, sin tocar el resto de la orden (solo con señal).
router.patch(
  "/:id(\\d{1,9})/asignado",
  requireRole("admin", "operador"),
  validate(asignarOrdenSchema),
  asyncHandler(OrdenesTrabajoController.asignar)
);

// La conformidad manda la casilla, no el rol (ni el administrador la trae por defecto). PATCH: solo con
// señal.
router.patch(
  "/:id(\\d{1,9})/conformidad",
  requirePestana("ordenes_trabajo", "conformidad:dar"),
  asyncHandler(OrdenesTrabajoController.darConformidad)
);

router.delete("/:id", requireRole("admin"), asyncHandler(OrdenesTrabajoController.eliminar));

export default router;
