/** src/modules/equipos/equipos.lecturas.ts
 *
 * Las lecturas del medidor de cada unidad (migración 0187): el horómetro o el
 * kilometraje que marcaba en un momento. Es de Flota y funciona solo: no lee
 * vales ni viajes. Los otros módulos podrán dejar la suya con otro `origen`.
 *
 * Todo corre dentro de la transacción de `withTenant`. Dos reglas:
 *  - NO RETROCEDER: una lectura no es menor que la anterior de la unidad ni mayor
 *    que la siguiente (por fecha de lectura, del mismo tipo de medidor). Se
 *    comprueba con la fila de la unidad bloqueada, así dos registros a la vez no
 *    se saltan la regla.
 *  - LO PASADO NO SE REESCRIBE: corregir es anular (con motivo) y registrar otra.
 *    Un trigger de la base lo impone. */
import type { PoolClient } from "pg";

import type { RegistrarLecturaInput } from "../../server/schemas/equipos.schema";
import { AppError } from "../../server/shared/middlewares/error.middleware";
import { huellaDeRegistro, idempotentInsert } from "../../server/shared/utils/idempotentInsert";

const COLUMNAS = `l.id::int AS id, l.equipo_id, l.tipo, l.valor::float8 AS valor, l.leido_en, l.origen,
       l.creado_en, u.nombre AS registrado_por, l.anulada_en, l.motivo_anulacion,
       ua.nombre AS anulada_por_nombre`;

const DESDE = `FROM equipo_lecturas l
  LEFT JOIN usuarios u ON u.id = l.usuario_id
  LEFT JOIN usuarios ua ON ua.id = l.anulada_por`;

const ETIQUETA_TIPO = { horometro: "horómetro", odometro: "odómetro" } as const;

/** Bloquea la fila de la unidad y devuelve su medidor. 404 si no existe. */
async function bloquearUnidad(client: PoolClient, tenantId: string, equipoId: number) {
  const r = await client.query<{ tipo_medidor: "horometro" | "odometro" | null }>(
    `SELECT tipo_medidor FROM equipos WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [tenantId, equipoId]
  );
  if (!r.rows[0]) throw new AppError(404, "La unidad no existe");
  return r.rows[0];
}

async function leerLectura(client: PoolClient, tenantId: string, id: number) {
  const r = await client.query(`SELECT ${COLUMNAS} ${DESDE} WHERE l.tenant_id = $1 AND l.id = $2`, [
    tenantId,
    id,
  ]);
  return r.rows[0] ?? null;
}

/** Registra una lectura manual. Con `cliente_uuid`, el reintento de una que estuvo en la cola sin
 *  señal devuelve la misma fila en vez de crear otra (`creado: false`). */
export async function registrarLectura(
  client: PoolClient,
  tenantId: string,
  usuarioId: string,
  equipoId: number,
  data: RegistrarLecturaInput
) {
  return idempotentInsert({
    client,
    tenantId,
    modulo: "flota",
    clienteUuid: data.cliente_uuid,
    huella: huellaDeRegistro("equipo_lectura", {
      equipo_id: equipoId,
      valor: data.valor,
      leido_en: data.leido_en,
    }),
    insertar: async () => {
      const unidad = await bloquearUnidad(client, tenantId, equipoId);
      const tipo = unidad.tipo_medidor;
      if (!tipo) {
        throw new AppError(
          400,
          "La unidad no tiene medidor configurado: elige horómetro u odómetro en su ficha"
        );
      }
      // La hora se toma DESPUÉS del candado, no con now() (hora de inicio de la transacción).
      const instante = (await client.query<{ t: Date }>(`SELECT clock_timestamp() AS t`)).rows[0].t;
      const leidoEn = data.leido_en ? new Date(data.leido_en) : instante;

      const anterior = await client.query<{ valor: number; leido_en: Date }>(
        `SELECT valor::float8 AS valor, leido_en FROM equipo_lecturas
          WHERE tenant_id = $1 AND equipo_id = $2 AND tipo = $3 AND anulada_en IS NULL
            AND leido_en <= $4
          ORDER BY leido_en DESC, id DESC LIMIT 1`,
        [tenantId, equipoId, tipo, leidoEn]
      );
      if (anterior.rows[0] && data.valor < anterior.rows[0].valor) {
        throw new AppError(
          400,
          `El ${ETIQUETA_TIPO[tipo]} (${data.valor}) es menor que el último registrado ` +
            `(${anterior.rows[0].valor}). Si la lectura anterior está mal, anúlala primero`
        );
      }
      const siguiente = await client.query<{ valor: number; leido_en: Date }>(
        `SELECT valor::float8 AS valor, leido_en FROM equipo_lecturas
          WHERE tenant_id = $1 AND equipo_id = $2 AND tipo = $3 AND anulada_en IS NULL
            AND leido_en > $4
          ORDER BY leido_en ASC, id ASC LIMIT 1`,
        [tenantId, equipoId, tipo, leidoEn]
      );
      if (siguiente.rows[0] && data.valor > siguiente.rows[0].valor) {
        throw new AppError(
          400,
          `El ${ETIQUETA_TIPO[tipo]} (${data.valor}) es mayor que una lectura posterior ya ` +
            `registrada (${siguiente.rows[0].valor}). Revisa la fecha o anula la otra`
        );
      }
      const creada = await client.query<{ id: number }>(
        `INSERT INTO equipo_lecturas
           (tenant_id, equipo_id, tipo, valor, leido_en, origen, cliente_uuid, usuario_id)
         VALUES ($1, $2, $3, $4, $5, 'manual', $6, $7)
         RETURNING id::int AS id`,
        [tenantId, equipoId, tipo, data.valor, leidoEn, data.cliente_uuid ?? null, usuarioId]
      );
      const id = creada.rows[0].id;
      return { id, fila: await leerLectura(client, tenantId, id) };
    },
    recuperar: (id) => leerLectura(client, tenantId, id),
  });
}

/** Anula una lectura vigente, con motivo. Devuelve la lectura como quedó. */
export async function anularLectura(
  client: PoolClient,
  tenantId: string,
  usuarioId: string,
  equipoId: number,
  lecturaId: number,
  motivo: string
) {
  await bloquearUnidad(client, tenantId, equipoId);
  const actual = await client.query<{ anulada_en: Date | null }>(
    `SELECT anulada_en FROM equipo_lecturas
      WHERE tenant_id = $1 AND equipo_id = $2 AND id = $3`,
    [tenantId, equipoId, lecturaId]
  );
  if (!actual.rows[0]) throw new AppError(404, "La lectura no existe");
  if (actual.rows[0].anulada_en) throw new AppError(409, "Esa lectura ya está anulada");
  await client.query(
    `UPDATE equipo_lecturas
        SET anulada_en = clock_timestamp(), anulada_por = $4, motivo_anulacion = $5
      WHERE tenant_id = $1 AND equipo_id = $2 AND id = $3`,
    [tenantId, equipoId, lecturaId, usuarioId, motivo]
  );
  return leerLectura(client, tenantId, lecturaId);
}

/** El historial de la unidad, lo más reciente primero, con las anuladas y su motivo. */
export async function listarLecturas(
  client: PoolClient,
  tenantId: string,
  equipoId: number,
  limite: number
) {
  const unidad = await client.query(`SELECT 1 FROM equipos WHERE tenant_id = $1 AND id = $2`, [
    tenantId,
    equipoId,
  ]);
  if (!unidad.rows[0]) throw new AppError(404, "La unidad no existe");
  const r = await client.query(
    `SELECT ${COLUMNAS} ${DESDE}
      WHERE l.tenant_id = $1 AND l.equipo_id = $2
      ORDER BY l.leido_en DESC, l.id DESC
      LIMIT $3`,
    [tenantId, equipoId, limite]
  );
  return r.rows;
}

/** La última lectura vigente de la unidad (o null si todavía no tiene ninguna). */
export async function ultimaLectura(client: PoolClient, tenantId: string, equipoId: number) {
  const unidad = await client.query<{ tipo_medidor: string | null }>(
    `SELECT tipo_medidor FROM equipos WHERE tenant_id = $1 AND id = $2`,
    [tenantId, equipoId]
  );
  if (!unidad.rows[0]) throw new AppError(404, "La unidad no existe");
  const r = await client.query(
    `SELECT ${COLUMNAS} ${DESDE}
      WHERE l.tenant_id = $1 AND l.equipo_id = $2 AND l.anulada_en IS NULL
      ORDER BY l.leido_en DESC, l.id DESC
      LIMIT 1`,
    [tenantId, equipoId]
  );
  return { tipo_medidor: unidad.rows[0].tipo_medidor, lectura: r.rows[0] ?? null };
}
