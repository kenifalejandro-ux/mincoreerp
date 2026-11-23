// client/src/components/proveedores/centroDeGestion.ts
//
// Lógica pura del Centro de gestión (como la maqueta): las cifras de las tarjetas, qué requiere atención, la
// calidad de las fichas, la distribución por tipo y cómo se dice «hace 18 min». Todo sale de los proveedores y
// precios reales; lo que todavía no existe (documentos, homologación) NO se inventa. Sin React.
import { totales } from "./preciosProveedores";
import type { FilaPrecio, ProveedorEnDirectorio } from "./proveedoresApi";

export const FICHA_INCOMPLETA_BAJO = 80;

const porcentaje = (parte: number, total: number) =>
  total === 0 ? 0 : Math.round((parte / total) * 100);

export interface CifrasDelCentro {
  total: number;
  activos: number;
  /** % de activos sobre el total del directorio. */
  pctActivos: number;
  combustible: number;
  urea: number;
  /** Activos sin ningún precio vigente. `null` si esta persona no ve precios (no se puede saber). */
  activosSinPrecio: number | null;
  /** % de los activos que sí tienen precio vigente. `null` si no se ven precios. */
  pctConPrecio: number | null;
  /** Fichas por debajo del 80 %. */
  fichasIncompletas: number;
  /** Promedio de «ficha completa» de todos los proveedores (0 si no hay). */
  promedioDeFichas: number;
}

export function cifrasDelCentro(lista: ProveedorEnDirectorio[]): CifrasDelCentro {
  const activos = lista.filter((p) => p.activo);
  // Sin permiso de precios el servidor no manda `precioVigente`: ahí no se puede decir quién no tiene precio.
  const veLosPrecios = lista.length === 0 || lista.some((p) => p.precioVigente !== undefined);
  const sinPrecio = veLosPrecios ? activos.filter((p) => !p.precioVigente).length : null;
  return {
    total: lista.length,
    activos: activos.length,
    pctActivos: porcentaje(activos.length, lista.length),
    combustible: lista.filter((p) => p.tipos.includes("Combustible")).length,
    urea: lista.filter((p) => p.tipos.includes("Urea")).length,
    activosSinPrecio: sinPrecio,
    pctConPrecio:
      sinPrecio === null ? null : porcentaje(activos.length - sinPrecio, activos.length),
    fichasIncompletas: lista.filter((p) => p.fichaCompleta.porcentaje < FICHA_INCOMPLETA_BAJO)
      .length,
    promedioDeFichas:
      lista.length === 0
        ? 0
        : Math.round(lista.reduce((a, p) => a + p.fichaCompleta.porcentaje, 0) / lista.length),
  };
}

export type DestinoDelCentro = "directorio" | "comercial" | "documentos";
export type TonoDeAtencion = "ambar" | "rojo" | "azul";

export interface ItemDeAtencion {
  id: string;
  tono: TonoDeAtencion;
  titulo: string;
  detalle: string;
  /** El texto del botón. */
  accion: string;
  destino: DestinoDelCentro;
}

const plural = (n: number, uno: string, varios: string) => (n === 1 ? uno : varios);

/** «Requieren tu atención»: solo lo que de verdad hay (precios por vencer, alzas, fichas incompletas). Los
 *  precios solo cuentan si esta persona los ve (`precios` es `null` si no). */
export function atencionDelCentro(
  cifras: CifrasDelCentro,
  precios: FilaPrecio[] | null,
  ahora: number = Date.now()
): ItemDeAtencion[] {
  const items: ItemDeAtencion[] = [];
  if (precios) {
    const t = totales(precios, ahora);
    if (t.vencenPronto > 0) {
      items.push({
        id: "precios-por-vencer",
        tono: "ambar",
        titulo: `${t.vencenPronto} ${plural(t.vencenPronto, "precio vence", "precios vencen")} en los próximos 30 días`,
        detalle: "Renegociar antes de que caduque el acuerdo",
        accion: "Ver precios",
        destino: "comercial",
      });
    }
    if (t.subieron > 0) {
      items.push({
        id: "precios-con-alza",
        tono: "rojo",
        titulo: `${t.subieron} ${plural(t.subieron, "precio subió", "precios subieron")} 5 % o más`,
        detalle: "Frente al precio anterior",
        accion: "Revisar",
        destino: "comercial",
      });
    }
  }
  if (cifras.fichasIncompletas > 0) {
    items.push({
      id: "fichas-incompletas",
      tono: "ambar",
      titulo: `${cifras.fichasIncompletas} ${plural(cifras.fichasIncompletas, "ficha incompleta", "fichas incompletas")} (menos del ${FICHA_INCOMPLETA_BAJO} %)`,
      detalle: "Faltan RUC, dirección, teléfono, contacto o condición de pago",
      accion: "Ver directorio",
      destino: "directorio",
    });
  }
  return items;
}

export interface TrozoDeDona {
  etiqueta: string;
  cantidad: number;
  color: string;
}

/** Los trozos de «Proveedores por tipo». Un proveedor de los dos tipos cuenta en cada uno. */
export function trozosPorTipo(lista: ProveedorEnDirectorio[]): TrozoDeDona[] {
  const c = cifrasDelCentro(lista);
  return [
    { etiqueta: "Combustible", cantidad: c.combustible, color: "#84cc16" },
    { etiqueta: "Urea", cantidad: c.urea, color: "#1768e4" },
  ];
}

/** El fondo CSS de una dona: `conic-gradient(color 0% 60%, color 60% 100%)`. Sin datos, un solo gris. */
export function degradadoDeDona(trozos: TrozoDeDona[], vacio = "#e2e8f0"): string {
  const suma = trozos.reduce((a, t) => a + t.cantidad, 0);
  if (suma === 0) return `conic-gradient(${vacio} 0% 100%)`;
  let acumulado = 0;
  const partes = trozos.map((t, i) => {
    const desde = acumulado;
    acumulado = i === trozos.length - 1 ? 100 : acumulado + porcentaje(t.cantidad, suma);
    return `${t.color} ${desde}% ${acumulado}%`;
  });
  return `conic-gradient(${partes.join(", ")})`;
}

/** «Hace 18 min», «Hace 2 h», «Ayer, 16:42» o «12/11/2026, 09:30» (hora de Lima). */
export function tiempoRelativo(iso: string, ahora: number = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const minutos = Math.max(0, Math.floor((ahora - t) / 60_000));
  if (minutos < 1) return "Ahora";
  if (minutos < 60) return `Hace ${minutos} min`;
  if (minutos < 24 * 60) return `Hace ${Math.floor(minutos / 60)} h`;
  const lima = (ms: number, opciones: Intl.DateTimeFormatOptions) =>
    new Date(ms).toLocaleString("es-PE", { timeZone: "America/Lima", ...opciones });
  const hora = lima(t, { hour: "2-digit", minute: "2-digit", hour12: false });
  const dia = (ms: number) => lima(ms, { day: "2-digit", month: "2-digit", year: "numeric" });
  if (dia(t) === dia(ahora - 24 * 3_600_000)) return `Ayer, ${hora}`;
  return `${dia(t)}, ${hora}`;
}

/** «cargó un precio» a partir de «Cargó un precio». */
export const enMinuscula = (titulo: string) =>
  titulo === "" ? "" : titulo.charAt(0).toLowerCase() + titulo.slice(1);

/** Iniciales de un nombre (dos letras). */
export const inicialesDe = (nombre: string | null) =>
  (nombre ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0])
    .join("")
    .toUpperCase() || "—";

/** «22 de noviembre de 2026» (día de Lima). */
export function fechaLarga(ahora: number = Date.now()): string {
  return new Date(ahora).toLocaleDateString("es-PE", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "America/Lima",
  });
}
