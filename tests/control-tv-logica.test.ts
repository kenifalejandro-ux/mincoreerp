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
import { anchoDeIcono, claseDeTipo, FORMAS } from "../client/src/components/controlTv/tiposUnidad";
import {
  colorDesvio,
  histograma,
  tendenciaMovil,
  topDesvios,
} from "../client/src/components/controlTv/resumenCorporativoLogica";
import { puedeVerControlTv } from "../client/src/components/flota/flotaAcceso";
import type { FilaViaje } from "../client/src/components/combustible/viajesFormato";

describe("FORMAS: cada tipo tiene su dibujo y su propio largo", () => {
  const clases = Object.keys(FORMAS) as (keyof typeof FORMAS)[];
  it("hay un dibujo para cada una de las 12 clases", () => {
    expect(clases).toHaveLength(12);
    for (const c of clases) {
      expect(FORMAS[c].w, c).toBeGreaterThan(0);
      expect(FORMAS[c].d.length, c).toBeGreaterThan(20);
    }
  });
  it("el tráiler es el más largo y la camioneta está entre las más cortas", () => {
    const ancho = (c: keyof typeof FORMAS) => FORMAS[c].w;
    for (const c of clases)
      if (c !== "trailer") expect(ancho("trailer"), c).toBeGreaterThan(ancho(c));
    expect(ancho("bombona")).toBeGreaterThan(ancho("volquete"));
    expect(ancho("carreta")).toBeGreaterThan(ancho("baranda"));
    expect(ancho("camioneta")).toBeLessThan(ancho("volquete"));
  });
  it("el ancho en píxeles crece con el alto y respeta la proporción del dibujo", () => {
    expect(anchoDeIcono("Tráiler", 24)).toBe(FORMAS.trailer.w);
    expect(anchoDeIcono("Tráiler", 48)).toBe(FORMAS.trailer.w * 2);
    // Un tipo desconocido o vacío se dibuja como «Otro».
    expect(anchoDeIcono("Grúa", 24)).toBe(FORMAS.otro.w);
    expect(anchoDeIcono(null, 24)).toBe(FORMAS.otro.w);
  });
});

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

describe("Resumen corporativo: cuentas de los gráficos", () => {
  it("la tendencia es una media móvil del mismo largo", () => {
    expect(tendenciaMovil([10, 20, 30, 40, 50])).toEqual([15, 20, 30, 40, 45]);
    expect(tendenciaMovil([])).toEqual([]);
  });

  it("el histograma reparte las duraciones en rangos iguales y calcula el promedio", () => {
    expect(histograma([])).toBeNull();
    const h = histograma([10, 11, 12, 14, 14, 20, 30])!;
    expect(h.bins.reduce((s, b) => s + b.n, 0)).toBe(7);
    expect(h.promedio).toBeCloseTo((10 + 11 + 12 + 14 + 14 + 20 + 30) / 7, 5);
    // Los rangos son contiguos y del mismo ancho.
    const ancho = h.bins[0].hasta - h.bins[0].desde;
    h.bins.forEach((b, i) => {
      expect(b.hasta - b.desde).toBe(ancho);
      if (i > 0) expect(b.desde).toBe(h.bins[i - 1].hasta);
    });
    // Un solo viaje cae en un solo rango.
    expect(histograma([8])!.bins.filter((b) => b.n > 0)).toHaveLength(1);
  });

  it("los desvíos salen del mayor al menor, con el mayor entre pares y pasado", () => {
    const r = topDesvios([
      { placa: "A", vs_pares_pct: 10, vs_pasado_pct: 40 },
      { placa: "B", vs_pares_pct: -50, vs_pasado_pct: null },
      { placa: "C", vs_pares_pct: null, vs_pasado_pct: 5 },
    ]);
    expect(r.map((x) => x.placa)).toEqual(["B", "A", "C"]);
    expect(r[0].pct).toBe(-50);
    expect(r[1].pct).toBe(40);
    expect(topDesvios([], 5)).toEqual([]);
    expect(colorDesvio(40)).toBe("#f87171");
    expect(colorDesvio(-20)).toBe("#a3c93a");
  });
});
