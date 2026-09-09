/**src/modules/combutible/combustible.routes.ts */

import { Router } from "express";
import { validate, validateQuery } from "../../server/middleware/validate";
import { requireRole } from "../../server/shared/middlewares/roles.middleware";
import { asyncHandler } from "../../server/shared/utils/asyncHandler";
import {
  registrarLecturaCombustibleSchema,
  actualizarNivelCombustibleSchema,
  crearTanqueCombustibleSchema,
  actualizarTanqueCombustibleSchema,
  cargaMasivaTanquesCombustibleSchema,
  anularLecturaCombustibleSchema,
  crearDespachoCombustibleSchema,
  crearGrifoCombustibleSchema,
  actualizarGrifoCombustibleSchema,
  crearPrecioCombustibleSchema,
  anularPrecioCombustibleSchema,
  crearRecepcionCombustibleSchema,
  anularRecepcionCombustibleSchema,
  anularDespachoCombustibleSchema,
  marcarAlertasLeidasCombustibleSchema,
  configCombustibleSchema,
  kardexCombustibleSchema,
  resolverAlertaCombustibleSchema,
  bajaTanqueCombustibleSchema,
} from "../../server/schemas/combustible.schema";
import { CombustibleController } from "./combustible.controller";
// Se activa solo con importarse (setInterval + .unref()) -- mismo mecanismo
// que events.ts con el worker de retención de eventos.
import "../../server/services/combustibleConciliacion.worker";

const router = Router();
const controller = new CombustibleController();

router.get("/", asyncHandler(controller.getAll.bind(controller)));

// Despachos (Fase B) -- segmentos literales, van ANTES de /:id: si /:id
// los capturara primero, "despachos" quedaría interpretado como un id
// (mismo motivo que /lecturas más abajo).
router.get("/despachos", asyncHandler(controller.listarDespachos.bind(controller)));
router.get("/despachos/huecos", asyncHandler(controller.getHuecosTalonario.bind(controller)));
router.post(
  "/despachos",
  requireRole("admin", "operador"),
  validate(crearDespachoCombustibleSchema),
  asyncHandler(controller.crearDespacho.bind(controller))
);

// 🚫 anular un vale roto o mal tipeado -- admin Y operador, los mismos que
// pueden registrarlo: el punto 3 del documento es literalmente sobre el
// grifero que arruina un vale en cancha y necesita rendirlo ahí mismo, sin
// depender de nadie (mismo criterio que anular una lectura).
router.patch(
  "/despachos/:despachoId/anular",
  requireRole("admin", "operador"),
  validate(anularDespachoCombustibleSchema),
  asyncHandler(controller.anularDespacho.bind(controller))
);

// Grifos externos y precios (migrations/0063) -- segmentos literales,
// mismo motivo que /despachos: tienen que ir ANTES de /:id.
router.get("/grifos", asyncHandler(controller.listarGrifos.bind(controller)));
router.post(
  "/grifos",
  requireRole("admin"),
  validate(crearGrifoCombustibleSchema),
  asyncHandler(controller.crearGrifo.bind(controller))
);
router.put(
  "/grifos/:id",
  requireRole("admin"),
  validate(actualizarGrifoCombustibleSchema),
  asyncHandler(controller.actualizarGrifo.bind(controller))
);

// GET /precios/vigente ANTES de GET /precios y de GET /:id -- Express
// matchea por orden de registro, no por especificidad.
router.get("/precios/vigente", asyncHandler(controller.getPrecioVigente.bind(controller)));
router.get("/precios", asyncHandler(controller.listarPrecios.bind(controller)));
router.post(
  "/precios",
  requireRole("admin"),
  validate(crearPrecioCombustibleSchema),
  asyncHandler(controller.crearPrecio.bind(controller))
);
router.patch(
  "/precios/:precioId/anular",
  requireRole("admin"),
  validate(anularPrecioCombustibleSchema),
  asyncHandler(controller.anularPrecio.bind(controller))
);

// Recepciones (Fase C, migrations/0064) -- segmentos literales, mismo
// motivo que /despachos y /grifos: tienen que ir ANTES de /:id.
//
// Crear una recepción es admin únicamente, a diferencia de un despacho
// (admin+operador): recibir combustible de un proveedor es un acto
// administrativo con sustento tributario de por medio (factura/guía), y lo
// que registra define cómo se valoriza TODO el inventario del tanque -- no
// es trabajo de cancha. Mismo criterio que los precios (0063).
router.get("/recepciones", asyncHandler(controller.listarRecepciones.bind(controller)));
router.post(
  "/recepciones",
  requireRole("admin"),
  validate(crearRecepcionCombustibleSchema),
  asyncHandler(controller.crearRecepcion.bind(controller))
);
router.patch(
  "/recepciones/:recepcionId/anular",
  requireRole("admin"),
  validate(anularRecepcionCombustibleSchema),
  asyncHandler(controller.anularRecepcion.bind(controller))
);

// Alertas (migrations/0068) -- segmentos literales, mismo motivo que
// /despachos: tienen que ir ANTES de /:id.
//
// Solo admin: es visibilidad de gerencia (hueco de talonario, vale
// anulado), el operador no la necesita para hacer su trabajo de cancha.
router.get(
  "/alertas",
  requireRole("admin"),
  asyncHandler(controller.listarAlertas.bind(controller))
);
router.patch(
  "/alertas/leidas",
  requireRole("admin"),
  validate(marcarAlertasLeidasCombustibleSchema),
  asyncHandler(controller.marcarAlertasLeidas.bind(controller))
);
router.patch(
  "/alertas/:alertaId/resolver",
  requireRole("admin"),
  validate(resolverAlertaCombustibleSchema),
  asyncHandler(controller.resolverAlertaManual.bind(controller))
);

// Conciliación (migraciones 0071/0072) -- segmentos literales, ANTES de
// /:id. Solo admin: la ventana de gracia gobierna cuándo un hallazgo se
// vuelve permanente, y las anomalías son visibilidad de gerencia.
// Bitácora del módulo para el propio tenant. Segmento literal, ANTES de
// /:id. Solo admin: es visibilidad de gerencia, igual que las alertas.
router.get(
  "/bitacora",
  requireRole("admin"),
  asyncHandler(controller.listarBitacora.bind(controller))
);

router.get("/config", requireRole("admin"), asyncHandler(controller.getConfig.bind(controller)));
router.put(
  "/config",
  requireRole("admin"),
  validate(configCombustibleSchema),
  asyncHandler(controller.guardarConfig.bind(controller))
);
router.get(
  "/anomalias",
  requireRole("admin"),
  asyncHandler(controller.listarAnomalias.bind(controller))
);

router.get("/:id", asyncHandler(controller.getById.bind(controller)));
router.get("/:id/lecturas", asyncHandler(controller.getLecturas.bind(controller)));

// Kardex del tanque: las tres historias (despachos, recepciones, lecturas)
// en UNA línea de tiempo con saldo corriente. Solo admin -- es visibilidad
// de gerencia y la herramienta del auditor, no trabajo de cancha.
router.get(
  "/:id/kardex",
  requireRole("admin"),
  validateQuery(kardexCombustibleSchema),
  asyncHandler(controller.getKardex.bind(controller))
);

// Asistente de calibración del umbral (Fase D, entrega 3) -- solo admin,
// es una decisión de configuración, no trabajo de cancha.
router.get(
  "/:id/sugerencia-umbral",
  requireRole("admin"),
  asyncHandler(controller.getSugerenciaUmbral.bind(controller))
);

// ➕ crear tanque -- admin únicamente: dar de alta un punto de
// abastecimiento es configuración de planta, no trabajo de campo (mismo
// criterio que las plantillas de Checklists, no las OT/movimientos).
router.post(
  "/",
  requireRole("admin"),
  validate(crearTanqueCombustibleSchema),
  asyncHandler(controller.create.bind(controller))
);

// ✏️ actualizar tanque
router.put(
  "/:id",
  requireRole("admin"),
  validate(actualizarTanqueCombustibleSchema),
  asyncHandler(controller.update.bind(controller))
);

// 🗑 soft-delete -- ver CombustibleController.delete
router.delete(
  "/:id",
  requireRole("admin"),
  validate(bajaTanqueCombustibleSchema),
  asyncHandler(controller.delete.bind(controller))
);

// 📦 importación masiva -- el límite de tamaño del cuerpo ya lo amplía
// app.ts de forma genérica para cualquier ruta que termine en /bulk.
router.post(
  "/bulk",
  requireRole("admin"),
  validate(cargaMasivaTanquesCombustibleSchema),
  asyncHandler(controller.bulk.bind(controller))
);

// Ruta literal, sin `:id` -- el combustible_id viaja en el body a propósito
// (ver el comentario en el controller). Definida antes de /:id/nivel por
// legibilidad; no hay ambigüedad real porque los métodos HTTP son distintos.
router.post(
  "/lecturas",
  requireRole("admin", "operador"),
  validate(registrarLecturaCombustibleSchema),
  asyncHandler(controller.registrarLectura.bind(controller))
);

// 🚫 anular una lectura mal cargada -- admin y operador, los mismos que
// pueden registrarla: quien se equivoca al tipear tiene que poder
// corregirlo en el momento, sin depender de nadie más (ver el punto 3 de
// docs/architecture/control-de-combustible.md). Va ANTES de /:id/nivel
// porque "lecturas" es un segmento literal: si /:id lo capturara primero,
// nunca llegaría acá.
router.patch(
  "/lecturas/:lecturaId/anular",
  requireRole("admin", "operador"),
  validate(anularLecturaCombustibleSchema),
  asyncHandler(controller.anularLectura.bind(controller))
);

router.put(
  "/:id/nivel",
  requireRole("admin", "operador"),
  validate(actualizarNivelCombustibleSchema),
  asyncHandler(controller.updateNivel.bind(controller))
);

export default router;
