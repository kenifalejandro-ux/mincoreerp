/** src/modules/dashboard/dashboard.controller.ts */

import { Request, Response } from "express";
import { withTenant } from "../../server/config/database";
import { tieneModulo } from "../../server/shared/utils/modulos";
import { getTenantId } from "../../server/shared/utils/request";
import { DashboardService, type ModulosDelDashboard } from "./dashboard.service";

/** Qué módulos tiene quien pide: el Dashboard solo consulta lo que hay (ver el servicio). */
const modulosDe = (req: Request): ModulosDelDashboard => ({
  repuestos: tieneModulo(req.usuario, "repuestos"),
  combustible: tieneModulo(req.usuario, "combustible"),
  documentos: tieneModulo(req.usuario, "documentos"),
});

export const DashboardController = {
  async getFullDashboard(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const data = await withTenant(tenantId, (client) =>
        DashboardService.getFullDashboardData(client, tenantId, modulosDe(req))
      );
      res.json(data);
    } catch (error) {
      console.error("Error en getFullDashboard:", error);
      res.status(500).json({ error: "Error al cargar los datos integrados del dashboard" });
    }
  },
  // ============================================================
  // 📊 KPIs PRINCIPALES
  // ============================================================
  async getKPIs(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const data = await withTenant(tenantId, (client) =>
        DashboardService.getKPIs(client, tenantId, modulosDe(req))
      );
      res.json(data);
    } catch {
      res.status(500).json({ error: "Error KPIs dashboard" });
    }
  },

  // ============================================================
  // 📊 CHART 1 - REPUESTOS POR CATEGORÍA
  // ============================================================
  async repuestosPorCategoria(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const data = await withTenant(tenantId, (client) =>
        DashboardService.repuestosPorCategoria(client, tenantId, modulosDe(req))
      );
      res.json(data);
    } catch {
      res.status(500).json({ error: "Error chart repuestos" });
    }
  },

  // ============================================================
  // 📊 CHART 2 - VALOR INVENTARIO
  // ============================================================
  async valorPorCategoria(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const data = await withTenant(tenantId, (client) =>
        DashboardService.valorPorCategoria(client, tenantId, modulosDe(req))
      );
      res.json(data);
    } catch {
      res.status(500).json({ error: "Error chart valor" });
    }
  },

  // ============================================================
  // 📊 CHART 3 - DOCUMENTOS
  // ============================================================
  async estadoDocumentos(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const data = await withTenant(tenantId, (client) =>
        DashboardService.estadoDocumentos(client, tenantId, modulosDe(req))
      );
      res.json(data);
    } catch {
      res.status(500).json({ error: "Error chart documentos" });
    }
  },

  // ============================================================
  // 📊 CHART 4 - NIVEL DE STOCK VS MINIMO
  // ============================================================
  async nivelstock(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const data = await withTenant(tenantId, (client) =>
        DashboardService.nivelstock(client, tenantId, modulosDe(req))
      );
      res.json(data);
    } catch {
      res.status(500).json({ error: "Error chart nivelstock" });
    }
  },
};
