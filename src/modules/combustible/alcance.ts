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
import {
  findDestinatariosAlertas,
  type DestinatarioDeAlerta,
} from "../../server/shared/utils/destinatariosAlertas";
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
 *  por el grifo del equipo o porque lo cargó el propio usuario (igual la carga
 *  en ruta desde tanqueta, 0114: la registra el conductor). La urea no se
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
           OR (${col}.origen IN ('compra_externa', 'tanqueta') AND ${col}.usuario_id = $${desde + 2}::uuid))`,
    valores: [a.grifos, a.surtidores, usuarioId],
  };
}

/** Una ALERTA (o una anomalía, que es una alerta congelada y hereda su grifo):
 *  la de su grifo, la de un vale cargado por un surtidor asignado, y las que no
 *  tienen grifo. El trigger
 *  `copiar_grifo_alerta` (0097) le estampa a cada alerta el grifo del hecho
 *  que la disparó y deja en NULL la urea y los hechos de talonario, que son
 *  de la empresa entera. Un NULL se ve SIEMPRE: filtrarlo esconderia justo
 *  las alertas que no son de nadie en particular. */
export function filtroAlertaVisible(a: AlcanceCombustible, col: string, desde: number): Filtro {
  if (a.todo) return { sql: "TRUE", valores: [] };
  // El surtidor suelto: ve el vale por su surtidor (filtroVale), así que
  // también ve la alerta de ese vale, aunque no tenga el grifo entero.
  return {
    sql: `(${col}.grifo_interno_id IS NULL
           OR ${col}.grifo_interno_id = ANY($${desde}::int[])
           OR EXISTS (SELECT 1 FROM combustible_despachos dv
                       WHERE dv.id = ${col}.despacho_id AND dv.tenant_id = ${col}.tenant_id
                         AND dv.surtidor_id = ANY($${desde + 1}::int[])))`,
    valores: [a.grifos, a.surtidores],
  };
}

/** El grifo de un lote de alertas RECIÉN CREADAS, para enrutar su aviso.
 *
 *  Se lee de las filas que devuelve crearAlertas(), ya con el grifo que les
 *  puso el trigger `copiar_grifo_alerta` -- la MISMA columna que ve la
 *  campanita. Derivarlo de la alerta y no del caso de uso es lo que impide
 *  que el correo y el panel discrepen: si el trigger cambia, cambian los dos.
 *
 *  `null` --o sea "toda la empresa"-- en los dos casos en que no hay un grifo
 *  del que hablar:
 *  - ninguna alerta del lote tiene grifo (urea, hechos de talonario);
 *  - el lote abarca MÁS DE UN grifo. No debería pasar (un lote sale de un
 *    solo hecho), pero si pasa se avisa a todos: dejar a alguien sin su aviso
 *    es peor que mandarle uno de más, y acá el error no se vería nunca. */
export function grifoDeAlertas(alertas: { grifo_interno_id: number | null }[]): number | null {
  // Un lote MEZCLADO (alguna alerta sin grifo) también es de toda la empresa:
  // comparte una sola lista de destinatarios, y enrutarlo al único grifo
  // presente dejaría sin aviso a los demás por la alerta que sí era de todos.
  if (alertas.some((a) => a.grifo_interno_id === null)) return null;
  const grifos = new Set(alertas.map((a) => a.grifo_interno_id));
  return grifos.size === 1 ? [...grifos][0] : null;
}

// ── Chequeos puntuales ───────────────────────────────────────────────────

/** resolverAlcance() AL REVÉS: en vez de "qué grifos ve este usuario",
 *  "cuáles de estos usuarios ven este grifo".
 *
 *  Es la MISMA regla --el grifo asignado, o la sede que lo contiene-- y vive
 *  acá, al lado de resolverAlcance(), justamente para que no se puedan
 *  separar: el día que cambie cómo se asigna el alcance, el enrutamiento de
 *  los avisos cambia con ella y no queda una segunda definición en otro
 *  archivo diciendo otra cosa.
 *
 *  Quien tiene asignado SOLO un surtidor queda afuera: su alcance es más
 *  chico que el grifo y el aviso le hablaría de tanques que no ve. Hoy no
 *  cambia nada en la práctica -- el personal de surtidor entra con DNI y sin
 *  correo, y findDestinatariosAlertas ya excluye a quien no tiene correo.
 *
 *  `usuarioIds` vacío devuelve un Set vacío sin tocar la base. */
export async function usuariosQueVenElGrifo(
  client: PoolClient,
  tenantId: string,
  usuarioIds: string[],
  grifoInternoId: number
): Promise<Set<string>> {
  if (usuarioIds.length === 0) return new Set();
  const r = await client.query<{ id: string }>(
    `SELECT u.id
       FROM usuarios u
      WHERE u.tenant_id = $1
        AND u.id = ANY($2::uuid[])
        AND (
          u.rol = 'admin'
          OR u.alcance_combustible <> 'asignado'
          OR EXISTS (
            SELECT 1
              FROM usuario_accesos_combustible ac
             WHERE ac.usuario_id = u.id
               AND ac.tenant_id = u.tenant_id
               AND (ac.grifo_interno_id = $3
                    OR ac.sede_id = (SELECT g.sede_id FROM grifos_internos g
                                      WHERE g.id = $3 AND g.tenant_id = u.tenant_id))
          )
        )`,
    [tenantId, usuarioIds, grifoInternoId]
  );
  return new Set(r.rows.map((x) => x.id));
}

/** Los destinatarios de alertas de COMBUSTIBLE que ven un grifo dado: la
 *  marca explícita de 0107 (`usuario_alertas_correo`, vía el helper
 *  compartido) filtrada por el alcance de cada uno.
 *
 *  `grifoInternoId` en `null` = toda la empresa, para los avisos que no son
 *  de un punto (urea, talonario, la config del módulo).
 *
 *  Vive acá, y no en el repositorio, porque la usan DOS módulos: combustible
 *  y equipos --aflojar el consumo máximo de una unidad despierta a los
 *  destinatarios de combustible, no a los de equipos, porque el control que
 *  se ensancha es de ellos. Una sola definición para que no se puedan ir
 *  separando. */
export async function destinatariosDeAlertasEnGrifo(
  client: PoolClient,
  tenantId: string,
  grifoInternoId: number | null
): Promise<DestinatarioDeAlerta[]> {
  const marcados = await findDestinatariosAlertas(client, tenantId, "combustible");
  if (grifoInternoId === null || marcados.length === 0) return marcados;
  const ven = await usuariosQueVenElGrifo(
    client,
    tenantId,
    marcados.map((m) => m.id),
    grifoInternoId
  );
  return marcados.filter((m) => ven.has(m.id));
}

/** Los grifos activos a los que, con el alcance de cada uno, NO les quedó
 *  ningún destinatario de alertas: lo que pase ahí no se lo avisa a nadie por
 *  correo.
 *
 *  Es el agujero que abre el propio enrutamiento, y por eso se vigila. Antes
 *  el correo iba a todos los marcados, así que alcanzaba con que hubiera UNO
 *  en la empresa; ahora cada punto necesita a alguien que lo mire, y un grifo
 *  nuevo --o alguien que se queda sin su sede-- puede quedar en silencio sin
 *  que nadie lo note. `modulosSinDestinatarios` responde la misma pregunta un
 *  nivel más arriba, para el módulo entero.
 *
 *  Devuelve "Sede - Grifo" para que el aviso diga dónde, no un id. */
export async function grifosSinDestinatariosDeAlertas(
  client: PoolClient,
  tenantId: string
): Promise<string[]> {
  const r = await client.query<{ etiqueta: string }>(
    `SELECT s.nombre || ' - ' || g.nombre AS etiqueta
       FROM grifos_internos g
       JOIN sedes s ON s.tenant_id = g.tenant_id AND s.id = g.sede_id
      WHERE g.tenant_id = $1
        AND g.activo
        AND EXISTS (SELECT 1 FROM tenant_modulos tm
                     WHERE tm.tenant_id = g.tenant_id
                       AND tm.modulo = 'combustible'::modulo_erp
                       AND tm.estado = 'habilitado')
        AND NOT EXISTS (
          SELECT 1
            FROM usuarios u
            JOIN usuario_alertas_correo a
              ON a.usuario_id = u.id AND a.tenant_id = u.tenant_id
             AND a.modulo = 'combustible'::modulo_erp AND a.recibe_alertas
            JOIN usuario_modulos um
              ON um.usuario_id = u.id AND um.modulo = 'combustible'::modulo_erp
           WHERE u.tenant_id = g.tenant_id
             AND u.activo = true
             AND u.email IS NOT NULL
             AND (
               u.rol = 'admin'
               OR u.alcance_combustible <> 'asignado'
               OR EXISTS (
                 SELECT 1 FROM usuario_accesos_combustible ac
                  WHERE ac.usuario_id = u.id AND ac.tenant_id = u.tenant_id
                    AND (ac.grifo_interno_id = g.id OR ac.sede_id = g.sede_id)
               )
             )
        )
      ORDER BY s.nombre, g.nombre`,
    [tenantId]
  );
  return r.rows.map((f) => f.etiqueta);
}

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
  // Tanqueta (0111): es del grifo donde se llena.
  tanquetaId: guardia((client, tenantId, a, id) =>
    existe(
      client,
      `SELECT 1 FROM combustible_tanquetas t
        WHERE t.id = $1 AND t.tenant_id = $2 AND t.grifo_interno_id = ANY($3::int[])`,
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
