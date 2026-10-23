/** tests/mapa-tests.test.ts
 *
 * La lógica pura del mapa de tests (scripts/mapaTestsLogica.ts). Un error acá
 * hace que `verificar` corra de menos y deje pasar un PR roto: se prueba con
 * los casos que importan (restar el arranque, separar lo transversal).
 */
import { describe, it, expect } from "vitest";
import {
  construirMapa,
  funcionesEjecutadas,
  mapaATexto,
  rangosATexto,
  restarBase,
  textoARangos,
  type CoberturaFinal,
  type FuncionesPorArchivo,
} from "../scripts/mapaTestsLogica";

const fn = (desde: number, hasta: number) => ({
  loc: { start: { line: desde }, end: { line: hasta } },
});
const como = (o: Record<string, string[]>): FuncionesPorArchivo =>
  new Map(Object.entries(o).map(([k, v]) => [k, new Set(v)]));

describe("mapa de tests: funciones ejecutadas", () => {
  it("toma solo las funciones con alguna ejecución y rutas relativas a la raíz", () => {
    const cobertura: CoberturaFinal = {
      "/repo/src/a.ts": {
        fnMap: { "0": fn(1, 5), "1": fn(10, 20), "2": fn(30, 40) },
        f: { "0": 3, "1": 0, "2": 1 },
      },
      "/repo/src/b.ts": { fnMap: { "0": fn(1, 2) }, f: { "0": 0 } },
    };
    const r = funcionesEjecutadas(cobertura, "/repo");
    expect([...(r.get("src/a.ts") ?? [])].sort()).toEqual(["1-5", "30-40"]);
    // Un archivo sin funciones ejecutadas no aparece.
    expect(r.has("src/b.ts")).toBe(false);
  });

  it("restarBase quita lo que ya ejecuta solo arrancar la app", () => {
    const test = como({ "src/a.ts": ["1-5", "10-20"], "src/b.ts": ["1-2"] });
    const base = como({ "src/a.ts": ["1-5"], "src/b.ts": ["1-2"] });
    const r = restarBase(test, base);
    expect([...(r.get("src/a.ts") ?? [])]).toEqual(["10-20"]);
    expect(r.has("src/b.ts")).toBe(false);
  });
});

describe("mapa de tests: construcción", () => {
  // 4 tests: login lo usan todos (transversal), la función de tanquetas solo uno.
  const medidos = {
    "t-uno": como({ "src/auth.ts": ["1-9"], "src/tanquetas.ts": ["5-30"] }),
    "t-dos": como({ "src/auth.ts": ["1-9"], "src/urea.ts": ["1-20"] }),
    "t-tres": como({ "src/auth.ts": ["1-9"], "src/urea.ts": ["1-20", "40-60"] }),
    "t-cuatro": como({ "src/auth.ts": ["1-9"] }),
  };
  const mapa = construirMapa(medidos, "abc123", "2026-10-23T00:00:00.000Z");

  it("separa como transversal lo que ejecutan la mitad o más de los tests", () => {
    expect(mapa.transversales).toEqual({ "src/auth.ts": "1-9", "src/urea.ts": "1-20" });
  });

  it("a cada test le deja solo lo propio", () => {
    expect(mapa.tests["t-uno"]).toEqual({ "src/tanquetas.ts": "5-30" });
    expect(mapa.tests["t-tres"]).toEqual({ "src/urea.ts": "40-60" });
    expect(mapa.tests["t-cuatro"]).toEqual({});
  });

  it("guarda el commit y es estable: mismo resultado, mismo texto", () => {
    expect(mapa.commit).toBe("abc123");
    const otra = construirMapa(medidos, "abc123", "2026-10-23T00:00:00.000Z");
    expect(mapaATexto(otra)).toBe(mapaATexto(mapa));
    expect(JSON.parse(mapaATexto(mapa))).toEqual(mapa);
  });
});

describe("mapa de tests: rangos", () => {
  it("se ordenan por línea y vuelven a números", () => {
    const texto = rangosATexto(["40-60", "5-30", "5-9"]);
    expect(texto).toBe("5-9,5-30,40-60");
    expect(textoARangos(texto)).toEqual([
      [5, 9],
      [5, 30],
      [40, 60],
    ]);
    expect(textoARangos(undefined)).toEqual([]);
  });
});
