/** src/modules/proveedores/proveedores.service.ts
 *
 * Arma lo que ve el ecosistema a partir de las banderas de `combustible_grifos`. Las palabras son
 * las del ERP: INTERNO = compra para despachar desde la planta (abastece_tanque, y abastece_urea para
 * la urea del almacén) y EXTERNO = se compra en el recorrido de ruta (abastece_ruta y
 * abastece_urea_ruta).
 */
import type { PoolClient } from "pg";

import { AppError } from "../../server/shared/middlewares/error.middleware";
import { armarFilasDePrecios, type FilaPrecioDto } from "./proveedores.precios";
import { armarCompras, type CompraDto } from "./proveedores.compras";
import { listarCompras, obtenerTolerancia } from "../combustible/comprasCisterna.service";
import type { AlcanceCombustible } from "../combustible/alcance";
import type {
  ActualizarProveedorInput,
  CrearProveedorInput,
} from "../../server/schemas/proveedores.schema";
import {
  ProveedorDuplicadoError,
  ProveedoresRepository,
  type FilaProveedor,
} from "./proveedores.repository";

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

  /** Gestión comercial: solo lo que este perfil puede ver (combustible y/o urea). */
  async precios(
    client: PoolClient,
    tenantId: string,
    ver: { combustible: boolean; urea: boolean },
    ahora: Date = new Date()
  ): Promise<FilaPrecioDto[]> {
    const proveedores = await this.listar(client, tenantId);
    const [preciosCombustible, preciosUrea, tiposEnTanques, presentaciones] = await Promise.all([
      ver.combustible
        ? this.repository.listarPreciosCombustibleDeProveedores(client, tenantId)
        : [],
      ver.urea ? this.repository.listarPreciosUrea(client, tenantId) : [],
      ver.combustible ? this.repository.tiposDeCombustibleEnTanques(client, tenantId) : [],
      ver.urea ? this.repository.presentacionesDeUreaActivas(client, tenantId) : [],
    ]);
    return armarFilasDePrecios(
      { proveedores, preciosCombustible, preciosUrea, tiposEnTanques, presentaciones },
      ver,
      ahora
    );
  }

  /** Compras y recepciones: las compras de cisterna de Combustible que este perfil puede ver (las mismas
   *  reglas de allá: alcance por sede y, si no gestiona compras, solo las ya por llegar), con lo que se
   *  descargó contra el documento. */
  async compras(
    client: PoolClient,
    tenantId: string,
    alcance: AlcanceCombustible,
    gestiona: boolean
  ): Promise<{ gestiona: boolean; tolerancia: number; compras: CompraDto[] }> {
    const filas = await listarCompras(client, tenantId, alcance, gestiona);
    const ids = filas.filter((f) => f.recepcion_id !== null).map((f) => Number(f.recepcion_id));
    const [recepciones, tolerancia] = await Promise.all([
      this.repository.recepcionesDeCompras(client, tenantId, ids),
      obtenerTolerancia(client, tenantId),
    ]);
    return {
      gestiona,
      tolerancia,
      compras: armarCompras(filas, new Map(recepciones.map((r) => [Number(r.id), r])), tolerancia),
    };
  }

  async crear(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    data: CrearProveedorInput
  ): Promise<ProveedorDto> {
    try {
      return aDto(await this.repository.crear(client, tenantId, usuarioId, data));
    } catch (err) {
      throw comoErrorDeNegocio(err);
    }
  }

  async actualizar(
    client: PoolClient,
    tenantId: string,
    id: number,
    data: ActualizarProveedorInput
  ): Promise<ProveedorDto> {
    try {
      const fila = await this.repository.actualizar(client, tenantId, id, data);
      if (!fila) throw new AppError(404, "Proveedor no encontrado");
      return aDto(fila);
    } catch (err) {
      throw comoErrorDeNegocio(err);
    }
  }
}

function comoErrorDeNegocio(err: unknown): unknown {
  return err instanceof ProveedorDuplicadoError ? new AppError(409, err.message) : err;
}
