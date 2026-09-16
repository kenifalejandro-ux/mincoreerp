/** src/modules/iperc/iperc.controller.ts */

import { Request, Response } from "express";
import { withTenant } from "../../server/config/database";
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
  CrearIpercInput,
  CambiarEstadoIpercInput,
  CrearLineaBaseInput,
} from "../../server/schemas/iperc.schema";
import { IpercService } from "./iperc.service";

export const IpercController = {
  async getAll(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const paginacion = parseCursorPaginacion(req.query);
      const tipo = typeof req.query.tipo === "string" ? req.query.tipo : undefined;
      const filas = await withTenant(tenantId, (client) =>
        IpercService.getAll(client, tenantId, paginacion, tipo)
      );
      res.json(armarRespuestaCursor(filas, paginacion.pageSize));
    } catch {
      res.status(500).json({ message: "Error al obtener IPERC" });
    }
  },

  async getById(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const iperc = await withTenant(tenantId, (client) =>
        IpercService.getById(client, tenantId, Number(req.params.id))
      );
      if (!iperc) {
        res.status(404).json({ message: "IPERC no encontrado" });
        return;
      }
      res.json(iperc);
    } catch {
      res.status(500).json({ message: "Error al obtener IPERC" });
    }
  },

  async crear(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const data = req.validatedBody as CrearIpercInput;
      const { fila: iperc, creado } = await withTenant(tenantId, (client) =>
        IpercService.crear(client, tenantId, req.usuario!.id, data)
      );

      // Reintento de un envío que ya se había guardado (la respuesta
      // original se perdió en la red). No se audita ni se publica el
      // evento de nuevo -- eso ya pasó la primera vez. 200 y no 201 porque
      // esta llamada no creó nada, pero sí es un éxito para la cola offline
      // del dispositivo.
      if (!creado) {
        res
          .status(200)
          .json(iperc ?? { message: "Este IPERC ya se había registrado y luego se eliminó" });
        return;
      }

      await registrarAuditoria({
        accion: "iperc.crear",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { ipercId: iperc!.id, tipo: data.tipo },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "iperc.creado", { ipercId: iperc!.id, tipo: data.tipo });
      res.status(201).json(iperc);
    } catch (err) {
      if (err instanceof Error && err.message.includes("no existe en este tenant")) {
        res.status(400).json({ message: err.message });
        return;
      }
      res.status(500).json({ message: "Error al crear IPERC" });
    }
  },

  async cambiarEstado(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);
      const { estado } = req.validatedBody as CambiarEstadoIpercInput;
      const resultado = await withTenant(tenantId, (client) =>
        IpercService.cambiarEstado(client, tenantId, id, estado, req.usuario!.id)
      );
      if (!resultado.ok) {
        if (resultado.motivo === "no_encontrado") {
          res.status(404).json({ message: "IPERC no encontrado" });
          return;
        }
        // 409, no 500: dos personas (ej. supervisor y gerente) intentando
        // aprobar/rechazar el mismo IPERC casi al mismo tiempo -- quien
        // llega segundo se entera de que ya no está en borrador, en vez
        // de pisar en silencio lo que decidió el primero.
        res.status(409).json({
          message: `El IPERC ya fue procesado (estado actual: ${resultado.estadoActual})`,
        });
        return;
      }
      // ¿Aprobó el mismo que lo redactó? No se bloquea --una operación chica
      // puede tener un solo admin-- pero un IPERC aprobado por su propio
      // autor no es una revisión, y el que audita tiene que poder encontrarlo
      // sin abrir uno por uno (mismo criterio que la autorrevisión de
      // alertas de combustible).
      const autoaprobado =
        resultado.fila.usuario_id != null && resultado.fila.usuario_id === req.usuario!.id;

      await registrarAuditoria({
        accion: autoaprobado ? "iperc.autoaprobado" : "iperc.cambiar_estado",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { ipercId: id, estado, autoaprobado },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "iperc.estado_cambiado", { ipercId: id, estado });
      res.json(resultado.fila);
    } catch {
      res.status(500).json({ message: "Error al cambiar estado del IPERC" });
    }
  },

  async eliminar(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);
      const resultado = await withTenant(tenantId, (client) =>
        IpercService.eliminar(client, tenantId, id)
      );
      if (!resultado.ok) {
        if (resultado.motivo === "no_encontrado") {
          res.status(404).json({ message: "IPERC no encontrado" });
          return;
        }
        // Un IPERC aprobado es el registro de que alguien evaluó y autorizó
        // el riesgo de una tarea: es lo que se presenta en una fiscalización
        // o después de un accidente. No se borra.
        res.status(409).json({
          message:
            `Este IPERC está ${resultado.estadoActual} y no se puede eliminar. ` +
            `Solo se eliminan los que siguen en borrador.`,
        });
        return;
      }
      await registrarAuditoria({
        accion: "iperc.eliminar",
        tenantId,
        usuarioId: req.usuario!.id,
        // El CONTENIDO de lo que se borró, no solo el id: un DELETE deja la
        // fila fuera de la base para siempre, y "se eliminó el IPERC #12" no
        // le sirve a nadie seis meses después.
        detalle: { ipercId: id, eliminado: resultado.fila },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "iperc.eliminado", { ipercId: id });
      res.json({ message: "Eliminado" });
    } catch {
      res.status(500).json({ message: "Error al eliminar IPERC" });
    }
  },

  // ── Línea Base ───────────────────────────────────────────────────────
  async getLineasBase(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const paginacion = parsePaginacion(req.query);
      const filas = await withTenant(tenantId, (client) =>
        IpercService.getLineasBase(client, tenantId, paginacion)
      );
      res.json(armarRespuestaPaginada(filas, paginacion));
    } catch {
      res.status(500).json({ message: "Error al obtener líneas base" });
    }
  },

  async getLineaBase(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const lineaBase = await withTenant(tenantId, (client) =>
        IpercService.getLineaBase(client, tenantId, Number(req.params.id))
      );
      if (!lineaBase) {
        res.status(404).json({ message: "Línea base no encontrada" });
        return;
      }
      res.json(lineaBase);
    } catch {
      res.status(500).json({ message: "Error al obtener línea base" });
    }
  },

  async crearLineaBase(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const data = req.validatedBody as CrearLineaBaseInput;
      const lineaBase = await withTenant(tenantId, (client) =>
        IpercService.crearLineaBase(client, tenantId, req.usuario!.id, data)
      );
      await registrarAuditoria({
        accion: "iperc.crear_linea_base",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { lineaBaseId: lineaBase.id },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "iperc.linea_base_creada", {
        lineaBaseId: lineaBase.id,
      });
      res.status(201).json(lineaBase);
    } catch {
      res.status(500).json({ message: "Error al crear línea base" });
    }
  },

  async cambiarEstadoLineaBase(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);
      const { estado } = req.validatedBody as CambiarEstadoIpercInput;
      const resultado = await withTenant(tenantId, (client) =>
        IpercService.cambiarEstadoLineaBase(client, tenantId, id, estado, req.usuario!.id)
      );
      if (!resultado.ok) {
        if (resultado.motivo === "no_encontrado") {
          res.status(404).json({ message: "Línea base no encontrada" });
          return;
        }
        // 409, mismo motivo que cambiarEstado(): dos aprobaciones/
        // rechazos casi simultáneos ya no se pisan en silencio.
        res.status(409).json({
          message: `La línea base ya fue procesada (estado actual: ${resultado.estadoActual})`,
        });
        return;
      }
      await registrarAuditoria({
        accion: "iperc.cambiar_estado_linea_base",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { lineaBaseId: id, estado },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "iperc.linea_base_estado_cambiado", {
        lineaBaseId: id,
        estado,
      });
      res.json(resultado.fila);
    } catch {
      res.status(500).json({ message: "Error al cambiar estado de la línea base" });
    }
  },

  async eliminarLineaBase(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);
      const resultado = await withTenant(tenantId, (client) =>
        IpercService.eliminarLineaBase(client, tenantId, id)
      );
      if (!resultado.ok) {
        if (resultado.motivo === "no_encontrado") {
          res.status(404).json({ message: "Línea base no encontrada" });
          return;
        }
        res.status(409).json({
          message:
            `Esta línea base está ${resultado.estadoActual} y no se puede eliminar. ` +
            `Los IPERC emitidos con ella la referencian.`,
        });
        return;
      }
      await registrarAuditoria({
        accion: "iperc.eliminar_linea_base",
        tenantId,
        usuarioId: req.usuario!.id,
        // El contenido, no solo el id: un DELETE la saca de la base para
        // siempre (mismo criterio que el IPERC).
        detalle: { lineaBaseId: id, eliminada: resultado.fila },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "iperc.linea_base_eliminada", { lineaBaseId: id });
      res.json({ message: "Eliminada" });
    } catch {
      res.status(500).json({ message: "Error al eliminar línea base" });
    }
  },
};
