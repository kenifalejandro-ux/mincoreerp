/** tests/control-tv-paneles.test.ts
 *
 * Las cuentas de los paneles del Control TV: el tope redondo de las gráficas, la etiqueta de cada
 * corte (hora de Lima), el dibujo del envase de urea y el «hace…». Sin pantalla.
 */
import { describe, it, expect } from "vitest";
import {
  claseEnvase,
  etiquetaCorte,
  haceTexto,
  topeRedondo,
} from "../client/src/components/controlTv/paneles";

describe("topeRedondo", () => {
  it("sube al número redondo siguiente y nunca queda por debajo del máximo", () => {
    expect(topeRedondo(0)).toBe(1);
    expect(topeRedondo(7)).toBe(10);
    expect(topeRedondo(120)).toBe(200);
    expect(topeRedondo(2200)).toBe(2500);
    expect(topeRedondo(4800)).toBe(5000);
    for (const v of [0.3, 1, 9.9, 101, 2501, 76000])
      expect(topeRedondo(v)).toBeGreaterThanOrEqual(v);
  });
});

describe("etiquetaCorte", () => {
  it("por hora, la hora de Lima; por día, día/mes de Lima", () => {
    // 02:00 UTC es 21:00 del día anterior en Lima (UTC-5).
    expect(etiquetaCorte("2026-11-10T02:00:00Z", true)).toBe("21:00");
    expect(etiquetaCorte("2026-11-10T02:00:00Z", false)).toBe("09/11");
    expect(etiquetaCorte("2026-11-10T15:00:00Z", true)).toBe("10:00");
  });
});

describe("claseEnvase", () => {
  it("reconoce caja, bidón y balde sin tildes ni mayúsculas, y lo demás cae en «otro»", () => {
    expect(claseEnvase("Caja de 20 L")).toBe("caja");
    expect(claseEnvase("Bidón")).toBe("bidon");
    expect(claseEnvase("BIDON 10 L")).toBe("bidon");
    expect(claseEnvase("Balde de 5 L")).toBe("balde");
    expect(claseEnvase("Cilindro")).toBe("otro");
    expect(claseEnvase("Sin envase registrado")).toBe("otro");
  });
});

describe("haceTexto", () => {
  const AHORA = Date.parse("2026-11-10T12:00:00Z");
  const antes = (min: number) => new Date(AHORA - min * 60_000).toISOString();
  it("minutos, horas y días", () => {
    expect(haceTexto(antes(0), AHORA)).toBe("ahora");
    expect(haceTexto(antes(25), AHORA)).toBe("hace 25 min");
    expect(haceTexto(antes(150), AHORA)).toBe("hace 2 h");
    expect(haceTexto(antes(6 * 1440), AHORA)).toBe("hace 6 días");
    // Una hora en el futuro (reloj corrido) no da un número negativo.
    expect(haceTexto(antes(-30), AHORA)).toBe("ahora");
  });
});
