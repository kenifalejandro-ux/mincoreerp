/** tests/proveedores-directorio-cliente.test.ts
 *
 * Directorio de proveedores como la maqueta (lógica del cliente, sin React): qué abastece cada uno, el
 * buscador (razón social, código, RUC y ciudad, sin tildes), los filtros y las cuatro mini-tarjetas.
 */
import { describe, it, expect } from "vitest";

import {
  abasteceA,
  dineroDelDirectorio,
  fichaIncompleta,
  filtrarDirectorio,
  resumenDelDirectorio,
  type FiltrosDelDirectorio,
} from "../client/src/components/proveedores/directorioProveedores";
import type { ProveedorEnDirectorio } from "../client/src/components/proveedores/proveedoresApi";

const prov = (id: number, extra: Partial<ProveedorEnDirectorio> = {}): ProveedorEnDirectorio => ({
  id,
  codigo: `PRV-00${id}`,
  nombre: `PROVEEDOR ${id}`,
  ruc: null,
  activo: true,
  tipos: ["Combustible"],
  combustible: { interno: true, externo: false },
  urea: { interno: false, externo: false },
  ciudad: null,
  fichaCompleta: { porcentaje: 0, faltan: [] },
  ...extra,
});

const sinFiltros: FiltrosDelDirectorio = {
  busqueda: "",
  tipo: "todos",
  abastece: "todos",
  estado: "todos",
};

const lista = [
  prov(1, { nombre: "GRIFO SANTA ROSA", ruc: "20123456789", ciudad: "Huancayo" }),
  prov(2, {
    nombre: "UREA ANDINA",
    tipos: ["Urea"],
    combustible: { interno: false, externo: false },
    urea: { interno: false, externo: true },
    ciudad: "Junín",
  }),
  prov(3, {
    nombre: "MIXTO SAC",
    activo: false,
    tipos: ["Combustible", "Urea"],
    combustible: { interno: false, externo: true },
    urea: { interno: true, externo: false },
  }),
];

describe("abasteceA", () => {
  it("junta combustible y urea", () => {
    expect(abasteceA(lista[0])).toEqual({ interno: true, externo: false });
    expect(abasteceA(lista[1])).toEqual({ interno: false, externo: true });
    expect(abasteceA(lista[2])).toEqual({ interno: true, externo: true });
    expect(abasteceA(prov(9, { combustible: { interno: false, externo: false } }))).toEqual({
      interno: false,
      externo: false,
    });
  });
});

describe("filtrarDirectorio", () => {
  const ids = (f: Partial<FiltrosDelDirectorio>) =>
    filtrarDirectorio(lista, { ...sinFiltros, ...f }).map((p) => p.id);

  it("sin filtros deja todos", () => {
    expect(ids({})).toEqual([1, 2, 3]);
  });

  it("busca por razón social, código, RUC y ciudad, sin tildes ni mayúsculas", () => {
    expect(ids({ busqueda: "santa rosa" })).toEqual([1]);
    expect(ids({ busqueda: "prv-002" })).toEqual([2]);
    expect(ids({ busqueda: "2012345" })).toEqual([1]);
    expect(ids({ busqueda: "huancayo" })).toEqual([1]);
    expect(ids({ busqueda: "JUNIN" })).toEqual([2]);
    expect(ids({ busqueda: "  nada que ver " })).toEqual([]);
  });

  it("filtra por tipo, abastece a y estado", () => {
    expect(ids({ tipo: "Urea" })).toEqual([2, 3]);
    expect(ids({ abastece: "interno" })).toEqual([1, 3]);
    expect(ids({ abastece: "externo" })).toEqual([2, 3]);
    expect(ids({ estado: "activos" })).toEqual([1, 2]);
    expect(ids({ estado: "inactivos" })).toEqual([3]);
    expect(ids({ tipo: "Urea", abastece: "interno", estado: "inactivos" })).toEqual([3]);
  });
});

describe("resumenDelDirectorio", () => {
  it("cuenta total, activos, combustible y urea", () => {
    expect(resumenDelDirectorio(lista)).toEqual({ total: 3, activos: 2, combustible: 2, urea: 2 });
    expect(resumenDelDirectorio([])).toEqual({ total: 0, activos: 0, combustible: 0, urea: 0 });
  });
});

describe("ficha incompleta y dinero", () => {
  it("por debajo de 80 % se marca incompleta", () => {
    expect(fichaIncompleta(79)).toBe(true);
    expect(fichaIncompleta(80)).toBe(false);
    expect(fichaIncompleta(100)).toBe(false);
  });
  it("el precio sale con dos decimales", () => {
    expect(dineroDelDirectorio(15.8)).toBe("S/ 15.80");
    expect(dineroDelDirectorio(8)).toBe("S/ 8.00");
  });
});
