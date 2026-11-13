/** tests/resumen-talonarios-logica.test.ts -- los totales y la dona de la franja de Talonarios. */
import { describe, it, expect } from "vitest";
import {
  arcosDeLaDona,
  resumirTalonarios,
} from "../client/src/components/combustible/resumenTalonarios";
import type { SerieTalonario } from "../client/src/components/combustible/valesFaltantesLogica";

const serie = (
  usados: number,
  faltan: number,
  explicados: number,
  litros = 0,
  galones = 0
): SerieTalonario => ({
  serie: "001",
  minimo: 1,
  maximo: usados + faltan,
  usados,
  faltan,
  explicados,
  sin_explicar: faltan - explicados,
  litros,
  galones,
  ultimo_vale: usados + faltan,
  ultima_fecha: "2026-11-11T22:00:00.000Z",
  tramos: [],
});

describe("resumirTalonarios", () => {
  it("suma las series y calcula lo que sigue sin explicar", () => {
    const r = resumirTalonarios([serie(6, 296, 96, 1404.2, 370.9), serie(1, 0, 0, 420.2, 111)]);
    expect(r).toMatchObject({
      usados: 7,
      faltan: 296,
      regularizados: 96,
      sinExplicar: 200,
      total: 303,
    });
    expect(r.litros).toBeCloseTo(1824.4, 5);
    expect(r.galones).toBeCloseTo(481.9, 5);
  });

  it("el porcentaje con respaldo cuenta usados y regularizados", () => {
    // 10 usados + 20 regularizados de 40 en total → 75 %.
    expect(resumirTalonarios([serie(10, 30, 20)]).conRespaldoPct).toBe(75);
  });

  it("sin vales no hay nada que explicar: 100 %", () => {
    expect(resumirTalonarios([]).conRespaldoPct).toBe(100);
    expect(resumirTalonarios([serie(5, 0, 0)]).conRespaldoPct).toBe(100);
  });
});

describe("arcosDeLaDona", () => {
  const C = 100;

  it("reparte la circunferencia en proporción y uno detrás de otro", () => {
    const arcos = arcosDeLaDona({ usados: 50, regularizados: 25, sinExplicar: 25, total: 100 }, C);
    expect(arcos.map((a) => [a.clave, a.largo, a.desfase])).toEqual([
      ["usados", 50, 0],
      ["regularizados", 25, 50],
      ["sinExplicar", 25, 75],
    ]);
  });

  it("no dibuja los tramos que valen cero", () => {
    const arcos = arcosDeLaDona({ usados: 10, regularizados: 0, sinExplicar: 10, total: 20 }, C);
    expect(arcos.map((a) => a.clave)).toEqual(["usados", "sinExplicar"]);
    expect(arcos[1].desfase).toBe(50);
  });

  it("sin vales no hay arcos", () => {
    expect(arcosDeLaDona({ usados: 0, regularizados: 0, sinExplicar: 0, total: 0 }, C)).toEqual([]);
  });

  it("los arcos llenan la circunferencia exacta", () => {
    const r = resumirTalonarios([serie(6, 296, 96)]);
    const total = arcosDeLaDona(r, 276.46).reduce((s, a) => s + a.largo, 0);
    expect(total).toBeCloseTo(276.46, 6);
  });
});
