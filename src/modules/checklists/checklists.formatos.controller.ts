/** src/modules/checklists/checklists.formatos.controller.ts
 *
 * Las rutas de versiones de formato (E5-1): ver, editar, volver a una anterior y activar o desactivar. La lógica
 * está en checklists.versiones.ts. Cada cambio queda en la auditoría de la empresa y avisa a las pantallas. */
import type { Request, Response } from "express";

import {
  cambiarActiva,
  editarFormato,
  listarVersiones,
  restaurarVersion,
} from "./checklists.versiones";
import { withTenant } from "../../server/config/database";
import type { EditarPlantillaInput } from "../../server/schemas/checklists.schema";
import { registrarAuditoria } from "../../server/services/platformAudit.service";
import { publicarEventoTenant } from "../../server/services/realtimeEvents.service";
import { contextoAuditoriaModulo } from "../../server/shared/utils/moduleAudit";
import { getTenantId } from "../../server/shared/utils/request";

async function dejarRastro(req: Request, accion: string, detalle: Record<string, unknown>) {
  const tenantId = getTenantId(req);
  await registrarAuditoria({
    accion,
    tenantId,
    usuarioId: req.usuario!.id,
    detalle,
    contexto: contextoAuditoriaModulo(req),
  });
  await publicarEventoTenant(tenantId, "checklists.plantilla_actualizada", {
    plantillaId: Number(req.params.id),
  });
}

export const FormatosController = {
  async versiones(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    res.json(
      await withTenant(tenantId, (client) =>
        listarVersiones(client, tenantId, Number(req.params.id))
      )
    );
  },

  async editar(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    const id = Number(req.params.id);
    const datos = req.validatedBody as EditarPlantillaInput;
    const version = await withTenant(tenantId, (client) =>
      editarFormato(client, tenantId, req.usuario!.id, id, datos)
    );
    await dejarRastro(req, "checklists.editar_plantilla", { plantillaId: id, version });
    res.json({ id, version });
  },

  async restaurar(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    const id = Number(req.params.id);
    const anterior = Number(req.params.version);
    const { version_base } = req.validatedBody as { version_base: number };
    const version = await withTenant(tenantId, (client) =>
      restaurarVersion(client, tenantId, req.usuario!.id, id, anterior, version_base)
    );
    await dejarRastro(req, "checklists.restaurar_plantilla", {
      plantillaId: id,
      version,
      desde: anterior,
    });
    res.json({ id, version });
  },

  async estado(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    const id = Number(req.params.id);
    const { activa } = req.validatedBody as { activa: boolean };
    const plantilla = await withTenant(tenantId, (client) =>
      cambiarActiva(client, tenantId, id, activa)
    );
    await dejarRastro(req, "checklists.estado_plantilla", { plantillaId: id, activa });
    res.json(plantilla);
  },
};
