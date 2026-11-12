/** tests/lugares-tipo-logica.test.ts
 *
 * El tipo de un lugar (Viajes › Lugares) es opcional y libre: cómo se normaliza lo que se escribe, cómo se
 * ve y qué ofrece la lista al escribir (los tres de siempre y los propios, sin repetir). Sin pantalla.
 */
import { describe, it, expect } from "vitest";
import {
  etiquetaDeTipo,
  normalizarTipo,
  opcionesDeTipo,
} from "../client/src/components/combustible/tiposLugarLogica";

describe("lugares: normalizar y mostrar el tipo", () => {
  it("quita espacios de más y pasa a minúsculas: «Mina», «mina» y « MINA » son lo mismo", () => {
    expect(normalizarTipo("Mina")).toBe("mina");
    expect(normalizarTipo("  MINA ")).toBe("mina");
    expect(normalizarTipo("Planta   Piloto")).toBe("planta piloto");
    expect(normalizarTipo(null)).toBe("");
    expect(normalizarTipo(undefined)).toBe("");
    expect(normalizarTipo("   ")).toBe("");
  });

  it("los tres de siempre se ven con su nombre y los propios con la primera letra en mayúscula", () => {
    expect(etiquetaDeTipo("mina")).toBe("Mina");
    expect(etiquetaDeTipo("abastecimiento")).toBe("Abastecimiento");
    expect(etiquetaDeTipo("planta piloto")).toBe("Planta piloto");
    expect(etiquetaDeTipo("  PUERTO ")).toBe("Puerto");
    expect(etiquetaDeTipo(null)).toBe("");
    expect(etiquetaDeTipo("")).toBe("");
  });
});

describe("lugares: la lista del campo Tipo", () => {
  const lugares = [
    { tipo: "mina" },
    { tipo: "Planta Piloto" },
    { tipo: "planta  piloto" }, // el mismo tipo escrito de otra forma
    { tipo: "puerto" },
    { tipo: null },
    { tipo: "" },
  ];

  it("sin escribir ofrece los tres de siempre y los propios, sin repetir", () => {
    expect(opcionesDeTipo(lugares, "").map((o) => o.etiqueta)).toEqual([
      "Mina",
      "Ciudad",
      "Abastecimiento",
      "Planta piloto",
      "Puerto",
    ]);
  });

  it("al escribir se filtra, sin importar mayúsculas ni tildes", () => {
    expect(opcionesDeTipo(lugares, "ABAST").map((o) => o.valor)).toEqual(["abastecimiento"]);
    expect(opcionesDeTipo(lugares, "pl").map((o) => o.valor)).toEqual(["planta piloto"]);
    expect(opcionesDeTipo([{ tipo: "Estación" }], "estacion").map((o) => o.valor)).toEqual([
      "estación",
    ]);
  });

  it("lo que no coincide con nada da una lista vacía (se usa lo que se escribió)", () => {
    expect(opcionesDeTipo(lugares, "zzz")).toEqual([]);
  });

  it("sin lugares ofrece solo los tres de siempre", () => {
    expect(opcionesDeTipo([], "").map((o) => o.valor)).toEqual([
      "mina",
      "ciudad",
      "abastecimiento",
    ]);
  });
});
