/**src/modules/combutible/combustible.routes.ts */

import { Router, type Request, type Response, type NextFunction } from "express";
import { validate, validateQuery } from "../../server/middleware/validate";
import { requireRole } from "../../server/shared/middlewares/roles.middleware";
import { requirePestana } from "../../server/shared/middlewares/pestana.middleware";
import { pestanaPermitida } from "../../server/services/permisosPestanas.service";
import { asyncHandler } from "../../server/shared/utils/asyncHandler";
import {
  registrarLecturaCombustibleSchema,
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
  validarRecepcionCombustibleSchema,
  resolverExcedenteRecepcionSchema,
  anularDespachoCombustibleSchema,
  subirComprobanteCompraSchema,
  marcarAlertasLeidasCombustibleSchema,
  configCombustibleSchema,
  kardexCombustibleSchema,
  periodoHistorialCombustibleSchema,
  resolverAlertaCombustibleSchema,
  bajaTanqueCombustibleSchema,
  crearConteoUreaSchema,
  anularConteoUreaSchema,
  crearPuntoPrecintoSchema,
  cambiarPrecintoSchema,
  bajaPuntoPrecintoSchema,
  crearSurtidorSchema,
  actualizarSurtidorSchema,
  conectarSurtidorSchema,
  motivoSurtidorSchema,
} from "../../server/schemas/combustible.schema";
import { moverDeGrifoSchema } from "../../server/schemas/sedes.schema";
import { cargarAlcance, GUARDIAS, requiereTanqueCompleto } from "./alcance";
import { CombustibleController } from "./combustible.controller";
import { subirArchivoComprobante } from "./combustible.upload";
import { EquiposController } from "../equipos/equipos.controller";
// Se activa solo con importarse (setInterval + .unref()) -- mismo mecanismo
// que events.ts con el worker de retención de eventos.
import "../../server/services/combustibleConciliacion.worker";

const router = Router();
const controller = new CombustibleController();
const requireHistorialOProducto =
  (pestanaBase: string, pestanaUrea = "urea:vista") =>
  (req: Request, res: Response, next: NextFunction) =>
    requirePestana("combustible", req.query.producto === "urea" ? pestanaUrea : pestanaBase)(
      req,
      res,
      next
    );

/** El listado de despachos sirve a TRES lugares distintos con permisos
 *  distintos: el botón "Historial de despacho" del panel de Tanques, la
 *  vista "Histórico de despachos (tanque propio)" y la vista "Histórico de
 *  consumo (grifo externo)". Lo que decide cuál permiso pedir es el filtro
 *  `origen` que el propio endpoint aplica después, así que un conductor con
 *  solo la vista de grifo externo habilitada no puede pedir los vales del
 *  tanque propio cambiando la URL: el permiso va atado al filtro real. */
const requireHistorialDeDespachos = (req: Request, res: Response, next: NextFunction) => {
  if (req.query.producto === "urea") {
    return requirePestana("combustible", "urea:vista")(req, res, next);
  }
  const porOrigen =
    req.query.origen === "tanque_propio"
      ? "historico:despachos"
      : req.query.origen === "compra_externa"
        ? "historico:compras_externas"
        : null;
  // Sin filtro de origen el listado trae de los dos tipos: solo lo ve
  // quien tiene el historial completo del panel de Tanques.
  if (!porOrigen)
    return requirePestana("combustible", "tanques:historial_despacho")(req, res, next);
  return requirePestanaAlguna(porOrigen, "tanques:historial_despacho")(req, res, next);
};

/** Deja pasar si el usuario tiene CUALQUIERA de las pestañas. Sirve donde un
 *  mismo dato se alcanza desde dos lugares con permisos distintos. */
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
const requirePestanaSegunProducto =
  (pestanaBase: string, pestanaUrea: string) => (req: Request, res: Response, next: NextFunction) =>
    requirePestana("combustible", req.body?.producto === "urea" ? pestanaUrea : pestanaBase)(
      req,
      res,
      next
    );

// El alcance del usuario (0100), una vez por pedido y antes de cualquier
// ruta: todo lo que sigue lo lee de req.alcanceCombustible.
router.use(cargarAlcance);
for (const [param, guardia] of Object.entries(GUARDIAS)) router.param(param, guardia);

router.get(
  "/",
  requirePestana("combustible", "tanques"),
  requireRole("admin", "operador", "lectura", "grifero"),
  asyncHandler(controller.getAll.bind(controller))
);

// El formulario de despacho necesita elegir una unidad, pero el personal de
// cancha no debe recibir acceso al módulo Equipos completo. Esta consulta
// acotada queda dentro de Combustible y solo expone el listado paginado.
router.get(
  "/equipos-destino",
  requireRole("admin", "operador", "grifero", "conductor_ruta", "encargado_urea"),
  asyncHandler(EquiposController.getAll)
);

// Despachos (Fase B) -- segmentos literales, van ANTES de /:id: si /:id
// los capturara primero, "despachos" quedaría interpretado como un id
router.get(
  "/despachos",
  requireHistorialDeDespachos,
  validateQuery(periodoHistorialCombustibleSchema),
  asyncHandler(controller.listarDespachos.bind(controller))
);
router.get(
  "/despachos/huecos",
  requirePestana("combustible", "tanques:historial_despacho"),
  asyncHandler(controller.getHuecosTalonario.bind(controller))
);

// Histórico del cliente: cada vista del selector tiene su propio permiso
// (filas 24-29 de la matriz robusta), para que el admin pueda darle a un
// perfil de cancha una sola consulta sin abrirle el resto. Segmentos
// literales, ANTES de /:id, mismo motivo que arriba.
router.get(
  "/consumo-por-conductor",
  requirePestana("combustible", "historico:por_conductor"),
  validateQuery(periodoHistorialCombustibleSchema),
  asyncHandler(controller.getConsumoPorConductor.bind(controller))
);
router.get(
  "/consumo-por-vehiculo",
  requirePestana("combustible", "historico:por_vehiculo"),
  validateQuery(periodoHistorialCombustibleSchema),
  asyncHandler(controller.getConsumoPorVehiculo.bind(controller))
);
router.get(
  "/consumo-por-grifo",
  requirePestana("combustible", "historico:por_grifo"),
  validateQuery(periodoHistorialCombustibleSchema),
  asyncHandler(controller.getConsumoPorGrifo.bind(controller))
);

// Los cuatro roles pueden POSTear acá, pero NO lo mismo: este endpoint sirve
// dos flujos distintos (el vale del tanque propio y la compra en grifo de
// ruta) que se distinguen por el campo `origen` del body. requireRole decide
// por RUTA, así que no alcanza -- sin el chequeo que hace el service, un
// conductor de ruta podría despachar del tanque de la empresa pasando por
// esta misma URL, y el rol parecería restringido sin serlo. Ver
// validarOrigenPermitidoParaRol() en combustible.service.ts.
router.post(
  "/despachos",
  requirePestanaSegunProducto("tanques:registrar_despacho", "urea:registrar_vale"),
  requireRole("admin", "operador", "grifero", "conductor_ruta", "encargado_urea"),
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
// 📎 Comprobante de la compra en ruta (0109) -- la foto de la boleta.
//
// SUBIR: los mismos que pueden registrar una compra externa, más el admin y
// el operador. El `grifero` queda afuera: su mundo es el tanque propio, no
// compra en ruta. El `encargado_urea` también -- la urea no lleva
// comprobante (conserva su talonario).
//
// El permiso de pestaña es el de registrar el despacho y no uno nuevo: subir
// la foto es terminar de registrar la compra, no una facultad aparte. Darle
// un permiso propio obligaría al admin a habilitar dos cosas para que un
// conductor pueda hacer una.
router.post(
  "/despachos/:despachoId/comprobante",
  requirePestana("combustible", "tanques:registrar_despacho"),
  requireRole("admin", "operador", "conductor_ruta"),
  subirArchivoComprobante,
  validate(subirComprobanteCompraSchema),
  asyncHandler(controller.subirComprobante.bind(controller))
);

// VER: el mismo permiso que el historial de compras. Quien puede ver que la
// compra existe tiene que poder ver su respaldo -- es justamente la persona
// de oficina que la cruza contra la factura del proveedor, y separar las dos
// cosas haría que viera el monto sin poder verificarlo.
router.get(
  "/despachos/:despachoId/comprobante",
  requirePestana("combustible", "tanques:historial_despacho"),
  asyncHandler(controller.descargarComprobante.bind(controller))
);

router.patch(
  "/despachos/:despachoId/anular",
  requireRole("admin", "operador"),
  validate(anularDespachoCombustibleSchema),
  asyncHandler(controller.anularDespacho.bind(controller))
);

// Surtidores (migración 0098) -- segmentos literales, ANTES de /:id. La lista
// la lee cualquier rol (el vale y la varilla la necesitan); lo que cambia la
// estructura del grifo es del admin, y todo pide motivo.
router.get(
  "/surtidores",
  requirePestana("combustible", "tanques:surtidores"),
  asyncHandler(controller.listarSurtidores.bind(controller))
);
router.post(
  "/surtidores",
  requirePestana("combustible", "tanques:surtidores"),
  requireRole("admin", "operador"),
  validate(crearSurtidorSchema),
  asyncHandler(controller.crearSurtidor.bind(controller))
);
router.put(
  "/surtidores/:surtidorId",
  requirePestana("combustible", "tanques:surtidores"),
  requireRole("admin", "operador"),
  validate(actualizarSurtidorSchema),
  asyncHandler(controller.actualizarSurtidor.bind(controller))
);
router.post(
  "/surtidores/:surtidorId/conexiones",
  requirePestana("combustible", "tanques:surtidores"),
  requireRole("admin", "operador"),
  validate(conectarSurtidorSchema),
  asyncHandler(controller.conectarSurtidor.bind(controller))
);
router.get(
  "/surtidores/:surtidorId/conexiones",
  requirePestana("combustible", "tanques:surtidores"),
  asyncHandler(controller.historialConexionesSurtidor.bind(controller))
);
router.patch(
  "/surtidores/:surtidorId/conexiones/:conexionId/desconectar",
  requirePestana("combustible", "tanques:surtidores"),
  requireRole("admin", "operador"),
  validate(motivoSurtidorSchema),
  asyncHandler(controller.desconectarSurtidor.bind(controller))
);
router.patch(
  "/surtidores/:surtidorId/baja",
  requirePestana("combustible", "tanques:surtidores"),
  requireRole("admin", "operador"),
  validate(motivoSurtidorSchema),
  asyncHandler(controller.bajaSurtidor.bind(controller))
);
router.patch(
  "/surtidores/:surtidorId/reactivar",
  requirePestana("combustible", "tanques:surtidores"),
  requireRole("admin", "operador"),
  validate(motivoSurtidorSchema),
  asyncHandler(controller.reactivarSurtidor.bind(controller))
);

// Precintos numerados (migración 0095) -- segmentos literales, ANTES de /:id.
// Cambiar un sello abre el tanque: admin u operador, nunca el grifero, que es
// justamente el que tiene el tanque a mano. Dar de baja un punto es aflojar
// la vigilancia: solo admin.
router.post(
  "/precintos/puntos/:puntoId/cambios",
  requireRole("admin", "operador"),
  validate(cambiarPrecintoSchema),
  asyncHandler(controller.cambiarPrecinto.bind(controller))
);
router.patch(
  "/precintos/puntos/:puntoId/baja",
  requireRole("admin"),
  validate(bajaPuntoPrecintoSchema),
  asyncHandler(controller.bajaPuntoPrecinto.bind(controller))
);

// Grifos externos y precios (migrations/0063) -- segmentos literales,
// mismo motivo que /despachos: tienen que ir ANTES de /:id.
router.get(
  "/grifos",
  requirePestana("combustible", "tanques:proveedores"),
  asyncHandler(controller.listarGrifos.bind(controller))
);
router.post(
  "/grifos",
  requirePestana("combustible", "tanques:proveedores"),
  requireRole("admin", "operador"),
  validate(crearGrifoCombustibleSchema),
  asyncHandler(controller.crearGrifo.bind(controller))
);
router.put(
  "/grifos/:id",
  requirePestana("combustible", "tanques:proveedores"),
  requireRole("admin", "operador"),
  validate(actualizarGrifoCombustibleSchema),
  asyncHandler(controller.actualizarGrifo.bind(controller))
);

// GET /precios/vigente ANTES de GET /precios y de GET /:id -- Express
// matchea por orden de registro, no por especificidad.
router.get(
  "/precios/vigente",
  requirePestana("combustible", "tanques:precios"),
  asyncHandler(controller.getPrecioVigente.bind(controller))
);
router.get(
  "/precios",
  requirePestana("combustible", "tanques:precios"),
  asyncHandler(controller.listarPrecios.bind(controller))
);
router.post(
  "/precios",
  requirePestana("combustible", "tanques:precios"),
  requireRole("admin", "operador"),
  validate(crearPrecioCombustibleSchema),
  asyncHandler(controller.crearPrecio.bind(controller))
);
router.patch(
  "/precios/:precioId/anular",
  requirePestana("combustible", "tanques:precios"),
  requireRole("admin", "operador"),
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
router.get(
  "/recepciones",
  requireHistorialOProducto("historico:recepciones"),
  validateQuery(periodoHistorialCombustibleSchema),
  asyncHandler(controller.listarRecepciones.bind(controller))
);
router.post(
  "/recepciones",
  requirePestanaSegunProducto("tanques:registrar_recepcion", "urea:registrar_entrada"),
  requireRole("admin", "operador", "grifero", "encargado_urea"),
  validate(crearRecepcionCombustibleSchema),
  asyncHandler(controller.crearRecepcion.bind(controller))
);
// El resto de la decisión sobre un excedente (0102) que el 409 de arriba
// deja pendiente -- "aceptar" es un re-POST a /recepciones, este endpoint es
// solo para "rechazar" y "contactar_admin", que no guardan nada. Mismo
// reparto de roles que /recepciones: quien puede recibir, puede decidir.
router.post(
  "/recepciones/resolver-excedente",
  requirePestanaSegunProducto("tanques:registrar_recepcion", "urea:registrar_entrada"),
  requireRole("admin", "operador", "grifero"),
  validate(resolverExcedenteRecepcionSchema),
  asyncHandler(controller.resolverExcedenteRecepcion.bind(controller))
);
// ✅ VALIDAR la recepción contra la guía (5ª auditoría, migración 0088).
//
// SOLO admin, y el reparto es el punto entero del control: el grifero
// registra lo que descarga la cisterna, administración escribe lo que dice la
// guía. Con una sola persona escribiendo los dos números no hay control --
// verificado: registrar 9.000 de una entrega de 10.000 y llevarse la
// diferencia no disparaba una sola alerta.
router.patch(
  "/recepciones/:recepcionId/validar",
  requirePestana("combustible", "tanques:gestion_recepciones"),
  requireRole("admin"),
  validate(validarRecepcionCombustibleSchema),
  asyncHandler(controller.validarRecepcion.bind(controller))
);

router.patch(
  "/recepciones/:recepcionId/anular",
  requirePestana("combustible", "tanques:gestion_recepciones"),
  requireRole("admin", "operador"),
  validate(anularRecepcionCombustibleSchema),
  asyncHandler(controller.anularRecepcion.bind(controller))
);

// Conteo físico de urea (migración 0092) -- segmentos literales, ANTES de
// /:id, mismo motivo que el resto.
//
// Kenif confirmó (2026-09-16) que HOY es la MISMA persona la que recibe la
// compra, la reparte a las unidades y cuenta lo que queda en almacén --
// cero segregación de funciones. Por eso `admin` + `grifero` acá también
// (mismo reparto que /recepciones): no hay a quién más dárselo todavía. El
// costo de esto -- que el conteo se pueda "hacer cuadrar" -- es el límite
// conocido del módulo ("si el admin es el dueño nadie lo vigila"); lo que
// se puede hacer es que quede visible, no impedirlo. Pendiente: si esta
// persona (¿logística?) recibe su propio acceso, revisar este reparto.
router.get(
  "/urea/estado",
  requirePestana("combustible", "urea:vista"),
  asyncHandler(controller.getEstadoUrea.bind(controller))
);
router.get(
  "/urea/conteos",
  requirePestana("combustible", "urea:vista"),
  asyncHandler(controller.listarConteosUrea.bind(controller))
);
router.post(
  "/urea/conteos",
  requirePestana("combustible", "urea:registrar_conteo_fisico"),
  requireRole("admin", "operador", "grifero", "encargado_urea"),
  validate(crearConteoUreaSchema),
  asyncHandler(controller.crearConteoUrea.bind(controller))
);
router.patch(
  "/urea/conteos/:id/anular",
  requirePestana("combustible", "urea:registrar_conteo_fisico"),
  requireRole("admin", "operador"),
  validate(anularConteoUreaSchema),
  asyncHandler(controller.anularConteoUrea.bind(controller))
);

// Alertas (migrations/0068) -- segmentos literales, mismo motivo que
// /despachos: tienen que ir ANTES de /:id.
//
// Solo admin: es visibilidad de gerencia (hueco de talonario, vale
// anulado), el operador no la necesita para hacer su trabajo de cancha.
router.get(
  "/alertas",
  requirePestana("combustible", "tanques:alertas"),
  requireRole("admin", "operador"),
  asyncHandler(controller.listarAlertas.bind(controller))
);
router.patch(
  "/alertas/leidas",
  requirePestana("combustible", "tanques:alertas"),
  requireRole("admin", "operador"),
  validate(marcarAlertasLeidasCombustibleSchema),
  asyncHandler(controller.marcarAlertasLeidas.bind(controller))
);
router.patch(
  "/alertas/:alertaId/resolver",
  requirePestana("combustible", "tanques:alertas"),
  requireRole("admin", "operador"),
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
  requirePestana("combustible", "bitacora"),
  requireRole("admin", "operador"),
  asyncHandler(controller.listarBitacora.bind(controller))
);

router.get(
  "/config",
  requirePestana("combustible", "tanques"),
  requireRole("admin"),
  asyncHandler(controller.getConfig.bind(controller))
);
router.put(
  "/config",
  requirePestana("combustible", "tanques"),
  requireRole("admin"),
  validate(configCombustibleSchema),
  asyncHandler(controller.guardarConfig.bind(controller))
);
// Topes diarios sugeridos desde el historial (respuesta de Kenif 2026-09-14:
// "guiarnos por el historial para que nos recomiende"). Segmento literal,
// ANTES de /:id.
router.get(
  "/config/sugerencia-topes",
  requirePestana("combustible", "tanques:alertas"),
  requireRole("admin"),
  asyncHandler(controller.getSugerenciaTopes.bind(controller))
);
router.get(
  "/anomalias",
  requirePestana("combustible", "auditoria"),
  requireRole("admin", "operador"),
  asyncHandler(controller.listarAnomalias.bind(controller))
);

// Segmento literal: VA ANTES de /:id, o Express lo tomaría como un id.
// Consumo máximo sugerido para un equipo, desde sus propias cargas. Solo
// admin: es configuración, igual que el asistente de umbrales del tanque.
router.get(
  "/equipos/:equipoId/sugerencia-consumo",
  requirePestana("combustible", "auditoria"),
  requireRole("admin"),
  asyncHandler(controller.getSugerenciaConsumo.bind(controller))
);

router.get(
  "/:id",
  requirePestana("combustible", "tanques:acciones:ver_tanque"),
  asyncHandler(controller.getById.bind(controller))
);
// Los puntos precintados del tanque con su número vigente. Cualquier rol: el
// que toma la varilla necesita saber qué sellos mirar.
router.get(
  "/:id/precintos",
  requirePestana("combustible", "tanques:acciones:ver_tanque"),
  requiereTanqueCompleto,
  asyncHandler(controller.listarPuntosPrecinto.bind(controller))
);
// Grifo interno del tanque (0097). Mover cambia quién lo ve (entrega 3): solo
// admin, con motivo. Los errores de negocio salen como AppError del servicio.
router.post(
  "/:id/mover-grifo",
  requireRole("admin"),
  validate(moverDeGrifoSchema),
  asyncHandler(controller.moverDeGrifo.bind(controller))
);
router.get(
  "/:id/movimientos-grifo",
  asyncHandler(controller.listarMovimientosDeGrifo.bind(controller))
);
router.get(
  "/:id/precintos/historial",
  requireRole("admin"),
  asyncHandler(controller.historialPrecintos.bind(controller))
);
router.post(
  "/:id/precintos/puntos",
  requireRole("admin"),
  validate(crearPuntoPrecintoSchema),
  asyncHandler(controller.crearPuntoPrecinto.bind(controller))
);
router.get(
  "/:id/lecturas",
  requirePestana("combustible", "tanques:acciones:historial_varilla"),
  // El historial de varillas es del grifo entero (0100).
  requiereTanqueCompleto,
  validateQuery(periodoHistorialCombustibleSchema),
  asyncHandler(controller.getLecturas.bind(controller))
);

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

// Consumo por equipo contra sus pares y contra su propio pasado: el único
// control que ve el robo que sale CON vale.
router.get(
  "/reportes/consumo-equipos",
  requireRole("admin"),
  validateQuery(kardexCombustibleSchema),
  asyncHandler(controller.getReporteConsumoEquipos.bind(controller))
);

// Kardex del tanque: las tres historias (despachos, recepciones, lecturas)
// en UNA línea de tiempo con saldo corriente. Solo admin -- es visibilidad
// de gerencia y la herramienta del auditor, no trabajo de cancha.
router.get(
  "/:id/kardex",
  requirePestana("combustible", "tanques:acciones:kardex"),
  requireRole("admin", "operador"),
  validateQuery(kardexCombustibleSchema),
  asyncHandler(controller.getKardex.bind(controller))
);

// El mismo kardex, descargable. Va como ruta aparte y no como ?formato=csv
// para que el navegador reciba un archivo y no un JSON con otro header.
router.get(
  "/:id/kardex/csv",
  requirePestana("combustible", "tanques:acciones:kardex"),
  requireRole("admin", "operador"),
  validateQuery(kardexCombustibleSchema),
  asyncHandler(controller.getKardexCsv.bind(controller))
);

// El mismo kardex en .xlsx: números que suman, dos hojas y totales como
// fórmulas. Convive con el CSV, no lo reemplaza.
router.get(
  "/:id/kardex/xlsx",
  requirePestana("combustible", "tanques:acciones:kardex"),
  requireRole("admin", "operador"),
  validateQuery(kardexCombustibleSchema),
  asyncHandler(controller.getKardexXlsx.bind(controller))
);

// Asistente de calibración del umbral (Fase D, entrega 3) -- solo admin,
// es una decisión de configuración, no trabajo de cancha.
router.get(
  "/:id/sugerencia-umbral",
  requireRole("admin"),
  asyncHandler(controller.getSugerenciaUmbral.bind(controller))
);

// De dónde sale la sugerencia: la muestra fila por fila y los números de la
// etiqueta como fórmulas. Mismo permiso que ver la sugerencia.
router.get(
  "/:id/sugerencia-umbral/xlsx",
  requireRole("admin"),
  asyncHandler(controller.getSugerenciaUmbralXlsx.bind(controller))
);

// ➕ crear tanque -- admin únicamente: dar de alta un punto de
// abastecimiento es configuración de planta, no trabajo de campo (mismo
// criterio que las plantillas de Checklists, no las OT/movimientos).
router.post(
  "/",
  requirePestana("combustible", "tanques:nuevo_tanque"),
  requireRole("admin", "operador"),
  validate(crearTanqueCombustibleSchema),
  asyncHandler(controller.create.bind(controller))
);

// ✏️ actualizar tanque
router.put(
  "/:id",
  requirePestana("combustible", "tanques:acciones:editar"),
  requireRole("admin", "operador"),
  validate(actualizarTanqueCombustibleSchema),
  asyncHandler(controller.update.bind(controller))
);

// 🗑 soft-delete -- ver CombustibleController.delete
router.delete(
  "/:id",
  requirePestana("combustible", "tanques:acciones:eliminar"),
  requireRole("admin", "operador"),
  validate(bajaTanqueCombustibleSchema),
  asyncHandler(controller.delete.bind(controller))
);

// 📦 importación masiva -- el límite de tamaño del cuerpo ya lo amplía
// app.ts de forma genérica para cualquier ruta que termine en /bulk.
router.post(
  "/bulk",
  requirePestana("combustible", "tanques:importar_excel"),
  requireRole("admin", "operador"),
  validate(cargaMasivaTanquesCombustibleSchema),
  asyncHandler(controller.bulk.bind(controller))
);

// Ruta literal, sin `:id` -- el combustible_id viaja en el body a propósito
// (ver el comentario en el controller).
// El `grifero` entra acá pero de forma CONDICIONAL: si puede o no tomar
// varilla lo decide `grifero_registra_varilla` de la config del tenant
// (0085), y eso no se puede resolver con requireRole, que no lee la base.
// El middleware lo deja pasar y el controller consulta la política. Default
// true, porque es lo que hace hoy la mayoría: la varilla la toma el mismo
// que despacha, y separar quien mide de quien despacha es una política que
// solo puede permitirse una empresa con gente de sobra.
router.post(
  "/lecturas",
  requirePestana("combustible", "tanques:acciones:registrar_lectura_varilla"),
  requireRole("admin", "operador", "grifero"),
  validate(registrarLecturaCombustibleSchema),
  asyncHandler(controller.registrarLectura.bind(controller))
);

// 🚫 anular una lectura mal cargada -- quien se equivoca al tipear tiene que
// poder corregirlo en el momento, sin depender de nadie más (ver el punto 3
// de docs/architecture/control-de-combustible.md).
//
// El `grifero` entra desde la matriz robusta de perfiles (fila 21: "puede
// anular el mal tipeo pero justificando, deja alerta"). El riesgo es real y
// conocido --una varilla que se puede anular es una varilla que se puede
// hacer coincidir con lo que uno ya declaró-- y lo que lo hace tolerable es
// que no queda en silencio: cada anulación suya levanta una alerta
// `lectura_anulada` con el motivo (ver anularLectura en el controller).
router.patch(
  "/lecturas/:lecturaId/anular",
  requirePestana("combustible", "tanques:acciones:anular_lectura_varilla"),
  requireRole("admin", "operador", "grifero"),
  validate(anularLecturaCombustibleSchema),
  asyncHandler(controller.anularLectura.bind(controller))
);

// PUT /:id/nivel ya NO existe (5ª auditoría, 2026-09-14). Era la puerta de
// antes de /lecturas: guardaba la varilla pero no evaluaba ningún descuadre
// --ni tramo, ni ciclo, ni ventana-- así que un operador podía medir "de
// verdad" después de sacar 3.000 L y el sistema no decía nada. El frontend ya
// no la usaba. Una varilla entra por UN solo camino, y ese camino corre
// todos los controles. Si alguien propone reabrirla "por compatibilidad",
// que pase por registrarLectura y procesarLecturaRegistrada, no por al lado.

export default router;
