import { z } from "zod";

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
  // el ruido de la varilla se suma a lo largo del ciclo: el mismo número
  // para los dos haría que este alertara todos los días.
  umbral_descuadre_ciclo_pct: z.number().min(0).max(100).nullable().default(null),
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
  /** Obligatorio SOLO si el cambio AFLOJA una vigilancia (subir un umbral,
   *  apagarlo poniéndolo en null, o dejar de exigir documento). No se puede
   *  validar acá porque depende de los valores actuales del tanque, que Zod
   *  no ve -- lo exige el service. Ver `evaluarAflojamiento`.
   *
   *  Motivo de que exista: hasta 0077, pasar el umbral de 1% a 90% -- que es
   *  APAGAR la detección de fraude -- quedaba en la auditoría igual que
   *  renombrar el tanque. */
  motivo_ajuste: z.string().trim().min(1).max(500).optional(),
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

// Wrapper legacy de PUT /:id/nivel -- mismo shape de body que siempre tuvo
// (nivel_actual), ahora validado con Zod como el resto de los módulos.
export const actualizarNivelCombustibleSchema = z.object({
  nivel_actual: z.number().nonnegative(),
});

export type ActualizarNivelCombustibleInput = z.infer<typeof actualizarNivelCombustibleSchema>;

// ── Despachos (Fase B, ver docs/architecture/control-de-combustible.md
// puntos 1, 2 y 5, y migrations/0062) ───────────────────────────────────

const ORIGENES_DESPACHO = ["tanque_propio", "compra_externa"] as const;
const TIPOS_DESTINO_DESPACHO = ["equipo", "planta", "reserva_cubeta"] as const;

/** Reglas cruzadas que Zod no expresa "limpio" solo con tipos -- por eso
 *  van en `.superRefine()` en vez de intentar dos schemas con `.and()`/
 *  discriminated union por dos campos a la vez (origen Y tipo_destino son
 *  independientes entre sí). Espejo de los CHECK de la migración 0062:
 *  esta es la validación que da un 400 legible ANTES de tocar la base: el
 *  CHECK sigue estando, como red de seguridad, para cualquier insert que
 *  no pase por acá. */
export const crearDespachoCombustibleSchema = z
  .object({
    // Mismo mecanismo que registrarLecturaCombustibleSchema -- lo genera
    // el dispositivo, online u offline. Opcional: sin él, siempre crea.
    cliente_uuid: z.string().uuid().optional(),

    origen: z.enum(ORIGENES_DESPACHO),
    // Solo tanque_propio.
    combustible_id: z.number().int().positive().optional(),
    // Solo compra_externa. FK al catálogo -- ver migrations/0063: texto
    // libre (0062) no alcanzaba para engancharle un precio de forma
    // confiable (cada grifo franquiciado cobra distinto en Perú).
    grifo_id: z.number().int().positive().optional(),

    // Mismo enum que combustible.tipo_combustible (Fase A) -- se reusa a
    // propósito, ver hallazgo 2 de la memoria de columnas reales.
    tipo_combustible: z.enum(TIPOS_COMBUSTIBLE),

    tipo_destino: z.enum(TIPOS_DESTINO_DESPACHO),
    // Solo cuando tipo_destino = 'equipo'.
    equipo_id: z.number().int().positive().optional(),

    // El talonario -- reinicia por serie/mes, ver hallazgo 6.
    serie_talonario: z.string().trim().min(1, "La serie del talonario es obligatoria").max(20),
    n_vale: z.number().int().positive(),

    cantidad: z.number().positive(),

    // Solo tanque_propio -- chequeo intra-vale del punto 5.
    lectura_contometro: z.number().nonnegative().optional(),

    // Solo compra_externa -- exactamente uno de los dos, según
    // equipos.tipo_medidor (hallazgo 9). horas_abastecidas siempre junto.
    lectura_horometro: z.number().nonnegative().optional(),
    lectura_odometro: z.number().nonnegative().optional(),
    horas_abastecidas: z.number().nonnegative().optional(),

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

    // Costos (migrations/0063). Obligatorio siempre -- Kenif lo confirmó
    // contra su planilla real, donde C.U está lleno en cada fila, para los
    // dos orígenes. El AUTOCOMPLETADO (buscar el precio vigente a
    // despachado_en) es responsabilidad del frontend -- este schema no
    // sabe nada de `combustible_precios`, solo exige el número.
    costo_unitario: z.number().positive(),
    observaciones: z.string().trim().max(500).optional(),
  })
  .superRefine((data, ctx) => {
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
      if (
        data.lectura_horometro !== undefined ||
        data.lectura_odometro !== undefined ||
        data.horas_abastecidas !== undefined
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["origen"],
          message: "horómetro/odómetro/horas_abastecidas no aplican a 'tanque_propio'",
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
  // Los dos topes diarios de la migración 0079. Nullable con la misma
  // semántica que los umbrales del tanque desde 0075: null = sin configurar
  // = no alerta. No se les pone default -- un techo inventado o alerta por
  // trabajo normal (y entonces se ignora) o queda tan alto que no atrapa
  // nada. El mínimo de 0.1 en los llenados es a propósito: 0 acá no
  // significa "estricto", significa "nadie puede recibir nada".
  llenados_por_dia_max: z.number().min(0.1).max(50).nullable(),
  tope_diario_sin_capacidad_l: z.number().positive().max(9_999_999).nullable(),
});

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
export const crearGrifoCombustibleSchema = z.object({
  nombre: z.string().trim().min(1, "El nombre del grifo es obligatorio").max(150),
  abastece_ruta: z.boolean().default(true),
  abastece_tanque: z.boolean().default(true),
});

export type CrearGrifoCombustibleInput = z.infer<typeof crearGrifoCombustibleSchema>;

export const actualizarGrifoCombustibleSchema = z.object({
  nombre: z.string().trim().min(1, "El nombre del grifo es obligatorio").max(150),
  activo: z.boolean(),
  abastece_ruta: z.boolean(),
  abastece_tanque: z.boolean(),
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

    // Las dos FK son obligatorias, a diferencia del despacho (donde son
    // polimórficas por origen): una recepción sin tanque no existe, y el
    // grifo/proveedor va SIEMPRE por catálogo -- alta previa obligatoria,
    // nunca texto libre.
    combustible_id: z.number().int().positive(),
    grifo_id: z.number().int().positive(),

    cantidad: z.number().positive(),
    costo_unitario: z.number().positive(),

    // Opcionales acá porque la obligatoriedad NO es fija: depende de
    // `combustible.requiere_documento` de ESE tanque, un dato de otra fila
    // que Zod no puede consultar. La exige el service; este schema solo
    // valida la coherencia del par (los dos o ninguno).
    tipo_documento: z.enum(TIPOS_DOCUMENTO_RECEPCION).optional(),
    numero_documento: z.string().trim().min(1).max(100).optional(),

    // Cuándo entró físicamente. Opcional: sin dato, el service usa now() --
    // mismo criterio que despachado_en/leido_en/vigente_desde.
    recibido_en: z.string().datetime().optional(),
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
  });

export type CrearRecepcionCombustibleInput = z.infer<typeof crearRecepcionCombustibleSchema>;

/** Anular una recepción mal cargada -- mismo criterio que lecturas y
 *  precios: `motivo` obligatorio, la fila NUNCA se borra ni se edita. Al
 *  anularla, el costo promedio del tanque se recalcula sin ella (ver
 *  CombustibleRepository.recalcularCostoPromedio). */
export const anularRecepcionCombustibleSchema = z.object({
  motivo: z.string().trim().min(1, "El motivo de la anulación es obligatorio").max(500),
});

export type AnularRecepcionCombustibleInput = z.infer<typeof anularRecepcionCombustibleSchema>;
