/** tests/proveedores-acciones-cliente.test.ts
 *
 * Qué acciones tiene cada persona sobre un proveedor (lógica del cliente, sin React): editar y desactivar o
 * reactivar son del admin y del operador; eliminar, solo del admin. Y cómo se valida el motivo.
 */
import { describe, it, expect } from "vitest";

import {
  accionesDelProveedor,
  ETIQUETA_DE_ACCION,
  MOTIVO_MAXIMO,
  problemaDelMotivo,
} from "../client/src/components/proveedores/accionesDeProveedor";

describe("accionesDelProveedor", () => {
  it("el admin ve editar, desactivar y eliminar; con el proveedor desactivado, reactivar", () => {
    expect(accionesDelProveedor({ activo: true, puedeEditar: true, esAdmin: true })).toEqual([
      "editar",
      "desactivar",
      "eliminar",
    ]);
    expect(accionesDelProveedor({ activo: false, puedeEditar: true, esAdmin: true })).toEqual([
      "editar",
      "reactivar",
      "eliminar",
    ]);
  });

  it("el operador no elimina", () => {
    expect(accionesDelProveedor({ activo: true, puedeEditar: true, esAdmin: false })).toEqual([
      "editar",
      "desactivar",
    ]);
  });

  it("quien no puede editar (Lectura, «Consultas») no tiene ninguna, ni siquiera siendo admin", () => {
    expect(accionesDelProveedor({ activo: true, puedeEditar: false, esAdmin: false })).toEqual([]);
    expect(accionesDelProveedor({ activo: true, puedeEditar: false, esAdmin: true })).toEqual([]);
  });

  it("cada acción tiene su etiqueta", () => {
    expect(ETIQUETA_DE_ACCION).toEqual({
      editar: "Editar proveedor",
      desactivar: "Desactivar proveedor",
      reactivar: "Reactivar proveedor",
      eliminar: "Eliminar proveedor",
    });
  });
});

describe("problemaDelMotivo", () => {
  it("desactivar exige el motivo (al menos 3 letras)", () => {
    expect(problemaDelMotivo("", true)).toBe("Escribe el motivo (al menos 3 letras).");
    expect(problemaDelMotivo("  ab  ", true)).toBe("Escribe el motivo (al menos 3 letras).");
    expect(problemaDelMotivo("Ya no nos abastece", true)).toBeNull();
  });

  it("reactivar no lo exige", () => {
    expect(problemaDelMotivo("", false)).toBeNull();
    expect(problemaDelMotivo("volvió a trabajar con nosotros", false)).toBeNull();
  });

  it("tiene un tope en los dos casos", () => {
    const largo = "x".repeat(MOTIVO_MAXIMO + 1);
    expect(problemaDelMotivo(largo, true)).toMatch(/no puede pasar de 300/);
    expect(problemaDelMotivo(largo, false)).toMatch(/no puede pasar de 300/);
    expect(problemaDelMotivo("x".repeat(MOTIVO_MAXIMO), true)).toBeNull();
  });
});
