// client/src/components/proveedores/historialProveedores.ts
//
// «Historial y auditoría» del ecosistema: lo que la gente de la empresa hizo con los proveedores, leído de la
// bitácora (solo el admin). Acá viven la lectura al servidor, quién lo ve y cómo se arma la consulta; la
// pantalla está en HistorialDeProveedores.tsx. Sin React.
import { apiFetch } from "../../services/apiClient";

export type CategoriaDeHistorial = "proveedor" | "precios" | "compras" | "ficha" | "cuentas";

export const CATEGORIAS_DE_HISTORIAL: { id: "" | CategoriaDeHistorial; etiqueta: string }[] = [
  { id: "", etiqueta: "Todo" },
  { id: "proveedor", etiqueta: "Proveedores" },
  { id: "precios", etiqueta: "Precios" },
  { id: "compras", etiqueta: "Compras" },
  { id: "ficha", etiqueta: "Datos y contactos" },
  { id: "cuentas", etiqueta: "Cuentas bancarias" },
];

export interface EventoDeHistorial {
  id: string;
  accion: string;
  /** «Cargó un precio», «Vio el número completo de una cuenta»… */
  titulo: string;
  categoria: CategoriaDeHistorial | null;
  /** ISO 8601. */
  creadoEn: string;
  actor: string | null;
  proveedorId: number | null;
  proveedorNombre: string | null;
  /** Detalle legible, una línea por dato. Nunca trae un número de cuenta ni datos de contacto. */
  lineas: string[];
}

export interface PaginaDeHistorial {
  eventos: EventoDeHistorial[];
  /** El cursor para la página siguiente, o null si no hay más. */
  siguiente: string | null;
}

export interface FiltroDeHistorial {
  categoria?: CategoriaDeHistorial | "";
  /** AAAA-MM-DD (día de Lima). */
  desde?: string;
  hasta?: string;
  /** Texto del nombre del proveedor. */
  proveedor?: string;
  antesDe?: string;
}

/** Quién ve el historial: solo el admin, con el módulo `proveedores`. El servidor exige lo mismo. */
export function puedeVerHistorialDeProveedores(
  usuario: { rol: string; modulosPermitidos: string[] } | null | undefined
): boolean {
  return !!usuario && usuario.rol === "admin" && usuario.modulosPermitidos.includes("proveedores");
}

/** La consulta (`?categoria=…&desde=…`): solo lo que se llenó. */
export function consultaDeHistorial(filtro: FiltroDeHistorial): string {
  const params = new URLSearchParams();
  for (const [clave, valor] of Object.entries(filtro)) {
    if (typeof valor === "string" && valor.trim() !== "") params.set(clave, valor.trim());
  }
  const consulta = params.toString();
  return consulta ? `?${consulta}` : "";
}

/** Una fecha y hora legibles, en la hora de Lima. */
export function fechaYHoraDeLima(iso: string): string {
  return new Date(iso).toLocaleString("es-PE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Lima",
  });
}

export async function leerHistorialDeProveedores(
  filtro: FiltroDeHistorial = {}
): Promise<PaginaDeHistorial> {
  const res = await apiFetch(`/api/erp/proveedores/historial${consultaDeHistorial(filtro)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || data.error || `No se pudo cargar (HTTP ${res.status})`);
  }
  return data as PaginaDeHistorial;
}
