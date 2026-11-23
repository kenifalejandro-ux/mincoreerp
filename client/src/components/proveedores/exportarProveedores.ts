// client/src/components/proveedores/exportarProveedores.ts
//
// Exportar el Directorio a Excel: trae las filas del servidor (que anota la exportación en la bitácora) y baja el
// archivo. La librería `xlsx` se carga recién al exportar. Las filas y el nombre del archivo salen de
// filasProveedores.ts (puro y probado).
import { filasDelExcel, nombreDelArchivo, type ProveedorParaExportar } from "./filasProveedores";
import { apiFetch } from "../../services/apiClient";

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
