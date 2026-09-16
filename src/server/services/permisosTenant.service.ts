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
