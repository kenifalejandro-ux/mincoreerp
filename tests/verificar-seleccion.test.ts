/** tests/verificar-seleccion.test.ts
 *
 * Qué verifica la puerta antes de subir (scripts/verificarSeleccion.ts). Un
 * error acá deja pasar un PR sin su e2e, o frena uno por nada: se prueba con
 * los casos que ya ocurrieron.
 */
import { describe, it, expect } from "vitest";
import type { MapaTests, Trozo } from "../scripts/mapaTestsLogica";
import {
  colisionesDeMigraciones,
  moduloDeArchivo,
  seleccionarVerificacion,
  type ConMapa,
} from "../scripts/verificarSeleccion";

const TESTS = [
  "tests/combustible-urea.test.ts",
  "tests/combustible-urea-conteo-envase.test.ts",
  "tests/checklists-x.test.ts",
  "tests/equipos-rutas.test.ts",
  "tests/ordenes-trabajo-a.test.ts",
  "tests/helpers.ts",
  "tests/rls-coverage.test.ts",
  "tests/tenant-isolation.test.ts",
  "tests/db-index-coverage.test.ts",
  "tests/backup-tablas-registradas.test.ts",
];
const HUMO = ["tests/rls-coverage.test.ts", "tests/tenant-isolation.test.ts"];
const HUMO_MIGRACION = [
  "tests/backup-tablas-registradas.test.ts",
  "tests/db-index-coverage.test.ts",
];
const SPECS = [
  "login.spec.ts",
  "acceso-por-dni.spec.ts",
  "aislamiento-tenants.spec.ts",
  "combustible-excedente.spec.ts",
  "urea-conteo-suelto.spec.ts",
  "urea-corregir-litros.spec.ts",
  "urea-vale-renglones.spec.ts",
  "offline-checklists.spec.ts",
];
const sel = (...f: string[]) => seleccionarVerificacion(f, TESTS, SPECS);

describe("verificar: qué se corre según lo que cambió", () => {
  it("solo documentación no verifica nada", () => {
    expect(sel("docs/architecture/urea-industrial.md", "README.md").nada).toBe(true);
    expect(sel().nada).toBe(true);
  });

  it("tocar el servicio y un spec corre los tests del módulo y SOLO el spec tocado", () => {
    const r = sel(
      "src/modules/combustible/combustible.service.ts",
      "e2e/urea-conteo-suelto.spec.ts"
    );
    expect(r.backend).toBe(true);
    expect(r.tests).toEqual([
      "tests/combustible-urea-conteo-envase.test.ts",
      "tests/combustible-urea.test.ts",
    ]);
    // Los otros specs del módulo (urea-corregir-litros, el que falló en el
    // PR #270) los corre el CI en el PR, no la laptop.
    expect(r.specs).toEqual(["urea-conteo-suelto.spec.ts"]);
  });

  it("tocar código sin tocar ningún spec no corre e2e en local, y lo dice", () => {
    const r = sel("src/modules/combustible/combustible.service.ts");
    expect(r.specs).toEqual([]);
    expect(r.motivos.join(" ")).toMatch(/no tocaste ningún spec/);
  });

  it("un módulo con guion bajo busca sus tests con guion medio", () => {
    expect(sel("src/modules/ordenes_trabajo/x.ts").tests).toEqual([
      "tests/ordenes-trabajo-a.test.ts",
    ]);
  });

  it("algo compartido (server, config, helpers) corre solo el humo, no la suite entera", () => {
    for (const f of ["src/server/config/database.ts", "package.json", "tests/helpers.ts"]) {
      const r = sel(f);
      expect(r.tests, f).toEqual(HUMO);
      expect(r.specs, f).toEqual([]);
      expect(r.motivos.join(" "), f).toMatch(/2 tests de humo/);
    }
  });

  it("una migración suma al humo los tests de índices y de respaldo", () => {
    const r = sel("migrations/0133_x.sql");
    expect(r.backend).toBe(true);
    expect(r.tests).toEqual([...HUMO, ...HUMO_MIGRACION].sort());
  });

  it("un cambio compartido junto a uno de módulo corre el módulo MÁS el humo", () => {
    const r = sel("src/modules/equipos/x.ts", "migrations/0133_x.sql");
    expect(r.tests).toEqual([...HUMO, ...HUMO_MIGRACION, "tests/equipos-rutas.test.ts"].sort());
  });

  it("si un test de humo no existe, no se inventa", () => {
    const r = seleccionarVerificacion(["src/server/x.ts"], ["tests/rls-coverage.test.ts"], []);
    expect(r.tests).toEqual(["tests/rls-coverage.test.ts"]);
  });

  it("el cliente de un módulo no corre tipos de backend, tests de backend ni e2e en local", () => {
    const r = sel("client/src/components/UreaPanel.tsx");
    expect(r.client).toBe(true);
    expect(r.backend).toBe(false);
    expect(r.tests).toEqual([]);
    expect(r.specs).toEqual([]);
    expect(r.motivos.join(" ")).toMatch(/cambió la pantalla.*sin tests de backend/);
  });

  it("pantalla y código del mismo módulo: solo el código elige tests de backend", () => {
    const r = sel("client/src/components/UreaPanel.tsx", "src/modules/ordenes_trabajo/x.ts");
    expect(r.tests).toEqual(["tests/ordenes-trabajo-a.test.ts"]);
  });

  it("un test o spec tocado se corre aunque su módulo no se reconozca", () => {
    const r = sel("tests/equipos-rutas.test.ts", "e2e/login.spec.ts");
    expect(r.tests).toEqual(["tests/equipos-rutas.test.ts"]);
    expect(r.specs).toEqual(["login.spec.ts"]);
  });

  it("moduloDeArchivo", () => {
    expect(moduloDeArchivo("src/modules/combustible/x.ts")).toBe("combustible");
    expect(moduloDeArchivo("client/src/components/combustible/Alertas.tsx")).toBe("combustible");
    expect(moduloDeArchivo("client/src/components/Checklists.tsx")).toBe("checklists");
    expect(moduloDeArchivo("src/server/x.ts")).toBeNull();
  });
});

describe("verificar: migraciones con el mismo número", () => {
  it("detecta dos ramas que tomaron el mismo siguiente número", () => {
    const r = colisionesDeMigraciones(
      ["migrations/0133_mi_cambio.sql"],
      ["migrations/0132_x.sql", "migrations/0133_otro_cambio.sql"]
    );
    expect(r).toEqual(["0133_mi_cambio.sql choca con 0133_otro_cambio.sql (ya en main)"]);
  });

  it("el mismo archivo ya en main no es choque, ni un número libre", () => {
    expect(colisionesDeMigraciones(["migrations/0133_a.sql"], ["migrations/0133_a.sql"])).toEqual(
      []
    );
    expect(colisionesDeMigraciones(["migrations/0134_a.sql"], ["migrations/0133_b.sql"])).toEqual(
      []
    );
  });
});

describe("verificar: con el mapa de tests", () => {
  const SERVICIO = "src/modules/combustible/combustible.service.ts";
  const SERVIDOR = "src/server/services/auth.service.ts";
  // Todos los tests del fixture figuran en el mapa (si no, correrían como "nuevos").
  const mapa: MapaTests = {
    version: 1,
    commit: "abc",
    generado: "2026-10-23T00:00:00.000Z",
    transversales: { [SERVICIO]: "100-110", [SERVIDOR]: "1-9" },
    tests: {
      "combustible-urea": { [SERVICIO]: "10-30" },
      "combustible-urea-conteo-envase": { [SERVICIO]: "40-60" },
      "checklists-x": {},
      "equipos-rutas": { [SERVIDOR]: "20-30" },
      "ordenes-trabajo-a": {},
      "rls-coverage": {},
      "tenant-isolation": {},
      "db-index-coverage": {},
      "backup-tablas-registradas": {},
    },
  };
  const trozo = (desde: number, hasta = desde, soloComentarios = false): Trozo[] => [
    { desde, hasta, soloComentarios },
  ];
  const conMapa = (hunks: Record<string, Trozo[]>): ConMapa => ({ mapa, hunks });
  const selM = (hunks: Record<string, Trozo[]>, ...f: string[]) =>
    seleccionarVerificacion(f, TESTS, SPECS, conMapa(hunks));

  it("una función del servicio corre solo los tests que la ejecutan, no el módulo", () => {
    const r = selM({ [SERVICIO]: trozo(15) }, SERVICIO);
    expect(r.tests).toEqual(["tests/combustible-urea.test.ts"]);
    expect(r.motivos.join(" ")).toMatch(/mapa de tests: 1 archivos de src\/ → 1 tests/);
  });

  it("otra función del mismo archivo corre otros tests", () => {
    expect(selM({ [SERVICIO]: trozo(50) }, SERVICIO).tests).toEqual([
      "tests/combustible-urea-conteo-envase.test.ts",
    ]);
  });

  it("un cambio fuera de toda función medida vuelve a la regla por módulo", () => {
    const r = selM({ [SERVICIO]: trozo(5) }, SERVICIO);
    expect(r.tests).toEqual([
      "tests/combustible-urea-conteo-envase.test.ts",
      "tests/combustible-urea.test.ts",
    ]);
    expect(r.motivos.join(" ")).toMatch(/sin afinar con el mapa/);
  });

  it("un archivo que no figura en el mapa vuelve a la regla por módulo", () => {
    const nuevo = "src/modules/combustible/tanquetas.nuevo.ts";
    expect(selM({ [nuevo]: trozo(1) }, nuevo).tests).toHaveLength(2);
  });

  it("una función transversal de un módulo vuelve a la regla por módulo", () => {
    expect(selM({ [SERVICIO]: trozo(105) }, SERVICIO).tests).toHaveLength(2);
  });

  it("solo comentarios o líneas en blanco no corren ningún test", () => {
    const r = selM({ [SERVICIO]: trozo(15, 15, true) }, SERVICIO);
    expect(r.tests).toEqual([]);
    expect(r.nada).toBe(false);
  });

  it("una función transversal de src/server corre solo el humo, como sin mapa", () => {
    expect(selM({ [SERVIDOR]: trozo(5) }, SERVIDOR).tests).toEqual(HUMO);
  });

  it("una función de src/server con tests suma esos tests al humo", () => {
    expect(selM({ [SERVIDOR]: trozo(25) }, SERVIDOR).tests).toEqual(
      [...HUMO, "tests/equipos-rutas.test.ts"].sort()
    );
  });

  it("un test que no está en el mapa corre siempre", () => {
    const tests = [...TESTS, "tests/combustible-tanqueta-nuevo.test.ts"];
    const r = seleccionarVerificacion([SERVICIO], tests, SPECS, conMapa({ [SERVICIO]: trozo(15) }));
    expect(r.tests).toContain("tests/combustible-tanqueta-nuevo.test.ts");
    expect(r.motivos.join(" ")).toMatch(/1 tests que no están en el mapa/);
  });

  it("el cliente de un módulo no corre tests de backend tampoco con mapa", () => {
    expect(selM({}, "client/src/components/UreaPanel.tsx").tests).toEqual([]);
  });

  it("el test de arranque (la línea base del mapa) no cuenta como test nuevo", () => {
    const tests = [...TESTS, "tests/app-arranca.test.ts"];
    const r = seleccionarVerificacion([SERVICIO], tests, SPECS, conMapa({ [SERVICIO]: trozo(15) }));
    expect(r.tests).toEqual(["tests/combustible-urea.test.ts"]);
  });

  it("sin mapa no cambia nada: el módulo entero", () => {
    expect(sel(SERVICIO).tests).toHaveLength(2);
  });
});
