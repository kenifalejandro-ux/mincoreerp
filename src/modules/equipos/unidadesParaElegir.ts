/** src/modules/equipos/unidadesParaElegir.ts
 *
 * La lista de unidades para ELEGIR una en otro módulo (Checklists, Órdenes de trabajo, IPERC). Cada
 * uno la monta en su propia ruta (`GET /<módulo>/unidades`) en vez de usar `/api/erp/equipos`, que
 * cuelga de Flota: una empresa que mantiene sus unidades en Mantenimiento, sin Flota, no tiene
 * acceso a esa ruta y se quedaría sin selector.
 *
 * Quien no tiene ningún módulo que mantenga unidades recibe una lista vacía, no un 403: el
 * formulario sigue funcionando con «Activo o lugar» en texto (ver `opcionales` en registry.ts).
 * Devuelve solo id, placa o código y tipo de las unidades activas: no hace falta más para elegir. */
import type { Request, Response } from "express";
import { withTenant } from "../../server/config/database";
import { tieneUnidades } from "../../server/shared/utils/modulos";
import { armarRespuestaPaginada, parsePaginacion } from "../../server/shared/utils/pagination";
import { getTenantId } from "../../server/shared/utils/request";
import { EquiposRepository } from "./equipos.repository";

export async function listarUnidadesParaElegir(req: Request, res: Response) {
  const paginacion = parsePaginacion(req.query);
  if (!tieneUnidades(req.usuario)) {
    res.json(armarRespuestaPaginada([], paginacion));
    return;
  }
  const tenantId = getTenantId(req);
  const filas = await withTenant(tenantId, (client) =>
    EquiposRepository.findParaElegir(client, tenantId, paginacion)
  );
  res.json(armarRespuestaPaginada(filas, paginacion));
}
