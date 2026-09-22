/** src/modules/combustible/alcance.ts
 *
 * El ALCANCE de un usuario en Combustible (migración 0100, entregas 3 y 4 de
 * docs/architecture/combustible-sedes-grifos-surtidores.md): qué sedes,
 * grifos y surtidores ve.
 *
 * Se resuelve UNA vez por pedido, al entrar al módulo (cargarAlcance), y NO se
 * guarda en el JWT: un cambio de alcance rige en el siguiente clic, no en el
 * próximo login. Una sede se expande acá a sus grifos, así que un grifo creado
 * después entra solo.
 *
 * Dos niveles de acceso a un tanque, y es la regla que más cuidado pide:
 *   - VISIBLE: tiene su grifo, o un surtidor que lo alimenta. Alcanza para
 *     verlo en la lista y cargar un vale por ese surtidor.
 *   - COMPLETO: tiene el grifo. Hace falta para la varilla (lee todos los
 *     surtidores del tanque), la recepción, las lecturas y los precintos.
 *
 * Fuera del alcance es un 404, igual que algo que no existe: no se revela que
 * existe. El administrador de la empresa ve todo siempre.
 */
import type { NextFunction, Request, RequestParamHandler, Response } from "express";
import type { PoolClient } from "pg";

import { withTenant } from "../../server/config/database";
import { getTenantId } from "../../server/shared/utils/request";

export type AlcanceCombustible =
  | { todo: true }
  | {
      todo: false;
      /** Grifos con acceso completo (los asignados y los de las sedes). */
      grifos: number[];
      /** Surtidores sueltos: solo sus vales. */
      surtidores: number[];
    };

export const ALCANCE_TODO: AlcanceCombustible = { todo: true };

export async function resolverAlcance(
  client: PoolClient,
  tenantId: string,
  usuario: { id: string; rol: string }
): Promise<AlcanceCombustible> {
  if (usuario.rol === "admin") return ALCANCE_TODO;
  const perfil = await client.query<{ alcance_combustible: string }>(
    `SELECT alcance_combustible FROM usuarios WHERE id = $1 AND tenant_id = $2`,
    [usuario.id, tenantId]
  );
  if (perfil.rows[0]?.alcance_combustible !== "asignado") return ALCANCE_TODO;
  const r = await client.query<{ grifos: number[] | null; surtidores: number[] | null }>(
    `SELECT
       (SELECT array_agg(DISTINCT g.id) FROM grifos_internos g
         WHERE g.tenant_id = $2 AND (
           g.id IN (SELECT a.grifo_interno_id FROM usuario_accesos_combustible a
                     WHERE a.usuario_id = $1 AND a.grifo_interno_id IS NOT NULL)
           OR g.sede_id IN (SELECT a.sede_id FROM usuario_accesos_combustible a
                             WHERE a.usuario_id = $1 AND a.sede_id IS NOT NULL))) AS grifos,
       (SELECT array_agg(a.surtidor_id) FROM usuario_accesos_combustible a
         WHERE a.usuario_id = $1 AND a.surtidor_id IS NOT NULL) AS surtidores`,
    [usuario.id, tenantId]
  );
  return { todo: false, grifos: r.rows[0].grifos ?? [], surtidores: r.rows[0].surtidores ?? [] };
}

/** Middleware del módulo: deja el alcance en `req.alcanceCombustible`. */
export function cargarAlcance(req: Request, _res: Response, next: NextFunction) {
  const tenantId = getTenantId(req);
  withTenant(tenantId, (client) => resolverAlcance(client, tenantId, req.usuario!))
    .then((alcance) => {
      req.alcanceCombustible = alcance;
      next();
    })
    .catch(next);
}

export const alcanceDe = (req: Request): AlcanceCombustible =>
  req.alcanceCombustible ?? ALCANCE_TODO;

// ── Filtros SQL ──────────────────────────────────────────────────────────
// Devuelven un fragmento para el WHERE y sus valores, numerados desde
// `desde`. Con alcance `todo` devuelven "TRUE": la consulta queda igual.

type Filtro = { sql: string; valores: unknown[] };

/** Un tanque VISIBLE: su grifo, o un surtidor que lo alimenta hoy. */
export function filtroTanqueVisible(a: AlcanceCombustible, col: string, desde: number): Filtro {
  if (a.todo) return { sql: "TRUE", valores: [] };
  return {
    sql: `(${col}.grifo_interno_id = ANY($${desde}::int[]) OR EXISTS (
            SELECT 1 FROM surtidor_tanques st_a
             WHERE st_a.combustible_id = ${col}.id AND st_a.desconectado_en IS NULL
               AND st_a.surtidor_id = ANY($${desde + 1}::int[])))`,
    valores: [a.grifos, a.surtidores],
  };
}

/** Un HECHO que es del grifo entero (varilla, recepción): su copia del grifo. */
export function filtroHechoDeGrifo(a: AlcanceCombustible, col: string, desde: number): Filtro {
  if (a.todo) return { sql: "TRUE", valores: [] };
  return { sql: `${col}.grifo_interno_id = ANY($${desde}::int[])`, valores: [a.grifos] };
}

/** Un VALE: del tanque propio, por su grifo o su surtidor; de compra externa,
 *  por el grifo del equipo o porque lo cargó el propio usuario. La urea no se
 *  filtra: su inventario es de la empresa. */
export function filtroVale(
  a: AlcanceCombustible,
  col: string,
  desde: number,
  usuarioId: string
): Filtro {
  if (a.todo) return { sql: "TRUE", valores: [] };
  return {
    sql: `(${col}.producto = 'urea'
           OR ${col}.grifo_interno_id = ANY($${desde}::int[])
           OR ${col}.surtidor_id = ANY($${desde + 1}::int[])
           OR (${col}.origen = 'compra_externa' AND ${col}.usuario_id = $${desde + 2}::uuid))`,
    valores: [a.grifos, a.surtidores, usuarioId],
  };
}

// ── Chequeos puntuales ───────────────────────────────────────────────────

export async function tanqueEnAlcance(
  client: PoolClient,
  tenantId: string,
  a: AlcanceCombustible,
  combustibleId: number,
  nivel: "visible" | "completo"
): Promise<boolean> {
  if (a.todo) return true;
  const f =
    nivel === "completo"
      ? { sql: `c.grifo_interno_id = ANY($3::int[])`, valores: [a.grifos] }
      : filtroTanqueVisible(a, "c", 3);
  const r = await client.query(
    `SELECT 1 FROM combustible c WHERE c.id = $1 AND c.tenant_id = $2 AND ${f.sql}`,
    [combustibleId, tenantId, ...f.valores]
  );
  return (r.rowCount ?? 0) > 0;
}

/** Un vale del tanque propio por ese surtidor (o por el tanque, si la base
 *  le va a crear el surtidor): el surtidor asignado, o el grifo del tanque. */
export async function valeEnAlcance(
  client: PoolClient,
  tenantId: string,
  a: AlcanceCombustible,
  combustibleId: number,
  surtidorId: number | null
): Promise<boolean> {
  if (a.todo) return true;
  if (surtidorId !== null && a.surtidores.includes(surtidorId)) return true;
  return tanqueEnAlcance(client, tenantId, a, combustibleId, "completo");
}

/** Los grifos de un filtro de reporte (sede o grifo). null = sin filtro. Va
 *  APARTE del alcance (filtroVale): un usuario de un solo surtidor ve vales
 *  por su surtidor, no por un grifo. */
export async function grifosDelFiltro(
  client: PoolClient,
  tenantId: string,
  filtro: { sede_id?: number; grifo_interno_id?: number }
): Promise<number[] | null> {
  if (filtro.grifo_interno_id !== undefined) return [filtro.grifo_interno_id];
  if (filtro.sede_id === undefined) return null;
  const r = await client.query<{ id: number }>(
    `SELECT id FROM grifos_internos WHERE tenant_id = $1 AND sede_id = $2`,
    [tenantId, filtro.sede_id]
  );
  return r.rows.map((x) => x.id);
}

// ── Ámbito de un listado de vales ────────────────────────────────────────

/** El alcance del usuario más el filtro de sede/grifo que pidió (entrega 4). */
export interface AmbitoVales {
  alcance: AlcanceCombustible;
  usuarioId: string;
  /** Grifos del filtro de sede o grifo del reporte; null = sin filtro. */
  grifos?: number[] | null;
}

export const ambitoDe = (req: Request, grifos: number[] | null = null): AmbitoVales => ({
  alcance: alcanceDe(req),
  usuarioId: req.usuario!.id,
  grifos,
});

/** Suma al WHERE de una consulta de vales el alcance y el filtro de grifo. */
export function agregarAmbitoVales(
  condiciones: string[],
  valores: unknown[],
  col: string,
  ambito?: AmbitoVales
) {
  if (!ambito) return;
  const f = filtroVale(ambito.alcance, col, valores.length + 1, ambito.usuarioId);
  if (f.sql !== "TRUE") {
    condiciones.push(f.sql);
    valores.push(...f.valores);
  }
  if (ambito.grifos) {
    valores.push(ambito.grifos);
    condiciones.push(`${col}.grifo_interno_id = ANY($${valores.length}::int[])`);
  }
}

// ── Guardias por parámetro de ruta ───────────────────────────────────────
// Un solo punto por tipo de id (router.param en combustible.routes.ts): cubre
// TODAS las rutas con ese parámetro, incluidas las que se agreguen después.
// Fuera del alcance es un 404, igual que un id que no existe.

type Comprobar = (
  client: PoolClient,
  tenantId: string,
  a: Exclude<AlcanceCombustible, { todo: true }>,
  id: number,
  usuarioId: string
) => Promise<boolean>;

function guardia(comprobar: Comprobar): RequestParamHandler {
  return (req, res, next, valor) => {
    const a = alcanceDe(req);
    const id = Number(valor);
    if (a.todo || !Number.isInteger(id)) return next();
    const tenantId = getTenantId(req);
    withTenant(tenantId, (client) => comprobar(client, tenantId, a, id, req.usuario!.id))
      .then((ok) => (ok ? next() : res.status(404).json({ error: "No encontrado" })))
      .catch(next);
  };
}

const existe = async (client: PoolClient, sql: string, valores: unknown[]) =>
  ((await client.query(sql, valores)).rowCount ?? 0) > 0;

export const GUARDIAS: Record<string, RequestParamHandler> = {
  // El tanque, VISIBLE (lista, ficha, historial de ubicación). Lo que pide el
  // grifo entero lo agrega requiereTanqueCompleto en la ruta.
  id: guardia((client, tenantId, a, id) => tanqueEnAlcance(client, tenantId, a, id, "visible")),
  despachoId: guardia((client, tenantId, a, id, usuarioId) => {
    const f = filtroVale(a, "d", 3, usuarioId);
    return existe(
      client,
      `SELECT 1 FROM combustible_despachos d WHERE d.id = $1 AND d.tenant_id = $2 AND ${f.sql}`,
      [id, tenantId, ...f.valores]
    );
  }),
  lecturaId: guardia((client, tenantId, a, id) =>
    existe(
      client,
      `SELECT 1 FROM combustible_lecturas l
        WHERE l.id = $1 AND l.tenant_id = $2 AND l.grifo_interno_id = ANY($3::int[])`,
      [id, tenantId, a.grifos]
    )
  ),
  recepcionId: guardia((client, tenantId, a, id) =>
    existe(
      client,
      `SELECT 1 FROM combustible_recepciones r
        WHERE r.id = $1 AND r.tenant_id = $2
          AND (r.producto = 'urea' OR r.grifo_interno_id = ANY($3::int[]))`,
      [id, tenantId, a.grifos]
    )
  ),
  puntoId: guardia((client, tenantId, a, id) =>
    existe(
      client,
      `SELECT 1 FROM combustible_precinto_puntos p
         JOIN combustible c ON c.id = p.combustible_id AND c.tenant_id = p.tenant_id
        WHERE p.id = $1 AND p.tenant_id = $2 AND c.grifo_interno_id = ANY($3::int[])`,
      [id, tenantId, a.grifos]
    )
  ),
  surtidorId: guardia((client, tenantId, a, id) =>
    existe(
      client,
      `SELECT 1 FROM surtidores s
        WHERE s.id = $1 AND s.tenant_id = $2
          AND (s.grifo_interno_id = ANY($3::int[]) OR s.id = ANY($4::int[]))`,
      [id, tenantId, a.grifos, a.surtidores]
    )
  ),
};

/** Lo que es del grifo entero (varilla, precintos): el tanque COMPLETO. */
export function requiereTanqueCompleto(req: Request, res: Response, next: NextFunction) {
  const a = alcanceDe(req);
  if (a.todo) return next();
  const tenantId = getTenantId(req);
  withTenant(tenantId, (client) =>
    tanqueEnAlcance(client, tenantId, a, Number(req.params.id), "completo")
  )
    .then((ok) => (ok ? next() : res.status(404).json({ error: "No encontrado" })))
    .catch(next);
}

/** Un evento de Combustible, sin contenido: el tipo alcanza para que la
 *  pantalla recargue, y los ids o niveles podrían ser de otra planta. */
export function vaciarEventoDeCombustible<T extends { tipo: string; payload: unknown }>(e: T): T {
  return e.tipo.startsWith("combustible.") ? { ...e, payload: {} } : e;
}
