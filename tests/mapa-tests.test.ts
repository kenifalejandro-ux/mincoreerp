/** tests/mapa-tests.test.ts
 *
 * La lógica pura del mapa de tests (scripts/mapaTestsLogica.ts). Un error acá
 * hace que `verificar` corra de menos y deje pasar un PR roto: se prueba con
 * los casos que importan (restar el arranque, separar lo transversal).
 */
import { describe, it, expect } from "vitest";
import {
  analizarDiff,
  construirMapa,
  funcionesEjecutadas,
  mapaATexto,
  rangosATexto,
  restarBase,
  testsAfectados,
  textoARangos,
  type CoberturaFinal,
  type FuncionesPorArchivo,
  type MapaTests,
  type Trozo,
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

describe("mapa de tests: leer el diff contra el commit del mapa", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -10,2 +10,3 @@ function x() {",
    "-  const a = 1;",
    "-  const b = 2;",
    "+  const a = 3;",
    "+  const b = 4;",
    "+  const c = 5;",
    "@@ -40,0 +42,2 @@",
    "+// un comentario",
    "+",
    "@@ -90 +92 @@",
    "-  // viejo",
    "+  // nuevo",
    "diff --git a/src/b.ts b/src/b.ts",
    "--- a/src/b.ts",
    "+++ b/src/b.ts",
    "@@ -7,3 +7,0 @@",
    "-  borrado();",
    "-  otro();",
    "-  mas();",
  ].join("\n");
  const r = analizarDiff(diff);

  it("saca los trozos por archivo con las líneas del lado viejo", () => {
    expect(Object.keys(r)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(r["src/a.ts"][0]).toEqual({ desde: 10, hasta: 11, soloComentarios: false });
    expect(r["src/b.ts"]).toEqual([{ desde: 7, hasta: 9, soloComentarios: false }]);
  });

  it("un trozo que solo agrega va de la línea anterior a la siguiente", () => {
    expect(r["src/a.ts"][1]).toMatchObject({ desde: 40, hasta: 41 });
  });

  it("distingue lo que solo cambia comentarios o líneas en blanco", () => {
    expect(r["src/a.ts"][1].soloComentarios).toBe(true);
    expect(r["src/a.ts"][2]).toEqual({ desde: 90, hasta: 90, soloComentarios: true });
    expect(r["src/a.ts"][0].soloComentarios).toBe(false);
  });
});

describe("mapa de tests: qué tests corresponden a un cambio", () => {
  const mapa: MapaTests = {
    version: 1,
    commit: "abc",
    generado: "2026-10-23T00:00:00.000Z",
    transversales: { "src/a.ts": "50-60" },
    tests: {
      "t-uno": { "src/a.ts": "10-20" },
      "t-dos": { "src/a.ts": "10-20,30-40" },
      "t-tres": { "src/b.ts": "1-5" },
    },
  };
  const t = (desde: number, hasta = desde, soloComentarios = false): Trozo[] => [
    { desde, hasta, soloComentarios },
  ];

  it("una función cambiada apunta solo a los tests que la ejecutan", () => {
    expect(testsAfectados(mapa, "src/a.ts", t(15))).toEqual({
      tipo: "tests",
      tests: ["t-dos", "t-uno"],
      transversal: false,
      fuera: false,
    });
    expect(testsAfectados(mapa, "src/a.ts", t(35))).toMatchObject({ tests: ["t-dos"] });
  });

  it("un archivo que no está en el mapa es desconocido", () => {
    expect(testsAfectados(mapa, "src/nuevo.ts", t(1))).toEqual({ tipo: "desconocido" });
  });

  it("solo comentarios o líneas en blanco no piden ningún test", () => {
    expect(testsAfectados(mapa, "src/a.ts", t(15, 15, true))).toEqual({ tipo: "sin-cambios" });
  });

  it("un cambio entre funciones queda marcado como fuera de las funciones medidas", () => {
    expect(testsAfectados(mapa, "src/a.ts", t(25))).toMatchObject({ tests: [], fuera: true });
  });

  it("una función transversal queda marcada como tal", () => {
    expect(testsAfectados(mapa, "src/a.ts", t(55))).toMatchObject({
      tests: [],
      transversal: true,
      fuera: false,
    });
  });

  it("agregar algo justo al final de una función cuenta como tocarla", () => {
    expect(testsAfectados(mapa, "src/a.ts", t(20, 21))).toMatchObject({
      tests: ["t-dos", "t-uno"],
    });
  });
});
