/** tests/dniUnico.ts
 *
 * Un DNI de prueba que NO se repite. Antes cada test armaba el suyo con `Math.random()`
 * («86100000 + Math.floor(Math.random() * 800000) + seq++») y, con decenas de altas por archivo, a
 * veces dos salían iguales: «409 Ya existe un usuario con ese correo o DNI» en el CI. El índice
 * único del DNI es por empresa (0084), pero el login por DNI mira TODAS las empresas (0125), así que
 * conviene que tampoco se repitan entre archivos que corren a la vez.
 *
 * Cómo se garantiza:
 *   · Los 2 primeros dígitos salen del proceso de vitest (`VITEST_POOL_ID`, 1..N): dos procesos que
 *     corren a la vez nunca comparten rango.
 *   · Los 6 siguientes son un contador que EMPIEZA en un punto al azar de cada archivo y sube de a
 *     uno: dentro de un proceso no repite nunca (hasta 1.000.000 de altas).
 *
 * Archivo sin dependencias a propósito: lo importa `helpers.ts` (que lo reexporta) y el test
 * guardián (`dni-unico-guardian.test.ts`), que no debe levantar la app para probarlo.
 */
const proceso = Number(process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? 0);
// 10..99: dos dígitos, sin ceros a la izquierda (un DNI no empieza en 0).
const prefijo = 10 + (Number.isFinite(proceso) ? proceso % 90 : 0);

let siguiente = Math.floor(Math.random() * 1_000_000);

/** Un DNI de 8 dígitos que no se repite dentro del proceso ni entre procesos paralelos. */
export function dniUnico(): string {
  const n = siguiente++ % 1_000_000;
  return `${prefijo}${String(n).padStart(6, "0")}`;
}
