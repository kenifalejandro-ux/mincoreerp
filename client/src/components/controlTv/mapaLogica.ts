// La lógica pura del mapa digital del Control TV: dónde queda cada lugar y cada unidad, cómo se
// encuadra el mapa en la zona de trabajo y cómo se separan las unidades que están juntas. Sin pantalla.
import type { CatTv } from "./controlTvLogica";
import { paradasDelViaje, posicion } from "../combustible/paradasViaje";
import { ubicacionVigente } from "../combustible/ubicacionesLogica";
import type { FilaViaje } from "../combustible/viajesFormato";

export interface LugarMapa {
  id: string | number;
  nombre: string;
  latitud?: number | null;
  longitud?: number | null;
}

export interface Punto {
  lat: number;
  lon: number;
}

export interface Caja {
  lon0: number;
  lon1: number;
  lat0: number;
  lat1: number;
}

/** El punto de un lugar, o null si todavía no se ubicó en el mapa. */
export function puntoDeLugar(l: LugarMapa | undefined): Punto | null {
  if (!l || l.latitud == null || l.longitud == null) return null;
  const lat = Number(l.latitud);
  const lon = Number(l.longitud);
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

/** Los puntos de las paradas de un viaje, en orden; null en las paradas cuyo lugar no tiene punto. */
export function puntosDelViaje(v: FilaViaje, lugares: Map<string, LugarMapa>): (Punto | null)[] {
  return paradasDelViaje(v).map((p) => puntoDeLugar(lugares.get(String(p.lugar_id))));
}

export interface PosicionMapa {
  punto: Punto;
  /** El tramo en el que va (0 = de la primera a la segunda parada) y qué fracción de él lleva. */
  tramo: number | null;
  fraccion: number;
}

/** Dónde se dibuja la unidad. Si la oficina anotó un punto en un lugar que tiene coordenadas y ese punto
 *  es lo último que se sabe del viaje (ubicacionVigente: ni una llegada ni una salida más nueva lo pisan),
 *  va exactamente ahí. Si no: en su parada si está detenida en una, y a mitad del tramo (en línea recta
 *  entre las dos paradas) si va en camino. Sin el punto de lo que necesita, null (la unidad queda «sin
 *  ubicar»). Es una estimación por las marcas, no GPS. */
export function posicionEnMapa(v: FilaViaje, lugares: Map<string, LugarMapa>): PosicionMapa | null {
  const paradas = paradasDelViaje(v);
  const puntos = puntosDelViaje(v, lugares);
  const vigente = ubicacionVigente(paradas, v.ultima_ubicacion);
  if (vigente?.origen === "punto" && vigente.lugar_id != null) {
    const exacto = puntoDeLugar(lugares.get(String(vigente.lugar_id)));
    if (exacto) return { punto: exacto, tramo: null, fraccion: 0 };
  }
  const pos = posicion(paradas);
  if (pos.tipo === "en_parada") {
    const p = puntos[pos.en];
    return p ? { punto: p, tramo: null, fraccion: 0 } : null;
  }
  if (pos.tipo === "en_marcha") {
    const a = puntos[pos.hacia - 1];
    const b = puntos[pos.hacia];
    if (!a || !b) return null;
    return {
      punto: { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 },
      tramo: pos.hacia - 1,
      fraccion: 0.5,
    };
  }
  if (pos.tipo === "sin_salir") {
    const p = puntos[0];
    return p ? { punto: p, tramo: null, fraccion: 0 } : null;
  }
  const ultimo = puntos[puntos.length - 1];
  return ultimo ? { punto: ultimo, tramo: null, fraccion: 1 } : null;
}

/** El recuadro que encuadra todos los puntos con un margen, y con la proporción del lienzo para que el
 *  mapa no se deforme. Sin puntos, toda la zona norte del Perú. */
export function encuadre(
  puntos: Punto[],
  ancho: number,
  alto: number,
  margen = 0.18,
  /** El recuadro mínimo, en grados: 3 en la flota (se ve la zona); menos en la vista de una unidad. */
  minGrados = 3
): Caja {
  if (puntos.length === 0) return { lon0: -81.6, lon1: -73.6, lat0: -9.9, lat1: -3.5 };
  const lons = puntos.map((p) => p.lon);
  const lats = puntos.map((p) => p.lat);
  let lon0 = Math.min(...lons);
  let lon1 = Math.max(...lons);
  let lat0 = Math.min(...lats);
  let lat1 = Math.max(...lats);
  // Un solo punto (o todos casi juntos): se abre un recuadro mínimo.
  const MIN = minGrados;
  if (lon1 - lon0 < MIN) {
    const c = (lon0 + lon1) / 2;
    lon0 = c - MIN / 2;
    lon1 = c + MIN / 2;
  }
  if (lat1 - lat0 < MIN) {
    const c = (lat0 + lat1) / 2;
    lat0 = c - MIN / 2;
    lat1 = c + MIN / 2;
  }
  const mx = (lon1 - lon0) * margen;
  const my = (lat1 - lat0) * margen;
  lon0 -= mx;
  lon1 += mx;
  lat0 -= my;
  lat1 += my;
  // Se ensancha el lado corto hasta la proporción del lienzo (un grado de longitud y de latitud miden
  // casi lo mismo cerca del ecuador).
  const razon = ancho / alto;
  const w = lon1 - lon0;
  const h = lat1 - lat0;
  if (w / h < razon) {
    const nuevo = h * razon;
    lon0 -= (nuevo - w) / 2;
    lon1 += (nuevo - w) / 2;
  } else {
    const nuevo = w / razon;
    lat0 -= (nuevo - h) / 2;
    lat1 += (nuevo - h) / 2;
  }
  return { lon0, lon1, lat0, lat1 };
}

/** Mueve el encuadre lo que se arrastró (en píxeles): arrastrar a la derecha muestra lo de la izquierda. */
export function desplazar(c: Caja, dx: number, dy: number, ancho: number, alto: number): Caja {
  const mx = (dx / ancho) * (c.lon1 - c.lon0);
  const my = (dy / alto) * (c.lat1 - c.lat0);
  return { lon0: c.lon0 - mx, lon1: c.lon1 - mx, lat0: c.lat0 + my, lat1: c.lat1 + my };
}

/** Los lados del encuadre en grados: ni más cerca que una zona de unos 6 km ni más lejos que el país. */
export const ZOOM_MIN_GRADOS = 0.06;
export const ZOOM_MAX_GRADOS = 16;

/** Acerca (factor > 1) o aleja (< 1) el encuadre dejando quieto el punto bajo (ax, ay), en píxeles. */
export function acercar(
  c: Caja,
  factor: number,
  ax: number,
  ay: number,
  ancho: number,
  alto: number
): Caja {
  const w = c.lon1 - c.lon0;
  const h = c.lat1 - c.lat0;
  if (!(factor > 0) || !(w > 0) || !(h > 0)) return c;
  // El ancho nuevo se acota; el alto sigue su proporción.
  const nw = Math.min(ZOOM_MAX_GRADOS, Math.max(ZOOM_MIN_GRADOS, w / factor));
  const nh = (h * nw) / w;
  const fx = ax / ancho;
  const fy = ay / alto;
  const lon = c.lon0 + fx * w;
  const lat = c.lat1 - fy * h;
  return {
    lon0: lon - fx * nw,
    lon1: lon - fx * nw + nw,
    lat1: lat + fy * nh,
    lat0: lat + fy * nh - nh,
  };
}

/** La unidad que está más cerca del puntero, dentro del radio; null si ninguna. */
export function masCercana(
  puestas: { id: string; x: number; y: number }[],
  x: number,
  y: number,
  radio = 14
): string | null {
  let mejor: { id: string; d: number } | null = null;
  for (const p of puestas) {
    const d = Math.hypot(p.x - x, p.y - y);
    if (d <= radio && (!mejor || d < mejor.d)) mejor = { id: p.id, d };
  }
  return mejor?.id ?? null;
}

export const aPixel = (p: Punto, c: Caja, ancho: number, alto: number) => ({
  x: ((p.lon - c.lon0) / (c.lon1 - c.lon0)) * ancho,
  y: ((c.lat1 - p.lat) / (c.lat1 - c.lat0)) * alto,
});

/** A las unidades que caen casi en el mismo píxel se les da un pequeño corrimiento en círculo, para que
 *  se vean todas y no una tape a otra. Devuelve el desplazamiento de cada una, en el mismo orden. */
export function separar(
  pixeles: { x: number; y: number }[],
  radio = 11
): { dx: number; dy: number }[] {
  const grupos: { x: number; y: number; n: number }[] = [];
  return pixeles.map((p) => {
    let g = grupos.find((q) => Math.hypot(q.x - p.x, q.y - p.y) < radio);
    if (!g) {
      g = { x: p.x, y: p.y, n: 0 };
      grupos.push(g);
    }
    const k = g.n++;
    if (k === 0) return { dx: 0, dy: 0 };
    // Anillos de 6, 12, 18 unidades alrededor del centro del grupo.
    const anillo = Math.ceil((-3 + Math.sqrt(9 + 12 * k)) / 6) || 1;
    const dentro = k - 3 * anillo * (anillo - 1) - 1;
    const total = 6 * anillo;
    const ang = (dentro / total) * Math.PI * 2 - Math.PI / 2;
    return { dx: Math.cos(ang) * radio * anillo, dy: Math.sin(ang) * radio * anillo };
  });
}

/** El texto de un tooltip del mapa satélite entra como HTML: se escapa lo que viene de los datos
 *  (placa, conductor, nombre de un lugar), para que un nombre con «<» no meta código en la pantalla. */
export function escaparHtml(texto: string): string {
  return texto.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string
  );
}

export type FiltroEstado = CatTv | "todas";

/** Cuántas unidades hay en un estado (o en total con «todas»): lo que dice la leyenda del mapa. */
export function contarPorEstado<T extends { cat: CatTv }>(filas: T[], k: FiltroEstado): number {
  return k === "todas" ? filas.length : filas.filter((f) => f.cat === k).length;
}

/** Las unidades que deja ver el filtro elegido en la leyenda. */
export function filtrarPorEstado<T extends { cat: CatTv }>(filas: T[], k: FiltroEstado): T[] {
  return k === "todas" ? filas : filas.filter((f) => f.cat === k);
}
