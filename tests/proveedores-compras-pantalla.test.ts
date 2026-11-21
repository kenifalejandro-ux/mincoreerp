/** tests/proveedores-compras-pantalla.test.ts
 *
 * Compras y recepciones (PR5), lógica de la pantalla sin React: totales, textos de la diferencia, fechas y
 * quién ve la entrada del menú.
 */
import { describe, it, expect } from "vitest";

import {
  formatoDia,
  formatoSoles,
  lecturaDeDiferencia,
  totalesCompras,
} from "../client/src/components/proveedores/comprasProveedores";
import { puedeVerComprasDeProveedores } from "../client/src/components/proveedores/proveedoresAcceso";
import type {
  CompraDeCisterna,
  RecepcionDeCompra,
} from "../client/src/components/proveedores/proveedoresApi";

const recepcion = (extra: Partial<RecepcionDeCompra> = {}): RecepcionDeCompra => ({
  id: 1,
  recibidoEn: "2026-11-12T15:00:00Z",
  descargado: 1000,
  unidad: "gal",
  diferenciaGalones: 0,
  fueraDeTolerancia: false,
  ...extra,
});

const compra = (extra: Partial<CompraDeCisterna> = {}): CompraDeCisterna => ({
  id: 1,
  estado: "registrada",
  proveedorId: 1,
  proveedorCodigo: "PRV-001",
  proveedorNombre: "P",
  combustible: "Diésel B5",
  unidad: "gal",
  tipoDocumento: "factura",
  numeroDocumento: "F-1",
  fechaCompra: "2026-11-10",
  llegadaEstimada: "2026-11-12",
  cantidadFacturada: 1000,
  costoUnitario: 15.8,
  total: 15800,
  placa: null,
  chofer: null,
  transportista: null,
  habilitada: false,
  motivoAnulacion: null,
  recepcion: null,
  ...extra,
});

describe("Compras y recepciones: lo que muestra la pantalla", () => {
  it("cuenta por llegar, recibidas, con diferencia fuera de tolerancia y anuladas", () => {
    expect(
      totalesCompras([
        compra({ estado: "registrada" }),
        compra({ estado: "por_llegar" }),
        compra({ estado: "por_llegar" }),
        compra({ estado: "recibida", recepcion: recepcion() }),
        compra({
          estado: "recibida",
          recepcion: recepcion({ diferenciaGalones: -50, fueraDeTolerancia: true }),
        }),
        compra({
          estado: "recibida",
          recepcion: recepcion({ diferenciaGalones: -2, fueraDeTolerancia: false }),
        }),
        compra({ estado: "anulada" }),
      ])
    ).toEqual({ porLlegar: 2, recibidas: 3, conDiferencia: 1, anuladas: 1 });
  });

  it("la diferencia se lee: sin diferencia, dentro de tolerancia o fuera", () => {
    expect(lecturaDeDiferencia(recepcion())).toEqual({ texto: "Sin diferencia", tono: "neutra" });
    expect(lecturaDeDiferencia(recepcion({ diferenciaGalones: -2.5 }))).toEqual({
      texto: "−2.5 gal · dentro de tolerancia",
      tono: "aviso",
    });
    expect(
      lecturaDeDiferencia(recepcion({ diferenciaGalones: -50, fueraDeTolerancia: true }))
    ).toEqual({ texto: "−50 gal · fuera de tolerancia", tono: "alerta" });
    expect(
      lecturaDeDiferencia(recepcion({ diferenciaGalones: 10, fueraDeTolerancia: true })).texto
    ).toBe("+10 gal · fuera de tolerancia");
  });

  it("las fechas de compra no se corren por zona horaria y el dinero va en soles", () => {
    expect(formatoDia("2026-11-12")).toBe("12/11/2026");
    expect(formatoSoles(15800)).toBe("S/ 15,800.00");
  });
});

describe("Compras y recepciones: quién ve la entrada del menú", () => {
  const u = (
    rol: string,
    permisosPestanas?: Record<string, boolean>,
    modulos = ["proveedores"]
  ) => ({
    rol,
    modulosPermitidos: modulos,
    permisosPestanas,
  });
  it("admin, operador y Lectura sí (como Cisternas); hace falta el módulo de Proveedores", () => {
    for (const rol of ["admin", "operador", "lectura"]) {
      expect(puedeVerComprasDeProveedores(u(rol))).toBe(true);
    }
    expect(puedeVerComprasDeProveedores(u("admin", undefined, ["combustible"]))).toBe(false);
    expect(puedeVerComprasDeProveedores(null)).toBe(false);
  });
  it("un permiso guardado manda sobre el perfil", () => {
    expect(puedeVerComprasDeProveedores(u("operador", { "combustible:cisternas": false }))).toBe(
      false
    );
    expect(
      puedeVerComprasDeProveedores(u("conductor_ruta", { "combustible:cisternas": true }))
    ).toBe(true);
  });
});
