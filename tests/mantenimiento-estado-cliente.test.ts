/** tests/mantenimiento-estado-cliente.test.ts
 *
 * M5 en pantalla: los filtros por estado y las detenidas primero.
 */
import { describe, it, expect } from "vitest";

import {
  FILTROS_VACIOS,
  contarPorEstado,
  filtrarEquipos,
} from "../client/src/components/mantenimiento/equiposMantenimiento";
import type { EquipoMantenimiento } from "../client/src/components/mantenimiento/mantenimientoApi";

const equipo = (placa: string, extra: Partial<EquipoMantenimiento> = {}): EquipoMantenimiento => ({
  id: placa.length,
  placa_codigo: placa,
  tipo: "Volquete",
  marca: null,
  modelo: null,
  medidor: "horometro",
  lectura: 0,
  propiedad: "propia",
  area_id: null,
  area: null,
  por_completar: false,
  ...extra,
});

describe("Mantenimiento: estado de las unidades en pantalla", () => {
  const lista = [
    equipo("A", { estado: "operativa" }),
    equipo("B", { estado: "en_mantenimiento", propiedad: "alquilada" }),
    equipo("C", { estado: "detenida" }),
    equipo("D"),
    equipo("E", { estado: "detenida" }),
  ];
  const placas = (estado: Parameters<typeof contarPorEstado>[1]) =>
    filtrarEquipos(lista, { ...FILTROS_VACIOS, estado }).map((e) => e.placa_codigo);

  it("las detenidas van primero y dentro de cada estado se mantiene el orden", () => {
    expect(placas("todas")).toEqual(["C", "E", "B", "A", "D"]);
    // No reordena la lista original.
    expect(lista[0].placa_codigo).toBe("A");
  });

  it("filtra y cuenta por estado y por alquiladas; sin dato es operativa", () => {
    expect(placas("detenida")).toEqual(["C", "E"]);
    expect(placas("en_mantenimiento")).toEqual(["B"]);
    expect(placas("operativa")).toEqual(["A", "D"]);
    expect(placas("alquiladas")).toEqual(["B"]);
    expect(contarPorEstado(lista, "todas")).toBe(5);
    expect(contarPorEstado(lista, "detenida")).toBe(2);
  });
});
