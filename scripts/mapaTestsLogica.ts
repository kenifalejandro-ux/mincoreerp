/** scripts/mapaTestsLogica.ts
 *
 * Lógica pura (sin git, sin Docker, sin vitest) del mapa de tests: qué funciones
 * de src/ ejecuta cada archivo de test. La usan `mapaTests.ts` (que lo genera) y
 * `verificarSeleccion.ts` (que lo consulta). Por eso tiene su propio test.
 *
 * ── Por qué por función y no por archivo ────────────────────────────────
 *
 * combustible.service.ts, .repository.ts y .controller.ts son archivos enormes
 * que casi todos los tests de combustible ejecutan en alguna parte: por archivo,
 * tocar cualquiera de ellos apunta a ~100 tests, o sea todo el módulo. Por
 * función se distingue: un cambio en una función de tanquetas apunta solo a los
 * tests que la ejecutan (en seis PR reales de tanquetas salieron de 6 a 75).
 *
 * ── Qué se resta ─────────────────────────────────────────────────────────
 *
 * Casi todos los tests importan `app`, y arrancarla ejecuta código de TODOS los
 * módulos. Sin restar eso, cada test quedaría ligado a todo. Se resta lo que
 * ejecuta `tests/app-arranca.test.ts` (la línea base: solo arranca la app), y
 * además las funciones que ejecuta la mitad o más de los tests (login,
 * middlewares, crear el tenant de prueba): esas son "transversales" y un cambio
 * en ellas se trata como cambio compartido, no como un cambio de un módulo.
 *
 * Las funciones se identifican por su rango de líneas en el commit con el que se
 * midió; por eso el mapa guarda ese commit: los cambios se miran contra él.
 */

/** Lo que vitest escribe en coverage-final.json (solo lo que se usa). */
export type CoberturaFinal = Record<
  string,
  {
    fnMap: Record<string, { loc: { start: { line: number }; end: { line: number } } }>;
    f: Record<string, number>;
  }
>;

/** archivo → rangos "inicio-fin" de las funciones ejecutadas. */
export type FuncionesPorArchivo = Map<string, Set<string>>;

export interface MapaTests {
  version: 1;
  /** Commit sobre el que se midió: los rangos son de ese commit. */
  commit: string;
  generado: string;
  /** archivo → "a-b,c-d": funciones que ejecutan la mitad o más de los tests. */
  transversales: Record<string, string>;
  /** test (sin ".test.ts") → archivo → "a-b,c-d". */
  tests: Record<string, Record<string, string>>;
}

/** Fracción de tests a partir de la cual una función se considera transversal. */
export const UMBRAL_TRANSVERSAL = 0.5;

/** Funciones con alguna ejecución, por archivo de src/ (ruta relativa a la raíz). */
export function funcionesEjecutadas(cobertura: CoberturaFinal, raiz: string): FuncionesPorArchivo {
  const prefijo = raiz.endsWith("/") ? raiz : `${raiz}/`;
  const r: FuncionesPorArchivo = new Map();
  for (const [archivo, datos] of Object.entries(cobertura)) {
    const rel = archivo.startsWith(prefijo) ? archivo.slice(prefijo.length) : archivo;
    const rangos = new Set<string>();
    for (const [id, veces] of Object.entries(datos.f)) {
      if (veces <= 0) continue;
      const { start, end } = datos.fnMap[id].loc;
      rangos.add(`${start.line}-${end.line}`);
    }
    if (rangos.size > 0) r.set(rel, rangos);
  }
  return r;
}

/** Lo que el test ejecuta además de lo que ya ejecuta solo arrancar la app. */
export function restarBase(
  test: FuncionesPorArchivo,
  base: FuncionesPorArchivo
): FuncionesPorArchivo {
  const r: FuncionesPorArchivo = new Map();
  for (const [archivo, rangos] of test) {
    const deBase = base.get(archivo);
    const propios = [...rangos].filter((x) => !deBase?.has(x));
    if (propios.length > 0) r.set(archivo, new Set(propios));
  }
  return r;
}

const comoNumeros = (r: string) => r.split("-").map(Number);
const porLinea = (a: string, b: string) => {
  const [a1, a2] = comoNumeros(a);
  const [b1, b2] = comoNumeros(b);
  return a1 - b1 || a2 - b2;
};

export const rangosATexto = (rangos: Iterable<string>) => [...rangos].sort(porLinea).join(",");
export const textoARangos = (texto: string | undefined): [number, number][] =>
  texto ? texto.split(",").map((r) => comoNumeros(r) as [number, number]) : [];

/** Arma el mapa: separa las funciones transversales y deja a cada test las suyas. */
export function construirMapa(
  /** Por test, lo que ejecuta ya sin la línea base. */
  medidos: Record<string, FuncionesPorArchivo>,
  commit: string,
  generado: string
): MapaTests {
  const nombres = Object.keys(medidos).sort();
  const cuantos = new Map<string, number>(); // "archivo|a-b" → tests que la ejecutan
  for (const n of nombres)
    for (const [archivo, rangos] of medidos[n])
      for (const r of rangos)
        cuantos.set(`${archivo}|${r}`, (cuantos.get(`${archivo}|${r}`) ?? 0) + 1);

  const esTransversal = (archivo: string, r: string) =>
    (cuantos.get(`${archivo}|${r}`) ?? 0) >= nombres.length * UMBRAL_TRANSVERSAL;

  const transversales = new Map<string, Set<string>>();
  const tests: MapaTests["tests"] = {};
  for (const n of nombres) {
    const propios: Record<string, string> = {};
    for (const [archivo, rangos] of [...medidos[n]].sort(([a], [b]) => a.localeCompare(b))) {
      const suyos: string[] = [];
      for (const r of rangos) {
        if (esTransversal(archivo, r)) {
          if (!transversales.has(archivo)) transversales.set(archivo, new Set());
          transversales.get(archivo)?.add(r);
        } else suyos.push(r);
      }
      if (suyos.length > 0) propios[archivo] = rangosATexto(suyos);
    }
    tests[n] = propios;
  }
  const comoTexto: Record<string, string> = {};
  for (const [archivo, rangos] of [...transversales].sort(([a], [b]) => a.localeCompare(b)))
    comoTexto[archivo] = rangosATexto(rangos);
  return { version: 1, commit, generado, transversales: comoTexto, tests };
}

/** El JSON con un test por línea, para que regenerar el mapa dé diffs legibles. */
export function mapaATexto(m: MapaTests): string {
  const lineas = (o: Record<string, unknown>) =>
    Object.entries(o)
      .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`)
      .join(",\n");
  return (
    `{\n"version": ${m.version},\n"commit": ${JSON.stringify(m.commit)},\n` +
    `"generado": ${JSON.stringify(m.generado)},\n` +
    `"transversales": {\n${lineas(m.transversales)}\n},\n"tests": {\n${lineas(m.tests)}\n}\n}\n`
  );
}
