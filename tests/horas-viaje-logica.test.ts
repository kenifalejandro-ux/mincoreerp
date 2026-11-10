/** tests/horas-viaje-logica.test.ts
 *
 * Horas del viaje (ida, estadía, vuelta, total), descanso dentro de un tramo y «dónde está»
 * (la marca más nueva gana al punto de ubicación viejo). Lógica pura, sin pantalla.
 */
import { describe, it, expect } from "vitest";
import { descansoEnVentana, horasDelViaje } from "../client/src/components/combustible/horasViaje";
import type { ParadaMia } from "../client/src/components/combustible/paradasViaje";
import {
  ubicacionVigente,
  type UbicacionViaje,
} from "../client/src/components/combustible/ubicacionesLogica";

const H = 3_600_000;
const T0 = Date.parse("2026-11-05T12:00:00Z");
const iso = (h: number) => new Date(T0 + h * H).toISOString();

const parada = (
  orden: number,
  lugar_id: number,
  llegada: number | null,
  salida: number | null
): ParadaMia => ({
  orden,
  lugar_id,
  lugar: `L${lugar_id}`,
  llegada_en: llegada === null ? null : iso(llegada),
  llegada_medidor: null,
  salida_en: salida === null ? null : iso(salida),
  salida_medidor: null,
});

describe("horasDelViaje", () => {
  it("separa ida, estadía y vuelta en A → B → A", () => {
    const h = horasDelViaje(
      [parada(0, 1, null, 0), parada(1, 2, 14, 34), parada(2, 1, 48, null)],
      T0 + 100 * H
    )!;
    expect(h.idaYVuelta).toBe(true);
    expect(h.ida).toBe(14 * 60);
    expect(h.estadia).toBe(20 * 60);
    expect(h.vuelta).toBe(14 * 60);
    expect(h.total).toBe(48 * 60);
  });

  it("la estadía abierta corre hasta ahora", () => {
    const h = horasDelViaje(
      [parada(0, 1, null, 0), parada(1, 2, 14, null), parada(2, 1, null, null)],
      T0 + 20 * H
    )!;
    expect(h.ida).toBe(14 * 60);
    expect(h.estadia).toBe(6 * 60);
    expect(h.vuelta).toBeNull();
    expect(h.total).toBe(20 * 60);
  });

  it("estadía sin salida con la llegada siguiente ya marcada no sigue corriendo", () => {
    const h = horasDelViaje(
      [parada(0, 1, null, 0), parada(1, 2, 14, null), parada(2, 1, 30, null)],
      T0 + 500 * H
    )!;
    expect(h.estadia).toBe(0);
  });

  it("ruta que no vuelve al origen usa En ruta / En paradas", () => {
    const h = horasDelViaje(
      [parada(0, 1, null, 0), parada(1, 2, 5, 7), parada(2, 3, 12, null)],
      T0 + 50 * H
    )!;
    expect(h.idaYVuelta).toBe(false);
    expect(h.enRuta).toBe(10 * 60);
    expect(h.enParadas).toBe(2 * 60);
    expect(h.total).toBe(12 * 60);
  });

  it("sin salida del origen no hay horas", () => {
    expect(horasDelViaje([parada(0, 1, null, null), parada(1, 2, null, null)], T0)).toBeNull();
  });
});

describe("descansoEnVentana", () => {
  const d = (i: number, f: number | null, detiene?: boolean) => ({
    inicio_en: iso(i),
    fin_en: f === null ? null : iso(f),
    motivo: null,
    detiene,
  });

  it("cuenta solo lo de adentro del tramo", () => {
    expect(descansoEnVentana([d(-1, 2)], iso(0), iso(10), T0 + 99 * H)).toBe(120);
  });
  it("el abierto cuenta hasta ahora y el que no detiene no cuenta", () => {
    expect(descansoEnVentana([d(4, null)], iso(0), null, T0 + 6 * H)).toBe(120);
    expect(descansoEnVentana([d(1, 3, false)], iso(0), iso(10), T0)).toBe(0);
  });
});

describe("ubicacionVigente", () => {
  const punto = (h: number): UbicacionViaje => ({
    id: 1,
    lugar_id: null,
    texto: "Tupac Amarú",
    nota: null,
    registrado_en: iso(h),
    origen: "oficina",
  });
  const sale = [parada(0, 1, null, 0)];
  const enB = [parada(0, 1, null, 0), parada(1, 2, 14, null)];

  it("llegó a una parada: manda la llegada, aunque haya un punto más viejo o más nuevo", () => {
    expect(ubicacionVigente(enB, punto(5))).toEqual({
      texto: "En L2",
      en: iso(14),
      origen: "llegada",
    });
    expect(ubicacionVigente(enB, punto(20))?.texto).toBe("En L2");
  });
  it("en camino: el punto más nuevo que la salida, o «Salió de X»", () => {
    expect(ubicacionVigente(sale, punto(5))).toEqual({
      texto: "Tupac Amarú",
      en: iso(5),
      origen: "punto",
    });
    expect(ubicacionVigente(sale, null)?.texto).toBe("Salió de L1");
  });
  it("después de salir de una parada vuelven a contar los puntos nuevos, no los viejos", () => {
    const salio = [parada(0, 1, null, 0), parada(1, 2, 14, 20)];
    expect(ubicacionVigente(salio, punto(5))?.texto).toBe("Salió de L2");
    expect(ubicacionVigente(salio, punto(25))?.texto).toBe("Tupac Amarú");
  });
  it("sin marcas ni punto no hay ubicación", () => {
    expect(ubicacionVigente([], null)).toBeNull();
  });
});
