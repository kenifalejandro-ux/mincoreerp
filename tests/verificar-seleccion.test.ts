/** tests/verificar-seleccion.test.ts
 *
 * Qué verifica la puerta antes de subir (scripts/verificarSeleccion.ts). Un
 * error acá deja pasar un PR sin su e2e, o frena uno por nada: se prueba con
 * los casos que ya ocurrieron.
 */
import { describe, it, expect } from "vitest";
import {
  colisionesDeMigraciones,
  moduloDeArchivo,
  seleccionarVerificacion,
} from "../scripts/verificarSeleccion";

const TESTS = [
  "tests/combustible-urea.test.ts",
  "tests/combustible-urea-conteo-envase.test.ts",
  "tests/checklists-x.test.ts",
  "tests/equipos-rutas.test.ts",
  "tests/ordenes-trabajo-a.test.ts",
  "tests/helpers.ts",
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

  it("algo compartido (server, migraciones, config) corre la suite entera de vitest", () => {
    for (const f of ["src/server/config/database.ts", "migrations/0133_x.sql", "package.json"]) {
      const r = sel(f);
      expect(r.tests, f).toBe("todos");
      expect(r.specs, f).toEqual([]);
    }
  });

  it("el cliente de un módulo no corre tipos de backend ni e2e en local", () => {
    const r = sel("client/src/components/UreaPanel.tsx");
    expect(r.client).toBe(true);
    expect(r.backend).toBe(false);
    expect(r.specs).toEqual([]);
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
