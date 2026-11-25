/** tests/checklists-registro-cliente.test.ts
 *
 * E5-2 en pantalla: la lectura escrita a mano, el resultado y los avisos al registrar.
 */
import { describe, it, expect } from "vitest";

import {
  avisoDelRegistro,
  avisoSinSenal,
  leerLectura,
  resultadoDe,
} from "../client/src/components/checklists/registro";

describe("Checklists: registro en pantalla", () => {
  it("lee la lectura con coma o punto y deja vacía la que no se anotó", () => {
    expect(leerLectura("  ")).toEqual({});
    expect(leerLectura("125000")).toEqual({ valor: 125000 });
    expect(leerLectura("1520,5")).toEqual({ valor: 1520.5 });
    expect(leerLectura("1520.55")).toEqual({ valor: 1520.55 });
  });

  it("rechaza el separador de miles y lo que no es una lectura", () => {
    for (const texto of ["125.000", "125,000", "1.250,5", "-4", "12 000", "abc", "10000000"]) {
      expect(leerLectura(texto).problema, texto).toBeTruthy();
    }
  });

  it("distingue no apta de observado", () => {
    expect(resultadoDe("bien").texto).toBe("Bien");
    expect(resultadoDe("observado").texto).toBe("Observado");
    expect(resultadoDe("no_apta").texto).toBe("No apta");
  });

  it("avisa la falla crítica, la orden y lo que no se pudo registrar", () => {
    expect(avisoDelRegistro({ resultado: "bien" })).toBeNull();
    expect(avisoDelRegistro({ resultado: "observado" })).toBeNull();
    expect(avisoDelRegistro({ resultado: "no_apta", orden_trabajo_id: 12 })).toContain("#12");
    expect(avisoDelRegistro({ resultado: "no_apta" })).not.toContain("orden");
    expect(avisoDelRegistro({ resultado: "bien", aviso_registro: "No se registró." })).toContain(
      "No se registró."
    );
    expect(avisoSinSenal(false)).not.toContain("NO APTA");
    expect(avisoSinSenal(true)).toContain("NO APTA");
  });
});
