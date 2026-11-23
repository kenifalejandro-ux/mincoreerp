/** tests/proveedores-formulario-proveedor.test.ts
 *
 * «Registrar / Editar proveedor» como la maqueta (lógica del cliente, sin React): las dos listas («Qué suministra»
 * y «Abastece a») y las cuatro banderas del servidor, el formulario de un proveedor que ya existe (incluida la
 * mezcla que las listas no pueden decir), lo que falta antes de enviar y el cuerpo que se envía.
 */
import { describe, it, expect } from "vitest";

import {
  banderasDe,
  cuerpoDelProveedor,
  formularioInicial,
  hayBandera,
  problemasDelProveedor,
  seleccionDe,
  type Banderas,
  type Suministra,
  type UsoDeProveedor,
} from "../client/src/components/proveedores/formularioProveedor";

const ninguna: Banderas = {
  abastece_tanque: false,
  abastece_ruta: false,
  abastece_urea: false,
  abastece_urea_ruta: false,
};
const uso = (interno: boolean, externo: boolean) => ({ interno, externo });
const proveedor = (
  comb: { interno: boolean; externo: boolean },
  urea: { interno: boolean; externo: boolean },
  extra: Record<string, unknown> = {}
) => ({ nombre: "GRIFO", ruc: null, activo: true, combustible: comb, urea, ...extra });

describe("banderasDe y seleccionDe", () => {
  it("las nueve combinaciones de las dos listas se convierten y vuelven iguales", () => {
    for (const s of ["combustible", "urea", "ambos"] as Suministra[]) {
      for (const u of ["interno", "externo", "ambos"] as UsoDeProveedor[]) {
        const b = banderasDe(s, u);
        expect(hayBandera(b), `${s}/${u}`).toBe(true);
        expect(seleccionDe(b), `${s}/${u}`).toEqual({ suministra: s, uso: u });
      }
    }
  });

  it("combustible interno = solo tanque; urea externa = solo urea en ruta", () => {
    expect(banderasDe("combustible", "interno")).toEqual({ ...ninguna, abastece_tanque: true });
    expect(banderasDe("urea", "externo")).toEqual({ ...ninguna, abastece_urea_ruta: true });
    expect(banderasDe("ambos", "ambos")).toEqual({
      abastece_tanque: true,
      abastece_ruta: true,
      abastece_urea: true,
      abastece_urea_ruta: true,
    });
  });

  it("una mezcla que las listas no dicen, o sin nada, da null", () => {
    // combustible interno y urea externa
    expect(seleccionDe({ ...ninguna, abastece_tanque: true, abastece_urea_ruta: true })).toBeNull();
    // combustible interno y externo, urea solo interna
    expect(
      seleccionDe({ ...ninguna, abastece_tanque: true, abastece_ruta: true, abastece_urea: true })
    ).toBeNull();
    expect(seleccionDe(ninguna)).toBeNull();
    expect(hayBandera(ninguna)).toBe(false);
  });
});

describe("formularioInicial", () => {
  it("uno nuevo arranca en Combustible · Interno, como la maqueta", () => {
    expect(formularioInicial()).toEqual({
      nombre: "",
      ruc: "",
      ciudad: "",
      suministra: "combustible",
      uso: "interno",
      casillas: null,
    });
  });

  it("uno que existe parte de lo guardado y usa las listas cuando alcanzan", () => {
    const f = formularioInicial(
      proveedor(uso(false, true), uso(false, true), { ruc: "20123456789", ciudad: "Huancayo" })
    );
    expect(f).toMatchObject({
      nombre: "GRIFO",
      ruc: "20123456789",
      ciudad: "Huancayo",
      suministra: "ambos",
      uso: "externo",
      casillas: null,
    });
  });

  it("una mezcla que las listas no dicen se edita con las cuatro casillas, sin perder nada", () => {
    const f = formularioInicial(proveedor(uso(true, false), uso(false, true)));
    expect(f.casillas).toEqual({ ...ninguna, abastece_tanque: true, abastece_urea_ruta: true });
    // El estado ya no es parte del formulario: se cambia con «Desactivar» / «Reactivar».
    expect(f).not.toHaveProperty("activo");
    expect(cuerpoDelProveedor(f)).toMatchObject({
      abastece_tanque: true,
      abastece_ruta: false,
      abastece_urea: false,
      abastece_urea_ruta: true,
    });
  });
});

describe("problemasDelProveedor y cuerpoDelProveedor", () => {
  const f = (extra = {}) => ({ ...formularioInicial(), nombre: "GRIFO UNO", ...extra });

  it("un formulario bueno no tiene problemas; el RUC y la ciudad son opcionales", () => {
    expect(problemasDelProveedor(f())).toEqual([]);
    expect(problemasDelProveedor(f({ ruc: "20123456789", ciudad: "Arequipa" }))).toEqual([]);
  });

  it("pide el nombre, un RUC de 11 dígitos y una ciudad de hasta 80 letras", () => {
    expect(problemasDelProveedor(f({ nombre: "   " }))).toEqual([
      "Escribe el nombre del proveedor.",
    ]);
    expect(problemasDelProveedor(f({ ruc: "123" }))).toEqual(["El RUC debe tener 11 dígitos."]);
    expect(problemasDelProveedor(f({ ruc: "2051239874X" }))).toEqual([
      "El RUC debe tener 11 dígitos.",
    ]);
    expect(problemasDelProveedor(f({ ciudad: "x".repeat(81) }))).toEqual([
      "La ciudad no puede pasar de 80 letras.",
    ]);
    expect(problemasDelProveedor(f({ nombre: "x".repeat(151) }))).toEqual([
      "El nombre no puede pasar de 150 letras.",
    ]);
  });

  it("con las casillas, hay que elegir al menos una", () => {
    expect(problemasDelProveedor(f({ casillas: ninguna }))).toEqual([
      "Elige qué abastece el proveedor.",
    ]);
    expect(problemasDelProveedor(f({ casillas: { ...ninguna, abastece_urea: true } }))).toEqual([]);
  });

  it("el cuerpo recorta los textos y trae las banderas de las listas", () => {
    expect(
      cuerpoDelProveedor(
        f({
          nombre: "  GRIFO UNO ",
          ruc: " 20123456789 ",
          ciudad: " Cusco ",
          suministra: "urea",
          uso: "ambos",
        })
      )
    ).toEqual({
      nombre: "GRIFO UNO",
      ruc: "20123456789",
      ciudad: "Cusco",
      abastece_tanque: false,
      abastece_ruta: false,
      abastece_urea: true,
      abastece_urea_ruta: true,
    });
  });
});
