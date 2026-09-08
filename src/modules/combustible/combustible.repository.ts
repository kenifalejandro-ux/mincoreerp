/**src/modules/combutible/combustible.repository.ts */

import type { PoolClient } from "pg";
import type {
  CrearTanqueCombustibleInput,
  ActualizarTanqueCombustibleInput,
} from "../../server/schemas/combustible.schema";
import type { Paginacion } from "../../server/shared/utils/pagination";
import { esViolacionUnicidad, esViolacionForeignKey } from "../../server/shared/utils/pgError";

/** Los siete tipos de alerta del módulo (migraciones 0068, 0070, 0072, 0073).
 *  Los cuatro primeros salen de un despacho y llevan vale; los tres últimos
 *  no -- ver el encabezado de 0073. */
export type TipoAlertaCombustible =
  | "hueco_detectado"
  | "vale_anulado"
  | "sobredespacho"
  | "despacho_tardio"
  | "diferencia_recepcion"
  | "nivel_bajo"
  | "medidor_inconsistente"
  | "descuadre_inventario"
  | "descuadre_ciclo"
  | "tanque_sin_medir"
  | "vale_fuera_de_orden"
  | "lectura_retroactiva"
  | "tope_diario_excedido";

/** Una alerta por crear. Las anclas son todas opcionales en el tipo, pero
 *  el CHECK de la base exige al menos una (vale, tanque o recepción). */
export interface AlertaNueva {
  tipo: TipoAlertaCombustible;
  serieTalonario?: string | null;
  nVale?: number | null;
  despachoId?: number | null;
  combustibleId?: number | null;
  recepcionId?: number | null;
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
const COLUMNAS_TANQUE = `
  c.id, c.codigo, c.tanque_nombre, c.tipo_combustible, c.unidad, c.tipo_punto,
  c.ubicacion, c.capacidad_total, c.nivel_minimo, c.totalizador_actual,
  c.costo_promedio, c.moneda, c.activo,
  c.tolerancia_capacidad_pct, c.requiere_documento, c.umbral_diferencia_pct,
  c.umbral_descuadre_pct, c.umbral_descuadre_ciclo_pct,
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
`;

export class CombustibleRepository {
  async findAll(client: PoolClient, tenantId: string) {
    const result = await client.query(
      `SELECT ${COLUMNAS_TANQUE} FROM combustible c ${JOIN_ULTIMA_LECTURA}
       WHERE c.tenant_id = $1 ORDER BY c.id ASC`,
      [tenantId]
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
        umbral_descuadre_pct, umbral_descuadre_ciclo_pct
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
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
      ]
    );

    const id = creado.rows[0].id;
    await client.query(
      `INSERT INTO combustible_lecturas (tenant_id, combustible_id, nivel, leido_en, origen)
       VALUES ($1, $2, $3, NOW(), 'inicial')`,
      [tenantId, id, data.nivel_actual]
    );

    // Se relee en vez de usar RETURNING: el nivel sale de un LATERAL JOIN
    // contra las lecturas, que RETURNING no puede hacer.
    return this.findById(client, tenantId, id);
  }

  /** Reemplaza la fila entera salvo `nivel_actual`/`totalizador_actual`/
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
        umbral_descuadre_ciclo_pct = $15
      WHERE id = $16 AND tenant_id = $17
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
        id,
        tenantId,
      ]
    );

    if (result.rows.length === 0) return null;
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
  async createBulk(client: PoolClient, tenantId: string, items: CrearTanqueCombustibleInput[]) {
    const TAMANO_LOTE = 1000;
    const results: unknown[] = [];

    for (let inicio = 0; inicio < items.length; inicio += TAMANO_LOTE) {
      const lote = items.slice(inicio, inicio + TAMANO_LOTE);

      const porCodigo = new Map<string, CrearTanqueCombustibleInput>();
      for (const fila of lote) porCodigo.set(fila.codigo, fila);
      const filasUnicas = [...porCodigo.values()];

      const COLUMNAS_POR_FILA = 13;
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
      ]);

      // Qué códigos YA existían, antes de que el upsert los toque: es la
      // única forma de distinguir después un alta nueva de una edición, y de
      // eso depende si corresponde crearle su lectura inicial.
      const preexistentes = await client.query<{ id: number }>(
        `SELECT id FROM combustible WHERE tenant_id = $1 AND codigo = ANY($2::varchar[])`,
        [tenantId, filasUnicas.map((d) => d.codigo)]
      );
      const idsPreexistentes = new Set(preexistentes.rows.map((f) => f.id));

      const insertados = await client.query<{ id: number; codigo: string }>(
        `INSERT INTO combustible (
           tenant_id, codigo, tanque_nombre, tipo_combustible, unidad, tipo_punto,
           ubicacion, capacidad_total, nivel_minimo,
           tolerancia_capacidad_pct, requiere_documento, umbral_diferencia_pct,
           umbral_descuadre_pct
         )
         VALUES ${placeholders}
         ON CONFLICT (tenant_id, codigo) DO UPDATE SET
           tanque_nombre = EXCLUDED.tanque_nombre,
           tipo_combustible = EXCLUDED.tipo_combustible,
           unidad = EXCLUDED.unidad,
           tipo_punto = EXCLUDED.tipo_punto,
           ubicacion = EXCLUDED.ubicacion,
           capacidad_total = EXCLUDED.capacidad_total,
           nivel_minimo = EXCLUDED.nivel_minimo,
           tolerancia_capacidad_pct = EXCLUDED.tolerancia_capacidad_pct,
           requiere_documento = EXCLUDED.requiere_documento,
           umbral_diferencia_pct = EXCLUDED.umbral_diferencia_pct,
           umbral_descuadre_pct = EXCLUDED.umbral_descuadre_pct
         RETURNING id, codigo`,
        valores
      );

      // Lectura `inicial` solo para los tanques NUEVOS: si el código ya
      // existía, esto fue un upsert sobre un tanque con historial propio, y
      // meterle una lectura del Excel le pisaría el nivel real medido en
      // campo con un número de planilla.
      const nivelPorCodigo = new Map(filasUnicas.map((d) => [d.codigo, d.nivel_actual]));
      const nuevos = insertados.rows.filter((f) => !idsPreexistentes.has(f.id));
      for (const fila of nuevos) {
        await client.query(
          `INSERT INTO combustible_lecturas (tenant_id, combustible_id, nivel, leido_en, origen)
           VALUES ($1, $2, $3, NOW(), 'inicial')`,
          [tenantId, fila.id, nivelPorCodigo.get(fila.codigo) ?? 0]
        );
      }

      for (const fila of insertados.rows) {
        results.push(await this.findById(client, tenantId, fila.id));
      }
    }

    return results;
  }

  /** GET /:id/lecturas -- a diferencia de los tanques (pocos, sin
   *  paginación), el histórico de lecturas SÍ crece con el trabajo de
   *  campo, mismo criterio que combustible_lecturas ya tiene declarada su
   *  propia cuota en el registry. */
  async findLecturas(
    client: PoolClient,
    tenantId: string,
    combustibleId: number,
    { pageSize, offset }: Paginacion
  ) {
    const result = await client.query(
      `
      SELECT l.id, l.combustible_id, l.nivel, l.leido_en, l.usuario_id, l.origen,
             l.metadata, l.creado_en,
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
      WHERE l.combustible_id = $1 AND l.tenant_id = $2
      ORDER BY l.leido_en DESC
      LIMIT $3 OFFSET $4
      `,
      [combustibleId, tenantId, pageSize, offset]
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
      RETURNING id, combustible_id, nivel, leido_en, usuario_id, origen, metadata, creado_en
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
      `SELECT id, combustible_id, nivel, leido_en, usuario_id, origen, metadata, creado_en
       FROM combustible_lecturas
       WHERE id = $1 AND tenant_id = $2`,
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
    id, tenant_id, origen, combustible_id, grifo_id, tipo_combustible,
    tipo_destino, equipo_id, serie_talonario, n_vale, cantidad,
    lectura_contometro, lectura_horometro, lectura_odometro, horas_abastecidas,
    costo_unitario, (cantidad * costo_unitario) AS costo_total, observaciones,
    usuario_id, despachado_en, creado_en,
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
      origen: string;
      combustibleId: number | null;
      grifoId: number | null;
      tipoCombustible: string;
      tipoDestino: string;
      equipoId: number | null;
      serieTalonario: string;
      nVale: number;
      cantidad: number;
      lecturaContometro: number | null;
      lecturaHorometro: number | null;
      lecturaOdometro: number | null;
      horasAbastecidas: number | null;
      costoUnitario: number;
      observaciones: string | null;
      despachadoEn: string;
    }
  ) {
    try {
      const result = await client.query(
        `
        INSERT INTO combustible_despachos (
          tenant_id, origen, combustible_id, grifo_id, tipo_combustible,
          tipo_destino, equipo_id, serie_talonario, n_vale, cantidad,
          lectura_contometro, lectura_horometro, lectura_odometro, horas_abastecidas,
          costo_unitario, observaciones, usuario_id, despachado_en
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
        RETURNING ${CombustibleRepository.COLUMNAS_DESPACHO}
        `,
        [
          tenantId,
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
          data.costoUnitario,
          data.observaciones,
          usuarioId,
          data.despachadoEn,
        ]
      );
      return result.rows[0];
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
          throw new Error(`grifo_id ${data.grifoId} no existe en este tenant`, { cause: err });
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
    serieTalonario: string,
    nVale: number
  ): Promise<boolean> {
    const result = await client.query(
      `SELECT 1 FROM combustible_despachos
       WHERE tenant_id = $1 AND serie_talonario = $2 AND n_vale = $3
         AND anulada_en IS NULL`,
      [tenantId, serieTalonario, nVale]
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
    filtros: { equipoId?: number; serieTalonario?: string },
    { pageSize, offset }: Paginacion
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
    return result.rows[0] ?? null;
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
  async findHuecosTalonario(client: PoolClient, tenantId: string, serieTalonario: string) {
    const limites = await client.query<{ minimo: number | null; maximo: number | null }>(
      `SELECT MIN(n_vale) AS minimo, MAX(n_vale) AS maximo
       FROM combustible_despachos WHERE tenant_id = $1 AND serie_talonario = $2`,
      [tenantId, serieTalonario]
    );
    const { minimo, maximo } = limites.rows[0];
    if (minimo === null || maximo === null) {
      return { serie: serieTalonario, huecos: [] as number[], ultimo: null as number | null };
    }

    const huecos = await client.query<{ n_vale: number }>(
      `
      SELECT gs AS n_vale
      FROM generate_series($3::int, $4::int) AS gs
      WHERE NOT EXISTS (
        SELECT 1 FROM combustible_despachos d
        WHERE d.tenant_id = $1 AND d.serie_talonario = $2 AND d.n_vale = gs
      )
      ORDER BY gs
      `,
      [tenantId, serieTalonario, minimo, maximo]
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
    serieTalonario: string,
    despachoId: number,
    nuevoNVale: number
  ): Promise<number[]> {
    const result = await client.query<{ max_anterior: number | null }>(
      `SELECT MAX(n_vale) AS max_anterior
       FROM combustible_despachos
       WHERE tenant_id = $1 AND serie_talonario = $2 AND id <> $3`,
      [tenantId, serieTalonario, despachoId]
    );
    const maxAnterior = result.rows[0]?.max_anterior;
    if (maxAnterior === null || maxAnterior === undefined || nuevoNVale <= maxAnterior + 1) {
      return [];
    }
    const revelados: number[] = [];
    for (let n = maxAnterior + 1; n < nuevoNVale; n++) revelados.push(n);
    return revelados;
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
    serieTalonario: string,
    despachoId: number,
    nuevoNVale: number
  ): Promise<number | null> {
    const result = await client.query<{ max_anterior: number | null }>(
      `SELECT MAX(n_vale) AS max_anterior
       FROM combustible_despachos
       WHERE tenant_id = $1 AND serie_talonario = $2 AND id <> $3`,
      [tenantId, serieTalonario, despachoId]
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
    serieTalonario: string,
    nVale: number
  ): Promise<boolean> {
    const result = await client.query(
      `SELECT 1 FROM combustible_alertas
       WHERE tenant_id = $1 AND tipo = 'hueco_detectado'
         AND serie_talonario = $2 AND n_vale = $3
       LIMIT 1`,
      [tenantId, serieTalonario, nVale]
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
    serieTalonario: string,
    nVale: number
  ): Promise<{ llegoTarde: boolean }> {
    await client.query(
      `UPDATE combustible_alertas
       SET resuelta_en = now()
       WHERE tenant_id = $1 AND tipo = 'hueco_detectado' AND serie_talonario = $2
         AND n_vale = $3 AND resuelta_en IS NULL AND congelada_en IS NULL`,
      [tenantId, serieTalonario, nVale]
    );

    const congelada = await client.query(
      `SELECT 1 FROM combustible_alertas
       WHERE tenant_id = $1 AND tipo = 'hueco_detectado' AND serie_talonario = $2
         AND n_vale = $3 AND congelada_en IS NOT NULL
       LIMIT 1`,
      [tenantId, serieTalonario, nVale]
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

  async getConfig(client: PoolClient, tenantId: string) {
    const ventana = await this.getVentanaGraciaHoras(client, tenantId);
    const diasSinMedir = await this.getDiasSinMedir(client, tenantId);
    const topes = await this.getTopesDiarios(client, tenantId);
    const result = await client.query(
      `SELECT actualizado_en, actualizado_por FROM combustible_config WHERE tenant_id = $1`,
      [tenantId]
    );
    return {
      ventana_gracia_horas: ventana,
      dias_sin_medir: diasSinMedir,
      llenados_por_dia_max: topes.llenadosPorDiaMax,
      tope_diario_sin_capacidad_l: topes.topeSinCapacidadL,
      actualizado_en: result.rows[0]?.actualizado_en ?? null,
      actualizado_por: result.rows[0]?.actualizado_por ?? null,
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
      llenadosPorDiaMax: number | null;
      topeSinCapacidadL: number | null;
    },
    usuarioId: string
  ) {
    const result = await client.query(
      `
      INSERT INTO combustible_config
        (tenant_id, ventana_gracia_horas, dias_sin_medir,
         llenados_por_dia_max, tope_diario_sin_capacidad_l, actualizado_por)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (tenant_id) DO UPDATE
        SET ventana_gracia_horas = EXCLUDED.ventana_gracia_horas,
            dias_sin_medir = EXCLUDED.dias_sin_medir,
            llenados_por_dia_max = EXCLUDED.llenados_por_dia_max,
            tope_diario_sin_capacidad_l = EXCLUDED.tope_diario_sin_capacidad_l,
            actualizado_por = EXCLUDED.actualizado_por,
            actualizado_en = now()
      RETURNING ventana_gracia_horas, dias_sin_medir, llenados_por_dia_max,
                tope_diario_sin_capacidad_l, actualizado_en, actualizado_por
      `,
      [
        tenantId,
        valores.ventanaGraciaHoras,
        valores.diasSinMedir,
        valores.llenadosPorDiaMax,
        valores.topeSinCapacidadL,
        usuarioId,
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
      detalle: Record<string, unknown>;
      creado_en: Date;
    }>(
      `SELECT id, tipo, serie_talonario, n_vale, despacho_id, combustible_id,
              recepcion_id, detalle, creado_en
       FROM combustible_alertas
       WHERE tenant_id = $1
         AND tipo IN ('hueco_detectado', 'sobredespacho', 'diferencia_recepcion',
                      'medidor_inconsistente', 'descuadre_inventario',
                      'descuadre_ciclo', 'tope_diario_excedido')
         AND resuelta_en IS NULL
         AND congelada_en IS NULL
         AND creado_en < now() - make_interval(hours => $2)
       ORDER BY creado_en`,
      [tenantId, ventanaHoras]
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
    }>(
      `
      SELECT r.id, r.combustible_id, r.cantidad, c.unidad, c.tanque_nombre,
             c.umbral_diferencia_pct, dif.diferencia_litros
      FROM combustible_recepciones r
      JOIN combustible c ON c.id = r.combustible_id
      LEFT JOIN LATERAL (
        SELECT
          CASE
            WHEN antes.nivel IS NULL OR despues.nivel IS NULL THEN NULL
            WHEN otras.cuantas > 0 THEN NULL
            ELSE (despues.nivel - antes.nivel) + COALESCE(salidas.total, 0) - r.cantidad
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
        LEFT JOIN LATERAL (
          SELECT SUM(d.cantidad) AS total FROM combustible_despachos d
          WHERE d.combustible_id = r.combustible_id AND d.anulada_en IS NULL
            AND d.despachado_en > antes.leido_en AND d.despachado_en <= despues.leido_en
        ) salidas ON true
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS cuantas FROM combustible_recepciones r2
          WHERE r2.combustible_id = r.combustible_id AND r2.anulada_en IS NULL
            AND r2.id <> r.id
            AND r2.recibido_en > antes.leido_en AND r2.recibido_en <= despues.leido_en
        ) otras ON true
      ) dif ON true
      WHERE r.tenant_id = $1
        AND r.anulada_en IS NULL
        AND c.umbral_diferencia_pct IS NOT NULL
        AND dif.diferencia_litros IS NOT NULL
        AND abs(dif.diferencia_litros / NULLIF(r.cantidad, 0)) * 100 > c.umbral_diferencia_pct
        AND NOT EXISTS (
          SELECT 1 FROM combustible_alertas a
          WHERE a.tenant_id = $1 AND a.tipo = 'diferencia_recepcion' AND a.recepcion_id = r.id
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
      WITH ultima_recepcion AS (
        SELECT MAX(r.recibido_en) AS recibido_en
        FROM combustible_recepciones r
        WHERE r.tenant_id = $1 AND r.combustible_id = $2 AND r.anulada_en IS NULL
          AND r.recibido_en <= $4::timestamptz
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
      detalle: Record<string, unknown>;
      creado_en: Date;
    },
    ventanaHoras: number
  ) {
    const result = await client.query<{ id: string }>(
      `
      INSERT INTO combustible_anomalias
        (tenant_id, tipo, serie_talonario, n_vale, despacho_id, combustible_id,
         recepcion_id, alerta_id, detalle, detectada_en, ventana_horas)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
             recepcion_id, alerta_id, detalle, detectada_en, congelada_en,
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

  /** Lo despachado a UN mismo actor en la ventana móvil de 24 h que termina
   *  en `hasta` (migración 0079). "Actor" es el equipo si el destino es un
   *  equipo, y el tipo de destino cuando no lo hay -- todos los vales a
   *  planta suman juntos, porque planta es una sola.
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
    actor: { equipoId: number } | { tipoDestino: string },
    hasta: string,
    excluirDespachoId?: number
  ) {
    const porEquipo = "equipoId" in actor;
    const result = await client.query<{ total_l: string | null; vales: string }>(
      `
      SELECT
        COALESCE(SUM(
          d.cantidad * CASE WHEN c.unidad = 'gal' THEN 3.785411784 ELSE 1 END
        ), 0) AS total_l,
        COUNT(*) AS vales
      FROM combustible_despachos d
      LEFT JOIN combustible c ON c.id = d.combustible_id AND c.tenant_id = $1
      WHERE d.tenant_id = $1
        AND d.anulada_en IS NULL
        AND d.despachado_en <= $3::timestamptz
        AND d.despachado_en > $3::timestamptz - INTERVAL '24 hours'
        AND ($4::int IS NULL OR d.id <> $4::int)
        AND ${porEquipo ? "d.equipo_id = $2::int" : "(d.equipo_id IS NULL AND d.tipo_destino = $2::text)"}
      `,
      [tenantId, porEquipo ? actor.equipoId : actor.tipoDestino, hasta, excluirDespachoId ?? null]
    );
    return {
      totalL: Number(result.rows[0].total_l),
      vales: Number(result.rows[0].vales),
    };
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
      detalle: JSON.stringify(f.detalle),
    };
  }

  async crearAlertas(client: PoolClient, tenantId: string, filas: AlertaNueva[]) {
    if (filas.length === 0) return [];
    const COLS = 7; // tenant_id + las 6 de columnasAlerta que van al INSERT
    const valores: unknown[] = [];
    const placeholders = filas.map((f, i) => {
      const c = CombustibleRepository.columnasAlerta(f);
      valores.push(
        tenantId,
        c.tipo,
        c.serie_talonario,
        c.n_vale,
        c.despacho_id,
        c.combustible_id,
        c.recepcion_id,
        c.detalle
      );
      const base = i * (COLS + 1);
      return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8})`;
    });
    const result = await client.query(
      `
      INSERT INTO combustible_alertas
        (tenant_id, tipo, serie_talonario, n_vale, despacho_id, combustible_id, recepcion_id, detalle)
      VALUES ${placeholders.join(",")}
      RETURNING id, tipo, serie_talonario, n_vale, despacho_id, combustible_id, recepcion_id,
        detalle, creado_en
      `,
      valores
    );
    return result.rows;
  }

  async findAlertas(
    client: PoolClient,
    tenantId: string,
    filtros: { soloNoLeidas?: boolean },
    { pageSize, offset }: Paginacion
  ) {
    const condiciones: string[] = ["tenant_id = $1"];
    const valores: unknown[] = [tenantId];

    if (filtros.soloNoLeidas) {
      condiciones.push("leida_en IS NULL");
    }

    valores.push(pageSize, offset);
    const result = await client.query(
      `
      SELECT id, tipo, serie_talonario, n_vale, despacho_id, combustible_id,
        recepcion_id, detalle, creado_en, leida_en, resuelta_en, resuelta_por,
        congelada_en, COUNT(*) OVER() AS total_count
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

  /** `vale_anulado` y `sobredespacho` se resuelven A MANO: los dos son
   *  hechos consumados que alguien tiene que revisar y dar por buenos (el
   *  motivo de la anulación, el bidón que explica el exceso). El
   *  `hueco_detectado` NO entra acá porque se resuelve solo cuando llega el
   *  vale que faltaba (ver resolverAlertaHuecoSiExiste) -- y el filtro por
   *  tipo del WHERE no es redundante con el controller: es lo que impide
   *  que alguien silencie a mano un hueco que en realidad sigue abierto. */
  /** Los tipos que se cierran A MANO, porque alguien tiene que mirarlos.
   *
   *  Hasta 0077 la lista tenía solo dos, y los cuatro agregados después
   *  (0073/0074/0076) habían quedado SIN NINGÚN camino de cierre: se
   *  acumulaban abiertos para siempre, y lo único que los sacaba de la
   *  campanita era "marcar todas leídas" -- que no es revisar, es tapar.
   *
   *  Los que NO están acá es porque se resuelven solos y meterlos sería
   *  darle a una persona la posibilidad de cerrar algo que el sistema sabe
   *  contestar mejor: `hueco_detectado` (llega el vale que faltaba),
   *  `nivel_bajo` (se repone) y `tanque_sin_medir` (se mide). */
  private static readonly TIPOS_REVISABLES = [
    "vale_anulado",
    "sobredespacho",
    "despacho_tardio",
    "diferencia_recepcion",
    "medidor_inconsistente",
    "descuadre_inventario",
    "descuadre_ciclo",
    "vale_fuera_de_orden",
    "lectura_retroactiva",
    "tope_diario_excedido",
  ];

  /** El motivo se guarda dentro de `detalle` y no en una columna propia: es
   *  el único dato de la revisión, la tabla ya tiene el JSONB para lo que
   *  varía por tipo, y agregarle una columna a `combustible_alertas` que solo
   *  se llena en la mitad de las filas es peor forma que esto. */
  async resolverAlertaManual(
    client: PoolClient,
    tenantId: string,
    alertaId: number,
    usuarioId: string,
    motivo: string
  ) {
    const result = await client.query(
      `
      UPDATE combustible_alertas
      SET resuelta_en = now(),
          resuelta_por = $1,
          detalle = detalle || jsonb_build_object('motivo_revision', $4::text)
      WHERE id = $2 AND tenant_id = $3
        AND tipo = ANY($5::text[]) AND resuelta_en IS NULL
      RETURNING id, tipo, serie_talonario, n_vale, despacho_id, detalle, creado_en, leida_en, resuelta_en, resuelta_por
      `,
      [usuarioId, alertaId, tenantId, motivo, CombustibleRepository.TIPOS_REVISABLES]
    );
    return result.rows[0] ?? null;
  }

  /** Destinatarios de correo/campanita: "gerencia" es el rol admin, sin
   *  concepto propio en el modelo de datos -- y solo los que además tienen
   *  el módulo combustible habilitado, mismo criterio que
   *  obtenerModulosPermitidos() en auth.service.ts pero a la inversa (de
   *  módulo a lista de usuarios, no de usuario a lista de módulos). */
  async findAdminsConCombustibleHabilitado(client: PoolClient, tenantId: string) {
    const result = await client.query<{ id: string; email: string; nombre: string }>(
      `
      SELECT u.id, u.email, u.nombre
      FROM usuarios u
      JOIN usuario_modulos um ON um.usuario_id = u.id AND um.modulo = 'combustible'
      JOIN tenant_modulos tm ON tm.tenant_id = u.tenant_id AND tm.modulo = 'combustible'
      WHERE u.tenant_id = $1 AND u.rol = 'admin' AND u.activo = true AND tm.estado = 'habilitado'
      `,
      [tenantId]
    );
    return result.rows;
  }

  // ── Grifos externos (migrations/0063) ────────────────────────────────

  async findGrifos(client: PoolClient, tenantId: string) {
    const result = await client.query(
      `SELECT id, nombre, activo, abastece_ruta, abastece_tanque, usuario_id, creado_en
       FROM combustible_grifos WHERE tenant_id = $1 ORDER BY nombre ASC`,
      [tenantId]
    );
    return result.rows;
  }

  async findGrifoPorId(client: PoolClient, tenantId: string, id: number) {
    const result = await client.query(
      `SELECT id, nombre, activo, abastece_ruta, abastece_tanque, usuario_id, creado_en
       FROM combustible_grifos WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );
    return result.rows[0] ?? null;
  }

  async crearGrifo(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    data: { nombre: string; abasteceRuta: boolean; abasteceTanque: boolean }
  ) {
    try {
      const result = await client.query(
        `INSERT INTO combustible_grifos
           (tenant_id, nombre, abastece_ruta, abastece_tanque, usuario_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, nombre, activo, abastece_ruta, abastece_tanque, usuario_id, creado_en`,
        [tenantId, data.nombre, data.abasteceRuta, data.abasteceTanque, usuarioId]
      );
      return result.rows[0];
    } catch (err) {
      if (esViolacionUnicidad(err)) {
        throw new Error(`ya existe un grifo llamado "${data.nombre}" en este tenant`, {
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
    data: { nombre: string; activo: boolean; abasteceRuta: boolean; abasteceTanque: boolean }
  ) {
    try {
      const result = await client.query(
        `UPDATE combustible_grifos
         SET nombre = $1, activo = $2, abastece_ruta = $3, abastece_tanque = $4
         WHERE id = $5 AND tenant_id = $6
         RETURNING id, nombre, activo, abastece_ruta, abastece_tanque, usuario_id, creado_en`,
        [data.nombre, data.activo, data.abasteceRuta, data.abasteceTanque, id, tenantId]
      );
      return result.rows[0] ?? null;
    } catch (err) {
      if (esViolacionUnicidad(err)) {
        throw new Error(`ya existe un grifo llamado "${data.nombre}" en este tenant`, {
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
          throw new Error(`grifo_id ${data.grifoId} no existe en este tenant`, { cause: err });
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
    id, tenant_id, combustible_id, grifo_id, cantidad, costo_unitario,
    (cantidad * costo_unitario) AS costo_total,
    tipo_documento, numero_documento, recibido_en, usuario_id, creado_en,
    anulada_en, anulada_por, motivo_anulacion
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
      combustibleId: number;
      grifoId: number;
      cantidad: number;
      costoUnitario: number;
      tipoDocumento: string | null;
      numeroDocumento: string | null;
      recibidoEn: string;
    }
  ) {
    try {
      const result = await client.query(
        `
        INSERT INTO combustible_recepciones (
          tenant_id, combustible_id, grifo_id, cantidad, costo_unitario,
          tipo_documento, numero_documento, recibido_en, usuario_id
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        RETURNING ${CombustibleRepository.COLUMNAS_RECEPCION}
        `,
        [
          tenantId,
          data.combustibleId,
          data.grifoId,
          data.cantidad,
          data.costoUnitario,
          data.tipoDocumento,
          data.numeroDocumento,
          data.recibidoEn,
          usuarioId,
        ]
      );
      return result.rows[0];
    } catch (err) {
      if (esViolacionForeignKey(err)) {
        const constraint = (err as { constraint?: string }).constraint ?? "";
        if (constraint.includes("grifo_id")) {
          throw new Error(`grifo_id ${data.grifoId} no existe en este tenant`, { cause: err });
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
    filtros: { combustibleId?: number },
    { pageSize, offset }: Paginacion
  ) {
    const condiciones: string[] = ["r.tenant_id = $1"];
    const valores: unknown[] = [tenantId];

    if (filtros.combustibleId !== undefined) {
      valores.push(filtros.combustibleId);
      condiciones.push(`r.combustible_id = $${valores.length}`);
    }

    valores.push(pageSize, offset);
    const result = await client.query(
      `
      SELECT r.id, r.combustible_id, r.grifo_id, r.cantidad, r.costo_unitario,
             (r.cantidad * r.costo_unitario) AS costo_total,
             r.tipo_documento, r.numero_documento, r.recibido_en, r.usuario_id,
             r.creado_en, r.anulada_en, r.anulada_por, r.motivo_anulacion,
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
             COUNT(*) OVER() AS total_count
      FROM combustible_recepciones r
      -- INNER para tanque y grifo (las dos FK son NOT NULL, siempre hay
      -- fila); LEFT para los usuarios, que son nullable por el ON DELETE
      -- SET NULL -- mismo criterio que findLecturas/findPrecios.
      JOIN combustible c ON c.id = r.combustible_id
      JOIN combustible_grifos g ON g.id = r.grifo_id
      LEFT JOIN usuarios autor ON autor.id = r.usuario_id
      LEFT JOIN usuarios anulador ON anulador.id = r.anulada_por
      LEFT JOIN LATERAL (
        SELECT
          antes.nivel AS nivel_antes,
          despues.nivel AS nivel_despues,
          CASE
            -- Sin las dos lecturas no hay nada que comparar. Y si en la misma
            -- ventana entró OTRA recepción, la diferencia es de las dos
            -- juntas: atribuírsela a esta sería inventar. En los dos casos
            -- NULL, y la UI lo muestra como "—".
            WHEN antes.nivel IS NULL OR despues.nivel IS NULL THEN NULL
            WHEN otras.cuantas > 0 THEN NULL
            ELSE (despues.nivel - antes.nivel) + COALESCE(salidas.total, 0) - r.cantidad
          END AS diferencia_litros
        FROM (
          SELECT l.nivel, l.leido_en
          FROM combustible_lecturas l
          WHERE l.combustible_id = r.combustible_id AND l.anulada_en IS NULL
            AND l.leido_en <= r.recibido_en
          ORDER BY l.leido_en DESC, l.id DESC LIMIT 1
        ) antes
        FULL JOIN (
          SELECT l.nivel, l.leido_en
          FROM combustible_lecturas l
          WHERE l.combustible_id = r.combustible_id AND l.anulada_en IS NULL
            AND l.leido_en > r.recibido_en
          ORDER BY l.leido_en ASC, l.id ASC LIMIT 1
        ) despues ON true
        -- Lo que SALIÓ del tanque entre las dos lecturas: sin sumarlo de
        -- vuelta, un despacho hecho en el medio se vería como faltante.
        LEFT JOIN LATERAL (
          SELECT SUM(d.cantidad) AS total
          FROM combustible_despachos d
          WHERE d.combustible_id = r.combustible_id
            -- Un vale anulado no sacó combustible del tanque: sumarlo
            -- inventaría un faltante que no existe (migración 0067).
            AND d.anulada_en IS NULL
            AND d.despachado_en > antes.leido_en
            AND d.despachado_en <= despues.leido_en
        ) salidas ON true
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS cuantas
          FROM combustible_recepciones r2
          WHERE r2.combustible_id = r.combustible_id AND r2.anulada_en IS NULL
            AND r2.id <> r.id
            AND r2.recibido_en > antes.leido_en
            AND r2.recibido_en <= despues.leido_en
        ) otras ON true
      ) dif ON true
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
  ): Promise<Array<{ cantidad: number; diferencia_litros: number }>> {
    const result = await client.query<{ cantidad: string; diferencia_litros: string }>(
      `
      SELECT r.cantidad, dif.diferencia_litros
      FROM combustible_recepciones r
      LEFT JOIN LATERAL (
        SELECT
          CASE
            WHEN antes.nivel IS NULL OR despues.nivel IS NULL THEN NULL
            WHEN otras.cuantas > 0 THEN NULL
            ELSE (despues.nivel - antes.nivel) + COALESCE(salidas.total, 0) - r.cantidad
          END AS diferencia_litros
        FROM (
          SELECT l.nivel, l.leido_en
          FROM combustible_lecturas l
          WHERE l.combustible_id = r.combustible_id AND l.anulada_en IS NULL
            AND l.leido_en <= r.recibido_en
          ORDER BY l.leido_en DESC, l.id DESC LIMIT 1
        ) antes
        FULL JOIN (
          SELECT l.nivel, l.leido_en
          FROM combustible_lecturas l
          WHERE l.combustible_id = r.combustible_id AND l.anulada_en IS NULL
            AND l.leido_en > r.recibido_en
          ORDER BY l.leido_en ASC, l.id ASC LIMIT 1
        ) despues ON true
        LEFT JOIN LATERAL (
          SELECT SUM(d.cantidad) AS total
          FROM combustible_despachos d
          WHERE d.combustible_id = r.combustible_id
            AND d.anulada_en IS NULL
            AND d.despachado_en > antes.leido_en
            AND d.despachado_en <= despues.leido_en
        ) salidas ON true
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS cuantas
          FROM combustible_recepciones r2
          WHERE r2.combustible_id = r.combustible_id AND r2.anulada_en IS NULL
            AND r2.id <> r.id
            AND r2.recibido_en > antes.leido_en
            AND r2.recibido_en <= despues.leido_en
        ) otras ON true
      ) dif ON true
      WHERE r.tenant_id = $1 AND r.combustible_id = $2 AND r.anulada_en IS NULL
        AND dif.diferencia_litros IS NOT NULL
      `,
      [tenantId, combustibleId]
    );
    return result.rows.map((f) => ({
      cantidad: Number(f.cantidad),
      diferencia_litros: Number(f.diferencia_litros),
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
  async findMuestraDescuadresParaCalibracion(
    client: PoolClient,
    tenantId: string,
    combustibleId: number
  ): Promise<Array<{ descuadre: number; recepciones: number; capacidad: number; leido_en: Date }>> {
    const result = await client.query<{
      descuadre: string;
      recepciones: string;
      capacidad_total: string;
      leido_en: Date;
    }>(
      `
      WITH lecturas AS (
        SELECT l.nivel, l.leido_en,
               LAG(l.nivel) OVER (ORDER BY l.leido_en, l.id) AS nivel_anterior,
               LAG(l.leido_en) OVER (ORDER BY l.leido_en, l.id) AS leido_en_anterior
        FROM combustible_lecturas l
        WHERE l.tenant_id = $1 AND l.combustible_id = $2 AND l.anulada_en IS NULL
      )
      SELECT
        (le.nivel - (le.nivel_anterior + COALESCE(rec.total, 0) - COALESCE(des.total, 0)))
          AS descuadre,
        COALESCE(rec.total, 0) AS recepciones,
        c.capacidad_total,
        le.leido_en
      FROM lecturas le
      JOIN combustible c ON c.id = $2 AND c.tenant_id = $1
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
      ORDER BY le.leido_en
      `,
      [tenantId, combustibleId]
    );
    return result.rows.map((f) => ({
      descuadre: Number(f.descuadre),
      recepciones: Number(f.recepciones),
      capacidad: Number(f.capacidad_total),
      leido_en: f.leido_en,
    }));
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
    await this.recalcularCostoPromedio(client, tenantId, recepcion.combustible_id);
    const tanque = await this.findById(client, tenantId, recepcion.combustible_id);

    return { recepcion, tanque };
  }
}
