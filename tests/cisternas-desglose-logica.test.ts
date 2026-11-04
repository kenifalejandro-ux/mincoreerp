/** tests/cisternas-desglose-logica.test.ts
 *
 * La lógica pura de la tarjeta de la cisterna: los renglones de "adónde fue lo que llegó", el total
 * entregado y el nombre de cada fila del kardex. Con datos sueltos, sin pantalla.
 */
import { describe, it, expect } from "vitest";
import type {
  CisternaDeLista,
  LineaDeReparto,
} from "../client/src/components/combustible/cisternasTipos";
import {
  renglonesDelDesglose,
  textoDelMovimiento,
  totalEntregado,
} from "../client/src/components/combustible/desgloseCisterna";

const linea = (
  id: number,
  destino: LineaDeReparto["destino"],
  cantidad: number,
  nombre: string | null = null
) =>
  ({
    id: String(id),
    destino,
    cantidad: String(cantidad),
    destino_nombre: nombre,
  }) as LineaDeReparto;

const cisterna = (extra: Partial<CisternaDeLista> = {}): CisternaDeLista => ({
  id: "1",
  cantidad: "400",
  saldo: "400",
  recepcion_id: "10",
  recibido_en: "2026-11-04T12:00:00Z",
  costo_unitario: "16.5",
  tanque_codigo: "TQ-02",
  tipo_combustible: "diesel_b5",
  unidad: "gal",
  grifo_interno_id: 1,
  proveedor: "ULLOA",
  estado: "con_saldo",
  proveedor_id: 7,
  salidas: [],
  ...extra,
});

describe("renglonesDelDesglose", () => {
  it("primero lo que entró al tanque y después el sobrante, en orden de destino", () => {
    const c = cisterna({
      al_tanque: "500",
      reparto: [
        linea(3, "cisterna", 400),
        linea(2, "devolucion", 100),
        linea(1, "cubeta", 200, "TQT-001"),
      ],
    });
    expect(renglonesDelDesglose(c).map((r) => [r.texto, r.cantidad])).toEqual([
      ["Al tanque TQ-02", 500],
      ["A la tanqueta TQT-001", 200],
      ["Devuelto al proveedor", 100],
      ["Quedó en la cisterna", 400],
    ]);
  });

  it("solo lo que quedó en la cisterna se marca como tal", () => {
    const c = cisterna({
      al_tanque: "0",
      reparto: [linea(1, "equipo", 50, "VQ-9"), linea(2, "cisterna", 400)],
    });
    const filas = renglonesDelDesglose(c);
    expect(filas.map((r) => [r.texto, !!r.enCisterna])).toEqual([
      ["Directo a la unidad VQ-9", false],
      ["Quedó en la cisterna", true],
    ]);
  });

  it("sin nombre de destino (sin Flota, tanqueta sin código) el renglón sigue diciendo adónde", () => {
    const c = cisterna({
      al_tanque: "100",
      reparto: [linea(1, "cubeta", 10), linea(2, "equipo", 20)],
    });
    expect(renglonesDelDesglose(c).map((r) => r.texto)).toEqual([
      "Al tanque TQ-02",
      "A una tanqueta",
      "Directo a una unidad",
    ]);
  });

  it("si nada entró al tanque, no hay renglón de tanque", () => {
    const c = cisterna({ al_tanque: "0", reparto: [linea(1, "cisterna", 400)] });
    expect(renglonesDelDesglose(c).map((r) => r.clave)).toEqual(["1"]);
  });

  it("datos viejos de la caché sin señal (sin desglose): no hay renglones, no falla", () => {
    expect(renglonesDelDesglose(cisterna())).toEqual([]);
  });
});

describe("totalEntregado", () => {
  it("es lo que dejó el proveedor; sin dato, lo que se sabe de la cisterna", () => {
    expect(totalEntregado(cisterna({ entregado: "1200" }))).toBe(1200);
    expect(totalEntregado(cisterna())).toBe(400);
  });
});

describe("textoDelMovimiento", () => {
  const fila = (
    tipo: Parameters<typeof textoDelMovimiento>[0]["tipo"],
    destino: string | null
  ) => ({
    tipo,
    cantidad: "10",
    fecha: "2026-11-04T12:00:00Z",
    destino,
    saldo: 0,
  });
  it("nombra la entrada y cada salida con su destino", () => {
    expect(textoDelMovimiento(fila("entrada", null))).toBe("Quedó al recibir");
    expect(textoDelMovimiento(fila("tanqueta", "TQT-001"))).toBe("A la tanqueta TQT-001");
    expect(textoDelMovimiento(fila("unidad", "VQ-9"))).toBe("A la unidad VQ-9");
    expect(textoDelMovimiento(fila("tanque", "TQ-02"))).toBe("Pase al tanque TQ-02");
  });
  it("una salida sin destino (sin Flota, sin placa) sigue diciendo qué fue", () => {
    expect(textoDelMovimiento(fila("unidad", null))).toBe("A la unidad");
  });
});
