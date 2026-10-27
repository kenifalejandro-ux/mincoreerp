/** tests/alertas-viaje-texto.test.ts
 *
 * Los textos que la Bandeja y la campanita muestran de las alertas de un viaje en curso (0156):
 * el nombre del tipo, la referencia ("V-12") y la explicación. Es lógica pura del cliente
 * (alertasTexto.ts); se prueba acá porque el e2e no puede disparar el worker que las crea.
 */
import { describe, it, expect } from "vitest";

import {
  ETIQUETA_TIPO_ALERTA,
  describirDetalleAlerta,
  referenciaAlerta,
  type AlertaCombustible,
} from "../client/src/components/combustible/alertasTexto";

const base = {
  critica: true,
  id: 1,
  serie_talonario: null,
  n_vale: null,
  despacho_id: null,
  combustible_id: null,
  recepcion_id: null,
  viaje_id: 12,
  creado_en: "2026-10-27T10:00:00Z",
  leida_en: null,
  resuelta_en: null,
  resuelta_por: null,
} as const;

describe("alertas de un viaje en curso: textos de la Bandeja", () => {
  it("el viaje demorado dice cuánto lleva, lo normal y de cuántos viajes sale", () => {
    const a = {
      ...base,
      tipo: "viaje_demorado",
      detalle: {
        viajeNumero: 12,
        unidad: "T5D-983",
        conductor: "Kenif Alejandro",
        de: "Huamachuco",
        a: "Bambamarca",
        marchaMin: 360,
        esperadoMin: 240,
        demoraMin: 120,
        viajesDeHistorial: 8,
        baseDelHistorial: "tipo",
      },
    } as unknown as AlertaCombustible;
    expect(ETIQUETA_TIPO_ALERTA.viaje_demorado).toBe("Viaje demorado");
    expect(referenciaAlerta(a)).toBe("V-12");
    const t = describirDetalleAlerta(a);
    expect(t).toBe(
      "El viaje V-12 de T5D-983 (Kenif Alejandro) va de Huamachuco a Bambamarca y lleva 6 h 0 min " +
        "en marcha: lo normal son 4 h 0 min, 2 h 0 min de más. Se calcula con 8 viajes de este " +
        "tipo de unidad, sin contar el tiempo detenido."
    );
  });

  it("con todas las unidades como base, lo dice; sin datos no revienta", () => {
    const todas = describirDetalleAlerta({
      ...base,
      tipo: "viaje_demorado",
      detalle: { viajeNumero: 3, baseDelHistorial: "todas", viajesDeHistorial: 3 },
    } as unknown as AlertaCombustible);
    expect(todas).toContain("3 viajes de todas las unidades");
    expect(todas).toContain("una unidad"); // sin unidad en el detalle
    // Un dato que falta se ve como "?", no como "0 min".
    expect(
      describirDetalleAlerta({
        ...base,
        tipo: "viaje_demorado",
        detalle: { viajeNumero: 3 },
      } as unknown as AlertaCombustible)
    ).toContain("lleva ? en marcha: lo normal son ?, ? de más");
    expect(() =>
      describirDetalleAlerta({
        ...base,
        tipo: "viaje_demorado",
        detalle: {},
      } as unknown as AlertaCombustible)
    ).not.toThrow();
  });

  it("la unidad detenida dice qué la detuvo, dónde y desde cuándo", () => {
    const a = {
      ...base,
      tipo: "viaje_detenido",
      detalle: {
        viajeNumero: 12,
        unidad: "T5D-983",
        conductor: "Kenif Alejandro",
        detencion: "Avería",
        motivo: "Avería del radiador",
        donde: "En ruta hacia Bambamarca",
        desde: "2026-10-27T15:30:00Z",
        marcadoPor: "Kenif Alejandro",
      },
    } as unknown as AlertaCombustible;
    expect(ETIQUETA_TIPO_ALERTA.viaje_detenido).toBe("Unidad detenida");
    expect(referenciaAlerta(a)).toBe("V-12");
    const t = describirDetalleAlerta(a);
    expect(t).toContain("detenido por avería");
    expect(t).toContain("En ruta hacia Bambamarca");
    expect(t).toContain("Motivo: Avería del radiador");
    expect(t).toContain("no cuenta como demora");
  });

  it("si el motivo es solo la etiqueta no lo repite", () => {
    const t = describirDetalleAlerta({
      ...base,
      tipo: "viaje_detenido",
      detalle: { viajeNumero: 1, detencion: "Huaico", motivo: "Huaico" },
    } as unknown as AlertaCombustible);
    expect(t).toContain("detenido por huaico");
    expect(t).not.toContain("Motivo:");
  });
});
