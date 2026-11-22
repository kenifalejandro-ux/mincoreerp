/** src/modules/proveedores/proveedores.repository.ts
 *
 * Lectura de los proveedores para el ecosistema «Gestión de proveedores» (PR1, solo lectura).
 * Hoy los proveedores son las filas de `combustible_grifos` (la tabla de Combustible): este módulo
 * las LEE, no las modifica ni las posee todavía. Por eso el registro declara `opcionales:
 * ["combustible"]` (ver src/modules/registry.ts y tests/modulos-autonomos.test.ts).
 *
 * PR2: también crea y edita esas mismas filas (la tabla sigue siendo de Combustible hasta el PR6).
 *
 * El proveedor "Otros" (`es_otros`, 0163) es un comodín interno de Combustible para los grifos que
 * no están en el catálogo: no es un proveedor real y no se lista acá.
 */
import type { PoolClient } from "pg";

import { esViolacionUnicidad } from "../../server/shared/utils/pgError";
import type {
  ActualizarProveedorInput,
  ContactoProveedorInput,
  CrearProveedorInput,
  GuardarDatosProveedorInput,
} from "../../server/schemas/proveedores.schema";

export interface FilaProveedor {
  id: number;
  nombre: string;
  ruc: string | null;
  activo: boolean;
  abastece_tanque: boolean;
  abastece_ruta: boolean;
  abastece_urea: boolean;
  abastece_urea_ruta: boolean;
  creado_en: Date;
}

export interface FilaDatosProveedor {
  direccion: string | null;
  telefono: string | null;
  correo: string | null;
  forma_pago: "contado" | "credito" | null;
  plazo_pago_dias: number | null;
  moneda: "PEN" | "USD" | null;
  actualizado_en: Date;
  actualizado_por: string | null;
}

export interface FilaContacto {
  id: string;
  grifo_id: number;
  nombre: string;
  cargo: string | null;
  telefono: string | null;
  correo: string | null;
  principal: boolean;
  activo: boolean;
  creado_en: Date;
}

const COLUMNAS_CONTACTO = `id, grifo_id, nombre, cargo, telefono, correo, principal, activo, creado_en`;

const COLUMNAS = `id, nombre, ruc, activo, abastece_tanque, abastece_ruta, abastece_urea,
                  abastece_urea_ruta, creado_en`;

import type { RecepcionDb } from "./proveedores.compras";
import type {
  FilaPrecioCombustibleDb,
  FilaPrecioUreaDb,
  PresentacionDb,
} from "./proveedores.precios";

export class ProveedoresRepository {
  async listar(client: PoolClient, tenantId: string): Promise<FilaProveedor[]> {
    const result = await client.query<FilaProveedor>(
      `SELECT ${COLUMNAS} FROM combustible_grifos
        WHERE tenant_id = $1 AND NOT es_otros
        ORDER BY nombre ASC`,
      [tenantId]
    );
    return result.rows;
  }

  async buscarPorId(
    client: PoolClient,
    tenantId: string,
    id: number
  ): Promise<FilaProveedor | undefined> {
    const result = await client.query<FilaProveedor>(
      `SELECT ${COLUMNAS} FROM combustible_grifos
        WHERE tenant_id = $1 AND id = $2 AND NOT es_otros`,
      [tenantId, id]
    );
    return result.rows[0];
  }

  // ── Ficha (PR3a): tablas propias del módulo, 0198 ───────────────────────────────────────────────

  async datosDe(
    client: PoolClient,
    tenantId: string,
    grifoId: number
  ): Promise<FilaDatosProveedor | undefined> {
    const r = await client.query<FilaDatosProveedor>(
      `SELECT direccion, telefono, correo, forma_pago, plazo_pago_dias, moneda, actualizado_en,
              actualizado_por
         FROM proveedores_ficha WHERE tenant_id = $1 AND grifo_id = $2`,
      [tenantId, grifoId]
    );
    return r.rows[0];
  }

  /** Guarda la ficha completa (una fila por proveedor): lo que no viene queda vacío. */
  async guardarDatos(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    grifoId: number,
    data: GuardarDatosProveedorInput
  ): Promise<FilaDatosProveedor> {
    const r = await client.query<FilaDatosProveedor>(
      `INSERT INTO proveedores_ficha
         (tenant_id, grifo_id, direccion, telefono, correo, forma_pago, plazo_pago_dias, moneda,
          actualizado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (tenant_id, grifo_id) DO UPDATE
          SET direccion = EXCLUDED.direccion, telefono = EXCLUDED.telefono,
              correo = EXCLUDED.correo, forma_pago = EXCLUDED.forma_pago,
              plazo_pago_dias = EXCLUDED.plazo_pago_dias, moneda = EXCLUDED.moneda,
              actualizado_en = now(), actualizado_por = EXCLUDED.actualizado_por
       RETURNING direccion, telefono, correo, forma_pago, plazo_pago_dias, moneda, actualizado_en,
                 actualizado_por`,
      [
        tenantId,
        grifoId,
        data.direccion,
        data.telefono,
        data.correo,
        data.forma_pago,
        data.plazo_pago_dias,
        data.moneda,
        usuarioId,
      ]
    );
    return r.rows[0];
  }

  /** Los contactos activos: el principal primero, luego por nombre. */
  async contactosActivos(
    client: PoolClient,
    tenantId: string,
    grifoId: number
  ): Promise<FilaContacto[]> {
    const r = await client.query<FilaContacto>(
      `SELECT ${COLUMNAS_CONTACTO} FROM proveedores_contactos
        WHERE tenant_id = $1 AND grifo_id = $2 AND activo
        ORDER BY principal DESC, lower(nombre), id`,
      [tenantId, grifoId]
    );
    return r.rows;
  }

  async contactoPorId(
    client: PoolClient,
    tenantId: string,
    grifoId: number,
    id: number
  ): Promise<FilaContacto | undefined> {
    const r = await client.query<FilaContacto>(
      `SELECT ${COLUMNAS_CONTACTO} FROM proveedores_contactos
        WHERE tenant_id = $1 AND grifo_id = $2 AND id = $3`,
      [tenantId, grifoId, id]
    );
    return r.rows[0];
  }

  /** El principal activo deja de serlo (se va a nombrar a otro). */
  async quitarPrincipal(client: PoolClient, tenantId: string, grifoId: number, usuarioId: string) {
    await client.query(
      `UPDATE proveedores_contactos
          SET principal = false, actualizado_en = now(), actualizado_por = $3
        WHERE tenant_id = $1 AND grifo_id = $2 AND principal AND activo`,
      [tenantId, grifoId, usuarioId]
    );
  }

  /** `undefined` si ya existía uno con ese `cliente_uuid` (un reintento). */
  async crearContacto(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    grifoId: number,
    data: ContactoProveedorInput
  ): Promise<FilaContacto | undefined> {
    const r = await client.query<FilaContacto>(
      `INSERT INTO proveedores_contactos
         (tenant_id, grifo_id, cliente_uuid, nombre, cargo, telefono, correo, principal,
          creado_por, actualizado_por)
       VALUES ($1,$2,COALESCE($3::uuid, gen_random_uuid()),$4,$5,$6,$7,$8,$9,$9)
       ON CONFLICT (tenant_id, cliente_uuid) DO NOTHING
       RETURNING ${COLUMNAS_CONTACTO}`,
      [
        tenantId,
        grifoId,
        data.cliente_uuid ?? null,
        data.nombre,
        data.cargo,
        data.telefono,
        data.correo,
        data.principal,
        usuarioId,
      ]
    );
    return r.rows[0];
  }

  async contactoPorClienteUuid(
    client: PoolClient,
    tenantId: string,
    grifoId: number,
    clienteUuid: string
  ): Promise<FilaContacto | undefined> {
    const r = await client.query<FilaContacto>(
      `SELECT ${COLUMNAS_CONTACTO} FROM proveedores_contactos
        WHERE tenant_id = $1 AND grifo_id = $2 AND cliente_uuid = $3`,
      [tenantId, grifoId, clienteUuid]
    );
    return r.rows[0];
  }

  async actualizarContacto(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    grifoId: number,
    id: number,
    data: ContactoProveedorInput
  ): Promise<FilaContacto | undefined> {
    const r = await client.query<FilaContacto>(
      `UPDATE proveedores_contactos
          SET nombre = $1, cargo = $2, telefono = $3, correo = $4, principal = $5,
              actualizado_en = now(), actualizado_por = $6
        WHERE tenant_id = $7 AND grifo_id = $8 AND id = $9 AND activo
        RETURNING ${COLUMNAS_CONTACTO}`,
      [
        data.nombre,
        data.cargo,
        data.telefono,
        data.correo,
        data.principal,
        usuarioId,
        tenantId,
        grifoId,
        id,
      ]
    );
    return r.rows[0];
  }

  async desactivarContacto(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    grifoId: number,
    id: number
  ): Promise<FilaContacto | undefined> {
    const r = await client.query<FilaContacto>(
      `UPDATE proveedores_contactos
          SET activo = false, principal = false, quitado_en = now(), quitado_por = $1,
              actualizado_en = now(), actualizado_por = $1
        WHERE tenant_id = $2 AND grifo_id = $3 AND id = $4 AND activo
        RETURNING ${COLUMNAS_CONTACTO}`,
      [usuarioId, tenantId, grifoId, id]
    );
    return r.rows[0];
  }

  /** Tras quitar al principal, el contacto más antiguo pasa a serlo (si queda alguno). */
  async ascenderPrimerContacto(
    client: PoolClient,
    tenantId: string,
    grifoId: number
  ): Promise<void> {
    await client.query(
      `UPDATE proveedores_contactos SET principal = true
        WHERE id = (SELECT id FROM proveedores_contactos
                     WHERE tenant_id = $1 AND grifo_id = $2 AND activo
                     ORDER BY creado_en, id LIMIT 1)
          AND NOT EXISTS (SELECT 1 FROM proveedores_contactos
                           WHERE tenant_id = $1 AND grifo_id = $2 AND activo AND principal)`,
      [tenantId, grifoId]
    );
  }

  // ── Precios (solo lectura, PR4): las tablas son de Combustible (0063 y 0121) ─────────────────────

  /** Los precios de combustible de PROVEEDORES (los de ruta); los de tanque son la venta interna. */
  async listarPreciosCombustibleDeProveedores(
    client: PoolClient,
    tenantId: string
  ): Promise<FilaPrecioCombustibleDb[]> {
    const r = await client.query<FilaPrecioCombustibleDb>(
      `SELECT p.id, p.tipo_combustible, p.grifo_id, p.precio_unitario, p.vigente_desde,
              u.nombre AS registrado_por, p.anulada_en, p.motivo_anulacion
         FROM combustible_precios p
         LEFT JOIN usuarios u ON u.id = p.usuario_id
        WHERE p.tenant_id = $1 AND p.grifo_id IS NOT NULL
        ORDER BY p.vigente_desde DESC, p.id DESC`,
      [tenantId]
    );
    return r.rows;
  }

  async listarPreciosUrea(client: PoolClient, tenantId: string): Promise<FilaPrecioUreaDb[]> {
    const r = await client.query<FilaPrecioUreaDb>(
      `SELECT p.id, p.grifo_id, p.presentacion, p.marca, p.precio_por_bulto, p.vigente_desde,
              u.nombre AS registrado_por, p.anulada_en, p.motivo_anulacion
         FROM combustible_urea_precios p
         LEFT JOIN usuarios u ON u.id = p.usuario_id
        WHERE p.tenant_id = $1
        ORDER BY p.vigente_desde DESC, p.id DESC`,
      [tenantId]
    );
    return r.rows;
  }

  /** Los tipos de combustible que la empresa maneja en sus tanques activos. */
  async tiposDeCombustibleEnTanques(client: PoolClient, tenantId: string): Promise<string[]> {
    const r = await client.query<{ tipo_combustible: string }>(
      `SELECT DISTINCT tipo_combustible FROM combustible
        WHERE tenant_id = $1 AND activo AND tipo_combustible IS NOT NULL`,
      [tenantId]
    );
    return r.rows.map((x) => x.tipo_combustible);
  }

  async presentacionesDeUreaActivas(
    client: PoolClient,
    tenantId: string
  ): Promise<PresentacionDb[]> {
    const r = await client.query<PresentacionDb>(
      `SELECT codigo, nombre, litros FROM combustible_urea_presentaciones
        WHERE tenant_id = $1 AND activa ORDER BY es_referencia DESC, litros DESC, id`,
      [tenantId]
    );
    return r.rows;
  }

  // ── Compras y recepciones (solo lectura, PR5): las tablas son de Combustible (0171 y 0173) ───────

  /** Las recepciones vigentes de esas compras, con la unidad del tanque que recibió. */
  async recepcionesDeCompras(
    client: PoolClient,
    tenantId: string,
    recepcionIds: number[]
  ): Promise<RecepcionDb[]> {
    if (recepcionIds.length === 0) return [];
    const r = await client.query<RecepcionDb>(
      `SELECT r.id, r.cantidad, r.cantidad_derivada, r.recibido_en, c.unidad
         FROM combustible_recepciones r
         JOIN combustible c ON c.id = r.combustible_id AND c.tenant_id = r.tenant_id
        WHERE r.tenant_id = $1 AND r.id = ANY($2::bigint[])`,
      [tenantId, recepcionIds]
    );
    return r.rows;
  }

  /** Crea un proveedor. Los índices únicos de nombre (0063) y de RUC (0160) los hace cumplir la base:
   *  se distinguen por el nombre del constraint. */
  async crear(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    data: CrearProveedorInput
  ): Promise<FilaProveedor> {
    try {
      const result = await client.query<FilaProveedor>(
        `INSERT INTO combustible_grifos
           (tenant_id, nombre, ruc, abastece_tanque, abastece_ruta, abastece_urea,
            abastece_urea_ruta, usuario_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING ${COLUMNAS}`,
        [
          tenantId,
          data.nombre,
          data.ruc,
          data.abastece_tanque,
          data.abastece_ruta,
          data.abastece_urea,
          data.abastece_urea_ruta,
          usuarioId,
        ]
      );
      return result.rows[0];
    } catch (err) {
      throw traducirUnicidad(err, data);
    }
  }

  /** Edita un proveedor (nunca el comodín «Otros»). `undefined` si no existe. */
  async actualizar(
    client: PoolClient,
    tenantId: string,
    id: number,
    data: ActualizarProveedorInput
  ): Promise<FilaProveedor | undefined> {
    try {
      const result = await client.query<FilaProveedor>(
        `UPDATE combustible_grifos
            SET nombre = $1, ruc = $2, activo = $3, abastece_tanque = $4, abastece_ruta = $5,
                abastece_urea = $6, abastece_urea_ruta = $7
          WHERE tenant_id = $8 AND id = $9 AND NOT es_otros
          RETURNING ${COLUMNAS}`,
        [
          data.nombre,
          data.ruc,
          data.activo,
          data.abastece_tanque,
          data.abastece_ruta,
          data.abastece_urea,
          data.abastece_urea_ruta,
          tenantId,
          id,
        ]
      );
      return result.rows[0];
    } catch (err) {
      throw traducirUnicidad(err, data);
    }
  }
}

/** Un nombre o un RUC repetido en la empresa: error de negocio (409), no 500. */
export class ProveedorDuplicadoError extends Error {}

function traducirUnicidad(err: unknown, data: { nombre: string; ruc: string | null }): unknown {
  if (!esViolacionUnicidad(err)) return err;
  const esRuc = ((err as { constraint?: string }).constraint ?? "").includes("ruc");
  return new ProveedorDuplicadoError(
    esRuc
      ? `Ya existe un proveedor con el RUC ${data.ruc}`
      : `Ya existe un proveedor llamado "${data.nombre}"`,
    { cause: err }
  );
}
