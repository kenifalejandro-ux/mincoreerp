/** tests/proveedores-ruta.test.ts
 *
 * Las direcciones (URL) del ecosistema «Gestión de proveedores»: leerlas, armarlas y titular la pantalla.
 * Lógica pura: lo que se entiende, lo que se corrige y que ir y volver da lo mismo.
 */
import { describe, it, expect } from "vitest";

import {
  esRutaDeProveedores,
  leerRuta,
  rutaDe,
  tituloDeRuta,
  type EstadoDeRuta,
} from "../client/src/components/proveedores/rutaProveedores";

describe("esRutaDeProveedores", () => {
  it("reconoce /proveedores y lo que cuelga de él, y nada más", () => {
    expect(esRutaDeProveedores("/proveedores")).toBe(true);
    expect(esRutaDeProveedores("/proveedores/")).toBe(true);
    expect(esRutaDeProveedores("/proveedores/directorio/3")).toBe(true);
    for (const otra of [
      "/",
      "/proveedoresX",
      "/plataforma",
      "/control-tv",
      "/api/erp/proveedores",
      "",
    ]) {
      expect(esRutaDeProveedores(otra), otra).toBe(false);
    }
  });
});

describe("leerRuta", () => {
  it("lee cada sección con su nombre en español", () => {
    expect(leerRuta("/proveedores")).toEqual({ seccion: "centro" });
    expect(leerRuta("/proveedores/")).toEqual({ seccion: "centro" });
    expect(leerRuta("/proveedores/directorio")).toEqual({ seccion: "directorio" });
    expect(leerRuta("/proveedores/precios")).toEqual({ seccion: "comercial" });
    expect(leerRuta("/proveedores/compras")).toEqual({ seccion: "compras" });
    expect(leerRuta("/proveedores/historial")).toEqual({ seccion: "historial" });
    expect(leerRuta("/proveedores/homologacion")).toEqual({ seccion: "homologacion" });
    expect(leerRuta("/proveedores/pagos")).toEqual({ seccion: "pagos" });
  });

  it("lee la ficha y su pestaña", () => {
    expect(leerRuta("/proveedores/directorio/123")).toEqual({
      seccion: "directorio",
      proveedorId: 123,
    });
    expect(leerRuta("/proveedores/directorio/123/comercial")).toEqual({
      seccion: "directorio",
      proveedorId: 123,
      pestana: "comercial",
    });
    for (const p of ["contactos", "cuentas", "comercial", "compras"]) {
      expect(leerRuta(`/proveedores/directorio/7/${p}`)?.pestana, p).toBe(p);
    }
  });

  it("no distingue mayúsculas ni barra final", () => {
    expect(leerRuta("/proveedores/Directorio/12/Cuentas/")).toEqual({
      seccion: "directorio",
      proveedorId: 12,
      pestana: "cuentas",
    });
  });

  it("corrige lo que no entiende en vez de romperse", () => {
    expect(leerRuta("/proveedores/xyz")).toEqual({ seccion: "centro" });
    expect(leerRuta("/proveedores/xyz/directorio/3")).toEqual({ seccion: "centro" });
    // Un id raro deja el Directorio sin ficha.
    for (const raro of ["abc", "0", "-3", "1.5", "99999999999", "3abc"]) {
      expect(leerRuta(`/proveedores/directorio/${raro}`), raro).toEqual({ seccion: "directorio" });
    }
    // Una pestaña desconocida abre la ficha en el Resumen.
    expect(leerRuta("/proveedores/directorio/5/otra")).toEqual({
      seccion: "directorio",
      proveedorId: 5,
    });
    // Lo que sobra al final se ignora; las demás secciones no llevan ficha.
    expect(leerRuta("/proveedores/precios/5/comercial")).toEqual({ seccion: "comercial" });
  });

  it("una dirección ajena no es del ecosistema", () => {
    expect(leerRuta("/")).toBeNull();
    expect(leerRuta("/control-tv")).toBeNull();
    expect(leerRuta("/proveedoresX")).toBeNull();
  });
});

describe("rutaDe", () => {
  it("arma la dirección de cada estado", () => {
    expect(rutaDe({ seccion: "centro" })).toBe("/proveedores");
    expect(rutaDe({ seccion: "directorio" })).toBe("/proveedores/directorio");
    expect(rutaDe({ seccion: "comercial" })).toBe("/proveedores/precios");
    expect(rutaDe({ seccion: "directorio", proveedorId: 9 })).toBe("/proveedores/directorio/9");
    expect(rutaDe({ seccion: "directorio", proveedorId: 9, pestana: "resumen" })).toBe(
      "/proveedores/directorio/9"
    );
    expect(rutaDe({ seccion: "directorio", proveedorId: 9, pestana: "cuentas" })).toBe(
      "/proveedores/directorio/9/cuentas"
    );
  });

  it("una ficha o pestaña fuera del Directorio no entra en la dirección", () => {
    expect(rutaDe({ seccion: "compras", proveedorId: 9, pestana: "cuentas" })).toBe(
      "/proveedores/compras"
    );
  });

  it("leer lo armado devuelve lo mismo (ida y vuelta)", () => {
    const estados: EstadoDeRuta[] = [
      { seccion: "centro" },
      { seccion: "directorio" },
      { seccion: "directorio", proveedorId: 1 },
      { seccion: "directorio", proveedorId: 42, pestana: "contactos" },
      { seccion: "directorio", proveedorId: 42, pestana: "compras" },
      { seccion: "comercial" },
      { seccion: "compras" },
      { seccion: "historial" },
      { seccion: "evaluacion" },
    ];
    for (const e of estados) expect(leerRuta(rutaDe(e)), rutaDe(e)).toEqual(e);
  });
});

describe("tituloDeRuta", () => {
  it("titula la pestaña del navegador con la sección", () => {
    expect(tituloDeRuta({ seccion: "centro" })).toBe("Centro de gestión · Gestión de proveedores");
    expect(tituloDeRuta({ seccion: "comercial" })).toBe(
      "Gestión comercial · Gestión de proveedores"
    );
    // Con una ficha abierta sigue siendo el Directorio.
    expect(tituloDeRuta({ seccion: "directorio", proveedorId: 3, pestana: "cuentas" })).toBe(
      "Directorio de proveedores · Gestión de proveedores"
    );
  });
});
