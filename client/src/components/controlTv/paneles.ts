// Los tipos y las cuentas de los paneles del Control TV. Sin pantalla.

export interface TanquetaTv {
  id: number;
  codigo: string;
  grifo: string | null;
  saldo: number;
  capacidad: number;
  equipo_asignado: string | null;
}

export interface SerieConsumo {
  t: string;
  gal: number;
  interno_gal: number;
  tanqueta_gal: number;
  ruta_gal: number;
}

export interface NivelTanque {
  id: number;
  nombre: string;
  unidad: string;
  capacidad: number;
  minimo: number | null;
  nivel_actual: number | string | null;
  puntos: { t: string; nivel: number }[];
}

export interface EnvaseTv {
  nombre: string;
  unidades: number;
  litros: number;
  entraron_mes: number;
  salieron_mes: number;
  ultimo_conteo: { contadoEn?: string } | null;
}

export interface EventoTv {
  t: string;
  tipo: "carga" | "compra_ruta" | "recepcion" | "llegada" | "detenida";
  titulo: string;
  detalle: string;
}

/** El color de cada origen del consumo. Los tres se distinguen también por su leyenda y la tabla. */
export const ORIGENES: { k: "interno_gal" | "tanqueta_gal" | "ruta_gal"; t: string; c: string }[] =
  [
    { k: "interno_gal", t: "Grifo interno", c: "#7fa21a" },
    { k: "tanqueta_gal", t: "Tanquetas", c: "#e0a526" },
    { k: "ruta_gal", t: "Compra en ruta", c: "#3b8fe0" },
  ];

export const COLOR_EVENTO: Record<EventoTv["tipo"], string> = {
  carga: "#9bbd1c",
  compra_ruta: "#60a5fa",
  recepcion: "#22d3ee",
  llegada: "#a78bfa",
  detenida: "#f87171",
};

/** Un número "redondo" para el tope de una gráfica. */
export function topeRedondo(max: number): number {
  if (max <= 0) return 1;
  const e = 10 ** Math.floor(Math.log10(max));
  const f = max / e;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e;
}

/** La etiqueta del eje de un corte: la hora si es por hora, el día si es por día (hora de Lima). */
export function etiquetaCorte(iso: string, porHora: boolean): string {
  const d = new Date(iso);
  if (porHora) {
    return d.toLocaleTimeString("es-PE", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: "America/Lima",
    });
  }
  // «AAAA-MM-DD» de Lima, armado a mano: el formato corto de cada navegador varía ("9/11" o "09/11").
  const [, mes, dia] = d.toLocaleDateString("en-CA", { timeZone: "America/Lima" }).split("-");
  return `${dia}/${mes}`;
}

/** El tipo de envase de la urea según su nombre (caja, bidón, balde), para su dibujo. */
export function claseEnvase(nombre: string): "caja" | "bidon" | "balde" | "otro" {
  const n = nombre.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (/caja/.test(n)) return "caja";
  if (/bidon/.test(n)) return "bidon";
  if (/balde/.test(n)) return "balde";
  return "otro";
}

/** «hace 2 h», «hace 6 días»: para el último conteo de urea y los eventos. */
export function haceTexto(iso: string, ahora: number): string {
  const min = Math.max(0, Math.round((ahora - Date.parse(iso)) / 60_000));
  if (min < 1) return "ahora";
  if (min < 60) return `hace ${min} min`;
  if (min < 48 * 60) return `hace ${Math.floor(min / 60)} h`;
  return `hace ${Math.floor(min / 1440)} días`;
}
