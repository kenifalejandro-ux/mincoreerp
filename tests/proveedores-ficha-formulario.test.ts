/** tests/proveedores-ficha-formulario.test.ts
 *
 * La ficha del proveedor (PR3a), lógica de los formularios sin React: valores iniciales, lo que falta antes
 * de enviar, el cuerpo que se envía y cómo se dicen las condiciones de pago.
 */
import { describe, it, expect } from "vitest";

import {
  cuerpoDeDatos,
  cuerpoDelContacto,
  formularioDeContacto,
  formularioDeDatos,
  problemasDeDatos,
  problemasDelContacto,
  textoDeFormaDePago,
  textoDeMoneda,
  type FormularioDeContacto,
  type FormularioDeDatos,
} from "../client/src/components/proveedores/fichaFormulario";
import type { DatosFicha } from "../client/src/components/proveedores/proveedoresApi";

const vacios: DatosFicha = {
  direccion: null,
  telefono: null,
  correo: null,
  formaPago: null,
  plazoPagoDias: null,
  moneda: null,
};
const datos = (extra: Partial<FormularioDeDatos> = {}): FormularioDeDatos => ({
  ...formularioDeDatos(vacios),
  ...extra,
});
const contacto = (extra: Partial<FormularioDeContacto> = {}): FormularioDeContacto => ({
  ...formularioDeContacto(),
  nombre: "Rosa Quispe",
  telefono: "987654321",
  ...extra,
});

describe("datos y condiciones de pago", () => {
  it("una ficha vacía arranca con todo en blanco y sin problemas", () => {
    const f = datos();
    expect(f).toEqual({
      direccion: "",
      telefono: "",
      correo: "",
      forma_pago: "",
      plazo_pago_dias: "",
      moneda: "",
    });
    expect(problemasDeDatos(f)).toEqual([]);
    expect(cuerpoDeDatos(f)).toEqual({
      direccion: null,
      telefono: null,
      correo: null,
      forma_pago: null,
      plazo_pago_dias: null,
      moneda: null,
    });
  });

  it("parte de lo guardado y lo devuelve igual", () => {
    const guardado: DatosFicha = {
      direccion: "Av. Los Pinos 123",
      telefono: "064-123456",
      correo: "a@b.pe",
      formaPago: "credito",
      plazoPagoDias: 30,
      moneda: "PEN",
    };
    const f = formularioDeDatos(guardado);
    expect(f.plazo_pago_dias).toBe("30");
    expect(cuerpoDeDatos(f)).toEqual({
      direccion: "Av. Los Pinos 123",
      telefono: "064-123456",
      correo: "a@b.pe",
      forma_pago: "credito",
      plazo_pago_dias: 30,
      moneda: "PEN",
    });
  });

  it("el crédito exige un plazo de 1 a 365 días; contado y sin definir descartan el plazo", () => {
    const mensaje = "El crédito necesita su plazo: de 1 a 365 días.";
    for (const plazo of ["", "0", "366", "2.5", "abc"]) {
      expect(problemasDeDatos(datos({ forma_pago: "credito", plazo_pago_dias: plazo }))).toEqual([
        mensaje,
      ]);
    }
    expect(problemasDeDatos(datos({ forma_pago: "credito", plazo_pago_dias: "365" }))).toEqual([]);
    expect(
      cuerpoDeDatos(datos({ forma_pago: "contado", plazo_pago_dias: "15" })).plazo_pago_dias
    ).toBeNull();
    expect(cuerpoDeDatos(datos({ plazo_pago_dias: "15" })).plazo_pago_dias).toBeNull();
  });

  it("valida teléfono y correo solo si se escribieron, y recorta los espacios", () => {
    expect(problemasDeDatos(datos({ telefono: "abc", correo: "sin-arroba" }))).toEqual([
      "El teléfono no es válido.",
      "El correo no es válido.",
    ]);
    expect(problemasDeDatos(datos({ telefono: "  (064) 22-1234 ", correo: " a@b.pe " }))).toEqual(
      []
    );
    expect(cuerpoDeDatos(datos({ direccion: "  Jr. Lima 1  " })).direccion).toBe("Jr. Lima 1");
    expect(problemasDeDatos(datos({ direccion: "x".repeat(251) }))).toEqual([
      "La dirección no puede pasar de 250 letras.",
    ]);
  });

  it("dice la forma de pago y la moneda con palabras", () => {
    expect(textoDeFormaDePago({ formaPago: null, plazoPagoDias: null })).toBe("Sin definir");
    expect(textoDeFormaDePago({ formaPago: "contado", plazoPagoDias: null })).toBe("Contado");
    expect(textoDeFormaDePago({ formaPago: "credito", plazoPagoDias: 30 })).toBe(
      "Crédito a 30 días"
    );
    expect(textoDeFormaDePago({ formaPago: "credito", plazoPagoDias: 1 })).toBe("Crédito a 1 día");
    expect(textoDeMoneda("PEN")).toBe("Soles (S/)");
    expect(textoDeMoneda("USD")).toBe("Dólares (US$)");
    expect(textoDeMoneda(null)).toBe("Sin definir");
  });
});

describe("contacto", () => {
  it("pide nombre y al menos un teléfono o un correo", () => {
    expect(problemasDelContacto(formularioDeContacto())).toEqual([
      "Escribe el nombre del contacto.",
      "Escribe un teléfono o un correo.",
    ]);
    expect(problemasDelContacto(contacto())).toEqual([]);
    expect(problemasDelContacto(contacto({ telefono: "", correo: "r@g.pe" }))).toEqual([]);
    expect(problemasDelContacto(contacto({ nombre: "   " }))).toEqual([
      "Escribe el nombre del contacto.",
    ]);
  });

  it("valida el formato de teléfono y correo", () => {
    expect(problemasDelContacto(contacto({ telefono: "abc", correo: "x" }))).toEqual([
      "El teléfono no es válido.",
      "El correo no es válido.",
    ]);
  });

  it("el cuerpo recorta, deja en null lo vacío y lleva el cliente_uuid solo al agregar", () => {
    const f = contacto({ nombre: "  Rosa  ", cargo: " ", correo: " r@g.pe ", principal: true });
    expect(cuerpoDelContacto(f)).toEqual({
      nombre: "Rosa",
      cargo: null,
      telefono: "987654321",
      correo: "r@g.pe",
      principal: true,
    });
    expect(cuerpoDelContacto(f, "11111111-1111-4111-8111-111111111111")).toMatchObject({
      cliente_uuid: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("al editar parte de lo guardado", () => {
    const f = formularioDeContacto({
      id: 3,
      nombre: "Juan",
      cargo: "Ventas",
      telefono: null,
      correo: "j@g.pe",
      principal: true,
    });
    expect(f).toEqual({
      nombre: "Juan",
      cargo: "Ventas",
      telefono: "",
      correo: "j@g.pe",
      principal: true,
    });
  });
});
