/** src/modules/proveedores/proveedores.directorio.ts
 *
 * El Directorio de proveedores: lo que se calcula por cada proveedor además de sus datos básicos. Lógica
 * pura, sin base de datos: qué tan completa está la ficha y cuál es su precio vigente a mostrar.
 *
 * «Ficha completa» cuenta cinco datos NO sensibles: RUC, dirección, teléfono, contacto y condición de pago.
 * La cuenta bancaria no entra a propósito: tiene un permiso aparte y el porcentaje no debe contar algo que
 * no todas las personas pueden ver (saldría distinto según quién mire).
 */
import type { FilaPrecioDto } from "./proveedores.precios";

export const DATOS_DE_LA_FICHA = [
  "RUC",
  "dirección",
  "teléfono",
  "contacto",
  "condición de pago",
] as const;

export interface FichaCompleta {
  /** 0 a 100. */
  porcentaje: number;
  /** Los datos que faltan, con su nombre («teléfono», «contacto»…). */
  faltan: string[];
}

/** Lo que el Directorio sabe de la ficha de un proveedor. */
export interface DatosDeLaFicha {
  ruc: string | null;
  direccion: string | null;
  /** El teléfono de la empresa. */
  telefono: string | null;
  formaPago: string | null;
  tieneContacto: boolean;
  /** Algún contacto activo con teléfono. */
  contactoConTelefono: boolean;
}

export function calcularFichaCompleta(d: DatosDeLaFicha): FichaCompleta {
  const tiene: Record<(typeof DATOS_DE_LA_FICHA)[number], boolean> = {
    RUC: !!d.ruc,
    dirección: !!d.direccion,
    // Basta con que la empresa o alguno de sus contactos tenga teléfono.
    teléfono: !!d.telefono || d.contactoConTelefono,
    contacto: d.tieneContacto,
    "condición de pago": !!d.formaPago,
  };
  const faltan = DATOS_DE_LA_FICHA.filter((k) => !tiene[k]);
  return {
    porcentaje: Math.round(
      ((DATOS_DE_LA_FICHA.length - faltan.length) / DATOS_DE_LA_FICHA.length) * 100
    ),
    faltan: [...faltan],
  };
}

/** El precio vigente que se muestra de un proveedor en el Directorio. */
export interface PrecioDelDirectorio {
  /** «Diésel B5», «Caja (20 L)». */
  producto: string;
  precio: number;
  /** «galón» o «envase». */
  unidad: string;
}

/** El primer precio vigente del proveedor (combustible antes que urea; las filas ya vienen ordenadas), o
 *  `null` si no tiene ninguno. */
export function precioDelDirectorio(filas: FilaPrecioDto[]): PrecioDelDirectorio | null {
  const f = filas.find((x) => x.vigente);
  return f?.vigente ? { producto: f.detalle, precio: f.vigente.precio, unidad: f.unidad } : null;
}
