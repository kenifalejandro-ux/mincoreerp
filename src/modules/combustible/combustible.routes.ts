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
// Los cuatro roles pueden POSTear acá, pero NO lo mismo: este endpoint sirve
// dos flujos distintos (el vale del tanque propio y la compra en grifo de
// ruta) que se distinguen por el campo `origen` del body. requireRole decide
// por RUTA, así que no alcanza -- sin el chequeo que hace el service, un
// conductor de ruta podría despachar del tanque de la empresa pasando por
// esta misma URL, y el rol parecería restringido sin serlo. Ver
// validarOrigenPermitidoParaRol() en combustible.service.ts.
router.post(
  "/despachos",
  requireRole("admin", "operador", "grifero", "conductor_ruta"),
  validate(crearDespachoCombustibleSchema),
  asyncHandler(controller.crearDespacho.bind(controller))
);

// 🚫 anular un vale roto o mal tipeado -- admin Y operador, los mismos que
// pueden registrarlo: el punto 3 del documento es literalmente sobre el
// grifero que arruina un vale en cancha y necesita rendirlo ahí mismo, sin
// depender de nadie (mismo criterio que anular una lectura).
//
// El rol `grifero` (0085) queda AFUERA a propósito, y sí, contradice el
// párrafo de arriba: cuando se escribió, "grifero" era una persona con rol
// `operador`, y la comodidad de rendir el vale en el momento pesaba más.
// Ahora que es un rol propio, pesa más lo otro. Anular es la maniobra de
// fraude más limpia que existe -- se despachan 200 L de verdad, se anula el
// vale, el combustible salió y el papel dice que no -- y si el que despacha
// es el mismo que anula, no hay segregación, hay autopsia. Decisión de Kenif
// (2026-09-10): "el grifero no anula sus vales, que dependa del admin".
// El costo es real: un vale mal tipeado le cuesta un llamado al admin.
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
// Crear una recepción era admin únicamente: recibir combustible de un
// proveedor es un acto administrativo con sustento tributario de por medio
// (factura/guía) y define cómo se valoriza TODO el inventario del tanque.
//
// Desde 0085 el `grifero` también puede, por una razón operativa simple: es
// quien está parado ahí cuando llega la cisterna, y hacer que la carga espere
// a que un administrativo esté disponible garantiza que se cargue de memoria
// horas después -- o que no se cargue. Lo que lo hace tolerable es que el
// sistema ya exige varilla previa para aceptar una recepción: el grifero no
// puede inflar el ingreso sin dejar antes la medición que lo va a contradecir.
//
// Decisión de Kenif (2026-09-10): "el grifero registra la recepción, el admin
// lo valida". Esa validación --una constancia del admin contra la guía de
// remisión-- es un flujo aparte, todavía sin implementar: el combustible de
// una recepción sin validar SÍ cuenta desde que se registra (entró de
// verdad), si no la próxima varilla mostraría un excedente inexistente.
router.get("/recepciones", asyncHandler(controller.listarRecepciones.bind(controller)));
router.post(
  "/recepciones",
  requireRole("admin", "grifero"),
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

// Quién hace y quién controla. No acusa: cuenta, para que el riesgo de
// concentración se pueda ver y compensar.
router.get(
  "/reportes/segregacion",
  requireRole("admin"),
  validateQuery(kardexCombustibleSchema),
  asyncHandler(controller.getReporteSegregacion.bind(controller))
);

// Estado de la vigilancia DURANTE un período, no el de hoy. Es el control
// que atrapa el apagón temporal: bajar un umbral el viernes, sacar el sábado
// y reponerlo el domingo deja la ficha impecable el lunes, pero no puede
// borrar el registro.
router.get(
  "/reportes/controles",
  requireRole("admin"),
  validateQuery(kardexCombustibleSchema),
  asyncHandler(controller.getReporteControles.bind(controller))
);

// Kardex del tanque: las tres historias (despachos, recepciones, lecturas)
// en UNA línea de tiempo con saldo corriente. Solo admin -- es visibilidad
// de gerencia y la herramienta del auditor, no trabajo de cancha.
router.get(
  "/:id/kardex",
  requireRole("admin"),
  validateQuery(kardexCombustibleSchema),
  asyncHandler(controller.getKardex.bind(controller))
);

// El mismo kardex, descargable. Va como ruta aparte y no como ?formato=csv
// para que el navegador reciba un archivo y no un JSON con otro header.
router.get(
  "/:id/kardex/csv",
  requireRole("admin"),
  validateQuery(kardexCombustibleSchema),
  asyncHandler(controller.getKardexCsv.bind(controller))
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
// El `grifero` entra acá pero de forma CONDICIONAL: si puede o no tomar
// varilla lo decide `grifero_registra_varilla` de la config del tenant
// (0085), y eso no se puede resolver con requireRole, que no lee la base.
// El middleware lo deja pasar y el controller consulta la política. Default
// true, porque es lo que hace hoy la mayoría: la varilla la toma el mismo
// que despacha, y separar quien mide de quien despacha es una política que
// solo puede permitirse una empresa con gente de sobra.
router.post(
  "/lecturas",
  requireRole("admin", "operador", "grifero"),
  validate(registrarLecturaCombustibleSchema),
  asyncHandler(controller.registrarLectura.bind(controller))
);

// 🚫 anular una lectura mal cargada -- admin y operador, los mismos que
// pueden registrarla: quien se equivoca al tipear tiene que poder
// corregirlo en el momento, sin depender de nadie más (ver el punto 3 de
// docs/architecture/control-de-combustible.md). El `grifero` queda afuera por
// el mismo motivo que en el vale: una varilla que se puede anular es una
// varilla que se puede hacer coincidir con lo que uno ya declaró. Va ANTES de /:id/nivel
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
