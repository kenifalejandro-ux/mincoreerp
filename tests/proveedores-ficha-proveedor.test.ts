/** tests/proveedores-ficha-proveedor.test.ts
 *
 * La ficha del proveedor como la maqueta (lógica del cliente, sin React): qué pestañas ve cada persona y en qué
 * orden, qué tan completa está la ficha (IGUAL que el servidor), a qué abastece, los chips de «Qué suministra»
 * y el contacto principal.
 */
import { describe, it, expect } from "vitest";

import {
  chipsDeSuministro,
  condicionDePago,
  contactoPrincipal,
  ETIQUETA_PESTANA,
  fichaCompleta,
  inicialesDeProveedor,
  pestanaPermitida,
  pestanasDeLaFicha,
  textoAbastece,
  type AccesoDeLaFicha,
} from "../client/src/components/proveedores/fichaProveedor";
import type { Contacto, FichaProveedor } from "../client/src/components/proveedores/proveedoresApi";
import { calcularFichaCompleta } from "../src/modules/proveedores/proveedores.directorio";

const todo: AccesoDeLaFicha = {
  verPrecios: true,
  verCompras: true,
  verCuentas: true,
  verHistorial: true,
};
const nada: AccesoDeLaFicha = {
  verPrecios: false,
  verCompras: false,
  verCuentas: false,
  verHistorial: false,
};

describe("pestanasDeLaFicha", () => {
  it("el admin ve todas, en el orden de la maqueta", () => {
    expect(pestanasDeLaFicha(todo)).toEqual([
      "resumen",
      "datos",
      "contactos",
      "cuentas",
      "comercial",
      "contratos",
      "documentos",
      "compras",
      "historial",
    ]);
  });

  it("quien no tiene permisos extra ve solo lo básico y las dos «Pronto»", () => {
    expect(pestanasDeLaFicha(nada)).toEqual([
      "resumen",
      "datos",
      "contactos",
      "contratos",
      "documentos",
    ]);
  });

  it("cada permiso agrega solo su pestaña", () => {
    expect(pestanasDeLaFicha({ ...nada, verPrecios: true })).toContain("comercial");
    expect(pestanasDeLaFicha({ ...nada, verPrecios: true })).not.toContain("cuentas");
    expect(pestanasDeLaFicha({ ...nada, verCompras: true })).toContain("compras");
    expect(pestanasDeLaFicha({ ...nada, verHistorial: true })).toContain("historial");
    expect(pestanasDeLaFicha({ ...nada, verCuentas: true })).toContain("cuentas");
  });

  it("una pestaña que no le toca se lee como el Resumen", () => {
    expect(pestanaPermitida("cuentas", nada)).toBe("resumen");
    expect(pestanaPermitida("historial", nada)).toBe("resumen");
    expect(pestanaPermitida("historial", todo)).toBe("historial");
    expect(pestanaPermitida("contratos", nada)).toBe("contratos");
  });

  it("todas las pestañas tienen etiqueta", () => {
    for (const p of pestanasDeLaFicha(todo)) expect(ETIQUETA_PESTANA[p]).toBeTruthy();
    expect(ETIQUETA_PESTANA.datos).toBe("Datos generales");
    expect(ETIQUETA_PESTANA.compras).toBe("Compras y recepciones");
  });
});

describe("fichaCompleta (igual que el servidor)", () => {
  const datos = (
    extra: { direccion?: string; telefono?: string; formaPago?: "contado" | "credito" } = {}
  ) => ({
    direccion: null as string | null,
    telefono: null as string | null,
    formaPago: null as "contado" | "credito" | null,
    ...extra,
  });

  it("vacía: 0 % y dice qué falta", () => {
    expect(fichaCompleta(null, datos(), [])).toEqual({
      porcentaje: 0,
      faltan: ["RUC", "dirección", "teléfono", "contacto", "condición de pago"],
    });
  });

  it("el teléfono lo da la empresa o un contacto", () => {
    const sinTel = fichaCompleta(null, datos(), [{ telefono: null }]);
    expect(sinTel.faltan).toContain("teléfono");
    expect(sinTel.faltan).not.toContain("contacto");
    expect(fichaCompleta(null, datos(), [{ telefono: "987654321" }]).faltan).not.toContain(
      "teléfono"
    );
    expect(fichaCompleta(null, datos({ telefono: "064123456" }), []).faltan).not.toContain(
      "teléfono"
    );
  });

  it("da lo mismo que el cálculo del servidor en todas las combinaciones", () => {
    const si = [true, false];
    for (const ruc of si)
      for (const direccion of si)
        for (const telefono of si)
          for (const pago of si)
            for (const contacto of [0, 1, 2]) {
              // contacto: 0 = ninguno, 1 = uno sin teléfono, 2 = uno con teléfono.
              const cliente = fichaCompleta(
                ruc ? "20123456789" : null,
                datos({
                  ...(direccion ? { direccion: "Av. 1" } : {}),
                  ...(telefono ? { telefono: "064123456" } : {}),
                  ...(pago ? { formaPago: "contado" } : {}),
                }),
                contacto === 0 ? [] : [{ telefono: contacto === 2 ? "987654321" : null }]
              );
              const servidor = calcularFichaCompleta({
                ruc: ruc ? "20123456789" : null,
                direccion: direccion ? "Av. 1" : null,
                telefono: telefono ? "064123456" : null,
                formaPago: pago ? "contado" : null,
                tieneContacto: contacto > 0,
                contactoConTelefono: contacto === 2,
              });
              expect(cliente).toEqual(servidor);
            }
  });
});

describe("textos de la cabecera y del Resumen", () => {
  it("textoAbastece", () => {
    expect(textoAbastece({ interno: true, externo: true })).toBe("Interno y Externo");
    expect(textoAbastece({ interno: true, externo: false })).toBe("Interno");
    expect(textoAbastece({ interno: false, externo: true })).toBe("Externo");
    expect(textoAbastece({ interno: false, externo: false })).toBe("");
  });

  it("chipsDeSuministro: los productos con precio, y si no hay, los tipos; sin repetir", () => {
    expect(chipsDeSuministro(["Diésel B5", "Diésel B5", "GLP"], ["Combustible"])).toEqual([
      "Diésel B5",
      "GLP",
    ]);
    expect(chipsDeSuministro([], ["Combustible", "Urea"])).toEqual(["Combustible", "Urea"]);
    expect(chipsDeSuministro([], [])).toEqual([]);
  });

  it("inicialesDeProveedor", () => {
    expect(inicialesDeProveedor("grifo santa rosa")).toBe("GS");
    expect(inicialesDeProveedor("Urea")).toBe("U");
  });

  it("condicionDePago", () => {
    const ficha = (formaPago: "contado" | "credito" | null, plazo: number | null) =>
      ({
        datos: { formaPago, plazoPagoDias: plazo },
        contactos: [],
      }) as unknown as FichaProveedor;
    expect(condicionDePago(null)).toBe("…");
    expect(condicionDePago(ficha(null, null))).toBe("Sin definir");
    expect(condicionDePago(ficha("contado", null))).toBe("Contado");
    expect(condicionDePago(ficha("credito", 30))).toBe("Crédito a 30 días");
  });
});

describe("contactoPrincipal", () => {
  const c = (id: number, principal: boolean): Contacto => ({
    id,
    nombre: `C${id}`,
    cargo: null,
    telefono: null,
    correo: null,
    principal,
  });
  it("el marcado como principal; si ninguno, el primero; sin contactos, null", () => {
    expect(contactoPrincipal([c(1, false), c(2, true)])?.id).toBe(2);
    expect(contactoPrincipal([c(1, false), c(2, false)])?.id).toBe(1);
    expect(contactoPrincipal([])).toBeNull();
  });
});
