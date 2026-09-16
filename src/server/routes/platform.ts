/** src/server/routes/platform.ts */

import { Router, type Request, type Response, type NextFunction } from "express";
import { timingSafeEqual } from "crypto";
import { ZodError, type ZodTypeAny } from "zod";
import { validate } from "../middleware/validate";
import rateLimiter from "../middleware/rateLimiter";
import platformTenantRateLimiter from "../middleware/platformTenantRateLimiter";
import platformAdminLoginRateLimiter from "../middleware/platformAdminLoginRateLimiter";
import { env } from "../config/env";
import { getRedis } from "../config/redis";
import {
  platformAdminMiddleware,
  PLATFORM_SESSION_COOKIE,
} from "../shared/middlewares/platformAdmin.middleware";
import { platformSuperAdminMiddleware } from "../shared/middlewares/platformSuperAdmin.middleware";
import { AppError } from "../shared/middlewares/error.middleware";
import {
  getClientIp,
  getRequestId,
  getUserAgent,
  getPlatformSessionId,
  getPlatformActor,
} from "../shared/utils/request";
import {
  crearSesion,
  revocarSesion,
  idSesionDeCookie,
  cookieDeSesion,
  obtenerSesion,
  listarSesionesDeAdmin,
  type ActorSesion,
} from "../services/platformSession.service";
import {
  consultarIdempotencia,
  liberarIdempotencia,
} from "../services/platformIdempotency.service";
import { buscarRespuestaPorClave } from "../services/platformOutbox.service";
import {
  reponerEventosPlataforma,
  suscribirCanal,
  publicarEventoPlataforma,
  CANAL_EVENTOS_PLATAFORMA,
} from "../services/realtimeEvents.service";
import { manejarConexionSSE } from "../shared/utils/sse";
import "../services/platformOutbox.worker"; // se activa solo con importarse (setInterval + .unref())
import "../services/platformAuditRetention.worker"; // ídem — deshabilitado si PLATFORM_AUDIT_RETENTION_DAYS no está seteado
import "../services/eventosTiempoRealRetention.worker"; // ídem — encendido por default (ver env.eventosTiempoRealRetentionMinutes)
import "../services/platformBackupRetention.worker"; // ídem — deshabilitado si las dos BACKUP_RETENTION_* no están seteadas
import "../services/particionado.worker"; // ídem — aprovisiona particiones futuras de checklists/ipercs (migración 0037)
import "../services/platformBackupDrill.worker"; // ídem — restore drill básico, siempre activo (es de solo lectura)
import "../services/platformBackupWriteDrill.worker"; // ídem — restore drill de escritura, deshabilitado si BACKUP_WRITE_DRILL_ENABLED no está en "true"
import {
  crearTenantSchema,
  onboardTenantSchema,
  cambiarEstadoTenantSchema,
  actualizarModulosSchema,
  actualizarModulosTenantSchema,
  actualizarModuloGlobalSchema,
  MODULOS_ERP,
  crearUsuarioEnTenantSchema,
  reemplazarAdminSchema,
  cambiarEstadoCuentaSchema,
  type ReemplazarAdminInput,
  type CambiarEstadoCuentaInput,
  cambiarEstadoUsuarioSchema,
  actualizarDominioSchema,
  platformSesionSchema,
  platformAdminLoginSchema,
  crearPlatformAdminSchema,
  cambiarEstadoPlatformAdminSchema,
  cambiarMiPasswordSchema,
  restaurarBackupSchema,
  restaurarBackupPlataformaSchema,
  fijarCuotaTenantSchema,
  asignarPlanTenantSchema,
  crearSuscripcionSchema,
  cambiarPlanSuscripcionSchema,
  extenderGraciaSchema,
  motivoOpcionalSchema,
  registrarCobroImplementacionSchema,
  iniciarCortesiaSchema,
  editarCobroSchema,
  registrarPagoCobroSchema,
  actualizarTipoCambioSchema,
  actualizarTipoCambioOverrideSchema,
  type ActualizarModuloGlobalInput,
  type CrearSuscripcionInput,
  type RegistrarCobroImplementacionInput,
  type IniciarCortesiaInput,
  type EditarCobroInput,
  type RegistrarPagoCobroInput,
  type ActualizarTipoCambioInput,
  type ActualizarTipoCambioOverrideInput,
  type CrearTenantInput,
  type OnboardTenantInput,
  type CrearUsuarioEnTenantInput,
} from "../schemas/platform.schema";
import {
  crearTenantConAdminService,
  cambiarEstadoTenantService,
  listarTenantsService,
  obtenerModulosTenantService,
  actualizarModulosTenantService,
  actualizarModuloGlobalService,
  listarUsuariosTenantService,
  crearUsuarioEnTenantService,
  cambiarEstadoUsuarioService,
  estadoDesdeActivo,
  reemplazarAdminService,
  cambiarEstadoCuentaService,
  obtenerModulosUsuarioService,
  actualizarModulosUsuarioService,
  type ConfiguracionModulo,
} from "../services/platform.service";
import { onboardTenantService } from "../services/tenantOnboardingService";
import {
  asignarDominioTenantService,
  verificarDominioService,
  obtenerDominioTenantService,
} from "../services/platformDomain.service";
import {
  obtenerSaludTenantService,
  obtenerSaludTodosLosTenantsService,
} from "../services/platformTenantHealth.service";
import {
  exportarTenantService,
  listarBackupsTenantService,
  restaurarBackupService,
} from "../services/platformBackup.service";
import { resumenCuotasTenant, fijarCuotaTenant } from "../services/platformCuotas.service";
import {
  resolverRateLimitTenant,
  sugerirRateLimitTenant,
  RECURSO_RATE_LIMIT,
} from "../services/platformRateLimitCuota";
import {
  listarPlanesService,
  obtenerPlanService,
  obtenerPlanDeTenantService,
  asignarPlanATenantService,
} from "../services/platformPlanes.service";
import {
  obtenerSuscripcionTenantService,
  crearSuscripcionService,
  cambiarPlanSuscripcionService,
  extenderGraciaService,
  cancelarSuscripcionService,
  reactivarSuscripcionService,
  forzarCobroService,
  crearMetodoPagoPruebaService,
  registrarCobroImplementacionService,
  marcarCobroPagadoService,
  iniciarCortesiaService,
  iniciarFacturacionService,
  editarCobroService,
  eliminarCobroService,
  eliminarSuscripcionService,
  actualizarTipoCambioOverrideSuscripcionService,
  registrarPagoCobroService,
  obtenerAlertasBillingService,
} from "../services/platformBilling.service";
import {
  obtenerTipoCambioActualService,
  actualizarTipoCambioService,
  actualizarTipoCambioDesdeBcrpService,
} from "../services/platformTipoCambio.service";
import { procesarVencimientosService } from "../services/platformBillingVencimientos.service";
import { obtenerPasarelaPago } from "../services/pasarelaPago";
import {
  exportarPlataformaService,
  listarBackupsPlataformaService,
  restaurarBackupPlataformaService,
} from "../services/platformBackupPlataforma.service";
import {
  verificarCredencialesPlatformAdminService,
  listarPlatformAdminsService,
  crearPlatformAdminService,
  cambiarEstadoPlatformAdminService,
  cambiarMiPasswordService,
  obtenerPlatformAdminService,
  esSuperAdminVigente,
} from "../services/platformAdminAccount.service";
import {
  ssoDisponibleParaPlatformAdmin,
  iniciarSsoPlatformAdminService,
  manejarCallbackSsoPlatformAdminService,
} from "../services/platformAdminSso.service";
import {
  obtenerConfigSsoTenantService,
  configurarSsoTenantService,
} from "../services/tenantSso.service";
import {
  obtenerConfigScimService,
  generarTokenScimService,
  revocarTokenScimService,
} from "../services/platformScim.service";
import {
  configurarSsoTenantSchema,
  type ConfigurarSsoTenantInput,
} from "../schemas/platform.schema";
import {
  listarAuditoriaService,
  registrarAuditoria,
  type ContextoAuditoria,
  type ResultadoAuditoria,
} from "../services/platformAudit.service";
import { asyncHandler } from "../shared/utils/asyncHandler";

/** Arma el contexto de auditoría a partir del request — si no hay actor
 *  resuelto (rutas de login/logout, que corren antes de
 *  platformAdminMiddleware) cae en "unauthenticated", que es exactamente
 *  lo correcto para sus ramas de fallo; las rutas que sí conocen el actor
 *  recién resuelto (login exitoso) lo pisan explícitamente — ver
 *  actorAContexto(). */
function contextoDe(req: Request): ContextoAuditoria {
  const actor = getPlatformActor(req);
  return {
    ip: getClientIp(req),
    requestId: getRequestId(req),
    userAgent: getUserAgent(req),
    sessionId: getPlatformSessionId(req),
    actorType: actor?.actorType ?? "unauthenticated",
    actorId: actor?.actorType === "platform_admin" ? actor.actorId : undefined,
    actorLabel: actor?.actorLabel ?? "sin_credencial",
  };
}

function actorAContexto(
  actor: ActorSesion | undefined
): Pick<ContextoAuditoria, "actorType" | "actorId" | "actorLabel"> {
  if (!actor) return { actorType: "unauthenticated", actorLabel: "sin_credencial" };
  if (actor.actorType === "platform_admin") {
    return { actorType: "platform_admin", actorId: actor.actorId, actorLabel: actor.actorLabel };
  }
  return { actorType: "emergency_shared_secret", actorLabel: actor.actorLabel };
}

function tokensCoinciden(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Igual que `validate()` (middleware/validate.ts), pero además audita el
 *  rechazo — acá y no en el middleware genérico, porque solo tiene sentido
 *  para las mutaciones ya auditadas en éxito (crear_tenant, crear_usuario,
 *  cambiar_estado_tenant, cambiar_estado_usuario, crear_platform_admin,
 *  cambiar_estado_platform_admin); el resto de la app usa `validate()` sin
 *  tocar platform_audit_log. */
function validarConAuditoria(
  schema: ZodTypeAny,
  accion: string,
  resolverIds: (req: Request) => {
    tenantId?: string | null;
    usuarioId?: string | null;
  } = () => ({})
) {
  return asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      req.validatedBody = await schema.parseAsync(req.body);
      next();
    } catch (error: unknown) {
      if (error instanceof ZodError) {
        const errors = error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        }));
        const { tenantId, usuarioId } = resolverIds(req);

        await registrarAuditoria({
          accion,
          tenantId,
          usuarioId,
          detalle: { errores: errors },
          contexto: contextoDe(req),
          resultado: "failure",
        });

        if (req.log) {
          req.log.warn({ errors }, "Datos invalidos en formulario de plataforma");
        } else {
          console.warn("Datos invalidos en formulario de plataforma", { errors });
        }

        return res.status(400).json({ errors });
      }

      if (req.log) {
        req.log.error({ err: error }, "Error inesperado validando formulario de plataforma");
      } else {
        console.error("Error inesperado validando formulario de plataforma", error);
      }

      return res.status(500).json({ message: "Error interno validando formulario" });
    }
  });
}

export function createPlatformRouter() {
  const router = Router();

  // Sin platformAdminMiddleware a propósito: son las rutas que ESTABLECEN
  // la cookie que ese middleware después va a aceptar.
  router.post(
    "/sesion",
    rateLimiter,
    validate(platformSesionSchema),
    asyncHandler(async (req, res) => {
      const { token } = req.validatedBody as { token: string };

      if (!env.platformAdminToken || !tokensCoinciden(token, env.platformAdminToken)) {
        await registrarAuditoria({
          accion: "platform.session.started",
          contexto: contextoDe(req),
          resultado: "failure",
        });
        return res.status(401).json({ ok: false, message: "Token inválido" });
      }

      const actor: ActorSesion = {
        actorType: "emergency_shared_secret",
        actorLabel: "secreto-compartido",
      };
      // sessionId es null si Redis no está disponible — en ese caso la
      // cookie cae al formato legado (token crudo), sin sesión revocable
      // individualmente (ver platformSession.service.ts).
      const sessionId = await crearSesion(getClientIp(req), actor);
      const valorCookie = sessionId ? cookieDeSesion(sessionId) : token;

      // httpOnly a propósito: esta credencial puede tocar todos los tenants
      // a la vez — nunca debe quedar en sessionStorage/localStorage legible
      // por JS (un XSS en la página se lo robaría directo). path acotado a
      // /api/platform: nunca se manda a las rutas de negocio de un tenant.
      res.cookie(PLATFORM_SESSION_COOKIE, valorCookie, {
        httpOnly: true,
        secure: env.isProduction,
        sameSite: "strict",
        path: "/api/platform",
        maxAge: env.platformSessionTtlMs,
      });

      await registrarAuditoria({
        accion: "platform.session.started",
        contexto: {
          ...contextoDe(req),
          sessionId: sessionId ?? undefined,
          ...actorAContexto(actor),
        },
        detalle: sessionId ? undefined : { advertencia: "sin_redis_sesion_no_revocable" },
      });

      res.status(200).json({ ok: true });
    })
  );

  // Login individual de un Platform Admin (email + password) — el "modo
  // preferido" desde que existen cuentas individuales (migrations/
  // 0016_platform_admins.sql). A diferencia de /sesion no tiene fallback
  // sin Redis: no hay equivalente razonable a "cookie = token crudo" para
  // una contraseña, así que si Redis no está arriba se le pide a quien
  // intenta entrar que use el acceso de emergencia mientras tanto.
  router.post(
    "/admin-sesion",
    rateLimiter,
    platformAdminLoginRateLimiter,
    validate(platformAdminLoginSchema),
    asyncHandler(async (req, res) => {
      const { email, password } = req.validatedBody as { email: string; password: string };

      if (!getRedis()) {
        return res.status(503).json({
          ok: false,
          message:
            "Inicio de sesión individual no disponible ahora mismo — usá el acceso de emergencia",
        });
      }

      const admin = await verificarCredencialesPlatformAdminService(email, password);
      if (!admin) {
        await registrarAuditoria({
          accion: "platform.session.started",
          contexto: contextoDe(req),
          resultado: "failure",
          detalle: { via: "admin" },
        });
        return res.status(401).json({ ok: false, message: "Credenciales inválidas" });
      }

      const actor: ActorSesion = {
        actorType: "platform_admin",
        actorId: admin.id,
        actorLabel: admin.email,
      };
      const sessionId = await crearSesion(getClientIp(req), actor);
      if (!sessionId) {
        // Redis falló justo entre el chequeo de arriba y acá — ventana
        // chica, pero sin fallback legado posible para un admin individual.
        return res
          .status(503)
          .json({ ok: false, message: "No se pudo iniciar sesión — intentá de nuevo" });
      }

      res.cookie(PLATFORM_SESSION_COOKIE, cookieDeSesion(sessionId), {
        httpOnly: true,
        secure: env.isProduction,
        sameSite: "strict",
        path: "/api/platform",
        maxAge: env.platformSessionTtlMs,
      });

      await registrarAuditoria({
        accion: "platform.session.started",
        contexto: { ...contextoDe(req), sessionId, ...actorAContexto(actor) },
      });

      res.status(200).json({ ok: true });
    })
  );

  // ── SSO de Platform Admin (proveedor único global, ver env PLATFORM_SSO_*) ──
  // Mismo criterio que /sesion y /admin-sesion: corren ANTES de
  // platformAdminMiddleware porque son ellas mismas las que establecen la
  // cookie que ese middleware después va a aceptar.
  router.get("/sso/disponible", (_req, res) => {
    res.status(200).json({ ok: true, disponible: ssoDisponibleParaPlatformAdmin() });
  });

  router.get(
    "/sso/iniciar",
    rateLimiter,
    asyncHandler(async (_req, res, next) => {
      try {
        const { redirectUrl } = await iniciarSsoPlatformAdminService();
        res.redirect(redirectUrl);
      } catch (err) {
        next(err);
      }
    })
  );

  router.get(
    "/sso/callback",
    rateLimiter,
    asyncHandler(async (req, res) => {
      try {
        const state = typeof req.query.state === "string" ? req.query.state : "";
        const currentUrl = new URL(`${req.protocol}://${req.get("host")}${req.originalUrl}`);
        const { admin } = await manejarCallbackSsoPlatformAdminService(state, currentUrl);

        const actor: ActorSesion = {
          actorType: "platform_admin",
          actorId: admin.id,
          actorLabel: admin.email,
        };
        const sessionId = await crearSesion(getClientIp(req), actor);
        if (!sessionId) {
          return res.redirect(
            `${env.appPublicUrl}/plataforma?ssoError=${encodeURIComponent("No se pudo iniciar sesión")}`
          );
        }

        res.cookie(PLATFORM_SESSION_COOKIE, cookieDeSesion(sessionId), {
          httpOnly: true,
          secure: env.isProduction,
          sameSite: "strict",
          path: "/api/platform",
          maxAge: env.platformSessionTtlMs,
        });

        await registrarAuditoria({
          accion: "platform.session.started",
          contexto: { ...contextoDe(req), sessionId, ...actorAContexto(actor) },
          detalle: { via: "sso" },
        });

        res.redirect(`${env.appPublicUrl}/plataforma`);
      } catch (err) {
        const mensaje = err instanceof Error ? err.message : "No se pudo iniciar sesión con SSO";
        res.redirect(`${env.appPublicUrl}/plataforma?ssoError=${encodeURIComponent(mensaje)}`);
      }
    })
  );

  router.post(
    "/sesion/salir",
    asyncHandler(async (req, res) => {
      const cookieValue = (req as Request & { cookies?: Record<string, string> }).cookies?.[
        PLATFORM_SESSION_COOKIE
      ];
      const sessionId = cookieValue ? idSesionDeCookie(cookieValue) : null;

      let actor: ActorSesion | undefined;
      if (sessionId) {
        actor = (await obtenerSesion(sessionId))?.actor;
        await revocarSesion(sessionId);
      } else if (cookieValue) {
        // Formato legado (cookie = token crudo): solo el secreto compartido
        // usaba esa forma.
        actor = { actorType: "emergency_shared_secret", actorLabel: "secreto-compartido" };
      }

      res.clearCookie(PLATFORM_SESSION_COOKIE, { path: "/api/platform" });
      await registrarAuditoria({
        accion: "platform.session.ended",
        contexto: {
          ...contextoDe(req),
          sessionId: sessionId ?? undefined,
          ...actorAContexto(actor),
        },
      });
      res.status(200).json({ ok: true });
    })
  );

  router.use(rateLimiter, platformAdminMiddleware);

  // "¿Quién soy?" — la UI lo usa para decidir si mostrar la sección de
  // administración de otros Platform Admin (solo super_admin/emergencia).
  router.get(
    "/whoami",
    asyncHandler(async (req, res) => {
      const actor = getPlatformActor(req);
      const admin =
        actor?.actorType === "platform_admin"
          ? await obtenerPlatformAdminService(actor.actorId)
          : null;
      res.status(200).json({
        ok: true,
        actorType: actor?.actorType ?? "unauthenticated",
        actorLabel: actor?.actorLabel ?? null,
        esSuperAdmin: await esSuperAdminVigente(actor),
        debeCambiarPassword: admin?.debeCambiarPassword ?? false,
      });
    })
  );

  // Cambiar la propia contraseña -- pensado para la pantalla obligatoria
  // del primer login con clave temporal (ver debeCambiarPassword de
  // arriba), pero sirve para cualquier cambio voluntario después. Solo
  // tiene sentido para una cuenta individual: el secreto compartido no
  // tiene "su propia" contraseña que cambiar.
  router.post(
    "/mi-password",
    validate(cambiarMiPasswordSchema),
    asyncHandler(async (req, res, next) => {
      try {
        const actor = getPlatformActor(req);
        if (actor?.actorType !== "platform_admin") {
          throw new AppError(400, "El acceso de emergencia no tiene una contraseña propia");
        }
        const { passwordActual, passwordNueva } = req.validatedBody as {
          passwordActual: string;
          passwordNueva: string;
        };
        await cambiarMiPasswordService(actor.actorId, passwordActual, passwordNueva);
        res.status(200).json({ ok: true });
      } catch (err) {
        next(err);
      }
    })
  );

  // Tiempo real del panel de plataforma (cuotas, backups, dominio, etc.)
  // -- ver realtimeEvents.service.ts. Emiten los endpoints de estado de
  // tenant de acá para abajo (publicarEventoPlataforma) -- deliberadamente
  // NO los de sesión/cuenta de Platform Admin (ya cubiertos por
  // platform_audit_log, no son "visibilidad operativa del negocio").
  router.get(
    "/eventos/stream",
    asyncHandler(async (req, res) => {
      await manejarConexionSSE(req, res, {
        canal: CANAL_EVENTOS_PLATAFORMA,
        reponer: reponerEventosPlataforma,
        suscribir: suscribirCanal,
      });
    })
  );

  // Revoca una sesión de login puntual (por su session_id, visible en la
  // propia auditoría) sin tener que rotar PLATFORM_ADMIN_TOKEN ni
  // desactivar la cuenta entera — pensado para el caso "esta sesión del
  // panel se vio comprometida". Requiere volver a autenticarse (bearer o
  // cookie válida) para revocar, como cualquier otra acción de acá para
  // abajo.
  router.post(
    "/sesiones/:sessionId/revocar",
    asyncHandler(async (req, res, next) => {
      try {
        const revocada = await revocarSesion(req.params.sessionId);
        await registrarAuditoria({
          accion: "platform.session.revocada",
          contexto: contextoDe(req),
          detalle: { sessionId: req.params.sessionId, revocada },
        });
        res.status(200).json({ ok: true, revocada });
      } catch (err) {
        next(err);
      }
    })
  );

  // ── Gestión de otras cuentas de Platform Admin (solo super_admin) ──────
  router.get(
    "/admins",
    platformSuperAdminMiddleware,
    asyncHandler(async (req, res, next) => {
      try {
        const admins = await listarPlatformAdminsService();
        res.status(200).json({ ok: true, admins });
      } catch (err) {
        next(err);
      }
    })
  );

  router.post(
    "/admins",
    platformSuperAdminMiddleware,
    validarConAuditoria(crearPlatformAdminSchema, "crear_platform_admin"),
    asyncHandler(async (req, res, next) => {
      try {
        const input = req.validatedBody as {
          email: string;
          password: string;
          nombre: string;
          rol: "super_admin" | "admin";
        };
        const admin = await crearPlatformAdminService(input);
        await registrarAuditoria({
          accion: "crear_platform_admin",
          contexto: contextoDe(req),
          detalle: { email: admin.email, nombre: admin.nombre, rol: admin.rol },
        });
        res.status(201).json({ ok: true, admin });
      } catch (err) {
        next(err);
      }
    })
  );

  // Sesiones activas de un admin puntual — para poder revocar una sola
  // (ver POST /sesiones/:sessionId/revocar) sin desactivar la cuenta entera.
  router.get(
    "/admins/:id/sesiones",
    platformSuperAdminMiddleware,
    asyncHandler(async (req, res, next) => {
      try {
        const sesiones = await listarSesionesDeAdmin(req.params.id);
        res.status(200).json({ ok: true, sesiones });
      } catch (err) {
        next(err);
      }
    })
  );

  router.patch(
    "/admins/:id/estado",
    platformSuperAdminMiddleware,
    validarConAuditoria(cambiarEstadoPlatformAdminSchema, "cambiar_estado_platform_admin"),
    asyncHandler(async (req, res, next) => {
      try {
        const actor = getPlatformActor(req);
        const { activo, motivo } = req.validatedBody as { activo: boolean; motivo?: string };

        if (actor?.actorType === "platform_admin" && actor.actorId === req.params.id && !activo) {
          return res.status(400).json({ ok: false, message: "No podés desactivarte a vos mismo" });
        }

        const { admin, before } = await cambiarEstadoPlatformAdminService(req.params.id, activo);
        await registrarAuditoria({
          accion: "cambiar_estado_platform_admin",
          contexto: contextoDe(req),
          detalle: {
            before: { activo: before },
            after: { activo },
            motivo: motivo ?? null,
            email: admin.email,
          },
        });
        res.status(200).json({ ok: true, admin });
      } catch (err) {
        next(err);
      }
    })
  );

  router.get(
    "/tenants",
    asyncHandler(async (req, res, next) => {
      try {
        const tenants = await listarTenantsService();
        res.status(200).json({ ok: true, tenants });
      } catch (err) {
        next(err);
      }
    })
  );

  // Resumen de salud de todos los tenants — antes de /tenants/:id/salud
  // a propósito (aunque Express no los confunde, distinta cantidad de
  // segmentos): así queda junto al resto de las rutas "de lista".
  router.get(
    "/tenants/salud",
    asyncHandler(async (req, res, next) => {
      try {
        const salud = await obtenerSaludTodosLosTenantsService();
        res.status(200).json({ ok: true, salud });
      } catch (err) {
        next(err);
      }
    })
  );

  router.get(
    "/tenants/:id/salud",
    asyncHandler(async (req, res, next) => {
      try {
        const salud = await obtenerSaludTenantService(req.params.id);
        res.status(200).json({ ok: true, salud });
      } catch (err) {
        next(err);
      }
    })
  );

  router.get(
    "/tenants/:id/backups",
    asyncHandler(async (req, res, next) => {
      try {
        const backups = await listarBackupsTenantService(req.params.id);
        res.status(200).json({ ok: true, backups });
      } catch (err) {
        next(err);
      }
    })
  );

  router.post(
    "/tenants/:id/backups",
    asyncHandler(async (req, res, next) => {
      try {
        const backup = await exportarTenantService(req.params.id, contextoDe(req));
        await publicarEventoPlataforma("tenant.backup_creado", {
          tenantId: req.params.id,
          backupId: backup.id,
        });
        res.status(201).json({ ok: true, backup });
      } catch (err) {
        next(err);
      }
    })
  );

  // Destructivo (vacía el tenant destino antes de restaurar) — gateado a
  // super_admin/emergencia, mismo criterio que el toggle global de
  // módulos. confirmar:true es obligatorio en el body (ver
  // restaurarBackupSchema), no alcanza con estar autenticado.
  router.post(
    "/backups/:backupId/restaurar",
    platformSuperAdminMiddleware,
    validate(restaurarBackupSchema),
    asyncHandler(async (req, res, next) => {
      try {
        const { targetTenantId } = req.validatedBody as { targetTenantId: string; confirmar: true };
        const resultado = await restaurarBackupService(
          req.params.backupId,
          targetTenantId,
          contextoDe(req)
        );
        await publicarEventoPlataforma("tenant.backup_restaurado", {
          backupId: req.params.backupId,
          targetTenantId,
        });
        res.status(200).json({ ok: true, ...resultado });
      } catch (err) {
        next(err);
      }
    })
  );

  // ── Planes ────────────────────────────────────────────────────────────
  // Ver docs/architecture/cuotas-por-tenant.md. Un plan es un conjunto con
  // nombre de límites por recurso; el escalón intermedio entre la excepción
  // puntual de un tenant y el default global del registry.

  router.get(
    "/planes",
    asyncHandler(async (req, res, next) => {
      try {
        // ?soloActivos=true para el selector del panel: un plan dado de baja
        // no debe ofrecerse para asignar, pero sí seguir siendo visible en el
        // listado completo (los tenants que ya lo tienen lo conservan).
        const planes = await listarPlanesService(req.query.soloActivos === "true");
        res.status(200).json({ ok: true, planes });
      } catch (err) {
        next(err);
      }
    })
  );

  router.get(
    "/planes/:idOCodigo",
    asyncHandler(async (req, res, next) => {
      try {
        res.status(200).json({ ok: true, plan: await obtenerPlanService(req.params.idOCodigo) });
      } catch (err) {
        next(err);
      }
    })
  );

  router.get(
    "/tenants/:id/plan",
    asyncHandler(async (req, res, next) => {
      try {
        res.status(200).json({ ok: true, plan: await obtenerPlanDeTenantService(req.params.id) });
      } catch (err) {
        next(err);
      }
    })
  );

  // super_admin, mismo criterio que el ajuste de cuotas: cambia lo que un
  // cliente puede consumir. La respuesta incluye `recursosExcedidos` para
  // que el panel advierta EN EL MOMENTO si bajar de plan dejó al tenant por
  // encima de sus nuevos topes — no se borra nada, pero deja de poder crear.
  router.put(
    "/tenants/:id/plan",
    platformSuperAdminMiddleware,
    validate(asignarPlanTenantSchema),
    asyncHandler(async (req, res, next) => {
      try {
        const { plan, motivo } = req.validatedBody as { plan: string | null; motivo?: string };
        const resultado = await asignarPlanATenantService(
          req.params.id,
          plan,
          contextoDe(req),
          motivo
        );
        await publicarEventoPlataforma("tenant.plan_cambiado", { tenantId: req.params.id, plan });
        res.status(200).json({ ok: true, ...resultado });
      } catch (err) {
        next(err);
      }
    })
  );

  // ── Cuotas por tenant ─────────────────────────────────────────────────
  // Ver docs/architecture/cuotas-por-tenant.md. El GET devuelve uso Y
  // límite juntos a propósito: el límite solo se puede interpretar contra
  // el consumo real, y pedirlos por separado invitaría a mostrar uno sin
  // el otro.

  router.get(
    "/tenants/:id/cuotas",
    asyncHandler(async (req, res, next) => {
      try {
        // El rate limit va SEPARADO de `cuotas` a propósito: es un ritmo
        // (req/min), no un acumulado, y meterlo en la misma tabla obligaría a
        // inventar un valor de "uso" que no significa nada. Se devuelve con su
        // sugerencia y los datos que la justifican, para que quien lo configure
        // decida mirando el tráfico real y no adivinando.
        const [cuotas, rateLimitRpm, sugerencia] = await Promise.all([
          resumenCuotasTenant(req.params.id),
          resolverRateLimitTenant(req.params.id),
          sugerirRateLimitTenant(req.params.id),
        ]);

        res.status(200).json({
          ok: true,
          cuotas,
          rateLimit: {
            recurso: RECURSO_RATE_LIMIT,
            limiteRpm: rateLimitRpm, // null = sin techo
            ...sugerencia,
          },
        });
      } catch (err) {
        next(err);
      }
    })
  );

  // Subirle la cuota a UN cliente es una decisión comercial puntual; subir
  // el default de TODOS es cambiar el registry y desplegar (ver la
  // migración 0033). Va a super_admin por el mismo criterio que el toggle
  // global de módulos: cambia lo que un cliente puede consumir.
  router.put(
    "/tenants/:id/cuotas",
    platformSuperAdminMiddleware,
    validate(fijarCuotaTenantSchema),
    asyncHandler(async (req, res, next) => {
      try {
        const { recurso, limite, motivo } = req.validatedBody as {
          recurso: string;
          limite?: number | null;
          motivo?: string;
        };
        // `limite` ausente en el body = borrar el override. Se distingue de
        // `limite: null` (ilimitado) mirando la clave, no el valor.
        const nuevoLimite = "limite" in (req.validatedBody as object) ? limite : undefined;

        await fijarCuotaTenant(req.params.id, recurso, nuevoLimite, motivo);

        await registrarAuditoria({
          accion: "actualizar_cuota_tenant",
          tenantId: req.params.id,
          detalle: {
            recurso,
            limite: nuevoLimite === undefined ? "(default)" : nuevoLimite,
            motivo: motivo ?? null,
          },
          contexto: contextoDe(req),
        });

        await publicarEventoPlataforma("tenant.cuota_actualizada", {
          tenantId: req.params.id,
          recurso,
          limite: nuevoLimite === undefined ? null : nuevoLimite,
        });

        const cuotas = await resumenCuotasTenant(req.params.id);
        res.status(200).json({ ok: true, cuotas });
      } catch (err) {
        next(err);
      }
    })
  );

  // ── Suscripción / billing (migración 0041) ────────────────────────────
  // Todas las mutaciones van a super_admin: mismo criterio que cuotas/plan
  // (cambian lo que un cliente paga o puede consumir), acá con dinero real
  // de por medio. La lectura queda abierta a cualquier platform admin.

  // Le permite a la UI mostrar el botón de "Agregar método de pago de
  // prueba" (ver crearMetodoPagoPruebaService) solo cuando corresponde --
  // esa ruta ya se autoprotege igual, esto es nomás para no ofrecer un
  // botón que va a terminar en 400.
  router.get(
    "/billing/pasarela",
    asyncHandler(async (_req, res, next) => {
      try {
        res.status(200).json({ ok: true, nombre: obtenerPasarelaPago().nombre });
      } catch (err) {
        next(err);
      }
    })
  );

  // Vencidas/fallidas/próximas de TODOS los tenants en un solo query -- ver
  // obtenerAlertasBillingService. Lectura, sin super_admin (mismo criterio
  // que el resto de las lecturas de este bloque).
  router.get(
    "/billing/alertas",
    asyncHandler(async (_req, res, next) => {
      try {
        const alertas = await obtenerAlertasBillingService();
        res.status(200).json({ ok: true, alertas });
      } catch (err) {
        next(err);
      }
    })
  );

  // Tipo de cambio USD -> PEN, global de plataforma (migración 0053) --
  // dato de mercado compartido por todos los tenants, no algo por tenant.
  // Lectura abierta a cualquier platform admin; actualizarlo va a
  // super_admin (afecta el monto que se cobra a TODOS los tenants con
  // tarjeta, no solo a uno).
  router.get(
    "/billing/tipo-cambio",
    asyncHandler(async (_req, res, next) => {
      try {
        const tipoCambio = await obtenerTipoCambioActualService();
        res.status(200).json({ ok: true, tipoCambio });
      } catch (err) {
        next(err);
      }
    })
  );

  router.put(
    "/billing/tipo-cambio",
    platformSuperAdminMiddleware,
    validarConAuditoria(actualizarTipoCambioSchema, "billing.actualizar_tipo_cambio"),
    asyncHandler(async (req, res, next) => {
      try {
        const { valor } = req.validatedBody as ActualizarTipoCambioInput;
        const tipoCambio = await actualizarTipoCambioService(valor, contextoDe(req));
        res.status(200).json({ ok: true, tipoCambio });
      } catch (err) {
        next(err);
      }
    })
  );

  router.get(
    "/tenants/:id/suscripcion",
    asyncHandler(async (req, res, next) => {
      try {
        const estado = await obtenerSuscripcionTenantService(req.params.id);
        res.status(200).json({ ok: true, suscripcion: estado });
      } catch (err) {
        next(err);
      }
    })
  );

  router.post(
    "/tenants/:id/suscripcion",
    platformSuperAdminMiddleware,
    validarConAuditoria(crearSuscripcionSchema, "billing.crear_suscripcion", (req) => ({
      tenantId: req.params.id,
    })),
    asyncHandler(async (req, res, next) => {
      try {
        const estado = await crearSuscripcionService(
          req.params.id,
          req.validatedBody as CrearSuscripcionInput,
          contextoDe(req)
        );
        res.status(201).json({ ok: true, suscripcion: estado });
      } catch (err) {
        next(err);
      }
    })
  );

  // Borra la suscripción por completo -- distinto de cancelar (ver el
  // comentario de eliminarSuscripcionService). Pensado para corregir una
  // alta mal hecha, no para el ciclo de vida normal de un cliente.
  router.delete(
    "/tenants/:id/suscripcion",
    platformSuperAdminMiddleware,
    asyncHandler(async (req, res, next) => {
      try {
        await eliminarSuscripcionService(req.params.id, contextoDe(req));
        res.status(200).json({ ok: true });
      } catch (err) {
        next(err);
      }
    })
  );

  // Cobro único de implementación (ej. puesta en marcha del ERP),
  // independiente de la suscripción -- ver el comentario de
  // registrarCobroImplementacionService. A propósito NO cuelga de
  // /suscripcion: puede cobrarse aunque el tenant todavía no tenga una.
  router.post(
    "/tenants/:id/cobros-implementacion",
    platformSuperAdminMiddleware,
    validarConAuditoria(
      registrarCobroImplementacionSchema,
      "billing.registrar_cobro_implementacion",
      (req) => ({ tenantId: req.params.id })
    ),
    asyncHandler(async (req, res, next) => {
      try {
        const estado = await registrarCobroImplementacionService(
          req.params.id,
          req.validatedBody as RegistrarCobroImplementacionInput,
          contextoDe(req)
        );
        res.status(201).json({ ok: true, suscripcion: estado });
      } catch (err) {
        next(err);
      }
    })
  );

  // Editar un cobro ya cargado -- ver editarCobroService (descripción
  // siempre editable, monto/moneda solo mientras sigue 'pendiente').
  router.put(
    "/tenants/:id/cobros/:cobroId",
    platformSuperAdminMiddleware,
    validarConAuditoria(editarCobroSchema, "billing.editar_cobro", (req) => ({
      tenantId: req.params.id,
    })),
    asyncHandler(async (req, res, next) => {
      try {
        const estado = await editarCobroService(
          req.params.id,
          req.params.cobroId,
          req.validatedBody as EditarCobroInput,
          contextoDe(req)
        );
        res.status(200).json({ ok: true, suscripcion: estado });
      } catch (err) {
        next(err);
      }
    })
  );

  // Borra un cobro entero -- SOLO 'implementacion' (ver
  // eliminarCobroService). Los de 'suscripcion' no se pueden borrar.
  router.delete(
    "/tenants/:id/cobros/:cobroId",
    platformSuperAdminMiddleware,
    asyncHandler(async (req, res, next) => {
      try {
        const estado = await eliminarCobroService(
          req.params.id,
          req.params.cobroId,
          contextoDe(req)
        );
        res.status(200).json({ ok: true, suscripcion: estado });
      } catch (err) {
        next(err);
      }
    })
  );

  // Cierra una cuota pendiente de cobros-implementacion (ej. el saldo de
  // implementación) cuando la plata efectivamente llega -- ver
  // marcarCobroPagadoService.
  router.post(
    "/tenants/:id/cobros/:cobroId/marcar-pagado",
    platformSuperAdminMiddleware,
    asyncHandler(async (req, res, next) => {
      try {
        const estado = await marcarCobroPagadoService(
          req.params.id,
          req.params.cobroId,
          contextoDe(req)
        );
        res.status(200).json({ ok: true, suscripcion: estado });
      } catch (err) {
        next(err);
      }
    })
  );

  // Pago parcial (o total, con montoPagado = saldo completo) sobre un
  // cobro 'pendiente' -- ver registrarPagoCobroService.
  router.post(
    "/tenants/:id/cobros/:cobroId/pago",
    platformSuperAdminMiddleware,
    validarConAuditoria(registrarPagoCobroSchema, "billing.registrar_pago_cobro", (req) => ({
      tenantId: req.params.id,
    })),
    asyncHandler(async (req, res, next) => {
      try {
        const { montoPagado, fecha } = req.validatedBody as RegistrarPagoCobroInput;
        const estado = await registrarPagoCobroService(
          req.params.id,
          req.params.cobroId,
          montoPagado,
          contextoDe(req),
          fecha
        );
        res.status(200).json({ ok: true, suscripcion: estado });
      } catch (err) {
        next(err);
      }
    })
  );

  // Recalcula el arranque de la cortesía desde hoy -- para cuando el alta
  // se hizo antes de que el tenant esté operando de verdad en producción.
  // Ver iniciarCortesiaService.
  router.post(
    "/tenants/:id/suscripcion/iniciar-cortesia",
    platformSuperAdminMiddleware,
    validarConAuditoria(iniciarCortesiaSchema, "billing.iniciar_cortesia", (req) => ({
      tenantId: req.params.id,
    })),
    asyncHandler(async (req, res, next) => {
      try {
        const { trialMeses } = req.validatedBody as IniciarCortesiaInput;
        const estado = await iniciarCortesiaService(req.params.id, trialMeses, contextoDe(req));
        res.status(200).json({ ok: true, suscripcion: estado });
      } catch (err) {
        next(err);
      }
    })
  );

  // El paso que le faltaba a "iniciar-cortesia": resetea el período a
  // partir de HOY y pasa a 'activa' -- el momento en que la facturación
  // arranca de verdad, desacoplado de cuándo se cargó el registro. Ver
  // iniciarFacturacionService.
  router.post(
    "/tenants/:id/suscripcion/iniciar-facturacion",
    platformSuperAdminMiddleware,
    asyncHandler(async (req, res, next) => {
      try {
        const estado = await iniciarFacturacionService(req.params.id, contextoDe(req));
        res.status(200).json({ ok: true, suscripcion: estado });
      } catch (err) {
        next(err);
      }
    })
  );

  // Fija (o quita, con valor: null) la tasa pactada fija de ESTA
  // suscripción -- excepción puntual, no la norma. Ver
  // actualizarTipoCambioOverrideSuscripcionService.
  router.put(
    "/tenants/:id/suscripcion/tipo-cambio",
    platformSuperAdminMiddleware,
    validarConAuditoria(
      actualizarTipoCambioOverrideSchema,
      "billing.actualizar_tipo_cambio_override",
      (req) => ({ tenantId: req.params.id })
    ),
    asyncHandler(async (req, res, next) => {
      try {
        const { valor } = req.validatedBody as ActualizarTipoCambioOverrideInput;
        const estado = await actualizarTipoCambioOverrideSuscripcionService(
          req.params.id,
          valor,
          contextoDe(req)
        );
        res.status(200).json({ ok: true, suscripcion: estado });
      } catch (err) {
        next(err);
      }
    })
  );

  router.put(
    "/tenants/:id/suscripcion/plan",
    platformSuperAdminMiddleware,
    validarConAuditoria(cambiarPlanSuscripcionSchema, "billing.cambiar_plan", (req) => ({
      tenantId: req.params.id,
    })),
    asyncHandler(async (req, res, next) => {
      try {
        const { plan, precioReferencia, motivo } = req.validatedBody as {
          plan: string;
          precioReferencia?: number;
          motivo?: string;
        };
        const estado = await cambiarPlanSuscripcionService(
          req.params.id,
          plan,
          precioReferencia,
          motivo,
          contextoDe(req)
        );
        res.status(200).json({ ok: true, suscripcion: estado });
      } catch (err) {
        next(err);
      }
    })
  );

  router.post(
    "/tenants/:id/suscripcion/gracia",
    platformSuperAdminMiddleware,
    validarConAuditoria(extenderGraciaSchema, "billing.extender_gracia", (req) => ({
      tenantId: req.params.id,
    })),
    asyncHandler(async (req, res, next) => {
      try {
        const { dias, motivo } = req.validatedBody as { dias: number; motivo?: string };
        const estado = await extenderGraciaService(req.params.id, dias, motivo, contextoDe(req));
        res.status(200).json({ ok: true, suscripcion: estado });
      } catch (err) {
        next(err);
      }
    })
  );

  router.post(
    "/tenants/:id/suscripcion/cancelar",
    platformSuperAdminMiddleware,
    validarConAuditoria(motivoOpcionalSchema, "billing.cancelar_suscripcion", (req) => ({
      tenantId: req.params.id,
    })),
    asyncHandler(async (req, res, next) => {
      try {
        const { motivo } = req.validatedBody as { motivo?: string };
        const estado = await cancelarSuscripcionService(req.params.id, motivo, contextoDe(req));
        res.status(200).json({ ok: true, suscripcion: estado });
      } catch (err) {
        next(err);
      }
    })
  );

  router.post(
    "/tenants/:id/suscripcion/reactivar",
    platformSuperAdminMiddleware,
    asyncHandler(async (req, res, next) => {
      try {
        const estado = await reactivarSuscripcionService(req.params.id, contextoDe(req));
        res.status(200).json({ ok: true, suscripcion: estado });
      } catch (err) {
        next(err);
      }
    })
  );

  router.post(
    "/tenants/:id/suscripcion/cobrar",
    platformSuperAdminMiddleware,
    asyncHandler(async (req, res, next) => {
      try {
        const estado = await forzarCobroService(req.params.id, contextoDe(req));
        res.status(200).json({ ok: true, suscripcion: estado });
      } catch (err) {
        next(err);
      }
    })
  );

  // Sin super_admin: el propio servicio se autoprotege (400 si la pasarela
  // activa no es la Stub), así que no hace falta el gate extra de dinero
  // real que sí llevan el resto de las mutaciones de acá arriba.
  router.post(
    "/tenants/:id/suscripcion/metodo-pago-prueba",
    asyncHandler(async (req, res, next) => {
      try {
        const estado = await crearMetodoPagoPruebaService(req.params.id, contextoDe(req));
        res.status(201).json({ ok: true, suscripcion: estado });
      } catch (err) {
        next(err);
      }
    })
  );

  // Job diario de vencimientos (.github/workflows/scheduled-billing-vencimientos.yml,
  // mismo patrón que scheduled-backup.yml) — mismo nivel de protección que
  // las rutas de backup que ese otro workflow llama: platformAdminMiddleware
  // ya cubre el token compartido vía Authorization Bearer, no hace falta
  // super_admin acá (el workflow no tiene una cuenta individual).
  router.post(
    "/billing/procesar-vencimientos",
    asyncHandler(async (_req, res, next) => {
      try {
        const resultado = await procesarVencimientosService();
        res.status(200).json({ ok: true, ...resultado });
      } catch (err) {
        next(err);
      }
    })
  );

  // Job diario (.github/workflows/scheduled-billing-tc-bcrp.yml) Y botón
  // manual "Actualizar desde API" en el panel -- ambos disparan lo mismo.
  // super_admin porque, igual que el PUT manual, termina escribiendo el
  // TC global; el secreto compartido que usa el workflow cuenta como
  // super_admin (ver platformSuperAdmin.middleware.ts), así que el cron
  // no se rompe. Si el BCRP no responde o no publicó nada en la ventana,
  // el servicio tira 502 y falla visiblemente en vez de dejar el TC
  // global desactualizado en silencio.
  router.post(
    "/billing/tipo-cambio/actualizar-desde-bcrp",
    platformSuperAdminMiddleware,
    asyncHandler(async (_req, res, next) => {
      try {
        const tipoCambio = await actualizarTipoCambioDesdeBcrpService();
        res.status(200).json({ ok: true, tipoCambio });
      } catch (err) {
        next(err);
      }
    })
  );

  // ── Backups de la capa de plataforma ──────────────────────────────────
  // Rutas separadas de /tenants/:id/backups a propósito: no pertenecen a
  // ningún tenant y su contenido es el más sensible del sistema
  // (password_hash de admins, secretos de SSO) — ver
  // platformBackupPlataforma.service.ts.

  router.get(
    "/backups/plataforma",
    asyncHandler(async (_req, res, next) => {
      try {
        const backups = await listarBackupsPlataformaService();
        res.status(200).json({ ok: true, backups });
      } catch (err) {
        next(err);
      }
    })
  );

  // Crear el backup exige super_admin: a diferencia del backup de un
  // tenant (que solo copia datos que ese admin ya puede ver por el panel),
  // éste materializa en un solo archivo los hashes de contraseña de TODOS
  // los admins de plataforma y los secretos de SSO de todos los clientes.
  router.post(
    "/backups/plataforma",
    platformSuperAdminMiddleware,
    asyncHandler(async (req, res, next) => {
      try {
        const backup = await exportarPlataformaService(contextoDe(req));
        await publicarEventoPlataforma("plataforma.backup_creado", { backupId: backup.id });
        res.status(201).json({ ok: true, backup });
      } catch (err) {
        next(err);
      }
    })
  );

  // Aditivo, nunca destructivo (ver restaurarBackupPlataformaService), pero
  // igual gateado a super_admin + confirmar:true: reinsertar tenants o
  // admins borrados es una operación de recuperación ante desastre, no algo
  // que deba poder dispararse de un click distraído.
  router.post(
    "/backups/plataforma/:backupId/restaurar",
    platformSuperAdminMiddleware,
    validate(restaurarBackupPlataformaSchema),
    asyncHandler(async (req, res, next) => {
      try {
        const resultado = await restaurarBackupPlataformaService(
          req.params.backupId,
          contextoDe(req)
        );
        await publicarEventoPlataforma("plataforma.backup_restaurado", {
          backupId: req.params.backupId,
        });
        res.status(200).json({ ok: true, ...resultado });
      } catch (err) {
        next(err);
      }
    })
  );

  // Compartido entre /tenants y /tenants/onboard — ambos son "crear un
  // tenant" con Idempotency-Key opcional, solo cambia qué service ejecutan
  // (crearTenantConAdminService vs. onboardTenantService, que la envuelve
  // agregando plan — ver tenantOnboardingService.ts). La respuesta ya
  // queda guardada en platform_outbox DENTRO de la misma transacción que
  // crea el tenant, no hace falta escribirla acá.
  async function crearTenantConIdempotencia<T extends { tenant: { id: string; slug: string } }>(
    req: Request,
    res: Response,
    next: NextFunction,
    ejecutar: (idempotencyKey: string | undefined) => Promise<T>
  ) {
    const idempotencyKey = req.header("Idempotency-Key");
    try {
      if (idempotencyKey) {
        const estado = await consultarIdempotencia(idempotencyKey);
        if (estado.estado === "en_progreso") {
          return res
            .status(409)
            .json({ ok: false, message: "Ya hay una solicitud en curso con esa Idempotency-Key" });
        }
        if (estado.estado === "resuelta") {
          return res.status(201).json(estado.respuesta);
        }
      }

      const resultado = await ejecutar(idempotencyKey);
      await publicarEventoPlataforma("tenant.creado", {
        tenantId: resultado.tenant.id,
        slug: resultado.tenant.slug,
      });
      res.status(201).json({ ok: true, ...resultado });
    } catch (err) {
      if (idempotencyKey) {
        // Cubre la carrera real entre dos requests concurrentes con la
        // misma Idempotency-Key nunca vista: la segunda transacción choca
        // contra el índice único de platform_outbox y se revierte entera
        // (ver migrations/0018) — acá se recupera la respuesta de la que
        // sí ganó, en vez de devolverle un 500 a alguien cuyo pedido en
        // rigor sí se cumplió.
        const yaResuelta = await buscarRespuestaPorClave(idempotencyKey);
        if (yaResuelta) {
          return res.status(201).json(yaResuelta);
        }
        await liberarIdempotencia(idempotencyKey);
      }
      next(err);
    }
  }

  router.post(
    "/tenants",
    platformTenantRateLimiter,
    validarConAuditoria(crearTenantSchema, "crear_tenant"),
    asyncHandler((req, res, next) =>
      crearTenantConIdempotencia(req, res, next, (idempotencyKey) =>
        crearTenantConAdminService(
          req.validatedBody as CrearTenantInput,
          contextoDe(req),
          idempotencyKey
        )
      )
    )
  );

  // Onboarding completo: lo mismo que /tenants + asignación de plan inicial
  // (planCodigo opcional), en la MISMA transacción — ver
  // tenantOnboardingService.ts sobre por qué no alcanza con llamar a
  // asignarPlanATenantService por separado. Gateado a super-admin porque
  // es una operación de alta de cliente, más sensible que el alta simple
  // sin plan que ya permitía cualquier platform admin.
  router.post(
    "/tenants/onboard",
    platformTenantRateLimiter,
    platformSuperAdminMiddleware,
    validarConAuditoria(onboardTenantSchema, "onboard_tenant"),
    asyncHandler((req, res, next) =>
      crearTenantConIdempotencia(req, res, next, (idempotencyKey) =>
        onboardTenantService(
          req.validatedBody as OnboardTenantInput,
          contextoDe(req),
          idempotencyKey
        )
      )
    )
  );

  router.patch(
    "/tenants/:id/estado",
    validarConAuditoria(cambiarEstadoTenantSchema, "cambiar_estado_tenant", (req) => ({
      tenantId: req.params.id,
    })),
    asyncHandler(async (req, res, next) => {
      try {
        const { activo, motivo } = req.validatedBody as { activo: boolean; motivo?: string };
        const tenant = await cambiarEstadoTenantService(
          req.params.id,
          activo,
          motivo,
          contextoDe(req)
        );
        await publicarEventoPlataforma("tenant.estado_cambiado", {
          tenantId: req.params.id,
          activo,
        });
        res.status(200).json({ ok: true, tenant });
      } catch (err) {
        next(err);
      }
    })
  );

  router.get(
    "/tenants/:id/dominio",
    asyncHandler(async (req, res, next) => {
      try {
        const dominio = await obtenerDominioTenantService(req.params.id);
        res.status(200).json({ ok: true, dominio });
      } catch (err) {
        next(err);
      }
    })
  );

  router.patch(
    "/tenants/:id/dominio",
    validate(actualizarDominioSchema),
    asyncHandler(async (req, res, next) => {
      try {
        const { dominioPersonalizado } = req.validatedBody as {
          dominioPersonalizado: string | null;
        };
        const dominio = await asignarDominioTenantService(
          req.params.id,
          dominioPersonalizado,
          contextoDe(req)
        );
        await publicarEventoPlataforma("tenant.dominio_cambiado", {
          tenantId: req.params.id,
          dominioPersonalizado,
        });
        res.status(200).json({ ok: true, dominio });
      } catch (err) {
        next(err);
      }
    })
  );

  // Consulta DNS de verdad (TXT record) y activa el dominio si coincide —
  // se puede llamar cuantas veces haga falta mientras el cliente termina
  // de propagar su DNS, sin perder el token entre intentos.
  router.post(
    "/tenants/:id/dominio/verificar",
    asyncHandler(async (req, res, next) => {
      try {
        const dominio = await verificarDominioService(req.params.id, contextoDe(req));
        await publicarEventoPlataforma("tenant.dominio_verificado", {
          tenantId: req.params.id,
          estado: dominio.dominioEstado,
        });
        res.status(200).json({ ok: true, dominio });
      } catch (err) {
        next(err);
      }
    })
  );

  // ── SSO del tenant (config por empresa, ver tenant_sso_config) ─────────
  router.get(
    "/tenants/:id/sso",
    asyncHandler(async (req, res, next) => {
      try {
        const sso = await obtenerConfigSsoTenantService(req.params.id);
        res.status(200).json({ ok: true, sso });
      } catch (err) {
        next(err);
      }
    })
  );

  router.put(
    "/tenants/:id/sso",
    validate(configurarSsoTenantSchema),
    asyncHandler(async (req, res, next) => {
      try {
        const sso = await configurarSsoTenantService(
          req.params.id,
          req.validatedBody as ConfigurarSsoTenantInput,
          contextoDe(req)
        );
        await publicarEventoPlataforma("tenant.sso_configurado", { tenantId: req.params.id });
        res.status(200).json({ ok: true, sso });
      } catch (err) {
        next(err);
      }
    })
  );

  // ── SCIM del tenant (config del token, ver tenant_scim_config) ─────────
  router.get(
    "/tenants/:id/scim",
    asyncHandler(async (req, res, next) => {
      try {
        const scim = await obtenerConfigScimService(req.params.id);
        res.status(200).json({ ok: true, scim });
      } catch (err) {
        next(err);
      }
    })
  );

  // Devuelve el token en texto plano UNA SOLA VEZ — el panel lo muestra al
  // admin en el momento y no lo vuelve a pedir (no se puede: solo se guarda
  // el hash, ver platformScim.service.ts).
  router.post(
    "/tenants/:id/scim/token",
    asyncHandler(async (req, res, next) => {
      try {
        const token = await generarTokenScimService(req.params.id, contextoDe(req));
        // El token en sí NUNCA va en el evento -- es un secreto de un solo
        // uso (ver el comentario de la ruta), el canal de tiempo real no es
        // el lugar para eso.
        await publicarEventoPlataforma("tenant.scim_token_generado", { tenantId: req.params.id });
        res.status(200).json({ ok: true, token });
      } catch (err) {
        next(err);
      }
    })
  );

  router.delete(
    "/tenants/:id/scim/token",
    asyncHandler(async (req, res, next) => {
      try {
        await revocarTokenScimService(req.params.id, contextoDe(req));
        await publicarEventoPlataforma("tenant.scim_token_revocado", { tenantId: req.params.id });
        res.status(200).json({ ok: true });
      } catch (err) {
        next(err);
      }
    })
  );

  router.get(
    "/tenants/:id/modulos",
    asyncHandler(async (req, res, next) => {
      try {
        const modulos = await obtenerModulosTenantService(req.params.id);
        res.status(200).json({ ok: true, modulos });
      } catch (err) {
        next(err);
      }
    })
  );

  router.put(
    "/tenants/:id/modulos",
    validate(actualizarModulosTenantSchema),
    asyncHandler(async (req, res, next) => {
      try {
        const { configuraciones } = req.validatedBody as { configuraciones: ConfiguracionModulo[] };
        const resultado = await actualizarModulosTenantService(
          req.params.id,
          configuraciones,
          contextoDe(req)
        );
        await publicarEventoPlataforma("tenant.modulos_actualizados", {
          tenantId: req.params.id,
          configuraciones,
        });
        res.status(200).json({ ok: true, modulos: resultado });
      } catch (err) {
        next(err);
      }
    })
  );

  // Aplica el mismo estado a un módulo en TODOS los tenants de una sola
  // vez — "apagar en caliente globalmente". Blast radius alto (toca cada
  // tenant), gateado a super_admin/emergencia igual que la gestión de
  // otros Platform Admin.
  router.put(
    "/modulos/:modulo/global",
    platformSuperAdminMiddleware,
    validate(actualizarModuloGlobalSchema),
    asyncHandler(async (req, res, next) => {
      try {
        if (!MODULOS_ERP.includes(req.params.modulo as (typeof MODULOS_ERP)[number])) {
          return res.status(400).json({ ok: false, message: "Módulo desconocido" });
        }
        const config = req.validatedBody as ActualizarModuloGlobalInput;
        const resultado = await actualizarModuloGlobalService(
          req.params.modulo,
          config,
          contextoDe(req)
        );
        await publicarEventoPlataforma("modulo.global_actualizado", {
          modulo: req.params.modulo,
          config,
        });
        res.status(200).json({ ok: true, ...resultado });
      } catch (err) {
        next(err);
      }
    })
  );

  router.get(
    "/tenants/:id/usuarios",
    asyncHandler(async (req, res, next) => {
      try {
        const usuarios = await listarUsuariosTenantService(req.params.id);
        res.status(200).json({ ok: true, usuarios });
      } catch (err) {
        next(err);
      }
    })
  );

  router.post(
    "/tenants/:id/usuarios",
    validarConAuditoria(crearUsuarioEnTenantSchema, "crear_usuario", (req) => ({
      tenantId: req.params.id,
    })),
    asyncHandler(async (req, res, next) => {
      try {
        const usuario = await crearUsuarioEnTenantService(
          req.params.id,
          req.validatedBody as CrearUsuarioEnTenantInput,
          contextoDe(req)
        );
        await publicarEventoPlataforma("tenant.usuario_creado", {
          tenantId: req.params.id,
          usuarioId: usuario.id,
        });
        res.status(201).json({ ok: true, usuario });
      } catch (err) {
        next(err);
      }
    })
  );

  // ── Break-glass: nombrar un administrador desde afuera (§12) ─────────
  //
  // Para la empresa que activó la doble firma y se quedó con un solo
  // administrador: con uno solo no hay quien firme la orden que nombraría al
  // reemplazo. No pasa por órdenes -- es la salida de emergencia del sistema
  // de órdenes -- pero queda en la bitácora de esa empresa, con motivo.
  router.patch(
    "/tenants/:tenantId/usuarios/:usuarioId/rol",
    validarConAuditoria(reemplazarAdminSchema, "plataforma.reemplazar_admin", (req) => ({
      tenantId: req.params.tenantId,
      usuarioId: req.params.usuarioId,
    })),
    asyncHandler(async (req, res, next) => {
      try {
        res.json({
          ok: true,
          usuario: await reemplazarAdminService(
            req.params.tenantId,
            req.params.usuarioId,
            req.validatedBody as ReemplazarAdminInput,
            contextoDe(req)
          ),
        });
      } catch (err) {
        next(err);
      }
    })
  );

  // ── Desactivar una CUENTA entera (§12) ───────────────────────────────
  //
  // La persona deja de entrar a TODAS sus empresas. Una empresa solo puede
  // desactivar su propio perfil: no puede dejar a alguien afuera del trabajo
  // que tiene en otra.
  router.patch(
    "/cuentas/:cuentaId/estado",
    // Sin tenantId: una cuenta no es de ninguna empresa. El rastro por
    // empresa lo escribe el servicio, una fila por cada perfil que tenía.
    validarConAuditoria(cambiarEstadoCuentaSchema, "plataforma.cambiar_estado_cuenta", () => ({})),
    asyncHandler(async (req, res, next) => {
      try {
        const { activo, motivo } = req.validatedBody as CambiarEstadoCuentaInput;
        res.json({
          ok: true,
          ...(await cambiarEstadoCuentaService(
            req.params.cuentaId,
            activo,
            motivo,
            contextoDe(req)
          )),
        });
      } catch (err) {
        next(err);
      }
    })
  );

  // Anidadas bajo su tenant a propósito (no /usuarios/:id/...): usuarios
  // tiene RLS, así que cualquier operación sobre un usuario puntual
  // necesita su tenantId de antemano — ver comentario al inicio de
  // platform.service.ts.
  router.patch(
    "/tenants/:tenantId/usuarios/:usuarioId/estado",
    validarConAuditoria(cambiarEstadoUsuarioSchema, "cambiar_estado_usuario", (req) => ({
      tenantId: req.params.tenantId,
      usuarioId: req.params.usuarioId,
    })),
    asyncHandler(async (req, res, next) => {
      try {
        const { activo, motivo } = req.validatedBody as { activo: boolean; motivo?: string };
        const usuario = await cambiarEstadoUsuarioService(
          req.params.tenantId,
          req.params.usuarioId,
          estadoDesdeActivo(activo),
          motivo,
          contextoDe(req)
        );
        await publicarEventoPlataforma("tenant.usuario_estado_cambiado", {
          tenantId: req.params.tenantId,
          usuarioId: req.params.usuarioId,
          activo,
        });
        res.status(200).json({ ok: true, usuario });
      } catch (err) {
        next(err);
      }
    })
  );

  router.get(
    "/tenants/:tenantId/usuarios/:usuarioId/modulos",
    asyncHandler(async (req, res, next) => {
      try {
        const modulos = await obtenerModulosUsuarioService(
          req.params.tenantId,
          req.params.usuarioId
        );
        res.status(200).json({ ok: true, modulos });
      } catch (err) {
        next(err);
      }
    })
  );

  router.put(
    "/tenants/:tenantId/usuarios/:usuarioId/modulos",
    validate(actualizarModulosSchema),
    asyncHandler(async (req, res, next) => {
      try {
        const { modulos } = req.validatedBody as { modulos: string[] };
        const resultado = await actualizarModulosUsuarioService(
          req.params.tenantId,
          req.params.usuarioId,
          modulos,
          contextoDe(req)
        );
        await publicarEventoPlataforma("tenant.usuario_modulos_actualizados", {
          tenantId: req.params.tenantId,
          usuarioId: req.params.usuarioId,
          modulos,
        });
        res.status(200).json({ ok: true, modulos: resultado });
      } catch (err) {
        next(err);
      }
    })
  );

  router.get(
    "/auditoria",
    asyncHandler(async (req, res, next) => {
      try {
        const q = req.query;
        const tenantId = typeof q.tenantId === "string" ? q.tenantId : undefined;
        const accion = typeof q.accion === "string" ? q.accion : undefined;
        const resultado: ResultadoAuditoria | undefined =
          q.resultado === "success" || q.resultado === "failure" ? q.resultado : undefined;
        const sessionId = typeof q.sessionId === "string" ? q.sessionId : undefined;
        const actorId = typeof q.actorId === "string" ? q.actorId : undefined;
        const desde = typeof q.desde === "string" ? q.desde : undefined;
        const hasta = typeof q.hasta === "string" ? q.hasta : undefined;
        const limit = typeof q.limit === "string" ? Number(q.limit) : undefined;

        if (
          (desde && Number.isNaN(Date.parse(desde))) ||
          (hasta && Number.isNaN(Date.parse(hasta)))
        ) {
          return res.status(400).json({ ok: false, message: "Rango de fechas inválido" });
        }

        let cursor: { creadoEn: string; id: string } | undefined;
        if (typeof q.cursor === "string" && q.cursor) {
          const [creadoEn, id] = Buffer.from(q.cursor, "base64url").toString("utf8").split("|");
          if (!creadoEn || !id) {
            return res.status(400).json({ ok: false, message: "Cursor inválido" });
          }
          cursor = { creadoEn, id };
        }

        const pagina = await listarAuditoriaService({
          tenantId,
          accion,
          resultado,
          sessionId,
          actorId,
          desde,
          hasta,
          cursor,
          limit,
        });

        const siguienteCursor = pagina.siguienteCursor
          ? Buffer.from(`${pagina.siguienteCursor.creadoEn}|${pagina.siguienteCursor.id}`).toString(
              "base64url"
            )
          : null;

        res.status(200).json({ ok: true, entradas: pagina.entradas, siguienteCursor });
      } catch (err) {
        next(err);
      }
    })
  );

  return router;
}
