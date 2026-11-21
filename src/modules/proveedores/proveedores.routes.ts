/** src/modules/proveedores/proveedores.routes.ts
 *
 * Ecosistema «Gestión de proveedores» (PR1, solo lectura): resumen del Centro de gestión, listado del
 * Directorio y ficha; el PR2 suma el alta y la edición (POST y PUT).
 *
 * Sin permiso de pestaña a propósito: el acceso lo da el MÓDULO asignado a cada persona (los perfiles
 * de cancha no lo reciben por su rol, ver MODULOS_POR_ROL) y el perfil Lectura mira pero no escribe
 * (requireNivelParaEscribir corta los métodos de escritura). Una pestaña más agrandaría la cookie de
 * sesión, que ya está cerca de su tope (tests/combustible-historial-compras-conductor.test.ts, A-4).
 */
import { Router, type Request, type Response } from "express";

import { withTenant } from "../../server/config/database";
import { validate } from "../../server/middleware/validate";
import {
  actualizarProveedorSchema,
  crearProveedorSchema,
  type ActualizarProveedorInput,
  type CrearProveedorInput,
} from "../../server/schemas/proveedores.schema";
import { registrarAuditoria } from "../../server/services/platformAudit.service";
import { AppError } from "../../server/shared/middlewares/error.middleware";
import { requireRole } from "../../server/shared/middlewares/roles.middleware";
import { asyncHandler } from "../../server/shared/utils/asyncHandler";
import { contextoAuditoriaModulo } from "../../server/shared/utils/moduleAudit";
import { getTenantId } from "../../server/shared/utils/request";
import { ProveedoresService } from "./proveedores.service";

const router = Router();
const service = new ProveedoresService();

router.get(
  "/resumen",
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    res.json(await withTenant(tenantId, (client) => service.resumen(client, tenantId)));
  })
);

router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    res.json(await withTenant(tenantId, (client) => service.listar(client, tenantId)));
  })
);

router.get(
  "/:id(\\d+)",
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) throw new AppError(400, "Proveedor inválido");
    res.json(await withTenant(tenantId, (client) => service.detalle(client, tenantId, id)));
  })
);

// PR2: alta y edición. Solo admin y operador (Lectura y los módulos en «Consultas» los corta
// requireNivelParaEscribir al montar el router). La auditoría lleva ids y banderas, no el contenido.
router.post(
  "/",
  requireRole("admin", "operador"),
  validate(crearProveedorSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    const data = req.validatedBody as CrearProveedorInput;
    const proveedor = await withTenant(tenantId, (client) =>
      service.crear(client, tenantId, req.usuario!.id, data)
    );
    await registrarAuditoria({
      accion: "proveedores.crear",
      tenantId,
      usuarioId: req.usuario!.id,
      detalle: {
        proveedorId: proveedor.id,
        conRuc: proveedor.ruc !== null,
        tipos: proveedor.tipos,
      },
      contexto: contextoAuditoriaModulo(req),
    });
    res.status(201).json(proveedor);
  })
);

router.put(
  "/:id(\\d+)",
  requireRole("admin", "operador"),
  validate(actualizarProveedorSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) throw new AppError(400, "Proveedor inválido");
    const data = req.validatedBody as ActualizarProveedorInput;
    const proveedor = await withTenant(tenantId, (client) =>
      service.actualizar(client, tenantId, id, data)
    );
    await registrarAuditoria({
      accion: "proveedores.actualizar",
      tenantId,
      usuarioId: req.usuario!.id,
      detalle: { proveedorId: id, activo: proveedor.activo, tipos: proveedor.tipos },
      contexto: contextoAuditoriaModulo(req),
    });
    res.json(proveedor);
  })
);

export default router;
