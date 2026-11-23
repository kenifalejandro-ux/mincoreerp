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
  ciudad: string | null;
  telefono: string | null;
  correo: string | null;
  forma_pago: "contado" | "credito" | null;
  plazo_pago_dias: number | null;
  moneda: "PEN" | "USD" | null;
  actualizado_en: Date;
  actualizado_por: string | null;
}

export interface FilaEventoDeHistorial {
  id: string;
  accion: string;
  creadoEn: Date;
  detalle: Record<string, unknown> | null;
  actor: string | null;
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

export interface FilaCuenta {
  id: string;
  grifo_id: number;
  banco: string;
  tipo_cuenta: "corriente" | "ahorros" | "detraccion";
  moneda: "PEN" | "USD";
  titular: string | null;
  numero_ultimos4: string;
  principal: boolean;
  activo: boolean;
  creado_en: Date;
}

const COLUMNAS_CUENTA = `id, grifo_id, banco, tipo_cuenta, moneda, titular, numero_ultimos4, principal,
                         activo, creado_en`;

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

  // ── Historial y auditoría: lectura de la bitácora (`platform_audit_log`, acciones `proveedores.*`) ──

  async eventosDeHistorial(
    client: PoolClient,
    tenantId: string,
    filtro: {
      patron: string;
      desde?: string;
      hasta?: string;
      antesDe?: string;
      proveedorIds?: number[];
      limite: number;
    }
  ): Promise<FilaEventoDeHistorial[]> {
    const condiciones = ["a.tenant_id = $1", "a.accion ~ $2"];
    const valores: unknown[] = [tenantId, filtro.patron];
    const agregar = (sql: string, valor: unknown) => {
      valores.push(valor);
      condiciones.push(sql.replace("$N", `$${valores.length}`));
    };
    // Las fechas son días de Lima (mismo criterio que el Log de eventos de Administración).
    if (filtro.desde)
      agregar("a.creado_en >= ($N::date)::timestamp AT TIME ZONE 'America/Lima'", filtro.desde);
    if (filtro.hasta)
      agregar(
        "a.creado_en < ($N::date + interval '1 day')::timestamp AT TIME ZONE 'America/Lima'",
        filtro.hasta
      );
    if (filtro.antesDe) agregar("a.id < $N", filtro.antesDe);
    if (filtro.proveedorIds) {
      // El id del proveedor viaja dentro del detalle: solo se compara cuando es un entero.
      agregar(
        "(CASE WHEN (a.detalle->>'proveedorId') ~ '^[0-9]{1,9}$' THEN (a.detalle->>'proveedorId')::int END) = ANY($N::int[])",
        filtro.proveedorIds
      );
    }
    valores.push(filtro.limite);
    const r = await client.query<FilaEventoDeHistorial>(
      `SELECT a.id, a.accion, a.creado_en AS "creadoEn", a.detalle,
              COALESCE(u.nombre, a.actor_label) AS actor
         FROM platform_audit_log a
         LEFT JOIN usuarios u ON u.id = a.usuario_id
        WHERE ${condiciones.join(" AND ")}
        ORDER BY a.id DESC
        LIMIT $${valores.length}`,
      valores
    );
    return r.rows;
  }

  /** Los nombres de proveedores por id (para decir sobre quién recayó cada evento). */
  async nombresDeProveedores(
    client: PoolClient,
    tenantId: string,
    ids: number[]
  ): Promise<Map<number, string>> {
    if (ids.length === 0) return new Map();
    const r = await client.query<{ id: number; nombre: string }>(
      `SELECT id, nombre FROM combustible_grifos WHERE tenant_id = $1 AND id = ANY($2::int[])`,
      [tenantId, ids]
    );
    return new Map(r.rows.map((f) => [f.id, f.nombre]));
  }

  /** Los proveedores cuyo nombre contiene el texto (para filtrar el historial por proveedor). */
  async idsDeProveedoresPorNombre(
    client: PoolClient,
    tenantId: string,
    texto: string
  ): Promise<number[]> {
    const r = await client.query<{ id: number }>(
      `SELECT id FROM combustible_grifos
        WHERE tenant_id = $1 AND NOT es_otros AND position(lower($2) in lower(nombre)) > 0
        LIMIT 200`,
      [tenantId, texto]
    );
    return r.rows.map((f) => f.id);
  }

  // ── Ficha (PR3a): tablas propias del módulo, 0198 ───────────────────────────────────────────────

  async datosDe(
    client: PoolClient,
    tenantId: string,
    grifoId: number
  ): Promise<FilaDatosProveedor | undefined> {
    const r = await client.query<FilaDatosProveedor>(
      `SELECT direccion, ciudad, telefono, correo, forma_pago, plazo_pago_dias, moneda,
              actualizado_en, actualizado_por
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
         (tenant_id, grifo_id, direccion, ciudad, telefono, correo, forma_pago, plazo_pago_dias,
          moneda, actualizado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (tenant_id, grifo_id) DO UPDATE
          SET direccion = EXCLUDED.direccion, ciudad = EXCLUDED.ciudad, telefono = EXCLUDED.telefono,
              correo = EXCLUDED.correo, forma_pago = EXCLUDED.forma_pago,
              plazo_pago_dias = EXCLUDED.plazo_pago_dias, moneda = EXCLUDED.moneda,
              actualizado_en = now(), actualizado_por = EXCLUDED.actualizado_por
       RETURNING direccion, ciudad, telefono, correo, forma_pago, plazo_pago_dias, moneda,
                 actualizado_en, actualizado_por`,
      [
        tenantId,
        grifoId,
        data.direccion,
        data.ciudad,
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

  /** Guarda SOLO la ciudad en la ficha (crea la fila si no existe y deja lo demás como está). Es lo que usa el
   *  alta y la edición del proveedor; los demás datos de la ficha se editan en su pestaña. */
  async guardarCiudad(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    grifoId: number,
    ciudad: string | null
  ): Promise<void> {
    await client.query(
      `INSERT INTO proveedores_ficha (tenant_id, grifo_id, ciudad, actualizado_por)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id, grifo_id) DO UPDATE
          SET ciudad = EXCLUDED.ciudad, actualizado_en = now(), actualizado_por = EXCLUDED.actualizado_por`,
      [tenantId, grifoId, ciudad, usuarioId]
    );
  }

  /** Lo que el Directorio necesita de la ficha de cada proveedor, de una sola vez: ciudad, dirección,
   *  teléfono, condición de pago y si tiene contactos (y alguno con teléfono). Sin ficha, todo vacío. */
  async fichasParaElDirectorio(
    client: PoolClient,
    tenantId: string
  ): Promise<
    {
      grifo_id: number;
      ciudad: string | null;
      direccion: string | null;
      telefono: string | null;
      forma_pago: string | null;
      tiene_contacto: boolean;
      contacto_con_telefono: boolean;
    }[]
  > {
    const r = await client.query(
      `SELECT g.id AS grifo_id, f.ciudad, f.direccion, f.telefono, f.forma_pago,
              EXISTS (SELECT 1 FROM proveedores_contactos c
                       WHERE c.tenant_id = g.tenant_id AND c.grifo_id = g.id AND c.activo)
                AS tiene_contacto,
              EXISTS (SELECT 1 FROM proveedores_contactos c
                       WHERE c.tenant_id = g.tenant_id AND c.grifo_id = g.id AND c.activo
                         AND c.telefono IS NOT NULL) AS contacto_con_telefono
         FROM combustible_grifos g
         LEFT JOIN proveedores_ficha f ON f.tenant_id = g.tenant_id AND f.grifo_id = g.id
        WHERE g.tenant_id = $1 AND NOT g.es_otros`,
      [tenantId]
    );
    return r.rows;
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

  // ── Cuentas bancarias (PR3b): tablas propias, 0199. El número viaja siempre CIFRADO ───────────────

  async cuentasActivas(
    client: PoolClient,
    tenantId: string,
    grifoId: number
  ): Promise<FilaCuenta[]> {
    const r = await client.query<FilaCuenta>(
      `SELECT ${COLUMNAS_CUENTA} FROM proveedores_cuentas_bancarias
        WHERE tenant_id = $1 AND grifo_id = $2 AND activo
        ORDER BY principal DESC, lower(banco), id`,
      [tenantId, grifoId]
    );
    return r.rows;
  }

  async cuentaPorId(
    client: PoolClient,
    tenantId: string,
    grifoId: number,
    id: number
  ): Promise<FilaCuenta | undefined> {
    const r = await client.query<FilaCuenta>(
      `SELECT ${COLUMNAS_CUENTA} FROM proveedores_cuentas_bancarias
        WHERE tenant_id = $1 AND grifo_id = $2 AND id = $3`,
      [tenantId, grifoId, id]
    );
    return r.rows[0];
  }

  async cuentaPorClienteUuid(
    client: PoolClient,
    tenantId: string,
    grifoId: number,
    clienteUuid: string
  ): Promise<FilaCuenta | undefined> {
    const r = await client.query<FilaCuenta>(
      `SELECT ${COLUMNAS_CUENTA} FROM proveedores_cuentas_bancarias
        WHERE tenant_id = $1 AND grifo_id = $2 AND cliente_uuid = $3`,
      [tenantId, grifoId, clienteUuid]
    );
    return r.rows[0];
  }

  /** El número cifrado de una cuenta ACTIVA (solo para «ver completo»). */
  async numeroCifradoDe(
    client: PoolClient,
    tenantId: string,
    grifoId: number,
    id: number
  ): Promise<string | undefined> {
    const r = await client.query<{ numero_cifrado: string }>(
      `SELECT numero_cifrado FROM proveedores_cuentas_bancarias
        WHERE tenant_id = $1 AND grifo_id = $2 AND id = $3 AND activo`,
      [tenantId, grifoId, id]
    );
    return r.rows[0]?.numero_cifrado;
  }

  async quitarPrincipalDeCuentas(
    client: PoolClient,
    tenantId: string,
    grifoId: number,
    usuarioId: string
  ) {
    await client.query(
      `UPDATE proveedores_cuentas_bancarias
          SET principal = false, actualizado_en = now(), actualizado_por = $3
        WHERE tenant_id = $1 AND grifo_id = $2 AND principal AND activo`,
      [tenantId, grifoId, usuarioId]
    );
  }

  /** `undefined` si ya existía una con ese `cliente_uuid` (un reintento). */
  async crearCuenta(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    grifoId: number,
    datos: {
      banco: string;
      tipo_cuenta: string;
      moneda: string;
      titular: string | null;
      principal: boolean;
      cliente_uuid?: string;
      numero_cifrado: string;
      numero_ultimos4: string;
      numero_huella: string;
    }
  ): Promise<FilaCuenta | undefined> {
    try {
      const r = await client.query<FilaCuenta>(
        `INSERT INTO proveedores_cuentas_bancarias
           (tenant_id, grifo_id, cliente_uuid, banco, tipo_cuenta, moneda, titular, numero_cifrado,
            numero_ultimos4, numero_huella, principal, creado_por, actualizado_por)
         VALUES ($1,$2,COALESCE($3::uuid, gen_random_uuid()),$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
         ON CONFLICT (tenant_id, cliente_uuid) DO NOTHING
         RETURNING ${COLUMNAS_CUENTA}`,
        [
          tenantId,
          grifoId,
          datos.cliente_uuid ?? null,
          datos.banco,
          datos.tipo_cuenta,
          datos.moneda,
          datos.titular,
          datos.numero_cifrado,
          datos.numero_ultimos4,
          datos.numero_huella,
          datos.principal,
          usuarioId,
        ]
      );
      return r.rows[0];
    } catch (err) {
      throw traducirCuentaDuplicada(err);
    }
  }

  async actualizarCuenta(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    grifoId: number,
    id: number,
    datos: {
      banco: string;
      tipo_cuenta: string;
      moneda: string;
      titular: string | null;
      principal: boolean;
      /** Ausente = se conserva el número que está. */
      numero?: { numero_cifrado: string; numero_ultimos4: string; numero_huella: string };
    }
  ): Promise<FilaCuenta | undefined> {
    try {
      const r = await client.query<FilaCuenta>(
        `UPDATE proveedores_cuentas_bancarias
            SET banco = $1, tipo_cuenta = $2, moneda = $3, titular = $4, principal = $5,
                numero_cifrado = COALESCE($6, numero_cifrado),
                numero_ultimos4 = COALESCE($7, numero_ultimos4),
                numero_huella = COALESCE($8, numero_huella),
                actualizado_en = now(), actualizado_por = $9
          WHERE tenant_id = $10 AND grifo_id = $11 AND id = $12 AND activo
          RETURNING ${COLUMNAS_CUENTA}`,
        [
          datos.banco,
          datos.tipo_cuenta,
          datos.moneda,
          datos.titular,
          datos.principal,
          datos.numero?.numero_cifrado ?? null,
          datos.numero?.numero_ultimos4 ?? null,
          datos.numero?.numero_huella ?? null,
          usuarioId,
          tenantId,
          grifoId,
          id,
        ]
      );
      return r.rows[0];
    } catch (err) {
      throw traducirCuentaDuplicada(err);
    }
  }

  async desactivarCuenta(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    grifoId: number,
    id: number,
    motivo: string
  ): Promise<FilaCuenta | undefined> {
    const r = await client.query<FilaCuenta>(
      `UPDATE proveedores_cuentas_bancarias
          SET activo = false, principal = false, quitado_en = now(), quitado_por = $1,
              motivo_baja = $2, actualizado_en = now(), actualizado_por = $1
        WHERE tenant_id = $3 AND grifo_id = $4 AND id = $5 AND activo
        RETURNING ${COLUMNAS_CUENTA}`,
      [usuarioId, motivo, tenantId, grifoId, id]
    );
    return r.rows[0];
  }

  /** Tras quitar a la principal, la cuenta activa más antigua pasa a serlo (si queda alguna). */
  async ascenderPrimeraCuenta(client: PoolClient, tenantId: string, grifoId: number) {
    await client.query(
      `UPDATE proveedores_cuentas_bancarias SET principal = true
        WHERE id = (SELECT id FROM proveedores_cuentas_bancarias
                     WHERE tenant_id = $1 AND grifo_id = $2 AND activo
                     ORDER BY creado_en, id LIMIT 1)
          AND NOT EXISTS (SELECT 1 FROM proveedores_cuentas_bancarias
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
              p.vigente_hasta::text AS vigente_hasta,
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
              p.vigente_hasta::text AS vigente_hasta,
              u.nombre AS registrado_por, p.anulada_en, p.motivo_anulacion
         FROM combustible_urea_precios p
         LEFT JOIN usuarios u ON u.id = p.usuario_id
        WHERE p.tenant_id = $1
        ORDER BY p.vigente_desde DESC, p.id DESC`,
      [tenantId]
    );
    return r.rows;
  }

  /** La condición de pago de cada proveedor, de su ficha (0198). Sin ficha, no aparece. */
  async condicionesDePago(
    client: PoolClient,
    tenantId: string
  ): Promise<
    { grifo_id: number; forma_pago: "contado" | "credito"; plazo_pago_dias: number | null }[]
  > {
    const r = await client.query<{
      grifo_id: number;
      forma_pago: "contado" | "credito";
      plazo_pago_dias: number | null;
    }>(
      `SELECT grifo_id, forma_pago, plazo_pago_dias FROM proveedores_ficha
        WHERE tenant_id = $1 AND forma_pago IS NOT NULL`,
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

/** La misma cuenta dos veces en un proveedor: error de negocio (409), no 500. */
export class CuentaDuplicadaError extends Error {}

function traducirCuentaDuplicada(err: unknown): unknown {
  if (!esViolacionUnicidad(err)) return err;
  const restriccion = (err as { constraint?: string }).constraint ?? "";
  if (restriccion.includes("huella")) {
    return new CuentaDuplicadaError("Esa cuenta ya está registrada en este proveedor");
  }
  return err;
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
