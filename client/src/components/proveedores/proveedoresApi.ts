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

/** Lo que se carga al registrar o editar un proveedor. INTERNO es la compra para despachar desde la
 *  planta (`tanque`, y `urea` para la del almacén) y EXTERNO la que se hace en ruta. */
export interface DatosProveedor {
  nombre: string;
  /** "" = sin RUC. */
  ruc: string;
  abastece_tanque: boolean;
  abastece_ruta: boolean;
  abastece_urea: boolean;
  abastece_urea_ruta: boolean;
}

async function enviar(ruta: string, metodo: "POST" | "PUT", cuerpo: object): Promise<Proveedor> {
  const res = await apiFetch(`/api/erp/proveedores${ruta}`, {
    method: metodo,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cuerpo),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      data.errors?.[0]?.message ||
        data.message ||
        data.error ||
        `No se pudo guardar (HTTP ${res.status})`
    );
  }
  return data as Proveedor;
}

export const crearProveedor = (datos: DatosProveedor) => enviar("", "POST", datos);
export const actualizarProveedor = (id: number, datos: DatosProveedor & { activo: boolean }) =>
  enviar(`/${id}`, "PUT", datos);

// ── Gestión comercial: precios de proveedores (solo lectura) ─────────────────────────────────────

export interface EntradaPrecio {
  id: number;
  precio: number;
  /** ISO 8601. */
  desde: string;
  por: string | null;
  marca: string | null;
  anulado: boolean;
  motivo: string | null;
}

export interface FilaPrecio {
  clave: string;
  proveedorId: number;
  proveedorCodigo: string;
  proveedorNombre: string;
  proveedorActivo: boolean;
  producto: "combustible" | "urea";
  codigo: string;
  /** «Diésel B5» o «Caja (20 L)». */
  detalle: string;
  /** «galón» o «envase». */
  unidad: string;
  vigente: EntradaPrecio | null;
  anterior: EntradaPrecio | null;
  programado: EntradaPrecio | null;
  historial: EntradaPrecio[];
}

export interface RespuestaPrecios {
  /** Qué productos puede ver esta persona. */
  combustible: boolean;
  urea: boolean;
  filas: FilaPrecio[];
}

export const listarPrecios = () => leer<RespuestaPrecios>("/precios");
