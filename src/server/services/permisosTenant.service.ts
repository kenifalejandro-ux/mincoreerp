/** src/server/services/permisosTenant.service.ts
 *
 * Las **autonomías**: qué módulos ve cada persona de la empresa y con qué
 * nivel. Es la pantalla "Administración → Configuración" que pidió Kenif
 * copiando el telebanking de su banco.
 *
 * ── El límite que no se puede cruzar ────────────────────────────────────
 *
 * Un administrador reparte lo que su empresa YA tiene contratado; no se
 * habilita módulos a sí mismo. Qué módulos tiene una empresa es parte del
 * contrato comercial y lo sigue decidiendo la plataforma (`tenant_modulos`,
 * migración 0008). Por eso `modulosDisponibles` filtra por el estado del
 * módulo en la empresa y `guardarPermisos` ignora cualquier módulo que no
 * esté ahí: aunque alguien arme el request a mano, no puede darse acceso a
 * algo que su empresa no contrató.
 *
 * ── Cuándo se cierran las sesiones ──────────────────────────────────────
 *
 * Cuando el cambio RECORTA (saca un módulo, baja a consultas, cambia el tipo
 * de usuario), las sesiones abiertas de ese perfil se cierran en el acto: si
 * no, alguien a quien le acaban de quitar el acceso lo conserva hasta que su
 * token se renueve. Cuando el cambio solo AGREGA, no hace falta echar a
 * nadie: la sesión toma lo nuevo en su próxima renovación. Es el mismo
 * criterio que el resto del ERP -- endurecer es inmediato, aflojar puede
 * esperar.
 */
import type { PoolClient } from "pg";

import { withTenant } from "../config/database";
import { MODULOS_ERP } from "../schemas/platform.schema";
import { AppError } from "../shared/middlewares/error.middleware";
import { revocarSesionesService, type UsuarioPayload } from "./auth.service";

export type NivelModulo = "operar" | "consultas";

export interface PermisoDeModulo {
  modulo: string;
  /** false = sin acceso. En la base, "sin acceso" es que la fila no exista. */
  asignado: boolean;
  nivel: NivelModulo;
}

export interface PermisosDeUsuario {
  usuarioId: string;
  nombre: string;
  rol: UsuarioPayload["rol"];
  /** Solo los módulos que la EMPRESA tiene; un admin no puede dar más que eso. */
  modulos: PermisoDeModulo[];
  /** Qué sedes, grifos y surtidores ve en Combustible (0100). */
  alcanceCombustible: AlcanceDeCombustible;
}

/** `todo` = todas las sedes (el valor de todos hasta la migración 0100). */
export interface AlcanceDeCombustible {
  todo: boolean;
  sedes: number[];
  grifos: number[];
  surtidores: number[];
}

async function leerAlcance(
  client: PoolClient,
  tenantId: string,
  usuarioId: string
): Promise<AlcanceDeCombustible> {
  const perfil = await client.query<{ alcance_combustible: string }>(
    `SELECT alcance_combustible FROM usuarios WHERE id = $1 AND tenant_id = $2`,
    [usuarioId, tenantId]
  );
  const accesos = await client.query<{
    sede_id: number | null;
    grifo_interno_id: number | null;
    surtidor_id: number | null;
  }>(
    `SELECT sede_id, grifo_interno_id, surtidor_id FROM usuario_accesos_combustible
      WHERE usuario_id = $1 AND tenant_id = $2`,
    [usuarioId, tenantId]
  );
  const de = (k: "sede_id" | "grifo_interno_id" | "surtidor_id") =>
    accesos.rows
      .map((f) => f[k])
      .filter((v): v is number => v !== null)
      .sort((a, b) => a - b);
  return {
    todo: perfil.rows[0]?.alcance_combustible !== "asignado",
    sedes: de("sede_id"),
    grifos: de("grifo_interno_id"),
    surtidores: de("surtidor_id"),
  };
}

/** ¿El alcance nuevo deja ver algo que el anterior no? Eso pide dos firmas,
 *  aunque el mismo cambio recorte otra cosa. */
export function alcanceAmplia(antes: AlcanceDeCombustible, despues?: AlcanceDeCombustible) {
  if (!despues || antes.todo) return false;
  if (despues.todo) return true;
  const nuevo = (a: number[], b: number[]) => b.some((x) => !a.includes(x));
  return (
    nuevo(antes.sedes, despues.sedes) ||
    nuevo(antes.grifos, despues.grifos) ||
    nuevo(antes.surtidores, despues.surtidores)
  );
}

/** ¿Deja de ver algo que veía? */
export function alcanceRecorta(antes: AlcanceDeCombustible, despues: AlcanceDeCombustible) {
  if (antes.todo) return !despues.todo;
  if (despues.todo) return false;
  const falta = (a: number[], b: number[]) => a.some((x) => !b.includes(x));
  return (
    falta(antes.sedes, despues.sedes) ||
    falta(antes.grifos, despues.grifos) ||
    falta(antes.surtidores, despues.surtidores)
  );
}

/** Los módulos que la empresa tiene hoy, en el orden del registry.
 *
 *  'rollout' cuenta como disponible: el reparto por usuario es "en principio
 *  lo puede ver", y quién lo ve de verdad lo decide el bucketing en cada
 *  login (ver obtenerModulosConNivel). Un módulo 'deshabilitado' no aparece
 *  siquiera en la pantalla. */
async function modulosDisponibles(client: PoolClient, tenantId: string): Promise<string[]> {
  const result = await client.query(
    `SELECT modulo FROM tenant_modulos WHERE tenant_id = $1 AND estado <> 'deshabilitado'`,
    [tenantId]
  );
  const contratados = new Set(result.rows.map((f) => f.modulo as string));
  return MODULOS_ERP.filter((modulo) => contratados.has(modulo));
}

async function perfilDelTenant(client: PoolClient, tenantId: string, usuarioId: string) {
  const result = await client.query(
    `SELECT id, nombre, rol FROM usuarios WHERE id = $1 AND tenant_id = $2`,
    [usuarioId, tenantId]
  );
  if (!result.rows[0]) throw new AppError(404, "Usuario no encontrado");
  return result.rows[0];
}

export async function listarPermisosUsuarioService(
  tenantId: string,
  usuarioId: string
): Promise<PermisosDeUsuario> {
  return withTenant(tenantId, async (client) => {
    const perfil = await perfilDelTenant(client, tenantId, usuarioId);
    const disponibles = await modulosDisponibles(client, tenantId);

    const asignados = await client.query(
      `SELECT modulo, nivel FROM usuario_modulos WHERE usuario_id = $1`,
      [usuarioId]
    );
    const porModulo = new Map<string, NivelModulo>(
      asignados.rows.map((f) => [f.modulo as string, f.nivel as NivelModulo])
    );

    return {
      usuarioId: perfil.id,
      nombre: perfil.nombre,
      rol: perfil.rol,
      alcanceCombustible: await leerAlcance(client, tenantId, usuarioId),
      modulos: disponibles.map((modulo) => ({
        modulo,
        asignado: porModulo.has(modulo),
        nivel: porModulo.get(modulo) ?? "operar",
      })),
    };
  });
}

export interface CambioDePermisos {
  rol?: UsuarioPayload["rol"];
  modulos: { modulo: string; asignado: boolean; nivel: NivelModulo }[];
  /** Ausente = no se toca. */
  alcanceCombustible?: AlcanceDeCombustible;
}

export interface ResultadoPermisos {
  antes: PermisosDeUsuario;
  despues: PermisosDeUsuario;
  /** true si el cambio le SACA algo a la persona. Decide si se le cierran las
   *  sesiones ya mismo y qué se le dice al administrador. */
  recorta: boolean;
}

/** ¿El cambio le quita algo? Un módulo que ya no tiene, o que pasa de operar
 *  a consultas. El cambio de tipo de usuario cuenta como recorte salvo que
 *  suba a administrador: bajar de admin a operador quita permisos, y de
 *  operador a grifero también (el rol recorta módulos, ver MODULOS_POR_ROL). */
function calcularRecorte(antes: PermisosDeUsuario, despues: PermisosDeUsuario): boolean {
  if (antes.rol !== despues.rol && despues.rol !== "admin") return true;
  if (alcanceRecorta(antes.alcanceCombustible, despues.alcanceCombustible)) return true;

  const nivelAntes = new Map(antes.modulos.map((m) => [m.modulo, m]));
  return despues.modulos.some((ahora) => {
    const era = nivelAntes.get(ahora.modulo);
    if (!era?.asignado) return false;
    if (!ahora.asignado) return true;
    return era.nivel === "operar" && ahora.nivel === "consultas";
  });
}

export async function guardarPermisosUsuarioService(
  tenantId: string,
  usuarioId: string,
  cambio: CambioDePermisos,
  /** El admin que hace el cambio. No puede editarse a sí mismo: quitarse
   *  permisos por error deja a la empresa sin quien los devuelva, y dárselos
   *  a sí mismo es exactamente lo que la doble firma viene a impedir. */
  actorId: string
): Promise<ResultadoPermisos> {
  if (usuarioId === actorId) {
    throw new AppError(
      400,
      "No podés cambiar tus propios permisos. Pedíselo al otro administrador"
    );
  }

  const antes = await listarPermisosUsuarioService(tenantId, usuarioId);

  await withTenant(tenantId, async (client) => {
    const disponibles = new Set(await modulosDisponibles(client, tenantId));

    if (cambio.rol && cambio.rol !== antes.rol) {
      await client.query(`UPDATE usuarios SET rol = $1, actualizado_en = now() WHERE id = $2`, [
        cambio.rol,
        usuarioId,
      ]);
    }

    if (cambio.alcanceCombustible) {
      await guardarAlcance(client, tenantId, usuarioId, cambio.alcanceCombustible);
    }

    for (const pedido of cambio.modulos) {
      // Un módulo que la empresa no tiene se ignora en silencio: no es un
      // error del administrador, es un request que no puede valer.
      if (!disponibles.has(pedido.modulo)) continue;

      if (pedido.asignado) {
        await client.query(
          `INSERT INTO usuario_modulos (usuario_id, modulo, nivel)
           VALUES ($1, $2, $3)
           ON CONFLICT (usuario_id, modulo) DO UPDATE SET nivel = EXCLUDED.nivel`,
          [usuarioId, pedido.modulo, pedido.nivel]
        );
      } else {
        await client.query(`DELETE FROM usuario_modulos WHERE usuario_id = $1 AND modulo = $2`, [
          usuarioId,
          pedido.modulo,
        ]);
      }
    }
  });

  const despues = await listarPermisosUsuarioService(tenantId, usuarioId);
  const recorta = calcularRecorte(antes, despues);

  if (recorta) await revocarSesionesService(usuarioId, tenantId);

  return { antes, despues, recorta };
}

/** Reemplaza el alcance entero. Cada id tiene que ser de ESTA empresa: la
 *  clave compuesta también lo impediría, pero con un 500. */
async function guardarAlcance(
  client: PoolClient,
  tenantId: string,
  usuarioId: string,
  alcance: AlcanceDeCombustible
) {
  const unicos = (ids: number[]) => [...new Set(ids)];
  const sedes = unicos(alcance.sedes);
  const grifos = unicos(alcance.grifos);
  const surtidores = unicos(alcance.surtidores);
  const existen = async (tabla: string, ids: number[]) =>
    ids.length === 0 ||
    Number(
      (
        await client.query(
          `SELECT count(*) AS n FROM ${tabla} WHERE tenant_id = $1 AND id = ANY($2::int[])`,
          [tenantId, ids]
        )
      ).rows[0].n
    ) === ids.length;
  if (
    !(await existen("sedes", sedes)) ||
    !(await existen("grifos_internos", grifos)) ||
    !(await existen("surtidores", surtidores))
  ) {
    throw new AppError(400, "Alguna sede, grifo o surtidor del alcance no existe");
  }

  await client.query(
    `UPDATE usuarios SET alcance_combustible = $1 WHERE id = $2 AND tenant_id = $3`,
    [alcance.todo ? "todo" : "asignado", usuarioId, tenantId]
  );
  await client.query(
    `DELETE FROM usuario_accesos_combustible WHERE usuario_id = $1 AND tenant_id = $2`,
    [usuarioId, tenantId]
  );
  if (alcance.todo) return;
  const filas: ["sede_id" | "grifo_interno_id" | "surtidor_id", number][] = [
    ...sedes.map((id) => ["sede_id", id] as ["sede_id", number]),
    ...grifos.map((id) => ["grifo_interno_id", id] as ["grifo_interno_id", number]),
    ...surtidores.map((id) => ["surtidor_id", id] as ["surtidor_id", number]),
  ];
  for (const [columna, id] of filas) {
    await client.query(
      `INSERT INTO usuario_accesos_combustible (tenant_id, usuario_id, ${columna})
       VALUES ($1, $2, $3)`,
      [tenantId, usuarioId, id]
    );
  }
}
