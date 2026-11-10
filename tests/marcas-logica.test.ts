/** tests/marcas-logica.test.ts
 *
 * «Registrar llegada / salida» de la oficina (sin orden de registro): qué paradas se eligen, qué se
 * rechaza antes de mandar y el cuerpo de POST /viajes/:id/marcas. Lógica pura, sin pantalla.
 */
import { describe, it, expect } from "vitest";
import {
  cuerpoDeMarca,
  errorDeMarca,
  paradaInicial,
  paradasElegibles,
  type EntradaMarca,
} from "../client/src/components/combustible/marcasLogica";
import type { ParadaMia } from "../client/src/components/combustible/paradasViaje";
import { aValorLocal } from "../client/src/components/combustible/ponerAlDiaLogica";

const H = 3_600_000;
const AHORA = Date.parse("2026-11-10T12:00:00");
const iso = (h: number) => new Date(AHORA + h * H).toISOString();
const parada = (orden: number, ll: number | null, sa: number | null): ParadaMia => ({
  orden,
  lugar_id: orden === 2 ? 1 : orden + 1,
  lugar: ["A", "B", "A"][orden],
  llegada_en: ll === null ? null : iso(ll),
  llegada_medidor: null,
  salida_en: sa === null ? null : iso(sa),
  salida_medidor: null,
});
// A salió hace 30 h; B: llegó hace 16 h y salió hace 10 h; la llegada final falta.
const ruta = [parada(0, null, -30), parada(1, -16, -10), parada(2, null, null)];

const entrada = (c: Partial<EntradaMarca> = {}): EntradaMarca => ({
  que: "llegada",
  orden: 2,
  momento: "ahora",
  horaLocal: "",
  motivo: "",
  reemplazar: false,
  medidor: "",
  descanso: { activo: false, motivo: "Dormir", detalle: "", desde: "", hasta: "" },
  ...c,
});
const error = (c: Partial<EntradaMarca>, p = ruta, medidorInicio: unknown = null) =>
  errorDeMarca(entrada(c), p, medidorInicio, AHORA, "Odómetro");
const antes = (h: number) => aValorLocal(AHORA + h * H);

describe("paradas elegibles", () => {
  it("la llegada no existe en el origen ni la salida en la última", () => {
    expect(paradasElegibles(ruta, "llegada").map((x) => x.orden)).toEqual([1, 2]);
    expect(paradasElegibles(ruta, "salida").map((x) => x.orden)).toEqual([0, 1]);
  });
  it("de entrada se elige la primera sin marca", () => {
    expect(paradaInicial(ruta, "llegada")).toBe(2);
    expect(
      paradaInicial([parada(0, null, -3), parada(1, -1, null), parada(2, null, null)], "llegada")
    ).toBe(2);
  });
});

describe("errorDeMarca", () => {
  it("«Ahora» sin más se acepta (sin restricción de orden)", () => {
    expect(error({})).toBeNull();
    // Registrar la llegada final sin haber marcado la salida de B tampoco estorba.
    expect(
      error({}, [parada(0, null, -30), parada(1, null, null), parada(2, null, null)])
    ).toBeNull();
  });
  it("«Fue antes» pide hora y motivo, y la hora no puede ser futura", () => {
    expect(error({ momento: "antes" })).toMatch(/fecha y la hora/);
    expect(error({ momento: "antes", horaLocal: antes(-2) })).toMatch(/motivo/);
    expect(error({ momento: "antes", horaLocal: antes(-2), motivo: "Sin señal" })).toBeNull();
    expect(error({ momento: "antes", horaLocal: antes(2), motivo: "Sin señal" })).toMatch(/futura/);
  });
  it("la hora no se cruza con la marca anterior ni con la siguiente", () => {
    const m = "Sin señal";
    expect(error({ momento: "antes", horaLocal: antes(-12), motivo: m })).toMatch(/posterior/);
    expect(
      error({
        que: "llegada",
        orden: 1,
        reemplazar: true,
        momento: "antes",
        horaLocal: antes(-9),
        motivo: m,
      })
    ).toMatch(/anterior a la marca siguiente/);
  });
  it("una marca puesta pide «reemplazar» y su motivo", () => {
    const e = {
      que: "llegada" as const,
      orden: 1,
      momento: "antes" as const,
      horaLocal: antes(-17),
    };
    expect(error({ ...e, motivo: "Corrección" })).toMatch(/Reemplazar/);
    expect(error({ ...e, reemplazar: true })).toMatch(/motivo/);
    expect(error({ ...e, reemplazar: true, motivo: "Corrección" })).toBeNull();
  });
  it("la llegada final exige el odómetro si el viaje salió con él", () => {
    expect(error({}, ruta, 100)).toMatch(/Falta el odómetro/);
    expect(error({ medidor: "250" }, ruta, 100)).toBeNull();
    expect(error({ medidor: "abc" }, ruta, 100)).toMatch(/número válido/);
  });
  it("el descanso va antes de la marca y con su motivo", () => {
    const d = (c: Partial<EntradaMarca["descanso"]>) => ({
      activo: true,
      motivo: "Dormir",
      detalle: "",
      desde: antes(-5),
      hasta: antes(-3),
      ...c,
    });
    expect(error({ descanso: d({}) })).toBeNull();
    expect(error({ descanso: d({ hasta: antes(-6) }) })).toMatch(/después del inicio/);
    expect(error({ descanso: d({ desde: antes(-2), hasta: "" }) })).toBeNull();
    expect(
      error({ momento: "antes", horaLocal: antes(-4), motivo: "Sin señal", descanso: d({}) })
    ).toMatch(/anterior a la marca/);
    expect(error({ descanso: d({ motivo: "Otro", detalle: "" }) })).toMatch(/motivo del descanso/);
  });
});

describe("cuerpoDeMarca", () => {
  it("«Ahora» no manda hora: pone la del servidor", () => {
    const c = cuerpoDeMarca(entrada(), "u-1");
    expect(c).toEqual({ que: "llegada", orden: 2, cliente_uuid: "u-1" });
  });
  it("«Fue antes» manda la hora en ISO, el motivo, el medidor y el descanso", () => {
    const c = cuerpoDeMarca(
      entrada({
        momento: "antes",
        horaLocal: antes(-2),
        motivo: " Sin señal ",
        medidor: "250",
        reemplazar: true,
        descanso: {
          activo: true,
          motivo: "Comer",
          detalle: "",
          desde: antes(-5),
          hasta: antes(-4),
        },
      }),
      "u-2"
    );
    expect(c).toMatchObject({
      hora: iso(-2),
      motivo: "Sin señal",
      medidor: 250,
      reemplazar: true,
      descanso: { motivo: "Comer", desde: iso(-5), hasta: iso(-4) },
    });
  });
});
