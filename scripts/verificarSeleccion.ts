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
 * ── Con el mapa de tests ────────────────────────────────────────────────
 *
 * Si hay un mapa vigente (scripts/mapa-tests.json, ver mapaTestsLogica.ts), un
 * cambio en src/ corre solo los tests que ejecutan las funciones que tocaste, en
 * vez de todo el módulo. Todo lo dudoso corre MÁS, nunca menos: un archivo que no
 * está en el mapa, un cambio fuera de toda función medida, o una función que
 * usa la mitad de los tests vuelven a la regla por módulo.
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

import { TEST_BASE, testsAfectados, type MapaTests, type Trozo } from "./mapaTestsLogica";

/** El mapa de tests y los trozos de cada archivo cambiado, contra el commit del mapa. */
export interface ConMapa {
  mapa: MapaTests;
  hunks: Record<string, Trozo[]>;
}

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
  specsExistentes: string[],
  /** Sin esto se elige solo por módulo. */
  conMapa?: ConMapa
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

  const agregarHumo = (conMigracion: boolean) => {
    const humo = [...HUMO, ...(conMigracion ? HUMO_MIGRACION : [])].filter((t) =>
      testsExistentes.includes(t)
    );
    humo.forEach((t) => tests.add(t));
    return humo.length;
  };

  const compartido = relevantes.filter((f) => COMPARTIDO.test(f));
  if (compartido.length > 0) {
    const deHumo = agregarHumo(compartido.some((f) => f.startsWith("migrations/")));
    motivos.push(
      `cambió algo compartido (${compartido[0]}): ${deHumo} tests de humo; la suite entera la corre el CI (o --completo)`
    );
  }

  // Módulos cuyos tests corren completos: lo que no se puede afinar con el mapa.
  const modulos = new Set<string>();
  const conCambioMedido = relevantes.filter(
    (f) => conMapa && /^src\/.+\.ts$/.test(f) && !f.endsWith(".d.ts")
  );
  const delMapa = new Set<string>();
  const dudosos: string[] = [];
  for (const f of relevantes) {
    const m = moduloDeArchivo(f);
    if (!conMapa || !conCambioMedido.includes(f)) {
      if (m) modulos.add(m);
      continue;
    }
    const a = testsAfectados(conMapa.mapa, f, conMapa.hunks[f] ?? []);
    if (a.tipo === "sin-cambios") continue;
    if (a.tipo === "desconocido" || a.fuera || (a.transversal && m)) {
      dudosos.push(f);
      if (m) modulos.add(m);
    }
    if (a.tipo === "tests") {
      a.tests.forEach((t) => delMapa.add(`tests/${t}.test.ts`));
      if (a.transversal && !m && !COMPARTIDO.test(f)) agregarHumo(false);
    }
  }
  if (conMapa && conCambioMedido.length > 0) {
    const propios = [...delMapa].filter((t) => testsExistentes.includes(t));
    propios.forEach((t) => tests.add(t));
    motivos.push(
      `mapa de tests: ${conCambioMedido.length} archivos de src/ → ${propios.length} tests que ejecutan lo que cambiaste`
    );
    if (dudosos.length > 0) {
      motivos.push(
        `sin afinar con el mapa (${dudosos[0]}${dudosos.length > 1 ? ` y ${dudosos.length - 1} más` : ""}): no figura en el mapa, cambió código que corre al arrancar, o lo usa la mitad de los tests`
      );
    }
  }
  if (conMapa) {
    const nuevos = testsExistentes.filter((t) => {
      const nombre = t.slice(6, -".test.ts".length);
      return /\.test\.ts$/.test(t) && nombre !== TEST_BASE && !(nombre in conMapa.mapa.tests);
    });
    nuevos.forEach((t) => tests.add(t));
    if (nuevos.length > 0)
      motivos.push(`${nuevos.length} tests que no están en el mapa (posteriores a su generación)`);
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
