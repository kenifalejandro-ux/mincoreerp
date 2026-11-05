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
  detalleDelMovimiento,
  diferenciaConElDocumento,
  lineasDeOrigen,
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

// El mismo formato de números que usa la pantalla (la configuración regional de quien corre la
// prueba no tiene por qué ser la misma).
const fmt = (n: number) => n.toLocaleString("es-PE", { maximumFractionDigits: 4 });

describe("lineasDeOrigen", () => {
  it("documento, costo y transporte con su RUC; solo las que se saben", () => {
    const c = cisterna({
      tipo_documento: "guia_remision",
      numero_documento: "TRR1-00003638",
      costo_unitario: "24.5",
      transportista: "CORPORACION KIME S.A.C.",
      transportista_ruc: "20602504655",
    });
    expect(lineasDeOrigen(c)).toEqual([
      { etiqueta: "Guía de remisión", valor: "TRR1-00003638" },
      { etiqueta: "Costo por gal", valor: fmt(24.5) },
      { etiqueta: "Transporte", valor: "CORPORACION KIME S.A.C. · RUC 20602504655" },
    ]);
  });

  it("una cisterna de antes de las compras no trae documento ni transporte: esas líneas no salen", () => {
    expect(lineasDeOrigen(cisterna({ costo_unitario: "16.5" }))).toEqual([
      { etiqueta: "Costo por gal", valor: fmt(16.5) },
    ]);
    expect(lineasDeOrigen(cisterna({ costo_unitario: "0" }))).toEqual([]);
  });

  it("un transportista sin RUC sale solo con su nombre; una factura se nombra factura", () => {
    const c = cisterna({
      tipo_documento: "factura",
      numero_documento: "F001-77",
      costo_unitario: "0",
      transportista: "TRANSPORTES X",
    });
    expect(lineasDeOrigen(c)).toEqual([
      { etiqueta: "Factura", valor: "F001-77" },
      { etiqueta: "Transporte", valor: "TRANSPORTES X" },
    ]);
  });
});

describe("diferenciaConElDocumento", () => {
  const conDiferencia = (dif: string, tolerancia: number | string | null = 3) =>
    cisterna({
      entregado: "995",
      compra_cantidad: "1000",
      compra_unidad: "gal",
      diferencia_compra_galones: dif,
      tolerancia_galones: tolerancia,
    });

  it("dice lo que decía el documento, lo descargado y la diferencia con su signo", () => {
    const d = diferenciaConElDocumento(conDiferencia("-5"))!;
    expect(d.texto).toBe(`Documento ${fmt(1000)} gal · Descargado 995 gal · −5 gal`);
    const mas = diferenciaConElDocumento(conDiferencia("2"))!;
    expect(mas.texto).toContain("+2 gal");
    expect(diferenciaConElDocumento(conDiferencia("0"))!.texto).toContain("sin diferencia");
  });

  it("solo está 'fuera' pasada la tolerancia de la empresa; en el límite, no", () => {
    expect(diferenciaConElDocumento(conDiferencia("-5"))!.fuera).toBe(true);
    expect(diferenciaConElDocumento(conDiferencia("-3"))!.fuera).toBe(false);
    expect(diferenciaConElDocumento(conDiferencia("-5", 10))!.fuera).toBe(false);
    expect(diferenciaConElDocumento(conDiferencia("4", "3"))!.fuera).toBe(true);
    // Sin tolerancia en los datos (caché vieja), vale la de siempre: 3.
    expect(diferenciaConElDocumento(conDiferencia("-5", null))!.fuera).toBe(true);
  });

  it("sin compra no hay documento contra qué comparar", () => {
    expect(diferenciaConElDocumento(cisterna())).toBeNull();
    expect(
      diferenciaConElDocumento(cisterna({ diferencia_compra_galones: null, compra_cantidad: null }))
    ).toBeNull();
  });
});

describe("detalleDelMovimiento", () => {
  const fila = (extra: Record<string, unknown> = {}) => ({
    tipo: "unidad" as const,
    cantidad: "10",
    fecha: "2026-11-04T19:32:00Z",
    destino: "VQ-9",
    saldo: 0,
    ...extra,
  });

  it("la hora, quién lo registró y su vale, en ese orden", () => {
    const d = detalleDelMovimiento(fila({ por: "Noemi", vale: "CLS-77" }));
    expect(d).toMatch(/^\d{1,2}:\d{2}.* · Noemi · vale CLS-77$/);
  });

  it("lo que no se sabe no sale: sin vale, sin persona, o con una fecha ilegible", () => {
    expect(detalleDelMovimiento(fila({ por: "Noemi" }))).toMatch(/^\d{1,2}:\d{2}.* · Noemi$/);
    expect(detalleDelMovimiento(fila())).toMatch(/^\d{1,2}:\d{2}[^·]*$/);
    expect(detalleDelMovimiento(fila({ fecha: "no es fecha", por: "Noemi" }))).toBe("Noemi");
  });
});
