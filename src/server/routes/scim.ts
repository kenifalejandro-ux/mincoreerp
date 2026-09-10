/** src/server/routes/scim.ts
 *
 * SCIM 2.0 mínimo viable — provisioning automático de usuarios de tenant
 * desde el IdP del cliente (Okta, Azure AD, etc.), separado del login
 * (ver tenantSso.service.ts): esto NUNCA autentica a nadie como ese
 * usuario, solo crea/desactiva/reactiva la cuenta para que después pueda
 * entrar por SSO o por contraseña.
 *
 * Reutiliza los services YA existentes de platform.service.ts
 * (crearUsuarioEnTenantService, cambiarEstadoUsuarioService,
 * listarUsuariosTenantService) en vez de duplicar lógica de negocio — este
 * router es solo un adaptador de protocolo: traduce el schema SCIM de/hacia
 * el shape que esos services ya esperan, y pone actor_type='scim' en la
 * auditoría para distinguir el origen.
 *
 * Subset implementado (lo que cubre el caso real de "alta/baja automática
 * al entrar/salir del Directorio Activo del tenant"): GET/POST /Users,
 * GET /Users/:id, PATCH y DELETE /Users/:id (ambos desactivan — soft-delete,
 * igual que el resto de la app). Actualizar email/rol vía SCIM queda fuera
 * de esta primera versión (ver el PR).
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { randomBytes } from "crypto";
import { ZodError } from "zod";
import rateLimiter from "../middleware/rateLimiter";
import { scimAuthMiddleware, getScimTenantId } from "../shared/middlewares/scim.middleware";
import { getClientIp, getRequestId, getUserAgent } from "../shared/utils/request";
import { AppError } from "../shared/middlewares/error.middleware";
import { crearUsuarioEnTenantSchema } from "../schemas/platform.schema";
import {
  listarUsuariosTenantService,
  crearUsuarioEnTenantService,
  cambiarEstadoUsuarioService,
  type UsuarioListado,
} from "../services/platform.service";
import type { ContextoAuditoria } from "../services/platformAudit.service";
import { asyncHandler } from "../shared/utils/asyncHandler";

const SCHEMA_USER = "urn:ietf:params:scim:schemas:core:2.0:User";
const SCHEMA_LIST = "urn:ietf:params:scim:api:messages:2.0:ListResponse";

function contextoScim(req: Request): ContextoAuditoria {
  return {
    ip: getClientIp(req),
    requestId: getRequestId(req),
    userAgent: getUserAgent(req),
    actorType: "scim",
    actorLabel: "integración-scim",
  };
}

function usuarioAScim(usuario: UsuarioListado) {
  return {
    schemas: [SCHEMA_USER],
    id: usuario.id,
    userName: usuario.email,
    name: { formatted: usuario.nombre },
    active: usuario.activo,
    meta: { resourceType: "User" },
  };
}

/** Filtro SCIM mínimo: solo `userName eq "valor"` (el único que los
 *  conectores de provisioning reales usan para chequear si un usuario ya
 *  existe antes de crearlo) — cualquier otro filtro se ignora en vez de
 *  fallar, y devuelve la lista completa. */
function extraerUserNameDelFiltro(filter: unknown): string | null {
  if (typeof filter !== "string") return null;
  const match = filter.match(/userName\s+eq\s+"([^"]+)"/i);
  return match ? match[1].toLowerCase() : null;
}

function errorScim(res: Response, status: number, detail: string) {
  return res.status(status).json({
    schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
    status: String(status),
    detail,
  });
}

export function createScimRouter() {
  const router = Router();

  // Sin esto, el bearer token de un tenant se podía probar sin límite: el
  // resto de la app (login, forgot-password, reset-password) ya pasa por
  // rateLimiter antes de validar la credencial, SCIM había quedado afuera.
  router.use(rateLimiter, scimAuthMiddleware);

  router.get(
    "/Users",
    asyncHandler(async (req, res, next) => {
      try {
        const tenantId = getScimTenantId(req);
        const usuarios = await listarUsuariosTenantService(tenantId);
        const userName = extraerUserNameDelFiltro(req.query.filter);
        const filtrados = userName ? usuarios.filter((u) => u.email === userName) : usuarios;

        res.status(200).json({
          schemas: [SCHEMA_LIST],
          totalResults: filtrados.length,
          Resources: filtrados.map(usuarioAScim),
        });
      } catch (err) {
        next(err);
      }
    })
  );

  router.get(
    "/Users/:id",
    asyncHandler(async (req, res, next) => {
      try {
        const tenantId = getScimTenantId(req);
        const usuarios = await listarUsuariosTenantService(tenantId);
        const usuario = usuarios.find((u) => u.id === req.params.id);
        if (!usuario) return errorScim(res, 404, "Usuario no encontrado");
        res.status(200).json(usuarioAScim(usuario));
      } catch (err) {
        next(err);
      }
    })
  );

  router.post(
    "/Users",
    asyncHandler(async (req, res, next) => {
      try {
        const tenantId = getScimTenantId(req);
        const body = req.body as {
          userName?: string;
          name?: { formatted?: string; givenName?: string; familyName?: string };
          displayName?: string;
        };

        const email = body.userName?.trim();
        if (!email) return errorScim(res, 400, "userName es obligatorio");

        const nombre =
          body.name?.formatted ||
          [body.name?.givenName, body.name?.familyName].filter(Boolean).join(" ") ||
          body.displayName ||
          email;

        // Los usuarios provisionados por SCIM entran por SSO, no por
        // contraseña — se les genera una al azar que nadie conoce ni necesita
        // conocer (crearUsuarioEnTenantSchema exige el campo, pero nada del
        // login por contraseña queda accesible sin que un admin la resetee
        // a propósito). El linking con su identidad SSO ocurre en su primer
        // login real (ver resolverUsuarioSso en tenantSso.service.ts).
        const input = crearUsuarioEnTenantSchema.parse({
          nombre,
          email,
          password: randomBytes(24).toString("base64url"),
        });

        const usuario = await crearUsuarioEnTenantService(tenantId, input, contextoScim(req));
        res.status(201).json(
          usuarioAScim({
            id: usuario.id,
            nombre: usuario.nombre,
            // SCIM sincroniza desde un IdP corporativo, así que el correo
            // siempre viene. El `?? ""` es solo para el tipo, que desde 0084
            // admite null por los usuarios de cancha -- que nunca llegan
            // por acá.
            email: usuario.email ?? "",
            dni: usuario.dni ?? null,
            rol: usuario.rol,
            activo: true,
          })
        );
      } catch (err) {
        next(err);
      }
    })
  );

  router.patch(
    "/Users/:id",
    asyncHandler(async (req, res, next) => {
      try {
        const tenantId = getScimTenantId(req);
        const activo = leerActivoDePatch(req.body);
        if (activo === null)
          return errorScim(res, 400, "Solo se soporta cambiar el atributo 'active'");

        const usuario = await cambiarEstadoUsuarioService(
          tenantId,
          req.params.id,
          activo,
          undefined,
          contextoScim(req)
        );
        res.status(200).json(usuarioAScim(usuario));
      } catch (err) {
        next(err);
      }
    })
  );

  router.delete(
    "/Users/:id",
    asyncHandler(async (req, res, next) => {
      try {
        const tenantId = getScimTenantId(req);
        await cambiarEstadoUsuarioService(
          tenantId,
          req.params.id,
          false,
          "baja vía SCIM",
          contextoScim(req)
        );
        res.status(204).send();
      } catch (err) {
        next(err);
      }
    })
  );

  // Envoltorio SCIM propio del error, en vez del errorHandler genérico
  // (`{ ok: false, message }`) — un cliente SCIM real espera este schema.
  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      return errorScim(res, 400, err.issues.map((i) => i.message).join("; "));
    }
    if (err instanceof AppError) {
      return errorScim(res, err.statusCode, err.message);
    }
    errorScim(res, 500, "Error interno");
  });

  return router;
}

/** Soporta tanto el PatchOp estándar (RFC 7644 §3.5.2, lo que mandan
 *  Okta/Azure AD) como un body plano `{ active: boolean }` — null si no se
 *  pudo interpretar ninguna de las dos formas. */
function leerActivoDePatch(body: unknown): boolean | null {
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;

  if (typeof obj.active === "boolean") return obj.active;

  if (Array.isArray(obj.Operations)) {
    for (const op of obj.Operations) {
      if (!op || typeof op !== "object") continue;
      const operacion = op as { path?: string; value?: unknown };
      if (operacion.path && operacion.path.toLowerCase() !== "active") continue;
      if (typeof operacion.value === "boolean") return operacion.value;
      if (operacion.value && typeof operacion.value === "object" && "active" in operacion.value) {
        const valorActivo = (operacion.value as { active?: unknown }).active;
        if (typeof valorActivo === "boolean") return valorActivo;
      }
    }
  }

  return null;
}
