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
const COLUMNAS_EQUIPO = `id, placa_codigo, tipo, marca, modelo, tipo_medidor,
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
      `INSERT INTO equipos (tenant_id, placa_codigo, tipo, marca, modelo, tipo_medidor,
         capacidad_tanque, capacidad_tanque_unidad, conductor_nombre, conductor_dni,
         consumo_maximo_l, usa_urea, grifo_interno_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING ${COLUMNAS_EQUIPO}`,
      [
        tenantId,
        placa_codigo,
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
        tipo = $2,
        marca = $3,
        modelo = $4,
        tipo_medidor = $5,
        capacidad_tanque = $6,
        capacidad_tanque_unidad = $7,
        conductor_nombre = $8,
        conductor_dni = $9,
        consumo_maximo_l = $10,
        usa_urea = $11
      WHERE id = $12 AND tenant_id = $13
      RETURNING ${COLUMNAS_EQUIPO}`,
      [
        placa_codigo,
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
};
