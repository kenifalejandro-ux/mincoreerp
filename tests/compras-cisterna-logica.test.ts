/** tests/compras-cisterna-logica.test.ts
 *
 * La lógica pura de "Registrar compra" y de la lista de compras: qué se rellena solo al elegir el
 * proveedor, qué falta antes de enviar, el cuerpo que se manda y cómo se filtra. Con datos sueltos,
 * sin pantalla.
 */
import { describe, it, expect } from "vitest";
import {
  cuerpoDeLaCompra,
  diasParaLaLlegada,
  filtrarCompras,
  formularioInicial,
  hoyEnLima,
  problemasDeLaCompra,
  proveedoresDeCompras,
  sugerenciasPara,
  type FormularioDeCompra,
} from "../client/src/components/combustible/comprasCisternaLogica";
import type {
  CompraDeCisterna,
  DatosParaElFormulario,
} from "../client/src/components/combustible/comprasCisternaTipos";

let n = 0;
const compra = (extra: Partial<CompraDeCisterna> = {}): CompraDeCisterna => ({
  id: String(++n),
  grifo_interno_id: 1,
  grifo_id: 7,
  proveedor: "ULLOA",
  tipo_combustible: "diesel_b5",
  unidad: "gal",
  tipo_documento: "guia_remision",
  numero_documento: `TRR1-${n}`,
  fecha_compra: "2026-11-02",
  llegada_estimada: "2026-11-03",
  cantidad_facturada: "11100",
  costo_unitario: "24.5",
  transportista: null,
  transportista_ruc: null,
  creado_en: `2026-11-0${(n % 8) + 1}T12:00:00Z`,
  estado: "recibida",
  recepcion_id: null,
  motivo_anulacion: null,
  ...extra,
});

const datos = (extra: Partial<DatosParaElFormulario> = {}): DatosParaElFormulario => ({
  proveedores: [{ id: 7, nombre: "ULLOA" }],
  sedes: [
    { id: 1, nombre: "Principal", sede: "Huamachuco" },
    { id: 2, nombre: "Cancha Este", sede: "Huamachuco" },
  ],
  precios: [{ grifo_id: 7, tipo_combustible: "diesel_b5", precio_unitario: "24.8000" }],
  ...extra,
});

describe("hoyEnLima", () => {
  it("usa la fecha de Lima aunque la UTC ya esté en el día siguiente", () => {
    // 02:00 UTC del 5 de noviembre son las 21:00 del 4 en Lima.
    expect(hoyEnLima(Date.UTC(2026, 10, 5, 2, 0))).toBe("2026-11-04");
    expect(hoyEnLima(Date.UTC(2026, 10, 5, 12, 0))).toBe("2026-11-05");
  });
});

describe("sugerenciasPara", () => {
  it("trae la sede, la unidad y el transportista de la última compra, y el precio vigente", () => {
    const compras = [
      compra({
        grifo_interno_id: 2,
        transportista: "VIEJA S.A.",
        creado_en: "2026-10-01T00:00:00Z",
      }),
      compra({
        grifo_interno_id: 2,
        transportista: "CORPORACION KIME S.A.C.",
        transportista_ruc: "20602504655",
        creado_en: "2026-11-02T00:00:00Z",
      }),
    ];
    expect(sugerenciasPara(7, compras, datos())).toMatchObject({
      grifo_interno_id: "2",
      unidad: "gal",
      transportista: "CORPORACION KIME S.A.C.",
      transportista_ruc: "20602504655",
      tipo_combustible: "diesel_b5",
      costo_unitario: "24.8",
    });
  });

  it("una compra anulada no cuenta como la última", () => {
    const compras = [
      compra({ transportista: "BUENA S.A.", creado_en: "2026-10-01T00:00:00Z" }),
      compra({
        transportista: "ANULADA S.A.",
        estado: "anulada",
        creado_en: "2026-11-02T00:00:00Z",
      }),
    ];
    expect(sugerenciasPara(7, compras, datos()).transportista).toBe("BUENA S.A.");
  });

  it("proveedor sin compras anteriores: solo lo que se sabe (una sola sede se elige sola)", () => {
    const una = datos({ sedes: [{ id: 5, nombre: "Principal", sede: "Huamachuco" }] });
    const s = sugerenciasPara(7, [], una);
    expect(s.grifo_interno_id).toBe("5");
    expect(s.transportista).toBeUndefined();
    // Con varias sedes y sin historial no adivina la sede.
    expect(sugerenciasPara(7, [], datos()).grifo_interno_id).toBeUndefined();
  });

  it("sin precio cargado para ese proveedor y combustible, no inventa el costo", () => {
    expect(sugerenciasPara(7, [], datos({ precios: [] })).costo_unitario).toBeUndefined();
    // El precio de otro combustible o de otro proveedor no sirve.
    const otros = datos({
      precios: [
        { grifo_id: 7, tipo_combustible: "gasolina_90", precio_unitario: "20" },
        { grifo_id: 9, tipo_combustible: "diesel_b5", precio_unitario: "30" },
      ],
    });
    expect(sugerenciasPara(7, [], otros).costo_unitario).toBeUndefined();
  });

  it("al cambiar el combustible solo recalcula el precio y no toca el combustible elegido", () => {
    const d = datos({
      precios: [
        { grifo_id: 7, tipo_combustible: "diesel_b5", precio_unitario: "24.8" },
        { grifo_id: 7, tipo_combustible: "gasolina_90", precio_unitario: "19.5" },
      ],
    });
    const s = sugerenciasPara(7, [], d, "gasolina_90");
    expect(s.costo_unitario).toBe("19.5");
    expect(s.tipo_combustible).toBeUndefined();
  });
});

describe("problemasDeLaCompra", () => {
  const completo = (): FormularioDeCompra => ({
    ...formularioInicial(Date.UTC(2026, 10, 4, 15, 0)),
    grifo_id: "7",
    grifo_interno_id: "1",
    numero_documento: "TRR1-3638",
    cantidad_facturada: "11100",
    costo_unitario: "24.8",
  });

  it("un formulario completo no tiene problemas", () => {
    expect(problemasDeLaCompra(completo())).toEqual([]);
  });

  it("dice qué falta, en palabras", () => {
    const vacio = formularioInicial();
    const texto = problemasDeLaCompra(vacio).join(" | ");
    expect(texto).toMatch(/proveedor/i);
    expect(texto).toMatch(/sede/i);
    expect(texto).toMatch(/número del documento/i);
    expect(texto).toMatch(/cantidad/i);
    expect(texto).toMatch(/costo/i);
  });

  it("la llegada no puede ser antes de la emisión", () => {
    const f = { ...completo(), fecha_compra: "2026-11-04", llegada_estimada: "2026-11-02" };
    expect(problemasDeLaCompra(f).join(" ")).toMatch(/antes de la emisión/);
    expect(problemasDeLaCompra({ ...f, llegada_estimada: "2026-11-04" })).toEqual([]);
  });

  it("cantidad o costo en cero o negativos no pasan", () => {
    expect(problemasDeLaCompra({ ...completo(), cantidad_facturada: "0" })).not.toEqual([]);
    expect(problemasDeLaCompra({ ...completo(), cantidad_facturada: "-5" })).not.toEqual([]);
    expect(problemasDeLaCompra({ ...completo(), costo_unitario: "0" })).not.toEqual([]);
  });

  it("el RUC del transportista: 11 dígitos, y no sin su nombre", () => {
    const f = completo();
    expect(problemasDeLaCompra({ ...f, transportista_ruc: "123" }).join(" ")).toMatch(/11 dígitos/);
    expect(problemasDeLaCompra({ ...f, transportista_ruc: "20602504655" }).join(" ")).toMatch(
      /también su nombre/
    );
    expect(
      problemasDeLaCompra({ ...f, transportista: "KIME", transportista_ruc: "20602504655" })
    ).toEqual([]);
    // Sin RUC ni transportista no se pide nada: son opcionales.
    expect(problemasDeLaCompra({ ...f, transportista: "", transportista_ruc: "" })).toEqual([]);
  });
});

describe("cuerpoDeLaCompra", () => {
  it("manda números como números, recorta el texto y no manda lo vacío", () => {
    const f: FormularioDeCompra = {
      ...formularioInicial(Date.UTC(2026, 10, 4, 15, 0)),
      grifo_id: "7",
      grifo_interno_id: "2",
      numero_documento: "  TRR1-3638  ",
      cantidad_facturada: "11100",
      costo_unitario: "24.8",
      transportista: "  ",
      transportista_ruc: "",
    };
    const c = cuerpoDeLaCompra(f, "uuid-1");
    expect(c).toMatchObject({
      cliente_uuid: "uuid-1",
      grifo_id: 7,
      grifo_interno_id: 2,
      numero_documento: "TRR1-3638",
      cantidad_facturada: 11100,
      costo_unitario: 24.8,
      tipo_documento: "guia_remision",
      fecha_compra: "2026-11-04",
    });
    expect(c.transportista).toBeUndefined();
    expect(c.transportista_ruc).toBeUndefined();
  });
});

describe("filtrarCompras y proveedoresDeCompras", () => {
  const lista = [
    compra({ estado: "registrada", grifo_id: 7, proveedor: "ULLOA" }),
    compra({ estado: "por_llegar", grifo_id: 7, proveedor: "ULLOA" }),
    compra({ estado: "recibida", grifo_id: 8, proveedor: "PRIMAX" }),
    compra({ estado: "anulada", grifo_id: 8, proveedor: "PRIMAX" }),
  ];

  it("'por recibir' son las registradas y las por llegar; no las recibidas ni las anuladas", () => {
    expect(filtrarCompras(lista, "pendientes", "").map((c) => c.estado)).toEqual([
      "registrada",
      "por_llegar",
    ]);
    expect(filtrarCompras(lista, "recibidas", "")).toHaveLength(1);
    expect(filtrarCompras(lista, "anuladas", "")).toHaveLength(1);
    expect(filtrarCompras(lista, "todas", "")).toHaveLength(4);
  });

  it("filtra por proveedor y combina con el estado", () => {
    expect(filtrarCompras(lista, "todas", "8")).toHaveLength(2);
    expect(filtrarCompras(lista, "pendientes", "8")).toHaveLength(0);
  });

  it("los proveedores salen sin repetir y por nombre", () => {
    expect(proveedoresDeCompras(lista)).toEqual([
      { valor: "8", nombre: "PRIMAX" },
      { valor: "7", nombre: "ULLOA" },
    ]);
  });
});

describe("diasParaLaLlegada", () => {
  it("positivo faltan, cero hoy, negativo ya pasó", () => {
    expect(diasParaLaLlegada("2026-11-07", "2026-11-04")).toBe(3);
    expect(diasParaLaLlegada("2026-11-04", "2026-11-04")).toBe(0);
    expect(diasParaLaLlegada("2026-11-02", "2026-11-04")).toBe(-2);
  });
});
