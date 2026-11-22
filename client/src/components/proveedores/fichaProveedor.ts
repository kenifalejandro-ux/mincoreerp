// client/src/components/proveedores/fichaProveedor.ts
//
// Lógica pura de la ficha del proveedor (como la maqueta): qué pestañas ve cada persona, qué tan completa está
// la ficha, y los textos de la cabecera y del Resumen. Sin React ni red.
import { textoDeFormaDePago } from "./fichaFormulario";
import type { Contacto, DatosFicha, FichaProveedor } from "./proveedoresApi";
import type { PestanaDeRuta } from "./rutaProveedores";

export type PestanaFicha = PestanaDeRuta;

export const ETIQUETA_PESTANA: Record<PestanaFicha, string> = {
  resumen: "Resumen",
  datos: "Datos generales",
  contactos: "Contactos",
  cuentas: "Cuentas",
  comercial: "Comercial",
  contratos: "Contratos",
  documentos: "Documentos",
  compras: "Compras y recepciones",
  historial: "Historial",
};

export interface AccesoDeLaFicha {
  /** Pestaña «Comercial» (los precios). */
  verPrecios: boolean;
  /** Pestaña «Compras y recepciones». */
  verCompras: boolean;
  /** Pestaña «Cuentas» (cuentas bancarias; nace solo para el admin). */
  verCuentas: boolean;
  /** Pestaña «Historial» (solo el admin). */
  verHistorial: boolean;
}

/** Las pestañas de la ficha, en el orden de la maqueta. Contratos y Documentos van siempre: son «Pronto». */
export function pestanasDeLaFicha(a: AccesoDeLaFicha): PestanaFicha[] {
  return [
    "resumen",
    "datos",
    "contactos",
    ...(a.verCuentas ? (["cuentas"] as const) : []),
    ...(a.verPrecios ? (["comercial"] as const) : []),
    "contratos",
    "documentos",
    ...(a.verCompras ? (["compras"] as const) : []),
    ...(a.verHistorial ? (["historial"] as const) : []),
  ];
}

/** Una pestaña que la persona no puede ver se lee como el Resumen. */
export const pestanaPermitida = (pestana: PestanaFicha, a: AccesoDeLaFicha): PestanaFicha =>
  pestanasDeLaFicha(a).includes(pestana) ? pestana : "resumen";

/** Los cinco datos que cuenta «Ficha completa». IGUAL que el servidor (proveedores.directorio.ts): la
 *  cuenta bancaria no entra a propósito. Acá se recalcula con la ficha que se acaba de editar. */
export const DATOS_DE_LA_FICHA = [
  "RUC",
  "dirección",
  "teléfono",
  "contacto",
  "condición de pago",
] as const;

export function fichaCompleta(
  ruc: string | null,
  datos: Pick<DatosFicha, "direccion" | "telefono" | "formaPago">,
  contactos: Pick<Contacto, "telefono">[]
): { porcentaje: number; faltan: string[] } {
  const tiene: Record<(typeof DATOS_DE_LA_FICHA)[number], boolean> = {
    RUC: !!ruc,
    dirección: !!datos.direccion,
    teléfono: !!datos.telefono || contactos.some((c) => !!c.telefono),
    contacto: contactos.length > 0,
    "condición de pago": !!datos.formaPago,
  };
  const faltan = DATOS_DE_LA_FICHA.filter((k) => !tiene[k]);
  return {
    porcentaje: Math.round(
      ((DATOS_DE_LA_FICHA.length - faltan.length) / DATOS_DE_LA_FICHA.length) * 100
    ),
    faltan: [...faltan],
  };
}

/** «Interno», «Externo» o «Interno y Externo»; vacío si no abastece a nadie. */
export function textoAbastece(uso: { interno: boolean; externo: boolean }): string {
  if (uso.interno && uso.externo) return "Interno y Externo";
  if (uso.interno) return "Interno";
  if (uso.externo) return "Externo";
  return "";
}

/** «Combustible / Urea» (la línea bajo el nombre). */
export const textoDeTipos = (tipos: string[]): string => tipos.join(" / ");

/** Qué suministra (los chips): los productos con precio, y si no hay, los tipos de proveedor. Sin repetir. */
export function chipsDeSuministro(productosConPrecio: string[], tipos: string[]): string[] {
  const fuente = productosConPrecio.length > 0 ? productosConPrecio : tipos;
  return [...new Set(fuente)];
}

/** El contacto principal (o el primero si ninguno está marcado), o `null` si no hay contactos. */
export function contactoPrincipal(contactos: Contacto[]): Contacto | null {
  return contactos.find((c) => c.principal) ?? contactos[0] ?? null;
}

/** Iniciales para el cuadro de color (dos letras). */
export const inicialesDeProveedor = (nombre: string): string =>
  nombre
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0])
    .join("")
    .toUpperCase();

/** «Contado», «Crédito a 30 días» o «Sin definir» (mientras la ficha carga, «…»). */
export const condicionDePago = (ficha: FichaProveedor | null): string =>
  ficha ? textoDeFormaDePago(ficha.datos) : "…";
