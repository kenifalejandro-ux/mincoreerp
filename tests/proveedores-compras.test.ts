/** tests/proveedores-compras.test.ts
 *
 * Compras y recepciones (PR5): cómo se arma cada compra para la pantalla, sin base de datos. El estado
 * y la diferencia son los de Combustible (0171/0173): lo descargado es lo que entró al tanque más lo
 * repartido, y se compara contra el documento en galones, con la tolerancia de la empresa.
 */
import { describe, it, expect } from "vitest";

import {
  armarCompras,
  type CompraDb,
  type RecepcionDb,
} from "../src/modules/proveedores/proveedores.compras";

const compra = (extra: Partial<CompraDb> = {}): CompraDb => ({
  id: "7",
  grifo_id: 5,
  proveedor: "GRIFO UNO",
  tipo_combustible: "diesel_b5",
  unidad: "gal",
  tipo_documento: "guia_remision",
  numero_documento: "T001-77",
  fecha_compra: "2026-11-10",
  llegada_estimada: "2026-11-12",
  cantidad_facturada: "1000.00",
  costo_unitario: "15.8000",
  placa: "ABC123",
  chofer: null,
  transportista: null,
  habilitada_en: null,
  anulada_en: null,
  motivo_anulacion: null,
  recepcion_id: null,
  estado: "registrada",
  ...extra,
});

const recepcion = (extra: Partial<RecepcionDb> = {}): RecepcionDb => ({
  id: "20",
  cantidad: "1000.00",
  cantidad_derivada: "0.00",
  recibido_en: "2026-11-12T15:00:00Z",
  unidad: "gal",
  ...extra,
});

const una = (c: CompraDb, r?: RecepcionDb, tolerancia = 3) =>
  armarCompras([c], new Map(r ? [[Number(r.id), r]] : []), tolerancia)[0];

describe("Compras de combustible: lo que muestra cada compra", () => {
  it("sin recepción: total = cantidad × costo, código del proveedor y estado tal cual", () => {
    const c = una(compra({ habilitada_en: "2026-11-11T10:00:00Z", estado: "por_llegar" }));
    expect(c).toMatchObject({
      id: 7,
      estado: "por_llegar",
      proveedorId: 5,
      proveedorCodigo: "PRV-005",
      combustible: "Diésel B5",
      cantidadFacturada: 1000,
      costoUnitario: 15.8,
      total: 15800,
      habilitada: true,
      recepcion: null,
    });
  });

  it("lo descargado es lo del tanque más lo repartido; sin diferencia queda dentro de tolerancia", () => {
    const c = una(
      compra({ cantidad_facturada: "11100.00", recepcion_id: 20, estado: "recibida" }),
      recepcion({ cantidad: "10000.00", cantidad_derivada: "1100.00" })
    );
    expect(c.recepcion).toMatchObject({
      id: 20,
      descargado: 11100,
      unidad: "gal",
      diferenciaGalones: 0,
      fueraDeTolerancia: false,
    });
  });

  it("llegó menos: la diferencia es negativa y se marca solo pasada la tolerancia (3 gal exactos no)", () => {
    const base = compra({ recepcion_id: 20, estado: "recibida" });
    expect(una(base, recepcion({ cantidad: "997.00" })).recepcion).toMatchObject({
      diferenciaGalones: -3,
      fueraDeTolerancia: false,
    });
    expect(una(base, recepcion({ cantidad: "996.00" })).recepcion).toMatchObject({
      diferenciaGalones: -4,
      fueraDeTolerancia: true,
    });
    // Con otra tolerancia de la empresa.
    expect(una(base, recepcion({ cantidad: "996.00" }), 5).recepcion?.fueraDeTolerancia).toBe(
      false
    );
  });

  it("el documento y el tanque pueden estar en unidades distintas: se compara en galones", () => {
    // 3785.41 L ≈ 1000 gal; el tanque en galones recibió 998.
    const c = una(
      compra({ unidad: "L", cantidad_facturada: "3785.41", recepcion_id: 20, estado: "recibida" }),
      recepcion({ cantidad: "998.00", unidad: "gal" })
    );
    expect(c.recepcion?.diferenciaGalones).toBeCloseTo(-2, 1);
    expect(c.recepcion?.fueraDeTolerancia).toBe(false);
  });

  it("una compra anulada trae su motivo y ninguna recepción", () => {
    const c = una(
      compra({
        anulada_en: "2026-11-11T00:00:00Z",
        motivo_anulacion: "factura duplicada",
        estado: "anulada",
      })
    );
    expect(c).toMatchObject({
      estado: "anulada",
      motivoAnulacion: "factura duplicada",
      recepcion: null,
    });
  });

  it("si la recepción no viene en el mapa, la compra queda sin recepción (no revienta)", () => {
    expect(una(compra({ recepcion_id: 99, estado: "recibida" })).recepcion).toBeNull();
  });
});

describe("Compras de combustible: la sede de llegada", () => {
  it("sale de la etiqueta de su sede por id; sin dato o sin mapa, null", () => {
    const sedes = new Map([[3, "Huamachuco · TQ-huamachuco"]]);
    const con = armarCompras([compra({ grifo_interno_id: 3 })], new Map(), 3, sedes)[0];
    expect(con.sedeDeLlegada).toBe("Huamachuco · TQ-huamachuco");
    // El id llega como texto desde la base: igual se encuentra.
    expect(
      armarCompras([compra({ grifo_interno_id: "3" })], new Map(), 3, sedes)[0].sedeDeLlegada
    ).toBe("Huamachuco · TQ-huamachuco");
    // Una sede que no está en el mapa, o una compra sin sede, no se inventa.
    expect(
      armarCompras([compra({ grifo_interno_id: 9 })], new Map(), 3, sedes)[0].sedeDeLlegada
    ).toBeNull();
    expect(armarCompras([compra()], new Map(), 3, sedes)[0].sedeDeLlegada).toBeNull();
    expect(una(compra({ grifo_interno_id: 3 })).sedeDeLlegada).toBeNull();
  });
});
