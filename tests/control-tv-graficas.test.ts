/** tests/control-tv-graficas.test.ts
 *
 * Las cuentas de los gráficos de la vista de una unidad en el Control TV: galones por origen y su
 * acumulado, el eje «redondo», las barras de desvío y que ninguna cifra absurda llegue a la pantalla.
 * Sin pantalla.
 */
import { describe, it, expect } from "vitest";
import {
  acumuladoPorOrigen,
  alturaPct,
  barraDivergente,
  escalaY,
  origenDe,
  textoDesvio,
  type CargaGrafica,
} from "../client/src/components/controlTv/graficasUnidadLogica";

const H = 3_600_000;
const carga = (p: Partial<CargaGrafica> & { horas: number }): CargaGrafica => ({
  producto: "combustible",
  origen: "tanque",
  cantidad: 10,
  unidad: "gal",
  despachado_en: new Date(Date.UTC(2026, 10, 11) + p.horas * H).toISOString(),
  ...p,
});

describe("control TV: acumulado de combustible por origen", () => {
  it("clasifica el origen: tanqueta, compra en ruta y todo lo demás es el grifo", () => {
    expect(origenDe("tanqueta")).toBe("tanqueta");
    expect(origenDe("compra_externa")).toBe("ruta");
    expect(origenDe("tanque")).toBe("grifo");
    expect(origenDe("lo_que_sea")).toBe("grifo");
  });

  it("suma por origen en el orden en que cada uno empezó y acumula", () => {
    const r = acumuladoPorOrigen([
      carga({ horas: 5, origen: "compra_externa", cantidad: 5 }),
      carga({ horas: 1, origen: "tanque", cantidad: 12 }),
      carga({ horas: 3, origen: "tanqueta", cantidad: 10 }),
      carga({ horas: 2, origen: "tanque", cantidad: 6 }), // otra del grifo: se suma al grifo
    ]);
    expect(r.map((x) => x.k)).toEqual(["grifo", "tanqueta", "ruta"]);
    expect(r.map((x) => x.gal)).toEqual([18, 10, 5]);
    expect(r.map((x) => x.acumulado)).toEqual([18, 28, 33]);
  });

  it("convierte los litros a galones y deja fuera la urea y lo que no es número", () => {
    const r = acumuladoPorOrigen([
      carga({ horas: 1, cantidad: 3.785411784, unidad: "L" }),
      carga({ horas: 2, producto: "urea", cantidad: 50, unidad: "L" }),
      carga({ horas: 3, origen: "tanqueta", cantidad: "abc" }),
      carga({ horas: 4, origen: "compra_externa", cantidad: 0 }),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].k).toBe("grifo");
    expect(r[0].gal).toBeCloseTo(1, 6);
  });

  it("sin cargas no hay barras", () => {
    expect(acumuladoPorOrigen([])).toEqual([]);
  });
});

describe("control TV: ejes y barras", () => {
  it("el eje sube a un tope redondo y se parte en cuartos", () => {
    expect(escalaY(33)).toEqual({ tope: 40, marcas: [0, 10, 20, 30, 40] });
    expect(escalaY(19.5).tope).toBe(20);
    expect(escalaY(3.6).tope).toBe(4);
    expect(escalaY(100).tope).toBe(100);
    expect(escalaY(101).tope).toBe(200);
  });

  it("sin valores el eje no se rompe (0, negativo o no número)", () => {
    for (const m of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const e = escalaY(m);
      expect(e.tope).toBeGreaterThan(0);
      expect(e.marcas).toHaveLength(5);
    }
  });

  it("la altura de la barra queda entre 0 y 100 %", () => {
    expect(alturaPct(10, 40)).toBe(25);
    expect(alturaPct(80, 40)).toBe(100);
    expect(alturaPct(-3, 40)).toBe(0);
    expect(alturaPct(5, 0)).toBe(0);
  });

  it("el desvío sale del centro: a la derecha si sube y no se pasa de su mitad", () => {
    expect(barraDivergente(25)).toEqual({ derecha: true, ancho: 0.5 });
    expect(barraDivergente(-15)).toEqual({ derecha: false, ancho: 0.3 });
    expect(barraDivergente(5000).ancho).toBe(1);
    expect(barraDivergente(0).ancho).toBe(0);
  });

  it("el texto del desvío no muestra cifras absurdas", () => {
    expect(textoDesvio(22.4)).toBe("+22 %");
    expect(textoDesvio(-15)).toBe("−15 %");
    expect(textoDesvio(0)).toBe("0 %");
    expect(textoDesvio(15568)).toBe("> 999 %");
    expect(textoDesvio(-15568)).toBe("< −999 %");
  });
});
