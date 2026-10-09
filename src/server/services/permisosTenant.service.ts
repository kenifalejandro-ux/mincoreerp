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
import {
  MODULOS_CON_ALERTAS_POR_CORREO,
  modulosSinDestinatarios,
} from "../shared/utils/destinatariosAlertas";
import { grifosSinDestinatariosDeAlertas } from "../../modules/combustible/alcance";
import { revocarSesionesService, type UsuarioPayload } from "./auth.service";
import {
  guardarPermisosPestanas,
  listarPermisosPestanasEnTransaccion,
  listarPermisosPestanasService,
  type PermisoPestana,
} from "./permisosPestanas.service";
import { moduloPorDefectoDeRol, type NivelModulo } from "./perfilesDefaults";

export type { NivelModulo };

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
  pestanas: Awaited<ReturnType<typeof listarPermisosPestanasService>>;
  /** De qué módulos recibe los correos de alerta (0107). Una entrada por
   *  módulo disponible, como `modulos`. */
  alertasCorreo: AlertaDeModulo[];
  /** De la EMPRESA, no de esta persona: los módulos habilitados a los que no
   *  les quedó ningún destinatario. Viaja en este payload porque es el que la
   *  pantalla de Configuración ya pide, y el aviso tiene que aparecer justo
   *  donde el admin acaba de dejar a un módulo sin nadie mirándolo. */
  modulosSinDestinatarios: string[];
  /** También de la EMPRESA: los grifos de combustible que, con el alcance de
   *  cada destinatario, no le quedaron a cargo de nadie. El nivel de abajo de
   *  `modulosSinDestinatarios` -- el módulo puede tener gente y aun así haber
   *  un punto que nadie mira. */
  grifosSinDestinatarios: string[];
}

export interface AlertaDeModulo {
  modulo: string;
  recibeAlertas: boolean;
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
export async function modulosDisponibles(client: PoolClient, tenantId: string): Promise<string[]> {
  const result = await client.query(
    `SELECT modulo FROM tenant_modulos WHERE tenant_id = $1 AND estado <> 'deshabilitado'`,
    [tenantId]
  );
  const contratados = new Set(result.rows.map((f) => f.modulo as string));
  return MODULOS_ERP.filter((modulo) => contratados.has(modulo));
}

/** Deja al usuario con los módulos y pestañas predeterminados de su perfil
 *  nuevo. Lo usan los dos caminos que cambian el perfil (Administración del
 *  tenant y "Cambiar perfil" de plataforma): si uno solo lo hiciera, el otro
 *  dejaba al usuario con los restos del perfil anterior. */
export async function reiniciarModulosDePerfil(
  client: PoolClient,
  usuarioId: string,
  rolNuevo: UsuarioPayload["rol"],
  disponibles: Iterable<string>
): Promise<void> {
  await client.query(`DELETE FROM usuario_permisos_pestana WHERE usuario_id = $1`, [usuarioId]);
  // Las alertas por correo (0107) también se rehacen: el perfil nuevo arranca
  // sin ninguna, igual que arranca sin overrides de pestañas. No se re-siembra
  // por rol a propósito -- "admin recibe todo" es exactamente el default
  // implícito que 0107 vino a sacar. Que un módulo quede sin destinatario se
  // ve en pantalla.
  await client.query(`DELETE FROM usuario_alertas_correo WHERE usuario_id = $1`, [usuarioId]);
  await client.query(`DELETE FROM usuario_modulos WHERE usuario_id = $1`, [usuarioId]);
  for (const modulo of disponibles) {
    const base = moduloPorDefectoDeRol(rolNuevo, modulo);
    if (!base.asignado) continue;
    await client.query(
      `INSERT INTO usuario_modulos (usuario_id, modulo, nivel) VALUES ($1, $2, $3)`,
      [usuarioId, modulo, base.nivel]
    );
  }
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

    const alertas = await client.query<{ modulo: string; recibe_alertas: boolean }>(
      `SELECT modulo, recibe_alertas FROM usuario_alertas_correo
        WHERE usuario_id = $1 AND tenant_id = $2`,
      [usuarioId, tenantId]
    );
    const alertaPorModulo = new Map(
      alertas.rows.map((f) => [f.modulo, f.recibe_alertas as boolean])
    );

    return {
      usuarioId: perfil.id,
      nombre: perfil.nombre,
      rol: perfil.rol,
      alcanceCombustible: await leerAlcance(client, tenantId, usuarioId),
      pestanas: await listarPermisosPestanasEnTransaccion(client, tenantId, usuarioId),
      modulos: disponibles.map((modulo) => ({
        modulo,
        asignado: porModulo.has(modulo),
        nivel: porModulo.get(modulo) ?? "operar",
      })),
      // Sin fila = no recibe. Ver el encabezado de la migración 0107. Solo los
      // módulos que de verdad envían correos: ver MODULOS_CON_ALERTAS_POR_CORREO.
      alertasCorreo: disponibles
        .filter((modulo) => MODULOS_CON_ALERTAS_POR_CORREO.includes(modulo))
        .map((modulo) => ({
          modulo,
          recibeAlertas: alertaPorModulo.get(modulo) ?? false,
        })),
      modulosSinDestinatarios: await modulosSinDestinatarios(client, tenantId),
      grifosSinDestinatarios: await grifosSinDestinatariosDeAlertas(client, tenantId),
    };
  });
}

export interface CambioDePermisos {
  rol?: UsuarioPayload["rol"];
  modulos: { modulo: string; asignado: boolean; nivel: NivelModulo }[];
  /** Ausente = no se toca. */
  alcanceCombustible?: AlcanceDeCombustible;
  pestanas?: PermisoPestana[];
  /** Ausente = no se toca (0107). */
  alertasCorreo?: AlertaDeModulo[];
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
 *  operador a grifero también (el rol recorta módulos, ver MODULOS_POR_ROL).
 *
 *  Las alertas por correo (0107) NO cuentan: destildar una casilla no le quita
 *  a nadie acceso a nada, y echar a alguien de sus sesiones abiertas por dejar
 *  de mandarle correos sería un castigo sin motivo. */
function calcularRecorte(antes: PermisosDeUsuario, despues: PermisosDeUsuario): boolean {
  if (antes.rol !== despues.rol && despues.rol !== "admin") return true;
  if (alcanceRecorta(antes.alcanceCombustible, despues.alcanceCombustible)) return true;

  const nivelAntes = new Map(antes.modulos.map((m) => [m.modulo, m]));
  const recortaModulo = despues.modulos.some((ahora) => {
    const era = nivelAntes.get(ahora.modulo);
    if (!era?.asignado) return false;
    if (!ahora.asignado) return true;
    return era.nivel === "operar" && ahora.nivel === "consultas";
  });
  if (recortaModulo) return true;

  const pestañasAntes = new Map(
    antes.pestanas.map((p) => [`${p.modulo}:${p.pestana}`, p.permitido])
  );
  return despues.pestanas.some(
    (p) => pestañasAntes.get(`${p.modulo}:${p.pestana}`) === true && !p.permitido
  );
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
    const cambiaDePerfil = Boolean(cambio.rol && cambio.rol !== antes.rol);

    if (cambio.rol && cambiaDePerfil) {
      await client.query(`UPDATE usuarios SET rol = $1, actualizado_en = now() WHERE id = $2`, [
        cambio.rol,
        usuarioId,
      ]);
    }

    if (cambio.alcanceCombustible) {
      await guardarAlcance(client, tenantId, usuarioId, cambio.alcanceCombustible);
    }

    // Cambiar de perfil REHACE la configuración: el perfil nuevo hereda sus
    // propios predeterminados, no los restos del anterior (Kenif, 2026-10-01
    // -- "las empresas cambian de perfil, un admin puede pasar a consultas").
    // Sin esto, alguien que pasa de Lectura a Encargado de Urea se quedaba
    // con todos sus módulos en "Consultas" y con los overrides de pestañas
    // del perfil viejo.
    if (cambiaDePerfil) {
      await reiniciarModulosDePerfil(
        client,
        usuarioId,
        cambio.rol as UsuarioPayload["rol"],
        disponibles
      );
      return;
    }

    if (cambio.pestanas) {
      await guardarPermisosPestanas(client, tenantId, usuarioId, cambio.pestanas);
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

    // Después del reparto de módulos, no antes: quitarle un módulo le quita
    // también sus alertas, y para saber qué módulos le quedaron hay que leer
    // el estado final.
    await guardarAlertasCorreo(client, tenantId, usuarioId, cambio.alertasCorreo);
  });

  const despues = await listarPermisosUsuarioService(tenantId, usuarioId);
  const recorta = calcularRecorte(antes, despues);

  if (recorta) await revocarSesionesService(usuarioId, tenantId);

  return { antes, despues, recorta };
}

/** Quién recibe los correos de alerta de cada módulo (0107).
 *
 *  La limpieza corre SIEMPRE, incluso cuando el request no trae
 *  `alertasCorreo`: si el mismo guardado le quitó un módulo, su marca de
 *  alertas se va con él en la misma transacción. Sin eso quedaría una fila
 *  huérfana que vuelve a la vida -- y vuelve a mandar correos -- el día que
 *  alguien le reasigne el módulo, que es la clase de reaparición silenciosa
 *  que la migración 0100 ya evitó con el alcance.
 *
 *  `pedidos` es el estado completo, no un parche, por lo mismo que `modulos`:
 *  dos administradores editando a la vez no pueden dejar una marca puesta
 *  porque nadie mandó su baja. */
async function guardarAlertasCorreo(
  client: PoolClient,
  tenantId: string,
  usuarioId: string,
  pedidos: AlertaDeModulo[] | undefined
) {
  await client.query(
    `DELETE FROM usuario_alertas_correo
      WHERE usuario_id = $1 AND tenant_id = $2
        AND modulo NOT IN (SELECT modulo FROM usuario_modulos WHERE usuario_id = $1)`,
    [usuarioId, tenantId]
  );
  if (!pedidos) return;

  // Solo módulos que la persona TIENE: marcar alertas de algo que no ve sería
  // enterarse por correo de un módulo al que no se puede entrar.
  const asignados = await client.query<{ modulo: string }>(
    `SELECT modulo FROM usuario_modulos WHERE usuario_id = $1`,
    [usuarioId]
  );
  const tiene = new Set(asignados.rows.map((f) => f.modulo));

  for (const pedido of pedidos) {
    if (!tiene.has(pedido.modulo)) continue;
    // Un módulo que no envía correos no tiene nada que suscribir: se ignora
    // en silencio, igual que uno que la empresa no contrató.
    if (!MODULOS_CON_ALERTAS_POR_CORREO.includes(pedido.modulo)) continue;
    await client.query(
      `INSERT INTO usuario_alertas_correo (tenant_id, usuario_id, modulo, recibe_alertas)
       VALUES ($1, $2, $3::modulo_erp, $4)
       ON CONFLICT (usuario_id, modulo)
         DO UPDATE SET recibe_alertas = EXCLUDED.recibe_alertas, actualizado_en = now()`,
      [tenantId, usuarioId, pedido.modulo, pedido.recibeAlertas]
    );
  }
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
