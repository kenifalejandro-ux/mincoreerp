/** tests/recepciones-cisterna-logica.test.ts
 *
 * La lógica de la vista "Recepciones" de Cisternas: en qué estado está cada recepción, cuánto se
 * descargó en total y cómo se dice la diferencia contra el documento. Con datos sueltos, sin pantalla.
 */
import { describe, it, expect } from "vitest";
import {
  diferenciaDeLaRecepcion,
  estadoDeRecepcion,
  filtrarRecepciones,
  finDelDiaLima,
  inicioDelDiaLima,
  totalEntregadoDeLaRecepcion,
  type RecepcionDeLista,
} from "../client/src/components/combustible/recepcionesCisternaLogica";

let n = 0;
const recepcion = (extra: Partial<RecepcionDeLista> = {}): RecepcionDeLista => ({
  id: String(++n),
  producto: "combustible",
  cantidad: "100",
  cantidad_derivada: "0",
  recibido_en: "2026-11-04T12:00:00Z",
  tipo_documento: "guia_remision",
  numero_documento: "TRR1-1",
  tanque_nombre: "Tanque",
  tanque_unidad: "gal",
  grifo_nombre: "ULLOA",
  anulada_en: null,
  motivo_anulacion: null,
  anulada_por_nombre: null,
  registrada_por_nombre: "Noemi",
  requiere_validacion: false,
  validada_en: null,
  compra_id: null,
  compra_documento: null,
  compra_cantidad: null,
  compra_unidad: null,
  diferencia_compra_galones: null,
  ...extra,
});

describe("estadoDeRecepcion", () => {
  it("anulada manda sobre todo, aunque se hubiera validado", () => {
    expect(
      estadoDeRecepcion(
        recepcion({ anulada_en: "2026-11-05T00:00:00Z", validada_en: "2026-11-04T13:00:00Z" })
      )
    ).toBe("anulada");
  });
  it("validada, por validar y registrada", () => {
    expect(estadoDeRecepcion(recepcion({ validada_en: "2026-11-04T13:00:00Z" }))).toBe("validada");
    expect(estadoDeRecepcion(recepcion({ requiere_validacion: true }))).toBe("por_validar");
    expect(estadoDeRecepcion(recepcion())).toBe("registrada");
  });
  it("una que ya se validó deja de estar por validar", () => {
    expect(
      estadoDeRecepcion(
        recepcion({ requiere_validacion: true, validada_en: "2026-11-04T13:00:00Z" })
      )
    ).toBe("validada");
  });
});

describe("totalEntregadoDeLaRecepcion", () => {
  it("lo que entró al tanque más lo que se derivó", () => {
    expect(
      totalEntregadoDeLaRecepcion(recepcion({ cantidad: "100", cantidad_derivada: "895" }))
    ).toBe(995);
    expect(totalEntregadoDeLaRecepcion(recepcion())).toBe(100);
  });
});

describe("diferenciaDeLaRecepcion", () => {
  const con = (dif: string | null, tolerancia?: number | string | null) =>
    recepcion({ diferencia_compra_galones: dif, tolerancia_galones: tolerancia });

  it("sin compra no hay documento contra qué comparar", () => {
    expect(diferenciaDeLaRecepcion(con(null))).toBeNull();
  });
  it("dice la diferencia con su signo, o 'sin diferencia'", () => {
    expect(diferenciaDeLaRecepcion(con("-10"))!.texto).toBe("−10 gal");
    expect(diferenciaDeLaRecepcion(con("2.5"))!.texto).toBe(
      `+${(2.5).toLocaleString("es-PE")} gal`
    );
    expect(diferenciaDeLaRecepcion(con("0"))).toEqual({ texto: "Sin diferencia", fuera: false });
  });
  it("solo está 'fuera' pasada la tolerancia de la empresa; en el límite, no", () => {
    expect(diferenciaDeLaRecepcion(con("-10", 3))!.fuera).toBe(true);
    expect(diferenciaDeLaRecepcion(con("-3", 3))!.fuera).toBe(false);
    expect(diferenciaDeLaRecepcion(con("-10", 20))!.fuera).toBe(false);
    expect(diferenciaDeLaRecepcion(con("4", "3"))!.fuera).toBe(true);
    // Sin tolerancia en los datos, vale la de siempre: 3.
    expect(diferenciaDeLaRecepcion(con("-5", null))!.fuera).toBe(true);
    expect(diferenciaDeLaRecepcion(con("-2", undefined))!.fuera).toBe(false);
  });
});

describe("filtrarRecepciones", () => {
  const lista = [
    recepcion(),
    recepcion({ requiere_validacion: true }),
    recepcion({ validada_en: "2026-11-04T13:00:00Z" }),
    recepcion({ anulada_en: "2026-11-05T00:00:00Z" }),
  ];
  it("'todas' no filtra, y cada estado deja solo las suyas (las anuladas se ven)", () => {
    expect(filtrarRecepciones(lista, "todas")).toHaveLength(4);
    expect(filtrarRecepciones(lista, "anulada")).toHaveLength(1);
    expect(filtrarRecepciones(lista, "por_validar")).toHaveLength(1);
    expect(filtrarRecepciones(lista, "validada")).toHaveLength(1);
    expect(filtrarRecepciones(lista, "registrada")).toHaveLength(1);
  });
});

describe("el período se lee en hora de Lima, no en la del navegador", () => {
  it("el día de Lima va de las 05:00 UTC a las 04:59 UTC del siguiente", () => {
    expect(inicioDelDiaLima("2026-11-05")).toBe("2026-11-05T05:00:00.000Z");
    expect(finDelDiaLima("2026-11-05")).toBe("2026-11-06T04:59:59.999Z");
  });

  it("lo recibido la noche del 5 en Lima (01:42 UTC del 6) cabe en el 'hasta' del 5", () => {
    const recibido = Date.parse("2026-11-06T01:42:35.207Z");
    expect(recibido).toBeLessThanOrEqual(Date.parse(finDelDiaLima("2026-11-05")));
    expect(recibido).toBeGreaterThanOrEqual(Date.parse(inicioDelDiaLima("2026-11-05")));
  });
});
