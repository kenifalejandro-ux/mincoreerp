/**src/modules/repuestos/repuestos.service.ts */

import type { PoolClient } from "pg";
import type { Paginacion } from "../../server/shared/utils/pagination";
import type {
  RegistrarMovimientoRepuestoInput,
  CrearRepuestoInput,
  ActualizarRepuestoInput,
  CargaMasivaRepuestosInput,
} from "../../server/schemas/repuestos.schema";
import { idempotentInsert } from "../../server/shared/utils/idempotentInsert";
import { RepuestosRepository } from "./repuestos.repository";

export const RepuestosService = {
  // 📥 traer todo (paginado)
  getAll(client: PoolClient, tenantId: string, paginacion: Paginacion) {
    return RepuestosRepository.findAll(client, tenantId, paginacion);
  },

  // ➕ crear
  create(client: PoolClient, tenantId: string, data: CrearRepuestoInput) {
    return RepuestosRepository.create(client, tenantId, data);
  },

  // ✏️ actualizar
  getById(client: PoolClient, tenantId: string, id: number) {
    return RepuestosRepository.findById(client, tenantId, id);
  },

  update(client: PoolClient, tenantId: string, id: number, data: ActualizarRepuestoInput) {
    return RepuestosRepository.update(client, tenantId, id, data);
  },

  // 🗑 eliminar
  delete(client: PoolClient, tenantId: string, id: number) {
    return RepuestosRepository.delete(client, tenantId, id);
  },

  // 📦 bulk
  createBulk(client: PoolClient, tenantId: string, rows: CargaMasivaRepuestosInput) {
    return RepuestosRepository.createBulk(client, tenantId, rows);
  },

  // 📊 KPIs
  getKPIs(client: PoolClient, tenantId: string) {
    return RepuestosRepository.getDashboardKPIs(client, tenantId);
  },

  // 📦 registrar movimiento de stock (entrada/salida)
  // Devuelve `creado: false` cuando este movimiento ya se había registrado
  // con el mismo `cliente_uuid` -- el reintento de un envío cuya respuesta
  // se perdió. El controller usa ese flag para no publicar el evento de
  // nuevo. Sin `cliente_uuid` en el body, siempre crea (mismo molde que
  // CombustibleService.registrarLectura).
  registrarMovimiento(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    data: RegistrarMovimientoRepuestoInput
  ) {
    return idempotentInsert({
      client,
      tenantId,
      modulo: "repuestos",
      clienteUuid: data.cliente_uuid,
      insertar: async () => {
        const fila = await RepuestosRepository.registrarMovimiento(client, tenantId, {
          repuestoId: data.repuesto_id,
          tipo: data.tipo,
          cantidad: data.cantidad,
          motivo: data.motivo ?? null,
          registradoEn: data.registrado_en ?? new Date().toISOString(),
          usuarioId,
          metadata: data.metadata ?? {},
          ordenTrabajoId: data.orden_trabajo_id ?? null,
        });
        return { id: Number(fila.movimiento.id), fila };
      },
      recuperar: (filaId) =>
        RepuestosRepository.findMovimientoConRepuesto(client, tenantId, filaId),
    });
  },
};
