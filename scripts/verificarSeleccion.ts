/** scripts/verificarSeleccion.ts
 *
 * Qué verificar antes de subir, según los archivos que cambiaron. Lógica pura
 * (sin git, sin Docker): por eso tiene su propio test.
 *
 * ── Por qué no `vitest related` ─────────────────────────────────────────
 *
 * Casi todos los tests de integración importan `app` desde tests/helpers, y
 * `app` importa todos los módulos: para vitest, "relacionado" sería TODO. Se
 * elige por módulo (src/modules/<m>/ → tests/<m>*.test.ts) y, si cambia algo
 * compartido (src/server, migraciones, config), se corre la suite entera.
 *
 * ── Por qué en local solo los specs que tocaste ─────────────────────────
 *
 * Antes se corrían acá todos los e2e del módulo, en chromium y firefox. En
 * una laptop más lenta que el runner del CI eso tardaba mucho por push y a
 * veces fallaba por la máquina, no por el código. Ahora los e2e del módulo
 * los corre el CI en cada PR (todos los specs en chromium, y en webkit los de
 * celular) y los 3 navegadores cada noche: ver ci.yml.
 *
 * Lo que sí se corre acá es el spec que creaste o modificaste, varias veces
 * seguidas (ver verificar.ts): un spec que pasa una vez por suerte es el que
 * después falla en el CI, y eso solo se ve repitiéndolo.
 */

export interface Seleccion {
  /** Nada que verificar (solo documentación, o sin cambios). */
  nada: boolean;
  backend: boolean;
  client: boolean;
  /** Archivos de test de vitest, o "todos" si cambió algo compartido. */
  tests: string[] | "todos";
  /** Specs de Playwright que la persona creó o modificó (nombres dentro de e2e/). */
  specs: string[];
  /** Por qué se eligió lo que se eligió, para mostrarlo. */
  motivos: string[];
}

const SOLO_DOCS = /^(docs\/|\.claude\/)|\.md$/;
const COMPARTIDO =
  /^(src\/server\/|migrations\/|package(-lock)?\.json$|vitest\.config|tests\/(helpers|setup)|tsconfig|server\.ts$|migrate\.ts$|scripts\/e2eLocal\.ts$)/;

/** El módulo al que pertenece un archivo, o null si es compartido/ajeno. */
export function moduloDeArchivo(archivo: string): string | null {
  const m = archivo.match(/^src\/modules\/([^/]+)\//);
  if (m) return m[1];
  if (archivo.startsWith("client/src/")) {
    if (/urea|combustible|tanque|surtidor|viaje|grifo|kardex|alerta/i.test(archivo)) {
      return "combustible";
    }
    if (/checklist/i.test(archivo)) return "checklists";
    if (/equipo/i.test(archivo)) return "equipos";
  }
  return null;
}

const comoNombreDeTest = (modulo: string) => modulo.replace(/_/g, "-");

export function seleccionarVerificacion(
  cambiados: string[],
  /** Todos los tests/*.test.ts que existen, con ruta ("tests/x.test.ts"). */
  testsExistentes: string[],
  /** Todos los e2e/*.spec.ts que existen, solo el nombre ("login.spec.ts"). */
  specsExistentes: string[]
): Seleccion {
  const relevantes = cambiados.filter((f) => !SOLO_DOCS.test(f));
  const vacia: Seleccion = {
    nada: true,
    backend: false,
    client: false,
    tests: [],
    specs: [],
    motivos: [],
  };
  if (relevantes.length === 0) return vacia;

  const tests = new Set<string>();
  const specs = new Set<string>();
  const motivos: string[] = [];
  let todosLosTests = false;

  const compartido = relevantes.filter((f) => COMPARTIDO.test(f));
  if (compartido.length > 0) {
    todosLosTests = true;
    motivos.push(`cambió algo compartido (${compartido[0]}): suite completa de vitest`);
  }

  const modulos = new Set<string>();
  for (const f of relevantes) {
    const m = moduloDeArchivo(f);
    if (m) modulos.add(m);
  }
  for (const m of modulos) {
    const prefijo = `tests/${comoNombreDeTest(m)}`;
    const deModulo = testsExistentes.filter((t) => t.startsWith(prefijo));
    deModulo.forEach((t) => tests.add(t));
    motivos.push(`módulo ${m}: ${deModulo.length} archivos de test`);
  }

  // Lo que la persona tocó directamente siempre se corre.
  for (const f of relevantes) {
    if (/^tests\/.+\.test\.ts$/.test(f) && testsExistentes.includes(f)) tests.add(f);
    const spec = f.match(/^e2e\/([^/]+\.spec\.ts)$/);
    if (spec && specsExistentes.includes(spec[1])) specs.add(spec[1]);
  }
  if (specs.size > 0) {
    motivos.push(`specs que creaste o modificaste: ${[...specs].sort().join(", ")}`);
  } else {
    motivos.push("no tocaste ningún spec: los e2e los corre el CI en el PR");
  }

  return {
    nada: false,
    backend: relevantes.some((f) => !f.startsWith("client/")),
    client: relevantes.some((f) => f.startsWith("client/")),
    tests: todosLosTests ? "todos" : [...tests].sort(),
    specs: [...specs].sort(),
    motivos,
  };
}

/** Migraciones nuevas de esta rama cuyo número ya usa OTRO archivo en main.
 *  Con varias ramas abiertas a la vez, dos ramas toman el mismo siguiente
 *  número, y el segundo merge rompe `migrate` en producción. */
export function colisionesDeMigraciones(propias: string[], enMain: string[]): string[] {
  const numero = (f: string) => f.match(/(?:^|\/)(\d{4})_/)?.[1] ?? null;
  const base = (f: string) => f.split("/").pop() ?? f;
  const choques: string[] = [];
  for (const p of propias) {
    const n = numero(p);
    if (!n) continue;
    const otro = enMain.find((m) => numero(m) === n && base(m) !== base(p));
    if (otro) choques.push(`${base(p)} choca con ${base(otro)} (ya en main)`);
  }
  return choques;
}
