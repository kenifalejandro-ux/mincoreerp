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
 * No expone los módulos por usuario (`usuario_modulos`): qué módulos tiene
 * contratada una empresa es parte del contrato comercial, y sigue siendo
 * decisión de plataforma. El admin del tenant reparte a su gente dentro de
 * lo que ya tiene, no se auto-habilita módulos.
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
} from "../services/platform.service";
import {
  crearUsuarioEnTenantSchema,
  type CrearUsuarioEnTenantInput,
} from "../schemas/platform.schema";

const resetClaveSchema = z.object({
  password: z.string().min(8, "La contraseña debe tener al menos 8 caracteres").max(200),
});

const cambiarEstadoSchema = z.object({
  activo: z.boolean(),
  /** Obligatorio al DESACTIVAR (se chequea en el handler, no acá, porque
   *  depende de `activo`): dejar a alguien afuera del sistema es una acción
   *  correctiva, y el módulo ya exige motivo para todas las demás -- anular
   *  un vale, aflojar un umbral. */
  motivo: z.string().trim().min(1).max(500).optional(),
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
        // Nunca la contraseña, obviamente: solo a quién se le cambió.
        detalle: { identificador: usuario.email ?? usuario.dni },
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
      const { activo, motivo } = req.validatedBody as { activo: boolean; motivo?: string };

      if (!activo && !motivo) {
        throw new AppError(400, "Indicá el motivo de la baja para dejarlo registrado");
      }
      if (req.params.id === req.usuario?.id) {
        // Sin esto, un admin puede dejarse afuera de su propio tenant y
        // necesitar al proveedor para volver a entrar.
        throw new AppError(400, "No podés desactivar tu propia cuenta");
      }

      const usuario = await cambiarEstadoUsuarioService(
        tenantId,
        req.params.id,
        activo,
        motivo,
        contextoAuditoriaModulo(req)
      );
      res.json(usuario);
    })
  );

  return router;
}
