/** tests/proveedores-en-ecosistema.test.ts
 *
 * La pestaña «Proveedores» de Combustible se oculta y «Precios» queda solo con la venta interna cuando la
 * persona maneja los proveedores en «Gestión de proveedores». Lógica sin React: quién entra en ese caso y
 * quién sigue editando acá.
 */
import { describe, it, expect } from "vitest";

import { puedeVerPrecios } from "../client/src/components/combustible/preciosAcceso";
import { edicionDeProveedoresEnElEcosistema } from "../client/src/components/combustible/proveedoresEnEcosistema";

const usuario = (
  rol: string,
  modulos: string[],
  consulta: string[] = []
): Parameters<typeof edicionDeProveedoresEnElEcosistema>[0] => ({
  rol,
  modulosPermitidos: modulos,
  modulosConsulta: consulta,
});

describe("edicionDeProveedoresEnElEcosistema", () => {
  it("admin y operador con el módulo Proveedores editan allá: la pestaña de Combustible es de consulta", () => {
    expect(
      edicionDeProveedoresEnElEcosistema(usuario("admin", ["combustible", "proveedores"]))
    ).toBe(true);
    expect(
      edicionDeProveedoresEnElEcosistema(usuario("operador", ["combustible", "proveedores"]))
    ).toBe(true);
  });

  it("sin el módulo Proveedores (la empresa no lo tiene o la persona no lo tiene asignado) se edita acá", () => {
    expect(edicionDeProveedoresEnElEcosistema(usuario("admin", ["combustible"]))).toBe(false);
    expect(edicionDeProveedoresEnElEcosistema(usuario("operador", ["combustible"]))).toBe(false);
  });

  it("si en Proveedores solo puede consultar, no puede editar allá: acá sigue pudiendo", () => {
    expect(
      edicionDeProveedoresEnElEcosistema(
        usuario("operador", ["combustible", "proveedores"], ["proveedores"])
      )
    ).toBe(false);
  });

  it("los perfiles que no editan proveedores en el ecosistema (Lectura y cancha) no cambian", () => {
    for (const rol of ["lectura", "grifero", "conductor_ruta", "encargado_urea"]) {
      expect(
        edicionDeProveedoresEnElEcosistema(usuario(rol, ["combustible", "proveedores"])),
        rol
      ).toBe(false);
    }
  });

  it("sin usuario no hay nada que concentrar", () => {
    expect(edicionDeProveedoresEnElEcosistema(null)).toBe(false);
    expect(edicionDeProveedoresEnElEcosistema(undefined)).toBe(false);
  });
});

describe("puedeVerPrecios con Gestión de proveedores", () => {
  const con = (rol: string, modulos: string[], permisos: Record<string, boolean> = {}) => ({
    rol,
    modulosPermitidos: modulos,
    permisosPestanas: permisos,
  });

  it("sin el módulo Proveedores ve Precios con cualquiera de los dos permisos, como siempre", () => {
    expect(puedeVerPrecios(con("admin", ["combustible"]))).toBe(true);
    expect(
      puedeVerPrecios(
        con("operador", ["combustible"], {
          "combustible:tanques:precios": false,
          "combustible:urea:precios": true,
        })
      )
    ).toBe(true);
  });

  it("con el módulo Proveedores, Precios es solo la venta interna: pide el permiso de combustible", () => {
    const modulos = ["combustible", "proveedores"];
    expect(puedeVerPrecios(con("admin", modulos))).toBe(true);
    // Solo el permiso de urea ya no alcanza: los precios de urea se cargan en el ecosistema.
    expect(
      puedeVerPrecios(
        con("operador", modulos, {
          "combustible:tanques:precios": false,
          "combustible:urea:precios": true,
        })
      )
    ).toBe(false);
    expect(puedeVerPrecios(con("operador", modulos, { "combustible:tanques:precios": true }))).toBe(
      true
    );
  });

  it("Lectura y la cancha no cambian aunque tengan el módulo", () => {
    expect(
      puedeVerPrecios(
        con("lectura", ["combustible", "proveedores"], { "combustible:urea:precios": true })
      )
    ).toBe(true);
  });

  it("sin el módulo Combustible no ve Precios", () => {
    expect(puedeVerPrecios(con("admin", ["proveedores"]))).toBe(false);
    expect(puedeVerPrecios(null)).toBe(false);
  });
});
