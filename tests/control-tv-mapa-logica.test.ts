/** tests/control-tv-mapa-logica.test.ts
 *
 * La lógica pura del mapa digital del Control TV: dónde queda cada lugar y cada unidad, cómo se
 * encuadra el mapa, y cómo se separan las unidades que están juntas. Sin pantalla.
 */
import { describe, it, expect } from "vitest";
import type { FilaViaje } from "../client/src/components/combustible/viajesFormato";
import {
  aPixel,
  arcosDelViaje,
  encuadre,
  escaparHtml,
  posicionEnMapa,
  puntoDeLugar,
  puntosDelViaje,
  separar,
  type LugarMapa,
} from "../client/src/components/controlTv/mapaLogica";

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
const viaje = (paradas: ReturnType<typeof parada>[]) =>
  ({ paradas, descansos: [], origen_id: "1", destino_id: "2" }) as unknown as FilaViaje;

const lugares = (...l: LugarMapa[]) => new Map(l.map((x) => [String(x.id), x]));
const TRUJILLO = { id: 1, nombre: "Trujillo", latitud: -8.1116, longitud: -79.0288 };
const TOCACHE = { id: 2, nombre: "Tocache", latitud: -8.1833, longitud: -76.5167 };

describe("puntoDeLugar: el lugar sin punto no se dibuja", () => {
  it("con las dos coordenadas da el punto; sin una de ellas, o sin lugar, null", () => {
    expect(puntoDeLugar(TRUJILLO)).toEqual({ lat: -8.1116, lon: -79.0288 });
    expect(puntoDeLugar({ id: 3, nombre: "X" })).toBeNull();
    expect(puntoDeLugar({ id: 3, nombre: "X", latitud: -5, longitud: null })).toBeNull();
    expect(puntoDeLugar({ id: 3, nombre: "X", latitud: null, longitud: -76 })).toBeNull();
    expect(puntoDeLugar(undefined)).toBeNull();
  });
  it("acepta números que llegan como texto y rechaza lo que no es número", () => {
    const texto = { id: 4, nombre: "T", latitud: "-5.9" as unknown as number, longitud: -76.1 };
    expect(puntoDeLugar(texto)).toEqual({ lat: -5.9, lon: -76.1 });
    const basura = { id: 5, nombre: "B", latitud: "abc" as unknown as number, longitud: 1 };
    expect(puntoDeLugar(basura)).toBeNull();
  });
});

describe("posicionEnMapa: dónde se dibuja la unidad", () => {
  const L = lugares(TRUJILLO, TOCACHE);
  const sale = viaje([parada(0, 1, null, 0), parada(1, 2, null, null), parada(2, 1, null, null)]);
  const enB = viaje([parada(0, 1, null, 0), parada(1, 2, 5, null), parada(2, 1, null, null)]);
  const sinSalir = viaje([parada(0, 1, null, null), parada(1, 2, null, null)]);
  const terminado = viaje([parada(0, 1, null, 0), parada(1, 2, 5, null)]);

  it("detenida en una parada va en esa parada", () => {
    const p = posicionEnMapa(enB, L);
    expect(p?.punto).toEqual({ lat: TOCACHE.latitud, lon: TOCACHE.longitud });
    expect(p?.tramo).toBeNull();
  });

  it("en camino va sobre el arco del tramo, entre las dos paradas", () => {
    const p = posicionEnMapa(sale, L);
    expect(p).not.toBeNull();
    expect(p!.tramo).toBe(0);
    expect(p!.fraccion).toBe(0.5);
    // Cae entre Trujillo y Tocache, no fuera del recuadro que forman.
    expect(p!.punto.lon).toBeGreaterThan(TRUJILLO.longitud);
    expect(p!.punto.lon).toBeLessThan(TOCACHE.longitud);
  });

  it("sin salir se muestra en el origen, y terminado en la última parada", () => {
    expect(posicionEnMapa(sinSalir, L)?.punto).toEqual({
      lat: TRUJILLO.latitud,
      lon: TRUJILLO.longitud,
    });
    expect(posicionEnMapa(terminado, L)?.punto).toEqual({
      lat: TOCACHE.latitud,
      lon: TOCACHE.longitud,
    });
  });

  it("si falta el punto de lo que necesita, la unidad queda sin ubicar (null), nunca en 0,0", () => {
    const sinTocache = lugares(TRUJILLO, { id: 2, nombre: "Tocache" });
    expect(posicionEnMapa(sale, sinTocache)).toBeNull(); // el tramo necesita los dos extremos
    expect(posicionEnMapa(enB, sinTocache)).toBeNull(); // parada sin punto
    expect(posicionEnMapa(sale, lugares())).toBeNull(); // ningún lugar ubicado
    // En el origen, con solo el origen ubicado, sí se puede mostrar.
    expect(posicionEnMapa(sinSalir, sinTocache)).not.toBeNull();
  });
});

describe("arcosDelViaje: el recorrido dibujado", () => {
  const P = (lat: number, lon: number) => ({ lat, lon });

  it("cada tramo con sus dos extremos es un arco con muestras desde A hasta B", () => {
    const arcos = arcosDelViaje([P(0, 0), P(0, 10)], 24);
    expect(arcos).toHaveLength(1);
    const a = arcos[0]!;
    expect(a).toHaveLength(25);
    expect(a[0]).toEqual(P(0, 0));
    expect(a[24].lon).toBeCloseTo(10, 9);
    expect(a[24].lat).toBeCloseTo(0, 9);
    // Se curva: el punto del medio no queda sobre la recta.
    expect(Math.abs(a[12].lat)).toBeGreaterThan(0.1);
  });

  it("el tramo con un extremo sin punto no se dibuja y los demás sí", () => {
    const arcos = arcosDelViaje([P(0, 0), null, P(0, 10), P(5, 10)]);
    expect(arcos.map((x) => x !== null)).toEqual([false, false, true]);
  });

  it("ida y vuelta se curvan a lados opuestos, para que no se pisen", () => {
    const arcos = arcosDelViaje([P(0, 0), P(0, 10), P(0, 0)]);
    const ida = arcos[0]![12].lat;
    const vuelta = arcos[1]![12].lat;
    expect(Math.sign(ida)).toBe(-Math.sign(vuelta));
  });

  it("dos paradas en el mismo punto no dan NaN", () => {
    const arco = arcosDelViaje([P(1, 1), P(1, 1)])[0]!;
    expect(arco.every((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))).toBe(true);
  });

  it("puntosDelViaje respeta el orden de las paradas y deja null donde falta el punto", () => {
    const v = viaje([parada(0, 1, null, 0), parada(1, 9, null, null), parada(2, 2, null, null)]);
    const pts = puntosDelViaje(v, lugares(TRUJILLO, TOCACHE));
    expect(pts[0]).not.toBeNull();
    expect(pts[1]).toBeNull();
    expect(pts[2]).not.toBeNull();
  });
});

describe("encuadre: el mapa se acerca a donde hay actividad", () => {
  it("sin puntos muestra la zona norte del Perú por defecto", () => {
    const c = encuadre([], 800, 600);
    expect(c.lon0).toBeLessThan(c.lon1);
    expect(c.lat0).toBeLessThan(c.lat1);
  });

  it("deja todos los puntos dentro con margen y respeta la proporción del lienzo", () => {
    const puntos = [
      { lat: -8.1, lon: -79 },
      { lat: -5.9, lon: -76 },
    ];
    for (const [w, hh] of [
      [1920, 1080],
      [400, 800],
      [1000, 1000],
    ]) {
      const c = encuadre(puntos, w, hh);
      for (const p of puntos) {
        expect(p.lon).toBeGreaterThan(c.lon0);
        expect(p.lon).toBeLessThan(c.lon1);
        expect(p.lat).toBeGreaterThan(c.lat0);
        expect(p.lat).toBeLessThan(c.lat1);
      }
      // Un grado mide lo mismo de ancho que de alto: el mapa no se deforma.
      expect((c.lon1 - c.lon0) / (c.lat1 - c.lat0)).toBeCloseTo(w / hh, 6);
    }
  });

  it("un solo punto, o varios casi juntos, abren un recuadro mínimo y no un punto sin tamaño", () => {
    const uno = encuadre([{ lat: -8, lon: -79 }], 800, 600);
    expect(uno.lon1 - uno.lon0).toBeGreaterThanOrEqual(3);
    expect(uno.lat1 - uno.lat0).toBeGreaterThanOrEqual(3);
    const casi = encuadre(
      [
        { lat: -8, lon: -79 },
        { lat: -8.001, lon: -79.001 },
      ],
      800,
      600
    );
    expect(casi.lon1 - casi.lon0).toBeGreaterThanOrEqual(3);
  });

  it("aPixel lleva las esquinas del recuadro a las esquinas del lienzo", () => {
    const c = { lon0: -80, lon1: -70, lat0: -10, lat1: 0 };
    expect(aPixel({ lat: 0, lon: -80 }, c, 500, 400)).toEqual({ x: 0, y: 0 });
    expect(aPixel({ lat: -10, lon: -70 }, c, 500, 400)).toEqual({ x: 500, y: 400 });
    expect(aPixel({ lat: -5, lon: -75 }, c, 500, 400)).toEqual({ x: 250, y: 200 });
  });
});

describe("separar: las unidades juntas se ven todas", () => {
  it("una sola unidad no se mueve, y las lejanas tampoco", () => {
    expect(separar([{ x: 10, y: 10 }])).toEqual([{ dx: 0, dy: 0 }]);
    const lejos = separar([
      { x: 0, y: 0 },
      { x: 100, y: 100 },
    ]);
    expect(lejos).toEqual([
      { dx: 0, dy: 0 },
      { dx: 0, dy: 0 },
    ]);
  });

  it("las que caen en el mismo punto se reparten en círculo, a distancia unas de otras", () => {
    const mismas = Array.from({ length: 10 }, () => ({ x: 50, y: 50 }));
    const d = separar(mismas, 11);
    // La primera queda en el centro; el resto, a su alrededor.
    expect(d[0]).toEqual({ dx: 0, dy: 0 });
    const lugares = d.map((o) => `${o.dx.toFixed(1)},${o.dy.toFixed(1)}`);
    expect(new Set(lugares).size).toBe(10); // ninguna encima de otra
    // Las del primer anillo (6) quedan a un radio del centro; las del segundo, a dos.
    for (let k = 1; k <= 6; k++) expect(Math.hypot(d[k].dx, d[k].dy)).toBeCloseTo(11, 5);
    for (let k = 7; k < 10; k++) expect(Math.hypot(d[k].dx, d[k].dy)).toBeCloseTo(22, 5);
  });

  it("es estable: la misma entrada da siempre los mismos corrimientos", () => {
    const e = Array.from({ length: 5 }, () => ({ x: 5, y: 5 }));
    expect(separar(e)).toEqual(separar(e));
  });

  it("40 unidades en el mismo punto no producen NaN", () => {
    const d = separar(Array.from({ length: 40 }, () => ({ x: 0, y: 0 })));
    expect(d).toHaveLength(40);
    expect(d.every((o) => Number.isFinite(o.dx) && Number.isFinite(o.dy))).toBe(true);
  });
});

describe("escaparHtml: el texto del mapa satélite no mete código en la pantalla", () => {
  it("escapa los cinco caracteres que cierran o abren etiquetas y atributos", () => {
    expect(escaparHtml(`<img src=x onerror="alert(1)">`)).toBe(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"
    );
    expect(escaparHtml("Tom & Jerry's")).toBe("Tom &amp; Jerry&#39;s");
    expect(escaparHtml("<script>")).not.toContain("<");
  });

  it("no toca un texto normal, con tildes o ñ, ni el vacío", () => {
    expect(escaparHtml("Yurimaguas · José Núñez")).toBe("Yurimaguas · José Núñez");
    expect(escaparHtml("")).toBe("");
  });

  it("escapa también lo ya escapado: no se cuela una entidad", () => {
    expect(escaparHtml("&lt;")).toBe("&amp;lt;");
  });
});
