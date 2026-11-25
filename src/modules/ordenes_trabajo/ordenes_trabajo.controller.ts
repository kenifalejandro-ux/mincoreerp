/** src/modules/ordenes_trabajo/ordenes_trabajo.controller.ts */

import { Request, Response } from "express";
import { withTenant } from "../../server/config/database";
import { tieneUnidades } from "../../server/shared/utils/modulos";
import { getTenantId } from "../../server/shared/utils/request";
import { parsePaginacion, armarRespuestaPaginada } from "../../server/shared/utils/pagination";
import { contextoAuditoriaModulo } from "../../server/shared/utils/moduleAudit";
import { registrarAuditoria } from "../../server/services/platformAudit.service";
import { publicarEventoTenant } from "../../server/services/realtimeEvents.service";
import type {
  CrearOrdenTrabajoInput,
  ActualizarOrdenTrabajoInput,
  CambiarEstadoOrdenTrabajoInput,
} from "../../server/schemas/ordenes_trabajo.schema";
import { OrdenSinActivoError } from "./ordenes_trabajo.repository";
import { OrdenesTrabajoService } from "./ordenes_trabajo.service";

export const OrdenesTrabajoController = {
  async getUsuariosAsignables(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const usuarios = await withTenant(tenantId, (client) =>
        OrdenesTrabajoService.getUsuariosAsignables(client, tenantId)
      );
      res.json(usuarios);
    } catch {
      res.status(500).json({ message: "Error al obtener usuarios asignables" });
    }
  },

  async getAll(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const paginacion = parsePaginacion(req.query);
      const estado = typeof req.query.estado === "string" ? req.query.estado : undefined;
      const equipoIdRaw = req.query.equipo_id;
      const equipoId =
        typeof equipoIdRaw === "string" && equipoIdRaw.trim() !== ""
          ? Number(equipoIdRaw)
          : undefined;
      const asignadoA = typeof req.query.asignado_a === "string" ? req.query.asignado_a : undefined;
      const filas = await withTenant(tenantId, (client) =>
        OrdenesTrabajoService.getAll(
          client,
          tenantId,
          paginacion,
          { estado, equipoId, asignadoA },
          tieneUnidades(req.usuario)
        )
      );
      res.json(armarRespuestaPaginada(filas, paginacion));
    } catch {
      res.status(500).json({ message: "Error al obtener órdenes de trabajo" });
    }
  },

  async getById(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const ordenTrabajo = await withTenant(tenantId, (client) =>
        OrdenesTrabajoService.getById(
          client,
          tenantId,
          Number(req.params.id),
          tieneUnidades(req.usuario)
        )
      );
      if (!ordenTrabajo) {
        res.status(404).json({ message: "Orden de trabajo no encontrada" });
        return;
      }
      res.json(ordenTrabajo);
    } catch {
      res.status(500).json({ message: "Error al obtener la orden de trabajo" });
    }
  },

  async crear(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const data = req.validatedBody as CrearOrdenTrabajoInput;
      // La unidad viene del maestro (Flota o Mantenimiento): sin ninguno de los dos la orden se identifica por el texto
      // (`opcionales` en registry.ts). Se rechaza en vez de ignorarla, para que el cliente se entere.
      const conUnidades = tieneUnidades(req.usuario);
      if (data.equipo_id !== undefined && !conUnidades) {
        res.status(400).json({
          message: "Esta empresa no tiene Registro de unidades: escribe el activo o lugar en texto",
        });
        return;
      }
      const { fila, creado } = await withTenant(tenantId, (client) =>
        OrdenesTrabajoService.crear(client, tenantId, req.usuario!.id, data, conUnidades)
      );

      // Reintento de un envío que ya se había guardado (la respuesta
      // original se perdió en la red, o quedó en la cola offline). No se
      // audita ni se publica el evento de nuevo -- eso ya pasó la primera
      // vez. 200 y no 201 porque esta llamada no creó nada, pero sí es un
      // éxito para la cola offline del dispositivo.
      if (!creado) {
        res
          .status(200)
          .json(
            fila ?? { message: "Esta orden de trabajo ya se había registrado y luego se eliminó" }
          );
        return;
      }

      await registrarAuditoria({
        accion: "ordenes_trabajo.crear",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: {
          ordenTrabajoId: fila!.id,
          equipoId: data.equipo_id ?? null,
          activo: data.activo_texto ?? null,
          asignadoA: data.asignado_a,
        },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "ordenes_trabajo.creada", {
        ordenTrabajoId: fila!.id,
        equipoId: data.equipo_id ?? null,
      });
      res.status(201).json(fila);
    } catch (err) {
      if (err instanceof Error && err.message.includes("no existe en este tenant")) {
        res.status(400).json({ message: err.message });
        return;
      }
      res.status(500).json({ message: "Error al crear la orden de trabajo" });
    }
  },

  async actualizar(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);
      const data = req.validatedBody as ActualizarOrdenTrabajoInput;
      const ordenTrabajo = await withTenant(tenantId, (client) =>
        OrdenesTrabajoService.actualizar(client, tenantId, id, data)
      );
      if (!ordenTrabajo) {
        res.status(404).json({ message: "Orden de trabajo no encontrada" });
        return;
      }
      await registrarAuditoria({
        accion: "ordenes_trabajo.actualizar",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { ordenTrabajoId: id, asignadoA: data.asignado_a },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "ordenes_trabajo.actualizada", { ordenTrabajoId: id });
      res.json(ordenTrabajo);
    } catch (err) {
      if (
        err instanceof OrdenSinActivoError ||
        (err instanceof Error && err.message.includes("no existe en este tenant"))
      ) {
        res.status(400).json({ message: (err as Error).message });
        return;
      }
      res.status(500).json({ message: "Error al actualizar la orden de trabajo" });
    }
  },

  async cambiarEstado(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);
      const { estado, observaciones_cierre } = req.validatedBody as CambiarEstadoOrdenTrabajoInput;
      const resultado = await withTenant(tenantId, (client) =>
        OrdenesTrabajoService.cambiarEstado(client, tenantId, id, estado, observaciones_cierre)
      );
      if (!resultado.ok) {
        if (resultado.motivo === "no_encontrado") {
          res.status(404).json({ message: "Orden de trabajo no encontrada" });
          return;
        }
        // 409, no 500: cubre tanto un salto inválido (abierta -> completada)
        // como la carrera real (dos personas transicionando casi al mismo
        // tiempo) -- mismo criterio que IpercController.cambiarEstado.
        res.status(409).json({
          message: `La orden de trabajo no admite esa transición desde su estado actual (estado actual: ${resultado.estadoActual})`,
        });
        return;
      }
      await registrarAuditoria({
        accion: "ordenes_trabajo.cambiar_estado",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { ordenTrabajoId: id, estado },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "ordenes_trabajo.estado_cambiado", {
        ordenTrabajoId: id,
        estado,
      });
      res.json(resultado.fila);
    } catch {
      res.status(500).json({ message: "Error al cambiar el estado de la orden de trabajo" });
    }
  },

  async eliminar(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);
      const eliminado = await withTenant(tenantId, (client) =>
        OrdenesTrabajoService.eliminar(client, tenantId, id)
      );
      if (!eliminado) {
        res.status(404).json({ message: "Orden de trabajo no encontrada" });
        return;
      }
      await registrarAuditoria({
        accion: "ordenes_trabajo.eliminar",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { ordenTrabajoId: id },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "ordenes_trabajo.eliminada", { ordenTrabajoId: id });
      res.json({ message: "Eliminada" });
    } catch {
      res.status(500).json({ message: "Error al eliminar la orden de trabajo" });
    }
  },
};
