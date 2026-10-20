// client/src/components/combustible/fotoComprobante.ts
//
// Una sola definición de "qué foto se acepta" para el comprobante de una compra
// en ruta: JPG/PNG o PDF, comprimida en el teléfono antes de subir (la señal en
// ruta es mala), máximo 6 MB. La usan el formulario de Compra en ruta y el
// historial unificado (adjuntar o reemplazar la foto después).
import { comprimirImagen } from "./comprimirImagen";

export const TIPOS_FOTO_COMPROBANTE = ["image/jpeg", "image/png", "application/pdf"];
const MAXIMO_BYTES = 6 * 1024 * 1024;

export async function prepararFotoComprobante(
  archivo: File
): Promise<{ lista: File } | { error: string }> {
  if (!TIPOS_FOTO_COMPROBANTE.includes(archivo.type)) {
    return { error: "Solo se acepta foto (JPG/PNG) o PDF." };
  }
  const lista = await comprimirImagen(archivo);
  if (lista.size > MAXIMO_BYTES) return { error: "El archivo supera el máximo de 6 MB." };
  return { lista };
}
