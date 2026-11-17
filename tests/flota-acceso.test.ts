/** tests/flota-acceso.test.ts
 *
 * Quién ve qué en Gestión operacional de flota (client/src/components/flota/flotaAcceso.ts). Lo que
 * se fija es la autonomía: Viajes y «Mi viaje» se ven con solo el módulo `viajes`; lo que viene de
 * Combustible (la pestaña «Consumo por viaje») pide además ese módulo; y «Mi viaje» va dentro de
 * Combustible si la empresa lo tiene y suelto bajo Flota si no.
 */
import { describe, it, expect } from "vitest";

import {
  miViajeVaEnFlota,
  puedeVerConsumoDeViajes,
  puedeVerMiViaje,
  puedeVerViajes,
} from "../client/src/components/flota/flotaAcceso";

const usuario = (rol: string, modulosPermitidos: string[], permisosPestanas = {}) => ({
  rol,
  modulosPermitidos,
  permisosPestanas,
});

describe("acceso a Viajes sin Combustible", () => {
  it("la oficina ve la lista de viajes con solo el módulo viajes", () => {
    expect(puedeVerViajes(usuario("admin", ["flota", "viajes"]))).toBe(true);
    expect(puedeVerViajes(usuario("operador", ["viajes"]))).toBe(true);
    expect(puedeVerViajes(usuario("admin", ["flota"]))).toBe(false);
    expect(puedeVerViajes(null)).toBe(false);
  });

  it("«Consumo por viaje» es de Combustible: sin ese módulo no se ve", () => {
    expect(puedeVerConsumoDeViajes(usuario("admin", ["flota", "viajes"]))).toBe(false);
    expect(puedeVerConsumoDeViajes(usuario("admin", ["flota", "viajes", "combustible"]))).toBe(
      true
    );
  });

  it("«Mi viaje» del conductor se ve con solo el módulo viajes", () => {
    expect(puedeVerMiViaje(usuario("conductor_ruta", ["viajes"]))).toBe(true);
    expect(puedeVerMiViaje(usuario("conductor_ruta", ["combustible"]))).toBe(false);
    expect(puedeVerMiViaje(usuario("operador", ["viajes"]))).toBe(false);
  });

  it("«Mi viaje» va suelto bajo Flota solo cuando la empresa no tiene Combustible", () => {
    expect(miViajeVaEnFlota(usuario("conductor_ruta", ["flota", "viajes"]))).toBe(true);
    expect(miViajeVaEnFlota(usuario("conductor_ruta", ["viajes", "combustible"]))).toBe(false);
    expect(miViajeVaEnFlota(usuario("operador", ["viajes"]))).toBe(false);
  });

  it("un permiso puesto a mano manda sobre el perfil", () => {
    expect(puedeVerMiViaje(usuario("operador", ["viajes"], { "combustible:mi_viaje": true }))).toBe(
      true
    );
    expect(puedeVerViajes(usuario("admin", ["viajes"], { "combustible:viajes": false }))).toBe(
      false
    );
  });
});
