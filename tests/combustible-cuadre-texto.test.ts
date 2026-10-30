/** tests/combustible-cuadre-texto.test.ts
 *
 * El texto de cada salida en el cuadre de la tanqueta. Si la tanqueta ya traía combustible (o
 * entró algo durante la salida), la cuenta salió con − cargó no da lo que debía volver: la línea
 * lo explica. Una tanqueta gastada del todo no tiene retorno que registrar: dice "se gastó todo".
 */
import { describe, it, expect } from "vitest";
import {
  describirSalida,
  type SalidaCuadre,
} from "../client/src/components/combustible/cuadreTanquetaDatos";

const base: SalidaCuadre = {
  fuente: "asignacion",
  vale: "A-2-15",
  unidad: "VQ-12",
  inicio: "2026-01-01T00:00:00.000Z",
  fin: null,
  estado: "cerrada",
  salioCon: 100,
  cargo: 70,
  cargas: 2,
  debiaVolver: 30,
  volvio: 28,
  diferencia: -2,
  motivo: "se derramó al bajarla",
  destinoDelRetorno: "reserva",
  llevaAhora: null,
};
const d = (x: Partial<SalidaCuadre>) => describirSalida({ ...base, ...x });

describe("cuadre de la tanqueta: el texto de cada salida", () => {
  it("el ejemplo aprobado queda exactamente igual", () => {
    expect(d({})).toBe(
      'Vale A-2-15 · unidad VQ-12 — salió con 100 gal · cargó 70 gal (2 cargas) · debía volver con 30 gal · volvió con 28 gal · diferencia −2 gal (motivo: "se derramó al bajarla")'
    );
  });

  it("con remanente: salió con 90, cargó 50 y debía volver 68 explica los 28 gal de más", () => {
    const t = d({
      salioCon: 90,
      cargo: 50,
      cargas: 1,
      debiaVolver: 68,
      volvio: 68,
      diferencia: 0,
      motivo: null,
    });
    expect(t).toBe(
      "Vale A-2-15 · unidad VQ-12 — salió con 90 gal · cargó 50 gal (1 carga) · debía volver con 68 gal (había 28 gal más: ya los tenía la tanqueta o entraron durante la salida) · volvió con 68 gal · cuadra"
    );
  });

  it("si el saldo real es MENOR que el del vale, también lo dice", () => {
    expect(d({ salioCon: 100, cargo: 50, debiaVolver: 40, volvio: 40, diferencia: 0 })).toContain(
      "(había 10 gal menos de lo que dice el vale)"
    );
  });

  it("una salida abierta con remanente explica lo que lleva", () => {
    const t = d({
      estado: "abierta",
      salioCon: 90,
      cargo: 50,
      cargas: 1,
      debiaVolver: null,
      volvio: null,
      diferencia: null,
      motivo: null,
      llevaAhora: 68,
    });
    expect(t).toContain("va con la unidad · lleva 68 gal (había 28 gal más:");
  });

  it("sin remanente no se agrega nada, ni por el ruido de los decimales", () => {
    expect(d({})).not.toContain("había");
    expect(
      d({ salioCon: 100, cargo: 70, debiaVolver: 30.004, volvio: 30.004, diferencia: 0 })
    ).not.toContain("había");
    // sin cantidad en el vale (anterior a la 0142) no hay con qué comparar
    expect(d({ salioCon: null })).not.toContain("había");
  });

  it("una tanqueta gastada del todo y sin retorno dice 'se gastó todo'", () => {
    const t = d({
      estado: "sin_retorno",
      salioCon: 100,
      cargo: 100,
      cargas: 2,
      debiaVolver: null,
      volvio: null,
      diferencia: null,
      motivo: null,
    });
    expect(t).toBe(
      "Vale A-2-15 · unidad VQ-12 — salió con 100 gal · cargó 100 gal (2 cargas) · se gastó todo"
    );
  });

  it("sin retorno pero con combustible sin cargar sigue diciendo que no se registró el retorno", () => {
    const t = d({
      estado: "sin_retorno",
      salioCon: 100,
      cargo: 60,
      debiaVolver: null,
      volvio: null,
      diferencia: null,
      motivo: null,
    });
    expect(t).toContain("no se registró su retorno");
    expect(t).not.toContain("se gastó todo");
    expect(d({ estado: "sin_retorno", salioCon: null, cargo: 0, cargas: 0 })).toContain(
      "no se registró su retorno"
    );
  });
});
