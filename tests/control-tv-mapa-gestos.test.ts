/** tests/control-tv-mapa-gestos.test.ts
 *
 * La lógica de mover y acercar el mapa digital del Control TV (arrastrar, rueda, dos dedos), el recuadro
 * mínimo de la vista de una unidad, qué unidad queda bajo el puntero y la etiqueta «Nuevo» del ícono de TV.
 * Sin pantalla.
 */
import { describe, it, expect } from "vitest";
import {
  acercar,
  aPixel,
  desplazar,
  encuadre,
  masCercana,
  ZOOM_MAX_GRADOS,
  ZOOM_MIN_GRADOS,
  type Caja,
} from "../client/src/components/controlTv/mapaLogica";
import {
  HORAS_DE_AVISO,
  marcarNovedadVista,
  novedadVigente,
} from "../client/src/components/controlTv/novedad";

const CAJA: Caja = { lon0: -80, lon1: -76, lat0: -10, lat1: -6 };
const W = 800;
const H = 800;

describe("control TV: arrastrar y acercar el mapa", () => {
  it("arrastrar a la derecha muestra lo de la izquierda; hacia abajo, lo de arriba", () => {
    const c = desplazar(CAJA, 200, 0, W, H);
    expect(c.lon0).toBeCloseTo(-81, 9); // 200 px de 800 = una cuarta parte de 4°
    expect(c.lon1).toBeCloseTo(-77, 9);
    expect(c.lat0).toBe(CAJA.lat0);
    const d = desplazar(CAJA, 0, 400, W, H);
    expect(d.lat0).toBeCloseTo(-8, 9);
    expect(d.lat1).toBeCloseTo(-4, 9);
  });

  it("el tamaño del recuadro no cambia al arrastrar", () => {
    const c = desplazar(CAJA, 123, -57, W, H);
    expect(c.lon1 - c.lon0).toBeCloseTo(4, 9);
    expect(c.lat1 - c.lat0).toBeCloseTo(4, 9);
  });

  it("acercar deja quieto el punto que está bajo el puntero", () => {
    const antes = aPixel({ lat: -7, lon: -78.5 }, CAJA, W, H);
    const c = acercar(CAJA, 2, antes.x, antes.y, W, H);
    const despues = aPixel({ lat: -7, lon: -78.5 }, c, W, H);
    expect(despues.x).toBeCloseTo(antes.x, 6);
    expect(despues.y).toBeCloseTo(antes.y, 6);
    expect(c.lon1 - c.lon0).toBeCloseTo(2, 9); // el doble de cerca
    expect(c.lat1 - c.lat0).toBeCloseTo(2, 9); // y sigue la misma proporción
  });

  it("alejar y volver a acercar deja el mismo recuadro", () => {
    const a = acercar(CAJA, 0.5, 300, 500, W, H);
    const b = acercar(a, 2, 300, 500, W, H);
    for (const k of ["lon0", "lon1", "lat0", "lat1"] as const) expect(b[k]).toBeCloseTo(CAJA[k], 6);
  });

  it("no se acerca más que una zona de unos 6 km ni se aleja más que el país", () => {
    const cerca = acercar(CAJA, 1e9, 400, 400, W, H);
    expect(cerca.lon1 - cerca.lon0).toBeCloseTo(ZOOM_MIN_GRADOS, 9);
    const lejos = acercar(CAJA, 1e-9, 400, 400, W, H);
    expect(lejos.lon1 - lejos.lon0).toBeCloseTo(ZOOM_MAX_GRADOS, 9);
  });

  it("un factor que no es número no rompe el mapa", () => {
    for (const f of [0, -2, Number.NaN]) expect(acercar(CAJA, f, 10, 10, W, H)).toEqual(CAJA);
  });
});

describe("control TV: encuadre de la ruta de una unidad", () => {
  // Huamachuco y Trujillo, unos 1° de distancia.
  const puntos = [
    { lat: -7.8, lon: -78.05 },
    { lat: -8.11, lon: -79.03 },
  ];
  const ancho = (c: Caja) => c.lon1 - c.lon0;

  it("con el mínimo de la flota (3°) la ruta queda lejos; con el de la unidad queda de cerca", () => {
    const flota = encuadre(puntos, 1000, 400);
    const unidad = encuadre(puntos, 1000, 400, 0.18, 0.5);
    expect(ancho(flota)).toBeGreaterThan(4);
    expect(ancho(unidad)).toBeLessThan(ancho(flota) / 2);
  });

  it("la ruta cabe entera dentro del encuadre de la unidad", () => {
    const c = encuadre(puntos, 1000, 400, 0.18, 0.5);
    for (const p of puntos) {
      const q = aPixel(p, c, 1000, 400);
      expect(q.x).toBeGreaterThan(0);
      expect(q.x).toBeLessThan(1000);
      expect(q.y).toBeGreaterThan(0);
      expect(q.y).toBeLessThan(400);
    }
  });

  it("un solo punto abre un recuadro del mínimo pedido, sin dividir entre cero", () => {
    const c = encuadre([puntos[0]], 800, 800, 0, 0.5);
    expect(ancho(c)).toBeCloseTo(0.5, 9);
    expect(Number.isFinite(c.lat0) && Number.isFinite(c.lat1)).toBe(true);
  });

  it("sin puntos encuadra el Perú", () => {
    expect(encuadre([], 800, 800)).toEqual({ lon0: -81.6, lon1: -73.6, lat0: -9.9, lat1: -3.5 });
  });
});

describe("control TV: la unidad bajo el puntero", () => {
  const unidades = [
    { id: "a", x: 100, y: 100 },
    { id: "b", x: 110, y: 100 },
    { id: "c", x: 400, y: 300 },
  ];

  it("toma la más cercana dentro del radio", () => {
    expect(masCercana(unidades, 108, 100, 14)).toBe("b");
    expect(masCercana(unidades, 98, 102, 14)).toBe("a");
    expect(masCercana(unidades, 400, 300)).toBe("c");
  });

  it("fuera del radio no hay ninguna", () => {
    expect(masCercana(unidades, 250, 200, 14)).toBeNull();
    expect(masCercana([], 10, 10)).toBeNull();
  });
});

describe("control TV: la etiqueta «Nuevo» del ícono de TV", () => {
  const H24 = HORAS_DE_AVISO * 3_600_000;
  const almacenFalso = () => {
    const m = new Map<string, string>();
    return {
      m,
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
    };
  };

  it("sale mientras nadie abrió el Control TV", () => {
    expect(novedadVigente(1_000, almacenFalso())).toBe(true);
  });

  it("después del primer clic sigue 24 horas y luego desaparece", () => {
    const a = almacenFalso();
    marcarNovedadVista(1_000_000, a);
    expect(novedadVigente(1_000_000 + 1, a)).toBe(true);
    expect(novedadVigente(1_000_000 + H24 - 1, a)).toBe(true);
    expect(novedadVigente(1_000_000 + H24, a)).toBe(false);
  });

  it("los clics siguientes no mueven la hora del primero", () => {
    const a = almacenFalso();
    marcarNovedadVista(1_000_000, a);
    marcarNovedadVista(1_000_000 + H24 - 5, a);
    expect(novedadVigente(1_000_000 + H24, a)).toBe(false);
  });

  it("cada novedad tiene su propia clave: una nueva vuelve a salir", () => {
    const a = almacenFalso();
    marcarNovedadVista(1_000_000, a, "vieja");
    expect(novedadVigente(1_000_000 + 10 * H24, a, "vieja")).toBe(false);
    expect(novedadVigente(1_000_000 + 10 * H24, a, "nueva")).toBe(true);
  });

  it("sin almacenamiento (ventana privada o bloqueado) sale siempre y no falla", () => {
    expect(novedadVigente(1, null)).toBe(true);
    expect(() => marcarNovedadVista(1, null)).not.toThrow();
    const roto = {
      getItem: () => {
        throw new Error("bloqueado");
      },
      setItem: () => {
        throw new Error("bloqueado");
      },
    };
    expect(novedadVigente(1, roto)).toBe(true);
    expect(() => marcarNovedadVista(1, roto)).not.toThrow();
  });

  it("un valor guardado que no es número cuenta como «todavía no hizo clic»", () => {
    const a = almacenFalso();
    a.setItem("controlTv.novedad.x", "abc");
    expect(novedadVigente(5, a, "x")).toBe(true);
  });
});
