/** src/server/services/platform.service.ts
 *
 * Operaciones de plataforma: alta de tenants, y control de qué módulos
 * tiene contratados cada empresa y qué usuario ve cada uno — nunca toca
 * las tablas de negocio (repuestos, combustible, documentos, etc.), solo
 * metadatos. Separado de auth.service.ts porque no son operaciones de un
 * usuario autenticado de un tenant — las protege platformAdmin.middleware.ts
 * con un secreto aparte, no un JWT.
 *
 * `usuarios` tiene RLS (ver migrations/0010_usuarios_rls.sql) — toda
 * función acá que lea/escriba esa tabla necesita el `tenantId` explícito
 * ANTES de tocarla, y pasa por withTenant(). Por eso las operaciones sobre
 * un usuario puntual (activar/desactivar, módulos) viven bajo
 * `/tenants/:tenantId/usuarios/:usuarioId/...` en vez de `/usuarios/:id/...`
 * — sin el tenantId en la ruta, ni siquiera se podría comprobar que el
 * usuario existe. `tenant_modulos`/`usuario_modulos` siguen sin RLS (el
 * panel necesita leer/escribir cualquier tenant sin ese requisito).
 */
import type { Pool, PoolClient } from "pg";
import { pool, withTenant } from "../config/database";
import { logger } from "../config/logger";
import { AppError } from "../shared/middlewares/error.middleware";
import {
  crearUsuarioService,
  invitarAlPerfilService,
  revocarSesionesService,
  revocarSesionesDeCuentaService,
  aPublico,
  type UsuarioPublico,
} from "./auth.service";
import { MODULOS_ERP } from "../schemas/platform.schema";
import { verificarCuota, CuotaExcedidaError, RECURSO_USUARIOS } from "./platformCuotas.service";
import { esViolacionUnicidad, esViolacionForeignKey } from "../shared/utils/pgError";
import type { CrearTenantInput, CrearUsuarioEnTenantInput } from "../schemas/platform.schema";
import { registrarAuditoria, type ContextoAuditoria } from "./platformAudit.service";
import { escribirEventoOutbox } from "./platformOutbox.service";

export type { ContextoAuditoria };

export interface TenantCreado {
  id: string;
  nombre: string;
  slug: string;
}

async function habilitarTodosLosModulos(tenantId: string, db: Pool | PoolClient) {
  const placeholders = MODULOS_ERP.map((_, i) => `($1, $${i + 2}, 'habilitado')`).join(", ");
  await db.query(
    `INSERT INTO tenant_modulos (tenant_id, modulo, estado) VALUES ${placeholders}
     ON CONFLICT (tenant_id, modulo) DO NOTHING`,
    [tenantId, ...MODULOS_ERP]
  );
}

export async function crearTenantConAdminService(
  input: CrearTenantInput,
  contexto: ContextoAuditoria,
  idempotencyKey?: string,
  // UUID ya resuelto/validado por el caller (ver tenantOnboardingService.ts)
  // — este servicio no conoce códigos de plan, solo el id. Se aplica DENTRO
  // de esta misma transacción para que "tenant creado sin su plan" nunca
  // sea un estado posible, ni siquiera transitorio: si el UPDATE de más
  // abajo fallara, el tenant tampoco queda creado.
  planId?: string
): Promise<{ tenant: TenantCreado; usuario: UsuarioPublico }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    let tenantResult;
    try {
      tenantResult = await client.query(
        `INSERT INTO tenants (nombre, slug) VALUES ($1, $2) RETURNING id, nombre, slug`,
        [input.tenantNombre, input.tenantSlug]
      );
    } catch (err) {
      if (esViolacionUnicidad(err)) {
        throw new AppError(409, "Ya existe un tenant con ese slug");
      }
      throw err;
    }

    const tenant: TenantCreado = tenantResult.rows[0];

    if (planId) {
      await client.query(`UPDATE tenants SET plan_id = $1 WHERE id = $2`, [planId, tenant.id]);
    }

    // usuarios tiene RLS — sin esto, el INSERT de crearUsuarioService más
    // abajo (en este mismo client/transacción) fallaría. `is_local=true`
    // (tercer argumento) deja app.tenant_id visible solo hasta el
    // COMMIT/ROLLBACK de esta transacción, igual que hace withTenant().
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenant.id]);

    // Un tenant nuevo arranca con todo habilitado ("full featured" desde
    // el día uno) — el panel de plataforma restringe módulos puntuales
    // después, según lo que ese cliente haya contratado.
    await habilitarTodosLosModulos(tenant.id, client);

    // Mismo client/transacción: si crear el admin falla, el tenant tampoco
    // queda creado — nunca un tenant huérfano sin nadie que pueda entrar.
    const usuario = await crearUsuarioService(
      {
        tenantId: tenant.id,
        nombre: input.adminNombre,
        email: input.adminEmail,
        password: input.adminPassword,
        rol: "admin",
      },
      client
    );

    const resultado = { tenant, usuario: aPublico(usuario) };

    // Mismo client/transacción que el tenant recién creado: si el COMMIT
    // de abajo no llega a pasar, tampoco queda este registro — un retry
    // con esta misma Idempotency-Key nunca va a encontrar una respuesta
    // "fantasma" de un tenant que en realidad no llegó a crearse. Ver
    // platformOutbox.service.ts / platformIdempotency.service.ts.
    if (idempotencyKey) {
      await escribirEventoOutbox(client, {
        tipo: "idempotency_response",
        clave: idempotencyKey,
        payload: { ok: true, ...resultado },
      });
    }

    await client.query("COMMIT");

    await registrarAuditoria({
      accion: "crear_tenant",
      tenantId: tenant.id,
      usuarioId: usuario.id,
      detalle: {
        tenantNombre: tenant.nombre,
        tenantSlug: tenant.slug,
        adminEmail: input.adminEmail,
        planId: planId ?? null,
      },
      contexto,
    });

    return resultado;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (err instanceof AppError) throw err;
    logger.error({ err }, "Error al crear tenant con admin");
    throw new AppError(500, "No se pudo crear el tenant");
  } finally {
    client.release();
  }
}

// Verificación de propiedad de dominio: ver platformDomain.service.ts
// (asignarDominioTenantService / verificarDominioService). dominioEstado
// se expone acá para que la lista de tenants no necesite un segundo
// request solo para saber si un dominio ya quedó verificado.
export async function listarTenantsService(): Promise<
  (TenantCreado & {
    activo: boolean;
    dominioPersonalizado: string | null;
    dominioEstado: string;
  })[]
> {
  const result = await pool.query(
    `SELECT id, nombre, slug, activo, dominio_personalizado AS "dominioPersonalizado",
            dominio_estado AS "dominioEstado"
     FROM tenants ORDER BY nombre`
  );
  return result.rows;
}

/** Los cuatro estados del ciclo de vida de un tenant -- ver
 *  migrations/0038_tenant_estado_ciclo_vida.sql y
 *  docs/architecture/ciclo-de-vida-tenant.md. `tenants.activo` es una
 *  columna GENERATED a partir de esta (`estado = 'active'`), así que
 *  nunca se escribe directo -- Postgres lo rechaza. */
export type EstadoTenant = "provisioning" | "active" | "suspended" | "pending_deletion";

/** Activa/desactiva un tenant. Un tenant desactivado no puede loguear
 *  (ver loginService) y a los que ya tengan sesión abierta se les corta
 *  el acceso en ≤60s (mismo cache/mecanismo que revoca por token_version,
 *  ver authMiddleware + token-version-cache.ts).
 *
 *  Sigue recibiendo `activo: boolean` (no `estado` directo) a propósito:
 *  es el contrato que ya usa el panel (CambiarEstadoDialog.tsx) y no hace
 *  falta tocar el frontend para que el ciclo de vida completo exista en el
 *  esquema -- `true`/`false` se traducen a 'active'/'suspended', los dos
 *  únicos estados que este flujo produce hoy. 'provisioning' y
 *  'pending_deletion' quedan disponibles en la base para cuando haya un
 *  camino de código real que los use (ver el doc de arquitectura para qué
 *  falta). */
export async function cambiarEstadoTenantService(
  tenantId: string,
  activo: boolean,
  motivo: string | undefined,
  contexto: ContextoAuditoria
): Promise<TenantCreado> {
  const anterior = await pool.query(`SELECT estado FROM tenants WHERE id = $1`, [tenantId]);
  if (anterior.rows.length === 0) {
    throw new AppError(404, "Tenant no encontrado");
  }

  const estado: EstadoTenant = activo ? "active" : "suspended";
  const result = await pool.query(
    `UPDATE tenants SET estado = $1 WHERE id = $2 RETURNING id, nombre, slug`,
    [estado, tenantId]
  );

  await registrarAuditoria({
    accion: "cambiar_estado_tenant",
    tenantId,
    detalle: {
      before: { estado: anterior.rows[0].estado },
      after: { estado },
      motivo: motivo ?? null,
    },
    contexto,
  });

  return result.rows[0];
}

export type EstadoModulo = "habilitado" | "deshabilitado" | "rollout";

export interface ModuloEstado {
  modulo: string;
  estado: EstadoModulo;
  rolloutPorcentaje: number | null;
  version: string | null;
}

export interface ConfiguracionModulo {
  modulo: string;
  estado: EstadoModulo;
  rolloutPorcentaje?: number | null;
  version?: string | null;
}

/** Siempre devuelve los 7 módulos (LEFT JOIN), no solo los que ya tengan
 *  fila — un tenant creado antes de este sistema podría no tener todas. */
export async function obtenerModulosTenantService(tenantId: string): Promise<ModuloEstado[]> {
  const tenant = await pool.query(`SELECT id FROM tenants WHERE id = $1`, [tenantId]);
  if (tenant.rows.length === 0) {
    throw new AppError(404, "Tenant no encontrado");
  }

  const result = await pool.query(
    `SELECT m.modulo, COALESCE(tm.estado, 'deshabilitado') AS estado,
            tm.rollout_porcentaje AS "rolloutPorcentaje", tm.version
     FROM unnest(enum_range(NULL::modulo_erp)) AS m(modulo)
     LEFT JOIN tenant_modulos tm ON tm.tenant_id = $1 AND tm.modulo = m.modulo
     ORDER BY m.modulo`,
    [tenantId]
  );
  return result.rows;
}

/** Reemplaza la configuración completa de módulos del tenant por la que
 *  llega en `configuraciones` (declarativo, no incremental) — cualquier
 *  módulo que no venga en la lista queda 'deshabilitado'. rolloutPorcentaje
 *  solo tiene sentido con estado 'rollout' — se guarda igual si viene con
 *  otro estado (no rompe nada), pero obtenerModulosPermitidos lo ignora
 *  fuera de 'rollout'. */
export async function actualizarModulosTenantService(
  tenantId: string,
  configuraciones: ConfiguracionModulo[],
  contexto: ContextoAuditoria
): Promise<ModuloEstado[]> {
  const tenant = await pool.query(`SELECT id FROM tenants WHERE id = $1`, [tenantId]);
  if (tenant.rows.length === 0) {
    throw new AppError(404, "Tenant no encontrado");
  }

  const porModulo = new Map(configuraciones.map((c) => [c.modulo, c]));
  for (const modulo of MODULOS_ERP) {
    const config = porModulo.get(modulo);
    const estado = config?.estado ?? "deshabilitado";
    await pool.query(
      `INSERT INTO tenant_modulos (tenant_id, modulo, estado, rollout_porcentaje, version)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, modulo) DO UPDATE SET estado = $3, rollout_porcentaje = $4, version = $5`,
      [tenantId, modulo, estado, config?.rolloutPorcentaje ?? null, config?.version ?? null]
    );
  }

  await registrarAuditoria({
    accion: "actualizar_modulos_tenant",
    tenantId,
    detalle: { configuraciones },
    contexto,
  });

  return obtenerModulosTenantService(tenantId);
}

const MAX_INTENTOS_MODULO_GLOBAL = 3;

/** Aplica el mismo estado/porcentaje/versión de un módulo a TODOS los
 *  tenants de una sola vez — "apagar en caliente globalmente" (ej. un
 *  módulo con un bug grave) sin tener que recorrer tenant por tenant desde
 *  la UI. Un solo INSERT ... SELECT ... ON CONFLICT, atómico: o se aplica
 *  a todos o a ninguno.
 *
 *  Reintenta ante un 23503 (foreign_key_violation): el SELECT id FROM
 *  tenants toma su propia foto, y si un tenant se borra (COMMIT de otra
 *  transacción) entre esa foto y el INSERT de su fila, el chequeo de FK
 *  falla ahí, no en el SELECT. Es una carrera real -- dos admins de
 *  plataforma actuando a la vez, uno dando de baja un tenant justo cuando
 *  el otro aplica un toggle global -- no un caso hipotético: se detectó
 *  porque tests/platform-modulos-granular.test.ts fallaba de forma
 *  intermitente en la suite completa (tenants de OTROS archivos de test
 *  borrándose en paralelo), nunca aislado. Reintentar alcanza: en el
 *  siguiente intento ese tenant ya no aparece en el SELECT. */
export async function actualizarModuloGlobalService(
  modulo: string,
  config: { estado: EstadoModulo; rolloutPorcentaje?: number | null; version?: string | null },
  contexto: ContextoAuditoria
): Promise<{ tenantsAfectados: number }> {
  for (let intento = 1; intento <= MAX_INTENTOS_MODULO_GLOBAL; intento++) {
    try {
      const result = await pool.query(
        `INSERT INTO tenant_modulos (tenant_id, modulo, estado, rollout_porcentaje, version)
         SELECT id, $1, $2, $3, $4 FROM tenants
         ON CONFLICT (tenant_id, modulo) DO UPDATE SET estado = $2, rollout_porcentaje = $3, version = $4`,
        [modulo, config.estado, config.rolloutPorcentaje ?? null, config.version ?? null]
      );

      await registrarAuditoria({
        accion: "actualizar_modulo_global",
        detalle: { modulo, ...config, tenantsAfectados: result.rowCount ?? 0 },
        contexto,
      });

      return { tenantsAfectados: result.rowCount ?? 0 };
    } catch (err) {
      if (!esViolacionForeignKey(err) || intento === MAX_INTENTOS_MODULO_GLOBAL) throw err;
    }
  }

  // Inalcanzable: el loop siempre retorna o lanza -- solo para que TS vea
  // que la función retorna en todos los caminos.
  throw new Error("No se pudo actualizar el módulo globalmente");
}

export interface UsuarioListado {
  id: string;
  nombre: string;
  /** Puede ser null desde 0084: el personal de cancha entra con DNI y muchos
   *  no tienen correo de empresa. Al menos uno de los dos siempre está
   *  (CHECK usuarios_email_o_dni_check). */
  email: string | null;
  dni: string | null;
  rol: string;
  /** La copia booleana de `estado` que mantiene el trigger de 0090. Se sigue
   *  devolviendo para no romper a nadie que ya la lea. */
  activo: boolean;
  /** activo / inactivo (lo dio de baja un admin) / bloqueado (se le trabó la
   *  clave). Ver migrations/0090. */
  estado: "activo" | "inactivo" | "bloqueado";
  /** Del PERFIL, no de la persona: la misma puede tener otro número en otra
   *  empresa, y es cada empresa la que lo mantiene. */
  celular: string | null;
  bloqueadoEn: string | null;
}

/** Nunca selecciona password_hash — esto lo ve el panel de plataforma, que
 *  no debe poder ni ayudar a comprometer credenciales de un tenant. */
export async function listarUsuariosTenantService(tenantId: string): Promise<UsuarioListado[]> {
  const tenant = await pool.query(`SELECT id FROM tenants WHERE id = $1`, [tenantId]);
  if (tenant.rows.length === 0) {
    throw new AppError(404, "Tenant no encontrado");
  }

  return withTenant(tenantId, async (client) => {
    const result = await client.query(
      `SELECT id, nombre, email, dni, rol, activo, estado, celular,
              bloqueado_en AS "bloqueadoEn"
         FROM usuarios WHERE tenant_id = $1 ORDER BY nombre`,
      [tenantId]
    );
    return result.rows;
  });
}

/** Cómo quedó el acceso de la persona recién dada de alta. Lo mira la
 *  pantalla para saber qué mostrarle al administrador: una clave para dictar,
 *  o nada, porque la persona la define sola desde su correo. */
export type ModoAlta = "clave-temporal" | "invitacion-enviada";

export async function crearUsuarioEnTenantService(
  tenantId: string,
  input: CrearUsuarioEnTenantInput,
  contexto: ContextoAuditoria
): Promise<UsuarioPublico & { modo: ModoAlta }> {
  const tenant = await pool.query(`SELECT id FROM tenants WHERE id = $1`, [tenantId]);
  if (tenant.rows.length === 0) {
    throw new AppError(404, "Tenant no encontrado");
  }

  // Un solo punto cubre las DOS vías de alta: el panel y el aprovisionamiento
  // automático por SCIM (routes/scim.ts llama a este mismo servicio). Si el
  // IdP de un cliente empuja más usuarios de los contratados, se rechaza acá
  // con el mismo criterio que un alta manual.
  const usuario = await withTenant(tenantId, async (client) => {
    await verificarCuota(tenantId, RECURSO_USUARIOS, 1, client);
    return crearUsuarioService({ tenantId, ...input }, client);
  }).catch(async (err) => {
    if (err instanceof CuotaExcedidaError) {
      await registrarAuditoria({
        accion: "cuota.bloqueo",
        tenantId,
        detalle: {
          recurso: err.recurso,
          limite: err.limite,
          uso: err.uso,
          operacion: "crear_usuario",
        },
        contexto,
        resultado: "failure",
      });
    }
    throw err;
  });

  // Alta por invitación (entrega 3): con correo y sin clave elegida por el
  // administrador, la persona define la suya desde el enlace que le llega. El
  // administrador ve lo mismo trabaje o no esa persona en otra empresa -- ver
  // invitarAlPerfilService.
  const modo: ModoAlta = usuario.email && !input.password ? "invitacion-enviada" : "clave-temporal";
  if (modo === "invitacion-enviada") {
    await invitarAlPerfilService({
      email: usuario.email!,
      nombre: usuario.nombre,
      tenantId,
    });
  }

  await registrarAuditoria({
    accion: "crear_usuario",
    tenantId,
    usuarioId: usuario.id,
    // El número de carta viaja al detalle para que la EMPRESA lo vea en su
    // log de eventos: es la respuesta a "¿y este usuario de dónde salió?"
    // cuando el alta la hizo MINCORE (§12).
    detalle: {
      email: usuario.email,
      rol: usuario.rol,
      modo,
      ...(input.numeroCarta ? { numeroCarta: input.numeroCarta } : {}),
    },
    contexto,
  });

  return { ...aPublico(usuario), modo };
}

/** **Break-glass** (§12): MINCORE le cambia el tipo de usuario a alguien de
 *  una empresa. Existe para un caso y uno solo: la empresa activó la doble
 *  firma, su segundo administrador se fue, y con uno solo no hay quien firme
 *  la orden que nombraría al reemplazo. Sin esto, la empresa queda trabada y
 *  hay que tocarle la base a mano.
 *
 *  Por eso NO pasa por una orden: es la salida de emergencia del sistema de
 *  órdenes. Lo que sí hace es dejar rastro en la bitácora DE LA EMPRESA, con
 *  motivo obligatorio y el número de carta si lo hay -- sus administradores lo
 *  ven en su log de eventos, que es lo que convierte una intervención del
 *  proveedor en algo auditable por el cliente y no en algo que pasó y nadie
 *  supo. */
export async function reemplazarAdminService(
  tenantId: string,
  usuarioId: string,
  input: { rol: string; motivo: string; numeroCarta?: string },
  contexto: ContextoAuditoria
): Promise<UsuarioListado> {
  const fila = await withTenant(tenantId, async (client) => {
    const anterior = await client.query(
      `SELECT rol FROM usuarios WHERE id = $1 AND tenant_id = $2`,
      [usuarioId, tenantId]
    );
    if (anterior.rows.length === 0) throw new AppError(404, "Usuario no encontrado");

    const actualizado = await client.query(
      `UPDATE usuarios SET rol = $1::rol_usuario, actualizado_en = now()
        WHERE id = $2 AND tenant_id = $3
       RETURNING id, nombre, email, dni, rol, activo, estado, celular,
                 bloqueado_en AS "bloqueadoEn"`,
      [input.rol, usuarioId, tenantId]
    );
    return { fila: actualizado.rows[0], antes: anterior.rows[0].rol };
  });

  // El rol viaja en el JWT: sin revocar, el cambio tardaría hasta media hora
  // en valer, y un break-glass se pide justo cuando no se puede esperar.
  await revocarSesionesService(usuarioId, tenantId);

  await registrarAuditoria({
    accion: "plataforma.reemplazar_admin",
    tenantId,
    usuarioId,
    detalle: {
      antes: { rol: fila.antes },
      despues: { rol: input.rol },
      motivo: input.motivo,
      ...(input.numeroCarta ? { numeroCarta: input.numeroCarta } : {}),
    },
    contexto,
  });

  return fila.fila;
}

/** Desactivar una CUENTA entera: la persona deja de entrar a TODAS sus
 *  empresas (fraude, o ella misma lo pidió). Solo MINCORE: una empresa
 *  desactiva su propio perfil y nada más -- no puede dejar a alguien afuera
 *  del trabajo que tiene en otra.
 *
 *  Queda registrado en la bitácora de cada empresa donde esa persona tenía
 *  perfil: para ellas, alguien dejó de poder entrar y tienen que poder ver por
 *  qué. */
export async function cambiarEstadoCuentaService(
  cuentaId: string,
  activo: boolean,
  motivo: string,
  contexto: ContextoAuditoria
): Promise<{ email: string; activo: boolean; perfilesAfectados: number }> {
  const cuenta = await pool.query(
    `UPDATE cuentas SET activo = $2, actualizado_en = now() WHERE id = $1 RETURNING email`,
    [cuentaId, activo]
  );
  if (cuenta.rows.length === 0) throw new AppError(404, "Cuenta no encontrada");

  // Los perfiles quedan como están (cada empresa decide sobre el suyo): lo que
  // se corta es la cuenta, y con ella el login y el refresh.
  const perfiles = await revocarSesionesDeCuentaService(cuentaId);

  for (const perfil of perfiles) {
    await registrarAuditoria({
      accion: activo ? "plataforma.reactivar_cuenta" : "plataforma.desactivar_cuenta",
      tenantId: perfil.tenantId,
      usuarioId: perfil.usuarioId,
      detalle: { email: cuenta.rows[0].email, motivo },
      contexto,
    });
  }

  return { email: cuenta.rows[0].email, activo, perfilesAfectados: perfiles.length };
}

/** Verifica que el usuario exista Y pertenezca al tenant indicado — con
 *  RLS, "no encontrado" y "es de otro tenant" son indistinguibles para la
 *  query (la fila simplemente no es visible), que es exactamente el
 *  comportamiento deseado: la URL /tenants/:tenantId/usuarios/:usuarioId
 *  nunca debe confirmar la existencia de un usuario que pertenece a otro
 *  tenant. */
async function usuarioPerteneceATenant(tenantId: string, usuarioId: string): Promise<boolean> {
  const existe = await withTenant(tenantId, (client) =>
    client.query(`SELECT id FROM usuarios WHERE id = $1 AND tenant_id = $2`, [usuarioId, tenantId])
  );
  return existe.rows.length > 0;
}

/** Desactivar corta el acceso de inmediato (revoca sus sesiones activas,
 *  igual que cambiarEstadoTenantService hace a nivel de tenant) — nunca
 *  borra la fila: hay historial de negocio (checklists, IPERC, etc.) que
 *  referencia usuarios(id). */
export type EstadoPerfil = "activo" | "inactivo" | "bloqueado";

/** Para los llamadores que siguen hablando de un booleano -- SCIM (el
 *  atributo `active` del estándar) y el panel de plataforma. Un booleano no
 *  puede expresar "bloqueado", así que false es siempre una baja. */
export function estadoDesdeActivo(activo: boolean): EstadoPerfil {
  return activo ? "activo" : "inactivo";
}

/** Cambia el estado de un perfil (0090).
 *
 *  `estado` reemplaza al booleano `activo` de antes -- el trigger mantiene los
 *  dos coherentes, así que quien todavía llame con un booleano sigue
 *  funcionando. Volver a 'activo' desde 'bloqueado' es el DESBLOQUEO: además
 *  de cambiar el estado hay que poner en cero los intentos fallidos, o la
 *  persona se vuelve a bloquear con el primer error. */
export async function cambiarEstadoUsuarioService(
  tenantId: string,
  usuarioId: string,
  estado: EstadoPerfil,
  motivo: string | undefined,
  contexto: ContextoAuditoria
): Promise<UsuarioListado> {
  const { fila, before } = await withTenant(tenantId, async (client) => {
    const anterior = await client.query(
      `SELECT estado FROM usuarios WHERE id = $1 AND tenant_id = $2`,
      [usuarioId, tenantId]
    );
    if (anterior.rows.length === 0) {
      throw new AppError(404, "Usuario no encontrado");
    }

    const actualizado = await client.query(
      // El cast explícito en cada uso: sin él Postgres deduce `text` por las
      // comparaciones y `estado_perfil` por la asignación, y se niega a
      // resolver el mismo parámetro con dos tipos.
      `UPDATE usuarios
          SET estado = $1::estado_perfil,
              intentos_fallidos = CASE WHEN $1::estado_perfil = 'activo' THEN 0 ELSE intentos_fallidos END,
              bloqueado_en = CASE WHEN $1::estado_perfil = 'bloqueado' THEN now() ELSE NULL END
        WHERE id = $2 AND tenant_id = $3
       RETURNING id, nombre, email, dni, rol, activo, estado, celular,
                 bloqueado_en AS "bloqueadoEn"`,
      [estado, usuarioId, tenantId]
    );

    return { fila: actualizado.rows[0], before: anterior.rows[0].estado };
  });

  if (estado !== "activo") {
    await revocarSesionesService(usuarioId, tenantId);
  }

  await registrarAuditoria({
    accion: "cambiar_estado_usuario",
    tenantId,
    usuarioId,
    detalle: { before: { estado: before }, after: { estado }, motivo: motivo ?? null },
    contexto,
  });

  return fila;
}

/** Borrado real, distinto de cambiarEstadoUsuarioService: solo tiene sentido
 *  para perfiles sin historial (de prueba, cargados de más, etc.). Si el
 *  usuario ya generó despachos, checklists, IPERC u órdenes, el DELETE
 *  revienta contra esa foreign key (varias de esas tablas referencian
 *  usuarios(id) SIN ON DELETE) y se lo devolvemos como un error entendible
 *  en vez del 500 crudo de Postgres — la salida para ese caso sigue siendo
 *  desactivar, nunca forzar el borrado. */
export async function eliminarUsuarioService(
  tenantId: string,
  usuarioId: string,
  motivo: string | undefined,
  contexto: ContextoAuditoria
): Promise<{ email: string | null; nombre: string }> {
  const usuario = await withTenant(tenantId, async (client) => {
    const anterior = await client.query(
      `SELECT nombre, email FROM usuarios WHERE id = $1 AND tenant_id = $2`,
      [usuarioId, tenantId]
    );
    if (anterior.rows.length === 0) {
      throw new AppError(404, "Usuario no encontrado");
    }

    try {
      await client.query(`DELETE FROM usuarios WHERE id = $1 AND tenant_id = $2`, [
        usuarioId,
        tenantId,
      ]);
    } catch (err) {
      if (esViolacionForeignKey(err)) {
        throw new AppError(
          409,
          "No se puede eliminar: el usuario tiene historial en el sistema (despachos, checklists, IPERC, órdenes, etc.). Desactivalo en su lugar."
        );
      }
      throw err;
    }

    return anterior.rows[0] as { nombre: string; email: string | null };
  });

  await revocarSesionesService(usuarioId, tenantId);

  await registrarAuditoria({
    accion: "eliminar_usuario",
    tenantId,
    usuarioId,
    detalle: { email: usuario.email, nombre: usuario.nombre, motivo: motivo ?? null },
    contexto,
  });

  return usuario;
}

/** Los datos de contacto del perfil. El nombre y el celular son de la empresa:
 *  el correo NO se edita acá, porque es la identidad de la persona y cambiarlo
 *  sería moverla de cuenta (ver §4 del documento de arquitectura). */
export async function actualizarPerfilUsuarioService(
  tenantId: string,
  usuarioId: string,
  cambios: { nombre?: string; celular?: string | null },
  contexto: ContextoAuditoria
): Promise<UsuarioListado> {
  const fila = await withTenant(tenantId, async (client) => {
    const actualizado = await client.query(
      `UPDATE usuarios
          SET nombre = COALESCE($1, nombre),
              celular = CASE WHEN $2::boolean THEN $3 ELSE celular END,
              actualizado_en = now()
        WHERE id = $4 AND tenant_id = $5
       RETURNING id, nombre, email, dni, rol, activo, estado, celular,
                 bloqueado_en AS "bloqueadoEn"`,
      [
        cambios.nombre ?? null,
        cambios.celular !== undefined,
        cambios.celular ?? null,
        usuarioId,
        tenantId,
      ]
    );
    if (actualizado.rows.length === 0) throw new AppError(404, "Usuario no encontrado");
    return actualizado.rows[0];
  });

  await registrarAuditoria({
    accion: "actualizar_usuario",
    tenantId,
    usuarioId,
    detalle: { nombre: cambios.nombre ?? null, celular: cambios.celular ?? null },
    contexto,
  });

  return fila;
}

export interface ModuloAsignado {
  modulo: string;
  asignado: boolean;
}

/** Asignación cruda a nivel de usuario (usuario_modulos), independiente de
 *  si el tenant tiene ese módulo habilitado o no — el efectivo en login es
 *  la intersección de ambos (ver obtenerModulosPermitidos en
 *  auth.service.ts). Separar los dos permite preasignarle módulos a un
 *  usuario antes de que el tenant los tenga habilitados. */
export async function obtenerModulosUsuarioService(
  tenantId: string,
  usuarioId: string
): Promise<ModuloAsignado[]> {
  if (!(await usuarioPerteneceATenant(tenantId, usuarioId))) {
    throw new AppError(404, "Usuario no encontrado");
  }

  const result = await pool.query(
    `SELECT m.modulo, (um.usuario_id IS NOT NULL) AS asignado
     FROM unnest(enum_range(NULL::modulo_erp)) AS m(modulo)
     LEFT JOIN usuario_modulos um ON um.usuario_id = $1 AND um.modulo = m.modulo
     ORDER BY m.modulo`,
    [usuarioId]
  );
  return result.rows;
}

export async function actualizarModulosUsuarioService(
  tenantId: string,
  usuarioId: string,
  modulos: string[],
  contexto: ContextoAuditoria
): Promise<ModuloAsignado[]> {
  if (!(await usuarioPerteneceATenant(tenantId, usuarioId))) {
    throw new AppError(404, "Usuario no encontrado");
  }

  await pool.query(`DELETE FROM usuario_modulos WHERE usuario_id = $1`, [usuarioId]);
  if (modulos.length > 0) {
    const placeholders = modulos.map((_, i) => `($1, $${i + 2})`).join(", ");
    await pool.query(`INSERT INTO usuario_modulos (usuario_id, modulo) VALUES ${placeholders}`, [
      usuarioId,
      ...modulos,
    ]);
  }

  await registrarAuditoria({
    accion: "actualizar_modulos_usuario",
    tenantId,
    usuarioId,
    detalle: { modulos },
    contexto,
  });

  return obtenerModulosUsuarioService(tenantId, usuarioId);
}
