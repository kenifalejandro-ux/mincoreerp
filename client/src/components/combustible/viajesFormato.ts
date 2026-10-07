// Formato compartido de la vista por viaje (0123): panel Viajes e Histórico.
export type Producto = "combustible" | "urea";

export interface FilaViaje {
  id: string;
  numero: number;
  equipo_id: number;
  placa_codigo: string;
  codigo_interno: string | null;
  equipo_tipo: string | null;
  tipo_medidor: "horometro" | "odometro" | null;
  conductor_nombre: string | null;
  conductor_dni: string | null;
  origen_id: string;
  origen: string;
  destino_id: string;
  destino: string;
  inicio_en: string | null;
  fin_en: string | null;
  medidor_previo: string | null;
  medidor_inicio: string | null;
  medidor_fin: string | null;
  recorrido: string | null;
  recorrido_sin_viaje: string | null;
  ruta_por_confirmar: boolean;
  inicio_origen_hora: "servidor" | "manual" | "dispositivo" | null;
  fin_origen_hora: "servidor" | "manual" | "dispositivo" | null;
  nota_ruta: string | null;
  cuenta_como: string;
  estado: "programado" | "en_curso" | "cerrado" | "anulado";
  observaciones: string | null;
  motivo_anulacion: string | null;
  cargas: string;
  cantidad: string;
  cantidad_por_viaje: string;
  promedio_ruta_unidad: string | null;
  viajes_ruta_unidad: string;
  promedio_ruta: string | null;
  viajes_ruta: string;
}

export const unidadDe = (p: Producto) => (p === "urea" ? "L" : "gal");
export const fmt = (n: number, dec = 2) =>
  n.toLocaleString("es-PE", { maximumFractionDigits: dec });
export const fechaHora = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("es-PE", { dateStyle: "short", timeStyle: "short" }) : "—";
export const ruta = (v: Pick<FilaViaje, "origen" | "destino">) => `${v.origen} → ${v.destino}`;
export const unidadLabel = (v: Pick<FilaViaje, "placa_codigo" | "codigo_interno">) =>
  v.codigo_interno ? `${v.codigo_interno} · ${v.placa_codigo}` : v.placa_codigo;

/** km/gal con odómetro, gal/h con horómetro: lo que se lee en cada medidor. */
export function rendimiento(v: FilaViaje, producto: Producto): string {
  const rec = Number(v.recorrido);
  const cant = Number(v.cantidad);
  if (!v.recorrido || rec <= 0 || cant <= 0) return "—";
  const u = unidadDe(producto);
  return v.tipo_medidor === "horometro"
    ? `${fmt(cant / rec)} ${u}/h`
    : `${fmt(rec / cant)} km/${u}`;
}

/** Cuánto se aparta del promedio de su ruta. Con 3+ viajes cerrados de la
 *  misma unidad en esa ruta se compara contra ella misma; si no, contra todas
 *  las unidades de la ruta. Con menos de 3 no hay promedio confiable. */
export const MIN_VIAJES_PARA_COMPARAR = 3;

export function desvio(v: FilaViaje): { pct: number; contra: string } | null {
  if (v.estado !== "cerrado" || v.ruta_por_confirmar) return null;
  const propia = Number(v.viajes_ruta_unidad) >= MIN_VIAJES_PARA_COMPARAR;
  if (!propia && Number(v.viajes_ruta) < MIN_VIAJES_PARA_COMPARAR) return null;
  const base = Number(propia ? v.promedio_ruta_unidad : v.promedio_ruta);
  if (!base) return null;
  return {
    pct: ((Number(v.cantidad_por_viaje) - base) / base) * 100,
    contra: propia ? "su propio promedio en la ruta" : "el promedio de la ruta",
  };
}

export type ClaseDeUnidad = "camion" | "auto" | "maquina" | "contenedor";

/** La familia de la unidad, para su ícono: volquete y tracto son camión;
 *  camioneta, auto; excavadora, retro y cargador, maquinaria; carretas y
 *  bombonas, contenedor. */
export function claseDeUnidad(tipo: string | null): ClaseDeUnidad {
  const t = (tipo ?? "").toLowerCase();
  if (/camioneta|pickup|auto|van\b/.test(t)) return "auto";
  if (/excavadora|retro|cargador|tractor(?!.*remolc)|motoniveladora|rodillo|bulldozer/.test(t)) {
    return "maquina";
  }
  if (/carreta|bombona|cisterna|tanque|semi|remolque/.test(t)) return "contenedor";
  return "camion";
}

export const hora = (iso: string | number) =>
  new Date(iso).toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" });

export const diaHora = (iso: string) =>
  new Date(iso).toLocaleString("es-PE", { dateStyle: "short", timeStyle: "short" });

export function duracion(min: number) {
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h} h ${m % 60} min` : `${m} min`;
}

export function iniciales(nombre: string | null) {
  if (!nombre) return "?";
  const partes = nombre.trim().split(/\s+/);
  return (partes[0][0] + (partes[1]?.[0] ?? "")).toUpperCase();
}
