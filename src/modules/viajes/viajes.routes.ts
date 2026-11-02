/** src/modules/viajes/viajes.routes.ts
 *
 * Las rutas de Viajes y de Lugares (0123): programar viajes, el panel del
 * conductor ("Mi viaje") y el catálogo de lugares. Viven acá, bajo el módulo
 * `viajes` (/api/erp/viajes/...), y SIGUEN montadas también bajo Combustible
 * (/api/erp/combustible/viajes/..., ver combustible.routes.ts) como alias:
 * el cliente actual y las marcas que los celulares dejaron en la cola offline
 * todavía llaman a esas URL. Los alias se retiran en la entrega de limpieza.
 *
 * Los permisos de pestaña NO cambian en esta entrega: siguen siendo
 * `combustible:viajes`, `combustible:mi_viaje`, etc. (el cliente las lee con
 * esas claves). La lógica es la misma de siempre: lo único que cambia es por
 * dónde se llega y qué módulo hay que tener.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { validate, validateQuery } from "../../server/middleware/validate";
import { requireRole } from "../../server/shared/middlewares/roles.middleware";
import { requireModulo } from "../../server/shared/middlewares/modulo.middleware";
import { requirePestana } from "../../server/shared/middlewares/pestana.middleware";
import { pestanaPermitida } from "../../server/services/permisosPestanas.service";
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

/** Deja pasar si el usuario tiene CUALQUIERA de las pestañas de Combustible. */
const requirePestanaAlguna =
  (...pestanas: string[]) =>
  (req: Request, res: Response, next: NextFunction) => {
    const usuario = req.usuario;
    if (!usuario) return res.status(401).json({ ok: false, message: "No autenticado" });
    if (pestanas.some((pestana) => pestanaPermitida(usuario, "combustible", pestana))) {
      return next();
    }
    return res.status(403).json({ ok: false, message: "Pestaña no disponible para este perfil" });
  };

/** Registra las rutas de Viajes y de Lugares en `router`.
 *
 *  `base` es el prefijo de las rutas de viajes: "" bajo /api/erp/viajes y
 *  "/viajes" bajo Combustible (donde los lugares siguen en /lugares). Se
 *  define una sola vez para que las dos puertas no puedan divergir. */
export function registrarRutasDeViajes(router: Router, base: string): void {
  // Lo que LEE las cargas (vales: serie, número, litros, tanque, grifo) por la
  // puerta nueva exige también el módulo Combustible: `pestanaPermitida` solo
  // mira el perfil y no comprueba que el usuario tenga ese módulo, así que sin
  // esto alguien con solo Viajes leería datos de Combustible que nadie le dio.
  // Por el alias ya manda requireModulo("combustible") del propio montaje.
  const lecturaDeCargas = (req: Request, res: Response, next: NextFunction) =>
    base === "" ? requireModulo("combustible")(req, res, next) : next();

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
    base || "/",
    lecturaDeCargas,
    requirePestana("combustible", "viajes"),
    validateQuery(listarViajesQuerySchema),
    asyncHandler(viajesController.listar)
  );
  // El resumen de cada conductor en un período: lo ve quien ve la lista de viajes.
  router.get(
    `${base}/resumen-conductores`,
    lecturaDeCargas,
    requirePestana("combustible", "viajes"),
    validateQuery(listarViajesQuerySchema),
    asyncHandler(viajesController.resumenConductores)
  );
  // El permiso depende del producto: lo resuelve el controller.
  router.get(
    `${base}/consumo`,
    lecturaDeCargas,
    validateQuery(listarViajesQuerySchema),
    asyncHandler(viajesController.listarConsumo)
  );
  // "Mi viaje" (0124): el conductor ve y marca SOLO sus viajes (cruce por DNI en
  // el service). Sin requireRole: alcanza con la pestaña, el dueño lo decide el DNI.
  router.get(
    `${base}/mios`,
    lecturaDeCargas,
    requirePestana("combustible", "mi_viaje"),
    asyncHandler(viajesController.mios)
  );
  router.get(
    `${base}/mios/historial`,
    lecturaDeCargas,
    requirePestana("combustible", "mi_viaje"),
    validateQuery(historialMioQuerySchema),
    asyncHandler(viajesController.historialMio)
  );
  // La unidad del viaje del conductor, para precargar "Compra en ruta". Alcanza con
  // poder registrar una compra: no exige la pestaña "Mi viaje".
  router.get(
    `${base}/mi-unidad`,
    requirePestanaAlguna("tanques:registrar_despacho", "urea:registrar_compra"),
    requireRole("admin", "operador", "conductor_ruta"),
    asyncHandler(viajesController.miUnidad)
  );
  router.get(
    `${base}/conductores`,
    requirePestana("combustible", "viajes:nuevo"),
    asyncHandler(viajesController.conductores)
  );
  router.post(
    `${base}/:viajeId(\\d+)/iniciar-mio`,
    requirePestana("combustible", "mi_viaje"),
    validate(iniciarMiViajeSchema),
    asyncHandler(viajesController.iniciarMio)
  );
  router.post(
    `${base}/:viajeId(\\d+)/cerrar-mio`,
    requirePestana("combustible", "mi_viaje"),
    validate(cerrarMiViajeSchema),
    asyncHandler(viajesController.cerrarMio)
  );
  router.post(
    `${base}/:viajeId(\\d+)/llegada-mia`,
    requirePestana("combustible", "mi_viaje"),
    validate(llegadaMiaSchema),
    asyncHandler(viajesController.llegadaMia)
  );
  router.post(
    `${base}/:viajeId(\\d+)/salida-mia`,
    requirePestana("combustible", "mi_viaje"),
    validate(salidaMiaSchema),
    asyncHandler(viajesController.salidaMia)
  );
  router.post(
    `${base}/:viajeId(\\d+)/descanso-mio`,
    requirePestana("combustible", "mi_viaje"),
    validate(descansoMioSchema),
    asyncHandler(viajesController.descansoMio)
  );
  router.post(
    `${base}/:viajeId(\\d+)/descanso-mio/terminar`,
    requirePestana("combustible", "mi_viaje"),
    validate(terminarDescansoMioSchema),
    asyncHandler(viajesController.terminarDescansoMio)
  );
  router.post(
    `${base}/:viajeId(\\d+)/mando/entregar`,
    requirePestana("combustible", "mi_viaje"),
    validate(entregaMandoSchema),
    asyncHandler(viajesController.entregarMando)
  );
  router.post(
    `${base}/:viajeId(\\d+)/mando/aceptar`,
    requirePestana("combustible", "mi_viaje"),
    validate(aceptarMandoSchema),
    asyncHandler(viajesController.aceptarMando)
  );
  router.post(
    `${base}/:viajeId(\\d+)/mando/retirar`,
    requirePestana("combustible", "mi_viaje"),
    asyncHandler(viajesController.retirarEntrega)
  );
  router.post(
    `${base}/:viajeId(\\d+)/mando/corregir`,
    requirePestana("combustible", "viajes:editar"),
    requireRole("admin", "operador"),
    validate(corregirMandoSchema),
    asyncHandler(viajesController.corregirMando)
  );
  router.post(
    `${base}/:viajeId(\\d+)/paradas/:orden(\\d+)/corregir`,
    requirePestana("combustible", "viajes:editar"),
    requireRole("admin", "operador"),
    validate(corregirMarcaDeParadaSchema),
    asyncHandler(viajesController.corregirMarca)
  );
  router.get(
    `${base}/:viajeId(\\d+)`,
    lecturaDeCargas,
    requirePestana("combustible", "viajes"),
    asyncHandler(viajesController.detalle)
  );
  router.post(
    base || "/",
    requirePestana("combustible", "viajes:nuevo"),
    requireRole("admin", "operador"),
    validate(crearViajeSchema),
    asyncHandler(viajesController.crear)
  );
  router.get(
    `${base}/:viajeId(\\d+)/medidor-previo`,
    requirePestana("combustible", "viajes"),
    asyncHandler(viajesController.medidorPrevio)
  );
  router.post(
    `${base}/:viajeId(\\d+)/iniciar`,
    requirePestana("combustible", "viajes:editar"),
    requireRole("admin", "operador"),
    validate(iniciarViajeSchema),
    asyncHandler(viajesController.iniciar)
  );
  router.post(
    `${base}/:viajeId(\\d+)/cerrar`,
    requirePestana("combustible", "viajes:editar"),
    requireRole("admin", "operador"),
    validate(cerrarViajeSchema),
    asyncHandler(viajesController.cerrar)
  );
  router.post(
    `${base}/:viajeId(\\d+)/llegada`,
    requirePestana("combustible", "viajes:editar"),
    requireRole("admin", "operador"),
    validate(llegadaViajeSchema),
    asyncHandler(viajesController.llegada)
  );
  router.post(
    `${base}/:viajeId(\\d+)/salida`,
    requirePestana("combustible", "viajes:editar"),
    requireRole("admin", "operador"),
    validate(salidaViajeSchema),
    asyncHandler(viajesController.salida)
  );
  router.post(
    `${base}/:viajeId(\\d+)/descanso`,
    requirePestana("combustible", "viajes:editar"),
    requireRole("admin", "operador"),
    validate(descansoViajeSchema),
    asyncHandler(viajesController.descanso)
  );
  router.post(
    `${base}/:viajeId(\\d+)/descanso/terminar`,
    requirePestana("combustible", "viajes:editar"),
    requireRole("admin", "operador"),
    validate(terminarDescansoViajeSchema),
    asyncHandler(viajesController.terminarDescanso)
  );
  router.put(
    `${base}/:viajeId(\\d+)`,
    requirePestana("combustible", "viajes:editar"),
    requireRole("admin", "operador"),
    validate(editarViajeSchema),
    asyncHandler(viajesController.editar)
  );
  router.post(
    `${base}/:viajeId(\\d+)/anular`,
    requirePestana("combustible", "viajes:editar"),
    requireRole("admin", "operador"),
    validate(anularViajeSchema),
    asyncHandler(viajesController.anular)
  );
}

const router = Router();
// Viajes lee las cargas de Combustible y aplica el mismo alcance (qué grifos y
// surtidores ve cada usuario): hay que cargarlo igual que en ese módulo.
router.use(cargarAlcance);
registrarRutasDeViajes(router, "");

export default router;
