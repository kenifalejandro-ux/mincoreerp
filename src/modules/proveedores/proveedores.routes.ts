/** src/modules/proveedores/proveedores.routes.ts
 *
 * Ecosistema «Gestión de proveedores» (PR1, solo lectura): resumen del Centro de gestión, listado del
 * Directorio y ficha.
 *
 * Sin permiso de pestaña a propósito: el acceso lo da el MÓDULO asignado a cada persona (los perfiles
 * de cancha no lo reciben por su rol, ver MODULOS_POR_ROL) y el perfil Lectura mira pero no escribe
 * (requireNivelParaEscribir corta los métodos de escritura). Una pestaña más agrandaría la cookie de
 * sesión, que ya está cerca de su tope (tests/combustible-historial-compras-conductor.test.ts, A-4).
 */
import { Router, type Request, type Response } from "express";

import { withTenant } from "../../server/config/database";
import { AppError } from "../../server/shared/middlewares/error.middleware";
import { asyncHandler } from "../../server/shared/utils/asyncHandler";
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

export default router;
