/** tests/dni-unico-guardian.test.ts
 *
 * Los DNI de prueba salen de `dniUnico()` (tests/dniUnico.ts), nunca de `Math.random()`. Dos
 * altas con el mismo DNI en una empresa dan «409 Ya existe un usuario con ese correo o DNI», y con
 * decenas de altas por archivo un DNI al azar choca de vez en cuando en el CI. Lo que se fija:
 *
 * 1. `dniUnico()` da siempre 8 dígitos, sin empezar en 0, y no repite en 100.000 llamadas.
 * 2. Ningún test arma un DNI con `Math.random()` (guardián estático: si alguien vuelve a hacerlo,
 *    el mensaje dice archivo y línea).
 * 3. El propio guardián detecta las formas de escribirlo que se usaban antes.
 *
 * Estático a propósito: no levanta la app ni toca la base.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import { dniUnico } from "./dniUnico";

/** ¿Esta línea arma un DNI con Math.random? (la palabra «dni» y `Math.random` en la misma línea) */
function armaDniAlAzar(linea: string): boolean {
  return /dni/i.test(linea) && linea.includes("Math.random");
}

describe("DNI de prueba: dniUnico() y el guardián", () => {
  it("dniUnico() da 8 dígitos, no empieza en 0 y no repite en 100.000 llamadas", () => {
    const vistos = new Set<string>();
    for (let i = 0; i < 100_000; i++) {
      const dni = dniUnico();
      expect(dni).toMatch(/^[1-9]\d{7}$/);
      vistos.add(dni);
    }
    expect(vistos.size).toBe(100_000);
  });

  it("ningún test arma un DNI con Math.random()", () => {
    const aqui = __dirname;
    const infracciones: string[] = [];
    for (const archivo of readdirSync(aqui)) {
      // Este archivo cita `Math.random` para explicarlo; el generador lo usa solo para el punto
      // de partida del contador.
      if (!archivo.endsWith(".ts")) continue;
      if (archivo === "dni-unico-guardian.test.ts" || archivo === "dniUnico.ts") continue;
      readFileSync(join(aqui, archivo), "utf8")
        .split("\n")
        .forEach((linea, i) => {
          if (armaDniAlAzar(linea)) infracciones.push(`tests/${archivo}:${i + 1}  ${linea.trim()}`);
        });
    }
    expect(
      infracciones,
      `Estos tests arman un DNI con Math.random(); usa dniUnico() de ./helpers:\n${infracciones.join("\n")}`
    ).toEqual([]);
  });

  it("el guardián reconoce las formas con las que se armaba el DNI antes", () => {
    const antiguas = [
      "const dni = String(86100000 + Math.floor(Math.random() * 800000) + seq++);",
      "dni: String(Math.floor(10_000_000 + Math.random() * 89_999_999)),",
      "conductor_dni: String(40200000 + Math.floor(Math.random() * 90000)),",
      'dni: `8${Math.floor(Math.random() * 1e7)}`.padEnd(8, "1").slice(0, 8),',
    ];
    for (const linea of antiguas) expect(armaDniAlAzar(linea), linea).toBe(true);
    // Lo que NO es un DNI no se marca.
    expect(armaDniAlAzar("const serie = `S${Math.floor(Math.random() * 1e8)}`;")).toBe(false);
    expect(armaDniAlAzar("const dni = dniUnico();")).toBe(false);
  });
});
