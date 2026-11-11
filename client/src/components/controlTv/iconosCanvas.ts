// Los íconos de unidad (tiposUnidad.ts) dibujados dentro de un lienzo o de un marcador de Leaflet. El
// dibujo es el mismo SVG de la vista de marcas: se convierte en imagen una vez por tipo, color y alto,
// y se guarda. La imagen se pide al dibujar; cuando termina de cargar, avisa para que se redibuje.
import { claseDeTipo, FORMAS } from "./tiposUnidad";

/** El SVG de un tipo de unidad, con su trazo en el color pedido (el dibujo es fijo, nunca texto del usuario). */
export function svgDeTipo(tipo: string | null | undefined, color: string, alto: number): string {
  const f = FORMAS[claseDeTipo(tipo)];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${f.w} 24" width="${(f.w * alto) / 24}" height="${alto}" fill="none" stroke="${color}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${f.d}</svg>`;
}

const imagenes = new Map<string, HTMLImageElement>();

/** La imagen lista del ícono, o null si todavía está cargando (entonces `alCargar` se llama al terminar).
 *  Se dibuja al doble de tamaño para que se vea nítida en pantallas de alta densidad. */
export function imagenDeTipo(
  tipo: string | null | undefined,
  color: string,
  alto: number,
  alCargar: () => void
): HTMLImageElement | null {
  const k = `${claseDeTipo(tipo)}|${color}|${alto}`;
  let img = imagenes.get(k);
  if (!img) {
    img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgDeTipo(tipo, color, alto * 2))}`;
    imagenes.set(k, img);
  }
  if (img.complete && img.naturalWidth > 0) return img;
  img.addEventListener("load", alCargar, { once: true });
  return null;
}
