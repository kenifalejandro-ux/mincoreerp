/** tests/proveedores-compras-formulario.test.ts
 *
 * Registrar compra (PR5b), lógica del formulario sin React: valores iniciales, sugerencias al elegir el
 * proveedor, validaciones y el cuerpo que se envía.
 */
import { describe, it, expect } from "vitest";

import {
  cuerpoDeLaCompra,
  formularioInicial,
  hoyEnLima,
  precioVigenteDe,
  problemasDeLaCompra,
  sugerenciasPara,
  type FormularioDeCompra,
} from "../client/src/components/proveedores/comprasFormulario";
import type {
  CompraDeCisterna,
  DatosFormularioCompra,
} from "../client/src/components/proveedores/proveedoresApi";

const datos = (extra: Partial<DatosFormularioCompra> = {}): DatosFormularioCompra => ({
  proveedores: [{ id: 5, nombre: "GRIFO" }],
  sedes: [{ id: 1, nombre: "Principal", sede: "Planta" }],
  precios: [{ grifo_id: 5, tipo_combustible: "diesel_b5", precio_unitario: "15.8000" }],
  ...extra,
});

const compra = (extra: Partial<CompraDeCisterna> = {}): CompraDeCisterna => ({
  id: 1,
  estado: "recibida",
  proveedorId: 5,
  proveedorCodigo: "PRV-005",
  proveedorNombre: "GRIFO",
  tipoCombustible: "gasolina_90",
  combustible: "Gasolina 90",
  unidad: "L",
  tipoDocumento: "factura",
  numeroDocumento: "F-1",
  fechaCompra: "2026-11-01",
  llegadaEstimada: "2026-11-03",
  sedeDeLlegada: "Planta · Tanque 1",
  cantidadFacturada: 1000,
  costoUnitario: 4,
  total: 4000,
  placa: null,
  chofer: null,
  transportista: "TRANSPORTES SUR",
  transportistaRuc: "20123456789",
  habilitada: true,
  motivoAnulacion: null,
  recepcion: null,
  ...extra,
});

const completo = (extra: Partial<FormularioDeCompra> = {}): FormularioDeCompra => ({
  ...formularioInicial(datos(), Date.parse("2026-11-20T15:00:00Z")),
  grifo_id: "5",
  numero_documento: "F-100",
  cantidad_facturada: "1000",
  costo_unitario: "15.5",
  ...extra,
});

describe("Registrar compra: valores iniciales y sugerencias", () => {
  it("hoy es hoy en Lima, no en UTC", () => {
    // 03:00 UTC del 21 aún es 22:00 del 20 en Lima.
    expect(hoyEnLima(Date.parse("2026-11-21T03:00:00Z"))).toBe("2026-11-20");
    expect(hoyEnLima(Date.parse("2026-11-21T06:00:00Z"))).toBe("2026-11-21");
  });

  it("nace con hoy en las dos fechas y la sede elegida si hay una sola", () => {
    const f = formularioInicial(datos(), Date.parse("2026-11-20T15:00:00Z"));
    expect(f).toMatchObject({
      fecha_compra: "2026-11-20",
      llegada_estimada: "2026-11-20",
      grifo_interno_id: "1",
      unidad: "gal",
      tipo_combustible: "diesel_b5",
    });
    const dos = formularioInicial(
      datos({
        sedes: [
          { id: 1, nombre: "A", sede: "S" },
          { id: 2, nombre: "B", sede: "S" },
        ],
      })
    );
    expect(dos.grifo_interno_id).toBe("");
  });

  it("al elegir el proveedor trae el precio vigente y, si ya compró, su unidad y su transportista", () => {
    expect(sugerenciasPara(5, [], datos())).toEqual({
      tipo_combustible: "diesel_b5",
      costo_unitario: "15.8",
    });
    expect(sugerenciasPara(5, [compra()], datos())).toMatchObject({
      tipo_combustible: "gasolina_90",
      unidad: "L",
      transportista: "TRANSPORTES SUR",
      transportista_ruc: "20123456789",
    });
    // Sin precio para ese combustible: no se inventa el costo.
    expect(sugerenciasPara(5, [compra()], datos()).costo_unitario).toBeUndefined();
  });

  it("una compra anulada no sirve de ejemplo, y cambiar el combustible no pisa el combustible elegido", () => {
    expect(
      sugerenciasPara(5, [compra({ estado: "anulada" })], datos()).transportista
    ).toBeUndefined();
    const s = sugerenciasPara(5, [compra()], datos(), "diesel_b5");
    expect(s.tipo_combustible).toBeUndefined();
    expect(s.costo_unitario).toBe("15.8");
    expect(precioVigenteDe(5, "diesel_b5", datos())).toBe(15.8);
    expect(precioVigenteDe(5, "glp", datos())).toBeNull();
  });
});

describe("Registrar compra: lo que falta y lo que se envía", () => {
  it("un formulario completo no tiene problemas", () => {
    expect(problemasDeLaCompra(completo())).toEqual([]);
  });

  it("dice en palabras lo que falta", () => {
    const vacio = formularioInicial(datos(), Date.parse("2026-11-20T15:00:00Z"));
    expect(problemasDeLaCompra(vacio)).toEqual([
      "Elige el proveedor.",
      "Escribe el número del documento.",
      "La cantidad tiene que ser mayor que cero.",
      "Falta el costo por unidad.",
    ]);
    expect(problemasDeLaCompra(completo({ llegada_estimada: "2026-11-01" }))).toContain(
      "La llegada no puede ser antes de la emisión."
    );
    expect(problemasDeLaCompra(completo({ transportista_ruc: "123" }))).toContain(
      "El RUC del transportista tiene 11 dígitos."
    );
    expect(
      problemasDeLaCompra(completo({ transportista_ruc: "20123456789", transportista: " " }))
    ).toContain("Si pones el RUC del transportista, pon también su nombre.");
  });

  it("el cuerpo lleva números como números, recorta textos y no manda los vacíos", () => {
    const cuerpo = cuerpoDeLaCompra(
      completo({ numero_documento: "  F-100  ", transportista: "  ", transportista_ruc: "" }),
      "uuid-1"
    );
    expect(cuerpo).toEqual({
      cliente_uuid: "uuid-1",
      grifo_interno_id: 1,
      grifo_id: 5,
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_documento: "guia_remision",
      numero_documento: "F-100",
      fecha_compra: "2026-11-20",
      llegada_estimada: "2026-11-20",
      cantidad_facturada: 1000,
      costo_unitario: 15.5,
      transportista: undefined,
      transportista_ruc: undefined,
    });
  });
});
