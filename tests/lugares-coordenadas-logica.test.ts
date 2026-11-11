/** tests/lugares-coordenadas-logica.test.ts
 *
 * El punto de un lugar en el mapa: leer lo que se pega (como lo copia Google Maps) y pasar de un clic
 * en el mapa a grados y de vuelta.
 */
import { describe, it, expect } from "vitest";
import {
  aGrados,
  aPixeles,
  aPunto,
  CAJA_PERU,
  parsearCoordenadas,
  textoDePunto,
} from "../client/src/components/combustible/coordenadasLogica";

describe("parsearCoordenadas: lo que se pega", () => {
  it("lee los formatos que se copian de Google Maps y de otras fuentes", () => {
    const esperado = { lat: -5.9003, lon: -76.0947 };
    for (const texto of [
      "-5.9003, -76.0947",
      "-5.9003,-76.0947",
      "  -5.9003 , -76.0947  ",
      "-5.9003 -76.0947",
      "-5.9003; -76.0947",
      "(-5.9003, -76.0947)",
      "-5.9003°, -76.0947°",
    ]) {
      expect(parsearCoordenadas(texto), texto).toEqual(esperado);
    }
  });

  it("rechaza lo que no es un par de grados válido, sin lanzar errores", () => {
    for (const texto of [
      "",
      "   ",
      "abc",
      "-5.9",
      "-5.9, -76.0, 10",
      "-5.9, ",
      ", -76",
      "91, 0",
      "-91, 0",
      "0, 181",
      "0, -181",
      "NaN, 1",
      "Infinity, 1",
      "5.9.1, 2",
    ]) {
      expect(parsearCoordenadas(texto), JSON.stringify(texto)).toBeNull();
    }
    // Los bordes exactos valen.
    expect(parsearCoordenadas("90, 180")).toEqual({ lat: 90, lon: 180 });
    expect(parsearCoordenadas("-90, -180")).toEqual({ lat: -90, lon: -180 });
  });

  it("ida y vuelta: lo que se muestra se vuelve a leer igual", () => {
    const p = { lat: -7.16373, lon: -78.50031 };
    expect(parsearCoordenadas(textoDePunto(p))).toEqual(p);
    expect(textoDePunto(null)).toBe("");
  });
});

describe("el mapa del selector: de píxeles a grados y de vuelta", () => {
  it("las esquinas del lienzo son las esquinas del recuadro del Perú", () => {
    expect(aPunto(0, 0, 400, 500)).toEqual({ lat: CAJA_PERU.lat1, lon: CAJA_PERU.lon0 });
    expect(aPunto(400, 500, 400, 500)).toEqual({ lat: CAJA_PERU.lat0, lon: CAJA_PERU.lon1 });
  });

  it("un clic y su punto vuelven al mismo píxel (con el redondeo a 6 decimales)", () => {
    const p = aPunto(137, 211, 400, 500);
    const px = aPixeles(p, 400, 500);
    expect(px.x).toBeCloseTo(137, 3);
    expect(px.y).toBeCloseTo(211, 3);
  });

  it("los grados se guardan con seis decimales, como la base", () => {
    expect(aGrados(-5.90031234567)).toBe(-5.900312);
    expect(aGrados(-76)).toBe(-76);
  });
});
