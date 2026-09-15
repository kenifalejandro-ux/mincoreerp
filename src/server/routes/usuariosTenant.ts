/** src/server/routes/usuariosTenant.ts
 *
 * Gestión de usuarios POR EL PROPIO TENANT, no por el dueño del software.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────
 *
 * Hasta acá los usuarios de un tenant solo se creaban desde el panel de
 * plataforma (`POST /api/platform/tenants/:id/usuarios`), o sea únicamente el
 * dueño del ERP. Eso alcanzaba mientras cada empresa tenía dos o tres
 * usuarios de oficina.
 *
 * Dejó de alcanzar con el pedido del cliente: dar de alta al grifero, a los
 * conductores de ruta y al personal de mina. Son decenas de personas que
 * además ROTAN. Con el alta solo en plataforma, cada incorporación y cada
 * baja pasaría por el proveedor -- que queda de operador permanente de un
 * dato que es puramente interno de la empresa.
 *
 * Es además coherente con el principio del panel de plataforma: el dueño
 * nunca administra los datos de negocio de sus clientes.
 *
 * ── Solo admin ─────────────────────────────────────────────────────────
 *
 * Crear una credencial es dar acceso al sistema. Ni `operador` ni `lectura`
 * pueden -- y menos todavía los roles de cancha que vienen después, que
 * existen justamente para que un grifero solo pueda registrar vales.
 *
 * ── Lo que este router NO hace ─────────────────────────────────────────
 *
 * No habilita módulos: qué módulos tiene contratada una empresa es parte del
 * contrato comercial y sigue siendo decisión de plataforma. Lo que sí hace
 * desde la entrega 3 es REPARTIR lo que la empresa ya tiene -- las
 * "autonomías" de Kenif: a quién se le da cada módulo y con qué nivel
 * (operar / consultas / sin acceso). Un administrador no puede darle a nadie,
 * ni a sí mismo, un módulo que su empresa no contrató: ver
 * permisosTenant.service.ts.
 */
import { Router } from "express";
import { z } from "zod";

import { validate } from "../middleware/validate";
import { AppError } from "../shared/middlewares/error.middleware";
import { requireRole } from "../shared/middlewares/roles.middleware";
import { asyncHandler } from "../shared/utils/asyncHandler";
import { contextoAuditoriaModulo } from "../shared/utils/moduleAudit";
import { getTenantId } from "../shared/utils/request";
import { resetearClaveUsuarioService } from "../services/auth.service";
import { registrarAuditoria } from "../services/platformAudit.service";
import {
  crearUsuarioEnTenantService,
  listarUsuariosTenantService,
  cambiarEstadoUsuarioService,
  actualizarPerfilUsuarioService,
} from "../services/platform.service";
import {
  crearUsuarioEnTenantSchema,
  type CrearUsuarioEnTenantInput,
} from "../schemas/platform.schema";
import {
  listarPermisosUsuarioService,
  guardarPermisosUsuarioService,
} from "../services/permisosTenant.service";

const resetClaveSchema = z.object({
  password: z.string().min(8, "La contraseña debe tener al menos 8 caracteres").max(200),
});

/** Desde 0090 el estado tiene tres valores. `activo` se sigue aceptando como
 *  alias (una pestaña abierta con el bundle viejo, la cola offline) y se
 *  traduce: false = baja, que es lo único que un booleano puede decir. */
const cambiarEstadoSchema = z
  .object({
    estado: z.enum(["activo", "inactivo", "bloqueado"]).optional(),
    activo: z.boolean().optional(),
    /** Obligatorio al DESACTIVAR (se chequea en el handler, no acá, porque
     *  depende del estado): dejar a alguien afuera del sistema es una acción
     *  correctiva, y el módulo ya exige motivo para todas las demás -- anular
     *  un vale, aflojar un umbral. */
    motivo: z.string().trim().min(1).max(500).optional(),
  })
  .transform((v) => ({
    estado: v.estado ?? (v.activo === false ? ("inactivo" as const) : ("activo" as const)),
    motivo: v.motivo,
    /** true si el request no dijo ni una cosa ni la otra. */
    vacio: v.estado === undefined && v.activo === undefined,
  }))
  .refine((v) => !v.vacio, { message: "Indicá el estado", path: ["estado"] });

const actualizarUsuarioSchema = z
  .object({
    nombre: z.string().trim().min(1).max(100).optional(),
    // null = borrarlo. Sin formato fijo: ver el comentario de la migración.
    celular: z.string().trim().max(30).nullable().optional(),
  })
  .refine((v) => v.nombre !== undefined || v.celular !== undefined, {
    message: "No hay nada que cambiar",
  });

/** Las autonomías de una persona, tal como las manda la pantalla: la lista
 *  completa, no un parche. Mandar el estado entero evita el problema clásico
 *  de los permisos por diferencias -- dos administradores editando a la vez y
 *  un módulo que queda asignado porque nadie mandó su baja. */
const guardarPermisosSchema = z.object({
  rol: z.enum(["admin", "operador", "lectura", "grifero", "conductor_ruta"]).optional(),
  modulos: z
    .array(
      z.object({
        modulo: z.string().min(1).max(50),
        asignado: z.boolean(),
        nivel: z.enum(["operar", "consultas"]),
      })
    )
    .max(50),
  motivo: z.string().trim().max(500).optional(),
});

export function createUsuariosTenantRouter() {
  const router = Router();

  router.get(
    "/",
    requireRole("admin"),
    asyncHandler(async (req, res) => {
      const usuarios = await listarUsuariosTenantService(getTenantId(req));
      res.json({ data: usuarios });
    })
  );

  router.post(
    "/",
    requireRole("admin"),
    validate(crearUsuarioEnTenantSchema),
    asyncHandler(async (req, res) => {
      const tenantId = getTenantId(req);
      const usuario = await crearUsuarioEnTenantService(
        tenantId,
        req.validatedBody as CrearUsuarioEnTenantInput,
        contextoAuditoriaModulo(req)
      );
      res.status(201).json(usuario);
    })
  );

  router.patch(
    "/:id/clave",
    requireRole("admin"),
    validate(resetClaveSchema),
    asyncHandler(async (req, res) => {
      const tenantId = getTenantId(req);
      const { password } = req.validatedBody as { password: string };

      const usuario = await resetearClaveUsuarioService(tenantId, req.params.id, password);

      await registrarAuditoria({
        accion: "resetear_clave_usuario",
        tenantId,
        usuarioId: usuario.id,
        // Nunca la contraseña, obviamente: solo a quién se le cambió y CÓMO.
        // `correo-enviado` significa que el admin no puso ninguna clave: la
        // persona tiene cuenta y la elige ella (ver resetearClaveUsuarioService).
        detalle: { identificador: usuario.email ?? usuario.dni, modo: usuario.modo },
        contexto: contextoAuditoriaModulo(req),
      });

      res.json(usuario);
    })
  );

  router.patch(
    "/:id/estado",
    requireRole("admin"),
    validate(cambiarEstadoSchema),
    asyncHandler(async (req, res) => {
      const tenantId = getTenantId(req);
      const { estado, motivo } = req.validatedBody as {
        estado: "activo" | "inactivo" | "bloqueado";
        motivo?: string;
      };

      if (estado !== "activo" && !motivo) {
        throw new AppError(400, "Indicá el motivo para dejarlo registrado");
      }
      if (req.params.id === req.usuario?.id) {
        // Sin esto, un admin puede dejarse afuera de su propio tenant y
        // necesitar al proveedor para volver a entrar.
        throw new AppError(400, "No podés desactivar tu propia cuenta");
      }

      const usuario = await cambiarEstadoUsuarioService(
        tenantId,
        req.params.id,
        estado,
        motivo,
        contextoAuditoriaModulo(req)
      );
      res.json(usuario);
    })
  );

  // Nombre y celular. El correo no se edita acá: es la identidad de la
  // persona, y cambiarlo sería moverla a otra cuenta.
  router.patch(
    "/:id",
    requireRole("admin"),
    validate(actualizarUsuarioSchema),
    asyncHandler(async (req, res) => {
      const cambios = req.validatedBody as { nombre?: string; celular?: string | null };
      res.json(
        await actualizarPerfilUsuarioService(
          getTenantId(req),
          req.params.id,
          cambios,
          contextoAuditoriaModulo(req)
        )
      );
    })
  );

  // ── Autonomías: qué módulos ve cada persona y con qué nivel ───────────

  router.get(
    "/:id/permisos",
    requireRole("admin"),
    asyncHandler(async (req, res) => {
      res.json(await listarPermisosUsuarioService(getTenantId(req), req.params.id));
    })
  );

  router.put(
    "/:id/permisos",
    requireRole("admin"),
    validate(guardarPermisosSchema),
    asyncHandler(async (req, res) => {
      const tenantId = getTenantId(req);
      const cambio = req.validatedBody as {
        rol?: "admin" | "operador" | "lectura" | "grifero" | "conductor_ruta";
        modulos: { modulo: string; asignado: boolean; nivel: "operar" | "consultas" }[];
        motivo?: string;
      };

      const resultado = await guardarPermisosUsuarioService(
        tenantId,
        req.params.id,
        cambio,
        req.usuario!.id
      );

      await registrarAuditoria({
        accion: "cambiar_permisos_usuario",
        tenantId,
        usuarioId: req.params.id,
        // El antes y el después completos: sin eso, meses después nadie puede
        // reconstruir por qué alguien tenía el acceso que tenía.
        detalle: {
          motivo: cambio.motivo ?? null,
          recorta: resultado.recorta,
          antes: { rol: resultado.antes.rol, modulos: resultado.antes.modulos },
          despues: { rol: resultado.despues.rol, modulos: resultado.despues.modulos },
        },
        contexto: contextoAuditoriaModulo(req),
      });

      res.json(resultado);
    })
  );

  return router;
}
