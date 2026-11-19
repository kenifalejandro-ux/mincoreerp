/** tests/unidad-escrita-cliente.test.ts
 *
 * La lógica pura de la unidad que se ESCRIBE en un vale
 * (client/src/components/combustible/unidadEscrita.ts). Vive acá porque client/ no tiene runner
 * propio; mismo criterio que tests/eventos-urea-cliente.test.ts.
 *
 * Lo que defiende:
 *   1. Una placa que coincide con una unidad registrada (sin importar mayúsculas, espacios ni
 *      guiones) es ESA unidad.
 *   2. Una placa que no coincide queda escrita, tal como se tipeó (sin Flota la lista viene vacía
 *      y todo cae acá).
 *   3. Menos de 3 caracteres útiles no es una placa: el vale no se puede mandar todavía.
 *   4. Los campos del body: unidad registrada → equipo_id; escrita → unidad_sin_alta + la placa.
 */
import { describe, it, expect } from "vitest";
import {
  camposDeUnidad,
  normalizarPlaca,
  resolverUnidad,
} from "../client/src/components/combustible/unidadEscrita";

const flota = [
  { id: 7, placa_codigo: "T8M-821", tipo: "VOLQUETE" },
  { id: 9, placa_codigo: "ABC123", tipo: "CAMIONETA" },
];

describe("unidad escrita en un vale (cliente)", () => {
  it("normaliza la placa: mayúsculas, sin espacios ni guiones", () => {
    expect(normalizarPlaca(" t8m 821 ")).toBe("T8M821");
    expect(normalizarPlaca("t8m-821")).toBe("T8M821");
  });

  it("una placa que coincide con una unidad registrada es esa unidad", () => {
    const u = resolverUnidad("t8m 821", flota);
    expect(u).toEqual({ tipo: "registrada", equipo: flota[0] });
    expect(camposDeUnidad(u)).toEqual({ tipo_destino: "equipo", equipo_id: 7 });
  });

  it("una placa que no está en la lista queda escrita, tal como se tipeó", () => {
    const u = resolverUnidad(" zz 9999 ", flota);
    expect(u).toEqual({ tipo: "escrita", placa: "zz 9999" });
    expect(camposDeUnidad(u)).toEqual({
      tipo_destino: "unidad_sin_alta",
      placa_sin_alta: "zz 9999",
    });
  });

  it("sin Flota la lista viene vacía y toda placa válida queda escrita", () => {
    expect(resolverUnidad("T8M-821", [])).toEqual({ tipo: "escrita", placa: "T8M-821" });
  });

  it("menos de 3 caracteres útiles no es una placa todavía", () => {
    expect(resolverUnidad("", flota)).toEqual({ tipo: "vacia" });
    expect(resolverUnidad("  - ", flota)).toEqual({ tipo: "vacia" });
    expect(resolverUnidad("ab", flota)).toEqual({ tipo: "vacia" });
    expect(camposDeUnidad(resolverUnidad("ab", flota))).toBeNull();
  });
});
