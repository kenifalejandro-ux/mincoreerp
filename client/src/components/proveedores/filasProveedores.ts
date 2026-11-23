// client/src/components/proveedores/filasProveedores.ts
//
// Las filas del Excel del Directorio y el nombre del archivo. PURO: sin red ni la librería `xlsx` (que solo vive en
// el cliente), para que lo prueben tanto el cliente como los tests de la raíz. NUNCA lleva cuentas bancarias, y el
// precio vigente solo si la persona ve precios.
import { abasteceA } from "./directorioProveedores";
import { textoAbastece } from "./fichaProveedor";
import type { PrecioDelDirectorio, ProveedorEnDirectorio } from "./proveedoresApi";

export interface ProveedorParaExportar extends ProveedorEnDirectorio {
  direccion: string | null;
  telefono: string | null;
  correo: string | null;
}

const precioTexto = (p: PrecioDelDirectorio) => `S/ ${p.precio.toFixed(2)} (${p.producto})`;

/** Las filas del Excel, con los encabezados como columnas. El precio solo si el servidor lo mandó (la persona
 *  ve precios); si no, la columna ni existe. */
export function filasDelExcel(
  proveedores: ProveedorParaExportar[]
): Record<string, string | number>[] {
  const conPrecios = proveedores.some((p) => p.precioVigente !== undefined);
  return proveedores.map((p) => {
    const fila: Record<string, string | number> = {
      Código: p.codigo,
      "Razón social": p.nombre,
      RUC: p.ruc ?? "",
      Tipo: p.tipos.join(", "),
      "Abastece a": textoAbastece(abasteceA(p)),
      Ciudad: p.ciudad ?? "",
      Dirección: p.direccion ?? "",
      Teléfono: p.telefono ?? "",
      Correo: p.correo ?? "",
      Estado: p.activo ? "Activo" : "Desactivado",
      "Ficha completa (%)": p.fichaCompleta.porcentaje,
    };
    if (conPrecios)
      fila["Precio vigente"] = p.precioVigente ? precioTexto(p.precioVigente) : "Sin precio";
    return fila;
  });
}

/** «proveedores-2026-11-23.xlsx» (día de Lima). */
export function nombreDelArchivo(ahora: number = Date.now()): string {
  const dia = new Date(ahora).toLocaleDateString("en-CA", { timeZone: "America/Lima" });
  return `proveedores-${dia}.xlsx`;
}
