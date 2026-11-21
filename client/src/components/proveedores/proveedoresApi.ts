// client/src/components/proveedores/proveedoresApi.ts
//
// Lectura del ecosistema «Gestión de proveedores» (/api/erp/proveedores). PR1: solo GET.
import { apiFetch } from "../../services/apiClient";

export type TipoProveedor = "Combustible" | "Urea";

export interface Proveedor {
  id: number;
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

async function leer<T>(ruta: string): Promise<T> {
  const res = await apiFetch(`/api/erp/proveedores${ruta}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || data.error || `No se pudo cargar (HTTP ${res.status})`);
  }
  return data as T;
}

export const listarProveedores = () => leer<Proveedor[]>("");
export const resumenProveedores = () => leer<ResumenProveedores>("/resumen");
