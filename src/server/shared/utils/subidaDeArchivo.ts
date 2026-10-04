/** src/server/shared/utils/subidaDeArchivo.ts
 *
 * Fábrica del middleware de subida de UN archivo. Nació como
 * `documentos.upload.ts` y se movió acá cuando Combustible necesitó lo
 * mismo para la foto de la boleta de una compra en ruta (0109): el mismo
 * multer, la misma traducción de errores y el mismo criterio de memoria en
 * vez de disco, dos veces, es una copia esperando a divergir.
 *
 * Memoria y no disco temporal: el tamaño máximo es chico a propósito para
 * que tenerlo un instante en un Buffer no sea un problema, y así ni el
 * driver local ni el s3 necesitan lidiar con un archivo temporal que
 * limpiar.
 *
 * Traduce los rechazos de multer (tipo no permitido, tamaño excedido) a
 * AppError con mensaje claro -- sin esto, un archivo de 11 MB terminaría
 * como un 500 genérico en vez de un 400 explicando el límite. Y para la
 * cola offline la diferencia no es cosmética: un 5xx se reintenta para
 * siempre, un 4xx se descarta.
 */
import multer, { MulterError } from "multer";
import type { NextFunction, Request, Response } from "express";
import { AppError } from "../middlewares/error.middleware";

export interface OpcionesDeSubida {
  /** Nombre del campo del FormData. */
  campo: string;
  mimeTypesPermitidos: Set<string>;
  maxBytes: number;
  /** Para el mensaje del límite: "El archivo supera el máximo de 10 MB". */
  etiquetaMaximo: string;
}

export function crearMiddlewareDeSubida(opciones: OpcionesDeSubida) {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: opciones.maxBytes },
    fileFilter: (_req, file, cb) => {
      if (!opciones.mimeTypesPermitidos.has(file.mimetype)) {
        cb(
          new AppError(
            400,
            `Tipo de archivo no permitido (${file.mimetype}). Solo se acepta PDF, JPG o PNG.`
          )
        );
        return;
      }
      cb(null, true);
    },
  }).single(opciones.campo);

  return function subirArchivo(req: Request, res: Response, next: NextFunction) {
    upload(req, res, (err: unknown) => {
      if (err instanceof MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          next(
            new AppError(400, `El archivo supera el máximo permitido de ${opciones.etiquetaMaximo}`)
          );
          return;
        }
        next(new AppError(400, `Error al subir el archivo: ${err.message}`));
        return;
      }
      if (err) {
        next(err);
        return;
      }
      if (!req.file) {
        next(
          new AppError(400, `No se recibió ningún archivo (campo esperado: '${opciones.campo}')`)
        );
        return;
      }
      next();
    });
  };
}
