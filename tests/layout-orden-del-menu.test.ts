/** tests/layout-orden-del-menu.test.ts
 *
 * El orden de los módulos en el menú del ERP: los ecosistemas (hoy «Gestión de proveedores») van justo debajo de
 * «Bandeja», que se dibuja pegada al Dashboard (o primera si la persona no tiene Dashboard). El resto conserva su
 * orden.
 */
import { describe, it, expect } from "vitest";

import { conEcosistemasBajoBandeja } from "../client/src/components/layout/ordenDelMenu";

const m = (...ids: string[]) => ids.map((id) => ({ id }));
const ids = (lista: { id: string }[]) => lista.map((x) => x.id);
const ECO = ["proveedores"];

describe("conEcosistemasBajoBandeja", () => {
  it("con Dashboard, el ecosistema queda justo después (donde va la Bandeja)", () => {
    expect(
      ids(
        conEcosistemasBajoBandeja(
          m("dashboard", "repuestos", "combustible", "flota", "ordenes_trabajo", "proveedores"),
          ECO
        )
      )
    ).toEqual(["dashboard", "proveedores", "repuestos", "combustible", "flota", "ordenes_trabajo"]);
  });

  it("sin Dashboard, el ecosistema pasa a ser el primero (la Bandeja va antes de todos)", () => {
    expect(
      ids(conEcosistemasBajoBandeja(m("repuestos", "combustible", "proveedores"), ECO))
    ).toEqual(["proveedores", "repuestos", "combustible"]);
  });

  it("sin módulos de ecosistema, la lista queda igual", () => {
    const lista = m("dashboard", "repuestos", "combustible");
    expect(conEcosistemasBajoBandeja(lista, ECO)).toBe(lista);
    expect(conEcosistemasBajoBandeja(lista, [])).toBe(lista);
  });

  it("solo el ecosistema, o ya en su lugar, no cambia nada", () => {
    expect(ids(conEcosistemasBajoBandeja(m("proveedores"), ECO))).toEqual(["proveedores"]);
    expect(ids(conEcosistemasBajoBandeja(m("dashboard", "proveedores", "repuestos"), ECO))).toEqual(
      ["dashboard", "proveedores", "repuestos"]
    );
  });

  it("con varios ecosistemas van todos bajo la Bandeja, en el orden en que venían", () => {
    expect(
      ids(
        conEcosistemasBajoBandeja(
          m("dashboard", "repuestos", "mantenimiento", "combustible", "proveedores"),
          ["proveedores", "mantenimiento"]
        )
      )
    ).toEqual(["dashboard", "mantenimiento", "proveedores", "repuestos", "combustible"]);
  });

  it("no modifica la lista original y conserva los objetos", () => {
    const lista = [
      { id: "dashboard", x: 1 },
      { id: "repuestos", x: 2 },
      { id: "proveedores", x: 3 },
    ];
    const antes = JSON.stringify(lista);
    const r = conEcosistemasBajoBandeja(lista, ECO);
    expect(JSON.stringify(lista)).toBe(antes);
    expect(r[1]).toBe(lista[2]);
  });
});
