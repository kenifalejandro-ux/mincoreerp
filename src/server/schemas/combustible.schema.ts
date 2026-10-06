import { z } from "zod";

import { grifoNoEditable } from "./sedes.schema";

// ── Tanques / puntos de abastecimiento (Fase A, ver
// docs/architecture/control-de-combustible.md) ─────────────────────────────

const TIPOS_COMBUSTIBLE = ["diesel_b5", "gasolina_90", "glp"] as const;
const UNIDADES_COMBUSTIBLE = ["gal", "L"] as const;
const TIPOS_PUNTO_COMBUSTIBLE = ["fijo", "cisterna", "surtidor"] as const;

// `nivel_actual` NO está acá a propósito: se gestiona exclusivamente por
// POST /lecturas (ver combustible.repository.ts, registrarLectura) para que
// el historial de combustible_lecturas nunca quede desincronizado del valor
// vigente -- mismo motivo por el que existe 0045_combustible_lecturas.sql.
// `totalizador_actual` tampoco: nace en 0 en esta fase, lo mueve la Fase B
// (despachos). `costo_promedio` TAMPOCO, y sigue sin estar: desde la Fase C
// lo calcula el motor de recepciones (migrations/0064), no se tipea a mano.
export const crearTanqueCombustibleSchema = z.object({
  codigo: z.string().trim().min(1).max(50),
  tanque_nombre: z.string().trim().min(1).max(100),
  tipo_combustible: z.enum(TIPOS_COMBUSTIBLE),
  unidad: z.enum(UNIDADES_COMBUSTIBLE),
  tipo_punto: z.enum(TIPOS_PUNTO_COMBUSTIBLE),
  ubicacion: z.string().trim().max(200).optional(),
  capacidad_total: z.number().positive(),
  nivel_actual: z.number().nonnegative().default(0),
  nivel_minimo: z.number().nonnegative().default(0),
  moneda: z.string().trim().length(3).default("PEN"),
  // Configuración de Fase C (migrations/0064). Los defaults reproducen el
  // comportamiento anterior a esa migración -- un tanque creado sin tocar
  // estos campos se comporta igual que siempre.
  tolerancia_capacidad_pct: z.number().min(0).max(100).default(0),
  // Qué hacer cuando una recepción supera capacidad + tolerancia (migración
  // 0102). 'estricto' reproduce el comportamiento de siempre: rechaza. Ver
  // el encabezado de esa migración para el argumento completo.
  modo_excedente_recepcion: z.enum(["estricto", "flexible"]).default("estricto"),
  // Tope adicional (% de capacidad_total) dentro del cual el modo flexible
  // deja decidir. NULL = sin tope, cualquier excedente admite decisión.
  limite_excedente_pct: z.number().min(0).nullable().default(null),
  requiere_documento: z.boolean().default(true),
  // Los dos umbrales son NULLABLE desde 0075, y los tres valores dicen
  // cosas distintas: NULL = sin configurar (no alertar), 0 = estricto
  // (alertar por cualquier diferencia), N = tolerar hasta ese %. Antes el 0
  // significaba "sin configurar" y la tolerancia cero real no se podía
  // expresar -- ver el encabezado de 0075.
  umbral_diferencia_pct: z.number().min(0).max(100).nullable().default(null),
  umbral_descuadre_pct: z.number().min(0).max(100).nullable().default(null),
  // El acumulado del ciclo (migración 0076). Va aparte del de tramo porque
  // el error del contómetro de cada despacho se suma a lo largo del ciclo (el
  // de la varilla no: se cancela entre tramos seguidos).
  umbral_descuadre_ciclo_pct: z.number().min(0).max(100).nullable().default(null),
  // El acumulado de la ventana deslizante (0080): el único que no se
  // reinicia con una recepción, y por eso el que atrapa el robo de a poco.
  umbral_descuadre_ventana_pct: z.number().min(0).max(100).nullable().default(null),
  /** EL PISO FIJO DE CADA UMBRAL (migración 0101), en la unidad del tanque.
   *
   *  La tolerancia de un control es `piso + pct/100 × lo movido`. El piso
   *  cubre el error de la varilla --que no depende del movimiento ni del
   *  tamaño del tanque-- y el porcentaje cubre el de los medidores, que sí
   *  crece con el volumen que pasa por ellos.
   *
   *  El par es ATÓMICO y lo normaliza el service (`normalizarUmbrales`): o
   *  los dos son NULL (sin configurar, no alerta) o los dos son números.
   *  Mandar el pct sin el piso deja el piso en 0 = sin piso, que es el lado
   *  estricto. Sin `.max()`: un piso se mide en litros o galones, no tiene
   *  techo natural más allá del CHECK de no-negativo. */
  umbral_diferencia_piso: z.number().min(0).nullable().default(null),
  umbral_descuadre_piso: z.number().min(0).nullable().default(null),
  umbral_descuadre_ciclo_piso: z.number().min(0).nullable().default(null),
  umbral_descuadre_ventana_piso: z.number().min(0).nullable().default(null),
  /** Qué eligió la persona en el alta: "recomendado" | "personalizado" |
   *  "sin_vigilar". NO se guarda en la tabla -- los umbrales ya dicen cómo
   *  quedó configurado el tanque. Existe para la AUDITORÍA: distingue "eligió
   *  explícitamente no vigilar" de "guardó sin mirar", que era el caso por
   *  defecto y el problema que esta pantalla vino a cerrar.
   *
   *  Opcional en el schema y obligatorio en el formulario: la API no puede
   *  romper a un cliente viejo (la cola offline, un script) por un dato que
   *  solo sirve para el registro. */
  modo_vigilancia: z.enum(["recomendado", "personalizado", "sin_vigilar"]).optional(),
  // Totalizador acumulativo del surtidor (0094). Nace APAGADO: falta confirmar
  // con el cliente que sus surtidores lo tienen y que se anota en cada vale.
  usa_totalizador: z.boolean().default(false),
  totalizador_tolerancia: z.number().min(0).max(1000).default(1),
  // Precintos numerados (0095). Apagado por el mismo motivo que el
  // totalizador: el cliente que no los usa no tiene que ver ni un campo.
  usa_precintos: z.boolean().default(false),
  // El grifo interno donde está el tanque (0097). Opcional: con un solo grifo
  // en la empresa lo asigna la base; con más de uno el servicio lo exige.
  grifo_interno_id: z.number().int().positive().optional(),
});

export type CrearTanqueCombustibleInput = z.infer<typeof crearTanqueCombustibleSchema>;

// PUT reemplaza la fila entera (mismo criterio que actualizarRepuestoSchema):
// omitir un campo no significa "dejalo como está", así que ninguno tiene
// `.default()`. `nivel_actual` sigue sin estar acá -- editar el tanque no es
// el camino para corregir su nivel, eso participa de la cola offline
// (POST /lecturas) y de ese historial no se sale por acá.
export const actualizarTanqueCombustibleSchema = z.object({
  codigo: z.string().trim().min(1).max(50),
  tanque_nombre: z.string().trim().min(1).max(100),
  tipo_combustible: z.enum(TIPOS_COMBUSTIBLE),
  unidad: z.enum(UNIDADES_COMBUSTIBLE),
  tipo_punto: z.enum(TIPOS_PUNTO_COMBUSTIBLE),
  ubicacion: z.string().trim().max(200).optional(),
  capacidad_total: z.number().positive(),
  nivel_minimo: z.number().nonnegative(),
  moneda: z.string().trim().length(3),
  activo: z.boolean(),
  // Sin `.default()`, como el resto de este schema: PUT reemplaza la fila
  // entera, omitir un campo no significa "dejalo como está".
  tolerancia_capacidad_pct: z.number().min(0).max(100),
  modo_excedente_recepcion: z.enum(["estricto", "flexible"]),
  limite_excedente_pct: z.number().min(0).nullable(),
  requiere_documento: z.boolean(),
  umbral_diferencia_pct: z.number().min(0).max(100).nullable(),
  umbral_descuadre_pct: z.number().min(0).max(100).nullable(),
  umbral_descuadre_ciclo_pct: z.number().min(0).max(100).nullable(),
  umbral_descuadre_ventana_pct: z.number().min(0).max(100).nullable(),
  /** Los cuatro pisos (0101) van OPCIONALES, al revés que los porcentajes de
   *  acá arriba: omitirlos CONSERVA el valor actual. Mismo criterio que
   *  `usa_totalizador` y por el mismo motivo -- un cliente viejo que no
   *  conoce el campo (la cola offline, un script, el formulario hasta que se
   *  actualice) no puede bajar un piso a 0 sin querer y llenar de falsos
   *  positivos al tenant. Mandar `null` explícito SÍ apaga el umbral entero,
   *  y eso pide motivo como cualquier aflojamiento. */
  umbral_diferencia_piso: z.number().min(0).nullable().optional(),
  umbral_descuadre_piso: z.number().min(0).nullable().optional(),
  umbral_descuadre_ciclo_piso: z.number().min(0).nullable().optional(),
  umbral_descuadre_ventana_piso: z.number().min(0).nullable().optional(),
  /** Obligatorio SOLO si el cambio AFLOJA una vigilancia (subir un umbral,
   *  apagarlo poniéndolo en null, o dejar de exigir documento). No se puede
   *  validar acá porque depende de los valores actuales del tanque, que Zod
   *  no ve -- lo exige el service. Ver `evaluarAflojamiento`.
   *
   *  Motivo de que exista: hasta 0077, pasar el umbral de 1% a 90% -- que es
   *  APAGAR la detección de fraude -- quedaba en la auditoría igual que
   *  renombrar el tanque. */
  motivo_ajuste: z.string().trim().min(1).max(500).optional(),
  // OPCIONALES a propósito, al revés que el resto de este schema: omitirlos
  // conserva el valor actual. Un cliente viejo (la cola offline, un script) que
  // no los conoce no puede apagar el control sin querer.
  usa_totalizador: z.boolean().optional(),
  totalizador_tolerancia: z.number().min(0).max(1000).optional(),
  usa_precintos: z.boolean().optional(),
  // Cambiar de grifo NO es editar el tanque: tiene su propio endpoint, con
  // motivo y rastro (0097). Mandarlo acá es un error, no algo que se ignora.
  grifo_interno_id: grifoNoEditable,
});

export type ActualizarTanqueCombustibleInput = z.infer<typeof actualizarTanqueCombustibleSchema>;

/** Mismo valor y mismo motivo que MAX_FILAS_CARGA_MASIVA en
 *  repuestos.schema.ts -- pero los tanques son configuración (unos pocos
 *  por tenant, ver el comentario de `cuota` en modules/registry.ts), así
 *  que en la práctica nunca se va a acercar a este techo; existe para
 *  acotar el trabajo de un request, no porque se espere un uso real cerca
 *  del límite. */
export const MAX_FILAS_CARGA_MASIVA_TANQUES = 5000;

export const cargaMasivaTanquesCombustibleSchema = z
  .array(crearTanqueCombustibleSchema)
  .min(1, "La importación no puede estar vacía")
  .max(
    MAX_FILAS_CARGA_MASIVA_TANQUES,
    `No se pueden importar más de ${MAX_FILAS_CARGA_MASIVA_TANQUES} filas de una vez`
  );

export type CargaMasivaTanquesCombustibleInput = z.infer<
  typeof cargaMasivaTanquesCombustibleSchema
>;

// ── Lecturas (ya existía) ───────────────────────────────────────────────

export const registrarLecturaCombustibleSchema = z.object({
  // Lo genera el dispositivo con crypto.randomUUID() al apretar "Registrar
  // lectura", online u offline (ver client/src/offline/). Opcional a
  // propósito: sin él, la creación se comporta igual que siempre. Con él,
  // un reintento del mismo envío no duplica (ver idempotentInsert.ts).
  cliente_uuid: z.string().uuid().optional(),
  combustible_id: z.number().int().positive(),
  nivel: z.number().nonnegative(),
  // Cuándo se TOMÓ la lectura, no cuándo llegó al servidor -- decide si
  // actualiza nivel_actual (ver combustible.repository.ts). Opcional:
  // sin dato, el service usa now() (siempre "la más reciente" en ese caso).
  //
  // NO puede estar en el FUTURO (0078), por el mismo motivo que
  // `despachado_en` desde 0077 -- pero acá el daño es mayor: el nivel del
  // tanque ES la última lectura vigente, así que una varilla fechada 90 días
  // adelante se vuelve el nivel oficial y NINGUNA medición real posterior la
  // desplaza hasta que llegue esa fecha. La simulación de robo lo aceptó sin
  // una queja.
  //
  // Mismo margen de 1 hora que el despacho: los dispositivos de cancha vienen
  // con el reloj corrido y rechazar una medición real por dos minutos de
  // desfase es peor que el margen.
  leido_en: z
    .string()
    .datetime()
    .refine((v) => new Date(v).getTime() <= Date.now() + 60 * 60 * 1000, {
      message: "La fecha de la lectura no puede estar en el futuro",
    })
    .optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  // El contador ACUMULATIVO del surtidor leído al medir (0096). Lo exige el
  // servicio si el tanque usa totalizador -- Zod no ve la fila del tanque.
  totalizador_lectura: z.number().nonnegative().optional(),
  // Lo que se leyó en CADA surtidor del tanque (0098). Lo exige el servicio
  // para los que tienen la casilla. `totalizador_lectura` sigue valiendo con un
  // solo surtidor: es lo que manda la app vieja del caché del celular.
  totalizadores: z
    .array(
      z.object({
        surtidor_id: z.number().int().positive(),
        valor: z.number().nonnegative(),
      })
    )
    .max(20)
    .optional(),
  // Lo que se VE en cada punto precintado al tomar la varilla (0095). Solo
  // si el tanque usa precintos; cuáles puntos son obligatorios lo decide el
  // servicio, que ve los puntos del tanque. `numero: null` = "no hay
  // precinto": el sello no está, que es un hallazgo y no un dato que falta.
  precintos: z
    .array(
      z.object({
        punto_id: z.number().int().positive(),
        numero: z.string().trim().min(1).max(40).nullable(),
      })
    )
    .max(20)
    .optional(),
});

export type RegistrarLecturaCombustibleInput = z.infer<typeof registrarLecturaCombustibleSchema>;

/** Anular una lectura mal cargada (ej. se tipeó 500 en vez de 19.000). La
 *  fila NUNCA se borra ni se edita -- ver migrations/0058 y el punto 3 de
 *  docs/architecture/control-de-combustible.md.
 *
 *  `motivo` es OBLIGATORIO, a diferencia del `motivo` opcional del panel de
 *  plataforma: es lo único que distingue "me equivoqué al tipear" de
 *  "estoy tapando un número que no me conviene". Sin él la válvula de
 *  escape no sirve como respaldo de nada. */
export const anularLecturaCombustibleSchema = z.object({
  motivo: z.string().trim().min(1, "El motivo de la anulación es obligatorio").max(500),
});

export type AnularLecturaCombustibleInput = z.infer<typeof anularLecturaCombustibleSchema>;

// ── Despachos (Fase B, ver docs/architecture/control-de-combustible.md
// puntos 1, 2 y 5, y migrations/0062) ───────────────────────────────────

// 'excedente_recepcion' (0112): el vale que regulariza un excedente cargado
// directo de la cisterna a una unidad. No sale de ningún tanque.
// 'tanqueta' (0114): la carga en ruta desde una tanqueta, que registra el
// conductor con el medidor de la unidad. No sale de ningún tanque.
// 'almacen' (0119): solo urea -- el reparto desde el depósito de la empresa,
// con talonario propio. Es el análogo de tanque_propio y es lo único que baja
// el stock de urea. La urea comprada en ruta es 'compra_externa', con el
// mismo significado que en combustible.
const ORIGENES_DESPACHO = [
  "tanque_propio",
  "compra_externa",
  "excedente_recepcion",
  "tanqueta",
  "almacen",
] as const;
const TIPOS_DESTINO_DESPACHO = ["equipo", "planta", "reserva_cubeta"] as const;

// Qué papel entrega el proveedor en la ruta (0109). Mismo vocabulario que
// `facturas.comprobante_tipo` de billing (0041), que ya usa 'boleta' y
// 'factura' -- no se inventa un enum paralelo para el mismo concepto.
// 'comprobante_pago' no entra: ese es un documento que EMITE el sistema,
// no uno que recibe el conductor en el grifo.
export const TIPOS_COMPROBANTE_COMPRA = ["boleta", "factura"] as const;

// ── Urea automotriz (migrations/0092) ────────────────────────────────────
// Discriminador nuevo, ortogonal a `tipo_combustible` -- Kenif fue
// explícito: la urea NO entra en ese enum (no es "otro combustible", es
// otro producto que comparte la misma tabla).
const PRODUCTOS_DESPACHO = ["combustible", "urea"] as const;

// ── Presentaciones de urea: SEMILLA, no fuente de verdad (0116) ──────────
//
// Hasta 0116 este mapa ERA la fuente de verdad del factor de conversión, y
// `presentacion` era un enum de tres valores fijos. Dejó de serlo: los
// litros por bulto viven en `combustible_urea_presentaciones`, una por
// empresa y editable desde la pantalla, porque la caja cambió de 16 a 20 L
// a los veinte días de arrancar y el próximo envase no debería costar una
// migración (ver docs/architecture/urea-industrial.md, decisión 3).
//
// Esto queda SOLO como semilla: lo usa el alta de un tenant nuevo
// (platform.service.ts) para crearle su catálogo inicial, igual que el seed
// de la migración. NADIE debe usarlo para calcular litros -- el factor sale
// del catálogo del tenant y se CONGELA en cada fila (combustible.service.ts,
// resolverFactorPresentacionUrea).
export const PRESENTACIONES_UREA_INICIALES = [
  { codigo: "bolsa", nombre: "Bolsa", litros: 4, esReferencia: false },
  { codigo: "caja", nombre: "Caja", litros: 16, esReferencia: true },
  { codigo: "balde", nombre: "Balde", litros: 20, esReferencia: false },
] as const;

/** Forma del código de presentación -- espejo exacto del CHECK
 *  `combustible_urea_presentaciones_codigo_check` de 0116. Que EXISTA en el
 *  catálogo del tenant y esté activa lo valida el service (necesita leer
 *  otra tabla, que es justo lo que Zod no puede hacer); esto solo ataja la
 *  forma, para dar un 400 legible antes de tocar la base. */
const codigoPresentacionUrea = z
  .string()
  .trim()
  .regex(/^[a-z0-9_]{2,20}$/, "El código de presentación va en minúsculas, sin espacios");

/** Reglas cruzadas que Zod no expresa "limpio" solo con tipos -- por eso
 *  van en `.superRefine()` en vez de intentar dos schemas con `.and()`/
 *  discriminated union por dos campos a la vez (origen Y tipo_destino son
 *  independientes entre sí). Espejo de los CHECK de la migración 0062:
 *  esta es la validación que da un 400 legible ANTES de tocar la base: el
 *  CHECK sigue estando, como red de seguridad, para cualquier insert que
 *  no pase por acá.
 *
 *  La rama de urea vive SEPARADA del resto de este `.superRefine()`, no
 *  entrelazada campo por campo con la lógica de combustible: son dos
 *  formas de vale completamente distintas (sin contómetro/horómetro/
 *  odómetro/horas, con presentación/bultos en su lugar) y mezclarlas
 *  campo a campo es como terminó necesitando reescritura el CHECK de la
 *  migración -- ver el comentario de esa migración. */
/** Serie + número son opcionales a nivel de objeto desde 0109 (la compra
 *  externa ya no los lleva), así que las tres formas que SÍ los exigen
 *  --tanque propio, urea, y la compra externa en formato anterior-- lo
 *  piden por acá en vez de repetir el par de `addIssue`. */
function exigirVale(
  data: { serie_talonario?: string; n_vale?: number },
  ctx: z.RefinementCtx,
  queEs: string
) {
  if (data.serie_talonario === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["serie_talonario"],
      message: `serie_talonario es obligatoria para ${queEs}`,
    });
  }
  if (data.n_vale === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["n_vale"],
      message: `n_vale es obligatorio para ${queEs}`,
    });
  }
}

export const crearDespachoCombustibleSchema = z
  .object({
    // Mismo mecanismo que registrarLecturaCombustibleSchema -- lo genera
    // el dispositivo, online u offline. Opcional: sin él, siempre crea.
    cliente_uuid: z.string().uuid().optional(),

    // Default 'combustible': todo llamador existente (frontend viejo, cola
    // offline con un vale ya en cola) sigue funcionando exactamente igual
    // sin mandar este campo -- el mismo criterio que grifero_registra_varilla.
    producto: z.enum(PRODUCTOS_DESPACHO).default("combustible"),

    origen: z.enum(ORIGENES_DESPACHO),
    // Solo excedente_recepcion (0112): la línea del reparto que regulariza.
    excedente_linea_id: z.number().int().positive().optional(),
    // 0114: a qué tanqueta va un vale del tanque a "reserva_cubeta", y de qué
    // tanqueta sale una carga en ruta (origen 'tanqueta').
    tanqueta_destino_id: z.number().int().positive().optional(),
    tanqueta_origen_id: z.number().int().positive().optional(),
    // 0115: dónde se cargó desde la tanqueta. 'ruta' (default): sin vale y con
    // medidor. 'planta': con vale, como el tanque.
    tanqueta_lugar: z.enum(["ruta", "planta"]).optional(),
    // Solo tanque_propio.
    combustible_id: z.number().int().positive().optional(),
    // compra_externa (combustible) Y urea -- FK al catálogo -- ver
    // migrations/0063: texto libre (0062) no alcanzaba para engancharle un
    // precio de forma confiable. Para urea el proveedor es "aparte"
    // (confirmado por el cliente), marcado con `abastece_urea` en vez de
    // `abastece_ruta`/`abastece_tanque`.
    grifo_id: z.number().int().positive().optional(),

    // Mismo enum que combustible.tipo_combustible (Fase A) -- se reusa a
    // propósito, ver hallazgo 2 de la memoria de columnas reales. Solo
    // aplica a producto='combustible' -- la urea no tiene un "tipo" que
    // declarar acá (ver PRODUCTOS_DESPACHO arriba).
    tipo_combustible: z.enum(TIPOS_COMBUSTIBLE).optional(),

    tipo_destino: z.enum(TIPOS_DESTINO_DESPACHO),
    // Solo cuando tipo_destino = 'equipo'.
    equipo_id: z.number().int().positive().optional(),

    // El talonario -- reinicia por serie/mes, ver hallazgo 6. Desde 0092
    // el espacio de nombres es (serie_talonario, producto): el cliente
    // aceptó un talonario PROPIO para urea, así que dos series con el
    // mismo nombre en productos distintos no compiten por el mismo número.
    //
    // Opcionales DESDE 0109, no por relajación: la obligatoriedad pasó a
    // depender del origen y eso solo se puede expresar en el superRefine.
    // El tanque propio y la urea los siguen exigiendo; la compra externa
    // los prohíbe (ahí nunca hubo talonario de la empresa -- ver 0109).
    serie_talonario: z
      .string()
      .trim()
      .min(1, "La serie del talonario es obligatoria")
      .max(20)
      .optional(),
    n_vale: z.number().int().positive().optional(),

    // El comprobante del proveedor (0109) -- el reemplazo del talonario en
    // la compra externa de combustible. Lo que vuelve de la ruta es una
    // boleta o una factura de PRIMAX/PETROPLUS, no un vale de la empresa.
    //
    // El número es texto libre y no `number`: viene impreso con serie y
    // ceros a la izquierda ("F001-00012345") y recortarlo a un entero
    // perdería justo lo que lo hace único y rastreable contra la factura.
    comprobante_tipo: z.enum(TIPOS_COMPROBANTE_COMPRA).optional(),
    comprobante_numero: z
      .string()
      .trim()
      .min(1, "El número del comprobante es obligatorio")
      .max(40)
      .optional(),

    // Litros, siempre -- para combustible lo tipea el cargador; para urea
    // el SERVIDOR lo calcula (cantidad_bultos × factor de la presentación)
    // y por eso acá queda opcional: mandarlo para un vale de urea es un
    // error de forma, no un dato a confiar.
    cantidad: z.number().positive().optional(),

    // Solo tanque_propio -- chequeo intra-vale del punto 5.
    lectura_contometro: z.number().nonnegative().optional(),

    // Solo tanque_propio, y solo si el tanque usa totalizador (lo valida el
    // servicio, que ve la fila del tanque): la lectura del contador
    // ACUMULATIVO del surtidor después de despachar. Ver migración 0094.
    totalizador_lectura: z.number().nonnegative().optional(),

    // Solo tanque_propio (0098): de qué surtidor salió. Opcional: con un solo
    // surtidor en el tanque lo asigna la base.
    surtidor_id: z.number().int().positive().optional(),

    // Solo compra_externa -- exactamente uno de los dos, según
    // equipos.tipo_medidor (hallazgo 9). horas_abastecidas siempre junto.
    lectura_horometro: z.number().nonnegative().optional(),
    lectura_odometro: z.number().nonnegative().optional(),
    horas_abastecidas: z.number().nonnegative().optional(),

    // Solo producto='urea' -- cómo se dispensó y cuántas unidades. El
    // factor de conversión NO viaja acá (ver FACTOR_LITROS_UREA): lo
    // resuelve el servidor a partir de `presentacion`, nunca el cliente.
    presentacion: codigoPresentacionUrea.optional(),
    cantidad_bultos: z.number().int().positive().optional(),

    // Solo la compra de urea en ruta (0120): una boleta puede traer varias
    // presentaciones -- "2 cajas + 3 bolsas". Cada renglón con su precio por
    // bulto tal como figura en el papel. Hasta 10: una boleta de grifo no
    // tiene más, y el techo corta un body inflado antes de tocar la base.
    // La forma de UNA presentación (presentacion + cantidad_bultos +
    // costo_unitario sueltos) se sigue aceptando y el .transform() la
    // convierte en un renglón.
    lineas: z
      .array(
        z.object({
          presentacion: codigoPresentacionUrea,
          cantidad_bultos: z.number().int().positive(),
          costo_unitario: z.number().positive(),
        })
      )
      .min(1, "la compra necesita al menos un renglón")
      .max(10, "una compra no puede tener más de 10 renglones")
      .optional(),

    // Cuándo se hizo el despacho en cancha -- opcional, mismo criterio que
    // `leido_en` de una lectura: sin dato, el service usa now().
    //
    // NO puede estar en el FUTURO (0077). Un vale fechado adelante queda
    // fuera del intervalo que se está balanceando ahora y entra en uno que
    // todavía no ocurrió: sirve para dejar preparada una explicación de un
    // faltante que aún no pasó. La auditoría adversaria lo aceptó con un mes
    // de adelanto sin ninguna queja.
    //
    // El margen de 1 hora no es capricho: los dispositivos de cancha vienen
    // con el reloj corrido, y rechazar un vale legítimo por dos minutos de
    // desfase dejaría a alguien sin poder registrar lo que sí hizo.
    despachado_en: z
      .string()
      .datetime()
      .refine((valor) => new Date(valor).getTime() <= Date.now() + 60 * 60 * 1000, {
        message: "La fecha del despacho no puede estar en el futuro",
      })
      .optional(),

    // Costos (migrations/0063). Obligatorio para COMBUSTIBLE -- Kenif lo
    // confirmó contra su planilla real, donde C.U está lleno en cada fila,
    // para los dos orígenes. El AUTOCOMPLETADO (buscar el precio vigente a
    // despachado_en) es responsabilidad del frontend -- este schema no
    // sabe nada de `combustible_precios`, solo exige el número.
    //
    // Para UREA es OPCIONAL: un vale de urea es un movimiento interno
    // (de almacén a una unidad), no una compra -- el costo de venta no
    // existe como tal. Si se manda, se guarda tal cual; si no, el service
    // lo estima promediando las recepciones de urea vigentes a la fecha
    // (ver resolverCostoUrea) solo para que el kardex quede valorizado,
    // nunca como un precio que alguien "cobra".
    costo_unitario: z.number().positive().optional(),
    observaciones: z.string().trim().max(500).optional(),
  })
  .superRefine((data, ctx) => {
    // ── UREA: rama separada, ver el comentario de arriba del schema ──────
    if (data.producto === "urea") {
      // Dos orígenes (0119). 'compra_externa' con vale y SIN comprobante es
      // la forma vieja del reparto del almacén -- la puede traer la cola
      // offline de un dispositivo que se quedó sin red antes del deploy. Se
      // acepta y el .transform() de abajo la normaliza a 'almacen'.
      const esCompraEnRuta =
        data.origen === "compra_externa" &&
        (data.comprobante_tipo !== undefined || data.comprobante_numero !== undefined);
      if (data.origen !== "almacen" && data.origen !== "compra_externa") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["origen"],
          message:
            "la urea sale del almacén ('almacen') o se compra en ruta ('compra_externa') -- no hay tanque de urea",
        });
      }
      if (data.tipo_destino !== "equipo" || data.equipo_id === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tipo_destino"],
          message: "un vale de urea siempre va a un equipo -- tipo_destino='equipo' y equipo_id",
        });
      }
      if (data.grifo_id === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["grifo_id"],
          message: "grifo_id (el proveedor de urea) es obligatorio",
        });
      }
      // Con renglones (0120), la presentación va en cada renglón y no suelta.
      // Las dos formas a la vez serían dos respuestas a la misma pregunta.
      if (data.lineas !== undefined) {
        if (
          data.presentacion !== undefined ||
          data.cantidad_bultos !== undefined ||
          data.costo_unitario !== undefined
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["lineas"],
            message:
              "con renglones, la presentación, la cantidad y el precio van en cada renglón, no sueltos",
          });
        }
        const codigos = data.lineas.map((l) => l.presentacion);
        if (new Set(codigos).size !== codigos.length) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["lineas"],
            message: "la misma presentación aparece en dos renglones -- sumalos en uno",
          });
        }
      } else {
        if (data.presentacion === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["presentacion"],
            message: "presentacion es obligatoria para un vale de urea (bolsa, caja o balde)",
          });
        }
        if (data.cantidad_bultos === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["cantidad_bultos"],
            message: "cantidad_bultos es obligatoria para un vale de urea",
          });
        }
      }
      // Campos exclusivos de combustible -- ninguno aplica acá. Que el
      // servidor los rechace y no simplemente los ignore importa: un
      // frontend con un bug que arrastre un valor viejo del formulario de
      // diésel a uno de urea se entera en el 400, no en un dato fantasma
      // guardado en la fila.
      const camposDeCombustible: [string, unknown][] = [
        ["tipo_combustible", data.tipo_combustible],
        ["combustible_id", data.combustible_id],
        ["cantidad", data.cantidad],
        ["lectura_contometro", data.lectura_contometro],
        ["totalizador_lectura", data.totalizador_lectura],
        ["surtidor_id", data.surtidor_id],
        ["lectura_horometro", data.lectura_horometro],
        ["lectura_odometro", data.lectura_odometro],
        ["horas_abastecidas", data.horas_abastecidas],
      ];
      for (const [campo, valor] of camposDeCombustible) {
        if (valor !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [campo],
            message: `${campo} no aplica a un vale de urea`,
          });
        }
      }

      if (esCompraEnRuta) {
        // Compra en ruta (0119): el papel es la boleta o factura del
        // proveedor, nunca un vale de la empresa -- mismo criterio que la
        // compra externa de combustible (0109). Y el costo es OBLIGATORIO:
        // es lo que dice el comprobante, no un promedio que el servidor
        // pueda estimar como en el reparto del almacén.
        if (data.comprobante_tipo === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["comprobante_tipo"],
            message: "comprobante_tipo es obligatorio (boleta o factura)",
          });
        }
        if (data.comprobante_numero === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["comprobante_numero"],
            message: "el número de la boleta o factura es obligatorio",
          });
        }
        if (data.serie_talonario !== undefined || data.n_vale !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["serie_talonario"],
            message:
              "una compra en ruta se identifica con el comprobante del proveedor, no con un vale de la empresa",
          });
        }
        if (data.lineas === undefined && data.costo_unitario === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["costo_unitario"],
            message: "el costo por bulto de la boleta es obligatorio en una compra en ruta",
          });
        }
        return;
      }

      // Los renglones son de la compra en ruta: el reparto del almacén sale
      // con una presentación por vale (0120, decisión de Kenif).
      if (data.lineas !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lineas"],
          message:
            "los renglones son de la compra en ruta; el vale del almacén lleva una presentación",
        });
      }

      // Reparto del almacén: el talonario propio (0092), sin comprobante.
      for (const [campo, valor] of [
        ["comprobante_tipo", data.comprobante_tipo],
        ["comprobante_numero", data.comprobante_numero],
      ] as const) {
        if (valor !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [campo],
            message: `${campo} no aplica al reparto del almacén -- es de la compra en ruta`,
          });
        }
      }
      exigirVale(data, ctx, "un vale de urea");
      return;
    }

    // ── COMBUSTIBLE: la validación de siempre, sin cambios ───────────────
    if (data.origen === "almacen") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["origen"],
        message: "'almacen' es el reparto de urea; el combustible sale de 'tanque_propio'",
      });
      return;
    }
    if (data.lineas !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lineas"],
        message: "lineas es de la compra de urea en ruta",
      });
      return;
    }
    if (data.tipo_combustible === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tipo_combustible"],
        message: "tipo_combustible es obligatorio para un vale de combustible",
      });
    }
    if (data.cantidad === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cantidad"],
        message: "cantidad es obligatoria para un vale de combustible",
      });
    }
    // La carga desde tanqueta (0114) no lo lleva: lo calcula el servidor con
    // el costo de lo que entró a la tanqueta, y el conductor no lo conoce.
    if (data.costo_unitario === undefined && data.origen !== "tanqueta") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["costo_unitario"],
        message: "costo_unitario es obligatorio para un vale de combustible",
      });
    }
    if (data.presentacion !== undefined || data.cantidad_bultos !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["presentacion"],
        message: "presentacion/cantidad_bultos solo aplican a un vale de urea",
      });
    }
    if (data.tipo_destino === "equipo" && data.equipo_id === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["equipo_id"],
        message: "equipo_id es obligatorio cuando tipo_destino es 'equipo'",
      });
    }
    if (data.tipo_destino !== "equipo" && data.equipo_id !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["equipo_id"],
        message: "equipo_id solo aplica cuando tipo_destino es 'equipo'",
      });
    }

    if (
      data.tanqueta_destino_id !== undefined &&
      (data.origen !== "tanque_propio" || data.tipo_destino !== "reserva_cubeta")
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tanqueta_destino_id"],
        message: "tanqueta_destino_id solo aplica a un vale del tanque a 'reserva_cubeta'",
      });
    }
    if (data.origen !== "tanqueta" && data.tanqueta_lugar !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tanqueta_lugar"],
        message: "tanqueta_lugar solo aplica a una carga desde tanqueta",
      });
    }
    if (data.origen !== "tanqueta" && data.tanqueta_origen_id !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tanqueta_origen_id"],
        message: "tanqueta_origen_id solo aplica a una carga desde tanqueta",
      });
    }

    // ── CARGA DESDE TANQUETA (0114/0115) ───────────────────────────────
    // En RUTA la registra el conductor: unidad, medidor y galones, sin vale
    // (la tanqueta salió con el suyo). En PLANTA es como un vale del tanque:
    // con vale del talonario, y el medidor según la config (0113).
    if (data.origen === "tanqueta") {
      const enPlanta = data.tanqueta_lugar === "planta";
      if (data.tanqueta_origen_id === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tanqueta_origen_id"],
          message: "tanqueta_origen_id es obligatorio: de qué tanqueta se cargó",
        });
      }
      if (data.tipo_destino !== "equipo") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tipo_destino"],
          message: "la carga desde tanqueta siempre va a una unidad",
        });
      }
      if (enPlanta) {
        exigirVale(data, ctx, "una carga desde tanqueta en planta");
        if (data.lectura_horometro !== undefined && data.lectura_odometro !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["lectura_horometro"],
            message: "Mandá el horómetro o el odómetro, nunca los dos en el mismo vale",
          });
        }
      } else if ((data.lectura_horometro === undefined) === (data.lectura_odometro === undefined)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lectura_horometro"],
          message:
            "la carga en ruta desde tanqueta exige el horómetro o el odómetro de la unidad: con él se calcula su consumo",
        });
      }
      for (const [campo, valor] of [
        ["combustible_id", data.combustible_id],
        ["grifo_id", data.grifo_id],
        ["lectura_contometro", data.lectura_contometro],
        ["totalizador_lectura", data.totalizador_lectura],
        ["surtidor_id", data.surtidor_id],
        ["horas_abastecidas", data.horas_abastecidas],
        // En ruta no hay vale; en planta sí (lo exige exigirVale de arriba).
        ...(enPlanta
          ? []
          : ([
              ["serie_talonario", data.serie_talonario],
              ["n_vale", data.n_vale],
            ] as [string, unknown][])),
        ["comprobante_tipo", data.comprobante_tipo],
        ["comprobante_numero", data.comprobante_numero],
        ["excedente_linea_id", data.excedente_linea_id],
      ] as [string, unknown][]) {
        if (valor !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [campo],
            message: `${campo} no aplica a una carga desde tanqueta${enPlanta ? " en planta" : " en ruta"}`,
          });
        }
      }
      return;
    }

    if (data.origen !== "excedente_recepcion" && data.excedente_linea_id !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["excedente_linea_id"],
        message: "excedente_linea_id solo aplica a un despacho de excedente de recepción",
      });
    }

    // ── EXCEDENTE DE CISTERNA (0112) ───────────────────────────────────
    // Combustible que la cisterna cargó directo a una unidad porque no cabía
    // en el tanque. Lleva vale (misma secuencia que el tanque) y el medidor de
    // la unidad, pero no sale de ningún tanque ni surtidor.
    if (data.origen === "excedente_recepcion") {
      exigirVale(data, ctx, "un despacho de excedente");
      if (data.excedente_linea_id === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["excedente_linea_id"],
          message: "excedente_linea_id es obligatorio: qué excedente pendiente se despacha",
        });
      }
      if (data.tipo_destino !== "equipo") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tipo_destino"],
          message: "el excedente directo a unidades siempre va a un equipo",
        });
      }
      if (data.lectura_horometro !== undefined && data.lectura_odometro !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lectura_horometro"],
          message: "Mandá el horómetro o el odómetro, nunca los dos en el mismo vale",
        });
      }
      for (const [campo, valor] of [
        ["combustible_id", data.combustible_id],
        ["grifo_id", data.grifo_id],
        ["lectura_contometro", data.lectura_contometro],
        ["totalizador_lectura", data.totalizador_lectura],
        ["surtidor_id", data.surtidor_id],
        ["horas_abastecidas", data.horas_abastecidas],
        ["comprobante_tipo", data.comprobante_tipo],
        ["comprobante_numero", data.comprobante_numero],
      ] as [string, unknown][]) {
        if (valor !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [campo],
            message: `${campo} no aplica a un despacho de excedente: no sale de un tanque ni de un grifo de ruta`,
          });
        }
      }
      return;
    }

    if (data.origen === "tanque_propio") {
      // El talonario es EL control del tanque propio (punto 1): su hueco es
      // el único mecanismo real contra la fuga. Acá no es negociable.
      exigirVale(data, ctx, "un vale de tanque propio");
      for (const [campo, valor] of [
        ["comprobante_tipo", data.comprobante_tipo],
        ["comprobante_numero", data.comprobante_numero],
      ] as [string, unknown][]) {
        if (valor !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [campo],
            message: `${campo} no aplica a 'tanque_propio': el comprobante es del proveedor de ruta`,
          });
        }
      }
      if (data.combustible_id === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["combustible_id"],
          message: "combustible_id es obligatorio cuando origen es 'tanque_propio'",
        });
      }
      if (data.lectura_contometro === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lectura_contometro"],
          message: "lectura_contometro es obligatoria cuando origen es 'tanque_propio'",
        });
      }
      if (data.grifo_id !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["grifo_id"],
          message: "grifo_id no aplica a 'tanque_propio'",
        });
      }
      if (data.horas_abastecidas !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["origen"],
          message: "horas_abastecidas no aplica a 'tanque_propio'",
        });
      }

      // EL HORÓMETRO SÍ APLICA AL VALE DEL TANQUE PROPIO desde la 5ª
      // auditoría (migración 0088). Antes estaba prohibido, y eso dejaba al
      // canal principal de salida sin ningún control de consumo: el robo que
      // sale CON vale --se declaran 400 L y el volquete recibe 380-- no lo
      // puede ver el tanque, porque el tanque cuadra.
      //
      // Es OPCIONAL en la API y obligatorio en el formulario. Si fuera
      // requerido acá, un vale de la cola offline de una app vieja daría 400
      // para siempre y ese despacho se perdería -- y un despacho sin
      // registrar es peor que uno marcado (la regla del módulo). Cuando falta,
      // el service deja la alerta `medidor_inconsistente` con motivo
      // "sin_lectura": no se pierde el vale, pero tampoco pasa en silencio.
      if (data.lectura_horometro !== undefined && data.lectura_odometro !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lectura_horometro"],
          message: "Mandá el horómetro o el odómetro, nunca los dos en el mismo vale",
        });
      }
      if (
        data.tipo_destino !== "equipo" &&
        (data.lectura_horometro !== undefined || data.lectura_odometro !== undefined)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tipo_destino"],
          message:
            "el horómetro/odómetro es una lectura del equipo: no aplica a planta ni a reserva",
        });
      }
    } else {
      // compra_externa
      // El horómetro/odómetro es una lectura del EQUIPO (hallazgo 9) --
      // sin equipo_id (destino planta/reserva_cubeta) esa lectura no
      // correspondería a ningún medidor real. No estaba en el prompt
      // cerrado palabra por palabra, pero se deduce directo de esa misma
      // decisión: no tiene sentido pedir horómetro/odómetro sin equipo.
      if (data.tipo_destino !== "equipo") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tipo_destino"],
          message:
            "'compra_externa' exige tipo_destino='equipo' -- el horómetro/odómetro es una lectura del equipo, no tiene sentido sin uno",
        });
      }
      if (data.combustible_id !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["combustible_id"],
          message: "combustible_id no aplica a 'compra_externa'",
        });
      }
      if (data.grifo_id === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["grifo_id"],
          message: "grifo_id es obligatorio cuando origen es 'compra_externa'",
        });
      }
      if (data.lectura_contometro !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lectura_contometro"],
          message: "lectura_contometro no aplica a 'compra_externa' (el grifo ajeno no la incluye)",
        });
      }
      if (data.totalizador_lectura !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["totalizador_lectura"],
          message: "totalizador_lectura no aplica a 'compra_externa' (no hay surtidor propio)",
        });
      }
      if (data.surtidor_id !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["surtidor_id"],
          message: "surtidor_id no aplica a 'compra_externa' (no hay surtidor propio)",
        });
      }
      if (data.horas_abastecidas === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["horas_abastecidas"],
          message: "horas_abastecidas es obligatoria cuando origen es 'compra_externa'",
        });
      }
      const tieneHorometro = data.lectura_horometro !== undefined;
      const tieneOdometro = data.lectura_odometro !== undefined;
      if (tieneHorometro === tieneOdometro) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lectura_horometro"],
          message:
            "'compra_externa' exige exactamente uno de lectura_horometro/lectura_odometro, nunca los dos ni ninguno",
        });
      }

      // ── Comprobante vs. talonario (0109) ────────────────────────────
      // Espejo EXACTO del CHECK de la migración: exactamente una de las dos
      // formas de identificar la compra. Que la API y la base impongan la
      // misma regla no es redundancia -- es que no haya una forma de fila
      // que una acepte y la otra no, que es donde nacen los 500 genéricos.
      //
      // La forma VIEJA (vale, sin comprobante) se sigue aceptando a
      // propósito, y es el único motivo por el que esto no es un simple
      // "comprobante obligatorio": en la cola offline puede haber un
      // despacho armado por la app ANTERIOR, que mandaba vale. Rechazarlo
      // sería un 400, y `esErrorPermanente` de offlineSync descarta todo
      // 4xx: ese despacho se perdería en silencio. Un despacho sin
      // registrar es peor que uno marcado -- la regla del módulo, la misma
      // que dejó `lectura_horometro` opcional en 0088.
      //
      // El frontend nuevo NUNCA produce la forma vieja. Es un camino de
      // entrada que solo la cola puede recorrer, y muere solo cuando se
      // drena.
      const tieneComprobante =
        data.comprobante_tipo !== undefined || data.comprobante_numero !== undefined;
      const tieneVale = data.serie_talonario !== undefined || data.n_vale !== undefined;

      if (tieneComprobante && tieneVale) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["comprobante_numero"],
          message:
            "una compra externa se identifica con el comprobante del proveedor O con un vale (formato anterior), nunca con los dos",
        });
      } else if (tieneComprobante) {
        if (data.comprobante_tipo === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["comprobante_tipo"],
            message: "comprobante_tipo es obligatorio (boleta o factura)",
          });
        }
        if (data.comprobante_numero === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["comprobante_numero"],
            message: "comprobante_numero es obligatorio",
          });
        }
      } else if (tieneVale) {
        exigirVale(data, ctx, "una compra externa en formato anterior");
      } else {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["comprobante_numero"],
          message:
            "una compra externa necesita el comprobante del proveedor (boleta o factura): es lo que la identifica y lo que impide cargarla dos veces",
        });
      }
    }
  })
  // La forma vieja del reparto del almacén de urea ('compra_externa' + vale,
  // anterior a 0119) se normaliza ACÁ, una sola vez, para que el resto del
  // código nunca la vea: el servicio, las alertas y la fila guardada dicen
  // 'almacen'. Si cada lugar tuviera que reconocer las dos formas, el primero
  // que se olvide haría bajar el stock por una compra en ruta o al revés.
  .transform((data) => {
    if (data.producto !== "urea") return data;
    if (
      data.origen === "compra_externa" &&
      data.comprobante_tipo === undefined &&
      data.comprobante_numero === undefined
    ) {
      return { ...data, origen: "almacen" as const };
    }
    // La compra en ruta SIEMPRE llega al servicio con renglones (0120): la
    // forma de una sola presentación es un renglón. Un solo camino de código
    // para "de qué está hecha esta compra".
    if (data.origen === "compra_externa" && data.lineas === undefined) {
      return {
        ...data,
        lineas: [
          {
            presentacion: data.presentacion!,
            cantidad_bultos: data.cantidad_bultos!,
            costo_unitario: data.costo_unitario!,
          },
        ],
        presentacion: undefined,
        cantidad_bultos: undefined,
        costo_unitario: undefined,
      };
    }
    return data;
  });

export type CrearDespachoCombustibleInput = z.infer<typeof crearDespachoCombustibleSchema>;

/** Anular un vale (punto 3 del documento: se mojó con diésel, se tipeó mal).
 *  `motivo` obligatorio, mismo criterio que lecturas, precios y recepciones:
 *  es lo único que distingue "el papel quedó ilegible" de "estoy borrando un
 *  vale que no me conviene".
 *
 *  Anular libera el número dentro de su serie (migración 0067): el mismo vale
 *  físico se puede volver a cargar con el dato corregido. Sin eso, anular un
 *  vale mal tipeado borraría del sistema un despacho que sí ocurrió. */
export const anularDespachoCombustibleSchema = z.object({
  motivo: z.string().trim().min(1, "El motivo de la anulación es obligatorio").max(500),
});

export type AnularDespachoCombustibleInput = z.infer<typeof anularDespachoCombustibleSchema>;

/** Adjuntar la foto/PDF del comprobante de una compra en ruta (0109).
 *
 *  El archivo viaja en el multipart (campo "archivo", ver
 *  combustible.upload.ts); acá solo va el motivo, y SOLO hace falta cuando
 *  se está REEMPLAZANDO una foto ya adjunta. Por eso es opcional en el
 *  schema y obligatorio en el service, que es el único que sabe si la
 *  compra ya tenía archivo.
 *
 *  Pedirlo en el adjunto inicial sería ruido --no hay nada que corregir--
 *  y no pedirlo en el reemplazo rompería el principio del módulo: cambiar
 *  la evidencia de una compra es una acción correctiva, y toda acción
 *  correctiva dice por qué.
 *
 *  Viene de un FormData, así que todo llega como string: por eso no hay
 *  ningún campo numérico ni booleano acá. */
export const subirComprobanteCompraSchema = z.object({
  motivo: z.string().trim().min(1).max(500).optional(),
});

export type SubirComprobanteCompraInput = z.infer<typeof subirComprobanteCompraSchema>;

// ── Alertas (migrations/0068) ───────────────────────────────────────────
// Sin ids, marca TODAS las no leídas del tenant como leídas -- lo que
// dispara el botón "marcar todas como leídas" de la campanita.
export const marcarAlertasLeidasCombustibleSchema = z.object({
  ids: z.array(z.coerce.number().int().positive()).optional(),
});

export type MarcarAlertasLeidasCombustibleInput = z.infer<
  typeof marcarAlertasLeidasCombustibleSchema
>;

// ── Conciliación (migrations/0071) ──────────────────────────────────────
/** Cuánto tiempo tiene un hueco de talonario para explicarse solo antes de
 *  congelarse como anomalía permanente. Los límites son espejo del CHECK de
 *  la migración: menos de 1h congelaría vales que todavía están
 *  sincronizando; más de un año es no conciliar nunca. */
/** Revisar una alerta a mano. El motivo es OBLIGATORIO por el mismo criterio
 *  que en `anularLecturaCombustibleSchema`: cerrar una alerta anti-fraude sin
 *  decir por qué es indistinguible de taparla, y "todo tiene que tener
 *  sustento". Antes de 0077 esta acción no pedía nada. */
/** Dar de baja un tanque es un AFLOJAMIENTO, no una edición cualquiera: lo
 *  saca de la alerta de "sin medir" y deja de vigilarse su balance. Pedía
 *  menos que subir un umbral, que es exactamente al revés de lo que
 *  corresponde -- lo mostró la simulación de robo (0078). */
export const bajaTanqueCombustibleSchema = z.object({
  motivo: z.string().trim().min(1, "El motivo de la baja es obligatorio").max(500),
});

export type BajaTanqueCombustibleInput = z.infer<typeof bajaTanqueCombustibleSchema>;

export const resolverAlertaCombustibleSchema = z.object({
  motivo: z.string().trim().min(1, "El motivo de la revisión es obligatorio").max(500),
});

export type ResolverAlertaCombustibleInput = z.infer<typeof resolverAlertaCombustibleSchema>;

export const configCombustibleSchema = z
  .object({
    ventana_gracia_horas: z.number().int().min(1).max(8760),
    // Cada cuántos días se exige tomar varilla (migración 0076). Sin lecturas
    // no hay descuadre que calcular ni diferencia de recepción que comparar:
    // dejar de medir apaga las dos detecciones de una, y eso es exactamente
    // lo que esta alerta vigila.
    dias_sin_medir: z.number().int().min(1).max(365),
    // Cuántos días mira para atrás el acumulado de 0080. BAJARLO afloja: con 7
    // días en vez de 30 el que roba de a poco nunca junta lo suficiente.
    dias_ventana_descuadre: z.number().int().min(7).max(365),
    // Días tolerados entre la fecha del vale y su carga (0081). A diferencia de
    // los umbrales, acá SÍ hay default: el límite lo pone la tecnología (cuánto
    // tarda una cola offline en sincronizar), no la operación.
    dias_carga_retroactiva: z.number().int().min(1).max(90),
    // Días que un tanque puede despachar con los tres umbrales apagados antes
    // de que el sistema insista (0082). Default 7.
    dias_sin_vigilancia: z.number().int().min(1).max(90),
    // Los dos topes diarios de la migración 0079. Nullable con la misma
    // semántica que los umbrales del tanque desde 0075: null = sin configurar
    // = no alerta. No se les pone default -- un techo inventado o alerta por
    // trabajo normal (y entonces se ignora) o queda tan alto que no atrapa
    // nada. El mínimo de 0.1 en los llenados es a propósito: 0 acá no
    // significa "estricto", significa "nadie puede recibir nada".
    llenados_por_dia_max: z.number().min(0.1).max(50).nullable(),
    tope_diario_sin_capacidad_l: z.number().positive().max(9_999_999).nullable(),
    // Si el rol `grifero` (0085) puede tomar varilla. Decisión de Kenif: en la
    // operación real de este cliente la toma el mismo que despacha, así que la
    // separación entre quien mide y quien despacha es una POLÍTICA que cada
    // empresa elige, no una regla que el sistema imponga.
    //
    // .default(true) y no requerido: es el ÚNICO campo opcional de este schema,
    // a propósito. Agregarlo como requerido rompía todo llamador existente del
    // PUT --incluida la pantalla vieja que siga abierta en un navegador-- y el
    // default coincide con el comportamiento que ya había. El riesgo conocido
    // es el inverso: un cliente viejo que mande la config SIN este campo se lo
    // vuelve a poner en true sin que nadie lo pida. Por eso pasar de false a
    // true cuenta como aflojamiento y queda auditado (ver
    // evaluarAflojamientoConfig).
    grifero_registra_varilla: z.boolean().default(true),
    // ── 5ª auditoría (migración 0088) ──────────────────────────────────────
    //
    // Los tres con default DEL LADO ESTRICTO, y eso es lo que los hace seguros
    // como opcionales: este PUT reemplaza la fila entera, así que un llamador
    // viejo que no los mande solo puede ENDURECER la vigilancia, nunca aflojarla
    // en silencio. Es la vuelta al problema que dejó `grifero_registra_varilla`.
    //
    // Si la recepción tiene que validarla alguien distinto del que la registró,
    // contra la guía del proveedor. Es el control que cierra la recepción
    // sub-declarada: registrar 9.000 de una entrega de 10.000 y llevarse la
    // diferencia no disparaba NADA, porque el mismo que recibía escribía el
    // único número que existía.
    recepcion_requiere_validacion: z.boolean().default(true),
    horas_para_validar_recepcion: z.number().int().min(1).max(720).default(48),
    // Días tolerados sin una varilla tomada por alguien que NO despacha. null =
    // la empresa no tiene a nadie más (queda auditado como aflojamiento).
    dias_sin_varilla_de_control: z.number().int().min(1).max(90).nullable().default(7),
    // Si el vale del tanque propio (y el del excedente de cisterna) pide el
    // horómetro/odómetro de la unidad (0113). Default false por decisión de
    // Kenif: el medidor se toma en las cargas en ruta y el consumo se calcula
    // entre esas lecturas. Prenderlo endurece; apagarlo después es un
    // aflojamiento auditado (un PUT viejo sin el campo choca con eso y pide
    // motivo, no apaga en silencio).
    despacho_pide_medidor: z.boolean().default(false),
    // ── Urea (migración 0092) ─────────────────────────────────────────────
    // Los dos umbrales arrancan en NULL -- mismo criterio que el resto del
    // módulo desde 0075/0079: el cliente todavía no dio un número operativo
    // real (respondió "un aproximado de 4 bolsas" y "según la distancia
    // recorrida", ninguno es un techo), así que no se inventa uno.
    tope_diario_urea_l: z.number().positive().max(9_999_999).nullable().default(null),
    ratio_urea_diesel_max_pct: z.number().min(0).max(100).nullable().default(null),
    // Este SÍ lleva default (30): a diferencia de la varilla del tanque, que
    // ya era la práctica antes del sistema, el conteo físico de urea es un
    // control que el sistema introduce -- dejarlo en NULL lo apagaría desde
    // el día uno sin que nadie lo decidiera.
    dias_sin_conteo_urea: z.number().int().min(1).max(365).default(30),
    // ── Stock de urea (migración 0117) ────────────────────────────────────
    //
    // Los dos GLOBALES por empresa, no por equipo: el depósito de urea es uno
    // (el tope diario por unidad ya cubre la otra mitad del problema). NULL =
    // sin configurar = no alerta, como el resto.
    //
    // `stock_minimo_urea_l` avisa que hay que reabastecer; BAJARLO afloja (el
    // aviso llega más tarde, o nunca). `stock_maximo_urea_l` es un techo de
    // ALMACÉN, no de compra: al registrar una entrada se compara contra
    // `stock + lo que entra`, así que también atrapa comprar de a poco hasta
    // llenar el depósito. SUBIRLO afloja. Las dos direcciones opuestas están
    // en evaluarAflojamientoConfig, cada una por separado.
    //
    // El orden (mínimo < máximo) lo valida el .refine() de abajo además del
    // CHECK de la base: un mínimo por encima del máximo dispararía las dos
    // alertas en cada movimiento.
    stock_minimo_urea_l: z.number().positive().max(9_999_999).nullable().default(null),
    stock_maximo_urea_l: z.number().positive().max(9_999_999).nullable().default(null),
    // Tolerancia de precio de la compra de urea en ruta contra el catálogo
    // (0121). .default(10) y no null: es el valor que Kenif aprobó, y el
    // default va DEL LADO ESTRICTO (5ª auditoría) -- un llamador viejo que no
    // mande el campo vuelve a 10, nunca apaga el control en silencio. Subirla
    // o ponerla en null afloja y pide motivo.
    tolerancia_precio_urea_pct: z.number().positive().max(100).nullable().default(10),
    /** Obligatorio SOLO si el cambio AFLOJA algún control, igual que en la
     *  ficha del tanque. Hasta la 5ª auditoría la config era la excepción:
     *  apagar un tope o alargar la ventana de gracia se guardaba sin explicar
     *  nada, aunque el tanque sí lo exigiera. Mismo acto, mismo trato. */
    motivo_ajuste: z.string().trim().min(1).max(500).optional(),
  })
  // 0117: el único caso de esta config que se RECHAZA en vez de alertar. No
  // es una política de la empresa, es un dato que se contradice a sí mismo:
  // con el mínimo por encima del máximo el stock estaría en falta Y excedido
  // al mismo tiempo, y las dos alertas saldrían juntas en cada movimiento.
  // Mismo criterio que bloquear un cambio de unidad con historial.
  .refine(
    (v) =>
      v.stock_minimo_urea_l === null ||
      v.stock_maximo_urea_l === null ||
      v.stock_minimo_urea_l < v.stock_maximo_urea_l,
    {
      message:
        "El stock mínimo de urea tiene que ser menor que el máximo -- con el mínimo más alto, el depósito estaría en falta y excedido a la vez",
      path: ["stock_minimo_urea_l"],
    }
  );

// ── Kardex del tanque ───────────────────────────────────────────────────
// Las dos fechas son OBLIGATORIAS: un kardex sin período no es un reporte,
// es un volcado de la tabla. Y el saldo corriente solo significa algo si
// alguien eligió desde dónde se cuenta.

const MAX_DIAS_KARDEX = 400;

export const kardexCombustibleSchema = z
  .object({
    desde: z.string().datetime({ offset: true }),
    hasta: z.string().datetime({ offset: true }),
  })
  .refine((v) => Date.parse(v.desde) <= Date.parse(v.hasta), {
    message: "La fecha de inicio tiene que ser anterior a la de fin",
    path: ["desde"],
  })
  .refine((v) => Date.parse(v.hasta) - Date.parse(v.desde) <= MAX_DIAS_KARDEX * 24 * 3600 * 1000, {
    // El kardex NO se pagina a propósito (el saldo corriente pierde
    // sentido en pedazos), así que el techo del período es lo único que
    // impide que un tanque con años de historial devuelva una respuesta
    // enorme. 400 días entran cómodos en un ejercicio contable de 12
    // meses más el margen de cierre.
    message: `El período no puede superar los ${MAX_DIAS_KARDEX} días`,
    path: ["hasta"],
  });

export type KardexCombustibleQuery = z.infer<typeof kardexCombustibleSchema>;

// ── Período de los historiales (lecturas, despachos, recepciones) ────────
// Acá las dos fechas son OPCIONALES, al revés que en el kardex, y no es una
// inconsistencia: el kardex arma un saldo corriente, que sin período no
// significa nada. Estos tres son listados paginados, y "sin filtro" --
// últimos N registros, del más reciente al más antiguo -- es exactamente lo
// que hacían hasta ahora y sigue siendo una consulta sana.
//
// Que sean opcionales es lo que hace que agregar el filtro no rompa a
// ningún llamador que ya exista, incluida una pantalla vieja abierta en un
// navegador que nunca mandó estas fechas.
//
// Tampoco llevan el techo de días del kardex: el que acota el tamaño de la
// respuesta acá es `pageSize`, que ya existe y se aplica siempre.
export const periodoHistorialCombustibleSchema = z
  .object({
    desde: z.string().datetime({ offset: true }).optional(),
    hasta: z.string().datetime({ offset: true }).optional(),
  })
  .refine((v) => !v.desde || !v.hasta || Date.parse(v.desde) <= Date.parse(v.hasta), {
    message: "La fecha de inicio tiene que ser anterior a la de fin",
    path: ["desde"],
  });

export type PeriodoHistorialCombustibleQuery = z.infer<typeof periodoHistorialCombustibleSchema>;

// GET /equipos/:equipoId/ultimo-medidor -- la lectura de la carga anterior de
// una unidad, para que el formulario calcule las horas abastecidas. `antes_de`
// es la fecha del despacho que se está cargando: con una fecha retroactiva, la
// "carga anterior" es la que quedó ANTES de esa fecha, no la más reciente.
export const ultimoMedidorEquipoQuerySchema = z.object({
  antes_de: z.string().datetime({ offset: true }).optional(),
});

export type UltimoMedidorEquipoQuery = z.infer<typeof ultimoMedidorEquipoQuerySchema>;

export type ConfigCombustibleInput = z.infer<typeof configCombustibleSchema>;

// ── Grifos externos (migrations/0063) ───────────────────────────────────
// Catálogo chico (3-4 típicos: PRIMAX, VELASQUEZ) -- reemplaza el texto
// libre `grifo_externo` de 0062 para poder engancharle un precio de forma
// confiable. Solo admin los da de alta (ver combustible.routes.ts).

// Los dos roles (migrations/0065): el mismo catálogo sirve para el grifo de
// ruta (Fase B) y para el proveedor que llena el tanque propio (Fase C). Una
// empresa que hace las dos cosas se marca con los dos y sigue siendo UNA ficha.
//
// `.default(true)` acá, requeridos en el schema de actualización de abajo:
// mismo criterio que `moneda`/`activo` en los tanques -- el POST completa lo
// que falte, el PUT reemplaza la fila entera y no admite omisiones.
// Tercer rol (migrations/0092): el proveedor de urea que el cliente
// confirmó como "aparte" de los grifos de combustible (pregunta 9). Mismo
// catálogo, un flag más -- un proveedor que vende las tres cosas sigue
// siendo UNA ficha. Default false: a diferencia de abastece_ruta/
// abastece_tanque (que asumían "sí" porque ya existía el dato viejo de
// grifo_externo para migrar), acá no hay ningún grifo existente que deba
// heredar este rol -- que se marque a mano, uno por uno.
export const crearGrifoCombustibleSchema = z.object({
  nombre: z.string().trim().min(1, "El nombre del grifo es obligatorio").max(150),
  abastece_ruta: z.boolean().default(true),
  abastece_tanque: z.boolean().default(true),
  abastece_urea: z.boolean().default(false),
});

export type CrearGrifoCombustibleInput = z.infer<typeof crearGrifoCombustibleSchema>;

export const actualizarGrifoCombustibleSchema = z.object({
  nombre: z.string().trim().min(1, "El nombre del grifo es obligatorio").max(150),
  activo: z.boolean(),
  abastece_ruta: z.boolean(),
  abastece_tanque: z.boolean(),
  abastece_urea: z.boolean(),
});

export type ActualizarGrifoCombustibleInput = z.infer<typeof actualizarGrifoCombustibleSchema>;

// ── Precios de combustible (migrations/0063) ────────────────────────────
// Historial apilado -- nunca se pisa. Exactamente uno de combustible_id/
// grifo_id, mismo patrón que el destino polimórfico de un despacho.

export const crearPrecioCombustibleSchema = z
  .object({
    tipo_combustible: z.enum(TIPOS_COMBUSTIBLE),
    combustible_id: z.number().int().positive().optional(),
    grifo_id: z.number().int().positive().optional(),
    precio_unitario: z.number().positive(),
    // Opcional: sin dato, el service usa now() -- mismo criterio que
    // despachado_en/leido_en en el resto del módulo.
    vigente_desde: z.string().datetime().optional(),
  })
  .superRefine((data, ctx) => {
    const tieneCombustible = data.combustible_id !== undefined;
    const tieneGrifo = data.grifo_id !== undefined;
    if (tieneCombustible === tieneGrifo) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["combustible_id"],
        message: "Un precio va exactamente a un tanque o a un grifo, nunca los dos ni ninguno",
      });
    }
  });

export type CrearPrecioCombustibleInput = z.infer<typeof crearPrecioCombustibleSchema>;

/** Anular un precio mal cargado -- mismo criterio que
 *  anularLecturaCombustibleSchema: `motivo` obligatorio, la fila NUNCA se
 *  borra ni se edita. */
export const anularPrecioCombustibleSchema = z.object({
  motivo: z.string().trim().min(1, "El motivo de la anulación es obligatorio").max(500),
});

export type AnularPrecioCombustibleInput = z.infer<typeof anularPrecioCombustibleSchema>;

// ── Precios de urea (migración 0121) ─────────────────────────────────────
// Por proveedor y presentación: cada grifo cobra distinto. Se apila con su
// vigencia, igual que crearPrecioCombustibleSchema. El precio es POR BULTO,
// el número que trae la boleta ("S/ 50 la caja").
export const crearPrecioUreaSchema = z.object({
  grifo_id: z.number().int().positive(),
  presentacion: codigoPresentacionUrea,
  // Referencia libre ("Green 32", "AdBlue"): no hay reportes por marca.
  marca: z.string().trim().max(80).optional(),
  precio_por_bulto: z.number().positive().max(100_000),
  vigente_desde: z.string().datetime({ offset: true }).optional(),
});

export type CrearPrecioUreaInput = z.infer<typeof crearPrecioUreaSchema>;

// ── Recepciones (Fase C, ver migrations/0064) ───────────────────────────
// Cuánto ENTRA al tanque propio y a qué costo -- lo único que escribe
// `combustible.costo_promedio`. Una compra en grifo de ruta NO pasa por
// acá: eso ya es un despacho con origen='compra_externa' (Fase B).

const TIPOS_DOCUMENTO_RECEPCION = ["factura", "guia_remision"] as const;

export const crearRecepcionCombustibleSchema = z
  .object({
    // Mismo mecanismo que lecturas y despachos. Acá NO es por la cola
    // offline (una recepción se carga en planta, con red -- ver
    // registry.ts), sino por el doble clic: el modal lo genera al abrirse,
    // así dos envíos del mismo formulario no crean dos recepciones y, de
    // paso, no duplican el recálculo del costo promedio.
    cliente_uuid: z.string().uuid().optional(),

    // Migración 0092. Default 'combustible' -- mismo criterio que en
    // crearDespachoCombustibleSchema.
    producto: z.enum(PRODUCTOS_DESPACHO).default("combustible"),

    // combustible_id es obligatorio SOLO para producto='combustible' -- una
    // recepción de combustible sin tanque no existe (0064). Para urea NO
    // aplica: no hay tanque de urea que descontar (ver 0092).
    combustible_id: z.number().int().positive().optional(),
    // El grifo/proveedor SIEMPRE va por catálogo, para los dos productos --
    // alta previa obligatoria, nunca texto libre. Para urea es el
    // proveedor "aparte" que el cliente confirmó (pregunta 9), marcado con
    // `abastece_urea`.
    grifo_id: z.number().int().positive(),

    // Litros, para combustible. Para urea el servidor lo calcula (ver
    // presentacion/cantidad_bultos abajo), así que queda opcional acá.
    cantidad: z.number().positive().optional(),
    costo_unitario: z.number().positive(),

    // Solo producto='urea' -- mismo mecanismo que en el despacho: el
    // factor de conversión lo resuelve el servidor, nunca el cliente.
    presentacion: codigoPresentacionUrea.optional(),
    cantidad_bultos: z.number().int().positive().optional(),

    // Opcionales acá porque la obligatoriedad NO es fija: depende de
    // `combustible.requiere_documento` de ESE tanque, un dato de otra fila
    // que Zod no puede consultar. La exige el service; este schema solo
    // valida la coherencia del par (los dos o ninguno).
    tipo_documento: z.enum(TIPOS_DOCUMENTO_RECEPCION).optional(),
    numero_documento: z.string().trim().min(1).max(100).optional(),

    // Cuándo entró físicamente. Opcional: sin dato, el service usa now() --
    // mismo criterio que despachado_en/leido_en/vigente_desde.
    //
    // El tope de fecha futura faltaba, y era el único de los tres que no lo
    // tenía (5ª auditoría: se aceptó una recepción a +400 días). Una entrega
    // futura sale de todos los tramos hasta que llegue esa fecha y, peor,
    // deja el ciclo sin punto de arranque. El margen de 1 hora es el mismo de
    // despachado_en/leido_en: cubre el reloj desfasado del dispositivo.
    recibido_en: z
      .string()
      .datetime()
      .refine((valor) => new Date(valor).getTime() <= Date.now() + 60 * 60 * 1000, {
        message: "La fecha de la recepción no puede ser futura",
      })
      .optional(),

    // Migración 0110. Solo tiene sentido en el reintento: la primera vez que
    // una recepción no cabe en un tanque en modo 'flexible', la API responde
    // 409 con el detalle y NO guarda nada. Quien tiene el permiso "decidir
    // excedente" reparte el excedente y reenvía el MISMO payload con esto:
    // `cantidad` sigue siendo lo que entregó la cisterna (lo de la factura) y
    // el servidor guarda en el tanque lo que cabe. Las líneas suman
    // exactamente el excedente.
    reparto_excedente: z
      .array(
        z
          .object({
            destino: z.enum(["cubeta", "equipo", "devolucion"]),
            cantidad: z.number().positive(),
            equipo_id: z.number().int().positive().optional(),
            // A cuál tanqueta va una línea de 'cubeta' (0111).
            tanqueta_id: z.number().int().positive().optional(),
            observaciones: z.string().trim().max(300).optional(),
          })
          .superRefine((l, ctx) => {
            if ((l.destino === "equipo") !== (l.equipo_id !== undefined)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["equipo_id"],
                message: "equipo_id va si y solo si el destino es 'equipo'",
              });
            }
            if ((l.destino === "cubeta") !== (l.tanqueta_id !== undefined)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["tanqueta_id"],
                message: "tanqueta_id va si y solo si el destino es 'cubeta'",
              });
            }
          })
      )
      .min(1)
      .max(10)
      .optional(),

    // El precinto NUEVO de cada punto que se abrió para recibir (0095). Los
    // puntos marcados "se abre en recepción" lo exigen; lo valida el
    // servicio, que ve los puntos del tanque.
    precintos: z
      .array(
        z.object({
          punto_id: z.number().int().positive(),
          numero: z.string().trim().min(1).max(40),
        })
      )
      .max(20)
      .optional(),
  })
  .superRefine((data, ctx) => {
    // Espejo del CHECK combustible_recepciones_documento_check (0064): un
    // número sin tipo no dice qué documento es, y un tipo sin número no
    // sirve para encontrar el papel.
    const tieneTipo = data.tipo_documento !== undefined;
    const tieneNumero = data.numero_documento !== undefined;
    if (tieneTipo !== tieneNumero) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["numero_documento"],
        message: "Mandá tipo_documento y numero_documento juntos, o ninguno de los dos",
      });
    }

    if (data.producto === "urea") {
      if (data.combustible_id !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["combustible_id"],
          message: "combustible_id no aplica a una recepción de urea -- no hay tanque que llenar",
        });
      }
      if (data.presentacion === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["presentacion"],
          message: "presentacion es obligatoria para una recepción de urea",
        });
      }
      if (data.cantidad_bultos === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cantidad_bultos"],
          message: "cantidad_bultos es obligatoria para una recepción de urea",
        });
      }
      if (data.cantidad !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cantidad"],
          message: "cantidad no aplica a una recepción de urea -- se calcula de cantidad_bultos",
        });
      }
    } else {
      if (data.combustible_id === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["combustible_id"],
          message: "combustible_id es obligatorio para una recepción de combustible",
        });
      }
      if (data.cantidad === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cantidad"],
          message: "cantidad es obligatoria para una recepción de combustible",
        });
      }
      if (data.presentacion !== undefined || data.cantidad_bultos !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["presentacion"],
          message: "presentacion/cantidad_bultos solo aplican a una recepción de urea",
        });
      }
    }
  });

export type CrearRecepcionCombustibleInput = z.infer<typeof crearRecepcionCombustibleSchema>;

/** Anular una recepción mal cargada -- mismo criterio que lecturas y
 *  precios: `motivo` obligatorio, la fila NUNCA se borra ni se edita. Al
 *  anularla, el costo promedio del tanque se recalcula sin ella (ver
 *  CombustibleRepository.recalcularCostoPromedio). */
/** VALIDAR una recepción contra la guía (5ª auditoría, migración 0088).
 *
 *  Lo que se escribe acá es la cantidad que dice el DOCUMENTO del proveedor,
 *  no la que cargó quien recibió: son dos testigos distintos del mismo hecho,
 *  y el control existe justamente porque antes había uno solo. El formulario
 *  no muestra la cantidad registrada hasta después de guardar, para que
 *  validar sea escribir lo que dice el papel y no confirmar un número.
 *
 *  `cantidad_documento` va sin default y sin "confirmar sin número": validar
 *  sin leer la guía no es validar. */
export const validarRecepcionCombustibleSchema = z.object({
  cantidad_documento: z.number().positive(),
});

export type ValidarRecepcionCombustibleInput = z.infer<typeof validarRecepcionCombustibleSchema>;

export const anularRecepcionCombustibleSchema = z.object({
  motivo: z.string().trim().min(1, "El motivo de la anulación es obligatorio").max(500),
});

export type AnularRecepcionCombustibleInput = z.infer<typeof anularRecepcionCombustibleSchema>;

// ── Catálogo de presentaciones de urea (migración 0116) ──────────────────
// Los litros por bulto dejaron de ser una constante del código. El motivo y
// las alternativas descartadas están en docs/architecture/urea-industrial.md
// y en el encabezado de la migración.

/** El `codigo` NO se puede cambiar una vez creado: es lo que queda escrito
 *  en cada movimiento (`combustible_despachos.presentacion`), y es la mitad
 *  de la clave foránea. Renombrarlo rompería el vínculo de todo el historial
 *  que lo usa -- por eso el PUT recibe solo lo editable. Para "renombrar"
 *  una presentación se cambia su `nombre`, que es lo que ve el usuario. */
export const crearPresentacionUreaSchema = z.object({
  codigo: codigoPresentacionUrea,
  nombre: z.string().trim().min(1, "El nombre es obligatorio").max(60),
  // Mismo techo que el CHECK de la migración: un IBC industrial son 1.000 L,
  // así que 2.000 cubre cualquier envase real. Sin techo, un dedo de más
  // (200 en vez de 20) multiplica por diez todo el stock declarado.
  litros: z.number().positive().max(2000),
  es_referencia: z.boolean().default(false),
});

export type CrearPresentacionUreaInput = z.infer<typeof crearPresentacionUreaSchema>;

/** Cambiar los litros de una presentación NO reinterpreta el historial: cada
 *  movimiento guardó su propio `factor_litros` al crearse. Pero sí cambia lo
 *  que van a declarar los movimientos NUEVOS, así que lleva motivo
 *  obligatorio y queda en bitácora -- mismo trato que aflojar un umbral. */
export const actualizarPresentacionUreaSchema = z.object({
  nombre: z.string().trim().min(1, "El nombre es obligatorio").max(60),
  litros: z.number().positive().max(2000),
  es_referencia: z.boolean(),
  activa: z.boolean(),
  motivo: z.string().trim().min(1, "El motivo del cambio es obligatorio").max(500),
});

export type ActualizarPresentacionUreaInput = z.infer<typeof actualizarPresentacionUreaSchema>;

// ── Conteo físico de urea (migración 0092) ───────────────────────────────
// El reemplazo de la varilla: combustible se mide con una regla, urea se
// cuenta en cajas/bolsas/baldes. Es el único acto que le da al inventario
// de urea una contraparte FÍSICA -- sin esto, un stock que solo sale de
// restar movimientos nunca se puede contradecir a sí mismo.
export const crearConteoUreaSchema = z.object({
  cliente_uuid: z.string().uuid().optional(),
  // El que carga el conteo cuenta bultos, no litros -- igual que un vale.
  // El factor de conversión lo resuelve el servidor (ver FACTOR_LITROS_UREA),
  // nunca el cliente.
  presentacion: codigoPresentacionUrea,
  cantidad_bultos: z.number().int().nonnegative(),
  // Cuándo se hizo el conteo físico -- mismo criterio que leido_en/
  // despachado_en/recibido_en: opcional, el service usa now() sin dato, y
  // no puede ser futuro (el margen de 1h cubre el reloj del dispositivo).
  contado_en: z
    .string()
    .datetime()
    .refine((valor) => new Date(valor).getTime() <= Date.now() + 60 * 60 * 1000, {
      message: "La fecha del conteo no puede estar en el futuro",
    })
    .optional(),
  observaciones: z.string().trim().max(500).optional(),
});

export type CrearConteoUreaInput = z.infer<typeof crearConteoUreaSchema>;

export const anularConteoUreaSchema = z.object({
  motivo: z.string().trim().min(1, "El motivo de la anulación es obligatorio").max(500),
});

export type AnularConteoUreaInput = z.infer<typeof anularConteoUreaSchema>;

// ── Precintos numerados (migrations/0095) ─────────────────────────────────

/** Alta de un punto precintado: nace CON su primer precinto. Un punto sin
 *  precinto registrado no se puede verificar, así que no tiene sentido
 *  crearlo vacío. */
export const crearPuntoPrecintoSchema = z.object({
  nombre: z.string().trim().min(1).max(60),
  se_abre_en_recepcion: z.boolean().default(false),
  numero: z.string().trim().min(1).max(40),
});

export type CrearPuntoPrecintoInput = z.infer<typeof crearPuntoPrecintoSchema>;

/** Cambio de precinto FUERA de una recepción: mantenimiento, sello roto,
 *  corrección de un número mal tipeado. Motivo obligatorio: es la puerta que
 *  usaría el que roba, y lo único que la distingue es la explicación. */
export const cambiarPrecintoSchema = z.object({
  numero: z.string().trim().min(1).max(40),
  motivo: z.string().trim().min(1, "El motivo del cambio es obligatorio").max(500),
  colocado_en: z
    .string()
    .datetime()
    .refine((v) => new Date(v).getTime() <= Date.now() + 60 * 60 * 1000, {
      message: "La fecha del cambio no puede ser futura",
    })
    .optional(),
});

export type CambiarPrecintoInput = z.infer<typeof cambiarPrecintoSchema>;

/** Dejar de vigilar un punto. No se borra: queda con su historia y el
 *  motivo, y cuenta como aflojar la vigilancia. */
export const bajaPuntoPrecintoSchema = z.object({
  motivo: z.string().trim().min(1, "El motivo de la baja es obligatorio").max(500),
});

export type BajaPuntoPrecintoInput = z.infer<typeof bajaPuntoPrecintoSchema>;

// ── Surtidores (migración 0098) ───────────────────────────────────────────

export const crearSurtidorSchema = z.object({
  grifo_interno_id: z.number().int().positive(),
  nombre: z.string().trim().min(1).max(80),
  usa_totalizador: z.boolean().default(false),
  totalizador_tolerancia: z.number().min(0).max(1000).default(1),
});

export type CrearSurtidorInput = z.infer<typeof crearSurtidorSchema>;

/** Todo opcional: omitir un campo lo conserva. `motivo` es obligatorio
 *  cuando el cambio apaga el totalizador (lo decide el controller, que sabe
 *  cómo estaba). */
export const actualizarSurtidorSchema = z.object({
  nombre: z.string().trim().min(1).max(80).optional(),
  usa_totalizador: z.boolean().optional(),
  totalizador_tolerancia: z.number().min(0).max(1000).optional(),
  motivo: z.string().trim().min(1).max(500).optional(),
});

export type ActualizarSurtidorInput = z.infer<typeof actualizarSurtidorSchema>;

export const conectarSurtidorSchema = z.object({
  combustible_id: z.number().int().positive(),
  motivo: z.string().trim().min(1, "El motivo es obligatorio").max(500),
});

export type ConectarSurtidorInput = z.infer<typeof conectarSurtidorSchema>;

/** Desconectar, dar de baja o reactivar: sin decir por qué no deja rastro. */
export const motivoSurtidorSchema = z.object({
  motivo: z.string().trim().min(1, "El motivo es obligatorio").max(500),
});

export type MotivoSurtidorInput = z.infer<typeof motivoSurtidorSchema>;

/** Calibración del contómetro (0108): los TRES campos van siempre juntos y
 *  SE PISAN enteros, nunca se combinan con COALESCE -- a diferencia de
 *  actualizarSurtidorSchema, acá "no mandar un campo" también significa
 *  "bórralo", porque es la única forma de que el tenant pueda limpiar un
 *  certificado vencido sin dejar basura de uno viejo. */
export const calibracionSurtidorSchema = z.object({
  emp_pct: z.number().min(0).max(20).nullable().default(null),
  certificado: z.string().trim().min(1).max(80).nullable().default(null),
  vence: z.string().date().nullable().default(null),
});

export type CalibracionSurtidorInput = z.infer<typeof calibracionSurtidorSchema>;

// ── Tanquetas / cubetas (migración 0111) ─────────────────────────────────

export const crearTanquetaSchema = z.object({
  grifo_interno_id: z.number().int().positive(),
  // Sin código, el servidor asigna el siguiente (TQT-001...).
  codigo: z.string().trim().min(1).max(30).optional(),
  capacidad: z.number().positive().max(100000).default(280),
});

export type CrearTanquetaInput = z.infer<typeof crearTanquetaSchema>;

export const actualizarTanquetaSchema = z.object({
  codigo: z.string().trim().min(1).max(30).optional(),
  capacidad: z.number().positive().max(100000).optional(),
  activa: z.boolean().optional(),
  motivo: z.string().trim().min(1).max(500).optional(),
});

export type ActualizarTanquetaInput = z.infer<typeof actualizarTanquetaSchema>;
