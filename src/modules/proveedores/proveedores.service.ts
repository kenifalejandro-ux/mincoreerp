/** src/modules/proveedores/proveedores.service.ts
 *
 * Arma lo que ve el ecosistema a partir de las banderas de `combustible_grifos`. Las palabras son
 * las del ERP: INTERNO = compra para despachar desde la planta (abastece_tanque, y abastece_urea para
 * la urea del almacén) y EXTERNO = se compra en el recorrido de ruta (abastece_ruta y
 * abastece_urea_ruta).
 */
import type { PoolClient } from "pg";

import { AppError } from "../../server/shared/middlewares/error.middleware";
import { ProveedoresRepository, type FilaProveedor } from "./proveedores.repository";

export type TipoProveedor = "Combustible" | "Urea";

export interface ProveedorDto {
  id: number;
  /** Mismo formato que la pestaña Proveedores de Combustible (PRV-009). */
  codigo: string;
  nombre: string;
  ruc: string | null;
  activo: boolean;
  tipos: TipoProveedor[];
  combustible: { interno: boolean; externo: boolean };
  urea: { interno: boolean; externo: boolean };
}

export interface ResumenProveedores {
  total: number;
  activos: number;
  inactivos: number;
  combustible: number;
  urea: number;
  internos: number;
  externos: number;
}

export function codigoDeProveedor(id: number): string {
  return `PRV-${String(id).padStart(3, "0")}`;
}

export function aDto(fila: FilaProveedor): ProveedorDto {
  const combustible = { interno: fila.abastece_tanque, externo: fila.abastece_ruta };
  const urea = { interno: fila.abastece_urea, externo: fila.abastece_urea_ruta };
  const tipos: TipoProveedor[] = [];
  if (combustible.interno || combustible.externo) tipos.push("Combustible");
  if (urea.interno || urea.externo) tipos.push("Urea");
  return {
    id: fila.id,
    codigo: codigoDeProveedor(fila.id),
    nombre: fila.nombre,
    ruc: fila.ruc,
    activo: fila.activo,
    tipos,
    combustible,
    urea,
  };
}

export function resumir(lista: ProveedorDto[]): ResumenProveedores {
  return {
    total: lista.length,
    activos: lista.filter((p) => p.activo).length,
    inactivos: lista.filter((p) => !p.activo).length,
    combustible: lista.filter((p) => p.tipos.includes("Combustible")).length,
    urea: lista.filter((p) => p.tipos.includes("Urea")).length,
    internos: lista.filter((p) => p.combustible.interno || p.urea.interno).length,
    externos: lista.filter((p) => p.combustible.externo || p.urea.externo).length,
  };
}

export class ProveedoresService {
  constructor(private readonly repository = new ProveedoresRepository()) {}

  async listar(client: PoolClient, tenantId: string): Promise<ProveedorDto[]> {
    return (await this.repository.listar(client, tenantId)).map(aDto);
  }

  async resumen(client: PoolClient, tenantId: string): Promise<ResumenProveedores> {
    return resumir(await this.listar(client, tenantId));
  }

  async detalle(client: PoolClient, tenantId: string, id: number): Promise<ProveedorDto> {
    const fila = await this.repository.buscarPorId(client, tenantId, id);
    if (!fila) throw new AppError(404, "Proveedor no encontrado");
    return aDto(fila);
  }
}
