/** tests/viajes-exportar-excel.test.ts
 *
 * Las filas del Excel de la lista de viajes (client/src/components/combustible/exportarViajes.ts):
 * lo que se ve en pantalla, con el semáforo y el desfase de salida escritos. Sin base.
 */
import { describe, it, expect } from "vitest";
import { filasDeViajes } from "../client/src/components/combustible/exportarViajes";
import type { FilaViaje } from "../client/src/components/combustible/viajesFormato";

const viaje = (extra: Partial<FilaViaje>) =>
  ({
    numero: 7,
    origen: "Chota",
    destino: "Cutervo",
    paradas: null,
    placa_codigo: "ABC-123",
    codigo_interno: null,
    conductor_nombre: "Ana Pérez",
    relevo_nombre: null,
    salida_programada_en: null,
    inicio_en: null,
    fin_en: null,
    desfase_salida_min: null,
    desfase_tolerancia_min: 10,
    estado: "programado",
    cargas: 2,
    cantidad: "12.345",
    ...extra,
  }) as FilaViaje;

describe("filas del Excel de viajes", () => {
  it("una fila por viaje con lo que muestra la lista", () => {
    const [f] = filasDeViajes([viaje({})], () => "Programado");
    expect(f).toMatchObject({
      Viaje: "V-7",
      Ruta: "Chota → Cutervo",
      Unidad: expect.stringContaining("ABC-123"),
      Conductor: "Ana Pérez",
      Relevo: "",
      Estado: "Programado",
      Semáforo: "",
      "Motivos del semáforo": "",
      Cargas: 2,
      "Combustible (gal)": 12.35,
    });
  });

  it("el estado sale del texto que se le pasa, y un viaje sin datos no rompe", () => {
    const filas = filasDeViajes(
      [viaje({ estado: "en_curso", conductor_nombre: null })],
      () => "En avería"
    );
    expect(filas[0].Estado).toBe("En avería");
    expect(filas[0].Conductor).toBe("");
  });

  it("un nombre que empieza con = + - @ no se abre como fórmula", () => {
    const [f] = filasDeViajes([viaje({ conductor_nombre: '=HYPERLINK("x")' })], () => "");
    expect(f.Conductor).toBe('\'=HYPERLINK("x")');
  });

  it("sin viajes no hay filas", () => {
    expect(filasDeViajes([], () => "")).toEqual([]);
  });
});
