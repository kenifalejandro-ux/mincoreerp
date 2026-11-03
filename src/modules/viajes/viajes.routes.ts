/** src/modules/viajes/viajes.routes.ts
 *
 * Las rutas de Viajes y de Lugares (0123): programar viajes, el panel del
 * conductor ("Mi viaje") y el catálogo de lugares, montadas bajo el módulo
 * `viajes` (/api/erp/viajes/...). Los alias que tuvieron bajo Combustible
 * (/api/erp/combustible/viajes/... y /combustible/lugares) ya se retiraron;
 * queda solo `GET /api/erp/combustible/viajes/mi-unidad`, que Compra en ruta
 * necesita sin depender de que la empresa tenga Viajes (ver combustible.routes.ts).
 *
 * Los permisos de pestaña siguen siendo `combustible:viajes`,
 * `combustible:mi_viaje`, etc. (el cliente las lee con esas claves).
 */
import { Router } from "express";
import { validate, validateQuery } from "../../server/middleware/validate";
import { requireRole } from "../../server/shared/middlewares/roles.middleware";
import { requireModulo } from "../../server/shared/middlewares/modulo.middleware";
import { requirePestana } from "../../server/shared/middlewares/pestana.middleware";
import { asyncHandler } from "../../server/shared/utils/asyncHandler";
import {
  aceptarMandoSchema,
  anularViajeSchema,
  cerrarMiViajeSchema,
  cerrarViajeSchema,
  corregirMandoSchema,
  corregirMarcaDeParadaSchema,
  crearLugarSchema,
  crearViajeSchema,
  descansoMioSchema,
  descansoViajeSchema,
  editarLugarSchema,
  editarViajeSchema,
  entregaMandoSchema,
  historialMioQuerySchema,
  iniciarMiViajeSchema,
  iniciarViajeSchema,
  listarViajesQuerySchema,
  llegadaMiaSchema,
  llegadaViajeSchema,
  salidaMiaSchema,
  salidaViajeSchema,
  terminarDescansoMioSchema,
  terminarDescansoViajeSchema,
} from "../../server/schemas/combustible.schema";
import { cargarAlcance } from "../combustible/alcance";
import { viajesController } from "../combustible/viajes.controller";

const router = Router();
// Viajes lee las cargas de Combustible y aplica el mismo alcance (qué grifos y
// surtidores ve cada usuario): hay que cargarlo igual que en ese módulo.
router.use(cargarAlcance);

// Lo que LEE las cargas (vales: serie, número, litros, tanque, grifo) exige también el
// módulo Combustible: `pestanaPermitida` solo mira el perfil y no comprueba que el
// usuario tenga ese módulo, así que sin esto alguien con solo Viajes leería datos de
// Combustible que nadie le dio. También el último medidor (`medidor-previo` y el inicio
// del viaje, que lo compara con la última carga); las demás marcas no leen cargas.
const lecturaDeCargas = requireModulo("combustible");

// Viajes (0123) -- segmentos literales, ANTES de /:id. Lectura ve el panel;
// crear y corregir son acciones aparte.
router.get(
  "/lugares",
  requirePestana("combustible", "viajes"),
  asyncHandler(viajesController.listarLugares)
);
router.post(
  "/lugares",
  requirePestana("combustible", "viajes:lugares"),
  requireRole("admin", "operador"),
  validate(crearLugarSchema),
  asyncHandler(viajesController.crearLugar)
);
router.patch(
  "/lugares/:lugarId(\\d+)",
  requirePestana("combustible", "viajes:lugares"),
  requireRole("admin", "operador"),
  validate(editarLugarSchema),
  asyncHandler(viajesController.editarLugar)
);
router.get(
  "/",
  lecturaDeCargas,
  requirePestana("combustible", "viajes"),
  validateQuery(listarViajesQuerySchema),
  asyncHandler(viajesController.listar)
);
// El resumen de cada conductor en un período: lo ve quien ve la lista de viajes.
router.get(
  "/resumen-conductores",
  lecturaDeCargas,
  requirePestana("combustible", "viajes"),
  validateQuery(listarViajesQuerySchema),
  asyncHandler(viajesController.resumenConductores)
);
// El permiso depende del producto: lo resuelve el controller.
router.get(
  "/consumo",
  lecturaDeCargas,
  validateQuery(listarViajesQuerySchema),
  asyncHandler(viajesController.listarConsumo)
);
// "Mi viaje" (0124): el conductor ve y marca SOLO sus viajes (cruce por DNI en
// el service). Sin requireRole: alcanza con la pestaña, el dueño lo decide el DNI.
router.get(
  "/mios",
  lecturaDeCargas,
  requirePestana("combustible", "mi_viaje"),
  asyncHandler(viajesController.mios)
);
router.get(
  "/mios/historial",
  lecturaDeCargas,
  requirePestana("combustible", "mi_viaje"),
  validateQuery(historialMioQuerySchema),
  asyncHandler(viajesController.historialMio)
);
router.get(
  "/conductores",
  requirePestana("combustible", "viajes:nuevo"),
  asyncHandler(viajesController.conductores)
);
router.post(
  "/:viajeId(\\d+)/iniciar-mio",
  lecturaDeCargas,
  requirePestana("combustible", "mi_viaje"),
  validate(iniciarMiViajeSchema),
  asyncHandler(viajesController.iniciarMio)
);
router.post(
  "/:viajeId(\\d+)/cerrar-mio",
  requirePestana("combustible", "mi_viaje"),
  validate(cerrarMiViajeSchema),
  asyncHandler(viajesController.cerrarMio)
);
router.post(
  "/:viajeId(\\d+)/llegada-mia",
  requirePestana("combustible", "mi_viaje"),
  validate(llegadaMiaSchema),
  asyncHandler(viajesController.llegadaMia)
);
router.post(
  "/:viajeId(\\d+)/salida-mia",
  requirePestana("combustible", "mi_viaje"),
  validate(salidaMiaSchema),
  asyncHandler(viajesController.salidaMia)
);
router.post(
  "/:viajeId(\\d+)/descanso-mio",
  requirePestana("combustible", "mi_viaje"),
  validate(descansoMioSchema),
  asyncHandler(viajesController.descansoMio)
);
router.post(
  "/:viajeId(\\d+)/descanso-mio/terminar",
  requirePestana("combustible", "mi_viaje"),
  validate(terminarDescansoMioSchema),
  asyncHandler(viajesController.terminarDescansoMio)
);
router.post(
  "/:viajeId(\\d+)/mando/entregar",
  requirePestana("combustible", "mi_viaje"),
  validate(entregaMandoSchema),
  asyncHandler(viajesController.entregarMando)
);
router.post(
  "/:viajeId(\\d+)/mando/aceptar",
  requirePestana("combustible", "mi_viaje"),
  validate(aceptarMandoSchema),
  asyncHandler(viajesController.aceptarMando)
);
router.post(
  "/:viajeId(\\d+)/mando/retirar",
  requirePestana("combustible", "mi_viaje"),
  asyncHandler(viajesController.retirarEntrega)
);
router.post(
  "/:viajeId(\\d+)/mando/corregir",
  requirePestana("combustible", "viajes:editar"),
  requireRole("admin", "operador"),
  validate(corregirMandoSchema),
  asyncHandler(viajesController.corregirMando)
);
router.post(
  "/:viajeId(\\d+)/paradas/:orden(\\d+)/corregir",
  requirePestana("combustible", "viajes:editar"),
  requireRole("admin", "operador"),
  validate(corregirMarcaDeParadaSchema),
  asyncHandler(viajesController.corregirMarca)
);
router.get(
  "/:viajeId(\\d+)",
  lecturaDeCargas,
  requirePestana("combustible", "viajes"),
  asyncHandler(viajesController.detalle)
);
router.post(
  "/",
  requirePestana("combustible", "viajes:nuevo"),
  requireRole("admin", "operador"),
  validate(crearViajeSchema),
  asyncHandler(viajesController.crear)
);
router.get(
  "/:viajeId(\\d+)/medidor-previo",
  lecturaDeCargas,
  requirePestana("combustible", "viajes"),
  asyncHandler(viajesController.medidorPrevio)
);
router.post(
  "/:viajeId(\\d+)/iniciar",
  lecturaDeCargas,
  requirePestana("combustible", "viajes:editar"),
  requireRole("admin", "operador"),
  validate(iniciarViajeSchema),
  asyncHandler(viajesController.iniciar)
);
router.post(
  "/:viajeId(\\d+)/cerrar",
  requirePestana("combustible", "viajes:editar"),
  requireRole("admin", "operador"),
  validate(cerrarViajeSchema),
  asyncHandler(viajesController.cerrar)
);
router.post(
  "/:viajeId(\\d+)/llegada",
  requirePestana("combustible", "viajes:editar"),
  requireRole("admin", "operador"),
  validate(llegadaViajeSchema),
  asyncHandler(viajesController.llegada)
);
router.post(
  "/:viajeId(\\d+)/salida",
  requirePestana("combustible", "viajes:editar"),
  requireRole("admin", "operador"),
  validate(salidaViajeSchema),
  asyncHandler(viajesController.salida)
);
router.post(
  "/:viajeId(\\d+)/descanso",
  requirePestana("combustible", "viajes:editar"),
  requireRole("admin", "operador"),
  validate(descansoViajeSchema),
  asyncHandler(viajesController.descanso)
);
router.post(
  "/:viajeId(\\d+)/descanso/terminar",
  requirePestana("combustible", "viajes:editar"),
  requireRole("admin", "operador"),
  validate(terminarDescansoViajeSchema),
  asyncHandler(viajesController.terminarDescanso)
);
router.put(
  "/:viajeId(\\d+)",
  requirePestana("combustible", "viajes:editar"),
  requireRole("admin", "operador"),
  validate(editarViajeSchema),
  asyncHandler(viajesController.editar)
);
router.post(
  "/:viajeId(\\d+)/anular",
  requirePestana("combustible", "viajes:editar"),
  requireRole("admin", "operador"),
  validate(anularViajeSchema),
  asyncHandler(viajesController.anular)
);

export default router;
