/** src/server/shared/utils/idempotentInsert.ts
 *
 * Hace que una creación se pueda reintentar sin duplicar, apoyándose en la
 * tabla `idempotency_keys` (migración 0044 — ahí está el porqué de la tabla
 * aparte y de que no tenga columna `status`).
 *
 * El caso real: el POST llega, se commitea, y la respuesta se pierde de
 * vuelta porque se cortó la señal. El dispositivo reintenta con el MISMO
 * `cliente_uuid` y acá se detecta que ese trabajo ya está hecho.
 *
 * ── Contrato de uso (importante) ─────────────────────────────────────────
 *
 * `client` TIENE que venir de una transacción con `app.tenant_id` ya
 * seteado — o sea, de dentro de un withTenant(). No es solo por RLS
 * (idempotency_keys lo tiene forzado, un pool.query directo revienta con
 * `invalid input syntax for type uuid: ""`): es que TODA la garantía de
 * este helper depende de que la reserva de la clave y la creación de la
 * fila commiteen o reviertan JUNTAS. Llamarlo con dos conexiones distintas
 * dejaría claves reservadas para filas que nunca se crearon.
 *
 * ── Por qué se reserva la clave ANTES de crear la fila ───────────────────
 *
 * El orden inverso (crear la fila y después reservar) también evitaría
 * duplicados, pero recién al final: dos requests concurrentes harían los
 * dos todo el trabajo, y el perdedor tendría que deshacerlo con un
 * SAVEPOINT y quemar un valor de la secuencia por nada. Reservando primero,
 * el segundo request queda bloqueado en el índice único de la PK antes de
 * tocar nada más, y cuando el primero confirma se despierta, ve el
 * conflicto y devuelve la fila del ganador.
 *
 * `fila_id` queda NULL entre la reserva y el UPDATE final, pero es un
 * estado que solo existe DENTRO de esta transacción — ninguna otra sesión
 * lo ve, y si el proceso muere en el medio se revierte todo junto.
 */
import { createHash } from "node:crypto";

import type { PoolClient } from "pg";

import { AppError } from "../middlewares/error.middleware";

/** Un texto corto que identifica QUÉ registra una petición: el tipo y un hash de los
 *  campos que lo distinguen. Mismo registro => misma huella (el reintento de la
 *  cola manda el mismo cuerpo); otro registro con el mismo cliente_uuid => huella
 *  distinta. Pasar solo campos de identidad: ni los que el servidor completa ni la HORA
 *  (un reintento a mano recalcula la hora del formulario y no por eso es otro registro). */
export function huellaDeRegistro(tipo: string, campos: Record<string, unknown>): string {
  const ordenado = JSON.stringify(
    Object.keys(campos)
      .sort()
      .map((k) => [k, campos[k] ?? null])
  );
  return `${tipo}:${createHash("sha256").update(ordenado).digest("hex").slice(0, 16)}`;
}

export interface ResultadoIdempotente<T> {
  /** La fila creada, o la que ya existía si esto fue un reintento.
   *
   *  `null` en un único caso: la clave ya estaba pero la fila que había
   *  creado ya no existe (alguien la borró después). No se vuelve a crear
   *  —el pedido original SÍ se cumplió, y recrearla resucitaría algo que
   *  se eliminó a propósito—, así que quien llame debe responder "listo,
   *  nada que hacer" en vez de un error. */
  fila: T | null;
  /** true = esta llamada creó la fila. false = ya existía (reintento). */
  creado: boolean;
}

export interface OpcionesIdempotentes<T> {
  /** De un withTenant() — ver el contrato de uso arriba. */
  client: PoolClient;
  /** Del contexto de autenticación (getTenantId(req)), NUNCA del body: un
   *  cliente que pudiera elegir su tenant_id escribiría en otro tenant. */
  tenantId: string;
  /** Un id del enum `modulo_erp` — el mismo del registry de módulos. */
  modulo: string;
  /** El uuid que generó el dispositivo. `undefined` = el cliente no pidió
   *  idempotencia (llamada online de toda la vida): se ejecuta `insertar`
   *  directo, sin tocar idempotency_keys ni pagar su costo. */
  clienteUuid?: string;
  /** Crea la fila de negocio. Devuelve su id (para guardarlo en la clave)
   *  y la fila entera (para responderle al cliente). */
  insertar: () => Promise<{ id: number; fila: T }>;
  /** Qué registra esta petición (ver huellaDeRegistro). Si el cliente_uuid ya existe con
   *  otra huella, es un código reusado para otra cosa: 409 en vez de devolver el registro
   *  ajeno como si fuera un reintento. Sin huella, o con la clave vieja sin huella, no se
   *  compara. */
  huella?: string;
  /** Recupera una fila ya creada, para responder igual que la primera vez
   *  ante un reintento. Devuelve null si esa fila ya no existe. */
  recuperar: (filaId: number) => Promise<T | null>;
}

export async function idempotentInsert<T>({
  client,
  tenantId,
  modulo,
  clienteUuid,
  huella,
  insertar,
  recuperar,
}: OpcionesIdempotentes<T>): Promise<ResultadoIdempotente<T>> {
  if (!clienteUuid) {
    const { fila } = await insertar();
    return { fila, creado: true };
  }

  // ON CONFLICT DO NOTHING sobre la PK (tenant_id, modulo, cliente_uuid).
  // rowCount 0 = la clave ya existía ⇒ esto es un reintento.
  const reserva = await client.query(
    `INSERT INTO idempotency_keys (tenant_id, modulo, cliente_uuid, huella)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, modulo, cliente_uuid) DO NOTHING`,
    [tenantId, modulo, clienteUuid, huella ?? null]
  );

  if ((reserva.rowCount ?? 0) === 0) {
    const existente = await client.query<{ fila_id: string | null; huella: string | null }>(
      `SELECT fila_id, huella FROM idempotency_keys
       WHERE tenant_id = $1 AND modulo = $2 AND cliente_uuid = $3`,
      [tenantId, modulo, clienteUuid]
    );
    const guardada = existente.rows[0]?.huella;
    if (huella && guardada && guardada !== huella) {
      throw new AppError(
        409,
        "Este código ya se usó para otro registro distinto, así que este no se guardó. " +
          "Si es un registro nuevo, vuelve a registrarlo."
      );
    }
    const filaId = existente.rows[0]?.fila_id;
    // fila_id NULL en una fila ya commiteada no debería poder existir (ver
    // el comentario del archivo), pero si aparece, NO crear nada es la
    // respuesta segura: duplicar es peor que devolver "ya procesado".
    if (filaId === null || filaId === undefined) return { fila: null, creado: false };
    return { fila: await recuperar(Number(filaId)), creado: false };
  }

  const { id, fila } = await insertar();
  await client.query(
    `UPDATE idempotency_keys SET fila_id = $1
     WHERE tenant_id = $2 AND modulo = $3 AND cliente_uuid = $4`,
    [id, tenantId, modulo, clienteUuid]
  );

  return { fila, creado: true };
}
