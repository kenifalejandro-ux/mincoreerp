/** tests/setup.mailer.ts
 *
 * Corre en CADA archivo de test, ANTES que nada (primer entry de
 * `setupFiles` en vitest.config.mts, antes que setup.storage.ts).
 *
 * ── Por qué existe ──────────────────────────────────────────────────────
 *
 * Pasó de verdad, 2026-08-28: la máquina de Kenif tiene SMTP real
 * configurado en .env (Gmail personal, para poder probar el correo de
 * recuperación de contraseña) y ningún test hasta ahora ejercitaba ese
 * camino -- hasta la entrega 3 de Fase D, que agrega alertas de
 * combustible que SÍ mandan correo desde el propio flujo de negocio
 * (crear un despacho, anular un vale). La suite corrió esos flujos decenas
 * de veces contra el tenant de prueba `xxx@test.local`, y Gmail devolvió
 * cada uno como rebote -- a la bandeja de ENTRADA de Kenif, porque el
 * remitente configurado es su propio Gmail.
 *
 * `transporter` en mailer.ts (y `emailConfigured` en env.ts) se calculan
 * UNA sola vez, al importar esos módulos -- no alcanza con mutar `env.*`
 * después como hace setup.storage.ts con los drivers de storage (esos SÍ
 * se leen en cada llamada). Hay que vaciar `process.env.EMAIL_*` ANTES de
 * que `env.ts` se importe por primera vez -- por eso este archivo no
 * importa nada de la app, y por eso tiene que ir primero en `setupFiles`:
 * si `setup.storage.ts` corriera antes, su propio `import { env } from
 * ".../env"` ya habría fijado `emailConfigured` en base a las credenciales
 * reales, y esto llegaría tarde.
 *
 * Los tests que SÍ necesiten ejercitar el envío de correo lo hacen
 * mockeando `transporter`/`sendMail`, nunca contra SMTP real -- mismo
 * criterio que document-storage.test.ts con S3 (ver setup.storage.ts).
 */
process.env.EMAIL_HOST = "";
process.env.EMAIL_USER = "";
process.env.EMAIL_PASS = "";
process.env.EMAIL_PORT = "";
// Y la API de Brevo: sin clave ningún test puede mandar un correo real por ahí.
process.env.BREVO_API_KEY = "";
process.env.EMAIL_FROM = "";
