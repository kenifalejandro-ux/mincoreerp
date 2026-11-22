/** tests/layout-orden-del-menu.test.ts
 *
 * El orden de los módulos en el menú del ERP: «Gestión de proveedores» va justo debajo de «Bandeja», que se
 * dibuja pegada al Dashboard (o primera si la persona no tiene Dashboard). El resto conserva su orden.
 */
import { describe, it, expect } from "vitest";

import { conProveedoresBajoBandeja } from "../client/src/components/layout/ordenDelMenu";

const m = (...ids: string[]) => ids.map((id) => ({ id }));
const ids = (lista: { id: string }[]) => lista.map((x) => x.id);

describe("conProveedoresBajoBandeja", () => {
  it("con Dashboard, proveedores queda justo después (donde va la Bandeja)", () => {
    expect(
      ids(
        conProveedoresBajoBandeja(
          m("dashboard", "repuestos", "combustible", "flota", "ordenes_trabajo", "proveedores")
        )
      )
    ).toEqual(["dashboard", "proveedores", "repuestos", "combustible", "flota", "ordenes_trabajo"]);
  });

  it("sin Dashboard, proveedores pasa a ser el primero (la Bandeja va antes de todos)", () => {
    expect(ids(conProveedoresBajoBandeja(m("repuestos", "combustible", "proveedores")))).toEqual([
      "proveedores",
      "repuestos",
      "combustible",
    ]);
  });

  it("sin proveedores, la lista queda igual", () => {
    const lista = m("dashboard", "repuestos", "combustible");
    expect(conProveedoresBajoBandeja(lista)).toBe(lista);
  });

  it("solo proveedores, o ya en su lugar, no cambia nada", () => {
    expect(ids(conProveedoresBajoBandeja(m("proveedores")))).toEqual(["proveedores"]);
    expect(ids(conProveedoresBajoBandeja(m("dashboard", "proveedores", "repuestos")))).toEqual([
      "dashboard",
      "proveedores",
      "repuestos",
    ]);
  });

  it("no modifica la lista original y conserva los objetos", () => {
    const lista = [
      { id: "dashboard", x: 1 },
      { id: "repuestos", x: 2 },
      { id: "proveedores", x: 3 },
    ];
    const antes = JSON.stringify(lista);
    const r = conProveedoresBajoBandeja(lista);
    expect(JSON.stringify(lista)).toBe(antes);
    expect(r[1]).toBe(lista[2]);
  });
});
