/** tests/control-tv-mapa-logica.test.ts
 *
 * La lógica pura del mapa digital del Control TV: dónde queda cada lugar y cada unidad, cómo se
 * encuadra el mapa, y cómo se separan las unidades que están juntas. Sin pantalla.
 */
import { describe, it, expect } from "vitest";
import type { FilaViaje } from "../client/src/components/combustible/viajesFormato";
import {
  aPixel,
  contarPorEstado,
  encuadre,
  escaparHtml,
  filtrarPorEstado,
  posicionEnMapa,
  puntosDeEncuadre,
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

  it("en camino va a mitad del tramo, en línea recta entre las dos paradas", () => {
    const p = posicionEnMapa(sale, L);
    expect(p).not.toBeNull();
    expect(p!.tramo).toBe(0);
    expect(p!.fraccion).toBe(0.5);
    // El punto medio recto: justo entre Trujillo y Tocache.
    expect(p!.punto.lat).toBeCloseTo((TRUJILLO.latitud + TOCACHE.latitud) / 2, 9);
    expect(p!.punto.lon).toBeCloseTo((TRUJILLO.longitud + TOCACHE.longitud) / 2, 9);
  });

  describe("con un punto anotado en un lugar con coordenadas", () => {
    const ubic = (lugar_id: number | null, horas: number) => ({
      id: 1,
      lugar_id,
      texto: "Tupac amaru",
      nota: null,
      registrado_en: h(horas),
      origen: "oficina" as const,
    });
    const conPunto = (v: FilaViaje, u: ReturnType<typeof ubic> | null) =>
      ({ ...v, ultima_ubicacion: u }) as unknown as FilaViaje;
    const AMARU = { id: 7, nombre: "Tupac amaru", latitud: -8.12, longitud: -78.0 };
    const L3 = lugares(TRUJILLO, TOCACHE, AMARU);

    it("la unidad va exactamente ahí, no a mitad del tramo", () => {
      const p = posicionEnMapa(conPunto(sale, ubic(7, 2)), L3);
      expect(p?.punto).toEqual({ lat: AMARU.latitud, lon: AMARU.longitud });
    });

    it("si el lugar no tiene punto, o se escribió texto libre, se estima por las marcas", () => {
      const sinPunto = lugares(TRUJILLO, TOCACHE, { id: 7, nombre: "Tupac amaru" });
      const medio = posicionEnMapa(sale, L3)?.punto;
      expect(posicionEnMapa(conPunto(sale, ubic(7, 2)), sinPunto)?.punto).toEqual(medio);
      expect(posicionEnMapa(conPunto(sale, ubic(null, 2)), L3)?.punto).toEqual(medio);
      expect(posicionEnMapa(conPunto(sale, ubic(99, 2)), L3)?.punto).toEqual(medio);
    });

    it("un punto anterior a la salida, o una llegada a una parada, mandan sobre él", () => {
      // El punto es de antes de que saliera (hora -3, salida en la 0): vale «Salió de…».
      const viejo = posicionEnMapa(conPunto(sale, ubic(7, -3)), L3)?.punto;
      expect(viejo).toEqual(posicionEnMapa(sale, L3)?.punto);
      // Ya llegó a Tocache: la llegada manda aunque haya un punto anotado después.
      const llego = posicionEnMapa(conPunto(enB, ubic(7, 6)), L3)?.punto;
      expect(llego).toEqual({ lat: TOCACHE.latitud, lon: TOCACHE.longitud });
    });

    it("la posición se marca como exacta solo cuando va en el lugar anotado", () => {
      expect(posicionEnMapa(conPunto(sale, ubic(7, 2)), L3)?.exacta).toBe(true);
      expect(posicionEnMapa(sale, L3)?.exacta).toBeUndefined();
      expect(posicionEnMapa(conPunto(sale, ubic(null, 2)), L3)?.exacta).toBeUndefined();
    });

    it("sin ubicación anotada todo sigue como antes", () => {
      expect(posicionEnMapa(conPunto(sale, null), L3)).toEqual(posicionEnMapa(sale, L3));
    });
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

describe("puntosDelViaje: los puntos del recorrido", () => {
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

describe("la leyenda del mapa es el filtro: cuenta y filtra por estado", () => {
  const filas = [
    { id: "a", cat: "ruta" as const },
    { id: "b", cat: "ruta" as const },
    { id: "c", cat: "retorno" as const },
    { id: "d", cat: "detenida" as const },
    { id: "e", cat: "parada" as const },
  ];

  it("cada estado cuenta sus unidades y «todas» las cuenta todas", () => {
    expect(contarPorEstado(filas, "todas")).toBe(5);
    expect(contarPorEstado(filas, "ruta")).toBe(2);
    expect(contarPorEstado(filas, "retorno")).toBe(1);
    expect(contarPorEstado(filas, "detenida")).toBe(1);
    expect(contarPorEstado(filas, "parada")).toBe(1);
    expect(contarPorEstado(filas, "descansa")).toBe(0);
  });

  it("los conteos de los estados suman el total (ninguna unidad se pierde ni se repite)", () => {
    const estados = ["ruta", "retorno", "parada", "descansa", "detenida"] as const;
    const suma = estados.reduce((s, k) => s + contarPorEstado(filas, k), 0);
    expect(suma).toBe(contarPorEstado(filas, "todas"));
  });

  it("filtrar deja solo las de ese estado, y «todas» las deja todas, en el mismo orden", () => {
    expect(filtrarPorEstado(filas, "ruta").map((f) => f.id)).toEqual(["a", "b"]);
    expect(filtrarPorEstado(filas, "detenida").map((f) => f.id)).toEqual(["d"]);
    expect(filtrarPorEstado(filas, "todas").map((f) => f.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(filtrarPorEstado(filas, "descansa")).toEqual([]);
  });

  it("el conteo de la leyenda coincide con lo que muestra el filtro", () => {
    for (const k of ["todas", "ruta", "retorno", "parada", "descansa", "detenida"] as const) {
      expect(filtrarPorEstado(filas, k)).toHaveLength(contarPorEstado(filas, k));
    }
  });

  it("sin unidades, todo es cero y no falla", () => {
    expect(contarPorEstado([], "todas")).toBe(0);
    expect(filtrarPorEstado([], "ruta")).toEqual([]);
  });
});

describe("puntosDeEncuadre: lo que el mapa tiene que mostrar", () => {
  const P = (lat: number, lon: number) => ({ lat, lon });
  const pos = (lat: number, lon: number) => ({ punto: P(lat, lon), tramo: null, fraccion: 0 });

  it("incluye los lugares de la ruta y la posición de la unidad, sin los lugares sin punto", () => {
    const pts = puntosDeEncuadre([{ puntos: [P(1, 1), null, P(2, 2)], pos: pos(9, 9) }]);
    expect(pts).toEqual([P(1, 1), P(2, 2), P(9, 9)]);
  });

  it("una ubicación anotada lejos de la ruta entra en el encuadre", () => {
    const ruta = [P(-8.1, -79.0), P(-8.2, -76.5)];
    const lejos = pos(-12.6, -69.2);
    const solo = encuadre(puntosDeEncuadre([{ puntos: ruta, pos: null }]), 800, 400);
    const con = encuadre(puntosDeEncuadre([{ puntos: ruta, pos: lejos }]), 800, 400);
    const dentro = (c: typeof solo) =>
      lejos.punto.lon >= c.lon0 &&
      lejos.punto.lon <= c.lon1 &&
      lejos.punto.lat >= c.lat0 &&
      lejos.punto.lat <= c.lat1;
    expect(dentro(solo)).toBe(false);
    expect(dentro(con)).toBe(true);
  });

  it("sin unidades ni puntos da una lista vacía", () => {
    expect(puntosDeEncuadre([])).toEqual([]);
    expect(puntosDeEncuadre([{ puntos: [null], pos: null }])).toEqual([]);
  });
});
