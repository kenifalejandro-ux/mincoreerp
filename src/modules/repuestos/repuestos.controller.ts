/**src/modules/repuestos/repuestos.controller.ts */

import { Request, Response } from "express";
import { withTenant } from "../../server/config/database";
import { getTenantId } from "../../server/shared/utils/request";
import { parsePaginacion, armarRespuestaPaginada } from "../../server/shared/utils/pagination";
import { contextoAuditoriaModulo } from "../../server/shared/utils/moduleAudit";
import { registrarAuditoria } from "../../server/services/platformAudit.service";
import { publicarEventoTenant } from "../../server/services/realtimeEvents.service";
import type {
  RegistrarMovimientoRepuestoInput,
  CrearRepuestoInput,
  ActualizarRepuestoInput,
  CargaMasivaRepuestosInput,
} from "../../server/schemas/repuestos.schema";
import { RepuestosService } from "./repuestos.service";

/** Los campos de la ficha que cambiaron, con sus valores. `stock` no está:
 *  no se edita por la ficha (ver RepuestosRepository.update). */
function diffFicha(
  antes: Record<string, unknown> | null,
  ahora: Record<string, unknown>
): { campo: string; de: string; a: string }[] {
  if (!antes) return [];
  const CAMPOS = ["codigo", "nombre", "categoria", "stock_minimo", "stock_maximo", "precio"];
  const cambios: { campo: string; de: string; a: string }[] = [];
  for (const campo of CAMPOS) {
    const viejo = antes[campo];
    const nuevo = ahora[campo];
    // NUMERIC vuelve de Postgres como string ("12.00"): comparar crudo
    // marcaría como cambio lo que no cambió.
    if (String(viejo ?? "") === String(nuevo ?? "")) continue;
    if (Number(viejo) === Number(nuevo) && viejo !== null && nuevo !== null) continue;
    cambios.push({ campo, de: String(viejo ?? "(vacío)"), a: String(nuevo ?? "(vacío)") });
  }
  return cambios;
}

export const RepuestosController = {
  // =========================
  // 📥 OBTENER TODO (paginado)
  // =========================
  async getAll(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const paginacion = parsePaginacion(req.query);
      const filas = await withTenant(tenantId, (client) =>
        RepuestosService.getAll(client, tenantId, paginacion)
      );
      res.json(armarRespuestaPaginada(filas, paginacion));
    } catch {
      res.status(500).json({ message: "Error al obtener repuestos" });
    }
  },

  // =========================
  // ➕ CREAR REPUESTO
  // =========================
  async create(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const data = req.validatedBody as CrearRepuestoInput;
      const nuevo = await withTenant(tenantId, (client) =>
        RepuestosService.create(client, tenantId, data)
      );
      await registrarAuditoria({
        accion: "repuestos.crear",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { repuestoId: nuevo.id },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "repuestos.creado", { repuestoId: nuevo.id });
      res.status(201).json(nuevo);
    } catch {
      res.status(500).json({ message: "Error al crear repuesto" });
    }
  },

  // =========================
  // ✏️ ACTUALIZAR REPUESTO
  // =========================
  async update(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);
      const data = req.validatedBody as ActualizarRepuestoInput;

      const { actualizado, antes } = await withTenant(tenantId, async (client) => {
        const antes = await RepuestosService.getById(client, tenantId, id);
        const actualizado = await RepuestosService.update(client, tenantId, id, data);
        return { actualizado, antes };
      });

      if (!actualizado) {
        res.status(404).json({ message: "Repuesto no encontrado" });
        return;
      }

      // Todo campo que cambió, con su valor viejo y el nuevo. Antes la
      // bitácora decía `{ repuestoId }` y nada más: "alguien editó el
      // repuesto 12" no permite reconstruir nada. Misma regla que ya rige en
      // combustible ("la visibilidad es automática, la escalada es
      // declarada"), acá aplicada al módulo que guarda existencias.
      const cambios = diffFicha(antes, actualizado);

      await registrarAuditoria({
        accion: "repuestos.actualizar",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { repuestoId: id, cambios },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "repuestos.actualizado", { repuestoId: id });
      res.json(actualizado);
    } catch {
      res.status(500).json({ message: "Error al actualizar repuesto" });
    }
  },

  // =========================
  // 🗑 ELIMINAR
  // =========================
  async delete(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);
      const eliminado = await withTenant(tenantId, (client) =>
        RepuestosService.delete(client, tenantId, id)
      );

      if (!eliminado) {
        res.status(404).json({ message: "Repuesto no encontrado" });
        return;
      }

      await registrarAuditoria({
        accion: "repuestos.eliminar",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { repuestoId: id },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "repuestos.eliminado", { repuestoId: id });
      res.json({ message: "Eliminado" });
    } catch {
      res.status(500).json({ message: "Error al eliminar" });
    }
  },

  // =========================
  // 📦 INSERCIÓN MASIVA
  // =========================
  async bulk(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      // validate(cargaMasivaRepuestosSchema) ya garantiza que es un array de
      // 1 a MAX_FILAS_CARGA_MASIVA filas válidas -- el chequeo manual de
      // Array.isArray() que había acá quedó redundante.
      const rows = req.validatedBody as CargaMasivaRepuestosInput;
      const result = await withTenant(tenantId, (client) =>
        RepuestosService.createBulk(client, tenantId, rows)
      );
      // UNA fila de auditoría con el conteo, no una por repuesto: una carga
      // de MAX_FILAS_CARGA_MASIVA filas inundaría platform_audit_log con
      // ruido y la pregunta que se le hace después a la auditoría es "quién
      // importó y cuánto", no el detalle fila por fila (eso ya está en la
      // tabla del módulo). Mismo criterio que el evento de tiempo real de
      // acá al lado y que `incremento` en cuota.middleware.ts.
      await registrarAuditoria({
        accion: "repuestos.carga_masiva",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { cantidad: result.length },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "repuestos.carga_masiva", { cantidad: result.length });
      res.status(201).json({ insertados: result.length, data: result });
    } catch {
      res.status(500).json({ message: "Error en importación masiva" });
    }
  },

  // =========================
  // 📊 KPIs
  // =========================
  async kpis(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const data = await withTenant(tenantId, (client) =>
        RepuestosService.getKPIs(client, tenantId)
      );
      res.json(data);
    } catch {
      res.status(500).json({ message: "Error KPIs" });
    }
  },

  // =========================
  // 📦 REGISTRAR MOVIMIENTO DE STOCK
  // =========================
  // POST /repuestos/movimientos -- crea un movimiento histórico y aplica su
  // delta a `stock` (ver RepuestosRepository.registrarMovimiento). Único
  // endpoint de Repuestos que participa de la cola offline: `repuesto_id`
  // viaja en el body a propósito, no en la URL -- rutasOffline.ts (motor
  // offline del cliente) solo matchea rutas literales, sin parámetros.
  async registrarMovimiento(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const data = req.validatedBody as RegistrarMovimientoRepuestoInput;
      const { fila, creado } = await withTenant(tenantId, (client) =>
        RepuestosService.registrarMovimiento(client, tenantId, req.usuario!.id, data)
      );

      if (!fila) {
        // Caso documentado por idempotentInsert(): la clave quedó
        // reservada pero la fila ya no existe (alguien la borró después).
        // No pasa hoy -- repuestos_movimientos no tiene DELETE -- pero se
        // preserva el contrato del helper en vez de asumir que no puede
        // pasar.
        res.status(200).json({ message: "Este movimiento ya se había procesado" });
        return;
      }

      // 409 y no 400: no es un dato mal formado, es un rechazo por el
      // ESTADO actual del recurso (stock insuficiente, ver
      // RepuestosRepository.registrarMovimiento) -- y es la clave de todo
      // esto: cae dentro de `esErrorPermanente()`
      // (client/src/offline/offlineSync.ts, 4xx salvo 401/408/429), así
      // que la cola offline del dispositivo lo descarta sin reintentar y
      // lo reporta -- sin tocar el motor offline ni EstadoOffline.tsx, que
      // ya son genéricos. El movimiento SÍ queda persistido (estado
      // "rechazado") para que un rechazo no se pierda sin rastro -- ver
      // migrations/0048.
      const rechazado = fila.movimiento.estado === "rechazado";

      if (!creado) {
        // Reintento de un envío que ya se había guardado (la respuesta
        // original se perdió en la red) -- responde IGUAL que la primera
        // vez, sin publicar el evento de nuevo.
        res.status(rechazado ? 409 : 200).json(fila);
        return;
      }

      if (rechazado) {
        // El rechazo SÍ se audita, con resultado "failure": el movimiento
        // quedó persistido (estado "rechazado", ver migrations/0048), así
        // que es una mutación real, y que alguien choque contra el stock
        // disponible es justamente la señal operativa que hay que poder ver
        // después -- mismo criterio que `cuota.bloqueo` en
        // cuota.middleware.ts.
        await registrarAuditoria({
          accion: "repuestos.registrar_movimiento",
          tenantId,
          usuarioId: req.usuario!.id,
          detalle: {
            movimientoId: fila.movimiento.id,
            repuestoId: data.repuesto_id,
            tipo: data.tipo,
            estado: fila.movimiento.estado,
          },
          contexto: contextoAuditoriaModulo(req),
          resultado: "failure",
        });
        res.status(409).json({ ...fila, message: "Stock insuficiente para este movimiento" });
        return;
      }

      await registrarAuditoria({
        accion: "repuestos.registrar_movimiento",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: {
          movimientoId: fila.movimiento.id,
          repuestoId: data.repuesto_id,
          tipo: data.tipo,
          estado: fila.movimiento.estado,
        },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "repuestos.movimiento_registrado", {
        movimientoId: fila.movimiento.id,
        repuestoId: data.repuesto_id,
        tipo: data.tipo,
        cantidad: data.cantidad,
      });
      res.status(201).json(fila);
    } catch (err) {
      if (err instanceof Error && err.message.includes("no existe en este tenant")) {
        res.status(400).json({ message: err.message });
        return;
      }
      res.status(500).json({ message: "Error al registrar movimiento de repuesto" });
    }
  },
};
