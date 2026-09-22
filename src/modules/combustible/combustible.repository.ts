/**src/modules/combutible/combustible.repository.ts */

import type { PoolClient } from "pg";
import { findAdminsConModulo } from "../../server/shared/utils/adminsDeModulo";
import type {
  CrearTanqueCombustibleInput,
  ActualizarTanqueCombustibleInput,
} from "../../server/schemas/combustible.schema";
import type { Paginacion } from "../../server/shared/utils/pagination";
import { esViolacionUnicidad, esViolacionForeignKey } from "../../server/shared/utils/pgError";
import {
  agregarAmbitoVales,
  filtroHechoDeGrifo,
  filtroTanqueVisible,
  type AlcanceCombustible,
  type AmbitoVales,
} from "./alcance";

/** El período con el que se acota un historial. Las dos puntas son
 *  opcionales y se pueden usar sueltas: "de marzo en adelante" y "hasta
 *  marzo" son consultas tan válidas como el rango cerrado. Sin ninguna de
 *  las dos, el listado se comporta como antes de que existiera el filtro. */
export interface PeriodoHistorial {
  desde?: string;
  hasta?: string;
}

/** Agrega al WHERE las condiciones del período, sobre la columna que
 *  corresponda a cada historial (`leido_en`, `despachado_en`,
 *  `recibido_en`).
 *
 *  La columna la elige el llamador y NUNCA viene del request: se concatena
 *  al SQL, así que si saliera de la query string sería una inyección. Las
 *  fechas sí vienen del usuario, y por eso van como parámetros.
 *
 *  El filtro usa la misma columna por la que el listado ordena, y eso
 *  importa: filtrar por `creado_en` mientras se ordena por `leido_en`
 *  dejaría afuera justamente los vales cargados en diferido desde la
 *  cancha, que es lo que el filtro tiene que poder mostrar. */
function agregarPeriodo(
  condiciones: string[],
  valores: unknown[],
  columna: string,
  periodo: PeriodoHistorial
) {
  if (periodo.desde !== undefined) {
    valores.push(periodo.desde);
    condiciones.push(`${columna} >= $${valores.length}::timestamptz`);
  }
  if (periodo.hasta !== undefined) {
    valores.push(periodo.hasta);
    condiciones.push(`${columna} <= $${valores.length}::timestamptz`);
  }
}

/** LA lista de tipos de alerta del módulo. Única fuente de verdad.
 *
 *  Hasta la 5ª auditoría la lista vivía escrita a mano en cuatro lugares (el
 *  CHECK de alertas, el de anomalías, la consulta del worker y los tipos
 *  revisables) y se desincronizó: el worker congelaba tres tipos que el CHECK
 *  de anomalías no aceptaba, el INSERT fallaba y la conciliación entera se
 *  caía -- con ella, la alerta de "tanque sin medir". Ver migración 0086.
 *
 *  tests/combustible-tipos-de-alerta-sincronizados.test.ts compara estas tres
 *  listas contra los CHECK REALES de la base: agregar un tipo acá y no en una
 *  migración (o al revés) rompe CI. */
export const TIPOS_ALERTA = [
  "hueco_detectado",
  "vale_anulado",
  "sobredespacho",
  "despacho_tardio",
  "diferencia_recepcion",
  "nivel_bajo",
  "medidor_inconsistente",
  "descuadre_inventario",
  "descuadre_ciclo",
  "tanque_sin_medir",
  "vale_fuera_de_orden",
  "lectura_retroactiva",
  "tope_diario_excedido",
  "descuadre_ventana",
  "despacho_retroactivo",
  "vale_recargado",
  "tanque_sin_vigilancia",
  "recepcion_anulada",
  "recepcion_discrepante",
  "recepcion_sin_validar",
  "recepcion_retroactiva",
  "consumo_excedido",
  "varilla_sin_control",
  "varilla_exacta",
  // ── Urea (migración 0092) -- los 3 controles genuinamente nuevos, ver el
  // encabezado de esa migración. El resto de los tipos de arriba (hueco,
  // vale_anulado, vale_fuera_de_orden, vale_recargado, tope_diario_excedido)
  // se REUSAN para urea, distinguidos por la columna `producto`, no por un
  // tipo nuevo.
  "urea_equipo_no_habilitado",
  "urea_ratio_excedido",
  "urea_descuadre_conteo",
  // ── Migración 0093: consumo anterior a la primera varilla del tanque.
  "historial_sin_contrastar",
  // ── Migración 0094: el totalizador acumulativo del surtidor.
  "totalizador_salto",
  "totalizador_retroceso",
  // ── Migración 0095: precintos numerados del tanque.
  "precinto_alterado",
  "precinto_reemplazado",
  // ── Migración 0100: vale de tanque propio a un equipo de otro grifo.
  "equipo_de_otro_grifo",
] as const;

export type TipoAlertaCombustible = (typeof TIPOS_ALERTA)[number];

/** Los ESTADOS: se resuelven solos cuando el problema deja de existir, así
 *  que ni se congelan ni se cierran a mano. Congelar uno dejaría una anomalía
 *  permanente de algo que ya se arregló; cerrarlo a mano dejaría a una
 *  persona tapar algo que el sistema sabe contestar solo. */
export const TIPOS_ESTADO = [
  "nivel_bajo",
  "tanque_sin_medir",
  "tanque_sin_vigilancia",
  "recepcion_sin_validar",
  "varilla_sin_control",
] as const satisfies readonly TipoAlertaCombustible[];

/** Todo lo que no es estado es un HALLAZGO: si nadie lo explica dentro de la
 *  ventana de gracia, se congela como anomalía permanente. */
export const TIPOS_CONGELABLES = TIPOS_ALERTA.filter(
  (t) => !(TIPOS_ESTADO as readonly string[]).includes(t)
);

/** Los hallazgos que se cierran A MANO, con motivo. Todos los congelables
 *  menos el hueco de talonario, que se cierra solo cuando llega el vale que
 *  faltaba -- dejar que alguien lo cierre a mano sería permitir silenciar un
 *  hueco que en realidad sigue abierto. */
export const TIPOS_REVISABLES = TIPOS_CONGELABLES.filter((t) => t !== "hueco_detectado");

/** Una alerta por crear. Las anclas son todas opcionales en el tipo, pero
 *  el CHECK de la base exige al menos una (vale, tanque o recepción). */
export interface AlertaNueva {
  tipo: TipoAlertaCombustible;
  serieTalonario?: string | null;
  nVale?: number | null;
  despachoId?: number | null;
  combustibleId?: number | null;
  recepcionId?: number | null;
  /** La varilla que disparó la alerta (0086). Es lo que permite saber si
   *  quien cierra una alerta de descuadre es el mismo que midió. */
  lecturaId?: number | null;
  /** El conteo físico de urea que disparó la alerta (0092) -- el ancla de
   *  `urea_descuadre_conteo`, que no es sobre un vale ni un tanque ni una
   *  recepción. Cuarto tipo de ancla, mismo criterio que lecturaId. */
  ureaConteoId?: number | null;
  /** Migración 0092. Default 'combustible' -- no rompe ningún llamador
   *  existente. Es lo que separa el namespace del talonario de urea del de
   *  combustible en las consultas de hueco (ver
   *  idx_combustible_alertas_serie_vale): sin esto, un hueco de urea
   *  resolvería (o se confundiría con) uno de combustible con el mismo
   *  número de vale. */
  producto?: "combustible" | "urea";
  detalle: Record<string, unknown>;
}

// Columnas comunes a findAll/findById/create/update/delete -- un tanque es
// el punto de abastecimiento completo, no solo el medidor de antes de la
// Fase A (ver docs/architecture/control-de-combustible.md).
//
// `nivel_actual`, `fecha_actualizacion` y `porcentaje` NO son columnas: se
// calculan desde la última lectura vigente (migración 0059). Antes se
// guardaban y se mantenían con un UPDATE condicional que fallaba en
// silencio -- ver el comentario largo de esa migración. Ahora el desfase es
// imposible: hay una sola fuente.
//
// Se devuelven con los mismos nombres de siempre para no romper el contrato
// con el cliente, que no tiene por qué enterarse de dónde sale el número.
//
// NULL cuando el tanque no tiene ninguna lectura vigente (todas anuladas):
// ahí el nivel es genuinamente desconocido, y decirlo es más honesto que
// mostrar un 0 que nadie midió.
/** Los litros de un listado de vales, convertidos por la unidad de SU tanque
 *  (entrega 4): sumar galones y litros crudos da un número sin sentido. Una
 *  compra externa no tiene tanque ni unidad: se toma como litros, igual que
 *  findAcumuladoDiario. `t` es el alias del tanque en la consulta. */
const sumaLitros = (t: string) =>
  `SUM(d.cantidad * CASE WHEN ${t}.unidad = 'gal' THEN 3.785411784 ELSE 1 END)`;

const COLUMNAS_TANQUE = `
  c.id, c.codigo, c.tanque_nombre, c.tipo_combustible, c.unidad, c.tipo_punto,
  c.ubicacion, c.capacidad_total, c.nivel_minimo,
  c.costo_promedio, c.moneda, c.activo,
  c.tolerancia_capacidad_pct, c.requiere_documento, c.umbral_diferencia_pct,
  c.umbral_descuadre_pct, c.umbral_descuadre_ciclo_pct,
  c.umbral_descuadre_ventana_pct,
  c.usa_precintos, c.grifo_interno_id,
  -- Los surtidores que alimentan al tanque hoy (0098). La configuración del
  -- totalizador es del SURTIDOR; estas tres columnas se siguen devolviendo con
  -- los valores de su surtidor cuando tiene UNO solo (el caso simple, donde la
  -- casilla sigue en el formulario del tanque), y en NULL si tiene varios.
  sv.surtidores,
  CASE WHEN jsonb_array_length(sv.surtidores) = 1
       THEN (sv.surtidores->0->>'usa_totalizador')::boolean END AS usa_totalizador,
  CASE WHEN jsonb_array_length(sv.surtidores) = 1
       THEN (sv.surtidores->0->>'totalizador_tolerancia')::numeric END AS totalizador_tolerancia,
  CASE WHEN jsonb_array_length(sv.surtidores) = 1
       THEN (sv.surtidores->0->>'totalizador_actual')::numeric END AS totalizador_actual,
  ultima.nivel AS nivel_actual,
  ultima.leido_en AS fecha_actualizacion,
  ROUND((ultima.nivel / c.capacidad_total) * 100, 2) AS porcentaje
`;

// LEFT JOIN LATERAL y no un subquery por columna: así la última lectura se
// busca UNA vez por tanque y de ahí salen nivel y fecha juntos. LEFT (no
// INNER) para que un tanque sin lecturas vigentes siga apareciendo en el
// listado, con el nivel en NULL.
//
// El desempate por id importa: dos lecturas con el MISMO leido_en (mismo
// minuto, que es la precisión que manda el formulario) tienen que resolverse
// siempre igual, si no el nivel dependería del plan del query.
const JOIN_ULTIMA_LECTURA = `
  LEFT JOIN LATERAL (
    SELECT l.nivel, l.leido_en
    FROM combustible_lecturas l
    WHERE l.combustible_id = c.id AND l.anulada_en IS NULL
    ORDER BY l.leido_en DESC, l.id DESC
    LIMIT 1
  ) ultima ON true
  LEFT JOIN LATERAL (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'id', s.id,
             'nombre', s.nombre,
             'activo', s.activo,
             'usa_totalizador', s.usa_totalizador,
             'totalizador_tolerancia', s.totalizador_tolerancia,
             'totalizador_actual', s.totalizador_actual,
             -- Alimenta también a otro tanque: el vale tiene que decir de cuál
             -- salió, y el desglose del descuadre no se puede calcular.
             'compartido', EXISTS (
               SELECT 1 FROM surtidor_tanques otro
                WHERE otro.surtidor_id = s.id AND otro.desconectado_en IS NULL
                  AND otro.combustible_id <> c.id)
           ) ORDER BY lower(s.nombre)), '[]'::jsonb) AS surtidores
      FROM surtidor_tanques st
      JOIN surtidores s ON s.id = st.surtidor_id AND s.tenant_id = c.tenant_id
     WHERE st.combustible_id = c.id AND st.desconectado_en IS NULL
  ) sv ON true
`;

/** LA cuenta de la diferencia de recepción, compartida por el listado, la
 *  alerta del worker y la muestra de calibración. Espera la recepción con
 *  alias `r` y agrega un LATERAL `dif`.
 *
 *      diferencia = (nivel_después − nivel_antes) + salidas − lo recibido
 *
 *  ── Entregas combinadas (5ª auditoría) ──────────────────────────────────
 *
 *  Antes, si entre las dos varillas había OTRA recepción, la diferencia
 *  quedaba en NULL ("no se puede atribuir a una sola entrega"). Eso era un
 *  interruptor de apagado: dos recepciones de 1 L metidas entre dos varillas
 *  dejaban la diferencia en blanco y además reiniciaban el ciclo. Verificado:
 *  el control del ciclo pasó de 5 alertas a cero. Y dos cisternas el mismo
 *  día sin varilla en el medio es operación normal (Kenif, 2026-09-14).
 *
 *  Ahora las recepciones entre el mismo par de varillas forman UN grupo y la
 *  diferencia se calcula contra la suma del grupo. No se le atribuye a una
 *  entrega en particular (eso seguiría siendo inventar): se dice que el grupo
 *  no cierra, con todas sus entregas a la vista.
 *
 *  El propio `r` entra siempre en su grupo, aunque su fecha coincida con la
 *  de la varilla de antes; las demás, con el mismo corte `> antes, <= después`
 *  que usa el resto del módulo. */
/** Cuántos huecos como mucho puede revelar UN vale. Ver el comentario en
 *  detectarHuecosRevelados: es la red de seguridad del lado de los datos. */
const MAX_HUECOS_POR_VALE = 500;

const LATERAL_DIFERENCIA_RECEPCION = `
  LEFT JOIN LATERAL (
    SELECT
      antes.nivel AS nivel_antes,
      despues.nivel AS nivel_despues,
      COALESCE(salidas.total, 0) AS salidas,
      grupo.entregas AS entregas_en_grupo,
      grupo.cantidad AS cantidad_del_grupo,
      grupo.ids AS recepciones_del_grupo,
      grupo.ultima_id AS ultima_del_grupo,
      CASE
        WHEN antes.nivel IS NULL OR despues.nivel IS NULL THEN NULL
        WHEN r.anulada_en IS NOT NULL THEN NULL
        ELSE (despues.nivel - antes.nivel) + COALESCE(salidas.total, 0) - grupo.cantidad
      END AS diferencia_litros
    FROM (
      SELECT l.nivel, l.leido_en FROM combustible_lecturas l
       WHERE l.combustible_id = r.combustible_id AND l.anulada_en IS NULL
         AND l.leido_en <= r.recibido_en
       ORDER BY l.leido_en DESC, l.id DESC LIMIT 1
    ) antes
    FULL JOIN (
      SELECT l.nivel, l.leido_en FROM combustible_lecturas l
       WHERE l.combustible_id = r.combustible_id AND l.anulada_en IS NULL
         AND l.leido_en > r.recibido_en
       ORDER BY l.leido_en ASC, l.id ASC LIMIT 1
    ) despues ON true
    -- Lo que SALIÓ del tanque entre las dos lecturas: sin sumarlo de vuelta,
    -- un despacho hecho en el medio se vería como faltante. Un vale anulado
    -- no sacó combustible (0067).
    LEFT JOIN LATERAL (
      SELECT SUM(d.cantidad) AS total FROM combustible_despachos d
       WHERE d.combustible_id = r.combustible_id AND d.anulada_en IS NULL
         AND d.despachado_en > antes.leido_en AND d.despachado_en <= despues.leido_en
    ) salidas ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS entregas,
             COALESCE(SUM(r2.cantidad), 0) AS cantidad,
             ARRAY_AGG(r2.id ORDER BY r2.recibido_en, r2.id) AS ids,
             (ARRAY_AGG(r2.id ORDER BY r2.recibido_en DESC, r2.id DESC))[1] AS ultima_id
        FROM combustible_recepciones r2
       WHERE r2.combustible_id = r.combustible_id AND r2.anulada_en IS NULL
         AND (
           r2.id = r.id
           OR (r2.recibido_en > antes.leido_en AND r2.recibido_en <= despues.leido_en)
         )
    ) grupo ON true
  ) dif ON true
`;

export class CombustibleRepository {
  async findAll(client: PoolClient, tenantId: string, alcance?: AlcanceCombustible) {
    // Solo los tanques que el usuario ve (0100): su grifo o un surtidor suyo.
    const f = alcance ? filtroTanqueVisible(alcance, "c", 2) : { sql: "TRUE", valores: [] };
    const result = await client.query(
      `SELECT ${COLUMNAS_TANQUE} FROM combustible c ${JOIN_ULTIMA_LECTURA}
       WHERE c.tenant_id = $1 AND ${f.sql} ORDER BY c.id ASC`,
      [tenantId, ...f.valores]
    );

    return result.rows;
  }

  async findById(client: PoolClient, tenantId: string, id: number) {
    const result = await client.query(
      `SELECT ${COLUMNAS_TANQUE} FROM combustible c ${JOIN_ULTIMA_LECTURA}
       WHERE c.id = $1 AND c.tenant_id = $2`,
      [id, tenantId]
    );

    return result.rows[0] || null;
  }

  /** El nivel inicial del alta se guarda como una LECTURA (`origen =
   *  'inicial'`), no como una columna del tanque: desde la migración 0059 el
   *  nivel se deriva del historial, así que un tanque sin ninguna lectura no
   *  tendría nivel que mostrar. Además deja el arranque visible en el
   *  historial, que antes no figuraba en ningún lado. */
  async create(client: PoolClient, tenantId: string, data: CrearTanqueCombustibleInput) {
    // Mismo techo que validarRecepcion en el service (capacidad + tolerancia):
    // un nivel inicial que ya nace por encima es la misma contradicción física
    // que una recepción que lo empuja ahí, así que no puede colarse solo
    // porque llega por un camino distinto (INSERT directo, no recepción).
    const capacidad = Number(data.capacidad_total);
    const toleranciaPct = Number(data.tolerancia_capacidad_pct);
    const techo = capacidad * (1 + toleranciaPct / 100);
    if (data.nivel_actual > techo) {
      const detalleTolerancia =
        toleranciaPct > 0 ? ` + ${toleranciaPct}% de tolerancia (${techo.toFixed(2)})` : "";
      throw new Error(
        `el nivel inicial ${data.nivel_actual} supera la capacidad del tanque (${capacidad}${detalleTolerancia})`
      );
    }

    const creado = await client.query<{ id: number }>(
      `
      INSERT INTO combustible (
        tenant_id, codigo, tanque_nombre, tipo_combustible, unidad, tipo_punto,
        ubicacion, capacidad_total, nivel_minimo, moneda,
        tolerancia_capacidad_pct, requiere_documento, umbral_diferencia_pct,
        umbral_descuadre_pct, umbral_descuadre_ciclo_pct,
        umbral_descuadre_ventana_pct, usa_precintos, grifo_interno_id
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      RETURNING id
      `,
      [
        tenantId,
        data.codigo,
        data.tanque_nombre,
        data.tipo_combustible,
        data.unidad,
        data.tipo_punto,
        data.ubicacion ?? null,
        data.capacidad_total,
        data.nivel_minimo,
        data.moneda,
        data.tolerancia_capacidad_pct,
        data.requiere_documento,
        data.umbral_diferencia_pct,
        data.umbral_descuadre_pct,
        data.umbral_descuadre_ciclo_pct,
        data.umbral_descuadre_ventana_pct,
        data.usa_precintos ?? false,
        // NULL = que lo asigne la base (el único grifo de la empresa, 0097).
        data.grifo_interno_id ?? null,
      ]
    );

    const id = creado.rows[0].id;
    await client.query(
      `INSERT INTO combustible_lecturas (tenant_id, combustible_id, nivel, leido_en, origen)
       VALUES ($1, $2, $3, NOW(), 'inicial')`,
      [tenantId, id, data.nivel_actual]
    );
    // Todo tanque nace con su surtidor (0098), con la casilla y la tolerancia
    // del formulario. Acá y no en un trigger de alta: restaurar un backup
    // volvería a crearlo encima del que trae el backup.
    await this.crearSurtidorDelTanque(
      client,
      id,
      data.usa_totalizador,
      data.totalizador_tolerancia
    );

    // Se relee en vez de usar RETURNING: el nivel sale de un LATERAL JOIN
    // contra las lecturas, que RETURNING no puede hacer.
    return this.findById(client, tenantId, id);
  }

  /** Reemplaza la fila entera salvo `nivel_actual` (que es de las lecturas)/
   *  `costo_promedio` -- mismo motivo que en create(): esos tres tienen su
   *  propio camino de escritura, este endpoint no es ese camino. */
  async update(
    client: PoolClient,
    tenantId: string,
    id: number,
    data: ActualizarTanqueCombustibleInput
  ) {
    // Mismo techo que en create(): si bajan capacidad_total o tolerancia por
    // debajo de lo que ya hay cargado (vía lecturas), la fila queda
    // contradiciéndose a sí misma apenas se guarda, sin que ninguna recepción
    // ni lectura nueva lo dispare. NULL (sin lectura vigente) no se puede
    // comparar contra nada, así que no bloquea.
    const actual = await this.findById(client, tenantId, id);
    if (actual && actual.nivel_actual !== null) {
      const capacidad = Number(data.capacidad_total);
      const toleranciaPct = Number(data.tolerancia_capacidad_pct);
      const techo = capacidad * (1 + toleranciaPct / 100);
      if (Number(actual.nivel_actual) > techo) {
        const detalleTolerancia =
          toleranciaPct > 0 ? ` + ${toleranciaPct}% de tolerancia (${techo.toFixed(2)})` : "";
        throw new Error(
          `el nivel actual del tanque (${actual.nivel_actual}) supera la capacidad que estás por guardar (${capacidad}${detalleTolerancia})`
        );
      }
    }

    const result = await client.query(
      `
      UPDATE combustible SET
        codigo = $1,
        tanque_nombre = $2,
        tipo_combustible = $3,
        unidad = $4,
        tipo_punto = $5,
        ubicacion = $6,
        capacidad_total = $7,
        nivel_minimo = $8,
        moneda = $9,
        activo = $10,
        tolerancia_capacidad_pct = $11,
        requiere_documento = $12,
        umbral_diferencia_pct = $13,
        umbral_descuadre_pct = $14,
        umbral_descuadre_ciclo_pct = $15,
        umbral_descuadre_ventana_pct = $16,
        usa_precintos = COALESCE($17, usa_precintos)
      WHERE id = $18 AND tenant_id = $19
      RETURNING id
      `,
      [
        data.codigo,
        data.tanque_nombre,
        data.tipo_combustible,
        data.unidad,
        data.tipo_punto,
        data.ubicacion ?? null,
        data.capacidad_total,
        data.nivel_minimo,
        data.moneda,
        data.activo,
        data.tolerancia_capacidad_pct,
        data.requiere_documento,
        data.umbral_diferencia_pct,
        data.umbral_descuadre_pct,
        data.umbral_descuadre_ciclo_pct,
        data.umbral_descuadre_ventana_pct,
        data.usa_precintos ?? null,
        id,
        tenantId,
      ]
    );

    if (result.rows.length === 0) return null;
    // La casilla del totalizador es del SURTIDOR (0098). En el caso simple --un
    // solo surtidor-- sigue en el formulario del tanque y se guarda en él. Con
    // varios, se configura en cada surtidor y lo que venga acá no aplica.
    if (data.usa_totalizador !== undefined || data.totalizador_tolerancia !== undefined) {
      await client.query(
        `UPDATE surtidores s
            SET usa_totalizador = COALESCE($1, s.usa_totalizador),
                totalizador_tolerancia = COALESCE($2, s.totalizador_tolerancia)
          WHERE s.tenant_id = $3
            AND s.id = (SELECT st.surtidor_id FROM surtidor_tanques st
                         WHERE st.combustible_id = $4 AND st.desconectado_en IS NULL)
            AND (SELECT count(*) FROM surtidor_tanques st
                  WHERE st.combustible_id = $4 AND st.desconectado_en IS NULL) = 1`,
        [data.usa_totalizador ?? null, data.totalizador_tolerancia ?? null, tenantId, id]
      );
    }
    return this.findById(client, tenantId, id);
  }

  /** Soft-delete exclusivamente: `combustible_lecturas.combustible_id`
   *  tiene ON DELETE CASCADE (0045_combustible_lecturas.sql) -- un DELETE
   *  real de SQL borraría en cascada todo el historial de lecturas del
   *  tanque. Desactivar dejando la fila (y su historial) intactos es la
   *  única forma segura de "eliminar" un tanque acá. */
  async softDelete(client: PoolClient, tenantId: string, id: number) {
    const result = await client.query(
      `UPDATE combustible SET activo = false WHERE id = $1 AND tenant_id = $2
       RETURNING id`,
      [id, tenantId]
    );
    if (result.rows.length === 0) return null;
    return this.findById(client, tenantId, id);
  }

  /** Mismo patrón de lote de 1.000 + dedupe por `codigo` DENTRO del lote
   *  que RepuestosRepository.createBulk -- ver el comentario largo ahí. En
   *  la práctica un tenant nunca va a acercarse al tamaño de lote (los
   *  tanques son unos pocos por sitio), pero el molde es el mismo por
   *  consistencia y porque el tope real está en el schema (Zod), no acá. */
  /** La carga masiva DA DE ALTA; no edita lo que ya existe.
   *
   *  Antes hacía `ON CONFLICT (tenant_id, codigo) DO UPDATE`, y eso convertía
   *  la planilla en la puerta de atrás de toda la configuración del módulo: la
   *  5ª auditoría pasó un tanque con historial de litros a galones (el PUT lo
   *  bloquea), le multiplicó la capacidad por 10, le subió la tolerancia al
   *  90 %, le sacó la exigencia de documento y le apagó dos umbrales -- todo
   *  con un 201 y una sola línea de auditoría que decía `{ cantidad: 1 }`.
   *  Ni motivo, ni correo, ni valor viejo contra valor nuevo.
   *
   *  Y el daño no necesitaba mala intención: reimportar el mismo Excel para
   *  corregir una ubicación, sin las columnas de umbral, dejaba los umbrales
   *  en NULL. El tanque quedaba ciego sin que nadie tocara nada.
   *
   *  Ahora los códigos que ya existen se OMITEN y se devuelven, para que la
   *  pantalla lo diga y la auditoría lo registre. Editar un tanque es un acto
   *  con nombre propio: pasa por el PUT, que compara, pide motivo si afloja y
   *  avisa a los admins. */
  async createBulk(client: PoolClient, tenantId: string, items: CrearTanqueCombustibleInput[]) {
    const TAMANO_LOTE = 1000;
    const creados: unknown[] = [];
    const omitidos: string[] = [];

    for (let inicio = 0; inicio < items.length; inicio += TAMANO_LOTE) {
      const lote = items.slice(inicio, inicio + TAMANO_LOTE);

      // Dedupe por código DENTRO del lote: dos filas con el mismo código en
      // la misma sentencia rompen el INSERT ("command cannot affect row a
      // second time"). Gana la última, que es lo que hacía el loop original.
      const porCodigo = new Map<string, CrearTanqueCombustibleInput>();
      for (const fila of lote) porCodigo.set(fila.codigo, fila);

      const preexistentes = await client.query<{ codigo: string }>(
        `SELECT codigo FROM combustible WHERE tenant_id = $1 AND codigo = ANY($2::varchar[])`,
        [tenantId, [...porCodigo.keys()]]
      );
      const yaExisten = new Set(preexistentes.rows.map((f) => f.codigo));
      const filasUnicas: CrearTanqueCombustibleInput[] = [];
      for (const [codigo, fila] of porCodigo) {
        if (yaExisten.has(codigo)) omitidos.push(codigo);
        else filasUnicas.push(fila);
      }
      if (filasUnicas.length === 0) continue;

      // El mismo techo que create() y que validarRecepcion: un nivel inicial
      // por encima de la capacidad es una contradicción física, y entrar por
      // la planilla no la vuelve válida.
      for (const d of filasUnicas) {
        const techo = d.capacidad_total * (1 + d.tolerancia_capacidad_pct / 100);
        if (d.nivel_actual > techo) {
          throw new Error(
            `el nivel inicial ${d.nivel_actual} del tanque ${d.codigo} supera la capacidad ` +
              `(${d.capacidad_total})`
          );
        }
      }

      const COLUMNAS_POR_FILA = 16;
      const placeholders = filasUnicas
        .map((_, i) => {
          const base = i * COLUMNAS_POR_FILA;
          const params = Array.from(
            { length: COLUMNAS_POR_FILA },
            (_unused, j) => `$${base + j + 1}`
          );
          return `(${params.join(", ")})`;
        })
        .join(", ");

      const valores = filasUnicas.flatMap((d) => [
        tenantId,
        d.codigo,
        d.tanque_nombre,
        d.tipo_combustible,
        d.unidad,
        d.tipo_punto,
        d.ubicacion ?? null,
        d.capacidad_total,
        d.nivel_minimo,
        // Fase C (0064) -- el Excel puede traerlas o no; Zod ya aplicó el
        // default (0 / true) para las filas que no las incluyan.
        d.tolerancia_capacidad_pct,
        d.requiere_documento,
        d.umbral_diferencia_pct,
        d.umbral_descuadre_pct,
        // Los dos que faltaban: una planilla CON los umbrales del ciclo y de
        // la ventana los perdía en silencio, y el tanque nacía a medias
        // vigilado creyendo el cliente que los había cargado.
        d.umbral_descuadre_ciclo_pct,
        d.umbral_descuadre_ventana_pct,
        // 0097: NULL = el único grifo de la empresa, lo asigna la base.
        d.grifo_interno_id ?? null,
      ]);

      const insertados = await client.query<{ id: number; codigo: string }>(
        `INSERT INTO combustible (
           tenant_id, codigo, tanque_nombre, tipo_combustible, unidad, tipo_punto,
           ubicacion, capacidad_total, nivel_minimo,
           tolerancia_capacidad_pct, requiere_documento, umbral_diferencia_pct,
           umbral_descuadre_pct, umbral_descuadre_ciclo_pct, umbral_descuadre_ventana_pct,
           grifo_interno_id
         )
         VALUES ${placeholders}
         RETURNING id, codigo`,
        valores
      );

      const nivelPorCodigo = new Map(filasUnicas.map((d) => [d.codigo, d.nivel_actual]));
      for (const fila of insertados.rows) {
        await client.query(
          `INSERT INTO combustible_lecturas (tenant_id, combustible_id, nivel, leido_en, origen)
           VALUES ($1, $2, $3, NOW(), 'inicial')`,
          [tenantId, fila.id, nivelPorCodigo.get(fila.codigo) ?? 0]
        );
      }

      for (const fila of insertados.rows) {
        // Mismo surtidor que el alta de a uno (0098).
        const datos = porCodigo.get(fila.codigo);
        await this.crearSurtidorDelTanque(
          client,
          fila.id,
          datos?.usa_totalizador,
          datos?.totalizador_tolerancia
        );
        creados.push(await this.findById(client, tenantId, fila.id));
      }
    }

    return { creados, omitidos };
  }

  /** GET /:id/lecturas -- a diferencia de los tanques (pocos, sin
   *  paginación), el histórico de lecturas SÍ crece con el trabajo de
   *  campo, mismo criterio que combustible_lecturas ya tiene declarada su
   *  propia cuota en el registry. */
  async findLecturas(
    client: PoolClient,
    tenantId: string,
    combustibleId: number,
    { pageSize, offset }: Paginacion,
    periodo: PeriodoHistorial = {}
  ) {
    const condiciones: string[] = ["l.combustible_id = $1", "l.tenant_id = $2"];
    const valores: unknown[] = [combustibleId, tenantId];
    agregarPeriodo(condiciones, valores, "l.leido_en", periodo);
    valores.push(pageSize, offset);

    const result = await client.query(
      `
      SELECT l.id, l.combustible_id, l.nivel, l.leido_en, l.usuario_id, l.origen,
             l.metadata, l.creado_en,
             -- Lo que leyó en cada surtidor (0098), y el valor suelto cuando
             -- leyó uno solo: el campo que usaban la pantalla y los tests de
             -- 0096, que sigue teniendo sentido en el caso simple.
             tv.totalizadores,
             CASE WHEN jsonb_array_length(tv.totalizadores) = 1
                  THEN (tv.totalizadores->0->>'valor')::numeric END AS totalizador_lectura,
             l.anulada_en, l.anulada_por, l.motivo_anulacion,
             anulador.nombre AS anulada_por_nombre,
             autor.nombre AS registrada_por_nombre,
        COUNT(*) OVER() AS total_count
      FROM combustible_lecturas l
      -- Dos LEFT JOIN sobre la misma tabla, por dos motivos distintos:
      -- quién ANULÓ y quién REGISTRÓ. Los dos LEFT y no INNER porque las
      -- dos columnas son nullable (usuario borrado deja SET NULL, ver 0045
      -- y 0058) y la mayoría de las lecturas no están anuladas -- un INNER
      -- las dejaría a todas fuera del listado.
      LEFT JOIN usuarios anulador ON anulador.id = l.anulada_por
      -- El autor del registro importa tanto como el de la anulación: en un
      -- módulo anti-fuga, "¿quién anotó esta lectura rara?" es justamente
      -- la pregunta que hay que poder responder.
      LEFT JOIN usuarios autor ON autor.id = l.usuario_id
      LEFT JOIN LATERAL (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
                 'surtidor_id', lt.surtidor_id, 'surtidor', s.nombre, 'valor', lt.valor
               ) ORDER BY lower(s.nombre)), '[]'::jsonb) AS totalizadores
          FROM combustible_lectura_totalizadores lt
          JOIN surtidores s ON s.id = lt.surtidor_id AND s.tenant_id = lt.tenant_id
         WHERE lt.lectura_id = l.id AND lt.tenant_id = l.tenant_id
      ) tv ON true
      WHERE ${condiciones.join(" AND ")}
      ORDER BY l.leido_en DESC
      LIMIT $${valores.length - 1} OFFSET $${valores.length}
      `,
      valores
    );

    return result.rows;
  }

  /** Marca una lectura como anulada.
   *
   *  Ya no hace falta recalcular nada: desde la migración 0059 el nivel se
   *  deriva de la última lectura vigente al leerlo, así que anular la más
   *  reciente hace que el tanque vuelva solo a la anterior. Antes había un
   *  `recalcularNivelDesdeUltimaLectura()` acá justamente para eso.
   *
   *  El UPDATE lleva `anulada_en IS NULL` en el WHERE: si la lectura ya
   *  estaba anulada no afecta ninguna fila y devuelve null, así el
   *  controller responde 409 en vez de pisar el motivo y el autor de la
   *  anulación original (que son la evidencia de quién corrigió qué).
   *  Mismo patrón que `IpercRepository.cambiarEstado` -- ver
   *  fix_race_condition_iperc_estado: dos anulaciones simultáneas no pueden
   *  terminar las dos en 200. */
  async anularLectura(
    client: PoolClient,
    tenantId: string,
    lecturaId: number,
    usuarioId: string,
    motivo: string
  ) {
    const anulada = await client.query(
      `
      UPDATE combustible_lecturas
      SET anulada_en = now(), anulada_por = $1, motivo_anulacion = $2
      WHERE id = $3 AND tenant_id = $4 AND anulada_en IS NULL
      RETURNING id, combustible_id, nivel, leido_en, usuario_id, origen, metadata,
                creado_en, anulada_en, anulada_por, motivo_anulacion
      `,
      [usuarioId, motivo, lecturaId, tenantId]
    );

    if (anulada.rows.length === 0) return null;

    const lectura = anulada.rows[0];
    // Una varilla con totalizador es un punto de la cadena de CADA surtidor
    // que leyó (0096, 0098): al anularla sale de todas, y el máximo vigente de
    // cada uno puede bajar.
    const leidos = await client.query<{ surtidor_id: number }>(
      `SELECT surtidor_id FROM combustible_lectura_totalizadores
        WHERE lectura_id = $1 AND tenant_id = $2 ORDER BY surtidor_id`,
      [lecturaId, tenantId]
    );
    for (const { surtidor_id } of leidos.rows) {
      await this.bloquearSurtidor(client, tenantId, surtidor_id);
      await this.recalcularTotalizadorActual(client, tenantId, surtidor_id);
    }
    const tanque = await this.findById(client, tenantId, lectura.combustible_id);

    return { lectura, tanque };
  }

  /** Distingue "no existe / es de otro tenant" (404) de "ya estaba anulada"
   *  (409) -- sin esto, `anularLectura` devuelve null en los dos casos y el
   *  controller no puede decir cuál fue. */
  async findLecturaPorId(client: PoolClient, tenantId: string, lecturaId: number) {
    const result = await client.query(
      `SELECT id, combustible_id, anulada_en FROM combustible_lecturas
       WHERE id = $1 AND tenant_id = $2`,
      [lecturaId, tenantId]
    );
    return result.rows[0] ?? null;
  }

  /** Registra una lectura histórica. Nada más: el nivel del tanque sale de
   *  la última lectura vigente al leerlo (migración 0059), así que insertar
   *  la fila ES actualizar el nivel.
   *
   *  Antes había acá un UPDATE condicional sobre `combustible.nivel_actual`
   *  (`WHERE fecha_actualizacion < <leido_en>`) para que dos lecturas
   *  offline llegando desordenadas no se pisaran. Esa protección sigue
   *  existiendo, pero ahora es estructural en vez de defensiva: el ORDER BY
   *  del LATERAL JOIN elige la más reciente sin importar en qué orden se
   *  hayan insertado. Y de paso desaparecen los tres casos en que aquel
   *  UPDATE fallaba en silencio -- ver el comentario largo de 0059.
   *
   *  Lanza si `combustibleId` no existe en este tenant -- el controller lo
   *  distingue de un 500 genérico (mismo patrón que
   *  `IpercController.crear` con `linea_base_item_id`). */
  async registrarLectura(
    client: PoolClient,
    tenantId: string,
    data: {
      combustibleId: number;
      nivel: number;
      leidoEn: string;
      usuarioId: string | null;
      metadata: Record<string, unknown>;
    }
  ) {
    const tanqueExiste = await client.query<{ id: number; capacidad_total: string }>(
      `SELECT id, capacidad_total FROM combustible WHERE id = $1 AND tenant_id = $2`,
      [data.combustibleId, tenantId]
    );
    if (tanqueExiste.rows.length === 0) {
      throw new Error(`combustible_id ${data.combustibleId} no existe en este tenant`);
    }

    // Un tanque no puede contener más de lo que le entra: el dato se
    // contradice a sí mismo, no depende de ninguna otra lectura para saber
    // que está mal. Por eso BLOQUEA, a diferencia de un salto grande pero
    // posible (que solo se confirma en pantalla) -- ver el punto 5 de
    // docs/architecture/control-de-combustible.md.
    //
    // Va acá y no en el schema Zod porque el techo es dato del tanque, no
    // una constante: Zod valida la forma del body, no puede consultar la
    // capacidad. Y va en el repository y no solo en el cliente porque la
    // cola offline y cualquier llamada directa a la API tienen que chocar
    // con la misma pared.
    const capacidad = Number(tanqueExiste.rows[0].capacidad_total);
    if (data.nivel > capacidad) {
      throw new Error(`nivel ${data.nivel} supera la capacidad del tanque (${capacidad})`);
    }

    const lectura = await client.query(
      `
      INSERT INTO combustible_lecturas
        (tenant_id, combustible_id, nivel, leido_en, usuario_id, metadata)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, combustible_id, nivel, leido_en, usuario_id, origen, metadata, creado_en,
                -- Lo leído en cada surtidor se inserta después (0098); el
                -- servicio relee la varilla para devolverlo.
                NULL::numeric AS totalizador_lectura
    `,
      [
        tenantId,
        data.combustibleId,
        data.nivel,
        data.leidoEn,
        data.usuarioId,
        JSON.stringify(data.metadata),
      ]
    );

    const tanque = await this.findById(client, tenantId, data.combustibleId);
    return { lectura: lectura.rows[0], tanque };
  }

  /** Para el reintento de una lectura ya creada (mismo cliente_uuid) --
   *  responde igual que la primera vez, sin volver a tocar `combustible`. */
  async findLecturaConTanque(client: PoolClient, tenantId: string, lecturaId: number) {
    const lectura = await client.query(
      `SELECT l.id, l.combustible_id, l.nivel, l.leido_en, l.usuario_id, l.origen, l.metadata,
              l.creado_en,
              (SELECT CASE WHEN count(*) = 1 THEN max(lt.valor) END
                 FROM combustible_lectura_totalizadores lt WHERE lt.lectura_id = l.id)
                AS totalizador_lectura
       FROM combustible_lecturas l
       WHERE l.id = $1 AND l.tenant_id = $2`,
      [lecturaId, tenantId]
    );
    if (lectura.rows.length === 0) return null;

    const tanque = await this.findById(client, tenantId, lectura.rows[0].combustible_id);
    return { lectura: lectura.rows[0], tanque };
  }

  // ── Despachos (Fase B, ver docs/architecture/control-de-combustible.md
  // puntos 1, 2 y 5, y migrations/0062) ──────────────────────────────────

  // costo_total NUNCA se persiste (migrations/0063) -- se calcula acá, igual
  // que `porcentaje` en COLUMNAS_TANQUE, para que nunca pueda desincronizarse
  // de cantidad/costo_unitario.
  private static readonly COLUMNAS_DESPACHO = `
    id, tenant_id, producto, origen, combustible_id, grifo_id, tipo_combustible,
    tipo_destino, equipo_id, serie_talonario, n_vale, cantidad,
    lectura_contometro, totalizador_lectura, surtidor_id, lectura_horometro, lectura_odometro,
    horas_abastecidas,
    presentacion, factor_litros, cantidad_bultos,
    costo_unitario, (cantidad * costo_unitario) AS costo_total, observaciones,
    usuario_id, despachado_en, creado_en,
    conductor_nombre, conductor_dni,
    anulada_en, anulada_por, motivo_anulacion
  `;

  /** Inserta un despacho. La unicidad de (tenant_id, serie_talonario,
   *  n_vale) la impone el constraint de 0062 -- acá se traduce la
   *  violación (23505) a un mensaje que el controller reconoce para
   *  responder 409, en vez de dejar pasar el error crudo de Postgres.
   *
   *  Las reglas de forma por origen/destino ya las validó el schema Zod
   *  (mensaje legible, antes de tocar la base); los CHECK de 0062 son la
   *  red de seguridad para cualquier insert que no pase por ahí. Lo que
   *  este método SÍ valida (porque necesita datos que Zod no tiene: la
   *  fila del tanque, la fila del equipo) va en combustible.service.ts. */
  async crearDespacho(
    client: PoolClient,
    tenantId: string,
    usuarioId: string | null,
    data: {
      producto: string;
      origen: string;
      combustibleId: number | null;
      grifoId: number | null;
      tipoCombustible: string | null;
      tipoDestino: string;
      equipoId: number | null;
      serieTalonario: string;
      nVale: number;
      cantidad: number;
      lecturaContometro: number | null;
      totalizadorLectura?: number | null;
      /** 0098: de qué surtidor salió. NULL = el único del tanque (la base lo
       *  asigna, y rechaza si hay más de uno). */
      surtidorId?: number | null;
      lecturaHorometro: number | null;
      lecturaOdometro: number | null;
      horasAbastecidas: number | null;
      presentacion: string | null;
      factorLitros: number | null;
      cantidadBultos: number | null;
      costoUnitario: number;
      observaciones: string | null;
      despachadoEn: string;
    }
  ) {
    try {
      // El totalizador_actual del SURTIDOR es el máximo de sus puntos
      // vigentes. Se bloquea el surtidor ANTES de insertar para que dos vales
      // simultáneos no se pisen recalculando cada uno sin ver al otro.
      if (data.totalizadorLectura != null && data.surtidorId != null) {
        await this.bloquearSurtidor(client, tenantId, data.surtidorId);
      }
      const result = await client.query(
        `
        INSERT INTO combustible_despachos (
          tenant_id, producto, origen, combustible_id, grifo_id, tipo_combustible,
          tipo_destino, equipo_id, serie_talonario, n_vale, cantidad,
          lectura_contometro, lectura_horometro, lectura_odometro, horas_abastecidas,
          presentacion, factor_litros, cantidad_bultos,
          costo_unitario, observaciones, usuario_id, despachado_en,
          conductor_nombre, conductor_dni, totalizador_lectura, surtidor_id
        )
        -- El conductor se COPIA del equipo en este mismo INSERT (0083). Nadie
        -- lo tipea, y no se resuelve después con un JOIN a propósito: los
        -- conductores rotan, y un JOIN devolvería el chofer de HOY para un
        -- vale de hace tres meses. El vale guarda quién manejaba cuando el
        -- combustible salió, que es lo único que hace confiable el reporte de
        -- consumo por conductor. Vale también para urea -- mismo equipo_id.
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
               e.conductor_nombre, e.conductor_dni, $23::numeric, $24::int
          FROM (SELECT 1) dummy
          LEFT JOIN equipos e ON e.id = $8::int AND e.tenant_id = $1
        RETURNING ${CombustibleRepository.COLUMNAS_DESPACHO}
        `,
        [
          tenantId,
          data.producto,
          data.origen,
          data.combustibleId,
          data.grifoId,
          data.tipoCombustible,
          data.tipoDestino,
          data.equipoId,
          data.serieTalonario,
          data.nVale,
          data.cantidad,
          data.lecturaContometro,
          data.lecturaHorometro,
          data.lecturaOdometro,
          data.horasAbastecidas,
          data.presentacion,
          data.factorLitros,
          data.cantidadBultos,
          data.costoUnitario,
          data.observaciones,
          usuarioId,
          data.despachadoEn,
          data.totalizadorLectura ?? null,
          data.surtidorId ?? null,
        ]
      );
      const fila = result.rows[0];
      if (data.totalizadorLectura != null && fila.surtidor_id != null) {
        await this.recalcularTotalizadorActual(client, tenantId, Number(fila.surtidor_id));
      }
      return fila;
    } catch (err) {
      if (esViolacionUnicidad(err)) {
        throw new Error(
          `el vale ${data.nVale} de la serie ${data.serieTalonario} ya está registrado`,
          { cause: err }
        );
      }
      // combustible_id (tanque), equipo_id o grifo_id apuntan a una fila
      // que no existe en este tenant -- el nombre del constraint (Postgres
      // lo arma solo, `<tabla>_<columna>_fkey`) dice cuál de las tres FK fue.
      if (esViolacionForeignKey(err)) {
        const constraint = (err as { constraint?: string }).constraint ?? "";
        if (constraint.includes("combustible_id")) {
          throw new Error(`combustible_id ${data.combustibleId} no existe en este tenant`, {
            cause: err,
          });
        }
        if (constraint.includes("equipo_id")) {
          throw new Error(`equipo_id ${data.equipoId} no existe en este tenant`, { cause: err });
        }
        if (constraint.includes("grifo_id")) {
          throw new Error(`el proveedor ${data.grifoId} no existe en este tenant`, { cause: err });
        }
      }
      throw err;
    }
  }

  /** Chequeo barato ANTES de validar la forma del despacho -- si el vale ya
   *  existe, eso tiene que ganarle a cualquier otro 400 (contómetro,
   *  medidor): "ya está registrado" es una señal más fuerte que un dato
   *  raro en el reintento, y es la misma que el grifero necesita ver para
   *  entender que esto fue un doble tipeo, no un error de forma.
   *
   *  Solo cuentan los VIGENTES (migración 0067): un vale anulado dejó libre
   *  su número para que el mismo papel se pueda volver a cargar con el dato
   *  corregido. Espejo exacto del índice único parcial. */
  async existeVale(
    client: PoolClient,
    tenantId: string,
    producto: string,
    serieTalonario: string,
    nVale: number
  ): Promise<boolean> {
    const result = await client.query(
      `SELECT 1 FROM combustible_despachos
       WHERE tenant_id = $1 AND producto = $2 AND serie_talonario = $3 AND n_vale = $4
         AND anulada_en IS NULL`,
      [tenantId, producto, serieTalonario, nVale]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async findDespachoPorId(client: PoolClient, tenantId: string, id: number) {
    const result = await client.query(
      `SELECT ${CombustibleRepository.COLUMNAS_DESPACHO}
       FROM combustible_despachos WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );
    return result.rows[0] ?? null;
  }

  async findDespachos(
    client: PoolClient,
    tenantId: string,
    filtros: {
      equipoId?: number;
      serieTalonario?: string;
      origen?: string;
      producto?: string;
    } & PeriodoHistorial,
    { pageSize, offset }: Paginacion,
    ambito?: AmbitoVales
  ) {
    const condiciones: string[] = ["tenant_id = $1"];
    const valores: unknown[] = [tenantId];

    if (filtros.equipoId !== undefined) {
      valores.push(filtros.equipoId);
      condiciones.push(`equipo_id = $${valores.length}`);
    }
    if (filtros.serieTalonario !== undefined) {
      valores.push(filtros.serieTalonario);
      condiciones.push(`serie_talonario = $${valores.length}`);
    }
    if (filtros.origen !== undefined) {
      valores.push(filtros.origen);
      condiciones.push(`origen = $${valores.length}`);
    }
    if (filtros.producto !== undefined) {
      valores.push(filtros.producto);
      condiciones.push(`producto = $${valores.length}`);
    }
    agregarPeriodo(condiciones, valores, "despachado_en", filtros);
    agregarAmbitoVales(condiciones, valores, "combustible_despachos", ambito);

    valores.push(pageSize, offset);
    const result = await client.query(
      `
      SELECT ${CombustibleRepository.COLUMNAS_DESPACHO}, COUNT(*) OVER() AS total_count
      FROM combustible_despachos
      WHERE ${condiciones.join(" AND ")}
      ORDER BY despachado_en DESC, id DESC
      LIMIT $${valores.length - 1} OFFSET $${valores.length}
      `,
      valores
    );
    return result.rows;
  }

  /** Con qué granularidad se agrupa un ranking del Histórico -- undefined
   *  es "todo el período junto" (una fila por entidad), como era antes de
   *  esto. El mapeo a la unidad real de `date_trunc` vive en un
   *  allowlist fijo (TRUNC_SQL) precisamente para que este valor, que SÍ
   *  llega del query string, jamás se concatene crudo en el SQL. */
  private static readonly TRUNC_SQL: Record<string, string> = {
    dia: "day",
    semana: "week",
    mes: "month",
    anio: "year",
  };

  /** Consumo agregado por conductor, para la pestaña que el cliente mira
   *  (no el kardex del auditor). Agrupa por el par (conductor_nombre,
   *  conductor_dni) -- el DNI separa a dos conductores con el mismo nombre,
   *  y el nombre solo cubre al caso real de que el DNI no se haya cargado.
   *
   *  Usa la COPIA que el vale guarda de 0083, no un JOIN al equipo: el
   *  objetivo es "cuánto cargó Juan", y un JOIN devolvería el conductor DE
   *  HOY para un vale de hace meses (ver la migración).
   *
   *  Sin paginar a propósito, igual que /despachos/huecos y los reportes de
   *  gerencia: es un ranking chico (un conductor por fila -- o por
   *  conductor y período, si se agrupa), no un listado que crezca sin
   *  límite. Despachos sin conductor (a planta, por ejemplo) quedan
   *  afuera: no hay a quién atribuírselos. */
  async findConsumoPorConductor(
    client: PoolClient,
    tenantId: string,
    producto: string,
    periodo: PeriodoHistorial,
    agruparPor?: string,
    ambito?: AmbitoVales
  ) {
    const condiciones: string[] = [
      "d.tenant_id = $1",
      "d.producto = $2",
      "d.anulada_en IS NULL",
      "d.conductor_nombre IS NOT NULL",
    ];
    const valores: unknown[] = [tenantId, producto];
    agregarPeriodo(condiciones, valores, "d.despachado_en", periodo);
    agregarAmbitoVales(condiciones, valores, "d", ambito);

    const trunc = agruparPor ? CombustibleRepository.TRUNC_SQL[agruparPor] : undefined;
    const columnaPeriodo = trunc ? `date_trunc('${trunc}', d.despachado_en) AS periodo,` : "";
    const groupByPeriodo = trunc ? ", periodo" : "";
    const orderByPeriodo = trunc ? "periodo ASC, " : "";

    const result = await client.query(
      `
      SELECT
        ${columnaPeriodo}
        d.conductor_nombre, d.conductor_dni,
        COUNT(*) AS cantidad_vales,
        SUM(d.cantidad) AS total_cantidad,
        ${sumaLitros("c")} AS total_litros,
        ${sumaLitros("c")} / 3.785411784 AS total_galones,
        SUM(d.cantidad * d.costo_unitario) AS total_costo,
        MIN(d.despachado_en) AS primer_despacho,
        MAX(d.despachado_en) AS ultimo_despacho
      FROM combustible_despachos d
      LEFT JOIN combustible c ON c.id = d.combustible_id AND c.tenant_id = d.tenant_id
      WHERE ${condiciones.join(" AND ")}
      GROUP BY d.conductor_nombre, d.conductor_dni${groupByPeriodo}
      ORDER BY ${orderByPeriodo}total_cantidad DESC
      `,
      valores
    );
    return result.rows;
  }

  /** Consumo agregado por vehículo/equipo -- el ranking que pidió el
   *  cliente. JOIN a equipos por la placa y el tipo VIGENTES: acá sí
   *  conviene el dato de hoy (a diferencia del conductor, la placa de un
   *  equipo no rota entre vales). Un equipo dado de baja igual aparece si
   *  tiene despachos en el período -- LEFT JOIN, no INNER. */
  async findConsumoPorEquipo(
    client: PoolClient,
    tenantId: string,
    producto: string,
    periodo: PeriodoHistorial,
    agruparPor?: string,
    ambito?: AmbitoVales
  ) {
    const condiciones: string[] = [
      "d.tenant_id = $1",
      "d.producto = $2",
      "d.anulada_en IS NULL",
      "d.equipo_id IS NOT NULL",
    ];
    const valores: unknown[] = [tenantId, producto];
    agregarPeriodo(condiciones, valores, "d.despachado_en", periodo);
    agregarAmbitoVales(condiciones, valores, "d", ambito);

    const trunc = agruparPor ? CombustibleRepository.TRUNC_SQL[agruparPor] : undefined;
    const columnaPeriodo = trunc ? `date_trunc('${trunc}', d.despachado_en) AS periodo,` : "";
    const groupByPeriodo = trunc ? ", periodo" : "";
    const orderByPeriodo = trunc ? "periodo ASC, " : "";

    const result = await client.query(
      `
      SELECT
        ${columnaPeriodo}
        d.equipo_id,
        e.placa_codigo,
        e.tipo AS equipo_tipo,
        COUNT(*) AS cantidad_vales,
        SUM(d.cantidad) AS total_cantidad,
        ${sumaLitros("c")} AS total_litros,
        ${sumaLitros("c")} / 3.785411784 AS total_galones,
        SUM(d.cantidad * d.costo_unitario) AS total_costo,
        MIN(d.despachado_en) AS primer_despacho,
        MAX(d.despachado_en) AS ultimo_despacho
      FROM combustible_despachos d
      LEFT JOIN equipos e ON e.id = d.equipo_id AND e.tenant_id = d.tenant_id
      LEFT JOIN combustible c ON c.id = d.combustible_id AND c.tenant_id = d.tenant_id
      WHERE ${condiciones.join(" AND ")}
      GROUP BY d.equipo_id, e.placa_codigo, e.tipo${groupByPeriodo}
      ORDER BY ${orderByPeriodo}total_cantidad DESC
      `,
      valores
    );
    return result.rows;
  }

  /** Consumo agregado por grifo -- la tercera pata del ranking, la que
   *  contesta "¿de dónde sale el combustible?" y de paso arma la
   *  conciliación interno vs externo que pidió Kenif: sumar las filas con
   *  `tipo_grifo = 'interno'` da lo mismo que /despachos filtrado por
   *  tanque_propio, y las de `'externo'` lo mismo que /despachos filtrado
   *  por compra_externa -- ya viene sumado acá, sin tener que ir vale por
   *  vale.
   *
   *  Un despacho de tanque propio NO tiene grifo_id (sale del tanque, no
   *  de un proveedor externo) -- por eso el JOIN a combustible_grifos es
   *  condicional al origen, y el "grifo" en ese caso es el TANQUE mismo
   *  (para distinguir Santa Isabel de otro tanque, si el tenant tiene más
   *  de uno). */
  async findConsumoPorGrifo(
    client: PoolClient,
    tenantId: string,
    producto: string,
    periodo: PeriodoHistorial,
    agruparPor?: string,
    ambito?: AmbitoVales
  ) {
    const condiciones: string[] = ["d.tenant_id = $1", "d.producto = $2", "d.anulada_en IS NULL"];
    const valores: unknown[] = [tenantId, producto];
    agregarPeriodo(condiciones, valores, "d.despachado_en", periodo);
    agregarAmbitoVales(condiciones, valores, "d", ambito);

    const trunc = agruparPor ? CombustibleRepository.TRUNC_SQL[agruparPor] : undefined;
    const columnaPeriodo = trunc ? `date_trunc('${trunc}', d.despachado_en) AS periodo,` : "";
    const groupByPeriodo = trunc ? ", periodo" : "";
    const orderByPeriodo = trunc ? "periodo ASC, " : "";

    const result = await client.query(
      `
      SELECT
        ${columnaPeriodo}
        d.origen,
        CASE WHEN d.origen = 'tanque_propio' THEN 'interno' ELSE 'externo' END AS tipo_grifo,
        COALESCE(t.tanque_nombre, g.nombre, 'Sin identificar') AS grifo_nombre,
        -- El grifo interno del vale (0097), para desglosar lo interno por
        -- planta. NULL en las compras externas.
        CASE WHEN d.origen = 'tanque_propio' THEN gi.nombre END AS grifo_interno,
        COUNT(*) AS cantidad_vales,
        SUM(d.cantidad) AS total_cantidad,
        ${sumaLitros("t")} AS total_litros,
        ${sumaLitros("t")} / 3.785411784 AS total_galones,
        SUM(d.cantidad * d.costo_unitario) AS total_costo,
        MIN(d.despachado_en) AS primer_despacho,
        MAX(d.despachado_en) AS ultimo_despacho
      FROM combustible_despachos d
      LEFT JOIN combustible t ON t.id = d.combustible_id AND t.tenant_id = d.tenant_id
      LEFT JOIN combustible_grifos g ON g.id = d.grifo_id AND g.tenant_id = d.tenant_id
      LEFT JOIN grifos_internos gi ON gi.id = d.grifo_interno_id AND gi.tenant_id = d.tenant_id
      WHERE ${condiciones.join(" AND ")}
      GROUP BY d.origen, tipo_grifo, grifo_nombre, grifo_interno${groupByPeriodo}
      ORDER BY ${orderByPeriodo}total_cantidad DESC
      `,
      valores
    );
    return result.rows;
  }

  /** Anula un despacho -- el punto 3 del documento, la "válvula de escape"
   *  para un vale roto o mal tipeado. Mismo mecanismo que anularLectura y
   *  anularPrecio: `anulada_en IS NULL` en el WHERE para que dos anulaciones
   *  simultáneas no terminen las dos en 200 pisando el motivo original (ver
   *  fix_race_condition_iperc_estado).
   *
   *  A diferencia de anularRecepcion, acá NO hay nada que recalcular: un
   *  despacho no alimenta ningún valor derivado del tanque (el nivel sale de
   *  las lecturas, el costo promedio de las recepciones). Lo único que cambia
   *  es que este vale deja de contar para la conciliación -- y eso pasa solo,
   *  porque esas consultas filtran por `anulada_en IS NULL`. */
  async anularDespacho(
    client: PoolClient,
    tenantId: string,
    despachoId: number,
    usuarioId: string,
    motivo: string
  ) {
    const result = await client.query(
      `
      UPDATE combustible_despachos
      SET anulada_en = now(), anulada_por = $1, motivo_anulacion = $2
      WHERE id = $3 AND tenant_id = $4 AND anulada_en IS NULL
      RETURNING ${CombustibleRepository.COLUMNAS_DESPACHO}
      `,
      [usuarioId, motivo, despachoId, tenantId]
    );
    const anulado = result.rows[0] ?? null;
    if (anulado?.totalizador_lectura != null && anulado.surtidor_id != null) {
      await this.bloquearSurtidor(client, tenantId, Number(anulado.surtidor_id));
      await this.recalcularTotalizadorActual(client, tenantId, Number(anulado.surtidor_id));
    }
    return anulado;
  }

  /** Serializa los cambios de la cadena de un surtidor: dos vales o varillas
   *  simultáneos no pueden recalcular el máximo sin verse. */
  async bloquearSurtidor(client: PoolClient, tenantId: string, surtidorId: number) {
    await client.query(`SELECT id FROM surtidores WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [
      surtidorId,
      tenantId,
    ]);
  }

  /** `surtidores.totalizador_actual` = el MAYOR totalizador entre los puntos
   *  vigentes del surtidor -- sus vales y lo que leyeron de él las varillas
   *  (0098) -- o 0 si no hay ninguno. Se recalcula, no se acumula: anular el
   *  último punto tiene que devolverlo al anterior. El llamador ya bloqueó la
   *  fila del surtidor. */
  async recalcularTotalizadorActual(client: PoolClient, tenantId: string, surtidorId: number) {
    await client.query(
      `UPDATE surtidores s
          SET totalizador_actual = COALESCE((
                SELECT MAX(t) FROM (
                  SELECT d.totalizador_lectura AS t FROM combustible_despachos d
                   WHERE d.tenant_id = $1 AND d.surtidor_id = s.id
                     AND d.anulada_en IS NULL AND d.totalizador_lectura IS NOT NULL
                  UNION ALL
                  SELECT lt.valor FROM combustible_lectura_totalizadores lt
                    JOIN combustible_lecturas l ON l.id = lt.lectura_id AND l.tenant_id = $1
                   WHERE lt.tenant_id = $1 AND lt.surtidor_id = s.id AND l.anulada_en IS NULL
                ) puntos
              ), 0)
        WHERE s.id = $2 AND s.tenant_id = $1`,
      [tenantId, surtidorId]
    );
  }

  /** Lo que la varilla leyó en cada surtidor (0098). Bloquea cada surtidor y
   *  recalcula su máximo: la varilla es un punto de su cadena. */
  async insertarTotalizadoresDeLectura(
    client: PoolClient,
    tenantId: string,
    lecturaId: number,
    filas: { surtidorId: number; valor: number }[]
  ) {
    for (const f of [...filas].sort((a, b) => a.surtidorId - b.surtidorId)) {
      await this.bloquearSurtidor(client, tenantId, f.surtidorId);
      await client.query(
        `INSERT INTO combustible_lectura_totalizadores (tenant_id, lectura_id, surtidor_id, valor)
         VALUES ($1, $2, $3, $4)`,
        [tenantId, lecturaId, f.surtidorId, f.valor]
      );
      await this.recalcularTotalizadorActual(client, tenantId, f.surtidorId);
    }
  }

  /** Lo que leyó una varilla, surtidor por surtidor. */
  async findTotalizadoresDeLectura(client: PoolClient, tenantId: string, lecturaId: number) {
    const r = await client.query<{ surtidor_id: number; valor: string }>(
      `SELECT surtidor_id, valor FROM combustible_lectura_totalizadores
        WHERE lectura_id = $1 AND tenant_id = $2 ORDER BY surtidor_id`,
      [lecturaId, tenantId]
    );
    return r.rows.map((f) => ({ surtidorId: f.surtidor_id, valor: Number(f.valor) }));
  }

  /** Los surtidores que alimentaban un tanque EN UN INSTANTE (la conexión
   *  tiene historia, 0098), con su configuración y si eran compartidos. Es lo
   *  que decide qué exige un vale o una varilla cargados sin red que llegan
   *  tarde. `alguna_vez` dice si el tanque tuvo alguna conexión en su vida:
   *  sin ninguna, la base le crea su surtidor al primer vale. */
  async findSurtidoresDelTanqueEn(
    client: PoolClient,
    tenantId: string,
    combustibleId: number,
    instante: string
  ) {
    const r = await client.query<{
      id: number;
      nombre: string;
      activo: boolean;
      usa_totalizador: boolean;
      totalizador_tolerancia: string;
      compartido: boolean;
    }>(
      `SELECT s.id, s.nombre, s.activo, s.usa_totalizador, s.totalizador_tolerancia,
              EXISTS (
                SELECT 1 FROM surtidor_tanques otro
                 WHERE otro.surtidor_id = s.id AND otro.combustible_id <> $2
                   AND otro.conectado_en <= $3::timestamptz
                   AND (otro.desconectado_en IS NULL OR otro.desconectado_en > $3::timestamptz)
              ) AS compartido
         FROM surtidores s
        WHERE s.tenant_id = $1
          AND s.id IN (SELECT surtidores_del_tanque_en($2, $3::timestamptz))
        ORDER BY lower(s.nombre)`,
      [tenantId, combustibleId, instante]
    );
    const alguna = await client.query<{ hay: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM surtidor_tanques WHERE combustible_id = $1 AND tenant_id = $2)
         AS hay`,
      [combustibleId, tenantId]
    );
    return { surtidores: r.rows, algunaVez: alguna.rows[0].hay };
  }

  async findSurtidorPorId(client: PoolClient, tenantId: string, surtidorId: number) {
    const r = await client.query<{
      id: number;
      nombre: string;
      activo: boolean;
      usa_totalizador: boolean;
      totalizador_tolerancia: string;
      grifo_interno_id: number;
    }>(
      `SELECT id, nombre, activo, usa_totalizador, totalizador_tolerancia, grifo_interno_id
         FROM surtidores WHERE id = $1 AND tenant_id = $2`,
      [surtidorId, tenantId]
    );
    return r.rows[0] ?? null;
  }

  /** El surtidor que la base le creó (o le va a crear) a un tanque. Lo usa el
   *  alta de tanque: el surtidor se crea explícito, no por trigger de alta,
   *  porque restaurar un backup lo duplicaría. */
  async crearSurtidorDelTanque(
    client: PoolClient,
    combustibleId: number,
    usaTotalizador = false,
    tolerancia = 1
  ) {
    const r = await client.query<{ id: number }>(
      `SELECT crear_surtidor_del_tanque($1, $2, $3) AS id`,
      [combustibleId, usaTotalizador, tolerancia]
    );
    return r.rows[0].id;
  }

  /** Los vecinos de un punto de la cadena por VALOR de totalizador, no por
   *  hora: un vale offline que llega tarde se ubica donde le toca. Los puntos
   *  son los vales vigentes Y las varillas vigentes con totalizador (0096).
   *  `excluir` es el propio punto, que ya está insertado. Devuelve:
   *  - `anterior`: el punto vigente con el mayor totalizador <= al de este;
   *  - `retrocede`: algún punto vigente, anterior o igual en el tiempo, con un
   *    totalizador MAYOR (el medidor "volvió atrás"). */
  async findVecinosTotalizador(
    client: PoolClient,
    tenantId: string,
    surtidorId: number,
    excluir: { tipo: "despacho" | "lectura"; id: number },
    totalizador: number,
    instante: string
  ) {
    const r = await client.query<{
      anterior_id: string | null;
      anterior_totalizador: string | null;
      retroceso_id: string | null;
      retroceso_totalizador: string | null;
    }>(
      `
      -- La cadena es del SURTIDOR (0098): dos surtidores del mismo tanque
      -- tienen contadores distintos y no se comparan entre sí.
      WITH puntos AS (
        SELECT 'despacho' AS tipo, d.id, d.totalizador_lectura AS t, d.despachado_en AS en
          FROM combustible_despachos d
         WHERE d.tenant_id = $1 AND d.surtidor_id = $2
           AND d.anulada_en IS NULL AND d.totalizador_lectura IS NOT NULL
        UNION ALL
        SELECT 'lectura', l.id, lt.valor, l.leido_en
          FROM combustible_lectura_totalizadores lt
          JOIN combustible_lecturas l ON l.id = lt.lectura_id AND l.tenant_id = $1
         WHERE lt.tenant_id = $1 AND lt.surtidor_id = $2 AND l.anulada_en IS NULL
      ),
      otros AS (
        SELECT * FROM puntos WHERE NOT (tipo = $3 AND id = $4::bigint)
      ),
      anterior AS (
        SELECT id, t FROM otros WHERE t <= $5::numeric ORDER BY t DESC, en DESC LIMIT 1
      ),
      retroceso AS (
        SELECT id, t FROM otros
         WHERE t > $5::numeric AND en <= $6::timestamptz
         ORDER BY t DESC LIMIT 1
      )
      SELECT (SELECT id FROM anterior) AS anterior_id,
             (SELECT t FROM anterior) AS anterior_totalizador,
             (SELECT id FROM retroceso) AS retroceso_id,
             (SELECT t FROM retroceso) AS retroceso_totalizador
      `,
      [tenantId, surtidorId, excluir.tipo, excluir.id, totalizador, instante]
    );
    return r.rows[0];
  }

  /** Punto 1 reescrito: consulta bajo demanda, no persiste nada -- no hay
   *  período abierto/cerrado ni `combustible_anomalias` acá (eso es la
   *  "maquinaria de conciliación" del punto 4, Fase D). Si no hay ningún
   *  vale en esa serie, MIN/MAX dan NULL -- se corta antes de llamar
   *  generate_series(), que revienta con límites NULL.
   *
   *  **Un vale ANULADO cuenta como rendido, no como hueco** (migración
   *  0067): el NOT EXISTS de abajo pregunta si existe la fila, sin mirar su
   *  estado. Es la válvula de escape del punto 3 -- si el vale roto siguiera
   *  contando como hueco, la anulación no serviría de nada y volveríamos al
   *  caso de Juan inventando un despacho para que la secuencia cierre. */
  async findHuecosTalonario(
    client: PoolClient,
    tenantId: string,
    producto: string,
    serieTalonario: string
  ) {
    const limites = await client.query<{ minimo: number | null; maximo: number | null }>(
      `SELECT MIN(n_vale) AS minimo, MAX(n_vale) AS maximo
       FROM combustible_despachos WHERE tenant_id = $1 AND producto = $2 AND serie_talonario = $3`,
      [tenantId, producto, serieTalonario]
    );
    const { minimo, maximo } = limites.rows[0];
    if (minimo === null || maximo === null) {
      return { serie: serieTalonario, huecos: [] as number[], ultimo: null as number | null };
    }

    const huecos = await client.query<{ n_vale: number }>(
      `
      SELECT gs AS n_vale
      FROM generate_series($4::int, $5::int) AS gs
      WHERE NOT EXISTS (
        SELECT 1 FROM combustible_despachos d
        WHERE d.tenant_id = $1 AND d.producto = $2 AND d.serie_talonario = $3 AND d.n_vale = gs
      )
      ORDER BY gs
      `,
      [tenantId, producto, serieTalonario, minimo, maximo]
    );

    return {
      serie: serieTalonario,
      huecos: huecos.rows.map((f) => f.n_vale),
      ultimo: maximo,
    };
  }

  // ── Alertas (migrations/0068) ──────────────────────────────────────────
  // Gerencia (rol admin) se entera al momento de un hueco o una anulación,
  // sin esperar a que alguien note el hueco ni al cierre de período (Fase D
  // entrega 2, que sigue aparte). Ver el encabezado de la migración.

  /** El momento exacto en que un hueco se puede probar: cuando aparece un
   *  vale más allá de él -- antes de eso el número todavía podría estar
   *  "por venir". `maxAnterior` es el mayor n_vale de esa serie ANTES de
   *  este despacho (excluyendo la fila nueva); si el nuevo vale lo supera
   *  en más de 1, todo lo que quedó en el medio es un hueco recién
   *  revelado. No hace falta NOT EXISTS: la propia definición de MAX ya
   *  garantiza que esos números no tienen fila todavía. */
  async detectarHuecosRevelados(
    client: PoolClient,
    tenantId: string,
    producto: string,
    serieTalonario: string,
    despachoId: number,
    nuevoNVale: number
  ): Promise<number[]> {
    const result = await client.query<{ max_anterior: number | null }>(
      `SELECT MAX(n_vale) AS max_anterior
       FROM combustible_despachos
       WHERE tenant_id = $1 AND producto = $2 AND serie_talonario = $3 AND id <> $4`,
      [tenantId, producto, serieTalonario, despachoId]
    );
    const maxAnterior = result.rows[0]?.max_anterior;
    if (maxAnterior === null || maxAnterior === undefined || nuevoNVale <= maxAnterior + 1) {
      return [];
    }
    // TOPE DURO al tamaño del salto. El service ya rechaza los saltos
    // grandes (MAX_SALTO_TALONARIO), pero esto corre sobre datos, no sobre un
    // request: sin el tope, un salto de un vale a 2.000.000.000 --un dígito de
    // más al tipear-- arma acá un array de dos mil millones de elementos y
    // tumba el proceso entero, para todos los tenants. Verificado en la 5ª
    // auditoría: un vale con n=5001 generó 5.000 alertas de una sola carga.
    const revelados: number[] = [];
    for (let n = maxAnterior + 1; n < nuevoNVale && revelados.length < MAX_HUECOS_POR_VALE; n++) {
      revelados.push(n);
    }
    return revelados;
  }

  /** El mayor número cargado en esta serie, sin importar si está anulado (el
   *  papel existió igual). Lo usa el tope de salto del talonario. */
  async findMaxNValeDeSerie(
    client: PoolClient,
    tenantId: string,
    producto: string,
    serieTalonario: string
  ): Promise<number | null> {
    const r = await client.query<{ maximo: number | null }>(
      `SELECT MAX(n_vale) AS maximo FROM combustible_despachos
        WHERE tenant_id = $1 AND producto = $2 AND serie_talonario = $3`,
      [tenantId, producto, serieTalonario]
    );
    return r.rows[0]?.maximo ?? null;
  }

  /** ¿Este vale entró por DEBAJO del máximo de su serie? (migración 0077)
   *
   *  Complemento de `detectarHuecosRevelados`, que solo mira hacia adelante.
   *  Devuelve el máximo anterior cuando el vale nuevo queda por debajo, o
   *  null cuando la carga es normal (el vale sigue al máximo, o es el primero
   *  de la serie).
   *
   *  Mismo `id <> $3` de siempre: corre después del INSERT, así que sin
   *  excluir la fila recién creada se compararía contra sí misma. */
  async detectarValeFueraDeOrden(
    client: PoolClient,
    tenantId: string,
    producto: string,
    serieTalonario: string,
    despachoId: number,
    nuevoNVale: number
  ): Promise<number | null> {
    const result = await client.query<{ max_anterior: number | null }>(
      `SELECT MAX(n_vale) AS max_anterior
       FROM combustible_despachos
       WHERE tenant_id = $1 AND producto = $2 AND serie_talonario = $3 AND id <> $4`,
      [tenantId, producto, serieTalonario, despachoId]
    );
    const maxAnterior = result.rows[0]?.max_anterior;
    if (maxAnterior === null || maxAnterior === undefined) return null;
    return nuevoNVale < maxAnterior ? maxAnterior : null;
  }

  /** ¿Existió alguna vez una alerta de hueco por este número? Incluye las
   *  resueltas y las congeladas: lo que importa es que el sistema HABÍA
   *  reportado que faltaba, no en qué estado quedó esa alerta. */
  async existioHuecoPara(
    client: PoolClient,
    tenantId: string,
    producto: string,
    serieTalonario: string,
    nVale: number
  ): Promise<boolean> {
    const result = await client.query(
      `SELECT 1 FROM combustible_alertas
       WHERE tenant_id = $1 AND producto = $2 AND tipo = 'hueco_detectado'
         AND serie_talonario = $3 AND n_vale = $4
       LIMIT 1`,
      [tenantId, producto, serieTalonario, nVale]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** El vale tardío que llena un hueco ya alertado (típicamente porque
   *  sincronizó desde la cola offline) lo resuelve solo -- `resuelta_por`
   *  queda NULL porque lo resolvió el sistema, no una persona. Corre
   *  siempre, sin condicionar: si no había alerta abierta para ese número,
   *  el UPDATE simplemente no toca ninguna fila.
   *
   *  **`congelada_en IS NULL` en el WHERE** (migración 0072): si el hueco
   *  ya se congeló como anomalía, este vale NO lo resuelve. La anomalía es
   *  inmutable a propósito -- el hallazgo de que estuvo 72h sin explicarse
   *  ya ocurrió y no se borra porque el papel aparezca después. Devuelve
   *  si había una alerta congelada para ese número, que es lo que dispara
   *  la alerta `despacho_tardio` del punto 4 ("que alguien se acuerde de un
   *  vale dos días después es justo lo que se quiere ver"). */
  async resolverAlertaHuecoSiExiste(
    client: PoolClient,
    tenantId: string,
    producto: string,
    serieTalonario: string,
    nVale: number
  ): Promise<{ llegoTarde: boolean }> {
    await client.query(
      `UPDATE combustible_alertas
       SET resuelta_en = now()
       WHERE tenant_id = $1 AND producto = $2 AND tipo = 'hueco_detectado'
         AND serie_talonario = $3 AND n_vale = $4 AND resuelta_en IS NULL AND congelada_en IS NULL`,
      [tenantId, producto, serieTalonario, nVale]
    );

    const congelada = await client.query(
      `SELECT 1 FROM combustible_alertas
       WHERE tenant_id = $1 AND producto = $2 AND tipo = 'hueco_detectado'
         AND serie_talonario = $3 AND n_vale = $4 AND congelada_en IS NOT NULL
       LIMIT 1`,
      [tenantId, producto, serieTalonario, nVale]
    );
    return { llegoTarde: (congelada.rowCount ?? 0) > 0 };
  }

  // ── Conciliación (migraciones 0071/0072) ──────────────────────────────

  /** Un tenant sin fila en combustible_config usa el default de 72h -- por
   *  eso COALESCE y no un INSERT al dar de alta el tenant: así uno nuevo
   *  funciona sin que nadie se acuerde de sembrarle la config. */
  async getVentanaGraciaHoras(client: PoolClient, tenantId: string): Promise<number> {
    const result = await client.query<{ ventana_gracia_horas: number }>(
      `SELECT COALESCE(
         (SELECT ventana_gracia_horas FROM combustible_config WHERE tenant_id = $1),
         72
       ) AS ventana_gracia_horas`,
      [tenantId]
    );
    return Number(result.rows[0].ventana_gracia_horas);
  }

  /** Cada cuántos días la empresa exige que se tome varilla (migración
   *  0076). Mismo COALESCE que la ventana de gracia: el tenant que nunca
   *  tocó su configuración no tiene fila propia y usa el default. */
  async getDiasSinMedir(client: PoolClient, tenantId: string): Promise<number> {
    const result = await client.query<{ dias_sin_medir: number }>(
      `SELECT COALESCE(
         (SELECT dias_sin_medir FROM combustible_config WHERE tenant_id = $1),
         3
       ) AS dias_sin_medir`,
      [tenantId]
    );
    return Number(result.rows[0].dias_sin_medir);
  }

  /** Los dos techos diarios (migración 0079). SIN COALESCE, a diferencia de
   *  la ventana y los días sin medir: acá NULL no es "todavía no lo tocó",
   *  es el valor real y significa "sin configurar, no alerta". Inventarles
   *  un default sería inventar un límite operativo que nadie declaró. */
  async getTopesDiarios(client: PoolClient, tenantId: string) {
    const result = await client.query<{
      llenados_por_dia_max: string | null;
      tope_diario_sin_capacidad_l: string | null;
    }>(
      `SELECT llenados_por_dia_max, tope_diario_sin_capacidad_l
         FROM combustible_config WHERE tenant_id = $1`,
      [tenantId]
    );
    const fila = result.rows[0];
    return {
      llenadosPorDiaMax: fila?.llenados_por_dia_max ? Number(fila.llenados_por_dia_max) : null,
      topeSinCapacidadL: fila?.tope_diario_sin_capacidad_l
        ? Number(fila.tope_diario_sin_capacidad_l)
        : null,
    };
  }

  /** Cuántos días mira para atrás la ventana deslizante (0080). Mismo
   *  COALESCE que los otros dos: un tenant que nunca tocó su configuración
   *  no tiene fila propia y usa el default. */
  async getDiasVentanaDescuadre(client: PoolClient, tenantId: string): Promise<number> {
    const result = await client.query<{ dias_ventana_descuadre: number }>(
      `SELECT COALESCE(
         (SELECT dias_ventana_descuadre FROM combustible_config WHERE tenant_id = $1),
         30
       ) AS dias_ventana_descuadre`,
      [tenantId]
    );
    return Number(result.rows[0].dias_ventana_descuadre);
  }

  async getConfig(client: PoolClient, tenantId: string) {
    const ventana = await this.getVentanaGraciaHoras(client, tenantId);
    const diasSinMedir = await this.getDiasSinMedir(client, tenantId);
    const diasVentana = await this.getDiasVentanaDescuadre(client, tenantId);
    const diasCargaRetro = await this.getDiasCargaRetroactiva(client, tenantId);
    const diasSinVig = await this.getDiasSinVigilancia(client, tenantId);
    const topes = await this.getTopesDiarios(client, tenantId);
    const grifieroVarilla = await this.getGrifieroRegistraVarilla(client, tenantId);
    const result = await client.query(
      `SELECT actualizado_en, actualizado_por FROM combustible_config WHERE tenant_id = $1`,
      [tenantId]
    );
    const politica = await this.getPoliticaValidacionRecepcion(client, tenantId);
    const diasVarillaControl = await this.getDiasSinVarillaDeControl(client, tenantId);
    const topesUrea = await this.getTopesUrea(client, tenantId);
    return {
      recepcion_requiere_validacion: politica.requiere,
      horas_para_validar_recepcion: politica.horas,
      dias_sin_varilla_de_control: diasVarillaControl,
      ventana_gracia_horas: ventana,
      dias_sin_medir: diasSinMedir,
      dias_ventana_descuadre: diasVentana,
      dias_carga_retroactiva: diasCargaRetro,
      dias_sin_vigilancia: diasSinVig,
      llenados_por_dia_max: topes.llenadosPorDiaMax,
      tope_diario_sin_capacidad_l: topes.topeSinCapacidadL,
      grifero_registra_varilla: grifieroVarilla,
      tope_diario_urea_l: topesUrea.topeDiarioUreaL,
      ratio_urea_diesel_max_pct: topesUrea.ratioUreaDieselMaxPct,
      dias_sin_conteo_urea: topesUrea.diasSinConteoUrea,
      actualizado_en: result.rows[0]?.actualizado_en ?? null,
      actualizado_por: result.rows[0]?.actualizado_por ?? null,
    };
  }

  /** Los tres campos de urea de la config -- separados en su propia lectura
   *  igual que getTopesDiarios, mismo criterio: el default (72h, etc.) se
   *  resuelve acá con COALESCE, sin sembrar fila por tenant (ver 0071). */
  async getTopesUrea(client: PoolClient, tenantId: string) {
    const result = await client.query<{
      tope_diario_urea_l: string | null;
      ratio_urea_diesel_max_pct: string | null;
      dias_sin_conteo_urea: number;
    }>(
      `SELECT tope_diario_urea_l, ratio_urea_diesel_max_pct,
              COALESCE(dias_sin_conteo_urea, 30) AS dias_sin_conteo_urea
       FROM combustible_config WHERE tenant_id = $1`,
      [tenantId]
    );
    const fila = result.rows[0];
    return {
      topeDiarioUreaL: fila?.tope_diario_urea_l ? Number(fila.tope_diario_urea_l) : null,
      ratioUreaDieselMaxPct: fila?.ratio_urea_diesel_max_pct
        ? Number(fila.ratio_urea_diesel_max_pct)
        : null,
      diasSinConteoUrea: fila?.dias_sin_conteo_urea ?? 30,
    };
  }

  /** UPSERT: la primera vez que un admin toca la ventana se crea la fila.
   *  Antes de eso el tenant venía usando el default sin fila propia. */
  async guardarConfig(
    client: PoolClient,
    tenantId: string,
    valores: {
      ventanaGraciaHoras: number;
      diasSinMedir: number;
      diasVentanaDescuadre: number;
      diasCargaRetroactiva: number;
      diasSinVigilancia: number;
      llenadosPorDiaMax: number | null;
      topeSinCapacidadL: number | null;
      grifieroRegistraVarilla: boolean;
      recepcionRequiereValidacion: boolean;
      horasParaValidarRecepcion: number;
      diasSinVarillaDeControl: number | null;
      topeDiarioUreaL: number | null;
      ratioUreaDieselMaxPct: number | null;
      diasSinConteoUrea: number;
    },
    usuarioId: string
  ) {
    const result = await client.query(
      `
      INSERT INTO combustible_config
        (tenant_id, ventana_gracia_horas, dias_sin_medir, dias_ventana_descuadre,
         dias_carga_retroactiva, dias_sin_vigilancia, llenados_por_dia_max,
         tope_diario_sin_capacidad_l, grifero_registra_varilla, actualizado_por,
         recepcion_requiere_validacion, horas_para_validar_recepcion,
         dias_sin_varilla_de_control, tope_diario_urea_l, ratio_urea_diesel_max_pct,
         dias_sin_conteo_urea)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      ON CONFLICT (tenant_id) DO UPDATE
        SET ventana_gracia_horas = EXCLUDED.ventana_gracia_horas,
            dias_sin_medir = EXCLUDED.dias_sin_medir,
            dias_ventana_descuadre = EXCLUDED.dias_ventana_descuadre,
            dias_carga_retroactiva = EXCLUDED.dias_carga_retroactiva,
            dias_sin_vigilancia = EXCLUDED.dias_sin_vigilancia,
            llenados_por_dia_max = EXCLUDED.llenados_por_dia_max,
            tope_diario_sin_capacidad_l = EXCLUDED.tope_diario_sin_capacidad_l,
            grifero_registra_varilla = EXCLUDED.grifero_registra_varilla,
            recepcion_requiere_validacion = EXCLUDED.recepcion_requiere_validacion,
            horas_para_validar_recepcion = EXCLUDED.horas_para_validar_recepcion,
            dias_sin_varilla_de_control = EXCLUDED.dias_sin_varilla_de_control,
            tope_diario_urea_l = EXCLUDED.tope_diario_urea_l,
            ratio_urea_diesel_max_pct = EXCLUDED.ratio_urea_diesel_max_pct,
            dias_sin_conteo_urea = EXCLUDED.dias_sin_conteo_urea,
            actualizado_por = EXCLUDED.actualizado_por,
            actualizado_en = now()
      RETURNING ventana_gracia_horas, dias_sin_medir, dias_ventana_descuadre,
                dias_carga_retroactiva, dias_sin_vigilancia, llenados_por_dia_max,
                tope_diario_sin_capacidad_l, grifero_registra_varilla,
                recepcion_requiere_validacion, horas_para_validar_recepcion,
                dias_sin_varilla_de_control, tope_diario_urea_l,
                ratio_urea_diesel_max_pct, dias_sin_conteo_urea,
                actualizado_en, actualizado_por
      `,
      [
        tenantId,
        valores.ventanaGraciaHoras,
        valores.diasSinMedir,
        valores.diasVentanaDescuadre,
        valores.diasCargaRetroactiva,
        valores.diasSinVigilancia,
        valores.llenadosPorDiaMax,
        valores.topeSinCapacidadL,
        valores.grifieroRegistraVarilla,
        usuarioId,
        valores.recepcionRequiereValidacion,
        valores.horasParaValidarRecepcion,
        valores.diasSinVarillaDeControl,
        valores.topeDiarioUreaL,
        valores.ratioUreaDieselMaxPct,
        valores.diasSinConteoUrea,
      ]
    );
    const fila = result.rows[0];
    return {
      ...fila,
      // El driver devuelve NUMERIC como string; el resto de la respuesta de
      // config son números, y la pantalla los mete directo en un input.
      llenados_por_dia_max: fila.llenados_por_dia_max ? Number(fila.llenados_por_dia_max) : null,
      tope_diario_sin_capacidad_l: fila.tope_diario_sin_capacidad_l
        ? Number(fila.tope_diario_sin_capacidad_l)
        : null,
      tope_diario_urea_l: fila.tope_diario_urea_l ? Number(fila.tope_diario_urea_l) : null,
      ratio_urea_diesel_max_pct: fila.ratio_urea_diesel_max_pct
        ? Number(fila.ratio_urea_diesel_max_pct)
        : null,
    };
  }

  /** Las alertas que ya pasaron su ventana sin explicarse. Los tipos que
   *  se congelan son los FALTANTES -- lo que nadie pudo explicar:
   *  `hueco_detectado`, `sobredespacho`, `diferencia_recepcion`,
   *  `medidor_inconsistente` y `tope_diario_excedido` -- este último por el
   *  mismo motivo que el sobredespacho: si en la ventana de gracia nadie
   *  explicó por qué un equipo recibió tres veces su tanque en un día, eso
   *  deja de ser una duda y pasa a ser un hallazgo.
   *
   *  Quedan afuera los avisos que alguien revisa y cierra: `vale_anulado`
   *  (TIENE explicación, el motivo que se escribió), `despacho_tardio` (la
   *  anomalía del hueco ya se congeló aparte) y `nivel_bajo` (es operativo,
   *  se arregla reponiendo -- ver el CHECK de tipos en la migración 0073). */
  async findAlertasPorCongelar(client: PoolClient, tenantId: string, ventanaHoras: number) {
    const result = await client.query<{
      id: string;
      tipo: string;
      serie_talonario: string | null;
      n_vale: number | null;
      despacho_id: number | null;
      combustible_id: number | null;
      recepcion_id: number | null;
      lectura_id: string | null;
      detalle: Record<string, unknown>;
      creado_en: Date;
    }>(
      // La lista viaja como parámetro desde TIPOS_CONGELABLES en vez de estar
      // escrita acá: escrita a mano fue justamente como se desincronizó del
      // CHECK de anomalías (ver migración 0086).
      `SELECT id, tipo, serie_talonario, n_vale, despacho_id, combustible_id,
              recepcion_id, lectura_id, detalle, creado_en
       FROM combustible_alertas
       WHERE tenant_id = $1
         AND tipo = ANY($3::text[])
         AND resuelta_en IS NULL
         AND congelada_en IS NULL
         AND creado_en < now() - make_interval(hours => $2)
       ORDER BY creado_en`,
      [tenantId, ventanaHoras, TIPOS_CONGELABLES]
    );
    return result.rows;
  }

  // ── Alertas operativas (migración 0073) ───────────────────────────────

  /** Recepciones VIGENTES cuya diferencia ya es calculable, supera el umbral
   *  del tanque, y todavía no tienen alerta.
   *
   *  Reusa el mismo cálculo de `diferencia_litros` que findRecepciones (ver
   *  el comentario largo de ahí): NULL cuando falta alguna de las dos
   *  lecturas o cuando hubo otra recepción en la ventana -- en esos casos no
   *  se puede atribuir la diferencia a ESTA entrega, y decir "esta vino
   *  corta" sin poder probarlo señalaría a un proveedor por el faltante de
   *  otro.
   *
   *  `umbral_diferencia_pct IS NOT NULL` en el WHERE: NULL significa "sin
   *  configurar" desde la migración 0075, y un tanque sin calibrar nunca
   *  dispara. El 0, que antes era ese mismo caso, ahora sí alerta: es
   *  tolerancia cero de verdad, y la comparación estricta (`> 0`) lo
   *  respeta -- una diferencia de exactamente 0 sigue sin ser noticia. */
  async findRecepcionesConDiferenciaExcedida(client: PoolClient, tenantId: string) {
    const result = await client.query<{
      id: number;
      combustible_id: number;
      cantidad: string;
      unidad: string;
      diferencia_litros: string;
      umbral_diferencia_pct: string;
      tanque_nombre: string;
      entregas_en_grupo: string;
      cantidad_del_grupo: string;
      recepciones_del_grupo: string[];
    }>(
      `
      SELECT r.id, r.combustible_id, r.cantidad, c.unidad, c.tanque_nombre,
             c.umbral_diferencia_pct, dif.diferencia_litros,
             dif.entregas_en_grupo, dif.cantidad_del_grupo, dif.recepciones_del_grupo
      FROM combustible_recepciones r
      JOIN combustible c ON c.id = r.combustible_id
      ${LATERAL_DIFERENCIA_RECEPCION}
      WHERE r.tenant_id = $1
        AND r.anulada_en IS NULL
        AND c.umbral_diferencia_pct IS NOT NULL
        AND dif.diferencia_litros IS NOT NULL
        -- UNA alerta por grupo, anclada a su última entrega.
        AND dif.ultima_del_grupo = r.id
        AND abs(dif.diferencia_litros / NULLIF(dif.cantidad_del_grupo, 0)) * 100
            > c.umbral_diferencia_pct
        AND NOT EXISTS (
          SELECT 1 FROM combustible_alertas a
          WHERE a.tenant_id = $1 AND a.tipo = 'diferencia_recepcion'
            AND a.recepcion_id = ANY(dif.recepciones_del_grupo)
        )
      `,
      [tenantId]
    );
    return result.rows;
  }

  /** El último medidor registrado para ESTE equipo, para detectar un
   *  retroceso o un salto imposible (punto 5 del documento). Mira solo
   *  despachos vigentes: un vale anulado no es evidencia de nada.
   *
   *  Devuelve null si el equipo nunca tuvo un despacho con medidor -- ahí no
   *  hay contra qué comparar y no se alerta, igual que un tanque sin
   *  capacidad configurada. */
  async findUltimoMedidorEquipo(
    client: PoolClient,
    tenantId: string,
    equipoId: number,
    excluirDespachoId: number
  ) {
    const result = await client.query<{
      lectura_horometro: string | null;
      lectura_odometro: string | null;
      despachado_en: Date;
    }>(
      // `id <> $3` es imprescindible: esto corre DESPUÉS de insertar el
      // despacho nuevo, así que sin excluirlo se compararía contra sí mismo
      // y nunca detectaría nada. Mismo motivo que en detectarHuecosRevelados.
      `SELECT lectura_horometro, lectura_odometro, despachado_en
       FROM combustible_despachos
       WHERE tenant_id = $1 AND equipo_id = $2 AND id <> $3 AND anulada_en IS NULL
         AND (lectura_horometro IS NOT NULL OR lectura_odometro IS NOT NULL)
       ORDER BY despachado_en DESC, id DESC
       LIMIT 1`,
      [tenantId, equipoId, excluirDespachoId]
    );
    return result.rows[0] ?? null;
  }

  /** Datos del tanque para evaluar nivel bajo, más si YA hay una alerta de
   *  nivel abierta -- la deduplicación es lo que evita que cada lectura por
   *  debajo del mínimo genere una alerta nueva. */
  async findEstadoNivelTanque(client: PoolClient, tenantId: string, combustibleId: number) {
    const result = await client.query<{
      nivel_minimo: string;
      unidad: string;
      tanque_nombre: string;
      alerta_abierta: boolean;
    }>(
      `SELECT c.nivel_minimo, c.unidad, c.tanque_nombre,
              EXISTS (
                SELECT 1 FROM combustible_alertas a
                WHERE a.tenant_id = $1 AND a.combustible_id = c.id
                  AND a.tipo = 'nivel_bajo' AND a.resuelta_en IS NULL
              ) AS alerta_abierta
       FROM combustible c
       WHERE c.id = $2 AND c.tenant_id = $1`,
      [tenantId, combustibleId]
    );
    return result.rows[0] ?? null;
  }

  /** Los tres números que necesita el balance del tanque (migración 0074):
   *  la lectura anterior a la que se acaba de registrar, y los movimientos
   *  VIGENTES del intervalo entre las dos.
   *
   *  `id <> $3` y el corte por `(leido_en, id)`: la lectura nueva ya está
   *  insertada cuando esto corre (igual que `evaluarNivelBajo`), así que sin
   *  excluirla se encontraría a sí misma como "la anterior". Mismo detalle
   *  que ya habían resuelto `detectarHuecosRevelados` y
   *  `findUltimoMedidorEquipo` -- es el patrón de toda consulta "la anterior
   *  a esta" que corre post-insert.
   *
   *  La comparación es por par `(leido_en, id)` y no solo por fecha para
   *  desempatar igual que el resto del módulo (ver JOIN_ULTIMA_LECTURA): dos
   *  lecturas en el mismo minuto -- la precisión que manda el formulario --
   *  tienen que ordenarse siempre igual, si no el balance dependería del
   *  plan del query.
   *
   *  Los movimientos van `> anterior` y `<= actual`: cada uno pertenece al
   *  intervalo que cierra, nunca a los dos. Sin eso un despacho justo sobre
   *  el borde se contaría dos veces y el descuadre aparecería de la nada en
   *  la lectura siguiente.
   *
   *  Devuelve null cuando el tanque no tiene lectura anterior -- la primera
   *  del alta no tiene contra qué balancearse, y suponer que antes había 0
   *  sería inventar el dato que el módulo justamente no inventa. */
  async findDatosDescuadre(
    client: PoolClient,
    tenantId: string,
    combustibleId: number,
    lecturaId: number,
    leidoEn: string
  ) {
    const result = await client.query<{
      lectura_anterior_id: string;
      nivel_anterior: string;
      leido_en_anterior: Date;
      tanque_nombre: string;
      unidad: string;
      capacidad_total: string;
      // NULL = sin configurar (migración 0075), distinto de "0" que es
      // tolerancia cero.
      umbral_descuadre_pct: string | null;
      despachos: string;
      recepciones: string;
    }>(
      `
      WITH anterior AS (
        SELECT l.id, l.nivel, l.leido_en
        FROM combustible_lecturas l
        WHERE l.tenant_id = $1 AND l.combustible_id = $2
          AND l.anulada_en IS NULL AND l.id <> $3
          AND (l.leido_en, l.id) < ($4::timestamptz, $3::bigint)
        ORDER BY l.leido_en DESC, l.id DESC
        LIMIT 1
      )
      SELECT a.id AS lectura_anterior_id,
             a.nivel AS nivel_anterior,
             a.leido_en AS leido_en_anterior,
             c.tanque_nombre, c.unidad, c.capacidad_total, c.umbral_descuadre_pct,
             COALESCE((
               SELECT SUM(d.cantidad) FROM combustible_despachos d
               WHERE d.tenant_id = $1 AND d.combustible_id = $2
                 AND d.anulada_en IS NULL
                 AND d.despachado_en > a.leido_en AND d.despachado_en <= $4::timestamptz
             ), 0) AS despachos,
             COALESCE((
               SELECT SUM(r.cantidad) FROM combustible_recepciones r
               WHERE r.tenant_id = $1 AND r.combustible_id = $2
                 AND r.anulada_en IS NULL
                 AND r.recibido_en > a.leido_en AND r.recibido_en <= $4::timestamptz
             ), 0) AS recepciones
      FROM anterior a
      JOIN combustible c ON c.id = $2 AND c.tenant_id = $1
      `,
      [tenantId, combustibleId, lecturaId, leidoEn]
    );
    return result.rows[0] ?? null;
  }

  /** El saldo del CICLO: todo lo que pasó desde la última recepción hasta
   *  la lectura que se acaba de registrar (migración 0076).
   *
   *  Por qué existe además del descuadre por tramo: el de tramo compara
   *  lectura contra lectura, así que un faltante repartido en pedazos chicos
   *  -- cada uno debajo de la banda -- nunca dispara. La auditoría lo
   *  demostró sacando 600 L en cuatro tramos de 150 sin generar una sola
   *  alerta. Y como los tramos se compensan entre sí, el último puede decir
   *  "sobran 500" mientras el ciclo entero está 1.000 corto.
   *
   *  El ancla es la última recepción y no un rango de días: cargar el tanque
   *  es el único evento real que cierra un período de consumo. Si el tanque
   *  nunca recibió nada (todavía no se cargó por el sistema), el ciclo
   *  arranca en su lectura más antigua vigente -- que es la del alta.
   *
   *  Devuelve null si no hay ningún punto de partida con nivel medido: sin
   *  eso el acumulado no se puede calcular y estimarlo sería inventar. */
  async findSaldoCiclo(
    client: PoolClient,
    tenantId: string,
    combustibleId: number,
    lecturaId: number,
    leidoEn: string
  ) {
    const result = await client.query<{
      inicio_en: Date;
      nivel_inicio: string;
      tanque_nombre: string;
      unidad: string;
      capacidad_total: string;
      umbral_descuadre_ciclo_pct: string | null;
      despachos: string;
      recepciones: string;
    }>(
      `
      -- El arranque del ciclo: la lectura vigente inmediatamente POSTERIOR
      -- a la última recepción (el nivel ya con el combustible adentro). Sin
      -- recepciones, la lectura vigente más antigua del tanque.
      -- SOLO UNA CARGA DE VERDAD ABRE UN CICLO NUEVO.
      --
      -- El ancla del ciclo era "la última recepción", cualquiera fuera su
      -- tamaño, y eso lo volvía un interruptor: dos recepciones de 1 L cada
      -- dos tramos borraban el acumulado y el control pasaba de cinco alertas
      -- a cero (5ª auditoría). El ciclo existe porque cargar el tanque cierra
      -- un período de consumo; una recepción por debajo del 1 % de la
      -- capacidad --menos que el ruido de la propia varilla-- no cierra nada.
      -- Su combustible SÍ cuenta como entrada, lo que no hace es reiniciar.
      WITH ultima_recepcion AS (
        SELECT MAX(r.recibido_en) AS recibido_en
        FROM combustible_recepciones r
        JOIN combustible c ON c.id = r.combustible_id AND c.tenant_id = $1
        WHERE r.tenant_id = $1 AND r.combustible_id = $2 AND r.anulada_en IS NULL
          AND r.recibido_en <= $4::timestamptz
          AND r.cantidad >= c.capacidad_total * 0.01
      ),
      inicio AS (
        SELECT l.id, l.nivel, l.leido_en
        FROM combustible_lecturas l, ultima_recepcion ur
        WHERE l.tenant_id = $1 AND l.combustible_id = $2
          AND l.anulada_en IS NULL AND l.id <> $3
          AND (l.leido_en, l.id) < ($4::timestamptz, $3::bigint)
          AND (ur.recibido_en IS NULL OR l.leido_en >= ur.recibido_en)
        ORDER BY l.leido_en ASC, l.id ASC
        LIMIT 1
      )
      SELECT i.leido_en AS inicio_en,
             i.nivel AS nivel_inicio,
             c.tanque_nombre, c.unidad, c.capacidad_total,
             c.umbral_descuadre_ciclo_pct,
             COALESCE((
               SELECT SUM(d.cantidad) FROM combustible_despachos d
               WHERE d.tenant_id = $1 AND d.combustible_id = $2
                 AND d.anulada_en IS NULL
                 AND d.despachado_en > i.leido_en AND d.despachado_en <= $4::timestamptz
             ), 0) AS despachos,
             COALESCE((
               SELECT SUM(r.cantidad) FROM combustible_recepciones r
               WHERE r.tenant_id = $1 AND r.combustible_id = $2
                 AND r.anulada_en IS NULL
                 AND r.recibido_en > i.leido_en AND r.recibido_en <= $4::timestamptz
             ), 0) AS recepciones
      FROM inicio i
      JOIN combustible c ON c.id = $2 AND c.tenant_id = $1
      `,
      [tenantId, combustibleId, lecturaId, leidoEn]
    );
    return result.rows[0] ?? null;
  }

  /** Tanques ACTIVOS cuya última lectura vigente es más vieja que el plazo
   *  del tenant, y que todavía no tienen una alerta abierta por eso
   *  (migración 0076).
   *
   *  Incluye los tanques que NUNCA tuvieron lectura vigente: un tanque dado
   *  de alta y nunca medido es exactamente el mismo problema, y dejarlo
   *  afuera con un INNER JOIN sería el caso que más silenciosamente se
   *  escapa. De ahí el LEFT JOIN LATERAL y el `IS NULL` en la condición.
   *
   *  La deduplicación va acá y no en el llamador por el mismo motivo que en
   *  `nivel_bajo`: sin ella, cada corrida del worker generaría una alerta
   *  nueva del mismo tanque y el control moriría por ruidoso. */
  /** Tanques que ESTÁN OPERANDO con los tres umbrales de descuadre en NULL
   *  (migración 0082).
   *
   *  Las dos condiciones importan por igual:
   *
   *  - Los TRES en NULL. Con uno solo configurado el tanque ya no es ciego, y
   *    para "vigilancia parcial" alcanza la etiqueta ámbar de la lista. La
   *    alerta es para el estado en que NINGÚN faltante es detectable.
   *    `umbral_diferencia_pct` queda afuera: vigila la factura del proveedor,
   *    no el faltante del tanque.
   *  - Con despachos reales en la ventana. Un tanque recién dado de alta que
   *    todavía no despachó nada no tiene qué vigilar, y alertarlo el primer
   *    día sería el ruido que hace que nadie mire las alertas.
   *
   *  Sin duplicar: si ya hay una abierta para ese tanque, no se crea otra --
   *  es un ESTADO que persiste, no un evento que se repite. */
  async findTanquesOperandoSinVigilancia(client: PoolClient, tenantId: string, dias: number) {
    const result = await client.query<{
      id: number;
      tanque_nombre: string;
      codigo: string;
      unidad: string;
      vales: string;
      litros: string;
      primer_despacho: Date;
    }>(
      `
      SELECT c.id, c.tanque_nombre, c.codigo, c.unidad,
             mov.vales::text AS vales, mov.litros::text AS litros,
             mov.primero AS primer_despacho
      FROM combustible c
      JOIN LATERAL (
        SELECT COUNT(*) AS vales,
               COALESCE(SUM(d.cantidad), 0) AS litros,
               MIN(d.despachado_en) AS primero
        FROM combustible_despachos d
        WHERE d.tenant_id = $1 AND d.combustible_id = c.id
          AND d.anulada_en IS NULL
      ) mov ON mov.vales > 0
      WHERE c.tenant_id = $1 AND c.activo = true
        AND c.umbral_descuadre_pct IS NULL
        AND c.umbral_descuadre_ciclo_pct IS NULL
        AND c.umbral_descuadre_ventana_pct IS NULL
        -- El plazo se cuenta desde que el tanque EMPEZÓ A DESPACHAR, no desde
        -- que se dio de alta. Es la medida que importa: un tanque instalado
        -- hace meses pero que recién arranca no tiene historial con el que
        -- calibrar, y exigirle un umbral obligaría a inventarlo.
        -- La tabla combustible viene de la migración 0002 y no tiene creado_en,
        -- así que tampoco había de dónde sacar la fecha del alta.
        AND mov.primero < now() - make_interval(days => $2)
        AND NOT EXISTS (
          SELECT 1 FROM combustible_alertas a
          WHERE a.tenant_id = $1 AND a.combustible_id = c.id
            AND a.tipo = 'tanque_sin_vigilancia' AND a.resuelta_en IS NULL
        )
      ORDER BY c.id
      `,
      [tenantId, dias]
    );
    return result.rows;
  }

  /** Tanques con despachos o recepciones fechados ANTES de su primera varilla
   *  vigente (0093): consumo que ninguna medición puede contrastar. Una sola
   *  alerta por tanque en toda su vida -- se excluye al que ya tuvo una, abierta
   *  o cerrada, porque el historial no "se arregla" y re-alertar cada hora
   *  después de que alguien la cerró con motivo sería ruido. */
  async findTanquesConHistorialPrevio(client: PoolClient, tenantId: string) {
    const result = await client.query<{
      id: number;
      tanque_nombre: string;
      codigo: string;
      unidad: string;
      primera_varilla: Date;
      vales: string;
      litros_despachados: string;
      recepciones: string;
      litros_recibidos: string;
      desde: Date;
      hasta: Date;
    }>(
      `
      SELECT c.id, c.tanque_nombre, c.codigo, c.unidad,
             p.en AS primera_varilla,
             h.vales::text, h.litros_despachados::text,
             h.recepciones::text, h.litros_recibidos::text,
             h.desde, h.hasta
        FROM combustible c
        JOIN LATERAL (
          SELECT MIN(l.leido_en) AS en FROM combustible_lecturas l
           WHERE l.tenant_id = $1 AND l.combustible_id = c.id AND l.anulada_en IS NULL
        ) p ON p.en IS NOT NULL
        JOIN LATERAL (
          SELECT COUNT(*) FILTER (WHERE m.tipo = 'despacho') AS vales,
                 COALESCE(SUM(m.cantidad) FILTER (WHERE m.tipo = 'despacho'), 0) AS litros_despachados,
                 COUNT(*) FILTER (WHERE m.tipo = 'recepcion') AS recepciones,
                 COALESCE(SUM(m.cantidad) FILTER (WHERE m.tipo = 'recepcion'), 0) AS litros_recibidos,
                 MIN(m.en) AS desde, MAX(m.en) AS hasta
            FROM (
              SELECT 'despacho' AS tipo, d.cantidad, d.despachado_en AS en
                FROM combustible_despachos d
               WHERE d.tenant_id = $1 AND d.combustible_id = c.id
                 AND d.anulada_en IS NULL AND d.despachado_en < p.en
              UNION ALL
              SELECT 'recepcion', r.cantidad, r.recibido_en
                FROM combustible_recepciones r
               WHERE r.tenant_id = $1 AND r.combustible_id = c.id
                 AND r.anulada_en IS NULL AND r.recibido_en < p.en
            ) m
        ) h ON h.vales + h.recepciones > 0
       WHERE c.tenant_id = $1 AND c.activo = true
         AND NOT EXISTS (
           SELECT 1 FROM combustible_alertas a
            WHERE a.tenant_id = $1 AND a.combustible_id = c.id
              AND a.tipo = 'historial_sin_contrastar'
         )
       ORDER BY c.id
      `,
      [tenantId]
    );
    return result.rows;
  }

  /** Cuántos días puede un tanque despachar sin umbrales antes de que el
   *  sistema empiece a insistir (0082). */
  async getDiasSinVigilancia(client: PoolClient, tenantId: string): Promise<number> {
    const r = await client.query<{ dias: number }>(
      `SELECT COALESCE(
         (SELECT dias_sin_vigilancia FROM combustible_config WHERE tenant_id = $1),
         7
       ) AS dias`,
      [tenantId]
    );
    return Number(r.rows[0].dias);
  }

  /** Si el rol `grifero` puede tomar varilla en este tenant (0085).
   *
   *  El COALESCE a `true` cubre el tenant que nunca tocó la config y por lo
   *  tanto no tiene fila -- mismo criterio que los demás getters de acá: el
   *  default del getter tiene que coincidir con el DEFAULT de la columna, si
   *  no el sistema se comporta distinto según si alguien pasó por la pantalla
   *  de configuración alguna vez. */
  async getGrifieroRegistraVarilla(client: PoolClient, tenantId: string): Promise<boolean> {
    const r = await client.query<{ puede: boolean }>(
      `SELECT COALESCE(
         (SELECT grifero_registra_varilla FROM combustible_config WHERE tenant_id = $1),
         true
       ) AS puede`,
      [tenantId]
    );
    return r.rows[0].puede;
  }

  /** La alerta se cierra sola cuando alguien configura un umbral: el problema
   *  que reportaba dejó de existir. Misma mecánica que `tanque_sin_medir`
   *  cuando llega una lectura -- `resuelta_por` queda NULL porque no lo
   *  resolvió una persona revisando, lo resolvió el hecho. */
  async resolverSinVigilanciaSiExiste(client: PoolClient, tenantId: string, combustibleId: number) {
    await client.query(
      `UPDATE combustible_alertas
          SET resuelta_en = now(),
              detalle = detalle || jsonb_build_object(
                'motivo_revision', 'Se configuró la vigilancia del tanque'
              )
        WHERE tenant_id = $1 AND combustible_id = $2
          AND tipo = 'tanque_sin_vigilancia' AND resuelta_en IS NULL`,
      [tenantId, combustibleId]
    );
  }

  async findTanquesSinMedir(client: PoolClient, tenantId: string, dias: number) {
    const result = await client.query<{
      id: number;
      tanque_nombre: string;
      unidad: string;
      ultima_lectura: Date | null;
      dias_sin_medir: string | null;
    }>(
      `
      SELECT c.id, c.tanque_nombre, c.unidad,
             ultima.leido_en AS ultima_lectura,
             EXTRACT(DAY FROM now() - ultima.leido_en)::text AS dias_sin_medir
      FROM combustible c
      LEFT JOIN LATERAL (
        SELECT l.leido_en
        FROM combustible_lecturas l
        WHERE l.combustible_id = c.id AND l.anulada_en IS NULL
        ORDER BY l.leido_en DESC, l.id DESC
        LIMIT 1
      ) ultima ON true
      WHERE c.tenant_id = $1 AND c.activo = true
        AND (ultima.leido_en IS NULL OR ultima.leido_en < now() - make_interval(days => $2))
        AND NOT EXISTS (
          SELECT 1 FROM combustible_alertas a
          WHERE a.tenant_id = $1 AND a.combustible_id = c.id
            AND a.tipo = 'tanque_sin_medir' AND a.resuelta_en IS NULL
        )
      ORDER BY c.id
      `,
      [tenantId, dias]
    );
    return result.rows;
  }

  /** ¿Esta lectura se insertó HACIA ATRÁS, dentro del ciclo en curso?
   *  (migración 0078)
   *
   *  Devuelve la lectura posterior más antigua que ya existía, o null si la
   *  nueva es la más reciente (el caso normal).
   *
   *  Dos filtros, y los dos son para no generar ruido:
   *
   *  - `id <> $3`: corre después del INSERT, así que sin excluirla se
   *    encontraría a sí misma. Mismo detalle que en el resto del módulo.
   *  - Solo dentro del ciclo vivo (`>= última recepción`): una lectura
   *    metida en un ciclo YA CERRADO no puede cambiar ningún cálculo futuro,
   *    porque el tramo mira la lectura inmediata anterior y el ciclo arranca
   *    en la última recepción. Alertar por esas sería ruido.
   *
   *  Lo que SÍ importa: una lectura insertada justo después de una carga se
   *  vuelve el arranque del ciclo, y con un nivel inventado más bajo el
   *  "esperado" baja con ella -- un faltante real pasa a leerse como
   *  sobrante. Eso es reescribir el punto de partida de la cuenta. */
  async detectarLecturaRetroactiva(
    client: PoolClient,
    tenantId: string,
    combustibleId: number,
    lecturaId: number,
    leidoEn: string
  ): Promise<{ posteriores: number; masReciente: Date } | null> {
    const result = await client.query<{ posteriores: string; mas_reciente: Date }>(
      `
      WITH ultima_recepcion AS (
        SELECT MAX(r.recibido_en) AS recibido_en
        FROM combustible_recepciones r
        WHERE r.tenant_id = $1 AND r.combustible_id = $2 AND r.anulada_en IS NULL
      )
      SELECT COUNT(*)::text AS posteriores, MAX(l.leido_en) AS mas_reciente
      FROM combustible_lecturas l, ultima_recepcion ur
      WHERE l.tenant_id = $1 AND l.combustible_id = $2
        AND l.anulada_en IS NULL AND l.id <> $3
        -- La lectura 'inicial' del alta se crea con NOW() y NO es una
        -- medición que alguien haya tomado: es el punto de partida
        -- declarado. Contarla haría que toda varilla llegada de la cola
        -- offline -- fechada cuando se tomó, en el pasado -- quedara marcada
        -- como retroactiva. Ruido desde el día uno.
        AND l.origen <> 'inicial'
        AND l.leido_en > $4::timestamptz
        AND (ur.recibido_en IS NULL OR $4::timestamptz >= ur.recibido_en)
      `,
      [tenantId, combustibleId, lecturaId, leidoEn]
    );
    const fila = result.rows[0];
    const posteriores = Number(fila?.posteriores ?? 0);
    return posteriores > 0 ? { posteriores, masReciente: fila.mas_reciente } : null;
  }

  /** Alguien volvió a medir: la alerta de "sin medir" se cierra sola, igual
   *  que la de nivel bajo cuando se repone. `resuelta_por` queda NULL porque
   *  lo resolvió el sistema, no una persona. */
  async resolverAlertaSinMedirSiExiste(
    client: PoolClient,
    tenantId: string,
    combustibleId: number
  ): Promise<void> {
    await client.query(
      `UPDATE combustible_alertas
       SET resuelta_en = now()
       WHERE tenant_id = $1 AND combustible_id = $2
         AND tipo = 'tanque_sin_medir' AND resuelta_en IS NULL`,
      [tenantId, combustibleId]
    );
  }

  /** El tanque volvió por encima de su mínimo: la alerta de nivel se
   *  resuelve sola, sin que nadie la toque -- mismo mecanismo que el hueco
   *  cuando llega el vale que faltaba (`resuelta_por` queda NULL porque lo
   *  resolvió el sistema). */
  async resolverAlertaNivelSiExiste(
    client: PoolClient,
    tenantId: string,
    combustibleId: number
  ): Promise<void> {
    await client.query(
      `UPDATE combustible_alertas
       SET resuelta_en = now()
       WHERE tenant_id = $1 AND combustible_id = $2
         AND tipo = 'nivel_bajo' AND resuelta_en IS NULL`,
      [tenantId, combustibleId]
    );
  }

  /** Congela UNA alerta: inserta la anomalía y marca la alerta. Las dos
   *  cosas en la misma transacción del `client` que recibe -- si el UPDATE
   *  fallara después del INSERT, la próxima corrida volvería a congelar la
   *  misma alerta y quedarían dos anomalías del mismo hecho.
   *
   *  El índice único parcial sobre `alerta_id` (0072) es la red de
   *  seguridad final contra eso; el ON CONFLICT lo vuelve idempotente en
   *  vez de un error. */
  async congelarAlerta(
    client: PoolClient,
    tenantId: string,
    alerta: {
      id: string;
      tipo: string;
      serie_talonario: string | null;
      n_vale: number | null;
      despacho_id: number | null;
      combustible_id: number | null;
      recepcion_id: number | null;
      lectura_id: string | null;
      detalle: Record<string, unknown>;
      creado_en: Date;
    },
    ventanaHoras: number
  ) {
    const result = await client.query<{ id: string }>(
      `
      INSERT INTO combustible_anomalias
        (tenant_id, tipo, serie_talonario, n_vale, despacho_id, combustible_id,
         recepcion_id, alerta_id, detalle, detectada_en, ventana_horas, lectura_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (alerta_id) WHERE alerta_id IS NOT NULL DO NOTHING
      RETURNING id
      `,
      [
        tenantId,
        alerta.tipo,
        alerta.serie_talonario,
        alerta.n_vale,
        alerta.despacho_id,
        alerta.combustible_id,
        alerta.recepcion_id,
        alerta.id,
        JSON.stringify(alerta.detalle),
        alerta.creado_en,
        ventanaHoras,
        alerta.lectura_id,
      ]
    );

    const anomaliaId = result.rows[0]?.id;
    // Sin fila devuelta = ya estaba congelada (ON CONFLICT DO NOTHING).
    // Igual hay que marcar la alerta, por si quedó a medias en una corrida
    // anterior que murió entre el INSERT y el UPDATE.
    await client.query(
      `UPDATE combustible_alertas
       SET congelada_en = now()
       WHERE id = $1 AND tenant_id = $2 AND congelada_en IS NULL`,
      [alerta.id, tenantId]
    );

    return anomaliaId ?? null;
  }

  async findAnomalias(client: PoolClient, tenantId: string, { pageSize, offset }: Paginacion) {
    const result = await client.query(
      `
      SELECT id, tipo, serie_talonario, n_vale, despacho_id, combustible_id,
             recepcion_id, lectura_id, alerta_id, detalle, detectada_en, congelada_en,
             ventana_horas, COUNT(*) OVER() AS total_count
      FROM combustible_anomalias
      WHERE tenant_id = $1
      ORDER BY congelada_en DESC, id DESC
      LIMIT $2 OFFSET $3
      `,
      [tenantId, pageSize, offset]
    );
    return result.rows;
  }

  /** Los dos datos que hacen falta para evaluar sobredespacho, en una sola
   *  consulta: la capacidad del equipo (migración 0069) y la unidad del
   *  tanque del que salió el combustible (0057), que es la que da sentido a
   *  `cantidad`. `combustibleId` es NULL en compra_externa -- ahí no hay
   *  tanque y por lo tanto no hay unidad, ver evaluarSobredespacho(). */
  async findDatosSobredespacho(
    client: PoolClient,
    tenantId: string,
    equipoId: number,
    combustibleId: number | null
  ) {
    const result = await client.query<{
      capacidad_tanque: string | null;
      capacidad_tanque_unidad: string | null;
      unidad_tanque: string | null;
    }>(
      `
      SELECT e.capacidad_tanque, e.capacidad_tanque_unidad,
             (SELECT c.unidad FROM combustible c
               WHERE c.id = $3 AND c.tenant_id = $1) AS unidad_tanque
      FROM equipos e
      WHERE e.id = $2 AND e.tenant_id = $1
      `,
      [tenantId, equipoId, combustibleId]
    );
    return result.rows[0] ?? null;
  }

  /** Lo despachado a UN mismo actor en la PEOR ventana móvil de 24 h que
   *  contiene a `hasta` (migración 0079, corregida en la 5ª auditoría).
   *  "Actor" es el equipo si el destino es un equipo, y el tipo de destino
   *  cuando no lo hay -- todos los vales a planta suman juntos, porque planta
   *  es una sola.
   *
   *  Convierte cada fila a litros con la unidad de SU tanque: un tenant
   *  puede tener un tanque en galones y otro en litros, y sumarlos crudos
   *  daría un número sin sentido. En `compra_externa` no hay tanque y por lo
   *  tanto no hay unidad -- se asume litros, que es lo que usa la operación
   *  real (ver la planilla de vale de Cushuro). Si algún día aparece un
   *  tenant que compra en galones afuera, esto los cuenta de menos, que es
   *  el lado seguro: hace falta una unidad en el despacho para arreglarlo
   *  bien, no una adivinanza acá.
   *
   *  Excluye los vales anulados (0067) y, opcionalmente, un despacho por id
   *  -- lo usa evaluarTopeDiario para saber cuánto había ANTES de este vale
   *  y alertar solo en el que cruza la línea. */
  async findAcumuladoDiario(
    client: PoolClient,
    tenantId: string,
    producto: string,
    actor: { equipoId: number } | { tipoDestino: string },
    hasta: string,
    excluirDespachoId?: number
  ) {
    const porEquipo = "equipoId" in actor;
    const result = await client.query<{
      total_l: string | null;
      vales: string;
      desde_en: Date | null;
      hasta_en: Date | null;
    }>(
      // ── La ventana que MÁS suma entre las que contienen a este vale ──────
      //
      // Antes esto miraba solo hacia atrás: las 24 h anteriores a
      // `despachado_en`. Como la fecha del vale la escribe quien carga, la
      // evasión era de un renglón: fechar cada vale una hora ANTES del
      // anterior. Cada uno quedaba solo en su propia ventana y el techo no
      // veía nada. Verificado: 1.200 L a planta con tope de 500, cero alertas.
      //
      // Ahora se prueban todas las ventanas de 24 h que CONTIENEN al vale --
      // las que terminan en él o en cualquier vale posterior dentro de 24 h --
      // y se toma la peor. Con eso da igual en qué orden se carguen o se
      // fechen: el vale que completa la suma la ve completa.
      `
      WITH vales AS (
        SELECT d.id, d.despachado_en,
               d.cantidad * CASE WHEN c.unidad = 'gal' THEN 3.785411784 ELSE 1 END AS litros
          FROM combustible_despachos d
          LEFT JOIN combustible c ON c.id = d.combustible_id AND c.tenant_id = $1
         WHERE d.tenant_id = $1
           AND d.producto = $2
           AND d.anulada_en IS NULL
           AND d.despachado_en > $4::timestamptz - INTERVAL '24 hours'
           AND d.despachado_en < $4::timestamptz + INTERVAL '24 hours'
           AND ($5::bigint IS NULL OR d.id <> $5::bigint)
           AND ${porEquipo ? "d.equipo_id = $3::int" : "(d.equipo_id IS NULL AND d.tipo_destino = $3::text)"}
      ),
      -- Los finales de ventana posibles: el instante del vale que se está
      -- evaluando y el de cada vale posterior que todavía lo alcanza.
      anclas AS (
        SELECT $4::timestamptz AS fin
        UNION
        SELECT v.despachado_en FROM vales v WHERE v.despachado_en >= $4::timestamptz
      )
      SELECT COALESCE(SUM(v.litros), 0) AS total_l,
             COUNT(v.id) AS vales,
             MIN(v.despachado_en) AS desde_en,
             a.fin AS hasta_en
        FROM anclas a
        LEFT JOIN vales v
               ON v.despachado_en <= a.fin
              AND v.despachado_en > a.fin - INTERVAL '24 hours'
       GROUP BY a.fin
       ORDER BY total_l DESC, a.fin
       LIMIT 1
      `,
      [
        tenantId,
        producto,
        porEquipo ? actor.equipoId : actor.tipoDestino,
        hasta,
        excluirDespachoId ?? null,
      ]
    );
    const fila = result.rows[0];
    return {
      totalL: Number(fila?.total_l ?? 0),
      vales: Number(fila?.vales ?? 0),
      desdeEn: fila?.desde_en ?? null,
      hastaEn: fila?.hasta_en ?? null,
    };
  }

  /** Litros de urea y de diésel/gasolina/glp que un mismo equipo recibió en
   *  una ventana de N días terminando en `hasta` -- lo que compara
   *  evaluarUreaRatioExcedido. Los dos productos comparten tabla y
   *  `equipo_id`, así que es la misma consulta filtrada dos veces, no dos
   *  tablas que cruzar. El diésel se convierte a litros con el mismo CASE
   *  de siempre (gal → L); la urea ya está en litros (0092). */
  async findRatioUreaDiesel(
    client: PoolClient,
    tenantId: string,
    equipoId: number,
    hasta: string,
    dias: number
  ): Promise<{ litrosUrea: number; litrosDiesel: number }> {
    const result = await client.query<{ litros_urea: string; litros_diesel: string }>(
      `
      SELECT
        COALESCE(SUM(d.cantidad) FILTER (WHERE d.producto = 'urea'), 0) AS litros_urea,
        COALESCE(
          SUM(d.cantidad * CASE WHEN c.unidad = 'gal' THEN 3.785411784 ELSE 1 END)
            FILTER (WHERE d.producto = 'combustible'),
          0
        ) AS litros_diesel
      FROM combustible_despachos d
      LEFT JOIN combustible c ON c.id = d.combustible_id AND c.tenant_id = $1
      WHERE d.tenant_id = $1
        AND d.equipo_id = $2
        AND d.anulada_en IS NULL
        AND d.despachado_en > $3::timestamptz - ($4::int * INTERVAL '1 day')
        AND d.despachado_en <= $3::timestamptz
      `,
      [tenantId, equipoId, hasta, dias]
    );
    return {
      litrosUrea: Number(result.rows[0]?.litros_urea ?? 0),
      litrosDiesel: Number(result.rows[0]?.litros_diesel ?? 0),
    };
  }

  /** El costo simple de la urea que sale a un vale, cuando no trae el suyo
   *  propio -- promedio de las recepciones de urea VIGENTES hasta la fecha
   *  del vale. Ver el comentario largo de `resolverCostoUrea` en el
   *  service: a diferencia del tanque de combustible, esto no es un
   *  promedio PONDERADO con estado (las cajas no se mezclan entre sí), es
   *  un promedio simple derivado en el momento. `null` si todavía no hay
   *  ninguna recepción -- el llamador decide qué hacer (hoy: 0). */
  async findCostoPromedioUrea(
    client: PoolClient,
    tenantId: string,
    hasta: string
  ): Promise<number | null> {
    const result = await client.query<{ promedio: string | null }>(
      `SELECT AVG(costo_unitario) AS promedio
       FROM combustible_recepciones
       WHERE tenant_id = $1 AND producto = 'urea' AND anulada_en IS NULL
         AND recibido_en <= $2::timestamptz`,
      [tenantId, hasta]
    );
    const promedio = result.rows[0]?.promedio;
    return promedio ? Number(promedio) : null;
  }

  // ── Conteo físico de urea (migración 0092) ─────────────────────────────
  // Es a la urea lo que combustible_lecturas es al tanque: la contraparte
  // FÍSICA independiente. Append-only, mismo mecanismo de anulación con
  // motivo que despachos/recepciones.

  async crearConteoUrea(
    client: PoolClient,
    tenantId: string,
    usuarioId: string | null,
    data: { cantidadLitros: number; contadoEn: string; observaciones: string | null }
  ) {
    const result = await client.query(
      `
      INSERT INTO combustible_conteos_urea
        (tenant_id, cantidad_litros, contado_en, usuario_id, observaciones)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, tenant_id, cantidad_litros, contado_en, usuario_id, observaciones,
        creado_en, anulada_en, anulada_por, motivo_anulacion
      `,
      [tenantId, data.cantidadLitros, data.contadoEn, usuarioId, data.observaciones]
    );
    return result.rows[0];
  }

  async findConteoUreaPorId(client: PoolClient, tenantId: string, id: number) {
    const result = await client.query(
      `SELECT id, tenant_id, cantidad_litros, contado_en, usuario_id, observaciones,
         creado_en, anulada_en, anulada_por, motivo_anulacion
       FROM combustible_conteos_urea WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );
    return result.rows[0] ?? null;
  }

  async findConteosUrea(client: PoolClient, tenantId: string, { pageSize, offset }: Paginacion) {
    const result = await client.query(
      `
      SELECT c.id, c.cantidad_litros, c.contado_en, c.usuario_id, c.observaciones,
             c.creado_en, c.anulada_en, c.anulada_por, c.motivo_anulacion,
             autor.nombre AS registrado_por_nombre,
             anulador.nombre AS anulada_por_nombre,
             COUNT(*) OVER() AS total_count
      FROM combustible_conteos_urea c
      LEFT JOIN usuarios autor ON autor.id = c.usuario_id
      LEFT JOIN usuarios anulador ON anulador.id = c.anulada_por
      WHERE c.tenant_id = $1
      ORDER BY c.contado_en DESC, c.id DESC
      LIMIT $2 OFFSET $3
      `,
      [tenantId, pageSize, offset]
    );
    return result.rows;
  }

  async anularConteoUrea(
    client: PoolClient,
    tenantId: string,
    id: number,
    usuarioId: string,
    motivo: string
  ) {
    const result = await client.query(
      `
      UPDATE combustible_conteos_urea
      SET anulada_en = now(), anulada_por = $1, motivo_anulacion = $2
      WHERE id = $3 AND tenant_id = $4 AND anulada_en IS NULL
      RETURNING id, tenant_id, cantidad_litros, contado_en, usuario_id, observaciones,
        creado_en, anulada_en, anulada_por, motivo_anulacion
      `,
      [usuarioId, motivo, id, tenantId]
    );
    return result.rows[0] ?? null;
  }

  /** El último conteo VIGENTE -- es contra el que se compara el stock
   *  teórico. `null` si nunca se contó nada todavía (ver
   *  evaluarUreaDescuadreConteo: sin conteo previo no hay nada que
   *  comparar, y el control de "días sin conteo" -- no el de descuadre --
   *  es el que avisa de esa ausencia). */
  async findUltimoConteoUreaVigente(client: PoolClient, tenantId: string) {
    const result = await client.query<{ cantidad_litros: string; contado_en: Date }>(
      `SELECT cantidad_litros, contado_en FROM combustible_conteos_urea
       WHERE tenant_id = $1 AND anulada_en IS NULL
       ORDER BY contado_en DESC, id DESC LIMIT 1`,
      [tenantId]
    );
    const fila = result.rows[0];
    return fila
      ? { cantidadLitros: Number(fila.cantidad_litros), contadoEn: fila.contado_en }
      : null;
  }

  /** Stock TEÓRICO de urea hasta una fecha: entradas (recepciones vigentes)
   *  menos salidas (despachos vigentes), ambas con producto='urea'. Es la
   *  mitad "de papel" del descuadre -- la otra mitad es el conteo físico.
   *  Mismo principio que el saldo del tanque de combustible (kardex): se
   *  DERIVA, no se guarda como estado mutable. */
  async findStockTeoricoUrea(client: PoolClient, tenantId: string, hasta: string): Promise<number> {
    const result = await client.query<{ entradas: string; salidas: string }>(
      `
      SELECT
        COALESCE(
          (SELECT SUM(cantidad) FROM combustible_recepciones
            WHERE tenant_id = $1 AND producto = 'urea' AND anulada_en IS NULL
              AND recibido_en <= $2::timestamptz),
          0
        ) AS entradas,
        COALESCE(
          (SELECT SUM(cantidad) FROM combustible_despachos
            WHERE tenant_id = $1 AND producto = 'urea' AND anulada_en IS NULL
              AND despachado_en <= $2::timestamptz),
          0
        ) AS salidas
      `,
      [tenantId, hasta]
    );
    const fila = result.rows[0];
    return Number(fila.entradas) - Number(fila.salidas);
  }

  /** Días desde el último conteo VIGENTE -- alimenta la alerta de "días sin
   *  conteo" (mismo criterio que dias_sin_medir del tanque). `null` si
   *  nunca se contó nada (caso distinto de "hace mucho que no se cuenta":
   *  ese primer conteo pendiente también tiene que verse). */
  async getDiasSinConteoUrea(client: PoolClient, tenantId: string): Promise<number> {
    const result = await client.query<{ dias: number }>(
      `SELECT COALESCE(
         (SELECT dias_sin_conteo_urea FROM combustible_config WHERE tenant_id = $1),
         30
       ) AS dias`,
      [tenantId]
    );
    return Number(result.rows[0].dias);
  }

  /** KARDEX DEL TANQUE: las tres historias en UNA sola línea de tiempo.
   *
   *  Hasta acá el módulo tenía tres listados separados --despachos,
   *  recepciones y lecturas-- y ninguno cruzaba con los otros. Es lo primero
   *  que pide un auditor y no existía.
   *
   *  ── Las dos verdades ──────────────────────────────────────────────────
   *
   *  El módulo mantiene A PROPÓSITO dos números independientes: el SALDO
   *  TEÓRICO (lo que dice el papeleo: inicial + recepciones - despachos) y
   *  el NIVEL MEDIDO (lo que dice la varilla). Un auditor no mira ninguno de
   *  los dos solo: mira la DISTANCIA entre ellos y cómo evoluciona. Por eso
   *  esto es una línea de tiempo y no tres listas al lado.
   *
   *  ── Por qué el saldo teórico NO se re-ancla en cada varilla ───────────
   *
   *  Es la decisión de diseño que define el reporte. Si cada medición
   *  corrigiera el saldo al nivel real, un robo de 50 L/día en un tanque de
   *  20.000 se vería como veinte filas de -50 (0,25%, indistinguible de una
   *  varilla mal leída, nadie lo levanta). Arrastrando, la última fila dice
   *  -1.000 y eso no se explica con temperatura ni redondeo.
   *
   *  Es la misma lección de la migración 0080: un acumulado que se reinicia
   *  le regala al que roba de a poco el reinicio que necesita. Acá el
   *  reinicio sería la varilla en vez de la recepción, pero el regalo es el
   *  mismo.
   *
   *  ── Los anulados ─────────────────────────────────────────────────────
   *
   *  SE MUESTRAN, con su fecha y su motivo, pero suman 0 al saldo. Un vale
   *  anulado ES evidencia -- ocultarlo convertiría el kardex en un reporte
   *  que se maquilla borrando filas, que es exactamente lo contrario de
   *  para qué existe.
   *
   *  ── El orden dentro del mismo instante ───────────────────────────────
   *
   *  Recepción (1) y despacho (2) van ANTES que la lectura (3): en la
   *  realidad se mide DESPUÉS de cargar o despachar, así que la varilla
   *  tiene que ver el efecto de los movimientos de su mismo timestamp. Si
   *  fuera al revés, toda recepción registrada a la misma hora que su
   *  varilla aparecería como un descuadre gigante. */
  async findKardex(
    client: PoolClient,
    tenantId: string,
    combustibleId: number,
    desde: string,
    hasta: string
  ) {
    const result = await client.query<{
      ocurrido_en: Date;
      tipo: string;
      referencia_id: string;
      documento: string | null;
      detalle: string | null;
      entrada: string;
      salida: string;
      nivel_medido: string | null;
      saldo_teorico: string;
      usuario: string | null;
      anulada_en: Date | null;
      motivo_anulacion: string | null;
      historico: boolean;
      totalizador: string | null;
      totalizador_texto: string | null;
    }>(
      `
      -- El punto de partida: la última varilla VIGENTE anterior al período.
      -- Es el último número físicamente verificado, no un cálculo. Si no hay
      -- ninguna (período anterior al alta del tanque), arranca en la primera
      -- medición de adentro del período.
      WITH ancla AS (
        SELECT COALESCE(
          (SELECT l.nivel FROM combustible_lecturas l
            WHERE l.tenant_id = $1 AND l.combustible_id = $2
              AND l.anulada_en IS NULL AND l.leido_en < $3::timestamptz
            ORDER BY l.leido_en DESC, l.id DESC LIMIT 1),
          (SELECT l.nivel FROM combustible_lecturas l
            WHERE l.tenant_id = $1 AND l.combustible_id = $2
              AND l.anulada_en IS NULL
              AND l.leido_en >= $3::timestamptz AND l.leido_en <= $4::timestamptz
            ORDER BY l.leido_en ASC, l.id ASC LIMIT 1),
          0
        ) AS nivel
      ),
      movimientos AS (
        SELECT r.recibido_en AS ocurrido_en, 2 AS orden_tipo, 'recepcion' AS tipo,
               r.id::text AS referencia_id,
               CONCAT_WS(' ', r.tipo_documento, r.numero_documento) AS documento,
               g.nombre AS detalle,
               r.cantidad AS entrada, 0::numeric AS salida,
               NULL::numeric AS nivel_medido,
               r.usuario_id, r.anulada_en, r.motivo_anulacion,
               NULL::numeric AS totalizador, NULL::text AS totalizador_texto
          FROM combustible_recepciones r
          LEFT JOIN combustible_grifos g
                 ON g.id = r.grifo_id AND g.tenant_id = $1
         WHERE r.tenant_id = $1 AND r.combustible_id = $2
           AND r.recibido_en >= $3::timestamptz AND r.recibido_en <= $4::timestamptz

        UNION ALL

        SELECT d.despachado_en, 1, 'despacho',
               d.id::text,
               CONCAT(d.serie_talonario, '-', LPAD(d.n_vale::text, 5, '0')),
               COALESCE(e.placa_codigo, d.tipo_destino),
               0::numeric, d.cantidad,
               NULL::numeric,
               d.usuario_id, d.anulada_en, d.motivo_anulacion,
               d.totalizador_lectura, NULL::text
          FROM combustible_despachos d
          LEFT JOIN equipos e ON e.id = d.equipo_id AND e.tenant_id = $1
         WHERE d.tenant_id = $1 AND d.combustible_id = $2
           AND d.despachado_en >= $3::timestamptz AND d.despachado_en <= $4::timestamptz

        UNION ALL

        -- La varilla no mueve el saldo teórico: lo CONTRASTA. Por eso entrada
        -- y salida en 0 y el nivel aparte.
        SELECT l.leido_en, 3, 'lectura',
               l.id::text,
               NULL,
               l.origen,
               0::numeric, 0::numeric,
               l.nivel,
               l.usuario_id, l.anulada_en, l.motivo_anulacion,
               -- Un surtidor: el número. Varios (0098): "S1: 100 · S2: 200".
               (SELECT CASE WHEN count(*) = 1 THEN max(lt.valor) END
                  FROM combustible_lectura_totalizadores lt WHERE lt.lectura_id = l.id),
               (SELECT CASE WHEN count(*) > 1
                            THEN string_agg(s.nombre || ': ' || lt.valor::text, ' · '
                                            ORDER BY lower(s.nombre)) END
                  FROM combustible_lectura_totalizadores lt
                  JOIN surtidores s ON s.id = lt.surtidor_id
                 WHERE lt.lectura_id = l.id)
          FROM combustible_lecturas l
         WHERE l.tenant_id = $1 AND l.combustible_id = $2
           AND l.leido_en >= $3::timestamptz AND l.leido_en <= $4::timestamptz

        UNION ALL

        -- Cada precinto colocado (0095). No mueve el saldo ni se contrasta:
        -- está en la línea de tiempo para que un descuadre se lea junto con
        -- "ese día se abrió el drenaje".
        SELECT p.colocado_en, 4, 'precinto',
               p.id::text,
               p.numero,
               CONCAT(pp.nombre, ': ', p.motivo),
               0::numeric, 0::numeric,
               NULL::numeric,
               p.colocado_por, NULL::timestamptz, NULL::text,
               NULL::numeric, NULL::text
          FROM combustible_precintos p
          JOIN combustible_precinto_puntos pp ON pp.id = p.punto_id AND pp.tenant_id = $1
         WHERE p.tenant_id = $1 AND pp.combustible_id = $2
           AND p.colocado_en >= $3::timestamptz AND p.colocado_en <= $4::timestamptz
      ),
      -- CONSUMO HISTÓRICO: todo despacho o recepción anterior a la primera
      -- varilla vigente del tanque (la de TODA su vida, no la del período).
      -- Nada lo puede contrastar --la medición es posterior-- y si moviera
      -- el saldo, la primera varilla mostraría un "sobrante" igual a todo
      -- el consumo previo. Se muestra, pero suma 0, como los anulados.
      -- Igual instante que la varilla NO es histórico: en el orden del
      -- kardex el movimiento va antes que la lectura y ella lo ve.
      primera AS (
        SELECT MIN(l.leido_en) AS en
          FROM combustible_lecturas l
         WHERE l.tenant_id = $1 AND l.combustible_id = $2 AND l.anulada_en IS NULL
      ),
      marcados AS (
        SELECT m.*,
               COALESCE(m.tipo IN ('despacho', 'recepcion')
                        AND m.ocurrido_en < (SELECT p.en FROM primera p), false) AS historico
          FROM movimientos m
      )
      SELECT m.ocurrido_en, m.tipo, m.referencia_id, m.documento, m.detalle,
             m.entrada, m.salida, m.nivel_medido,
             -- El saldo corriente. Los anulados y el histórico aportan 0 (el
             -- CASE), así que aparecen en la lista sin ensuciar la cuenta.
             (SELECT a.nivel FROM ancla a) + SUM(
               CASE WHEN m.anulada_en IS NULL AND NOT m.historico
                    THEN m.entrada - m.salida ELSE 0 END
             ) OVER (ORDER BY m.ocurrido_en, m.orden_tipo, m.referencia_id
                     ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS saldo_teorico,
             u.nombre AS usuario,
             m.anulada_en, m.motivo_anulacion, m.historico, m.totalizador, m.totalizador_texto
        FROM marcados m
        LEFT JOIN usuarios u ON u.id = m.usuario_id AND u.tenant_id = $1
       ORDER BY m.ocurrido_en, m.orden_tipo, m.referencia_id
      `,
      [tenantId, combustibleId, desde, hasta]
    );
    return result.rows;
  }

  /** ¿Este tanque ya tiene historial? Cuenta despachos, recepciones y
   *  lecturas REALES -- la `inicial` del alta no cuenta, porque la crea el
   *  propio sistema y no es un movimiento de nadie.
   *
   *  Existe para una sola decisión: si cambiar la UNIDAD del tanque (L <-> gal)
   *  es reversible o destructivo. Ver validarCambioDeUnidad. */
  async tieneMovimientos(client: PoolClient, tenantId: string, combustibleId: number) {
    const r = await client.query<{ hay: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM combustible_despachos
          WHERE tenant_id = $1 AND combustible_id = $2
         UNION ALL
         SELECT 1 FROM combustible_recepciones
          WHERE tenant_id = $1 AND combustible_id = $2
         UNION ALL
         SELECT 1 FROM combustible_lecturas
          WHERE tenant_id = $1 AND combustible_id = $2 AND origen <> 'inicial'
       ) AS hay`,
      [tenantId, combustibleId]
    );
    return r.rows[0].hay;
  }

  /** Cuánto salió de un tanque entre dos instantes. Es la segunda mitad del
   *  reporte de controles: un aflojamiento por sí solo es una anécdota
   *  ("alguien subió el umbral el viernes"); lo que lo vuelve un hallazgo es
   *  el número que va al lado ("y en esa ventana salieron 14.000 L").
   *
   *  Sin `combustibleId` --hay aflojamientos que son de configuración del
   *  tenant, no de un tanque-- suma TODOS los tanques. */
  async findDespachadoEntre(
    client: PoolClient,
    tenantId: string,
    desde: string,
    hasta: string,
    combustibleId?: number | null
  ) {
    const r = await client.query<{ litros: string; vales: string }>(
      `
      SELECT COALESCE(SUM(
               d.cantidad * CASE WHEN c.unidad = 'gal' THEN 3.785411784 ELSE 1 END
             ), 0) AS litros,
             COUNT(*) AS vales
        FROM combustible_despachos d
        LEFT JOIN combustible c ON c.id = d.combustible_id AND c.tenant_id = $1
       WHERE d.tenant_id = $1
         -- Hardcodeado, no parametrizado: este reporte es del motor de
         -- conciliación del TANQUE (Fase D) -- existía antes de que la urea
         -- compartiera la tabla (migración 0092). Sin este filtro, litros de
         -- urea (que no salen de ningún tanque) se sumarían al descuadre de
         -- un tanque de combustible que nunca los tuvo.
         AND d.producto = 'combustible'
         AND d.anulada_en IS NULL
         AND d.despachado_en > $2::timestamptz
         AND d.despachado_en <= $3::timestamptz
         AND ($4::int IS NULL OR d.combustible_id = $4::int)
      `,
      [tenantId, desde, hasta, combustibleId ?? null]
    );
    return { litros: Number(r.rows[0].litros), vales: Number(r.rows[0].vales) };
  }

  /** El estado de vigilancia de cada tanque HOY: qué controles tiene
   *  apagados. Es la foto que acompaña a la película de los eventos. */
  async findEstadoVigilancia(client: PoolClient, tenantId: string) {
    const r = await client.query(
      `
      SELECT id, codigo, tanque_nombre, activo,
             umbral_descuadre_pct, umbral_descuadre_ciclo_pct,
             umbral_descuadre_ventana_pct, umbral_diferencia_pct
        FROM combustible
       WHERE tenant_id = $1
       ORDER BY activo DESC, codigo
      `,
      [tenantId]
    );
    return r.rows;
  }

  /** SEGREGACIÓN DE FUNCIONES: quién hace y quién controla.
   *
   *  Es la pregunta que un auditor hace siempre y que el módulo no podía
   *  contestar: ¿la misma persona que despacha es la que anula, corrige y da
   *  por revisados los faltantes? En una operación chica la respuesta suele
   *  ser "sí", y eso NO es un delito -- es un riesgo que hay que conocer y
   *  compensar (que alguien más revise el reporte, por ejemplo).
   *
   *  Por eso el reporte no acusa: cuenta. Una fila por persona, y adentro la
   *  distinción que importa: no es lo mismo anular el vale de otro --que deja
   *  dos personas en la historia-- que anular el propio, donde el que se
   *  equivoca y el que corrige son el mismo y nadie más se entera.
   *
   *  Todo en el período, para que el número sea comparable entre meses. */
  async findSegregacion(client: PoolClient, tenantId: string, desde: string, hasta: string) {
    const r = await client.query(
      `
      WITH movimientos AS (
        -- Lo que cada uno CARGÓ.
        SELECT d.usuario_id AS usuario, 'despacho' AS que, 'carga' AS accion,
               NULL::uuid AS autor_original
          FROM combustible_despachos d
         WHERE d.tenant_id = $1 AND d.despachado_en BETWEEN $2::timestamptz AND $3::timestamptz
        UNION ALL
        SELECT r.usuario_id, 'recepcion', 'carga', NULL::uuid
          FROM combustible_recepciones r
         WHERE r.tenant_id = $1 AND r.recibido_en BETWEEN $2::timestamptz AND $3::timestamptz
        UNION ALL
        SELECT l.usuario_id, 'lectura', 'carga', NULL::uuid
          FROM combustible_lecturas l
         WHERE l.tenant_id = $1 AND l.leido_en BETWEEN $2::timestamptz AND $3::timestamptz
           AND l.origen <> 'inicial'
        UNION ALL
        -- Los precintos que cada uno COLOCÓ (0095): quien cambia el sello y
        -- quien lo verifica en la varilla no deberían ser la misma persona.
        SELECT p.colocado_por, 'precinto', 'carga', NULL::uuid
          FROM combustible_precintos p
         WHERE p.tenant_id = $1 AND p.colocado_en BETWEEN $2::timestamptz AND $3::timestamptz

        UNION ALL

        -- Lo que cada uno ANULÓ, y de quién era.
        SELECT d.anulada_por, 'despacho', 'anulacion', d.usuario_id
          FROM combustible_despachos d
         WHERE d.tenant_id = $1 AND d.anulada_en BETWEEN $2::timestamptz AND $3::timestamptz
        UNION ALL
        SELECT r.anulada_por, 'recepcion', 'anulacion', r.usuario_id
          FROM combustible_recepciones r
         WHERE r.tenant_id = $1 AND r.anulada_en BETWEEN $2::timestamptz AND $3::timestamptz
        UNION ALL
        SELECT l.anulada_por, 'lectura', 'anulacion', l.usuario_id
          FROM combustible_lecturas l
         WHERE l.tenant_id = $1 AND l.anulada_en BETWEEN $2::timestamptz AND $3::timestamptz

        UNION ALL

        -- Lo que cada uno DIO POR REVISADO. La marca de autorrevision la pone
        -- el propio cierre (ver resolverAlertaManual): aca solo se cuenta.
        SELECT a.resuelta_por, 'alerta', 'revision',
               CASE WHEN (a.detalle->>'autorevision')::boolean THEN a.resuelta_por END
          FROM combustible_alertas a
         WHERE a.tenant_id = $1 AND a.resuelta_en BETWEEN $2::timestamptz AND $3::timestamptz
      )
      SELECT COALESCE(u.nombre, u.email, 'Sistema') AS persona,
             m.usuario AS usuario_id,
             COUNT(*) FILTER (WHERE m.accion = 'carga' AND m.que = 'despacho') AS vales_cargados,
             COUNT(*) FILTER (WHERE m.accion = 'carga' AND m.que = 'recepcion') AS recepciones_cargadas,
             COUNT(*) FILTER (WHERE m.accion = 'carga' AND m.que = 'lectura') AS lecturas_cargadas,
             COUNT(*) FILTER (WHERE m.accion = 'carga' AND m.que = 'precinto') AS precintos_colocados,
             COUNT(*) FILTER (WHERE m.accion = 'anulacion') AS anulaciones,
             COUNT(*) FILTER (WHERE m.accion = 'anulacion' AND m.autor_original = m.usuario)
               AS anulaciones_propias,
             COUNT(*) FILTER (WHERE m.accion = 'revision') AS alertas_revisadas,
             COUNT(*) FILTER (WHERE m.accion = 'revision' AND m.autor_original IS NOT NULL)
               AS autorevisiones
        FROM movimientos m
        LEFT JOIN usuarios u ON u.id = m.usuario AND u.tenant_id = $1
       WHERE m.usuario IS NOT NULL
       GROUP BY u.nombre, u.email, m.usuario
       ORDER BY 3 DESC, 1
      `,
      [tenantId, desde, hasta]
    );
    return r.rows;
  }

  /** El movimiento MÁS RECIENTE del tanque, sin contar el despacho que se
   *  acaba de crear. Distingue las dos cosas que `despacho_retroactivo`
   *  confundía:
   *
   *  - CARGA INICIAL del historial (un tenant que sube los vales del mes
   *    pasado desde el papel): cada vale es más nuevo que el anterior, así
   *    que nunca hay nada más reciente y no alerta.
   *  - VALE METIDO ATRÁS entre tráfico actual: el tanque ya tiene movimiento
   *    de hoy y aparece un vale de hace tres semanas. Eso sí es señal.
   *
   *  Mira despachos Y lecturas: un tanque puede estar midiéndose al día sin
   *  haber despachado nada. */
  /** El movimiento más reciente del tanque EXCLUYENDO una recepción, para
   *  saber si una recepción se insertó detrás de algo que ya existía. Mismo
   *  criterio que findUltimoMovimiento con los despachos. */
  async findUltimoMovimientoSinRecepcion(
    client: PoolClient,
    tenantId: string,
    combustibleId: number,
    excluirRecepcionId: number
  ): Promise<Date | null> {
    const r = await client.query<{ ultimo: Date | null }>(
      `SELECT GREATEST(
                (SELECT MAX(d.despachado_en) FROM combustible_despachos d
                  WHERE d.tenant_id = $1 AND d.combustible_id = $2 AND d.anulada_en IS NULL),
                (SELECT MAX(l.leido_en) FROM combustible_lecturas l
                  WHERE l.tenant_id = $1 AND l.combustible_id = $2 AND l.anulada_en IS NULL
                    AND l.origen <> 'inicial'),
                (SELECT MAX(r.recibido_en) FROM combustible_recepciones r
                  WHERE r.tenant_id = $1 AND r.combustible_id = $2 AND r.anulada_en IS NULL
                    AND r.id <> $3)
              ) AS ultimo`,
      [tenantId, combustibleId, excluirRecepcionId]
    );
    return r.rows[0]?.ultimo ?? null;
  }

  async findUltimoMovimiento(
    client: PoolClient,
    tenantId: string,
    combustibleId: number,
    excluirDespachoId: number
  ): Promise<Date | null> {
    const r = await client.query<{ ultimo: Date | null }>(
      `SELECT GREATEST(
                (SELECT MAX(d.despachado_en) FROM combustible_despachos d
                  WHERE d.tenant_id = $1 AND d.combustible_id = $2
                    AND d.anulada_en IS NULL AND d.id <> $3),
                (SELECT MAX(l.leido_en) FROM combustible_lecturas l
                  WHERE l.tenant_id = $1 AND l.combustible_id = $2
                    AND l.anulada_en IS NULL
                    -- La lectura del alta se estampa con NOW(), así que en un
                    -- tanque recién creado sería siempre "el movimiento más
                    -- reciente" y cualquier vale con fecha anterior alertaría.
                    -- Mismo motivo por el que la excluye detectarLecturaRetroactiva.
                    AND l.origen <> 'inicial')
              ) AS ultimo`,
      [tenantId, combustibleId, excluirDespachoId]
    );
    return r.rows[0]?.ultimo ?? null;
  }

  /** Las anulaciones previas de un número de vale (migración 0081).
   *
   *  La unicidad de 0067 es PARCIAL a propósito: un 00022 anulado más un
   *  00022 nuevo es la corrección de un tipeo, y prohibirla borraría del
   *  sistema un despacho que sí ocurrió. Esa misma migración anticipó que el
   *  patrón --un número con varias anulaciones-- sería en sí mismo la señal.
   *  Esto lo consulta.
   *
   *  Devuelve las cantidades anuladas y sus motivos, porque lo que importa no
   *  es que el número se reutilice sino QUE LA CANTIDAD CAMBIE. */
  async findAnulacionesDelVale(
    client: PoolClient,
    tenantId: string,
    producto: string,
    serieTalonario: string,
    nVale: number
  ) {
    const r = await client.query<{ cantidad: string; motivo_anulacion: string | null }>(
      `SELECT d.cantidad, d.motivo_anulacion
         FROM combustible_despachos d
        WHERE d.tenant_id = $1 AND d.producto = $2 AND d.serie_talonario = $3 AND d.n_vale = $4
          AND d.anulada_en IS NOT NULL
        ORDER BY d.anulada_en`,
      [tenantId, producto, serieTalonario, nVale]
    );
    return r.rows.map((f) => ({
      cantidad: Number(f.cantidad),
      motivo: f.motivo_anulacion,
    }));
  }

  /** Cada cuántos días de distancia entre la fecha del vale y su carga se
   *  considera retro-fechado (0081). Mismo COALESCE que el resto de la
   *  config: un tenant que nunca la tocó usa el default. */
  async getDiasCargaRetroactiva(client: PoolClient, tenantId: string): Promise<number> {
    const r = await client.query<{ dias: number }>(
      `SELECT COALESCE(
         (SELECT dias_carga_retroactiva FROM combustible_config WHERE tenant_id = $1),
         3
       ) AS dias`,
      [tenantId]
    );
    return Number(r.rows[0].dias);
  }

  /** El ancla de una alerta: sobre QUÉ es. Un vale (los tipos que salen de
   *  un despacho), un tanque (nivel bajo) o una recepción (diferencia).
   *  Al menos una tiene que venir -- lo garantiza también el CHECK
   *  `combustible_alertas_ancla_check` de la migración 0073. */
  private static columnasAlerta(f: AlertaNueva) {
    return {
      tipo: f.tipo,
      serie_talonario: f.serieTalonario ?? null,
      n_vale: f.nVale ?? null,
      despacho_id: f.despachoId ?? null,
      combustible_id: f.combustibleId ?? null,
      recepcion_id: f.recepcionId ?? null,
      lectura_id: f.lecturaId ?? null,
      urea_conteo_id: f.ureaConteoId ?? null,
      producto: f.producto ?? "combustible",
      detalle: JSON.stringify(f.detalle),
    };
  }

  async crearAlertas(client: PoolClient, tenantId: string, filas: AlertaNueva[]) {
    if (filas.length === 0) return [];
    const valores: unknown[] = [];
    const placeholders = filas.map((f) => {
      const c = CombustibleRepository.columnasAlerta(f);
      const fila = [
        tenantId,
        c.tipo,
        c.serie_talonario,
        c.n_vale,
        c.despacho_id,
        c.combustible_id,
        c.recepcion_id,
        c.lectura_id,
        c.urea_conteo_id,
        c.producto,
        c.detalle,
      ];
      const base = valores.length;
      valores.push(...fila);
      return `(${fila.map((_, j) => `$${base + j + 1}`).join(",")})`;
    });
    const result = await client.query(
      `
      INSERT INTO combustible_alertas
        (tenant_id, tipo, serie_talonario, n_vale, despacho_id, combustible_id, recepcion_id,
         lectura_id, urea_conteo_id, producto, detalle)
      VALUES ${placeholders.join(",")}
      RETURNING id, tipo, serie_talonario, n_vale, despacho_id, combustible_id, recepcion_id,
        lectura_id, urea_conteo_id, producto, detalle, creado_en
      `,
      valores
    );
    return result.rows;
  }

  async findAlertas(
    client: PoolClient,
    tenantId: string,
    filtros: { soloNoLeidas?: boolean; producto?: string },
    { pageSize, offset }: Paginacion
  ) {
    const condiciones: string[] = ["tenant_id = $1"];
    const valores: unknown[] = [tenantId];

    if (filtros.soloNoLeidas) {
      condiciones.push("leida_en IS NULL");
    }
    if (filtros.producto !== undefined) {
      valores.push(filtros.producto);
      condiciones.push(`producto = $${valores.length}`);
    }

    valores.push(pageSize, offset);
    const result = await client.query(
      `
      SELECT id, tipo, serie_talonario, n_vale, despacho_id, combustible_id,
        recepcion_id, lectura_id, producto, detalle, creado_en, leida_en, resuelta_en,
        resuelta_por, congelada_en, COUNT(*) OVER() AS total_count
      FROM combustible_alertas
      WHERE ${condiciones.join(" AND ")}
      ORDER BY creado_en DESC, id DESC
      LIMIT $${valores.length - 1} OFFSET $${valores.length}
      `,
      valores
    );
    return result.rows;
  }

  async marcarAlertasLeidas(client: PoolClient, tenantId: string, ids?: number[]) {
    if (ids && ids.length > 0) {
      await client.query(
        `UPDATE combustible_alertas SET leida_en = now()
         WHERE tenant_id = $1 AND id = ANY($2::bigint[]) AND leida_en IS NULL`,
        [tenantId, ids]
      );
      return;
    }
    await client.query(
      `UPDATE combustible_alertas SET leida_en = now()
       WHERE tenant_id = $1 AND leida_en IS NULL`,
      [tenantId]
    );
  }

  /** QUIÉNES participaron del hecho sobre el que se abrió esta alerta.
   *
   *  Sirve para una sola pregunta, la de segregación de funciones: ¿el que
   *  está cerrando la alerta es alguien que participó de lo que la disparó?
   *  Un auditor la hace siempre.
   *
   *  Hasta la 5ª auditoría miraba solo quién cargó el despacho o la recepción,
   *  y eso dejaba afuera justo las alertas más importantes: las de DESCUADRE
   *  cuelgan de una varilla, no de un vale, así que cerrar la alerta de la
   *  varilla propia nunca contaba como autorrevisión. Verificado: el mismo
   *  admin midió 1.000 L de menos, cerró la alerta con "error de varilla" y
   *  quedó `autorevision: false`.
   *
   *  Ahora cuentan tres participaciones, sobre las tres anclas posibles:
   *  - quien CARGÓ el movimiento (despacho, recepción o varilla);
   *  - quien lo ANULÓ, si la alerta es por una anulación: anular el vale ajeno
   *    y después cerrar uno mismo la alerta de esa anulación es revisarse a sí
   *    mismo igual;
   *  - para la recepción, quien la VALIDÓ contra la guía (0087).
   *
   *  Devuelve [] cuando no hay a quién señalar: alertas de estado del tanque
   *  (nivel bajo, sin medir) o filas de antes de que se guardara el usuario. */
  async findParticipantesDelHecho(
    client: PoolClient,
    tenantId: string,
    alertaId: number
  ): Promise<string[]> {
    const r = await client.query<{ participantes: (string | null)[] }>(
      `
      SELECT ARRAY[d.usuario_id, d.anulada_por,
                   rec.usuario_id, rec.anulada_por, rec.validada_por,
                   l.usuario_id, l.anulada_por]::text[] AS participantes
        FROM combustible_alertas a
        LEFT JOIN combustible_despachos d
               ON d.id = a.despacho_id AND d.tenant_id = $1
        LEFT JOIN combustible_recepciones rec
               ON rec.id = a.recepcion_id AND rec.tenant_id = $1
        LEFT JOIN combustible_lecturas l
               ON l.id = a.lectura_id AND l.tenant_id = $1
       WHERE a.id = $2 AND a.tenant_id = $1
      `,
      [tenantId, alertaId]
    );
    const fila = r.rows[0];
    if (!fila) return [];
    return [...new Set(fila.participantes.filter((u): u is string => u !== null))];
  }

  async resolverAlertaManual(
    client: PoolClient,
    tenantId: string,
    alertaId: number,
    usuarioId: string,
    motivo: string,
    autorevision: boolean
  ) {
    const result = await client.query(
      `
      UPDATE combustible_alertas
      SET resuelta_en = now(),
          resuelta_por = $1,
          detalle = detalle || jsonb_build_object(
            'motivo_revision', $4::text,
            -- Queda EN LA FILA y no solo en la auditoría: la alerta es lo que
            -- alguien va a mirar dentro de seis meses, y "esto lo cerró el
            -- mismo que lo hizo" es parte del hallazgo, no un metadato.
            'autorevision', $6::boolean
          )
      WHERE id = $2 AND tenant_id = $3
        AND tipo = ANY($5::text[]) AND resuelta_en IS NULL
      RETURNING id, tipo, serie_talonario, n_vale, despacho_id, detalle, creado_en, leida_en, resuelta_en, resuelta_por
      `,
      [usuarioId, alertaId, tenantId, motivo, TIPOS_REVISABLES, autorevision]
    );
    return result.rows[0] ?? null;
  }

  /** Destinatarios de correo/campanita: "gerencia" es el rol admin, sin
   *  concepto propio en el modelo de datos -- y solo los que además tienen
   *  el módulo combustible habilitado, mismo criterio que
   *  obtenerModulosPermitidos() en auth.service.ts pero a la inversa (de
   *  módulo a lista de usuarios, no de usuario a lista de módulos). */
  /** Delega en el helper compartido: la consulta no tenía nada de
   *  combustible salvo el nombre del módulo escrito a mano. */
  async findAdminsConCombustibleHabilitado(client: PoolClient, tenantId: string) {
    return findAdminsConModulo(client, tenantId, "combustible");
  }

  // ── Grifos externos (migrations/0063) ────────────────────────────────

  async findGrifos(client: PoolClient, tenantId: string) {
    const result = await client.query(
      `SELECT id, nombre, activo, abastece_ruta, abastece_tanque, abastece_urea, usuario_id, creado_en
       FROM combustible_grifos WHERE tenant_id = $1 ORDER BY nombre ASC`,
      [tenantId]
    );
    return result.rows;
  }

  async findGrifoPorId(client: PoolClient, tenantId: string, id: number) {
    const result = await client.query(
      `SELECT id, nombre, activo, abastece_ruta, abastece_tanque, abastece_urea, usuario_id, creado_en
       FROM combustible_grifos WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );
    return result.rows[0] ?? null;
  }

  async crearGrifo(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    data: {
      nombre: string;
      abasteceRuta: boolean;
      abasteceTanque: boolean;
      abasteceUrea: boolean;
    }
  ) {
    try {
      const result = await client.query(
        `INSERT INTO combustible_grifos
           (tenant_id, nombre, abastece_ruta, abastece_tanque, abastece_urea, usuario_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, nombre, activo, abastece_ruta, abastece_tanque, abastece_urea, usuario_id, creado_en`,
        [
          tenantId,
          data.nombre,
          data.abasteceRuta,
          data.abasteceTanque,
          data.abasteceUrea,
          usuarioId,
        ]
      );
      return result.rows[0];
    } catch (err) {
      if (esViolacionUnicidad(err)) {
        throw new Error(`ya existe un proveedor llamado "${data.nombre}" en este tenant`, {
          cause: err,
        });
      }
      throw err;
    }
  }

  async actualizarGrifo(
    client: PoolClient,
    tenantId: string,
    id: number,
    data: {
      nombre: string;
      activo: boolean;
      abasteceRuta: boolean;
      abasteceTanque: boolean;
      abasteceUrea: boolean;
    }
  ) {
    try {
      const result = await client.query(
        `UPDATE combustible_grifos
         SET nombre = $1, activo = $2, abastece_ruta = $3, abastece_tanque = $4, abastece_urea = $5
         WHERE id = $6 AND tenant_id = $7
         RETURNING id, nombre, activo, abastece_ruta, abastece_tanque, abastece_urea, usuario_id, creado_en`,
        [
          data.nombre,
          data.activo,
          data.abasteceRuta,
          data.abasteceTanque,
          data.abasteceUrea,
          id,
          tenantId,
        ]
      );
      return result.rows[0] ?? null;
    } catch (err) {
      if (esViolacionUnicidad(err)) {
        throw new Error(`ya existe un proveedor llamado "${data.nombre}" en este tenant`, {
          cause: err,
        });
      }
      throw err;
    }
  }

  // ── Precios de combustible (migrations/0063) ─────────────────────────

  private static readonly COLUMNAS_PRECIO = `
    id, tenant_id, tipo_combustible, combustible_id, grifo_id, precio_unitario,
    vigente_desde, usuario_id, creado_en, anulada_en, anulada_por, motivo_anulacion
  `;

  async crearPrecio(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    data: {
      tipoCombustible: string;
      combustibleId: number | null;
      grifoId: number | null;
      precioUnitario: number;
      vigenteDesde: string;
    }
  ) {
    try {
      const result = await client.query(
        `
        INSERT INTO combustible_precios (
          tenant_id, tipo_combustible, combustible_id, grifo_id, precio_unitario,
          vigente_desde, usuario_id
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        RETURNING ${CombustibleRepository.COLUMNAS_PRECIO}
        `,
        [
          tenantId,
          data.tipoCombustible,
          data.combustibleId,
          data.grifoId,
          data.precioUnitario,
          data.vigenteDesde,
          usuarioId,
        ]
      );
      return result.rows[0];
    } catch (err) {
      if (esViolacionForeignKey(err)) {
        const constraint = (err as { constraint?: string }).constraint ?? "";
        if (constraint.includes("combustible_id")) {
          throw new Error(`combustible_id ${data.combustibleId} no existe en este tenant`, {
            cause: err,
          });
        }
        if (constraint.includes("grifo_id")) {
          throw new Error(`el proveedor ${data.grifoId} no existe en este tenant`, { cause: err });
        }
      }
      throw err;
    }
  }

  /** Listado del historial de precios, más reciente primero -- misma forma
   *  que findLecturas (dos LEFT JOIN a usuarios, por quién cargó y quién
   *  anuló). Sin paginación real todavía: el volumen esperado (unos pocos
   *  tanques/grifos, precios que cambian cada tanto) es chico -- si crece,
   *  se le suma después el mismo patrón de `Paginacion` que ya usa
   *  findLecturas. */
  async findPrecios(client: PoolClient, tenantId: string) {
    const result = await client.query(
      `
      SELECT p.id, p.tipo_combustible, p.combustible_id, p.grifo_id, p.precio_unitario,
             p.vigente_desde, p.usuario_id, p.creado_en,
             p.anulada_en, p.anulada_por, p.motivo_anulacion,
             c.tanque_nombre, g.nombre AS grifo_nombre,
             autor.nombre AS registrado_por_nombre,
             anulador.nombre AS anulado_por_nombre
      FROM combustible_precios p
      LEFT JOIN combustible c ON c.id = p.combustible_id
      LEFT JOIN combustible_grifos g ON g.id = p.grifo_id
      LEFT JOIN usuarios autor ON autor.id = p.usuario_id
      LEFT JOIN usuarios anulador ON anulador.id = p.anulada_por
      WHERE p.tenant_id = $1
      ORDER BY p.vigente_desde DESC, p.id DESC
      `,
      [tenantId]
    );
    return result.rows;
  }

  async findPrecioPorId(client: PoolClient, tenantId: string, id: number) {
    const result = await client.query(
      `SELECT id, combustible_id, grifo_id, anulada_en
       FROM combustible_precios WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );
    return result.rows[0] ?? null;
  }

  /** El precio "vigente" a una fecha: el más reciente cuyo vigente_desde
   *  no supere esa fecha, ignorando los anulados -- si el más nuevo está
   *  anulado, cae solo al anterior válido (mismo criterio que
   *  combustible_lecturas: la fila anulada deja de contar, pero no se
   *  borra). Exactamente uno de combustibleId/grifoId viene con valor --
   *  lo garantiza el caller (combustible.service.ts). */
  async findPrecioVigente(
    client: PoolClient,
    tenantId: string,
    tipoCombustible: string,
    destino: { combustibleId: number | null; grifoId: number | null },
    fecha: string
  ) {
    const columna = destino.combustibleId !== null ? "combustible_id" : "grifo_id";
    const valor = destino.combustibleId ?? destino.grifoId;
    const result = await client.query(
      `
      SELECT ${CombustibleRepository.COLUMNAS_PRECIO}
      FROM combustible_precios
      WHERE tenant_id = $1 AND tipo_combustible = $2 AND ${columna} = $3
        AND anulada_en IS NULL AND vigente_desde <= $4
      ORDER BY vigente_desde DESC, id DESC
      LIMIT 1
      `,
      [tenantId, tipoCombustible, valor, fecha]
    );
    return result.rows[0] ?? null;
  }

  /** Anula un precio mal cargado -- mismo mecanismo exacto que
   *  anularLectura: nunca se borra ni se edita, el UPDATE lleva
   *  `anulada_en IS NULL` en el WHERE para que dos anulaciones simultáneas
   *  no se pisen (ver fix_race_condition_iperc_estado). */
  async anularPrecio(
    client: PoolClient,
    tenantId: string,
    precioId: number,
    usuarioId: string,
    motivo: string
  ) {
    const result = await client.query(
      `
      UPDATE combustible_precios
      SET anulada_en = now(), anulada_por = $1, motivo_anulacion = $2
      WHERE id = $3 AND tenant_id = $4 AND anulada_en IS NULL
      RETURNING ${CombustibleRepository.COLUMNAS_PRECIO}
      `,
      [usuarioId, motivo, precioId, tenantId]
    );
    return result.rows[0] ?? null;
  }

  // ── Recepciones (Fase C, ver migrations/0064) ─────────────────────────

  // costo_total no se persiste, se calcula -- mismo criterio que el
  // costo_total de un despacho (0063) y que `porcentaje` en COLUMNAS_TANQUE.
  private static readonly COLUMNAS_RECEPCION = `
    id, tenant_id, producto, combustible_id, grifo_id, cantidad, costo_unitario,
    (cantidad * costo_unitario) AS costo_total,
    presentacion, factor_litros, cantidad_bultos,
    tipo_documento, numero_documento, recibido_en, usuario_id, creado_en,
    anulada_en, anulada_por, motivo_anulacion,
    requiere_validacion, cantidad_documento, validada_en, validada_por
  `;

  /** Los datos del tanque que la Fase C necesita para validar una recepción
   *  -- capacidad y las dos columnas de configuración que agregó 0064. Va
   *  aparte de `findById` porque eso devuelve la fila "de presentación"
   *  (con el nivel derivado y el porcentaje), y acá hacen falta los crudos.
   *
   *  Devuelve null si el tanque no existe en este tenant -- el service lo
   *  traduce a un 400 legible en vez de dejar reventar la FK. */
  async findTanqueParaRecepcion(client: PoolClient, tenantId: string, combustibleId: number) {
    const result = await client.query<{
      id: number;
      capacidad_total: string;
      tolerancia_capacidad_pct: string;
      requiere_documento: boolean;
    }>(
      `SELECT id, capacidad_total, tolerancia_capacidad_pct, requiere_documento
       FROM combustible WHERE id = $1 AND tenant_id = $2`,
      [combustibleId, tenantId]
    );
    return result.rows[0] ?? null;
  }

  /** El nivel medido del tanque A UNA FECHA: la última lectura vigente
   *  cuyo `leido_en` no supere esa fecha. Mismo mecanismo que
   *  JOIN_ULTIMA_LECTURA (incluido el desempate por id, ver su comentario),
   *  pero con techo de fecha -- una recepción cargada tarde tiene que
   *  valorizarse contra el nivel que el tanque tenía EL DÍA que entró el
   *  combustible, no contra el de hoy.
   *
   *  Devuelve null si no hay ninguna lectura vigente anterior. Eso NO es
   *  "el tanque estaba vacío": es "no sabemos cuánto había" -- la distinción
   *  que estableció la migración 0059 y de la que depende que el costo
   *  promedio signifique algo (ver el comentario de recalcularCostoPromedio). */
  async findNivelVigenteA(
    client: PoolClient,
    tenantId: string,
    combustibleId: number,
    fecha: string
  ): Promise<number | null> {
    const result = await client.query<{ nivel: string }>(
      `
      SELECT l.nivel
      FROM combustible_lecturas l
      WHERE l.combustible_id = $1 AND l.tenant_id = $2
        AND l.anulada_en IS NULL AND l.leido_en <= $3
      ORDER BY l.leido_en DESC, l.id DESC
      LIMIT 1
      `,
      [combustibleId, tenantId, fecha]
    );
    if (result.rows.length === 0) return null;
    return Number(result.rows[0].nivel);
  }

  /** Recalcula `combustible.costo_promedio` DESDE CERO, reproduciendo en
   *  orden cronológico todas las recepciones vigentes del tanque.
   *
   *  ── Por qué replay completo y no un update incremental ──────────────
   *  El promedio ponderado es secuencial: cada recepción se apoya en el
   *  promedio que dejó la anterior. Eso hace que una anulación NO se pueda
   *  deshacer restando (no existe la operación inversa de una mezcla: si
   *  anulás una recepción vieja, todas las posteriores se calcularon sobre
   *  una base que ya no vale). Reproducir todo es la única forma de que el
   *  número quede bien sin importar QUÉ se anuló ni en qué orden.
   *  Es la misma lección que la migración 0059: no guardes estado mutable
   *  que podés derivar. El volumen lo permite de sobra -- las recepciones
   *  son semanales o mensuales, no una por despacho.
   *
   *  ── La primera recepción define el promedio ─────────────────────────
   *  Ojo con el caso de arranque, que es sutil: NO se puede empezar con
   *  `promedio = 0` y aplicarle la fórmula ponderada, porque si el tanque
   *  ya tenía combustible ese 0 se mete en la mezcla como si ese
   *  combustible hubiera salido gratis, y hunde el promedio. Ejemplo real:
   *  tanque con 1.000 gal, entra una recepción de 500 a S/18 ->
   *  (1000*0 + 500*18) / 1500 = S/6, un número que no significa nada.
   *
   *  Lo correcto es que la PRIMERA recepción vigente fije el promedio en su
   *  propio costo unitario. Equivale a asumir que lo que ya había costó lo
   *  mismo que esta primera compra conocida -- que es la única suposición
   *  honesta cuando no hay ningún dato de costo anterior (el módulo recién
   *  empieza a registrar compras acá), y se autocorrige a medida que entran
   *  recepciones reales.
   *
   *  Mismo tratamiento cuando el nivel a esa fecha es desconocido (no hay
   *  lectura vigente anterior, o la que había se anuló después): sin nivel
   *  no hay con qué ponderar, así que esa recepción vuelve a fijar el
   *  promedio en vez de inventar un peso. */
  async recalcularCostoPromedio(client: PoolClient, tenantId: string, combustibleId: number) {
    // Una sola consulta: cada recepción vigente ya trae resuelto el nivel
    // medido a SU fecha, vía LATERAL. Evita el N+1 de pedir la lectura por
    // separado para cada fila del replay.
    const recepciones = await client.query<{
      cantidad: string;
      costo_unitario: string;
      nivel_antes: string | null;
    }>(
      `
      SELECT r.cantidad, r.costo_unitario, nivel.nivel AS nivel_antes
      FROM combustible_recepciones r
      LEFT JOIN LATERAL (
        SELECT l.nivel
        FROM combustible_lecturas l
        WHERE l.combustible_id = r.combustible_id AND l.anulada_en IS NULL
          AND l.leido_en <= r.recibido_en
        ORDER BY l.leido_en DESC, l.id DESC
        LIMIT 1
      ) nivel ON true
      WHERE r.tenant_id = $1 AND r.combustible_id = $2 AND r.anulada_en IS NULL
      ORDER BY r.recibido_en ASC, r.id ASC
      `,
      [tenantId, combustibleId]
    );

    let promedio = 0;
    let esPrimera = true;

    for (const fila of recepciones.rows) {
      const cantidad = Number(fila.cantidad);
      const costoUnitario = Number(fila.costo_unitario);
      const nivelAntes = fila.nivel_antes === null ? null : Number(fila.nivel_antes);

      // Ver el comentario largo de arriba: sin promedio previo o sin nivel
      // con qué ponderar, esta recepción FIJA el promedio, no lo mezcla.
      if (esPrimera || nivelAntes === null) {
        promedio = costoUnitario;
        esPrimera = false;
        continue;
      }

      const total = nivelAntes + cantidad;
      // total nunca es 0 acá (cantidad > 0 por CHECK, nivelAntes >= 0), pero
      // la guarda cuesta nada y evita un NaN silencioso si eso cambiara.
      promedio =
        total === 0 ? costoUnitario : (nivelAntes * promedio + cantidad * costoUnitario) / total;
    }

    // Sin recepciones vigentes (todas anuladas, o ninguna todavía) el
    // promedio vuelve a 0: es el valor con el que nace la columna en 0057 y
    // significa "no hay ninguna compra registrada de la que derivar costo".
    await client.query(
      `UPDATE combustible SET costo_promedio = $1 WHERE id = $2 AND tenant_id = $3`,
      [promedio, combustibleId, tenantId]
    );

    return promedio;
  }

  /** Inserta la recepción. Las validaciones que dependen de otras filas
   *  (que el tanque exista, la capacidad con su tolerancia, la
   *  obligatoriedad del documento) ya las hizo el service -- acá solo queda
   *  traducir las violaciones de FK a mensajes que el controller reconozca,
   *  mismo patrón que crearDespacho/crearPrecio. */
  async crearRecepcion(
    client: PoolClient,
    tenantId: string,
    usuarioId: string | null,
    data: {
      producto: string;
      combustibleId: number | null;
      grifoId: number;
      cantidad: number;
      presentacion: string | null;
      factorLitros: number | null;
      cantidadBultos: number | null;
      costoUnitario: number;
      tipoDocumento: string | null;
      numeroDocumento: string | null;
      recibidoEn: string;
      /** Política vigente al momento de registrarla (0088). Se estampa en la
       *  fila y no se consulta después: apagar la política mañana no puede
       *  borrar las validaciones que hoy se deben. */
      requiereValidacion: boolean;
    }
  ) {
    try {
      const result = await client.query(
        `
        INSERT INTO combustible_recepciones (
          tenant_id, producto, combustible_id, grifo_id, cantidad,
          presentacion, factor_litros, cantidad_bultos, costo_unitario,
          tipo_documento, numero_documento, recibido_en, usuario_id, requiere_validacion
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        RETURNING ${CombustibleRepository.COLUMNAS_RECEPCION}
        `,
        [
          tenantId,
          data.producto,
          data.combustibleId,
          data.grifoId,
          data.cantidad,
          data.presentacion,
          data.factorLitros,
          data.cantidadBultos,
          data.costoUnitario,
          data.tipoDocumento,
          data.numeroDocumento,
          data.recibidoEn,
          usuarioId,
          data.requiereValidacion,
        ]
      );
      return result.rows[0];
    } catch (err) {
      if (esViolacionForeignKey(err)) {
        const constraint = (err as { constraint?: string }).constraint ?? "";
        if (constraint.includes("grifo_id")) {
          throw new Error(`el proveedor ${data.grifoId} no existe en este tenant`, { cause: err });
        }
        if (constraint.includes("combustible_id")) {
          throw new Error(`combustible_id ${data.combustibleId} no existe en este tenant`, {
            cause: err,
          });
        }
      }
      throw err;
    }
  }

  /** Historial de recepciones -- misma forma que findPrecios: resuelve del
   *  lado del servidor los nombres de tanque/grifo y los dos usuarios (quién
   *  registró y quién anuló). Paginado como findLecturas/findDespachos: a
   *  diferencia de los precios, esto crece con la operación.
   *
   *  ── `diferencia_litros`: lo facturado contra lo medido ────────────────
   *
   *  Es el número que delata una entrega corta (el proveedor factura 6.000 y
   *  descarga 5.800). Se calcula solo, por recepción:
   *
   *      (nivel_después − nivel_antes) + despachos_en_la_ventana − cantidad
   *
   *  donde "antes" es la última lectura vigente hasta `recibido_en` y
   *  "después" la primera posterior. Los despachos de la ventana se suman de
   *  vuelta porque son salidas legítimas: sin eso, cargar combustible a un
   *  volquete entre las dos lecturas se vería como faltante.
   *
   *  Negativo = entró menos de lo facturado. Positivo = entró más.
   *
   *  **Devuelve NULL, y eso es deliberado, en dos casos:**
   *  - Falta alguna de las dos lecturas. Sin medición no hay comparación
   *    posible, y estimar sería exactamente lo que este módulo no hace.
   *  - Hubo OTRA recepción entre las dos lecturas. Ahí la diferencia
   *    pertenece a las dos entregas juntas y no se puede atribuir a una;
   *    decir "esta entrega vino corta" sin poder probarlo señalaría a un
   *    proveedor por el faltante de otro.
   *
   *  Esto NO es todavía el motor de conciliación (Fase D): es un dato por
   *  fila, calculado al leer, sin período ni cierre ni `combustible_anomalias`.
   *  Existe desde ahora para que la muestra empiece a acumularse -- sin
   *  historial no hay con qué calibrar el umbral después. */
  async findRecepciones(
    client: PoolClient,
    tenantId: string,
    filtros: { combustibleId?: number; producto?: string } & PeriodoHistorial,
    { pageSize, offset }: Paginacion,
    alcance?: AlcanceCombustible
  ) {
    const condiciones: string[] = ["r.tenant_id = $1"];
    const valores: unknown[] = [tenantId];

    if (filtros.combustibleId !== undefined) {
      valores.push(filtros.combustibleId);
      condiciones.push(`r.combustible_id = $${valores.length}`);
    }
    if (filtros.producto !== undefined) {
      valores.push(filtros.producto);
      condiciones.push(`r.producto = $${valores.length}`);
    }
    agregarPeriodo(condiciones, valores, "r.recibido_en", filtros);
    // La recepción es del grifo entero (0100); la de urea, de la empresa.
    if (alcance && !alcance.todo) {
      const f = filtroHechoDeGrifo(alcance, "r", valores.length + 1);
      valores.push(...f.valores);
      condiciones.push(`(r.producto = 'urea' OR ${f.sql})`);
    }

    valores.push(pageSize, offset);
    const result = await client.query(
      `
      SELECT r.id, r.producto, r.combustible_id, r.grifo_id, r.cantidad, r.costo_unitario,
             (r.cantidad * r.costo_unitario) AS costo_total,
             r.presentacion, r.factor_litros, r.cantidad_bultos,
             r.tipo_documento, r.numero_documento, r.recibido_en, r.usuario_id,
             r.creado_en, r.anulada_en, r.anulada_por, r.motivo_anulacion,
             r.requiere_validacion, r.cantidad_documento, r.validada_en, r.validada_por,
             c.tanque_nombre, g.nombre AS grifo_nombre,
             c.umbral_diferencia_pct,
             autor.nombre AS registrada_por_nombre,
             anulador.nombre AS anulada_por_nombre,
             -- Cuánto se midió de menos (o de más) respecto de lo facturado.
             -- NULL cuando no se puede atribuir a ESTA entrega -- ver el
             -- comentario largo arriba de findRecepciones.
             dif.diferencia_litros,
             dif.nivel_antes,
             dif.nivel_despues,
             -- > 1 = la diferencia es de varias entregas juntas (ver
             -- LATERAL_DIFERENCIA_RECEPCION): la UI lo tiene que decir.
             dif.entregas_en_grupo,
             validador.nombre AS validada_por_nombre,
             COUNT(*) OVER() AS total_count
      FROM combustible_recepciones r
      -- LEFT para el tanque (0092): una recepción de urea no tiene
      -- combustible_id, y un INNER JOIN acá la sacaría del listado entero
      -- en silencio -- la urea desaparecería de /recepciones sin ningún
      -- error. El JOIN a grifos sigue INNER: grifo_id es NOT NULL para los dos
      -- productos. Los usuarios siguen LEFT, nullable por ON DELETE SET
      -- NULL -- mismo criterio que findLecturas/findPrecios.
      LEFT JOIN combustible c ON c.id = r.combustible_id AND c.tenant_id = r.tenant_id
      JOIN combustible_grifos g ON g.id = r.grifo_id
      LEFT JOIN usuarios autor ON autor.id = r.usuario_id
      LEFT JOIN usuarios anulador ON anulador.id = r.anulada_por
      LEFT JOIN usuarios validador ON validador.id = r.validada_por
      ${LATERAL_DIFERENCIA_RECEPCION}
      WHERE ${condiciones.join(" AND ")}
      ORDER BY r.recibido_en DESC, r.id DESC
      LIMIT $${valores.length - 1} OFFSET $${valores.length}
      `,
      valores
    );
    return result.rows;
  }

  /** Entrega 3 de Fase D: la muestra cruda para el asistente de
   *  calibración del umbral -- mismo cálculo de `diferencia_litros` que
   *  findRecepciones (ver el comentario largo de ahí), sin paginar y sin
   *  las columnas que ese endpoint necesita para mostrar la tabla. Solo
   *  recepciones VIGENTES: una anulada no es una entrega real, incluirla
   *  contaminaría la muestra con algo que nunca pasó. */
  async findMuestraDiferenciasParaCalibracion(
    client: PoolClient,
    tenantId: string,
    combustibleId: number
  ): Promise<
    Array<{
      cantidad: number;
      diferencia_litros: number;
      recibido_en: Date;
      documento: string | null;
      nivel_antes: number;
      nivel_despues: number;
      salidas: number;
    }>
  > {
    // Los pasos de la cuenta (nivel antes, nivel después, salidas del medio)
    // viajan junto al resultado para que la exportación los muestre: una
    // diferencia sin su cuenta no le dice nada a quien tiene que decidir si
    // el proveedor vino corto.
    const result = await client.query<{
      cantidad: string;
      diferencia_litros: string;
      recibido_en: Date;
      documento: string | null;
      nivel_antes: string;
      nivel_despues: string;
      salidas: string;
    }>(
      `
      SELECT r.cantidad, dif.diferencia_litros, r.recibido_en,
             NULLIF(CONCAT_WS(' ', r.tipo_documento, r.numero_documento), '') AS documento,
             dif.nivel_antes, dif.nivel_despues, dif.salidas
      FROM combustible_recepciones r
      ${LATERAL_DIFERENCIA_RECEPCION}
      WHERE r.tenant_id = $1 AND r.combustible_id = $2 AND r.anulada_en IS NULL
        AND dif.diferencia_litros IS NOT NULL
        -- La calibración sigue usando solo entregas SOLAS: el error de una
        -- entrega combinada mezcla dos cisternas y dos medidores, y meterlo
        -- en la muestra ensancharía el umbral de todas.
        AND dif.entregas_en_grupo = 1
      `,
      [tenantId, combustibleId]
    );
    return result.rows.map((f) => ({
      cantidad: Number(f.cantidad),
      diferencia_litros: Number(f.diferencia_litros),
      recibido_en: f.recibido_en,
      documento: f.documento,
      nivel_antes: Number(f.nivel_antes),
      nivel_despues: Number(f.nivel_despues),
      salidas: Number(f.salidas),
    }));
  }

  /** La muestra para calibrar los DOS umbrales de descuadre: un punto por
   *  cada intervalo entre lecturas vigentes consecutivas.
   *
   *      descuadre = nivel − (nivel_anterior + recepciones − despachos)
   *
   *  Es la misma cuenta que hace `findDatosDescuadre` en vivo, pero sobre
   *  todo el historial de una sola pasada, con `LAG()` en vez de un LIMIT 1
   *  por fila: para un tanque con cientos de lecturas, la versión correlada
   *  haría cientos de subconsultas.
   *
   *  Devuelve también `recepciones` y el instante de cada intervalo, porque
   *  con eso el service arma la muestra del CICLO sin volver a la base: los
   *  descuadres de los intervalos de un ciclo se suman (telescopan) y dan el
   *  acumulado del ciclo. Un intervalo con recepción adentro es el que abre
   *  un ciclo nuevo.
   *
   *  El desempate `(leido_en, id)` es el mismo del resto del módulo: dos
   *  lecturas del mismo minuto tienen que ordenarse siempre igual, o la
   *  muestra cambiaría entre corridas. */
  /** El descuadre acumulado de los últimos N días (migración 0080). Suma
   *  todos los tramos de la ventana SIN cortar en ninguna recepción -- que
   *  es la diferencia entera con findSaldoCiclo, donde cada recepción
   *  reinicia la cuenta y por eso robar de a poco salía gratis.
   *
   *  Suma CON SIGNO. Un faltante y un sobrante se cancelan, y eso es lo
   *  buscado: el error de varilla es aleatorio y se anula en un mes; el robo
   *  es sistemático y se acumula. Ver el encabezado de la migración.
   *
   *  Las recepciones y los despachos SÍ entran en la cuenta de cada tramo
   *  (son movimiento legítimo declarado); lo que no hacen es cortar la
   *  ventana. */
  /** EL FALTANTE MEDIDO ENTRE DOS INSTANTES, ignorando cualquier umbral.
   *
   *  Es la mitad que le faltaba al reporte de controles, y la encontró un red
   *  team simulando nueve días de operación: se subieron los tres umbrales a
   *  60 %, se sacaron 3.000 L SIN emitir vale, y el reporte del período dijo
   *  "0 L bajo vigilancia reducida". El evento de aflojamiento estaba, con
   *  quién y con el motivo -- pero el número que lo acompañaba contaba solo
   *  DESPACHOS DECLARADOS.
   *
   *  Y aflojar el umbral sirve justamente para sacar combustible sin vale.
   *  O sea que el reporte medía todo menos lo que el aflojamiento habilita.
   *
   *  Acá se calcula lo que dice LA VARILLA: la suma con signo de los
   *  descuadres de cada tramo del período. Sin mirar el umbral -- el umbral
   *  decide si se ALERTA, nunca si el número existe. Ese es el punto: durante
   *  la ventana floja el sistema calla a propósito, y este reporte se lee
   *  después, cuando lo que hace falta es el número.
   *
   *  `combustibleId` NULL suma todos los tanques del tenant: hay
   *  aflojamientos que son de configuración de la empresa y no cuelgan de un
   *  tanque.
   *
   *  Devuelve `tramos: 0` cuando no hubo mediciones en la ventana. Quien lo
   *  llama tiene que distinguir eso de un cero real: "no se midió" y "cuadra"
   *  no son lo mismo, y confundirlos sería repetir el error que este arreglo
   *  viene a corregir. */
  async findDescuadreEntre(
    client: PoolClient,
    tenantId: string,
    desde: string,
    hasta: string,
    combustibleId?: number | null
  ) {
    const result = await client.query<{ descuadre_total: string; tramos: string }>(
      `
      WITH lecturas AS (
        SELECT l.combustible_id, l.nivel, l.leido_en, l.id,
               LAG(l.nivel) OVER (PARTITION BY l.combustible_id
                                  ORDER BY l.leido_en, l.id) AS nivel_anterior,
               LAG(l.leido_en) OVER (PARTITION BY l.combustible_id
                                     ORDER BY l.leido_en, l.id) AS leido_en_anterior
          FROM combustible_lecturas l
         WHERE l.tenant_id = $1
           AND l.anulada_en IS NULL
           AND l.leido_en <= $3::timestamptz
           AND ($4::int IS NULL OR l.combustible_id = $4::int)
      )
      SELECT COALESCE(SUM(
               le.nivel - (le.nivel_anterior + COALESCE(rec.total, 0) - COALESCE(des.total, 0))
             ), 0) AS descuadre_total,
             COUNT(*) AS tramos
        FROM lecturas le
        LEFT JOIN LATERAL (
          SELECT SUM(d.cantidad) AS total
            FROM combustible_despachos d
           WHERE d.tenant_id = $1 AND d.combustible_id = le.combustible_id
             AND d.anulada_en IS NULL
             AND d.despachado_en > le.leido_en_anterior AND d.despachado_en <= le.leido_en
        ) des ON true
        LEFT JOIN LATERAL (
          SELECT SUM(r.cantidad) AS total
            FROM combustible_recepciones r
           WHERE r.tenant_id = $1 AND r.combustible_id = le.combustible_id
             AND r.anulada_en IS NULL
             AND r.recibido_en > le.leido_en_anterior AND r.recibido_en <= le.leido_en
        ) rec ON true
       WHERE le.nivel_anterior IS NOT NULL
         AND le.leido_en > $2::timestamptz
      `,
      [tenantId, desde, hasta, combustibleId ?? null]
    );
    return {
      descuadre: Number(result.rows[0].descuadre_total),
      tramos: Number(result.rows[0].tramos),
    };
  }

  async findDescuadreVentana(
    client: PoolClient,
    tenantId: string,
    combustibleId: number,
    hasta: string,
    dias: number
  ) {
    const result = await client.query<{
      descuadre_total: string;
      tramos: string;
      desde_en: Date | null;
      tanque_nombre: string;
      unidad: string;
      capacidad_total: string;
      umbral_descuadre_ventana_pct: string | null;
    }>(
      `
      WITH lecturas AS (
        SELECT l.nivel, l.leido_en, l.id,
               LAG(l.nivel) OVER (ORDER BY l.leido_en, l.id) AS nivel_anterior,
               LAG(l.leido_en) OVER (ORDER BY l.leido_en, l.id) AS leido_en_anterior
        FROM combustible_lecturas l
        WHERE l.tenant_id = $1 AND l.combustible_id = $2
          AND l.anulada_en IS NULL
          AND l.leido_en <= $3::timestamptz
      ),
      -- El tramo entra si su lectura FINAL cae en la ventana. Un tramo que
      -- arranca antes del corte cuenta entero: partirlo pediría prorratear
      -- despachos por tiempo, que sería inventar dónde ocurrió el consumo.
      tramos AS (
        SELECT
          (le.nivel - (le.nivel_anterior + COALESCE(rec.total, 0) - COALESCE(des.total, 0)))
            AS descuadre,
          le.leido_en_anterior
        FROM lecturas le
        LEFT JOIN LATERAL (
          SELECT SUM(d.cantidad) AS total
          FROM combustible_despachos d
          WHERE d.tenant_id = $1 AND d.combustible_id = $2 AND d.anulada_en IS NULL
            AND d.despachado_en > le.leido_en_anterior AND d.despachado_en <= le.leido_en
        ) des ON true
        LEFT JOIN LATERAL (
          SELECT SUM(r.cantidad) AS total
          FROM combustible_recepciones r
          WHERE r.tenant_id = $1 AND r.combustible_id = $2 AND r.anulada_en IS NULL
            AND r.recibido_en > le.leido_en_anterior AND r.recibido_en <= le.leido_en
        ) rec ON true
        WHERE le.nivel_anterior IS NOT NULL
          AND le.leido_en > $3::timestamptz - make_interval(days => $4)
      )
      SELECT COALESCE(SUM(t.descuadre), 0) AS descuadre_total,
             COUNT(t.descuadre) AS tramos,
             MIN(t.leido_en_anterior) AS desde_en,
             c.tanque_nombre, c.unidad, c.capacidad_total,
             c.umbral_descuadre_ventana_pct
      FROM combustible c
      LEFT JOIN tramos t ON true
      WHERE c.id = $2 AND c.tenant_id = $1
      GROUP BY c.tanque_nombre, c.unidad, c.capacidad_total, c.umbral_descuadre_ventana_pct
      `,
      [tenantId, combustibleId, hasta, dias]
    );
    return result.rows[0] ?? null;
  }

  async findMuestraDescuadresParaCalibracion(
    client: PoolClient,
    tenantId: string,
    combustibleId: number
  ): Promise<
    Array<{
      descuadre: number;
      recepciones: number;
      recepcionesAncla: number;
      capacidad: number;
      leido_en: Date;
      leido_en_anterior: Date;
      nivel_anterior: number;
      nivel: number;
      despachos: number;
      origen: string;
    }>
  > {
    // Además del descuadre, los pasos que lo producen (nivel anterior,
    // despachos, recepciones, medido) y el origen de la lectura. Los usa la
    // exportación de calibración para mostrar la cuenta ENTERA de cada tramo,
    // y el origen deja ver cuándo un tramo termina en la lectura `inicial` del
    // alta, que no es una medición de cancha.
    const result = await client.query<{
      descuadre: string;
      recepciones: string;
      recepciones_ancla: string;
      capacidad_total: string;
      leido_en: Date;
      leido_en_anterior: Date;
      nivel_anterior: string;
      nivel: string;
      despachos: string;
      origen: string;
    }>(
      `
      WITH lecturas AS (
        SELECT l.nivel, l.leido_en, l.origen,
               LAG(l.nivel) OVER (ORDER BY l.leido_en, l.id) AS nivel_anterior,
               LAG(l.leido_en) OVER (ORDER BY l.leido_en, l.id) AS leido_en_anterior
        FROM combustible_lecturas l
        WHERE l.tenant_id = $1 AND l.combustible_id = $2 AND l.anulada_en IS NULL
      )
      SELECT
        (le.nivel - (le.nivel_anterior + COALESCE(rec.total, 0) - COALESCE(des.total, 0)))
          AS descuadre,
        COALESCE(rec.total, 0) AS recepciones,
        -- Lo que cuenta para CORTAR un ciclo en la muestra de calibración:
        -- misma regla que el ancla del ciclo en findSaldoCiclo (1 % de la
        -- capacidad), o la muestra mediría ciclos que la alerta no usa.
        COALESCE(rec.ancla, 0) AS recepciones_ancla,
        c.capacidad_total,
        le.leido_en,
        le.leido_en_anterior,
        le.nivel_anterior,
        le.nivel,
        COALESCE(des.total, 0) AS despachos,
        le.origen
      FROM lecturas le
      JOIN combustible c ON c.id = $2 AND c.tenant_id = $1
      LEFT JOIN LATERAL (
        SELECT SUM(d.cantidad) AS total
        FROM combustible_despachos d
        WHERE d.tenant_id = $1 AND d.combustible_id = $2 AND d.anulada_en IS NULL
          AND d.despachado_en > le.leido_en_anterior AND d.despachado_en <= le.leido_en
      ) des ON true
      LEFT JOIN LATERAL (
        SELECT SUM(r.cantidad) AS total,
               SUM(r.cantidad) FILTER (WHERE r.cantidad >= c.capacidad_total * 0.01) AS ancla
        FROM combustible_recepciones r
        WHERE r.tenant_id = $1 AND r.combustible_id = $2 AND r.anulada_en IS NULL
          AND r.recibido_en > le.leido_en_anterior AND r.recibido_en <= le.leido_en
      ) rec ON true
      WHERE le.nivel_anterior IS NOT NULL
      ORDER BY le.leido_en
      `,
      [tenantId, combustibleId]
    );
    return result.rows.map((f) => ({
      descuadre: Number(f.descuadre),
      recepciones: Number(f.recepciones),
      recepcionesAncla: Number(f.recepciones_ancla),
      capacidad: Number(f.capacidad_total),
      leido_en: f.leido_en,
      leido_en_anterior: f.leido_en_anterior,
      nivel_anterior: Number(f.nivel_anterior),
      nivel: Number(f.nivel),
      despachos: Number(f.despachos),
      origen: f.origen,
    }));
  }

  // ── Sugerencia de los topes diarios desde el historial ───────────────

  /** Lo despachado POR DÍA a cada actor en los últimos `dias`, en litros.
   *  Actor = el equipo, o el tipo de destino cuando no hay equipo (planta es
   *  una sola), igual que el tope en vivo (findAcumuladoDiario). Trae la
   *  capacidad del equipo pasada a litros para poder sugerir también los
   *  "llenados por día".
   *
   *  Días calendario y no ventana móvil de 24 h: para SUGERIR alcanza, y la
   *  ventana móvil sobre todo el historial sería una consulta cuadrática. El
   *  tope en vivo sí usa la ventana móvil. */
  async findDespachadoPorDiaYActor(client: PoolClient, tenantId: string, dias: number) {
    const r = await client.query<{
      actor: string;
      equipo_id: number | null;
      capacidad_l: string | null;
      dia: Date;
      litros: string;
    }>(
      `
      SELECT COALESCE(e.placa_codigo, d.tipo_destino) AS actor,
             d.equipo_id,
             CASE WHEN e.capacidad_tanque IS NULL THEN NULL
                  ELSE e.capacidad_tanque *
                       CASE WHEN e.capacidad_tanque_unidad = 'gal' THEN 3.785411784 ELSE 1 END
             END AS capacidad_l,
             date_trunc('day', d.despachado_en) AS dia,
             SUM(d.cantidad * CASE WHEN c.unidad = 'gal' THEN 3.785411784 ELSE 1 END) AS litros
        FROM combustible_despachos d
        LEFT JOIN combustible c ON c.id = d.combustible_id AND c.tenant_id = $1
        LEFT JOIN equipos e ON e.id = d.equipo_id AND e.tenant_id = $1
       WHERE d.tenant_id = $1 AND d.anulada_en IS NULL
         AND d.despachado_en > now() - make_interval(days => $2)
       GROUP BY 1, 2, 3, 4
       ORDER BY 1, 4
      `,
      [tenantId, dias]
    );
    return r.rows.map((f) => ({
      actor: f.actor,
      equipoId: f.equipo_id,
      capacidadL: f.capacidad_l === null ? null : Number(f.capacidad_l),
      dia: f.dia,
      litros: Number(f.litros),
    }));
  }

  // ── 5ª auditoría: consumo por hora de motor / por km (0088) ──────────

  /** Los últimos vales CON MEDIDOR de un equipo, del más nuevo al más viejo,
   *  con la unidad del tanque del que salieron (para poder pasar todo a
   *  litros). Excluye el vale que se está evaluando por id, igual que
   *  findUltimoMedidorEquipo: corre después del INSERT. */
  async findValesConMedidor(
    client: PoolClient,
    tenantId: string,
    equipoId: number,
    excluirDespachoId: number,
    limite: number
  ) {
    const r = await client.query<{
      id: string;
      cantidad: string;
      unidad: string | null;
      lectura_horometro: string | null;
      lectura_odometro: string | null;
      despachado_en: Date;
    }>(
      `SELECT d.id, d.cantidad, c.unidad, d.lectura_horometro, d.lectura_odometro,
              d.despachado_en
         FROM combustible_despachos d
         LEFT JOIN combustible c ON c.id = d.combustible_id AND c.tenant_id = $1
        WHERE d.tenant_id = $1 AND d.equipo_id = $2 AND d.anulada_en IS NULL
          AND d.id <> $3
          AND (d.lectura_horometro IS NOT NULL OR d.lectura_odometro IS NOT NULL)
        ORDER BY d.despachado_en DESC, d.id DESC
        LIMIT $4`,
      [tenantId, equipoId, excluirDespachoId, limite]
    );
    return r.rows;
  }

  /** Lo cargado a un equipo DESPUÉS de un instante (litros ya convertidos),
   *  incluyendo el vale recién creado. Es el numerador del consumo. */
  async findLitrosDesde(
    client: PoolClient,
    tenantId: string,
    equipoId: number,
    desde: Date
  ): Promise<number> {
    const r = await client.query<{ litros: string }>(
      `SELECT COALESCE(SUM(
                d.cantidad * CASE WHEN c.unidad = 'gal' THEN 3.785411784 ELSE 1 END
              ), 0) AS litros
         FROM combustible_despachos d
         LEFT JOIN combustible c ON c.id = d.combustible_id AND c.tenant_id = $1
        WHERE d.tenant_id = $1 AND d.equipo_id = $2 AND d.anulada_en IS NULL
          -- La urea (0092) también es un vale a un equipo, pero no se quema en
          -- el motor: sumarla inflaba el consumo y disparaba consumo_excedido
          -- en falso.
          AND d.producto = 'combustible'
          AND d.despachado_en > $3`,
      [tenantId, equipoId, desde]
    );
    return Number(r.rows[0].litros);
  }

  async getConsumoMaximoEquipo(client: PoolClient, tenantId: string, equipoId: number) {
    const r = await client.query<{
      consumo_maximo_l: string | null;
      tipo_medidor: string | null;
      placa_codigo: string;
    }>(
      `SELECT consumo_maximo_l, tipo_medidor, placa_codigo
         FROM equipos WHERE id = $1 AND tenant_id = $2`,
      [equipoId, tenantId]
    );
    const f = r.rows[0];
    if (!f) return null;
    return {
      consumoMaximo: f.consumo_maximo_l === null ? null : Number(f.consumo_maximo_l),
      tipoMedidor: f.tipo_medidor,
      placa: f.placa_codigo,
    };
  }

  /** Los vales de COMBUSTIBLE a equipos, en litros, del más viejo al más
   *  nuevo. Todos, con o sin medidor: los que no traen medidor igual se
   *  quemaron en el motor y tienen que contar en el numerador del consumo.
   *  Sin urea (no se quema) y sin anulados.
   *
   *  `equipoId` null = toda la flota (el reporte); con id, un solo equipo (la
   *  sugerencia). `desde` null = sin límite hacia atrás; `limite` corta por
   *  el lado VIEJO, así que lo que se pierde es la historia más antigua.
   *
   *  compra_externa no tiene tanque y por lo tanto no tiene unidad: se toma
   *  como litros, igual que en findAcumuladoDiario. */
  async findValesParaConsumo(
    client: PoolClient,
    tenantId: string,
    filtro: { equipoId: number | null; desde: string | null; hasta: string; limite: number }
  ) {
    const r = await client.query<{
      id: string;
      equipo_id: number;
      litros: string;
      lectura_horometro: string | null;
      lectura_odometro: string | null;
      despachado_en: Date;
    }>(
      `SELECT * FROM (
         SELECT d.id, d.equipo_id,
                d.cantidad * CASE WHEN c.unidad = 'gal' THEN 3.785411784 ELSE 1 END AS litros,
                d.lectura_horometro, d.lectura_odometro, d.despachado_en
           FROM combustible_despachos d
           LEFT JOIN combustible c ON c.id = d.combustible_id AND c.tenant_id = $1
          WHERE d.tenant_id = $1 AND d.anulada_en IS NULL
            AND d.producto = 'combustible' AND d.equipo_id IS NOT NULL
            AND ($2::int IS NULL OR d.equipo_id = $2)
            AND ($3::timestamptz IS NULL OR d.despachado_en >= $3)
            AND d.despachado_en <= $4
          ORDER BY d.despachado_en DESC, d.id DESC
          LIMIT $5
       ) ultimos
       ORDER BY despachado_en ASC, id ASC`,
      [tenantId, filtro.equipoId, filtro.desde, filtro.hasta, filtro.limite]
    );
    return r.rows;
  }

  /** Los datos del equipo que el reporte de consumo necesita para agrupar
   *  pares (tipo/marca/modelo) y elegir el medidor. */
  async findEquiposParaConsumo(client: PoolClient, tenantId: string, ids: number[]) {
    if (ids.length === 0) return [];
    const r = await client.query<{
      id: number;
      placa_codigo: string;
      tipo: string | null;
      marca: string | null;
      modelo: string | null;
      tipo_medidor: string | null;
      consumo_maximo_l: string | null;
      activo: boolean;
    }>(
      `SELECT id, placa_codigo, tipo, marca, modelo, tipo_medidor, consumo_maximo_l, activo
         FROM equipos
        WHERE tenant_id = $1 AND id = ANY($2::int[])`,
      [tenantId, ids]
    );
    return r.rows;
  }

  // ── Precintos numerados (migración 0095) ─────────────────────────────

  /** Los puntos del tanque con su precinto VIGENTE hoy (la última
   *  colocación). Incluye los dados de baja, marcados: la historia no se
   *  esconde. */
  async listarPuntosPrecinto(client: PoolClient, tenantId: string, combustibleId: number) {
    const r = await client.query(
      `SELECT pp.id, pp.combustible_id, pp.nombre, pp.se_abre_en_recepcion, pp.activo,
              pp.motivo_baja, pp.creado_en,
              v.numero AS numero_vigente, v.colocado_en, v.motivo AS motivo_vigente,
              u.nombre AS colocado_por
         FROM combustible_precinto_puntos pp
         LEFT JOIN LATERAL (
           SELECT p.numero, p.colocado_en, p.motivo, p.colocado_por
             FROM combustible_precintos p
            WHERE p.tenant_id = $1 AND p.punto_id = pp.id
            ORDER BY p.colocado_en DESC, p.id DESC LIMIT 1
         ) v ON true
         LEFT JOIN usuarios u ON u.id = v.colocado_por AND u.tenant_id = $1
        WHERE pp.tenant_id = $1 AND pp.combustible_id = $2
        ORDER BY pp.activo DESC, pp.nombre`,
      [tenantId, combustibleId]
    );
    return r.rows;
  }

  async findPuntoPrecinto(client: PoolClient, tenantId: string, puntoId: number) {
    const r = await client.query<{
      id: number;
      combustible_id: number;
      nombre: string;
      se_abre_en_recepcion: boolean;
      activo: boolean;
    }>(
      `SELECT id, combustible_id, nombre, se_abre_en_recepcion, activo
         FROM combustible_precinto_puntos WHERE id = $1 AND tenant_id = $2`,
      [puntoId, tenantId]
    );
    return r.rows[0] ?? null;
  }

  async crearPuntoPrecinto(
    client: PoolClient,
    tenantId: string,
    data: { combustibleId: number; nombre: string; seAbreEnRecepcion: boolean; usuarioId: string }
  ) {
    try {
      const r = await client.query<{ id: number }>(
        `INSERT INTO combustible_precinto_puntos
           (tenant_id, combustible_id, nombre, se_abre_en_recepcion, creado_por)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [tenantId, data.combustibleId, data.nombre, data.seAbreEnRecepcion, data.usuarioId]
      );
      return r.rows[0].id;
    } catch (err) {
      if (esViolacionUnicidad(err)) {
        throw new Error(`el tanque ya tiene un punto llamado "${data.nombre}"`, {
          cause: err,
        });
      }
      throw err;
    }
  }

  async bajaPuntoPrecinto(client: PoolClient, tenantId: string, puntoId: number, motivo: string) {
    const r = await client.query(
      `UPDATE combustible_precinto_puntos SET activo = false, motivo_baja = $1
        WHERE id = $2 AND tenant_id = $3 AND activo
        RETURNING id, combustible_id, nombre`,
      [motivo, puntoId, tenantId]
    );
    return r.rows[0] ?? null;
  }

  /** Coloca un precinto. Bloquea el punto para que dos cambios simultáneos
   *  no queden en el orden equivocado, y rechaza uno fechado ANTES del último:
   *  el vigente de cada instante sale del orden por fecha, y meter un cambio
   *  atrás reescribiría qué se tendría que haber visto en varillas que ya se
   *  verificaron. Lanza con un mensaje que el controller traduce a 400/409. */
  async colocarPrecinto(
    client: PoolClient,
    tenantId: string,
    data: {
      puntoId: number;
      numero: string;
      colocadoEn: string;
      usuarioId: string;
      motivo: string;
      recepcionId: number | null;
    }
  ) {
    await client.query(
      `SELECT id FROM combustible_precinto_puntos WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [data.puntoId, tenantId]
    );
    const ultimo = await client.query<{ numero: string; colocado_en: Date }>(
      `SELECT numero, colocado_en FROM combustible_precintos
        WHERE tenant_id = $1 AND punto_id = $2
        ORDER BY colocado_en DESC, id DESC LIMIT 1`,
      [tenantId, data.puntoId]
    );
    const previo = ultimo.rows[0] ?? null;
    if (previo && new Date(previo.colocado_en).getTime() > Date.parse(data.colocadoEn)) {
      throw new Error(
        `el precinto ${previo.numero} de este punto se colocó después de la fecha indicada`
      );
    }
    try {
      const r = await client.query(
        `INSERT INTO combustible_precintos
           (tenant_id, punto_id, numero, colocado_en, colocado_por, motivo, recepcion_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, punto_id, numero, colocado_en, motivo, recepcion_id`,
        [
          tenantId,
          data.puntoId,
          data.numero,
          data.colocadoEn,
          data.usuarioId,
          data.motivo,
          data.recepcionId,
        ]
      );
      return { precinto: r.rows[0], numeroAnterior: previo?.numero ?? null };
    } catch (err) {
      if (esViolacionUnicidad(err)) {
        throw new Error(`el precinto ${data.numero} ya se usó: cada número va una sola vez`, {
          cause: err,
        });
      }
      throw err;
    }
  }

  /** Qué precinto había en cada punto del tanque EN UN INSTANTE: la última
   *  colocación hasta ese momento. Es lo que una varilla offline tiene que
   *  comparar -- no el de ahora. Un punto sin colocación hasta ese instante
   *  (se creó después) viene con `numero` null y no se exige. */
  async findPrecintosVigentesEn(
    client: PoolClient,
    tenantId: string,
    combustibleId: number,
    instante: string
  ) {
    const r = await client.query<{
      punto_id: number;
      nombre: string;
      activo: boolean;
      numero: string | null;
    }>(
      `SELECT pp.id AS punto_id, pp.nombre, pp.activo, v.numero
         FROM combustible_precinto_puntos pp
         LEFT JOIN LATERAL (
           SELECT p.numero FROM combustible_precintos p
            WHERE p.tenant_id = $1 AND p.punto_id = pp.id AND p.colocado_en <= $3::timestamptz
            ORDER BY p.colocado_en DESC, p.id DESC LIMIT 1
         ) v ON true
        WHERE pp.tenant_id = $1 AND pp.combustible_id = $2`,
      [tenantId, combustibleId, instante]
    );
    return r.rows;
  }

  async insertarVerificacionesPrecinto(
    client: PoolClient,
    tenantId: string,
    lecturaId: number,
    filas: { puntoId: number; visto: string | null; esperado: string; coincide: boolean }[]
  ) {
    for (const f of filas) {
      await client.query(
        `INSERT INTO combustible_precinto_verificaciones
           (tenant_id, lectura_id, punto_id, numero_visto, numero_esperado, coincide)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [tenantId, lecturaId, f.puntoId, f.visto, f.esperado, f.coincide]
      );
    }
  }

  /** Las verificaciones de una varilla que NO coincidieron, con el nombre del
   *  punto: es lo que la alerta necesita contar. */
  async findVerificacionesFallidas(client: PoolClient, tenantId: string, lecturaId: number) {
    const r = await client.query<{
      punto_id: number;
      nombre: string;
      numero_visto: string | null;
      numero_esperado: string;
    }>(
      `SELECT v.punto_id, pp.nombre, v.numero_visto, v.numero_esperado
         FROM combustible_precinto_verificaciones v
         JOIN combustible_precinto_puntos pp ON pp.id = v.punto_id AND pp.tenant_id = $1
        WHERE v.tenant_id = $1 AND v.lectura_id = $2 AND NOT v.coincide
        ORDER BY pp.nombre`,
      [tenantId, lecturaId]
    );
    return r.rows;
  }

  /** La historia de precintos del tanque: cada colocación y cada varilla que
   *  no coincidió, de la más nueva a la más vieja. */
  async historialPrecintos(client: PoolClient, tenantId: string, combustibleId: number) {
    const r = await client.query(
      `SELECT * FROM (
         SELECT 'colocacion' AS tipo, p.colocado_en AS ocurrido_en, pp.nombre AS punto,
                p.numero, NULL::varchar AS numero_esperado, p.motivo,
                p.recepcion_id, u.nombre AS persona
           FROM combustible_precintos p
           JOIN combustible_precinto_puntos pp ON pp.id = p.punto_id AND pp.tenant_id = $1
           LEFT JOIN usuarios u ON u.id = p.colocado_por AND u.tenant_id = $1
          WHERE p.tenant_id = $1 AND pp.combustible_id = $2
         UNION ALL
         SELECT 'no_coincide', l.leido_en, pp.nombre, v.numero_visto, v.numero_esperado,
                NULL, NULL, u.nombre
           FROM combustible_precinto_verificaciones v
           JOIN combustible_precinto_puntos pp ON pp.id = v.punto_id AND pp.tenant_id = $1
           JOIN combustible_lecturas l ON l.id = v.lectura_id AND l.tenant_id = $1
           LEFT JOIN usuarios u ON u.id = l.usuario_id AND u.tenant_id = $1
          WHERE v.tenant_id = $1 AND pp.combustible_id = $2 AND NOT v.coincide
       ) h
       ORDER BY ocurrido_en DESC
       LIMIT 300`,
      [tenantId, combustibleId]
    );
    return r.rows;
  }

  // ── 5ª auditoría: recepciones validadas contra la guía (0088) ────────

  async getPoliticaValidacionRecepcion(
    client: PoolClient,
    tenantId: string
  ): Promise<{ requiere: boolean; horas: number }> {
    const r = await client.query<{ requiere: boolean; horas: number }>(
      `SELECT recepcion_requiere_validacion AS requiere, horas_para_validar_recepcion AS horas
         FROM combustible_config WHERE tenant_id = $1`,
      [tenantId]
    );
    // Sin fila de config: los defaults de la migración, del lado estricto.
    if (r.rows.length === 0) return { requiere: true, horas: 48 };
    return { requiere: r.rows[0].requiere, horas: Number(r.rows[0].horas) };
  }

  /** Recepciones que esperan validación pasado el plazo y todavía no tienen
   *  alerta abierta por eso. */
  async findRecepcionesSinValidar(client: PoolClient, tenantId: string, horas: number) {
    const r = await client.query<{
      id: number;
      combustible_id: number;
      tanque_nombre: string;
      unidad: string;
      creado_en: Date;
      numero_documento: string | null;
    }>(
      `SELECT r.id, r.combustible_id, c.tanque_nombre, c.unidad, r.creado_en, r.numero_documento
         FROM combustible_recepciones r
         JOIN combustible c ON c.id = r.combustible_id AND c.tenant_id = $1
        WHERE r.tenant_id = $1
          AND r.requiere_validacion AND r.validada_en IS NULL AND r.anulada_en IS NULL
          AND r.creado_en < now() - make_interval(hours => $2)
          AND NOT EXISTS (
            SELECT 1 FROM combustible_alertas a
             WHERE a.tenant_id = $1 AND a.recepcion_id = r.id
               AND a.tipo = 'recepcion_sin_validar' AND a.resuelta_en IS NULL
          )
        ORDER BY r.creado_en`,
      [tenantId, horas]
    );
    return r.rows;
  }

  /** La validación (o la anulación) cierra la alerta de "sin validar". */
  async resolverRecepcionSinValidarSiExiste(
    client: PoolClient,
    tenantId: string,
    recepcionId: number
  ): Promise<void> {
    await client.query(
      `UPDATE combustible_alertas SET resuelta_en = now()
        WHERE tenant_id = $1 AND recepcion_id = $2
          AND tipo = 'recepcion_sin_validar' AND resuelta_en IS NULL`,
      [tenantId, recepcionId]
    );
  }

  /** Valida una recepción: guarda la cantidad de la guía que escribió quien
   *  valida. `validada_en IS NULL` en el WHERE: dos validaciones simultáneas
   *  no pueden terminar las dos en 200 (mismo patrón que las anulaciones). */
  async validarRecepcion(
    client: PoolClient,
    tenantId: string,
    recepcionId: number,
    usuarioId: string,
    cantidadDocumento: number
  ) {
    const r = await client.query(
      `UPDATE combustible_recepciones
          SET cantidad_documento = $1, validada_en = now(), validada_por = $2
        WHERE id = $3 AND tenant_id = $4
          AND validada_en IS NULL AND anulada_en IS NULL
        RETURNING ${CombustibleRepository.COLUMNAS_RECEPCION}`,
      [cantidadDocumento, usuarioId, recepcionId, tenantId]
    );
    return r.rows[0] ?? null;
  }

  // ── 5ª auditoría: alertas deduplicadas y controles de la varilla ─────

  /** Crea la alerta de un ESTADO ACUMULADO (ciclo, ventana, varillas
   *  exactas), o actualiza la que ya está abierta para ese tanque.
   *
   *  Antes cada varilla creaba una alerta nueva mientras el acumulado siguiera
   *  pasado: cinco varillas, cinco alertas y cinco correos iguales. El ruido
   *  es cómo muere un control -- la lección de "marcar todas leídas".
   *
   *  Si ya hay una abierta: se reemplaza el detalle por los números al día,
   *  se cuenta la repetición, se apunta a la varilla más reciente y se vuelve
   *  a marcar como NO LEÍDA (la situación sigue y puede haber empeorado), pero
   *  NO se crea otra ni se manda otro correo. `creado_en` no se toca: la
   *  ventana de gracia corre desde que se detectó por primera vez, no desde
   *  la última varilla -- si no, medir seguido la postergaría para siempre.
   *
   *  `FOR UPDATE` sobre el tanque serializa dos varillas simultáneas del
   *  mismo tanque: sin eso las dos pasarían por el "¿ya hay una abierta?" y
   *  crearían dos. */
  async registrarAlertaDeEstadoAcumulado(
    client: PoolClient,
    tenantId: string,
    fila: AlertaNueva & { combustibleId: number }
  ): Promise<{ nueva: boolean; id: string }> {
    await client.query(`SELECT id FROM combustible WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [
      fila.combustibleId,
      tenantId,
    ]);
    const abierta = await client.query<{ id: string }>(
      `SELECT id FROM combustible_alertas
        WHERE tenant_id = $1 AND combustible_id = $2 AND tipo = $3
          AND resuelta_en IS NULL AND congelada_en IS NULL
        ORDER BY creado_en DESC, id DESC
        LIMIT 1`,
      [tenantId, fila.combustibleId, fila.tipo]
    );
    if (abierta.rows[0]) {
      await client.query(
        `UPDATE combustible_alertas
            SET detalle = $1::jsonb || jsonb_build_object(
                  'repeticiones', COALESCE((detalle->>'repeticiones')::int, 1) + 1,
                  'primeraDeteccion', COALESCE(detalle->'primeraDeteccion', to_jsonb(creado_en))
                ),
                lectura_id = COALESCE($2, lectura_id),
                leida_en = NULL
          WHERE id = $3 AND tenant_id = $4`,
        [JSON.stringify(fila.detalle), fila.lecturaId ?? null, abierta.rows[0].id, tenantId]
      );
      return { nueva: false, id: abierta.rows[0].id };
    }
    const [creada] = await this.crearAlertas(client, tenantId, [fila]);
    return { nueva: true, id: String(creada.id) };
  }

  /** Los últimos `n` tramos del tanque que TERMINAN en esta lectura o antes
   *  (orden cronológico), con lo que se movió en cada uno. Para el control de
   *  varillas exactas. La lectura `inicial` del alta no es una medición de
   *  cancha y no forma tramo. */
  async findUltimosTramos(
    client: PoolClient,
    tenantId: string,
    combustibleId: number,
    lecturaId: number,
    n: number
  ) {
    const r = await client.query<{
      lectura_id: string;
      descuadre: string;
      despachos: string;
      recepciones: string;
      leido_en: Date;
    }>(
      `
      WITH lecturas AS (
        SELECT l.id, l.nivel, l.leido_en,
               LAG(l.nivel) OVER w AS nivel_anterior,
               LAG(l.leido_en) OVER w AS leido_en_anterior
          FROM combustible_lecturas l
         WHERE l.tenant_id = $1 AND l.combustible_id = $2 AND l.anulada_en IS NULL
           AND l.origen <> 'inicial'
        WINDOW w AS (ORDER BY l.leido_en, l.id)
      ),
      hasta AS (SELECT leido_en, id FROM lecturas WHERE id = $3)
      SELECT le.id AS lectura_id, le.leido_en,
             COALESCE(des.total, 0) AS despachos,
             COALESCE(rec.total, 0) AS recepciones,
             le.nivel - (le.nivel_anterior + COALESCE(rec.total, 0) - COALESCE(des.total, 0))
               AS descuadre
        FROM lecturas le
        CROSS JOIN hasta h
        LEFT JOIN LATERAL (
          SELECT SUM(d.cantidad) AS total FROM combustible_despachos d
           WHERE d.tenant_id = $1 AND d.combustible_id = $2 AND d.anulada_en IS NULL
             AND d.despachado_en > le.leido_en_anterior AND d.despachado_en <= le.leido_en
        ) des ON true
        LEFT JOIN LATERAL (
          SELECT SUM(rr.cantidad) AS total FROM combustible_recepciones rr
           WHERE rr.tenant_id = $1 AND rr.combustible_id = $2 AND rr.anulada_en IS NULL
             AND rr.recibido_en > le.leido_en_anterior AND rr.recibido_en <= le.leido_en
        ) rec ON true
       WHERE le.nivel_anterior IS NOT NULL
         AND (le.leido_en, le.id) <= (h.leido_en, h.id)
       ORDER BY le.leido_en DESC, le.id DESC
       LIMIT $4
      `,
      [tenantId, combustibleId, lecturaId, n]
    );
    return r.rows.reverse().map((f) => ({
      lecturaId: Number(f.lectura_id),
      leidoEn: f.leido_en,
      descuadre: Number(f.descuadre),
      despachos: Number(f.despachos),
      recepciones: Number(f.recepciones),
    }));
  }

  /** Una varilla tomada por alguien que NO es grifero cierra la alerta de
   *  "varilla sin control" del tanque. Lo resolvió el hecho, no una persona. */
  async resolverVarillaSinControlSiExiste(
    client: PoolClient,
    tenantId: string,
    combustibleId: number
  ): Promise<void> {
    await client.query(
      `UPDATE combustible_alertas SET resuelta_en = now()
        WHERE tenant_id = $1 AND combustible_id = $2
          AND tipo = 'varilla_sin_control' AND resuelta_en IS NULL`,
      [tenantId, combustibleId]
    );
  }

  /** Días tolerados sin una varilla de alguien que no despacha (0088). NULL
   *  = la empresa decidió no tener ese control. Sin fila de config, 7. */
  async getDiasSinVarillaDeControl(client: PoolClient, tenantId: string): Promise<number | null> {
    const r = await client.query<{ dias: number | null }>(
      `SELECT dias_sin_varilla_de_control AS dias FROM combustible_config WHERE tenant_id = $1`,
      [tenantId]
    );
    if (r.rows.length === 0) return 7;
    return r.rows[0].dias === null ? null : Number(r.rows[0].dias);
  }

  /** Tanques activos que en los últimos `dias` se midieron SOLO por griferos
   *  --los mismos que despachan--, y sin alerta abierta por eso.
   *
   *  Tiene que haber varillas en la ventana: un tanque que directamente no se
   *  mide ya lo cubre `tanque_sin_medir`, y alertarlo dos veces es ruido. Y
   *  despachos: un tanque parado no tiene nada que controlar.
   *
   *  El rol que cuenta es el ACTUAL del usuario. Si alguien pasó de operador a
   *  grifero, sus varillas viejas dejan de contar como independientes -- el
   *  lado seguro. */
  async findTanquesSinVarillaDeControl(client: PoolClient, tenantId: string, dias: number) {
    const r = await client.query<{
      id: number;
      tanque_nombre: string;
      codigo: string;
      varillas: string;
      ultima_de_control: Date | null;
    }>(
      `
      SELECT c.id, c.tanque_nombre, c.codigo,
             (SELECT COUNT(*) FROM combustible_lecturas l
               WHERE l.tenant_id = $1 AND l.combustible_id = c.id AND l.anulada_en IS NULL
                 AND l.origen <> 'inicial'
                 AND l.leido_en > now() - make_interval(days => $2))::text AS varillas,
             (SELECT MAX(l.leido_en) FROM combustible_lecturas l
                JOIN usuarios u ON u.id = l.usuario_id AND u.tenant_id = $1
               WHERE l.tenant_id = $1 AND l.combustible_id = c.id AND l.anulada_en IS NULL
                 AND u.rol <> 'grifero') AS ultima_de_control
        FROM combustible c
       WHERE c.tenant_id = $1 AND c.activo = true
         AND EXISTS (
           SELECT 1 FROM combustible_despachos d
            WHERE d.tenant_id = $1 AND d.combustible_id = c.id AND d.anulada_en IS NULL
              AND d.despachado_en > now() - make_interval(days => $2)
         )
         AND EXISTS (
           SELECT 1 FROM combustible_lecturas l
            WHERE l.tenant_id = $1 AND l.combustible_id = c.id AND l.anulada_en IS NULL
              AND l.origen <> 'inicial'
              AND l.leido_en > now() - make_interval(days => $2)
         )
         AND NOT EXISTS (
           SELECT 1 FROM combustible_lecturas l
             JOIN usuarios u ON u.id = l.usuario_id AND u.tenant_id = $1
            WHERE l.tenant_id = $1 AND l.combustible_id = c.id AND l.anulada_en IS NULL
              AND l.leido_en > now() - make_interval(days => $2)
              AND u.rol <> 'grifero'
         )
         AND NOT EXISTS (
           SELECT 1 FROM combustible_alertas a
            WHERE a.tenant_id = $1 AND a.combustible_id = c.id
              AND a.tipo = 'varilla_sin_control' AND a.resuelta_en IS NULL
         )
       ORDER BY c.id
      `,
      [tenantId, dias]
    );
    return r.rows;
  }

  /** Distingue "no existe / es de otro tenant" (404) de "ya estaba anulada"
   *  (409) -- mismo motivo que findLecturaPorId/findPrecioPorId. */
  async findRecepcionPorId(client: PoolClient, tenantId: string, id: number) {
    const result = await client.query(
      `SELECT ${CombustibleRepository.COLUMNAS_RECEPCION}
       FROM combustible_recepciones WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );
    return result.rows[0] ?? null;
  }

  /** Anula una recepción y recalcula el costo promedio del tanque sin ella.
   *
   *  El UPDATE lleva `anulada_en IS NULL` en el WHERE por el mismo motivo
   *  que anularLectura/anularPrecio: dos anulaciones simultáneas no pueden
   *  terminar las dos en 200 pisando el motivo original (ver
   *  fix_race_condition_iperc_estado).
   *
   *  A diferencia de anularLectura -- donde 0059 hizo que no hubiera nada
   *  que recalcular -- acá el replay SÍ es necesario: el costo promedio es
   *  un acumulado derivado, no se deduce mirando una sola fila. */
  async anularRecepcion(
    client: PoolClient,
    tenantId: string,
    recepcionId: number,
    usuarioId: string,
    motivo: string
  ) {
    const anulada = await client.query(
      `
      UPDATE combustible_recepciones
      SET anulada_en = now(), anulada_por = $1, motivo_anulacion = $2
      WHERE id = $3 AND tenant_id = $4 AND anulada_en IS NULL
      RETURNING ${CombustibleRepository.COLUMNAS_RECEPCION}
      `,
      [usuarioId, motivo, recepcionId, tenantId]
    );

    if (anulada.rows.length === 0) return null;

    const recepcion = anulada.rows[0];
    // El costo PONDERADO es un concepto del tanque de combustible -- una
    // recepción de urea (combustible_id NULL, ver 0092) no tiene tanque
    // que recalcular. `tanque: null` en la respuesta es la verdad, no un
    // caso sin cubrir.
    if (recepcion.producto === "urea") {
      return { recepcion, tanque: null };
    }
    await this.recalcularCostoPromedio(client, tenantId, recepcion.combustible_id);
    const tanque = await this.findById(client, tenantId, recepcion.combustible_id);

    return { recepcion, tanque };
  }
}
