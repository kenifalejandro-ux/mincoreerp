/** src/modules/equipos/equipos.repository.ts */

import type { PoolClient } from "pg";
import type { Paginacion } from "../../server/shared/utils/pagination";

// Sin schema de validación (req.body pasa directo desde el controller) --
// documenta la forma asumida por las queries de abajo, no valida en runtime.
export type EquipoPayload = {
  placa_codigo: string;
  tipo: string;
  marca?: string;
  modelo?: string;
  // Código interno de la empresa (columna CODIGO de la planilla de flota,
  // ej. "CU-14") -- distinto de la placa. Migración 0103. Opcional: no toda
  // la flota lo trae.
  codigo_interno?: string;
  // Qué instrumento mide este equipo en compra_externa (Fase B de
  // combustible) -- ver migrations/0062. undefined/null = no configurado.
  tipo_medidor?: string;
  // Capacidad del tanque de ESTA unidad, para detectar sobredespacho (ver
  // migrations/0069). Las dos van juntas o ninguna; undefined = sin
  // configurar, y entonces el sobredespacho no se evalúa para este equipo.
  capacidad_tanque?: number;
  capacidad_tanque_unidad?: string;
  consumo_maximo_l?: number | null;
  conductor_nombre?: string;
  conductor_dni?: string;
  // Si esta unidad usa urea automotriz (migración 0092, combustible). NOT
  // NULL DEFAULT true en la base -- undefined acá se resuelve a true, igual
  // que el default de la columna.
  usa_urea?: boolean;
  // 0097: solo en el alta. NULL = el único grifo de la empresa (lo asigna la
  // base). El PUT no lo toca: mover de grifo tiene su propio camino.
  grifo_interno_id?: number;
};

// Todas las columnas devueltas por el ABM -- centralizadas para que agregar
// una no obligue a tocar cuatro queries y olvidarse de la quinta.
const COLUMNAS_EQUIPO = `id, placa_codigo, codigo_interno, tipo, marca, modelo, tipo_medidor,
  capacidad_tanque, capacidad_tanque_unidad, consumo_maximo_l,
  conductor_nombre, conductor_dni, usa_urea, activo, creado_en, grifo_interno_id`;

export const EquiposRepository = {
  async findAll(client: PoolClient, tenantId: string, { pageSize, offset }: Paginacion) {
    const result = await client.query(
      `
      SELECT ${COLUMNAS_EQUIPO},
        COUNT(*) OVER() AS total_count
      FROM equipos
      WHERE tenant_id = $1
      ORDER BY id DESC
      LIMIT $2 OFFSET $3
    `,
      [tenantId, pageSize, offset]
    );

    return result.rows;
  },

  /** Toda la flota, sin paginar -- para el export a Excel. La lista visible
   *  en pantalla pagina de a 50 porque el operario la recorre a ojo; el
   *  archivo lo abre en una planilla, así que tiene que traer todo de una. */
  async findAllParaExportar(client: PoolClient, tenantId: string) {
    const result = await client.query(
      `SELECT ${COLUMNAS_EQUIPO} FROM equipos WHERE tenant_id = $1 ORDER BY tipo, placa_codigo`,
      [tenantId]
    );
    return result.rows;
  },

  async findById(client: PoolClient, tenantId: string, id: number) {
    const result = await client.query(
      `SELECT ${COLUMNAS_EQUIPO}
       FROM equipos WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );
    return result.rows[0] ?? null;
  },

  async create(client: PoolClient, tenantId: string, data: EquipoPayload) {
    const { placa_codigo, tipo, marca, modelo, tipo_medidor } = data;

    const result = await client.query(
      `INSERT INTO equipos (tenant_id, placa_codigo, codigo_interno, tipo, marca, modelo,
         tipo_medidor, capacidad_tanque, capacidad_tanque_unidad, conductor_nombre,
         conductor_dni, consumo_maximo_l, usa_urea, grifo_interno_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING ${COLUMNAS_EQUIPO}`,
      [
        tenantId,
        placa_codigo,
        data.codigo_interno ?? null,
        tipo,
        marca ?? null,
        modelo ?? null,
        tipo_medidor ?? null,
        data.capacidad_tanque ?? null,
        data.capacidad_tanque_unidad ?? null,
        data.conductor_nombre ?? null,
        data.conductor_dni ?? null,
        data.consumo_maximo_l ?? null,
        data.usa_urea ?? true,
        data.grifo_interno_id ?? null,
      ]
    );

    return result.rows[0];
  },

  async update(client: PoolClient, tenantId: string, id: number, data: EquipoPayload) {
    const { placa_codigo, tipo, marca, modelo, tipo_medidor } = data;

    const result = await client.query(
      `UPDATE equipos SET
        placa_codigo = $1,
        codigo_interno = $2,
        tipo = $3,
        marca = $4,
        modelo = $5,
        tipo_medidor = $6,
        capacidad_tanque = $7,
        capacidad_tanque_unidad = $8,
        conductor_nombre = $9,
        conductor_dni = $10,
        consumo_maximo_l = $11,
        usa_urea = $12
      WHERE id = $13 AND tenant_id = $14
      RETURNING ${COLUMNAS_EQUIPO}`,
      [
        placa_codigo,
        data.codigo_interno ?? null,
        tipo,
        marca ?? null,
        modelo ?? null,
        tipo_medidor ?? null,
        data.capacidad_tanque ?? null,
        data.capacidad_tanque_unidad ?? null,
        data.conductor_nombre ?? null,
        data.conductor_dni ?? null,
        data.consumo_maximo_l ?? null,
        data.usa_urea ?? true,
        id,
        tenantId,
      ]
    );

    return result.rows[0] ?? null;
  },

  /** Lectura mínima para los chequeos por-equipo de un despacho (ver
   *  combustible.service.ts): `tipo_medidor` para compra_externa (0062) y
   *  la capacidad de tanque para el sobredespacho (0069). No trae las demás
   *  columnas porque no hacen falta ahí. */
  async findTipoMedidor(client: PoolClient, tenantId: string, id: number) {
    const result = await client.query<{
      id: number;
      tipo_medidor: string | null;
      capacidad_tanque: string | null;
      capacidad_tanque_unidad: string | null;
      // usa_urea (migración 0092) viaja en la misma consulta -- es el
      // mismo equipo que el vale de compra_externa ya busca, solo que
      // combustible.service.ts lo lee para un cruce distinto según el
      // `producto` del vale (tipo_medidor para combustible, usa_urea
      // para urea).
      usa_urea: boolean;
      placa_codigo: string;
    }>(
      `SELECT id, tipo_medidor, capacidad_tanque, capacidad_tanque_unidad, usa_urea, placa_codigo
       FROM equipos WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );
    return result.rows[0] ?? null;
  },

  async delete(client: PoolClient, tenantId: string, id: number) {
    const result = await client.query(`DELETE FROM equipos WHERE id = $1 AND tenant_id = $2`, [
      id,
      tenantId,
    ]);
    return (result.rowCount ?? 0) > 0;
  },

  /** Importación masiva (planilla de flota). Solo toca placa/código
   *  interno/tipo/marca/modelo -- un ON CONFLICT que reimporta NO puede
   *  pisar capacidad de tanque, medidor, conductor ni grifo: esos los carga
   *  la operación a mano y una planilla de inventario no los trae. Mismo
   *  patrón que repuestos.repository.ts#createBulk (upsert por lotes,
   *  dedupe dentro del lote para no chocar contra sí mismo en el mismo
   *  INSERT). */
  async createBulk(
    client: PoolClient,
    tenantId: string,
    items: {
      placa_codigo: string;
      tipo: string;
      marca?: string;
      modelo?: string;
      codigo_interno?: string;
    }[]
  ) {
    const TAMANO_LOTE = 1000;
    const resultados: unknown[] = [];

    for (let inicio = 0; inicio < items.length; inicio += TAMANO_LOTE) {
      const lote = items.slice(inicio, inicio + TAMANO_LOTE);

      const porPlaca = new Map<string, (typeof lote)[number]>();
      for (const fila of lote) porPlaca.set(fila.placa_codigo, fila);
      const filasUnicas = [...porPlaca.values()];

      const placeholders = filasUnicas
        .map(
          (_, i) =>
            `($${i * 6 + 1}, $${i * 6 + 2}, $${i * 6 + 3}, $${i * 6 + 4}, $${i * 6 + 5}, $${i * 6 + 6})`
        )
        .join(", ");

      const valores = filasUnicas.flatMap((d) => [
        tenantId,
        d.placa_codigo,
        d.codigo_interno ?? null,
        d.tipo,
        d.marca ?? null,
        d.modelo ?? null,
      ]);

      const result = await client.query(
        `INSERT INTO equipos (tenant_id, placa_codigo, codigo_interno, tipo, marca, modelo)
         VALUES ${placeholders}
         ON CONFLICT (tenant_id, placa_codigo) DO UPDATE SET
           codigo_interno = EXCLUDED.codigo_interno,
           tipo = EXCLUDED.tipo,
           marca = EXCLUDED.marca,
           modelo = EXCLUDED.modelo
         RETURNING ${COLUMNAS_EQUIPO}`,
        valores
      );
      resultados.push(...result.rows);
    }

    return resultados;
  },

  /** Eliminación masiva: mismo camino de RLS que delete() (tenant_id en el
   *  WHERE), pero en UNA sola vuelta a la base en vez de N deletes. */
  async deleteMany(client: PoolClient, tenantId: string, ids: number[]) {
    const result = await client.query(
      `DELETE FROM equipos WHERE tenant_id = $1 AND id = ANY($2::int[]) RETURNING id`,
      [tenantId, ids]
    );
    return result.rows.map((r: { id: number }) => r.id);
  },
};
