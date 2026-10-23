/** tests/viajes-tramos.test.ts
 *
 * El reparto de lo cargado entre los tramos de un viaje (src/modules/combustible/viajesTramos.ts).
 * Es una cuenta sobre horas, sin base de datos: una carga cuenta para el tramo que termina
 * después de ella.
 */
import { describe, it, expect } from "vitest";
import { repartirPorTramo, type ParadaDeTramo } from "../src/modules/combustible/viajesTramos";
import { LITROS_POR_GALON } from "../src/server/shared/utils/unidades";

const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 20, 6, 0, 0);
const t = (h: number) => new Date(T0 + h * H).toISOString();
const gal = (g: number) => g * LITROS_POR_GALON;

/** A → B → A: sale a las 0 h, llega a B a las 4 h, sale de B a las 6 h, llega a A a las 10 h. */
const circuito: ParadaDeTramo[] = [
  {
    orden: 0,
    lugar: "A",
    llegada_en: null,
    llegada_medidor: null,
    salida_en: t(0),
    salida_medidor: 100,
  },
  {
    orden: 1,
    lugar: "B",
    llegada_en: t(4),
    llegada_medidor: 150,
    salida_en: t(6),
    salida_medidor: 155,
  },
  {
    orden: 2,
    lugar: "A",
    llegada_en: t(10),
    llegada_medidor: 260,
    salida_en: null,
    salida_medidor: null,
  },
];
const carga = (h: number, litros: number, producto: "combustible" | "urea" = "combustible") => ({
  despachado_en: t(h),
  producto,
  litros,
});

describe("repartirPorTramo", () => {
  it("un viaje A → B → A tiene dos tramos con su recorrido: el medidor de llegada menos el de salida", () => {
    const tramos = repartirPorTramo(circuito, []);
    expect(tramos.map((x) => `${x.de}→${x.a}`)).toEqual(["A→B", "B→A"]);
    expect(tramos.map((x) => x.recorrido)).toEqual([50, 105]);
  });

  it("la carga de antes de salir y las del camino van al tramo que termina después de ellas", () => {
    const tramos = repartirPorTramo(circuito, [
      carga(-1, gal(10)),
      carga(2, gal(5)),
      carga(8, gal(20)),
    ]);
    expect(tramos[0].combustible_gal).toBeCloseTo(15, 5);
    expect(tramos[1].combustible_gal).toBeCloseTo(20, 5);
  });

  it("la carga hecha en la parada (entre la llegada y la salida) va al tramo que sigue", () => {
    const tramos = repartirPorTramo(circuito, [carga(5, gal(30))]);
    expect(tramos[0].combustible_gal).toBe(0);
    expect(tramos[1].combustible_gal).toBeCloseTo(30, 5);
  });

  it("la carga justo a la hora de la llegada cuenta para el tramo que llega", () => {
    const tramos = repartirPorTramo(circuito, [carga(4, gal(7))]);
    expect(tramos[0].combustible_gal).toBeCloseTo(7, 5);
  });

  it("la urea va aparte, en litros", () => {
    const tramos = repartirPorTramo(circuito, [carga(2, 12, "urea"), carga(2, gal(4))]);
    expect(tramos[0].urea_l).toBe(12);
    expect(tramos[0].combustible_gal).toBeCloseTo(4, 5);
  });

  it("un tramo sin terminar se queda con lo que falta repartir, y sin medidor no hay recorrido", () => {
    const enCurso: ParadaDeTramo[] = [
      { ...circuito[0] },
      { ...circuito[1], salida_en: null, salida_medidor: null },
      { ...circuito[2], llegada_en: null, llegada_medidor: null },
    ];
    const tramos = repartirPorTramo(enCurso, [carga(9, gal(3))]);
    expect(tramos[1].llegada_en).toBeNull();
    expect(tramos[1].recorrido).toBeNull();
    expect(tramos[0].combustible_gal).toBe(0);
    expect(tramos[1].combustible_gal).toBeCloseTo(3, 5);
  });
});
