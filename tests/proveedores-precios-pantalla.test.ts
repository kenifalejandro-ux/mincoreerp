/** tests/proveedores-precios-pantalla.test.ts
 *
 * Gestión comercial (PR4), lógica de la pantalla sin React: variación, antigüedad, mejor precio, totales y
 * quién ve la entrada del menú.
 */
import { describe, it, expect } from "vitest";

import {
  clavesConMejorPrecio,
  coincideConUso,
  diasDesde,
  diasParaVencer,
  estadoDeVigencia,
  formatoDia,
  formatoPrecio,
  textoAntiguedad,
  textoCondicionDePago,
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
  hasta: null,
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
  uso: "externo",
  condicionDePago: null,
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
    expect(resumen).toEqual({
      conPrecio: 2,
      sinPrecio: 1,
      programados: 1,
      subieron: 1,
      productos: 1,
      vencenPronto: 0,
      vencidos: 0,
    });
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

describe("Gestión comercial: vigencia hasta, condición de pago y uso", () => {
  // 20/11/2026 12:00 en Lima (UTC-5).
  const AHORA = Date.parse("2026-11-20T17:00:00Z");

  it("cuenta los días para vencer desde hoy en Lima, sin correrse un día por la zona horaria", () => {
    expect(diasParaVencer("2026-11-20", AHORA)).toBe(0);
    expect(diasParaVencer("2026-11-21", AHORA)).toBe(1);
    expect(diasParaVencer("2026-12-20", AHORA)).toBe(30);
    expect(diasParaVencer("2026-11-19", AHORA)).toBe(-1);
    // A las 22:00 de Lima ya es el día siguiente en UTC: sigue siendo «hoy» en Lima.
    expect(diasParaVencer("2026-11-20", Date.parse("2026-11-21T03:00:00Z"))).toBe(0);
  });

  it("escribe el día como DD/MM/AAAA", () => {
    expect(formatoDia("2026-12-31")).toBe("31/12/2026");
  });

  it("dice cuánto falta y el tono: vencido, pronto (30 días o menos) o normal; sin fecha, nada", () => {
    expect(estadoDeVigencia(null, AHORA)).toBeNull();
    expect(estadoDeVigencia("2026-11-19", AHORA)).toEqual({
      fecha: "19/11/2026",
      texto: "venció ayer",
      tono: "vencido",
    });
    expect(estadoDeVigencia("2026-11-10", AHORA)?.texto).toBe("venció hace 10 días");
    expect(estadoDeVigencia("2026-11-20", AHORA)).toMatchObject({
      texto: "vence hoy",
      tono: "pronto",
    });
    expect(estadoDeVigencia("2026-11-21", AHORA)?.texto).toBe("vence mañana");
    expect(estadoDeVigencia("2026-12-20", AHORA)).toMatchObject({
      texto: "vence en 30 días",
      tono: "pronto",
    });
    expect(estadoDeVigencia("2026-12-21", AHORA)).toMatchObject({
      texto: "vence en 31 días",
      tono: "normal",
    });
  });

  it("los totales cuentan los que vencen en 30 días, los ya vencidos y los productos con precio", () => {
    const conHasta = (clave: string, hasta: string | null, extra: Partial<FilaPrecio> = {}) =>
      fila(clave, { vigente: { ...entrada(10), hasta }, ...extra });
    const t = totales(
      [
        conHasta("a", "2026-12-01"),
        conHasta("b", "2026-12-20"),
        conHasta("c", "2027-03-01"),
        conHasta("d", "2026-11-01"),
        conHasta("e", null, { codigo: "gasolina_90" }),
        fila("f"),
      ],
      AHORA
    );
    expect(t.vencenPronto).toBe(2);
    expect(t.vencidos).toBe(1);
    expect(t.conPrecio).toBe(5);
    // diesel_b5 y gasolina_90: dos productos distintos con precio.
    expect(t.productos).toBe(2);
  });

  it("la condición de pago sale de la ficha", () => {
    expect(textoCondicionDePago(null)).toBe("—");
    expect(textoCondicionDePago({ formaPago: "contado", plazoPagoDias: null })).toBe("Contado");
    expect(textoCondicionDePago({ formaPago: "credito", plazoPagoDias: 30 })).toBe(
      "Crédito 30 días"
    );
  });

  it("el filtro de uso deja pasar «interno y externo» por los dos lados", () => {
    expect(coincideConUso("externo", "todos")).toBe(true);
    expect(coincideConUso("externo", "externo")).toBe(true);
    expect(coincideConUso("externo", "interno")).toBe(false);
    expect(coincideConUso("interno", "externo")).toBe(false);
    expect(coincideConUso("ambos", "interno")).toBe(true);
    expect(coincideConUso("ambos", "externo")).toBe(true);
  });
});
