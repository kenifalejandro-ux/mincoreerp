/** tests/talonarios-cuadre-logica.test.ts -- el cuadre del reporte de talonarios y sus filas de Excel. */
import { describe, it, expect } from "vitest";
import {
  calcularCuadre,
  hojasDelExcel,
  ultimaVarilla,
  type FilaDeKardex,
} from "../client/src/components/combustible/talonariosCuadre";
import type { SerieTalonario } from "../client/src/components/combustible/valesFaltantesLogica";

const lectura = (dia: number, medido: number | null, teorico: number | null, extra = {}) => ({
  tipo: "lectura",
  anulada: false,
  historico: false,
  ocurrido_en: `2026-11-${String(dia).padStart(2, "0")}T12:00:00.000Z`,
  nivel_medido: medido,
  saldo_teorico: teorico,
  ...extra,
});

const serie = (usados: number, faltan: number, galones: number, litros = 0): SerieTalonario => ({
  serie: "001",
  minimo: 1,
  maximo: usados + faltan,
  usados,
  faltan,
  explicados: 0,
  sin_explicar: faltan,
  litros,
  galones,
  ultimo_vale: usados + faltan,
  ultima_fecha: "2026-11-11T22:00:00.000Z",
  tramos: [],
});

describe("ultimaVarilla", () => {
  it("toma la más reciente aunque vengan desordenadas", () => {
    const filas: FilaDeKardex[] = [lectura(6, 6133, 8393), lectura(2, 9000, 9100)];
    expect(ultimaVarilla(filas)).toMatchObject({ medido: 6133, teorico: 8393 });
  });
  it("ignora anuladas, históricas, sin medida y otros movimientos", () => {
    const filas: FilaDeKardex[] = [
      lectura(2, 9000, 9100),
      lectura(8, 1, 2, { anulada: true }),
      lectura(9, 1, 2, { historico: true }),
      lectura(10, null, 2),
      { ...lectura(11, 1, 2), tipo: "despacho" },
    ];
    expect(ultimaVarilla(filas)).toMatchObject({ medido: 9000, teorico: 9100 });
  });
  it("sin varillas válidas devuelve null", () => {
    expect(ultimaVarilla([])).toBeNull();
  });
});

describe("calcularCuadre", () => {
  const varilla = { ocurrido_en: "2026-11-06T13:59:00.000Z", medido: 6133.3, teorico: 8393.5 };

  it("estima lo que faltan los vales con el promedio por vale", () => {
    // 20 vales usados que sumaron 1400 gal: 70 gal por vale. Faltan 12: ≈ 840 gal.
    const c = calcularCuadre([serie(20, 12, 1400)], varilla, "gal");
    expect(c.promedioPorVale).toBeCloseTo(70, 5);
    expect(c.estimadoFaltantes).toBeCloseTo(840, 5);
    expect(c.faltanteTanque).toBeCloseTo(2260.2, 5);
    expect(c.sinExplicar).toBeCloseTo(1420.2, 5);
    expect(c.valesSinExplicar).toBeCloseTo(1420.2 / 70, 5);
  });

  it("suma varias series y usa la unidad del tanque", () => {
    const c = calcularCuadre([serie(10, 0, 100, 378.5), serie(10, 5, 300, 1135.5)], varilla, "L");
    expect(c.despachado).toBeCloseTo(1514, 5);
    expect(c.usados).toBe(20);
    expect(c.faltan).toBe(5);
  });

  it("si los vales que faltan explican todo, no queda nada sin explicar", () => {
    const c = calcularCuadre([serie(10, 100, 1000)], varilla, "gal");
    expect(c.sinExplicar).toBe(0);
  });

  it("los vales dados de baja no cuentan en la estimación", () => {
    const explicada: SerieTalonario = { ...serie(20, 12, 1400), explicados: 12, sin_explicar: 0 };
    const c = calcularCuadre([explicada], varilla, "gal");
    expect(c.faltan).toBe(0);
    expect(c.estimadoFaltantes).toBe(0);
    expect(c.sinExplicar).toBeCloseTo(2260.2, 5);
  });

  it("sin vales usados no hay promedio ni equivalencia", () => {
    const c = calcularCuadre([serie(0, 5, 0)], varilla, "gal");
    expect(c.promedioPorVale).toBe(0);
    expect(c.valesSinExplicar).toBeNull();
  });
});

describe("hojasDelExcel", () => {
  it("una fila por serie y una por tramo, con quién registró los vales de al lado", () => {
    const s: SerieTalonario = {
      ...serie(5, 2, 100, 378),
      tramos: [
        {
          desde: 3,
          hasta: 4,
          cantidad: 2,
          anterior: { n: 2, registrado_por: "sigma", despachado_en: "2026-11-03T19:00:00.000Z" },
          siguiente: null,
          vales: [
            { n: 3, baja: null },
            {
              n: 4,
              baja: {
                desde: 4,
                hasta: 4,
                motivo: "mal_llenado",
                detalle: null,
                dado_por: "Admin",
                fecha: "2026-11-12T14:00:00.000Z",
              },
            },
          ],
          explicados: 1,
          sin_explicar: 1,
        },
      ],
    };
    const { filasSeries, filasTramos } = hojasDelExcel([s], () => "03/11");
    expect(filasSeries).toHaveLength(1);
    expect(filasSeries[0]).toMatchObject({ Serie: "001", Usados: 5, Faltan: 2, Galones: 100 });
    // Una fila por vale que falta, con su estado y quién lo regularizó.
    expect(filasTramos).toHaveLength(2);
    expect(filasTramos[0]).toMatchObject({
      Serie: "001",
      Vale: 3,
      Estado: "Sin explicar",
      Motivo: "",
      "Vale anterior": 2,
      "Registrado el anterior": "sigma, 03/11",
      "Vale siguiente": 5,
      "Registrado el siguiente": "",
    });
    expect(filasTramos[1]).toMatchObject({
      Vale: 4,
      Estado: "Regularizado",
      Motivo: "Mal llenado, se anuló",
      "Regularizado por": "Admin",
    });
  });
});
