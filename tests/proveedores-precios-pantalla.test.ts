/** tests/proveedores-precios-pantalla.test.ts
 *
 * Gestión comercial (PR4), lógica de la pantalla sin React: variación, antigüedad, mejor precio, totales y
 * quién ve la entrada del menú.
 */
import { describe, it, expect } from "vitest";

import {
  clavesConMejorPrecio,
  diasDesde,
  formatoPrecio,
  textoAntiguedad,
  totales,
  variacionPct,
} from "../client/src/components/proveedores/preciosProveedores";
import type {
  EntradaPrecio,
  FilaPrecio,
} from "../client/src/components/proveedores/proveedoresApi";
import { puedeVerPreciosDeProveedores } from "../client/src/components/proveedores/proveedoresAcceso";

const entrada = (precio: number, desde = "2026-11-10T00:00:00Z"): EntradaPrecio => ({
  id: precio,
  precio,
  desde,
  por: null,
  marca: null,
  anulado: false,
  motivo: null,
});

const fila = (clave: string, extra: Partial<FilaPrecio> = {}): FilaPrecio => ({
  clave,
  proveedorId: 1,
  proveedorCodigo: "PRV-001",
  proveedorNombre: "P",
  proveedorActivo: true,
  producto: "combustible",
  codigo: "diesel_b5",
  detalle: "Diésel B5",
  unidad: "galón",
  vigente: null,
  anterior: null,
  programado: null,
  historial: [],
  ...extra,
});

describe("Gestión comercial: lo que muestra la pantalla", () => {
  it("la variación es contra el anterior; sin anterior no hay variación", () => {
    expect(variacionPct(fila("a", { vigente: entrada(12), anterior: entrada(10) }))).toBeCloseTo(
      20
    );
    expect(variacionPct(fila("a", { vigente: entrada(9), anterior: entrada(10) }))).toBeCloseTo(
      -10
    );
    expect(variacionPct(fila("a", { vigente: entrada(9) }))).toBeNull();
    expect(variacionPct(fila("a"))).toBeNull();
  });

  it("la antigüedad se cuenta en días completos y se escribe en español", () => {
    const ahora = new Date("2026-11-20T12:00:00Z").getTime();
    expect(diasDesde("2026-11-20T08:00:00Z", ahora)).toBe(0);
    expect(diasDesde("2026-11-19T00:00:00Z", ahora)).toBe(1);
    expect(diasDesde("2026-11-10T00:00:00Z", ahora)).toBe(10);
    expect(diasDesde("2026-12-01T00:00:00Z", ahora)).toBe(0); // fecha futura: no negativa
    expect(textoAntiguedad(0)).toBe("desde hoy");
    expect(textoAntiguedad(1)).toBe("hace 1 día");
    expect(textoAntiguedad(10)).toBe("hace 10 días");
  });

  it("el precio se muestra en soles, con 2 a 4 decimales", () => {
    expect(formatoPrecio(15.8)).toBe("S/ 15.80");
    expect(formatoPrecio(15.1234)).toBe("S/ 15.1234");
  });

  it("«mejor precio» solo cuando hay dos o más proveedores activos con precio del mismo producto", () => {
    const filas = [
      fila("a", { proveedorId: 1, vigente: entrada(15.8) }),
      fila("b", { proveedorId: 2, vigente: entrada(16.1) }),
      fila("c", { proveedorId: 3, vigente: entrada(15.0), proveedorActivo: false }),
      fila("d", { proveedorId: 4, producto: "urea", codigo: "caja", vigente: entrada(78) }),
      fila("e", { proveedorId: 5, vigente: null }),
    ];
    expect([...clavesConMejorPrecio(filas)]).toEqual(["a"]);
    expect(clavesConMejorPrecio([fila("solo", { vigente: entrada(10) })]).size).toBe(0);
  });

  it("los totales cuentan con precio, sin precio (solo activos), programados y subidas de 5 % o más", () => {
    const resumen = totales([
      fila("a", { vigente: entrada(10.4), anterior: entrada(10) }), // +4 %
      fila("b", { vigente: entrada(11), anterior: entrada(10), programado: entrada(12) }), // +10 %
      fila("c"), // sin precio, activo
      fila("d", { proveedorActivo: false }), // sin precio, inactivo: no cuenta
    ]);
    expect(resumen).toEqual({ conPrecio: 2, sinPrecio: 1, programados: 1, subieron: 1 });
  });
});

describe("Gestión comercial: quién ve la entrada del menú", () => {
  const usuario = (
    rol: string,
    permisosPestanas?: Record<string, boolean>,
    modulos = ["proveedores"]
  ) => ({
    rol,
    modulosPermitidos: modulos,
    permisosPestanas,
  });
  it("admin y operador sí; Lectura no", () => {
    expect(puedeVerPreciosDeProveedores(usuario("admin"))).toBe(true);
    expect(puedeVerPreciosDeProveedores(usuario("operador"))).toBe(true);
    expect(puedeVerPreciosDeProveedores(usuario("lectura"))).toBe(false);
  });
  it("hace falta el módulo de Proveedores, no el de Combustible", () => {
    expect(puedeVerPreciosDeProveedores(usuario("admin", undefined, ["combustible"]))).toBe(false);
    expect(puedeVerPreciosDeProveedores(usuario("admin", undefined, ["proveedores"]))).toBe(true);
    expect(puedeVerPreciosDeProveedores(null)).toBe(false);
  });
  it("un permiso puesto a mano manda sobre el perfil: uno de los dos productos alcanza", () => {
    expect(
      puedeVerPreciosDeProveedores(usuario("lectura", { "combustible:urea:precios": true }))
    ).toBe(true);
    expect(
      puedeVerPreciosDeProveedores(
        usuario("operador", {
          "combustible:tanques:precios": false,
          "combustible:urea:precios": false,
        })
      )
    ).toBe(false);
  });
});
