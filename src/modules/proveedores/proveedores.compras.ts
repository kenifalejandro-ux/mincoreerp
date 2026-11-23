/** src/modules/proveedores/proveedores.compras.ts
 *
 * Compras y recepciones (PR5, solo lectura): arma lo que ve el ecosistema a partir de las compras de
 * cisterna de Combustible (migraciones 0171 y 0173). Lógica pura: sin base ni red.
 *
 * El estado de la compra y la diferencia contra el documento los decide Combustible, igual que allá:
 *   · estado (derivado al leer): registrada, por_llegar, recibida o anulada.
 *   · diferencia = lo descargado (al tanque + lo repartido) menos lo que dice el documento, en
 *     galones; pasada la tolerancia de la empresa es una «diferencia fuera de tolerancia».
 */
import { diferenciaEnGalones } from "../combustible/comprasCisterna.service";
import { ETIQUETA_COMBUSTIBLE } from "./proveedores.precios";
import { codigoDeProveedor } from "./proveedores.service";

export type EstadoCompra = "registrada" | "por_llegar" | "recibida" | "anulada";

/** Una fila de `listarCompras` de Combustible (los números llegan como texto desde Postgres). */
export interface CompraDb {
  id: string | number;
  /** La sede a la que llega (grifos_internos). */
  grifo_interno_id?: string | number;
  grifo_id: number;
  proveedor: string;
  tipo_combustible: string;
  unidad: string;
  tipo_documento: string;
  numero_documento: string;
  fecha_compra: string;
  llegada_estimada: string;
  cantidad_facturada: string | number;
  costo_unitario: string | number;
  placa: string | null;
  chofer: string | null;
  transportista: string | null;
  transportista_ruc?: string | null;
  habilitada_en: Date | string | null;
  anulada_en: Date | string | null;
  motivo_anulacion: string | null;
  recepcion_id: string | number | null;
  estado: EstadoCompra;
}

export interface RecepcionDb {
  id: string | number;
  cantidad: string | number;
  cantidad_derivada: string | number;
  recibido_en: Date | string;
  /** Unidad del tanque que recibió. */
  unidad: string;
}

export interface RecepcionDeCompraDto {
  id: number;
  /** ISO 8601. */
  recibidoEn: string;
  /** Al tanque más lo repartido, en la unidad del tanque. */
  descargado: number;
  unidad: string;
  /** Lo descargado menos el documento, en galones (negativo: llegó menos). */
  diferenciaGalones: number;
  fueraDeTolerancia: boolean;
}

export interface CompraDto {
  id: number;
  estado: EstadoCompra;
  proveedorId: number;
  proveedorCodigo: string;
  proveedorNombre: string;
  tipoCombustible: string;
  combustible: string;
  unidad: string;
  tipoDocumento: string;
  numeroDocumento: string;
  fechaCompra: string;
  llegadaEstimada: string;
  /** «Sede · tanque» a la que llega, como se eligió en «Registrar compra» (null si no se pudo leer). */
  sedeDeLlegada: string | null;
  cantidadFacturada: number;
  costoUnitario: number;
  /** cantidad facturada × costo unitario. */
  total: number;
  placa: string | null;
  chofer: string | null;
  transportista: string | null;
  transportistaRuc: string | null;
  habilitada: boolean;
  motivoAnulacion: string | null;
  recepcion: RecepcionDeCompraDto | null;
}

const aIso = (f: Date | string) => new Date(f).toISOString();
const redondear2 = (n: number) => Math.round(n * 100) / 100;

export function armarCompras(
  filas: CompraDb[],
  recepciones: Map<number, RecepcionDb>,
  tolerancia: number,
  /** La etiqueta de cada sede de llegada por su id. */
  sedes: Map<number, string> = new Map()
): CompraDto[] {
  return filas.map((f): CompraDto => {
    const cantidad = Number(f.cantidad_facturada);
    const costo = Number(f.costo_unitario);
    const r = f.recepcion_id !== null ? recepciones.get(Number(f.recepcion_id)) : undefined;
    let recepcion: RecepcionDeCompraDto | null = null;
    if (r) {
      const descargado = Number(r.cantidad) + Number(r.cantidad_derivada);
      const diferenciaGalones = diferenciaEnGalones({
        cantidadDelDocumento: cantidad,
        unidadDelDocumento: f.unidad,
        descargado,
        unidadDelTanque: r.unidad,
      });
      recepcion = {
        id: Number(r.id),
        recibidoEn: aIso(r.recibido_en),
        descargado,
        unidad: r.unidad,
        diferenciaGalones,
        fueraDeTolerancia: Math.abs(diferenciaGalones) > tolerancia,
      };
    }
    return {
      id: Number(f.id),
      estado: f.estado,
      proveedorId: f.grifo_id,
      proveedorCodigo: codigoDeProveedor(f.grifo_id),
      proveedorNombre: f.proveedor,
      tipoCombustible: f.tipo_combustible,
      combustible: ETIQUETA_COMBUSTIBLE[f.tipo_combustible] ?? f.tipo_combustible,
      unidad: f.unidad,
      tipoDocumento: f.tipo_documento,
      numeroDocumento: f.numero_documento,
      fechaCompra: f.fecha_compra,
      llegadaEstimada: f.llegada_estimada,
      sedeDeLlegada:
        f.grifo_interno_id === undefined ? null : (sedes.get(Number(f.grifo_interno_id)) ?? null),
      cantidadFacturada: cantidad,
      costoUnitario: costo,
      total: redondear2(cantidad * costo),
      placa: f.placa,
      chofer: f.chofer,
      transportista: f.transportista,
      transportistaRuc: f.transportista_ruc ?? null,
      habilitada: f.habilitada_en !== null,
      motivoAnulacion: f.motivo_anulacion,
      recepcion,
    };
  });
}
