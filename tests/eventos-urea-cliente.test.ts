/** tests/eventos-urea-cliente.test.ts
 *
 * La lógica pura que decide qué le toca al panel de urea del stream de
 * eventos (client/src/components/combustible/eventosUrea.ts). Vive acá porque
 * client/ no tiene runner propio; mismo criterio que
 * tests/stream-alertas-compartido.test.ts.
 *
 * Lo que defiende:
 *   1. Un evento de OTRO producto se descarta; uno sin producto (payload
 *      vaciado del que ve solo algunas plantas, o roto) refresca igual --
 *      pedir de más es barato, perderse un cambio no.
 *   2. Cada tipo de evento vuelve a pedir lo suyo y nada más.
 *   3. Descartar un evento no deja rastro en window.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  EVENTOS_UREA,
  EVENTO_UREA_EN_WINDOW,
  avisarCambioDeUrea,
  esDeOtroProducto,
  planDeRefresco,
} from "../client/src/components/combustible/eventosUrea";

describe("esDeOtroProducto", () => {
  it("un evento de combustible no le toca a urea", () => {
    expect(esDeOtroProducto('{"despachoId":1,"producto":"combustible"}')).toBe(true);
  });

  it("un evento de urea sí", () => {
    expect(esDeOtroProducto('{"despachoId":1,"producto":"urea"}')).toBe(false);
  });

  it("sin producto o con el payload vaciado, NO se puede saber: refresca", () => {
    expect(esDeOtroProducto("{}")).toBe(false);
    expect(esDeOtroProducto('{"despachoId":1}')).toBe(false);
    expect(esDeOtroProducto("")).toBe(false);
  });

  it("un payload roto o de otro tipo no tumba nada: refresca", () => {
    expect(esDeOtroProducto("no es json")).toBe(false);
    expect(esDeOtroProducto("null")).toBe(false);
    expect(esDeOtroProducto("42")).toBe(false);
    expect(esDeOtroProducto('"urea"')).toBe(false);
    expect(esDeOtroProducto(undefined)).toBe(false);
    expect(esDeOtroProducto(null)).toBe(false);
    expect(esDeOtroProducto({ producto: "combustible" })).toBe(false);
  });

  it("un producto que no es texto no cuenta como 'otro producto'", () => {
    expect(esDeOtroProducto('{"producto":5}')).toBe(false);
    expect(esDeOtroProducto('{"producto":null}')).toBe(false);
  });
});

describe("planDeRefresco", () => {
  const vacio = {
    presentaciones: false,
    precios: false,
    estado: false,
    hallazgos: false,
    vista: false,
  };

  it("sin eventos no se pide nada", () => {
    expect(planDeRefresco([])).toEqual(vacio);
  });

  it("un precio nuevo recarga solo los precios", () => {
    expect(planDeRefresco(["combustible.urea_precios_cambiaron"])).toEqual({
      ...vacio,
      precios: true,
    });
  });

  it("corregir un envase recarga envases, stock y vista", () => {
    expect(planDeRefresco(["combustible.urea_presentaciones_cambiaron"])).toEqual({
      ...vacio,
      presentaciones: true,
      estado: true,
      vista: true,
    });
  });

  it("la configuración recarga solo el estado (los umbrales del banner)", () => {
    expect(planDeRefresco(["combustible.config_actualizada"])).toEqual({
      ...vacio,
      estado: true,
    });
  });

  it("las alertas recargan solo los hallazgos", () => {
    for (const tipo of [
      "combustible.alerta_creada",
      "combustible.alerta_resuelta",
      "combustible.alertas_actualizadas",
    ]) {
      expect(planDeRefresco([tipo])).toEqual({ ...vacio, hallazgos: true });
    }
  });

  it("vales, entradas, conteos y comprobantes recargan stock y vista", () => {
    for (const tipo of [
      "combustible.despacho_creado",
      "combustible.despacho_anulado",
      "combustible.comprobante_adjuntado",
      "combustible.recepcion_creada",
      "combustible.recepcion_anulada",
      "combustible.recepcion_validada",
      "combustible.urea_conteo_creado",
      "combustible.urea_conteo_anulado",
    ]) {
      expect(planDeRefresco([tipo])).toEqual({ ...vacio, estado: true, vista: true });
    }
  });

  it("varios avisos juntos suman lo que cada uno pide, sin repetir", () => {
    expect(
      planDeRefresco([
        "combustible.despacho_creado",
        "combustible.despacho_creado",
        "combustible.urea_precios_cambiaron",
        "combustible.alerta_creada",
      ])
    ).toEqual({ ...vacio, precios: true, hallazgos: true, estado: true, vista: true });
  });

  it("todo tipo que el panel escucha tiene un plan que pide ALGO", () => {
    for (const tipo of EVENTOS_UREA) {
      const plan = planDeRefresco([tipo]);
      expect(Object.values(plan).some(Boolean), `${tipo} no recarga nada`).toBe(true);
    }
  });

  it("un tipo desconocido recarga lo básico en vez de perderse", () => {
    expect(planDeRefresco(["combustible.algo_nuevo"])).toEqual({
      ...vacio,
      estado: true,
      vista: true,
    });
  });
});

describe("avisarCambioDeUrea", () => {
  const recibidos: string[] = [];
  const oyente = (e: Event) => recibidos.push((e as CustomEvent<{ tipo: string }>).detail.tipo);

  beforeEach(() => {
    recibidos.length = 0;
    const destino = new EventTarget();
    vi.stubGlobal("window", {
      dispatchEvent: (e: Event) => destino.dispatchEvent(e),
      addEventListener: (n: string, f: EventListener) => destino.addEventListener(n, f),
    });
    (globalThis as unknown as { window: Window }).window.addEventListener(
      EVENTO_UREA_EN_WINDOW,
      oyente
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reenvía a window un evento de urea o sin producto", () => {
    avisarCambioDeUrea("combustible.despacho_creado", '{"despachoId":1,"producto":"urea"}');
    avisarCambioDeUrea("combustible.alerta_creada", "{}");
    expect(recibidos).toEqual(["combustible.despacho_creado", "combustible.alerta_creada"]);
  });

  it("descarta el evento de otro producto sin dejar rastro", () => {
    avisarCambioDeUrea("combustible.despacho_creado", '{"despachoId":1,"producto":"combustible"}');
    expect(recibidos).toEqual([]);
  });
});
