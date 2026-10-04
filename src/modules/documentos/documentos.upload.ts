/** src/modules/documentos/documentos.upload.ts
 *
 * Middleware de subida para el archivo adjunto de un documento (PDF/imagen
 * de una licencia, certificado, etc).
 *
 * La mecánica (multer en memoria, traducción de los errores de multer a
 * AppError) vive en shared/utils/subidaDeArchivo.ts desde que Combustible
 * necesitó lo mismo para la foto de la boleta de una compra en ruta (0109).
 * Acá quedan solo los LÍMITES de este módulo, que son los que pueden
 * cambiar por su cuenta.
 */
import { crearMiddlewareDeSubida } from "../../server/shared/utils/subidaDeArchivo";

export const MIME_TYPES_PERMITIDOS = new Set(["application/pdf", "image/jpeg", "image/png"]);
export const TAMANO_MAXIMO_BYTES = 10 * 1024 * 1024;

export const subirArchivoDocumento = crearMiddlewareDeSubida({
  campo: "archivo",
  mimeTypesPermitidos: MIME_TYPES_PERMITIDOS,
  maxBytes: TAMANO_MAXIMO_BYTES,
  etiquetaMaximo: "10 MB",
});
