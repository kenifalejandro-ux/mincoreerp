/** tests/control-tv-logica.test.ts
 *
 * La lógica pura del Control TV: el ícono por tipo de unidad, el estado de cada unidad, dónde se
 * dibuja, y las cuentas de las tarjetas. Sin pantalla.
 */
import { describe, it, expect } from "vitest";
import {
  autonomiaDias,
  categoriaDe,
  porcentajeOperativas,
  posicionEnRuta,
  puntosTendencia,
  valorEnTanques,
} from "../client/src/components/controlTv/controlTvLogica";
import { claseDeTipo } from "../client/src/components/controlTv/tiposUnidad";
import { puedeVerControlTv } from "../client/src/components/flota/flotaAcceso";
import type { FilaViaje } from "../client/src/components/combustible/viajesFormato";

describe("claseDeTipo: un ícono por tipo de unidad", () => {
  it("reconoce los 12 tipos del registro, sin mayúsculas ni tildes", () => {
    const casos: [string, string][] = [
      ["Camioneta", "camioneta"],
      ["Cargador frontal", "cargador"],
      ["Camión baranda", "baranda"],
      ["Tracto remolcadores", "tracto"],
      ["Excavadora", "excavadora"],
      ["Retroexcavadora", "retro"],
      ["VOLQUETE", "volquete"],
      ["Tráiler", "trailer"],
      ["trailer", "trailer"],
      ["Carretas", "carreta"],
      ["Bombona", "bombona"],
      ["Perforadora", "perforadora"],
      ["Otro", "otro"],
    ];
    for (const [tipo, clase] of casos) expect(claseDeTipo(tipo), tipo).toBe(clase);
  });
  it("la retroexcavadora no se confunde con la excavadora, y lo desconocido cae en «otro»", () => {
    expect(claseDeTipo("Retroexcavadora CAT")).toBe("retro");
    expect(claseDeTipo("Grúa")).toBe("otro");
    expect(claseDeTipo(null)).toBe("otro");
    expect(claseDeTipo("")).toBe("otro");
  });
});

const h = (n: number) => new Date(Date.UTC(2026, 10, 10, 12) + n * 3_600_000).toISOString();
const parada = (orden: number, lugar_id: number, ll: number | null, sa: number | null) => ({
  orden,
  lugar_id,
  lugar: `L${lugar_id}`,
  llegada_en: ll === null ? null : h(ll),
  llegada_medidor: null,
  salida_en: sa === null ? null : h(sa),
  salida_medidor: null,
});
const viaje = (paradas: ReturnType<typeof parada>[], descansos: unknown[] = []) =>
  ({ paradas, descansos, origen_id: "1", destino_id: "2" }) as unknown as FilaViaje;

describe("categoriaDe y posicionEnRuta", () => {
  const sale = [parada(0, 1, null, 0), parada(1, 2, null, null), parada(2, 1, null, null)];
  const enB = [parada(0, 1, null, 0), parada(1, 2, 5, null), parada(2, 1, null, null)];
  const vuelta = [parada(0, 1, null, 0), parada(1, 2, 5, 8), parada(2, 1, null, null)];

  it("en ruta, en parada y retornando", () => {
    expect(categoriaDe(viaje(sale))).toBe("ruta");
    expect(categoriaDe(viaje(enB))).toBe("parada");
    expect(categoriaDe(viaje(vuelta))).toBe("retorno");
  });
  it("un descanso abierto manda: avería es detenida; dormir, descansando; el que no detiene no cuenta", () => {
    const d = (motivo: string, detiene = true) => [
      { inicio_en: h(1), fin_en: null, motivo, detiene },
    ];
    expect(categoriaDe(viaje(sale, d("Avería")))).toBe("detenida");
    expect(categoriaDe(viaje(sale, d("Tráfico · obras")))).toBe("detenida");
    expect(categoriaDe(viaje(sale, d("Dormir")))).toBe("descansa");
    expect(categoriaDe(viaje(sale, d("Dormir", false)))).toBe("ruta");
  });
  it("la posición va de 0 (salida) a 1 (regreso): a mitad del tramo si va en camino", () => {
    expect(posicionEnRuta(viaje(sale))).toBeCloseTo(0.25, 5);
    expect(posicionEnRuta(viaje(enB))).toBeCloseTo(0.5, 5);
    expect(posicionEnRuta(viaje(vuelta))).toBeCloseTo(0.75, 5);
  });
});

describe("cuentas de las tarjetas", () => {
  it("porcentaje de la flota operativa", () => {
    expect(porcentajeOperativas({ activos: 40, en_ruta: 14, retornando: 11, en_parada: 8 })).toBe(
      83
    );
    expect(porcentajeOperativas({ activos: 0, en_ruta: 0, retornando: 0, en_parada: 0 })).toBe(0);
  });
  it("autonomía: lo que hay entre el ritmo diario del período; sin consumo no hay", () => {
    expect(autonomiaDias(6000, 1000, "24h")).toBe(6);
    expect(autonomiaDias(6000, 1000, "7d")).toBe(42);
    expect(autonomiaDias(6000, 0, "30d")).toBeNull();
  });
  it("valor en tanques: nivel por costo promedio, y un tanque sin costo no suma", () => {
    expect(
      valorEnTanques([
        { nivel: 100, costo_promedio: 16 },
        { nivel: "50", costo_promedio: 10 },
        { nivel: 500, costo_promedio: null },
        { nivel: null, costo_promedio: 20 },
      ])
    ).toBe(2100);
  });
  it("la tendencia necesita al menos dos puntos y queda dentro del recuadro", () => {
    expect(puntosTendencia([5], 114, 38)).toBe("");
    const pts = puntosTendencia([1, 5, 3], 114, 38).split(" ");
    expect(pts).toHaveLength(3);
    for (const p of pts) {
      const [x, y] = p.split(",").map(Number);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(114);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(38);
    }
  });
});

describe("puedeVerControlTv", () => {
  const u = (
    rol: string,
    extra: Record<string, boolean> = {},
    modulos = ["viajes", "combustible"]
  ) => ({
    rol,
    modulosPermitidos: modulos,
    permisosPestanas: extra,
  });
  it("admin y lectura por defecto; operador y cancha no", () => {
    expect(puedeVerControlTv(u("admin"))).toBe(true);
    expect(puedeVerControlTv(u("lectura"))).toBe(true);
    expect(puedeVerControlTv(u("operador"))).toBe(false);
    expect(puedeVerControlTv(u("conductor_ruta"))).toBe(false);
  });
  it("el permiso por persona manda, y sin el módulo Viajes no hay pantalla", () => {
    expect(puedeVerControlTv(u("operador", { "combustible:viajes:control_tv": true }))).toBe(true);
    expect(puedeVerControlTv(u("lectura", { "combustible:viajes:control_tv": false }))).toBe(false);
    expect(puedeVerControlTv(u("admin", {}, ["combustible"]))).toBe(false);
    expect(puedeVerControlTv(null)).toBe(false);
  });
});
