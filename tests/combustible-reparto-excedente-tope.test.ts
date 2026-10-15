/** Tope de renglones del reparto del excedente de una recepción: un cliente
 *  con más de 10 tanquetas recibía "Array must contain at most 10 element(s)". */
import { describe, it, expect } from "vitest";
import { crearRecepcionCombustibleSchema } from "../src/server/schemas/combustible.schema";

const renglones = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    destino: "cubeta",
    cantidad: 10,
    tanqueta_id: i + 1,
  }));

const excedeTope = (n: number) => {
  const r = crearRecepcionCombustibleSchema.safeParse({ reparto_excedente: renglones(n) });
  return (
    !r.success &&
    r.error.issues.some((i) => i.path[0] === "reparto_excedente" && i.code === "too_big")
  );
};

describe("combustible: tope del reparto del excedente", () => {
  it("acepta 11 y 50 renglones", () => {
    expect(excedeTope(11)).toBe(false);
    expect(excedeTope(50)).toBe(false);
  });
  it("rechaza 51 renglones", () => {
    expect(excedeTope(51)).toBe(true);
  });
});
