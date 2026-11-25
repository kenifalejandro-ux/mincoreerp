/** src/modules/checklists/checklists.controller.ts */

import { Request, Response } from "express";
import { withTenant } from "../../server/config/database";
import { tieneUnidades } from "../../server/shared/utils/modulos";
import { getTenantId } from "../../server/shared/utils/request";
import {
  parsePaginacion,
  armarRespuestaPaginada,
  parseCursorPaginacion,
  armarRespuestaCursor,
} from "../../server/shared/utils/pagination";
import { contextoAuditoriaModulo } from "../../server/shared/utils/moduleAudit";
import { registrarAuditoria } from "../../server/services/platformAudit.service";
import { publicarEventoTenant } from "../../server/services/realtimeEvents.service";
import type {
  CrearPlantillaInput,
  CrearChecklistInput,
} from "../../server/schemas/checklists.schema";
import { ChecklistsService } from "./checklists.service";

export const ChecklistsController = {
  async getPlantillas(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const paginacion = parsePaginacion(req.query);
      const filas = await withTenant(tenantId, (client) =>
        ChecklistsService.getPlantillas(client, tenantId, paginacion)
      );
      res.json(armarRespuestaPaginada(filas, paginacion));
    } catch {
      res.status(500).json({ message: "Error al obtener plantillas" });
    }
  },

  async getPlantilla(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const plantilla = await withTenant(tenantId, (client) =>
        ChecklistsService.getPlantilla(client, tenantId, Number(req.params.id))
      );
      if (!plantilla) {
        res.status(404).json({ message: "Plantilla no encontrada" });
        return;
      }
      res.json(plantilla);
    } catch {
      res.status(500).json({ message: "Error al obtener plantilla" });
    }
  },

  async crearPlantilla(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const data = req.validatedBody as CrearPlantillaInput;
      const plantilla = await withTenant(tenantId, (client) =>
        ChecklistsService.crearPlantilla(client, tenantId, data)
      );
      await registrarAuditoria({
        accion: "checklists.crear_plantilla",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { plantillaId: plantilla.id },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "checklists.plantilla_creada", {
        plantillaId: plantilla.id,
      });
      res.status(201).json(plantilla);
    } catch {
      res.status(500).json({ message: "Error al crear plantilla" });
    }
  },

  async eliminarPlantilla(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);
      const eliminado = await withTenant(tenantId, (client) =>
        ChecklistsService.eliminarPlantilla(client, tenantId, id)
      );
      if (!eliminado) {
        res.status(404).json({ message: "Plantilla no encontrada" });
        return;
      }
      await registrarAuditoria({
        accion: "checklists.eliminar_plantilla",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { plantillaId: id },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "checklists.plantilla_eliminada", { plantillaId: id });
      res.json({ message: "Eliminada" });
    } catch (error) {
      // Con checklists ya llenados la base no deja borrarlo: se desactiva en su lugar.
      if ((error as { code?: string }).code === "23503") {
        res.status(409).json({
          message: "Este formato ya tiene checklists llenados: desactívalo en lugar de borrarlo",
        });
        return;
      }
      res.status(500).json({ message: "Error al eliminar plantilla" });
    }
  },

  async getAll(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const paginacion = parseCursorPaginacion(req.query);
      const filas = await withTenant(tenantId, (client) =>
        ChecklistsService.getAll(client, tenantId, paginacion, tieneUnidades(req.usuario))
      );
      res.json(armarRespuestaCursor(filas, paginacion.pageSize));
    } catch {
      res.status(500).json({ message: "Error al obtener checklists" });
    }
  },

  async getById(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const checklist = await withTenant(tenantId, (client) =>
        ChecklistsService.getById(
          client,
          tenantId,
          Number(req.params.id),
          tieneUnidades(req.usuario)
        )
      );
      if (!checklist) {
        res.status(404).json({ message: "Checklist no encontrado" });
        return;
      }
      res.json(checklist);
    } catch {
      res.status(500).json({ message: "Error al obtener checklist" });
    }
  },

  async crear(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const data = req.validatedBody as CrearChecklistInput;
      // La unidad viene del maestro (Flota o Mantenimiento): sin ninguno de los dos el checklist se identifica por el texto
      // (`opcionales` en registry.ts). Se rechaza en vez de ignorarla, para que el cliente se entere.
      const conUnidades = tieneUnidades(req.usuario);
      if (data.equipo_id !== undefined && !conUnidades) {
        res.status(400).json({
          message: "Esta empresa no tiene Registro de unidades: escribe el activo o lugar en texto",
        });
        return;
      }
      const { fila: checklist, creado } = await withTenant(tenantId, (client) =>
        ChecklistsService.crear(client, tenantId, req.usuario!.id, data, conUnidades)
      );

      // Reintento de un envío que ya se había guardado (la respuesta
      // original se perdió en la red). No se audita ni se publica el evento
      // de nuevo: eso ya pasó la primera vez, y repetirlo le mostraría a
      // los demás usuarios un checklist "nuevo" que no existe. 200 y no
      // 201 porque esta llamada no creó nada — pero sí es un éxito, así que
      // la cola offline del dispositivo puede darlo por sincronizado.
      if (!creado) {
        res
          .status(200)
          .json(
            checklist ?? { message: "Este checklist ya se había registrado y luego se eliminó" }
          );
        return;
      }

      await registrarAuditoria({
        accion: "checklists.crear",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: {
          checklistId: checklist!.id,
          equipoId: data.equipo_id ?? null,
          activo: data.activo_texto ?? null,
        },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "checklists.creado", {
        checklistId: checklist!.id,
        equipoId: data.equipo_id ?? null,
      });
      res.status(201).json(checklist);
    } catch {
      res.status(500).json({ message: "Error al crear checklist" });
    }
  },

  async eliminar(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);
      const eliminado = await withTenant(tenantId, (client) =>
        ChecklistsService.eliminar(client, tenantId, id)
      );
      if (!eliminado) {
        res.status(404).json({ message: "Checklist no encontrado" });
        return;
      }
      await registrarAuditoria({
        accion: "checklists.eliminar",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { checklistId: id },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "checklists.eliminado", { checklistId: id });
      res.json({ message: "Eliminado" });
    } catch {
      res.status(500).json({ message: "Error al eliminar checklist" });
    }
  },
};
