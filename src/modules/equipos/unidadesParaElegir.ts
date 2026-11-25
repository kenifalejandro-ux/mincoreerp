/** src/modules/equipos/unidadesParaElegir.ts
 *
 * La lista de unidades para ELEGIR una en otro módulo (Checklists, Órdenes de trabajo, IPERC). Cada
 * uno la monta en su propia ruta (`GET /<módulo>/unidades`) en vez de usar `/api/erp/equipos`, que
 * cuelga de Flota: una empresa que mantiene sus unidades en Mantenimiento, sin Flota, no tiene
 * acceso a esa ruta y se quedaría sin selector.
 *
 * Quien no tiene ningún módulo que mantenga unidades recibe una lista vacía, no un 403: el
 * formulario sigue funcionando con «Activo o lugar» en texto (ver `opcionales` en registry.ts).
 * Devuelve solo id, placa o código y tipo de las unidades activas: no hace falta más para elegir. Las
 * devuelve todas (el selector tiene buscador); el tope es solo un freno muy por encima de la cuota de
 * unidades por empresa. */
import type { Request, Response } from "express";
import { withTenant } from "../../server/config/database";
import { tieneUnidades } from "../../server/shared/utils/modulos";
import { armarRespuestaPaginada } from "../../server/shared/utils/pagination";
import { getTenantId } from "../../server/shared/utils/request";
import { EquiposRepository } from "./equipos.repository";

const TOPE_DE_UNIDADES = 10_000;
/** Una sola página con todo: se conserva la forma de las respuestas paginadas que leen las pantallas. */
const UNA_PAGINA = { page: 1, pageSize: TOPE_DE_UNIDADES, offset: 0 };

export async function listarUnidadesParaElegir(req: Request, res: Response) {
  if (!tieneUnidades(req.usuario)) {
    res.json(armarRespuestaPaginada([], UNA_PAGINA));
    return;
  }
  const tenantId = getTenantId(req);
  const filas = await withTenant(tenantId, (client) =>
    EquiposRepository.findParaElegir(client, tenantId, TOPE_DE_UNIDADES)
  );
  res.json(armarRespuestaPaginada(filas, UNA_PAGINA));
}
