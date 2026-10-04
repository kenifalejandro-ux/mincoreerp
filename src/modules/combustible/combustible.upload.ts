/** src/modules/combustible/combustible.upload.ts
 *
 * Subida de la foto (o el PDF) del comprobante de una compra en ruta
 * (0109). Mismo middleware que Documentos, con un límite propio.
 *
 * ── Por qué 6 MB y no los 10 de Documentos ────────────────────────────────
 *
 * El frontend comprime la foto antes de subirla (~1600 px de lado mayor,
 * JPEG medio) y una boleta queda legible en 150-300 kB. 6 MB deja pasar
 * igual una foto SIN comprimir de un celular moderno --el caso de una app
 * vieja en la cola, o de alguien subiendo desde la computadora-- y a la vez
 * acota lo que un cliente malicioso puede empujar al bucket por request.
 *
 * El límite importa más acá que en Documentos: esto lo sube un conductor en
 * ruta con señal mala, y un archivo de 10 MB en una red de cancha es una
 * subida que no termina nunca y reintenta sola desde la cola.
 */
import { crearMiddlewareDeSubida } from "../../server/shared/utils/subidaDeArchivo";

/** Los mismos tres de Documentos: la foto del papel (JPG/PNG) o el PDF que
 *  algunos proveedores mandan por correo. Nada ejecutable, nada de office. */
export const MIME_TYPES_COMPROBANTE = new Set(["application/pdf", "image/jpeg", "image/png"]);
export const TAMANO_MAXIMO_COMPROBANTE_BYTES = 6 * 1024 * 1024;

export const subirArchivoComprobante = crearMiddlewareDeSubida({
  campo: "archivo",
  mimeTypesPermitidos: MIME_TYPES_COMPROBANTE,
  maxBytes: TAMANO_MAXIMO_COMPROBANTE_BYTES,
  etiquetaMaximo: "6 MB",
});
