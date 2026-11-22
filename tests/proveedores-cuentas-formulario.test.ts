/** tests/proveedores-cuentas-formulario.test.ts
 *
 * Cuentas bancarias del proveedor (PR3b), lógica sin React: el formulario, lo que falta antes de enviar, el
 * cuerpo que se envía y quién ve la pestaña «Cuentas».
 */
import { describe, it, expect } from "vitest";

import {
  cuerpoDeLaCuenta,
  formularioDeCuenta,
  limpiarNumero,
  numeroEnGrupos,
  problemasDeLaCuenta,
  textoDeMonedaDeCuenta,
  textoDeTipoDeCuenta,
  type FormularioDeCuenta,
} from "../client/src/components/proveedores/cuentasFormulario";
import { puedeVerCuentasDeProveedores } from "../client/src/components/proveedores/proveedoresAcceso";
import type { CuentaBancaria } from "../client/src/components/proveedores/proveedoresApi";

const llena = (extra: Partial<FormularioDeCuenta> = {}): FormularioDeCuenta => ({
  ...formularioDeCuenta(),
  banco: "BCP",
  numero: "19412345678901234567",
  ...extra,
});

describe("formulario de la cuenta", () => {
  it("arranca vacío, en soles y corriente; al editar parte de lo guardado pero sin el número", () => {
    expect(formularioDeCuenta()).toEqual({
      banco: "",
      tipo_cuenta: "corriente",
      moneda: "PEN",
      titular: "",
      numero: "",
      principal: false,
    });
    const guardada: CuentaBancaria = {
      id: 4,
      banco: "BBVA",
      tipoCuenta: "ahorros",
      moneda: "USD",
      titular: "GRIFO SAC",
      numeroEnmascarado: "•••• 4567",
      principal: true,
    };
    expect(formularioDeCuenta(guardada)).toEqual({
      banco: "BBVA",
      tipo_cuenta: "ahorros",
      moneda: "USD",
      titular: "GRIFO SAC",
      numero: "",
      principal: true,
    });
  });

  it("limpia espacios y guiones del número y lo muestra en grupos de 4", () => {
    expect(limpiarNumero(" 194-1234 5678 ")).toBe("19412345678");
    expect(numeroEnGrupos("19412345678901234567")).toBe("1941 2345 6789 0123 4567");
    expect(numeroEnGrupos("123456789")).toBe("1234 5678 9");
  });

  it("al crear pide banco y número; al editar el número es opcional", () => {
    expect(problemasDeLaCuenta(formularioDeCuenta(), false)).toEqual([
      "Escribe el banco.",
      "Escribe el número de cuenta o CCI.",
    ]);
    expect(problemasDeLaCuenta(llena(), false)).toEqual([]);
    expect(problemasDeLaCuenta(llena({ numero: "" }), true)).toEqual([]);
    expect(problemasDeLaCuenta(llena({ banco: "  " }), true)).toEqual(["Escribe el banco."]);
  });

  it("el número debe tener de 8 a 20 dígitos", () => {
    const mensaje = "El número debe tener de 8 a 20 dígitos.";
    for (const malo of ["1234567", "123456789012345678901", "12345678abc", "ab"]) {
      expect(problemasDeLaCuenta(llena({ numero: malo }), false)).toEqual([mensaje]);
    }
    expect(problemasDeLaCuenta(llena({ numero: "194 1234-5678" }), false)).toEqual([]);
  });

  it("el cuerpo limpia el número, recorta y deja el titular vacío en null", () => {
    expect(
      cuerpoDeLaCuenta(llena({ banco: " BCP ", numero: "194-1234 5678", titular: " " }))
    ).toEqual({
      banco: "BCP",
      tipo_cuenta: "corriente",
      moneda: "PEN",
      titular: null,
      principal: false,
      numero: "19412345678",
    });
    expect(cuerpoDeLaCuenta(llena(), { clienteUuid: "u-1" })).toMatchObject({
      cliente_uuid: "u-1",
    });
  });

  it("al editar sin número NO manda el campo (el servidor conserva el guardado)", () => {
    expect(cuerpoDeLaCuenta(llena({ numero: "" }))).not.toHaveProperty("numero");
  });

  it("dice el tipo y la moneda con palabras", () => {
    expect(textoDeTipoDeCuenta("detraccion")).toBe("Detracciones (Banco de la Nación)");
    expect(textoDeTipoDeCuenta("ahorros")).toBe("Ahorros");
    expect(textoDeMonedaDeCuenta("PEN")).toBe("Soles (S/)");
    expect(textoDeMonedaDeCuenta("USD")).toBe("Dólares (US$)");
  });
});

describe("quién ve la pestaña «Cuentas»", () => {
  const usuario = (
    rol: string,
    permisos: Record<string, boolean> = {},
    modulos = ["proveedores"]
  ) => ({
    rol,
    modulosPermitidos: modulos,
    permisosPestanas: permisos,
  });

  it("el admin la ve siempre (con el módulo)", () => {
    expect(puedeVerCuentasDeProveedores(usuario("admin"))).toBe(true);
    expect(puedeVerCuentasDeProveedores(usuario("admin", {}, ["combustible"]))).toBe(false);
  });

  it("el resto solo si se la dieron a mano", () => {
    for (const rol of ["operador", "lectura", "grifero"]) {
      expect(puedeVerCuentasDeProveedores(usuario(rol))).toBe(false);
      expect(puedeVerCuentasDeProveedores(usuario(rol, { "proveedores:cuentas": true }))).toBe(
        true
      );
      expect(puedeVerCuentasDeProveedores(usuario(rol, { "proveedores:cuentas": false }))).toBe(
        false
      );
    }
  });

  it("sin usuario no la ve nadie", () => {
    expect(puedeVerCuentasDeProveedores(null)).toBe(false);
    expect(puedeVerCuentasDeProveedores(undefined)).toBe(false);
  });
});
