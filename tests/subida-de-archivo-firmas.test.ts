import { describe, expect, it } from "vitest";
import { contenidoCoincideConTipo } from "../src/server/shared/utils/subidaDeArchivo";

describe("contenidoCoincideConTipo", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

  it("acepta un contenido que coincide con su tipo", () => {
    expect(contenidoCoincideConTipo(jpeg, "image/jpeg")).toBe(true);
  });

  it("rechaza un contenido que no coincide", () => {
    expect(contenidoCoincideConTipo(Buffer.from("MZ"), "image/jpeg")).toBe(false);
  });

  it("rechaza un tipo no registrado", () => {
    expect(contenidoCoincideConTipo(jpeg, "image/gif")).toBe(false);
  });

  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])(
    "rechaza %s: no es una firma, es un miembro heredado del prototipo",
    (tipo) => {
      expect(contenidoCoincideConTipo(jpeg, tipo)).toBe(false);
    }
  );
});
