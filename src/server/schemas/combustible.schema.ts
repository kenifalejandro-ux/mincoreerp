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
  requiere_documento: z.boolean(),
  umbral_diferencia_pct: z.number().min(0).max(100).nullable(),
  umbral_descuadre_pct: z.number().min(0).max(100).nullable(),
  umbral_descuadre_ciclo_pct: z.number().min(0).max(100).nullable(),
  umbral_descuadre_ventana_pct: z.number().min(0).max(100).nullable(),
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

const ORIGENES_DESPACHO = ["tanque_propio", "compra_externa"] as const;
const TIPOS_DESTINO_DESPACHO = ["equipo", "planta", "reserva_cubeta"] as const;

// ── Urea automotriz (migrations/0092) ────────────────────────────────────
// Discriminador nuevo, ortogonal a `tipo_combustible` -- Kenif fue
// explícito: la urea NO entra en ese enum (no es "otro combustible", es
// otro producto que comparte la misma tabla).
const PRODUCTOS_DESPACHO = ["combustible", "urea"] as const;

// bolsa (4 L), caja (16 L, SIEMPRE 4 bolsas -- el cliente lo confirmó sin
// el "por lo general" de la respuesta de agosto), balde (20 L, es Green 32
// y en Perú los baldes vienen en ese tamaño). Fuente única de verdad para
// el factor de conversión -- el cliente NO lo manda: mandaría lo mismo que
// el sistema ya sabe, y dejar que lo mande abriría la puerta a que alguien
// declare una caja de 30 L el día que le convenga. El servidor lo resuelve
// y lo CONGELA en la fila (ver el encabezado de 0092) -- si el cliente
// confirma otro tamaño de envase el día de mañana, este mapa cambia pero
// las filas viejas no se reinterpretan solas.
export const PRESENTACIONES_UREA = ["bolsa", "caja", "balde"] as const;
export const FACTOR_LITROS_UREA: Record<(typeof PRESENTACIONES_UREA)[number], number> = {
  bolsa: 4,
  caja: 16,
  balde: 20,
};

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
    serie_talonario: z.string().trim().min(1, "La serie del talonario es obligatoria").max(20),
    n_vale: z.number().int().positive(),

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
    presentacion: z.enum(PRESENTACIONES_UREA).optional(),
    cantidad_bultos: z.number().int().positive().optional(),

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
      if (data.origen !== "compra_externa") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["origen"],
          message: "la urea siempre es 'compra_externa' -- no hay tanque propio de urea",
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
      return;
    }

    // ── COMBUSTIBLE: la validación de siempre, sin cambios ───────────────
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
    if (data.costo_unitario === undefined) {
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

    if (data.origen === "tanque_propio") {
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
    }
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

export const configCombustibleSchema = z.object({
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
  /** Obligatorio SOLO si el cambio AFLOJA algún control, igual que en la
   *  ficha del tanque. Hasta la 5ª auditoría la config era la excepción:
   *  apagar un tope o alargar la ventana de gracia se guardaba sin explicar
   *  nada, aunque el tanque sí lo exigiera. Mismo acto, mismo trato. */
  motivo_ajuste: z.string().trim().min(1).max(500).optional(),
});

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
    presentacion: z.enum(PRESENTACIONES_UREA).optional(),
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
  presentacion: z.enum(PRESENTACIONES_UREA),
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
