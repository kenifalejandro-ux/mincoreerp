// client/src/components/proveedores/exportarProveedores.ts
//
// Exportar el Directorio a Excel. `filasDelExcel` arma las filas (pura, probada) y `exportarProveedoresExcel` baja
// el archivo; la librería se carga recién al exportar. NUNCA lleva cuentas bancarias, y el precio vigente solo si
// la persona ve precios.
import { abasteceA } from "./directorioProveedores";
import { textoAbastece } from "./fichaProveedor";
import type { PrecioDelDirectorio, ProveedorEnDirectorio } from "./proveedoresApi";
import { apiFetch } from "../../services/apiClient";

export interface ProveedorParaExportar extends ProveedorEnDirectorio {
  direccion: string | null;
  telefono: string | null;
  correo: string | null;
}

/** Trae del servidor lo que se exporta. Con `ids`, solo esos proveedores (los filtrados en pantalla). */
export async function leerProveedoresParaExportar(
  ids?: number[]
): Promise<ProveedorParaExportar[]> {
  const consulta = ids ? `?ids=${ids.join(",")}` : "";
  const res = await apiFetch(`/api/erp/proveedores/exportar${consulta}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || data.error || `No se pudo exportar (HTTP ${res.status})`);
  }
  return data as ProveedorParaExportar[];
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

export async function exportarProveedoresExcel(proveedores: ProveedorParaExportar[]) {
  if (proveedores.length === 0) return;
  const XLSX = await import("xlsx");
  const libro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    libro,
    XLSX.utils.json_to_sheet(filasDelExcel(proveedores)),
    "Proveedores"
  );
  XLSX.writeFile(libro, nombreDelArchivo());
}
