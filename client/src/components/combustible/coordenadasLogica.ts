// El punto de un lugar en el mapa: leer lo que se pega y pasar entre píxeles y grados. Sin pantalla.

export interface Punto {
  lat: number;
  lon: number;
}

/** Lee «-5.9003, -76.0947» (como lo copia Google Maps) o con espacio o punto y coma. Null si no es un
 *  par de grados válido. */
export function parsearCoordenadas(texto: string): Punto | null {
  const limpio = texto.trim().replace(/[()°]/g, "").replace(/;/g, ",");
  const partes = limpio.includes(",") ? limpio.split(",") : limpio.split(/\s+/);
  if (partes.length !== 2) return null;
  const [lat, lon] = partes.map((p) => Number(p.trim().replace(",", ".")));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (partes.some((p) => p.trim() === "")) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

/** Seis decimales (unos 10 cm): lo que guarda la base. */
export const aGrados = (n: number) => Number(n.toFixed(6));

/** El recuadro del mapa del selector: el Perú. */
export const CAJA_PERU = { lon0: -81.6, lon1: -68.5, lat0: -18.6, lat1: 0.2 };

/** De un clic en el lienzo (ancho × alto) a grados. */
export function aPunto(x: number, y: number, ancho: number, alto: number): Punto {
  const { lon0, lon1, lat0, lat1 } = CAJA_PERU;
  return {
    lon: aGrados(lon0 + (x / ancho) * (lon1 - lon0)),
    lat: aGrados(lat1 - (y / alto) * (lat1 - lat0)),
  };
}

/** De grados a píxeles del lienzo. */
export function aPixeles(p: Punto, ancho: number, alto: number): { x: number; y: number } {
  const { lon0, lon1, lat0, lat1 } = CAJA_PERU;
  return {
    x: ((p.lon - lon0) / (lon1 - lon0)) * ancho,
    y: ((lat1 - p.lat) / (lat1 - lat0)) * alto,
  };
}

/** «-5.9003, -76.0947»: cómo se muestra y se vuelve a pegar. */
export const textoDePunto = (p: Punto | null) =>
  p ? `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}` : "";
