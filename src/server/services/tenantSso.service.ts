/** src/server/services/tenantSso.service.ts
 *
 * SSO por tenant (OIDC) — cada empresa puede tener su propio IdP, a
 * diferencia del SSO de Platform Admin (un solo proveedor global, ver
 * platformAdminSso.service.ts). Dos responsabilidades separadas:
 *
 *  - Configuración (CRUD sobre tenant_sso_config): la usa el panel de
 *    plataforma. client_secret nunca se guarda ni se devuelve en texto
 *    plano — se cifra con platformCrypto.ts al guardar, y la lectura para
 *    el panel jamás lo descifra (no hay ningún caso de uso legítimo para
 *    mostrarlo de nuevo; si hace falta cambiarlo, se sobreescribe).
 *  - El flujo de login en sí (iniciar/callback), que termina resolviendo a
 *    un usuario YA EXISTENTE del tenant — igual que googleLoginService, NO
 *    hay auto-registro. La única diferencia de comportamiento respecto a
 *    Google es el *linking*: la primera vez que alguien entra por SSO, si
 *    todavía no tiene sso_subject guardado pero su email coincide con un
 *    usuario activo del tenant, se lo vincula ahí mismo (persistiendo
 *    sso_subject/sso_provider) — de ahí en adelante entra por sub, más
 *    robusto que el email si la persona lo cambia en el IdP más adelante.
 */
import { pool, withTenant } from "../config/database";
import { env } from "../config/env";
import { AppError } from "../shared/middlewares/error.middleware";
import { cifrar, descifrar } from "../shared/utils/platformCrypto";
import { registrarAuditoria, type ContextoAuditoria } from "./platformAudit.service";
import {
  resolverTenantParaRecuperacion,
  construirUrlTenant,
  obtenerModulosPermitidos,
  emitirSesionCompleta,
  type UsuarioPayload,
} from "./auth.service";
import {
  descubrirConfiguracion,
  construirUrlAutorizacion,
  intercambiarCodigoPorClaims,
  invalidarCacheConfiguracion,
  type ClaimsOidc,
} from "./platformOidc.service";
import { guardarFlujo, tomarFlujo } from "./platformSsoFlow.service";
import * as client from "openid-client";

// ── Configuración (panel de plataforma) ────────────────────────────────────

export interface TenantSsoConfigPublica {
  configurado: boolean;
  proveedor: "oidc" | "saml" | null;
  issuerUrl: string | null;
  clientId: string | null;
  dominioEmailPermitido: string | null;
  activo: boolean;
}

export async function obtenerConfigSsoTenantService(
  tenantId: string
): Promise<TenantSsoConfigPublica> {
  const result = await pool.query(
    `SELECT proveedor, issuer_url AS "issuerUrl", client_id AS "clientId",
            dominio_email_permitido AS "dominioEmailPermitido", activo
     FROM tenant_sso_config WHERE tenant_id = $1`,
    [tenantId]
  );
  const fila = result.rows[0];
  if (!fila) {
    return {
      configurado: false,
      proveedor: null,
      issuerUrl: null,
      clientId: null,
      dominioEmailPermitido: null,
      activo: false,
    };
  }
  return { configurado: true, ...fila };
}

export interface ConfigurarSsoTenantInput {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  dominioEmailPermitido?: string | null;
  activo: boolean;
}

/** Upsert completo — client_secret es obligatorio en cada llamada (nunca
 *  se "conserva" el anterior desde el panel: si el admin no lo tiene a
 *  mano, lo vuelve a pedir al IdP, más simple y más seguro que un flujo de
 *  "dejar en blanco para no cambiar" que invitaría a guardarlo en texto
 *  plano en algún lado mientras tanto). */
export async function configurarSsoTenantService(
  tenantId: string,
  input: ConfigurarSsoTenantInput,
  contexto: ContextoAuditoria
): Promise<TenantSsoConfigPublica> {
  const tenant = await pool.query(`SELECT id FROM tenants WHERE id = $1`, [tenantId]);
  if (tenant.rows.length === 0) throw new AppError(404, "Tenant no encontrado");

  const anterior = await pool.query(
    `SELECT issuer_url AS "issuerUrl", client_id AS "clientId" FROM tenant_sso_config WHERE tenant_id = $1`,
    [tenantId]
  );

  await pool.query(
    `INSERT INTO tenant_sso_config (tenant_id, issuer_url, client_id, client_secret_cifrado, dominio_email_permitido, activo, actualizado_en)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (tenant_id) DO UPDATE SET
       issuer_url = $2, client_id = $3, client_secret_cifrado = $4,
       dominio_email_permitido = $5, activo = $6, actualizado_en = now()`,
    [
      tenantId,
      input.issuerUrl,
      input.clientId,
      cifrar(input.clientSecret),
      input.dominioEmailPermitido ?? null,
      input.activo,
    ]
  );

  // Si ya había una config previa (issuer/client distintos), invalida la
  // config OIDC cacheada de esos valores viejos — sin esto, un cambio de
  // client_secret tardaría hasta TTL_CACHE_MS en tomar efecto real.
  if (anterior.rows[0]) {
    invalidarCacheConfiguracion(anterior.rows[0].issuerUrl, anterior.rows[0].clientId);
  }

  await registrarAuditoria({
    accion: "configurar_sso_tenant",
    tenantId,
    detalle: { issuerUrl: input.issuerUrl, clientId: input.clientId, activo: input.activo },
    contexto,
  });

  return obtenerConfigSsoTenantService(tenantId);
}

interface ConfigSsoInterna {
  issuerUrl: string;
  clientId: string;
  clientSecretCifrado: string;
  dominioEmailPermitido: string | null;
  activo: boolean;
}

async function obtenerConfigInterna(tenantId: string): Promise<ConfigSsoInterna | null> {
  const result = await pool.query(
    `SELECT issuer_url AS "issuerUrl", client_id AS "clientId", client_secret_cifrado AS "clientSecretCifrado",
            dominio_email_permitido AS "dominioEmailPermitido", activo
     FROM tenant_sso_config WHERE tenant_id = $1`,
    [tenantId]
  );
  return result.rows[0] ?? null;
}

// ── Disponibilidad (login del tenant) ──────────────────────────────────────

/** Lo único que el frontend de login puede saber ANTES de autenticarse:
 *  si mostrar o no el botón. Nunca expone issuer/client — eso solo importa
 *  server-side. */
export async function ssoDisponibleParaTenantService(tenantSlug: string): Promise<boolean> {
  const tenant = await resolverTenantParaRecuperacion(tenantSlug);
  if (!tenant) return false;
  const config = await obtenerConfigInterna(tenant.id);
  return !!config?.activo;
}

// ── El flujo en sí ──────────────────────────────────────────────────────────

function baseUrlCallback(): string {
  // Un solo callback central para TODOS los tenants (el `state` guardado
  // en Redis ya sabe a qué tenant pertenece) — cada IdP de cliente
  // registra esta misma URL exacta, sin importar el dominio propio que
  // ese tenant use para el login en sí; recién después del intercambio se
  // redirige al usuario a SU dominio (ver construirUrlTenant más abajo).
  return `${env.appPublicUrl}/api/auth/sso/callback`;
}

export interface InicioSso {
  redirectUrl: string;
}

export async function iniciarSsoTenantService(tenantSlug: string): Promise<InicioSso> {
  const tenant = await resolverTenantParaRecuperacion(tenantSlug);
  if (!tenant) throw new AppError(404, "Empresa no encontrada");

  const config = await obtenerConfigInterna(tenant.id);
  if (!config || !config.activo)
    throw new AppError(503, "El inicio de sesión SSO no está disponible para esta empresa");

  const oidcConfig = await descubrirConfiguracion(
    config.issuerUrl,
    config.clientId,
    descifrar(config.clientSecretCifrado)
  );

  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  const nonce = client.randomNonce();

  const state = await guardarFlujo({
    contexto: "tenant",
    tenantId: tenant.id,
    codeVerifier,
    nonce,
  });

  const url = construirUrlAutorizacion(oidcConfig, {
    redirectUri: baseUrlCallback(),
    state,
    nonce,
    codeChallenge,
  });

  return { redirectUrl: url.href };
}

/** Resuelve el `usuario` para la sesión a partir de claims YA verificados
 *  por el IdP — nunca crea uno nuevo (mismo criterio que googleLoginService).
 *  El linking por email solo pasa si el usuario encontrado TODAVÍA no tiene
 *  sso_subject de este proveedor (primera vez); de ahí en más, el match es
 *  siempre por (tenant_id, sso_provider, sso_subject), más robusto que el
 *  email ante un cambio de correo en el IdP. */
async function resolverUsuarioSso(
  tenantId: string,
  proveedor: string,
  dominioEmailPermitido: string | null,
  claims: ClaimsOidc
): Promise<UsuarioPayload> {
  if (!claims.email || !claims.emailVerificado) {
    throw new AppError(401, "Tu proveedor de identidad no confirma un email verificado");
  }
  if (dominioEmailPermitido && !claims.email.endsWith(`@${dominioEmailPermitido}`)) {
    throw new AppError(401, "Esta cuenta no pertenece al dominio autorizado para esta empresa");
  }

  const fila = await withTenant(tenantId, async (dbClient) => {
    const porSubject = await dbClient.query(
      `SELECT id, tenant_id, nombre, email, dni, rol, token_version, debe_cambiar_password
       FROM usuarios WHERE tenant_id = $1 AND sso_provider = $2 AND sso_subject = $3 AND activo = true`,
      [tenantId, proveedor, claims.sub]
    );
    if (porSubject.rows[0]) return porSubject.rows[0];

    // Sin match por subject todavía: intenta linkear por email, SOLO si
    // ese usuario no tiene ya otro sso_subject de este proveedor asignado
    // (evita pisar un linking previo por un email que cambió de dueño).
    const linkeado = await dbClient.query(
      `UPDATE usuarios SET sso_provider = $2, sso_subject = $3
       WHERE tenant_id = $1 AND email = $4 AND activo = true AND sso_provider IS NULL
       RETURNING id, tenant_id, nombre, email, rol, token_version, debe_cambiar_password`,
      [tenantId, proveedor, claims.sub, claims.email]
    );
    return linkeado.rows[0];
  });

  if (!fila) {
    throw new AppError(
      401,
      "Esta cuenta no tiene acceso a esta empresa — pedile a un admin que te dé de alta primero"
    );
  }

  return {
    id: fila.id,
    tenantId: fila.tenant_id,
    nombre: fila.nombre,
    email: fila.email,
    dni: fila.dni,
    rol: fila.rol,
    modulosPermitidos: await obtenerModulosPermitidos(fila.id, fila.tenant_id),
    tokenVersion: fila.token_version,
    debeCambiarPassword: fila.debe_cambiar_password,
  };
}

export interface ResultadoCallbackSso {
  token: string;
  refreshToken: string;
  usuario: UsuarioPayload;
  urlDestino: string;
}

export async function manejarCallbackSsoTenantService(
  state: string,
  currentUrl: URL,
  contexto: ContextoAuditoria
): Promise<ResultadoCallbackSso> {
  const flujo = await tomarFlujo(state);
  if (!flujo || flujo.contexto !== "tenant") {
    throw new AppError(401, "El enlace de inicio de sesión expiró o ya se usó — intentá de nuevo");
  }

  const tenant = await pool.query(
    `SELECT id, slug, dominio_personalizado AS "dominioPersonalizado" FROM tenants WHERE id = $1 AND activo = true`,
    [flujo.tenantId]
  );
  if (tenant.rows.length === 0) throw new AppError(404, "Empresa no encontrada");

  const config = await obtenerConfigInterna(flujo.tenantId);
  if (!config || !config.activo)
    throw new AppError(503, "El inicio de sesión SSO no está disponible para esta empresa");

  const oidcConfig = await descubrirConfiguracion(
    config.issuerUrl,
    config.clientId,
    descifrar(config.clientSecretCifrado)
  );

  let claims: ClaimsOidc;
  try {
    claims = await intercambiarCodigoPorClaims(oidcConfig, currentUrl, {
      codeVerifier: flujo.codeVerifier,
      state,
      nonce: flujo.nonce,
    });
  } catch (err) {
    await registrarAuditoria({
      accion: "sso_login_tenant",
      tenantId: flujo.tenantId,
      contexto,
      resultado: "failure",
      detalle: { motivo: err instanceof Error ? err.message : "error desconocido" },
    });
    throw err;
  }

  let usuario: UsuarioPayload;
  try {
    usuario = await resolverUsuarioSso(
      flujo.tenantId,
      "oidc",
      config.dominioEmailPermitido,
      claims
    );
  } catch (err) {
    await registrarAuditoria({
      accion: "sso_login_tenant",
      tenantId: flujo.tenantId,
      contexto,
      resultado: "failure",
      detalle: {
        motivo: err instanceof Error ? err.message : "error desconocido",
        subject: claims.sub,
      },
    });
    throw err;
  }

  const sesion = await emitirSesionCompleta(usuario);

  await registrarAuditoria({
    accion: "sso_login_tenant",
    tenantId: flujo.tenantId,
    usuarioId: usuario.id,
    contexto,
    detalle: { email: usuario.email },
  });

  return { ...sesion, urlDestino: construirUrlTenant(tenant.rows[0]) };
}
