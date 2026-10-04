/** src/server/services/documentStorage.ts
 *
 * Dónde viven los archivos adjuntos del módulo Documentos (PDF/imagen de
 * una licencia, certificado, etc.). Mismo esqueleto de dos drivers detrás
 * de una interfaz que platformBackupStorage.ts, pero contenido distinto:
 * acá NO hay cifrado de cliente (no es información tan sensible como un
 * dump completo con password_hash, y el usuario necesita poder abrirlo
 * directo desde el navegador) y el driver "s3" reusa el MISMO bucket que
 * los backups (ver platformBackupS3.ts), bajo el prefijo "documentos/" en
 * vez de "backups/" -- no hace falta credenciales ni bucket aparte.
 *
 * Al escribir manda DOCUMENTOS_STORAGE_DRIVER. Al leer manda el driver con
 * el que se subió ESA versión puntual (documentos_versiones.storage_driver)
 * -- igual que backups, para que cambiar el driver no vuelva ilegibles las
 * versiones ya subidas.
 *
 * `obtenerDescarga()` centraliza la diferencia entre drivers para que el
 * controller no tenga que saber cuál está activo: con "s3" devuelve una URL
 * firmada de R2 (redirect, el navegador baja directo del bucket); con
 * "local" devuelve los bytes para que el controller los sirva él mismo (no
 * hay bucket al que redirigir).
 */
import { mkdir, writeFile, readFile, unlink } from "fs/promises";
import path from "path";
import { randomBytes } from "crypto";
import { Readable } from "stream";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { AppError } from "../shared/middlewares/error.middleware";
import { obtenerClienteS3, subirObjeto, borrarObjeto } from "./platformBackupS3";

export type DriverDocumento = "local" | "s3";

export const PREFIJO_DOCUMENTOS = "documentos/tenants";
const URL_DESCARGA_TTL_SEGUNDOS = 300;

export function driverDeEscrituraDocumentos(): DriverDocumento {
  return env.documentosStorageDriver === "s3" ? "s3" : "local";
}

// ── Red contra la pérdida silenciosa de archivos ─────────────────────────
// En Railway el disco del contenedor es EFÍMERO (no hay volumen en
// railway.json). Con el driver "local" en producción, cada deploy se lleva
// los PDF de los clientes y las fotos de los comprobantes de combustible, y
// nadie se entera hasta que alguien hace clic en "ver boleta" meses después
// y no hay nada.
//
// Es un fallo de configuración de UNA variable
// (DOCUMENTOS_STORAGE_DRIVER=s3), silencioso por naturaleza: todo "funciona"
// hasta el siguiente deploy. Un log de nivel error al arrancar es lo mínimo
// para que aparezca en Sentry en vez de descubrirse por una boleta perdida.
//
// No se lanza una excepción a propósito: tumbar el arranque de TODO el ERP
// porque los adjuntos no están bien configurados es peor que el problema
// que evita -- el resto del sistema (vales, tanques, alertas) funciona
// perfecto sin storage.
if (env.isProduction && env.documentosStorageDriver !== "s3") {
  logger.error(
    { driver: env.documentosStorageDriver },
    "DOCUMENTOS_STORAGE_DRIVER no es 's3' en producción: los archivos adjuntos " +
      "(documentos y comprobantes de combustible) se escriben en el disco efímero " +
      "del contenedor y se PIERDEN en cada deploy. Cargá las variables S3_* y " +
      "DOCUMENTOS_STORAGE_DRIVER=s3."
  );
}

/** Mismo criterio que platformBackupStorage.ts: las keys las genera siempre
 *  el servidor, pero se valida igual como defensa en profundidad. */
function validarKey(key: string): void {
  if (
    !key ||
    key.includes("..") ||
    key.startsWith("/") ||
    key.includes("\\") ||
    key.includes("\0")
  ) {
    throw new AppError(500, `Key de archivo de documento inválida: ${key}`);
  }
}

/** El nombre original lo elige quien sube el archivo -- no puede viajar tal
 *  cual a una key de S3 ni a una ruta en disco (separadores, "..", etc.). */
export function sanearNombreArchivo(nombre: string): string {
  const base = path.basename(nombre).replace(/[^a-zA-Z0-9._-]/g, "_");
  return base.slice(-100) || "archivo";
}

/** Dónde viven las fotos/PDF de las boletas y facturas de la compra en
 *  ruta (0109). Mismo bucket y mismas credenciales que Documentos --
 *  prefijo distinto para que se puedan listar, cotizar y archivar por
 *  separado (la regla de ciclo de vida de R2 que los manda a
 *  almacenamiento frío a los 12 meses se escribe sobre este prefijo). */
export const PREFIJO_COMPROBANTES = "combustible/comprobantes/tenants";

/** El tenant va en la key, no solo en la fila: si alguna vez hay que
 *  responder "qué archivos son de este cliente" --borrarlo, exportarlo,
 *  auditarlo-- se contesta con un prefijo y no con un JOIN. El sufijo
 *  aleatorio evita que dos subidas del mismo milisegundo se pisen. */
function construirKey(
  prefijo: string,
  tenantId: string,
  entidadId: number,
  nombreOriginal: string
): string {
  const sufijo = randomBytes(4).toString("hex");
  return `${prefijo}/${tenantId}/${entidadId}/${Date.now()}-${sufijo}-${sanearNombreArchivo(nombreOriginal)}`;
}

export function construirKeyDocumento(
  tenantId: string,
  documentoId: number,
  nombreOriginal: string
): string {
  return construirKey(PREFIJO_DOCUMENTOS, tenantId, documentoId, nombreOriginal);
}

export function construirKeyComprobante(
  tenantId: string,
  despachoId: number,
  nombreOriginal: string
): string {
  return construirKey(PREFIJO_COMPROBANTES, tenantId, despachoId, nombreOriginal);
}

function rutaLocal(key: string): string {
  return path.join(env.documentosDir, key);
}

/** Guarda una nueva versión en el driver de escritura configurado.
 *  Devuelve el driver usado (se persiste en documentos_versiones.storage_driver
 *  para que la lectura futura sepa cómo leerla, sin depender de la config
 *  vigente en ese momento). */
export async function guardarArchivoDocumento(
  key: string,
  contenido: Buffer,
  mimeType: string
): Promise<{ driver: DriverDocumento; bytes: number }> {
  validarKey(key);
  const driver = driverDeEscrituraDocumentos();

  if (driver === "s3") {
    const { bytes } = await subirObjeto(key, Readable.from(contenido), {}, mimeType);
    return { driver, bytes };
  }

  const destino = rutaLocal(key);
  await mkdir(path.dirname(destino), { recursive: true });
  await writeFile(destino, contenido);
  return { driver, bytes: contenido.length };
}

export type DescargaDocumento =
  { tipo: "redirect"; url: string } | { tipo: "stream"; contenido: Buffer };

/** Centraliza la diferencia entre drivers -- ver comentario de arriba. */
export async function obtenerDescarga(
  driver: DriverDocumento,
  key: string,
  nombreOriginal: string,
  mimeType: string
): Promise<DescargaDocumento> {
  validarKey(key);

  if (driver === "s3") {
    const url = await getSignedUrl(
      obtenerClienteS3(),
      new GetObjectCommand({
        Bucket: env.s3BucketName,
        Key: key,
        ResponseContentDisposition: `attachment; filename="${sanearNombreArchivo(nombreOriginal)}"`,
        ResponseContentType: mimeType,
      }),
      { expiresIn: URL_DESCARGA_TTL_SEGUNDOS }
    );
    return { tipo: "redirect", url };
  }

  const contenido = await readFile(rutaLocal(key));
  return { tipo: "stream", contenido };
}

/** No tira si el archivo ya no está -- mismo criterio que borrarBackup():
 *  quien llama (ej. borrar el documento completo) tiene que poder terminar
 *  de limpiar aunque el archivo ya hubiera desaparecido del storage. */
export async function borrarArchivoDocumento(driver: DriverDocumento, key: string): Promise<void> {
  validarKey(key);

  try {
    if (driver === "s3") {
      await borrarObjeto(key);
    } else {
      await unlink(rutaLocal(key));
    }
  } catch (err) {
    const codigo = (err as NodeJS.ErrnoException).code;
    const nombre = (err as Error).name;
    if (codigo === "ENOENT" || nombre === "NoSuchKey" || nombre === "NotFound") {
      logger.warn({ driver, key }, "El archivo de documento ya no existía al intentar borrarlo");
      return;
    }
    throw err;
  }
}
