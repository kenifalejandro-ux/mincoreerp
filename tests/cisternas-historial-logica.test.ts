/** tests/cisternas-historial-logica.test.ts
 *
 * La lógica pura del Historial de cisternas: qué proveedores se pueden filtrar, cómo se filtra y
 * cuánto duró una cisterna que ya se vació. Aparte de la pantalla, como el nivel de la tanqueta.
 */
import { describe, it, expect } from "vitest";
import type { CisternaDeLista } from "../client/src/components/combustible/cisternasTipos";
import {
  diasQueDuro,
  fechaDeLaUltimaSalida,
  filtrarHistorial,
  proveedoresDe,
  SIN_PROVEEDOR,
} from "../client/src/components/combustible/historialCisternas";

let n = 0;
const cisterna = (extra: Partial<CisternaDeLista> = {}): CisternaDeLista => ({
  id: String(++n),
  cantidad: "500",
  saldo: "0",
  recepcion_id: String(100 + n),
  recibido_en: "2026-11-01T12:00:00Z",
  costo_unitario: "16.5",
  tanque_codigo: "TQ-01",
  tipo_combustible: "diesel_b5",
  unidad: "gal",
  grifo_interno_id: 1,
  proveedor: "ULLOA",
  estado: "vaciada",
  proveedor_id: 7,
  salidas: [],
  ...extra,
});
const salida = (fecha: string, id = String(++n)) => ({
  id,
  tipo: "unidad" as const,
  cantidad: "100",
  fecha,
  destino: "ABC-123",
});

describe("proveedores del filtro", () => {
  it("salen de lo que hay en la lista, sin repetir y por nombre", () => {
    const lista = [
      cisterna({ proveedor: "ULLOA", proveedor_id: 7 }),
      cisterna({ proveedor: "ÁLAMO", proveedor_id: 3 }),
      cisterna({ proveedor: "ULLOA", proveedor_id: 7 }),
      cisterna({ proveedor: "BETA", proveedor_id: 9 }),
    ];
    expect(proveedoresDe(lista)).toEqual([
      { valor: "3", nombre: "ÁLAMO" },
      { valor: "9", nombre: "BETA" },
      { valor: "7", nombre: "ULLOA" },
    ]);
  });

  it("una cisterna sin proveedor es 'Sin proveedor' y no revienta", () => {
    expect(proveedoresDe([cisterna({ proveedor: null, proveedor_id: null })])).toEqual([
      { valor: SIN_PROVEEDOR, nombre: "Sin proveedor" },
    ]);
    expect(proveedoresDe([])).toEqual([]);
  });
});

describe("filtrar el historial", () => {
  const ulloa = cisterna({ proveedor_id: 7, estado: "vaciada" });
  const ulloaAnulada = cisterna({ proveedor_id: 7, estado: "anulada" });
  const alamo = cisterna({ proveedor: "ÁLAMO", proveedor_id: 3, estado: "vaciada" });
  const sin = cisterna({ proveedor: null, proveedor_id: null, estado: "anulada" });
  const todas = [ulloa, ulloaAnulada, alamo, sin];

  it("sin filtro devuelve todo, en el mismo orden", () => {
    expect(filtrarHistorial(todas, "", "todas")).toEqual(todas);
  });

  it("por proveedor y por estado, por separado y juntos", () => {
    expect(filtrarHistorial(todas, "7", "todas")).toEqual([ulloa, ulloaAnulada]);
    expect(filtrarHistorial(todas, "", "anulada")).toEqual([ulloaAnulada, sin]);
    expect(filtrarHistorial(todas, "7", "anulada")).toEqual([ulloaAnulada]);
    expect(filtrarHistorial(todas, "3", "anulada")).toEqual([]);
  });

  it("las sin proveedor se filtran con su propio valor", () => {
    expect(filtrarHistorial(todas, SIN_PROVEEDOR, "todas")).toEqual([sin]);
  });

  it("un proveedor que no existe no trae nada", () => {
    expect(filtrarHistorial(todas, "999", "todas")).toEqual([]);
  });
});

describe("cuánto duró una cisterna", () => {
  it("la última salida es la más reciente, sin importar el orden de la lista", () => {
    const c = cisterna({
      salidas: [
        salida("2026-11-05T10:00:00Z"),
        salida("2026-11-09T10:00:00Z"),
        salida("2026-11-03T10:00:00Z"),
      ],
    });
    expect(fechaDeLaUltimaSalida(c)).toBe("2026-11-09T10:00:00Z");
  });

  it("sin salidas, o con fechas ilegibles, no hay última salida ni duración", () => {
    expect(fechaDeLaUltimaSalida(cisterna({ salidas: [] }))).toBeNull();
    expect(diasQueDuro(cisterna({ salidas: [] }))).toBeNull();
    const rota = cisterna({ salidas: [salida("no es una fecha")] });
    expect(fechaDeLaUltimaSalida(rota)).toBeNull();
    expect(diasQueDuro(rota)).toBeNull();
    // Una salida buena y una rota: vale la buena.
    const mixta = cisterna({ salidas: [salida("basura"), salida("2026-11-04T12:00:00Z")] });
    expect(fechaDeLaUltimaSalida(mixta)).toBe("2026-11-04T12:00:00Z");
  });

  it("cuenta días enteros desde que llegó hasta la última salida", () => {
    expect(diasQueDuro(cisterna({ salidas: [salida("2026-11-01T18:00:00Z")] }))).toBe(0);
    expect(diasQueDuro(cisterna({ salidas: [salida("2026-11-04T12:00:00Z")] }))).toBe(3);
    expect(diasQueDuro(cisterna({ salidas: [salida("2026-11-04T11:00:00Z")] }))).toBe(2);
  });

  it("una salida anterior a la llegada (fechas cargadas a mano) da 0, no un negativo", () => {
    expect(diasQueDuro(cisterna({ salidas: [salida("2026-10-25T12:00:00Z")] }))).toBe(0);
  });

  it("una fecha de llegada ilegible no da NaN", () => {
    const c = cisterna({ recibido_en: "ayer", salidas: [salida("2026-11-04T12:00:00Z")] });
    expect(diasQueDuro(c)).toBeNull();
  });
});
