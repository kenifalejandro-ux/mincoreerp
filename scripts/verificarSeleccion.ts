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
 * compartido (src/server, migraciones, config), se suma un "humo": los pocos
 * tests que atrapan lo más grave de un cambio transversal (RLS, aislamiento
 * entre tenants y, con migraciones, índices y respaldo). La suite entera
 * (15 min en una laptop) la corre el CI en el PR, o acá con --completo.
 *
 * ── Por qué en local solo los specs que tocaste ─────────────────────────
 *
 * Antes se corrían acá todos los e2e del módulo, en chromium y firefox. En
 * una laptop más lenta que el runner del CI eso tardaba mucho por push y a
 * veces fallaba por la máquina, no por el código. Ahora los e2e del módulo
 * los corre el CI en cada PR (todos los specs en chromium, y en webkit los de
 * celular) y los 3 navegadores cada noche: ver ci.yml.
 *
 * Lo que sí se corre acá es el spec que creaste o modificaste, una vez (ver
 * verificar.ts). Repetirlo 5 veces seguidas para cazar los inestables lo hace
 * el CI en el PR (ver ci.yml), para no ocupar esta máquina.
 */

export interface Seleccion {
  /** Nada que verificar (solo documentación, o sin cambios). */
  nada: boolean;
  backend: boolean;
  client: boolean;
  /** Archivos de test de vitest. */
  tests: string[];
  /** Specs de Playwright que la persona creó o modificó (nombres dentro de e2e/). */
  specs: string[];
  /** Por qué se eligió lo que se eligió, para mostrarlo. */
  motivos: string[];
}

const SOLO_DOCS = /^(docs\/|\.claude\/)|\.md$/;
const COMPARTIDO =
  /^(src\/server\/|migrations\/|package(-lock)?\.json$|vitest\.config|tests\/(helpers|setup)|tsconfig|server\.ts$|migrate\.ts$|scripts\/e2eLocal\.ts$)/;
/** Lo que corre cualquier cambio compartido. */
const HUMO = ["tests/rls-coverage.test.ts", "tests/tenant-isolation.test.ts"];
/** Lo que además corre una migración. */
const HUMO_MIGRACION = [
  "tests/db-index-coverage.test.ts",
  "tests/backup-tablas-registradas.test.ts",
];

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

  const compartido = relevantes.filter((f) => COMPARTIDO.test(f));
  if (compartido.length > 0) {
    const humo = [
      ...HUMO,
      ...(compartido.some((f) => f.startsWith("migrations/")) ? HUMO_MIGRACION : []),
    ];
    const deHumo = humo.filter((t) => testsExistentes.includes(t));
    deHumo.forEach((t) => tests.add(t));
    motivos.push(
      `cambió algo compartido (${compartido[0]}): ${deHumo.length} tests de humo; la suite entera la corre el CI (o --completo)`
    );
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
    tests: [...tests].sort(),
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
