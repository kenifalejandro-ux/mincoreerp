/** tests/proveedores-en-ecosistema.test.ts
 *
 * PR6: la pestaña «Proveedores» de Combustible pasa a solo lectura cuando la persona edita los proveedores en
 * «Gestión de proveedores». Lógica sin React: quién entra en ese caso y quién sigue editando acá.
 */
import { describe, it, expect } from "vitest";

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
