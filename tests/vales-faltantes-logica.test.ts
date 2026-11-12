/** tests/vales-faltantes-logica.test.ts -- los textos del aviso de vales del kardex. */
import { describe, it, expect } from "vitest";
import {
  rangoTexto,
  seriesConFaltantes,
  textoVecinos,
  totalFaltantes,
  valeTexto,
  type SerieTalonario,
  type TramoFaltante,
} from "../client/src/components/combustible/valesFaltantesLogica";

const serie = (faltan: number): SerieTalonario => ({
  serie: "001",
  minimo: 1280,
  maximo: 1357,
  usados: 55,
  faltan,
  litros: 0,
  galones: 0,
  ultimo_vale: 1357,
  ultima_fecha: "2026-11-11T22:00:00.000Z",
  tramos: [],
});

describe("aviso de vales faltantes", () => {
  it("el vale se escribe como en el papel, con cinco dígitos", () => {
    expect(valeTexto("001", 1289)).toBe("001-01289");
    expect(valeTexto("A-2", 15)).toBe("A-2-00015");
  });

  it("un tramo de un vale es un número; de varios, un rango", () => {
    expect(rangoTexto({ desde: 1289, hasta: 1289 })).toBe("01289");
    expect(rangoTexto({ desde: 1302, hasta: 1304 })).toBe("01302 – 01304");
  });

  it("suma los faltantes de todas las series y deja solo las que tienen", () => {
    const series = [serie(3), serie(0), serie(20)];
    expect(totalFaltantes(series)).toBe(23);
    expect(seriesConFaltantes(series)).toHaveLength(2);
    expect(totalFaltantes([])).toBe(0);
  });

  it("dice entre qué vales cayó el hueco y quién registró los vecinos", () => {
    const tramo: TramoFaltante = {
      desde: 1302,
      hasta: 1304,
      cantidad: 3,
      anterior: { n: 1301, registrado_por: "joel", despachado_en: "a" },
      siguiente: { n: 1305, registrado_por: null, despachado_en: "b" },
    };
    expect(textoVecinos("001", tramo, (iso) => iso)).toBe(
      "Entre el 001-01301 (registrado por joel, a) y el 001-01305 (registrado por un usuario ya borrado, b)"
    );
  });

  it("un vecino que no es despacho se nombra sin quién", () => {
    const tramo: TramoFaltante = {
      desde: 5,
      hasta: 5,
      cantidad: 1,
      anterior: null,
      siguiente: null,
    };
    expect(textoVecinos("001", tramo, (iso) => iso)).toBe("Entre el 001-00004 y el 001-00006");
  });
});
