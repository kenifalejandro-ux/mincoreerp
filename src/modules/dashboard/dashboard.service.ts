/** src/modules/dashboard/dashboard.service.ts */
import type { PoolClient } from "pg";
import { DashboardRepository } from "./dashboard.repository";

/**
 * Qué módulos tiene quien pide el Dashboard. El Dashboard no tiene datos propios: cada tarjeta y
 * cada gráfico es enriquecimiento de OTRO módulo (`opcionales` en src/modules/registry.ts). Sin el
 * módulo NO se ejecuta su consulta: la parte se omite (sin 403, sin leer la tabla ajena), y la clave
 * no aparece en la respuesta.
 */
export interface ModulosDelDashboard {
  repuestos: boolean;
  combustible: boolean;
  documentos: boolean;
}

export const DashboardService = {
  /**
   * Ejecuta las consultas de los módulos que hay y retorna un objeto único con el formato
   * que el Dashboard.tsx espera. Comparten un mismo client (ver
   * withTenant en database.ts) para que RLS vea el mismo tenant en todas —
   * por eso corren en secuencia y no con Promise.all: un PoolClient de
   * node-postgres no soporta queries concurrentes sobre la misma conexión.
   */
  async getFullDashboardData(client: PoolClient, tenantId: string, modulos: ModulosDelDashboard) {
    const datos: Record<string, unknown> = await DashboardService.getKPIs(
      client,
      tenantId,
      modulos
    );

    if (modulos.repuestos) {
      datos.inventario_categoria = await DashboardRepository.repuestosPorCategoria(
        client,
        tenantId
      );
      datos.valor_categoria = await DashboardRepository.valorPorCategoria(client, tenantId);
    }
    if (modulos.documentos) {
      datos.documentos_estado = await DashboardRepository.estadoDocumentos(client, tenantId);
    }
    if (modulos.repuestos) {
      datos.stock_vs_minimo = await DashboardRepository.nivelstock(client, tenantId);
    }
    return datos;
  },

  async getKPIs(client: PoolClient, tenantId: string, modulos: ModulosDelDashboard) {
    return {
      ...(modulos.repuestos ? await DashboardRepository.getKPIsRepuestos(client, tenantId) : {}),
      ...(modulos.combustible ? await DashboardRepository.getKPICombustible(client, tenantId) : {}),
      ...(modulos.documentos ? await DashboardRepository.getKPIsDocumentos(client, tenantId) : {}),
    };
  },

  // Las rutas sueltas: sin el módulo responden vacío (200), no un error.
  async repuestosPorCategoria(client: PoolClient, tenantId: string, modulos: ModulosDelDashboard) {
    return modulos.repuestos ? DashboardRepository.repuestosPorCategoria(client, tenantId) : [];
  },

  async valorPorCategoria(client: PoolClient, tenantId: string, modulos: ModulosDelDashboard) {
    return modulos.repuestos ? DashboardRepository.valorPorCategoria(client, tenantId) : [];
  },

  async estadoDocumentos(client: PoolClient, tenantId: string, modulos: ModulosDelDashboard) {
    return modulos.documentos ? DashboardRepository.estadoDocumentos(client, tenantId) : [];
  },

  async nivelstock(client: PoolClient, tenantId: string, modulos: ModulosDelDashboard) {
    return modulos.repuestos ? DashboardRepository.nivelstock(client, tenantId) : [];
  },
};
