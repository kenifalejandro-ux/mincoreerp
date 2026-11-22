/** src/server/shared/utils/platformCrypto.ts
 *
 * Cifrado reversible para secretos de plataforma que, a diferencia de una
 * contraseña (bcrypt, de un solo sentido), necesitan volver a leerse en
 * texto plano más adelante — hoy el único caso es
 * tenant_sso_config.client_secret_cifrado: hace falta mandárselo de vuelta
 * al proveedor OIDC en cada intercambio de código por tokens, así que un
 * hash no sirve.
 *
 * AES-256-GCM con una clave de aplicación separada (APP_ENCRYPTION_KEY,
 * nunca la misma que JWT_SECRET) — alcanza para este caso: un solo secreto
 * por tenant, no un almacén de muchos secretos con rotación por clave
 * (para eso haría falta un KMS de verdad, fuera de alcance acá). IV
 * aleatorio de 12 bytes por valor (nunca reusado con la misma clave) y el
 * auth tag de GCM viajan concatenados en el mismo string cifrado — no hace
 * falta guardarlos aparte.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "crypto";
import { env } from "../../config/env";
import { AppError } from "../middlewares/error.middleware";

const ALGORITMO = "aes-256-gcm";
const IV_BYTES = 12;

function claveAplicacion(): Buffer {
  if (!env.appEncryptionKey) {
    throw new AppError(503, "Cifrado de plataforma no configurado (falta APP_ENCRYPTION_KEY)");
  }
  const clave = Buffer.from(env.appEncryptionKey, "base64");
  if (clave.length !== 32) {
    throw new AppError(500, "APP_ENCRYPTION_KEY inválida: debe decodificar a 32 bytes en base64");
  }
  return clave;
}

/** iv (12) + authTag (16) + ciphertext, todo concatenado y codificado en
 *  base64 — un solo string que entra sin fricción en una columna TEXT. */
export function cifrar(textoPlano: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITMO, claveAplicacion(), iv);
  const cifrado = Buffer.concat([cipher.update(textoPlano, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, cifrado]).toString("base64");
}

export function descifrar(valorCifrado: string): string {
  const datos = Buffer.from(valorCifrado, "base64");
  const iv = datos.subarray(0, IV_BYTES);
  const authTag = datos.subarray(IV_BYTES, IV_BYTES + 16);
  const cifrado = datos.subarray(IV_BYTES + 16);

  const decipher = createDecipheriv(ALGORITMO, claveAplicacion(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(cifrado), decipher.final()]).toString("utf8");
}

/** Huella NO reversible de un valor (HMAC-SHA256 con la clave de aplicación, en hexadecimal): sirve para
 *  saber si dos valores son iguales (p. ej. impedir la misma cuenta bancaria dos veces) sin guardar el
 *  valor. Con otra clave da otra huella; no se usa para nada que deba sobrevivir a una rotación. */
export function huellaDe(textoPlano: string): string {
  return createHmac("sha256", claveAplicacion()).update(`huella:${textoPlano}`).digest("hex");
}
