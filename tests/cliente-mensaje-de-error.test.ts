/** El aviso del cliente muestra el motivo real del servidor, venga en la
 *  forma que venga: antes muchos solo leían `error` y el AppError (que manda
 *  `message`) quedaba escondido detrás del texto por defecto. */
import { describe, it, expect } from "vitest";
import { mensajeDeError } from "../client/src/utils/mensajeDeError";

describe("cliente: mensajeDeError", () => {
  it("lee el message del manejador de errores (AppError)", () => {
    expect(mensajeDeError({ ok: false, message: "Ya existe" }, "x")).toBe("Ya existe");
  });
  it("lee el error que algunos controladores mandan a mano", () => {
    expect(mensajeDeError({ error: "El grifo no existe" }, "x")).toBe("El grifo no existe");
  });
  it("prefiere el detalle de la validación de esquema", () => {
    expect(mensajeDeError({ errors: [{ field: "a", message: "detalle" }] }, "x")).toBe("detalle");
  });
  it("cae al texto por defecto si no hay motivo útil", () => {
    expect(mensajeDeError({}, "defecto")).toBe("defecto");
    expect(mensajeDeError(null, "defecto")).toBe("defecto");
    expect(mensajeDeError({ message: "  ", error: 42 }, "defecto")).toBe("defecto");
  });
});
