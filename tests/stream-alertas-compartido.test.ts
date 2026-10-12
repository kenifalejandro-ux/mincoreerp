/** tests/stream-alertas-compartido.test.ts
 *
 * Prueba la conexión compartida al stream de alertas del cliente
 * (client/src/components/combustible/streamDeAlertas.ts). Vive acá porque
 * client/ no tiene runner propio; mismo criterio que
 * tests/sentry-frontend-filter.test.ts.
 *
 * La promesa: una pestaña abre UNA conexión, la tenga abierta la campanita
 * (admin), la Bandeja (admin y operador) o las dos. El caso del operador es el
 * que no se podía ver a ojo: no tiene campanita, así que la Bandeja es la única
 * que abre el stream, y entrar y salir de ella varias veces no debe ir
 * acumulando conexiones ni dejar una abierta al salir.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  EVENTOS_DE_ALERTAS,
  suscribirseAlStreamDeAlertas,
} from "../client/src/components/combustible/streamDeAlertas";

class EventSourceFalso {
  static abiertas: EventSourceFalso[] = [];
  static creadas = 0;
  cerrada = false;
  oyentes = new Map<string, Array<() => void>>();

  constructor(
    public url: string,
    public opciones?: { withCredentials?: boolean }
  ) {
    EventSourceFalso.creadas++;
    EventSourceFalso.abiertas.push(this);
  }
  addEventListener(tipo: string, fn: () => void) {
    this.oyentes.set(tipo, [...(this.oyentes.get(tipo) ?? []), fn]);
  }
  close() {
    this.cerrada = true;
    EventSourceFalso.abiertas = EventSourceFalso.abiertas.filter((e) => e !== this);
  }
  emitir(tipo: string) {
    for (const fn of this.oyentes.get(tipo) ?? []) fn();
  }
}

describe("stream de alertas: una sola conexión por pestaña", () => {
  beforeEach(() => {
    EventSourceFalso.abiertas = [];
    EventSourceFalso.creadas = 0;
    vi.stubGlobal("EventSource", EventSourceFalso);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("admin: campanita + Bandeja comparten UNA conexión, que se cierra con el último", () => {
    const campanita = vi.fn();
    const bandeja = vi.fn();

    const bajaCampanita = suscribirseAlStreamDeAlertas(campanita);
    const bajaBandeja = suscribirseAlStreamDeAlertas(bandeja);
    expect(EventSourceFalso.creadas).toBe(1);
    const [es] = EventSourceFalso.abiertas;
    expect(es.url).toBe("/api/eventos/stream");
    expect(es.opciones?.withCredentials).toBe(true);

    // Cada evento de alertas llega a los dos.
    for (const tipo of EVENTOS_DE_ALERTAS) es.emitir(tipo);
    expect(campanita).toHaveBeenCalledTimes(EVENTOS_DE_ALERTAS.length);
    expect(bandeja).toHaveBeenCalledTimes(EVENTOS_DE_ALERTAS.length);

    // Salir de la Bandeja no corta la campanita.
    bajaBandeja();
    expect(es.cerrada).toBe(false);
    es.emitir("combustible.alerta_creada");
    expect(campanita).toHaveBeenCalledTimes(EVENTOS_DE_ALERTAS.length + 1);
    expect(bandeja).toHaveBeenCalledTimes(EVENTOS_DE_ALERTAS.length);

    bajaCampanita();
    expect(es.cerrada).toBe(true);
    expect(EventSourceFalso.abiertas).toHaveLength(0);
  });

  it("operador (sin campanita): la Bandeja abre y cierra la conexión, sin acumular al entrar y salir", () => {
    const bandeja = vi.fn();

    for (let vez = 1; vez <= 5; vez++) {
      const baja = suscribirseAlStreamDeAlertas(bandeja);
      expect(EventSourceFalso.abiertas).toHaveLength(1);
      expect(EventSourceFalso.creadas).toBe(vez);
      baja();
      expect(EventSourceFalso.abiertas).toHaveLength(0);
    }

    // Una vez cerrada, un evento rezagado no despierta a nadie.
    expect(bandeja).not.toHaveBeenCalled();
  });

  it("dar de baja dos veces no cierra la conexión de otro suscriptor", () => {
    const bajaA = suscribirseAlStreamDeAlertas(vi.fn());
    const bajaB = suscribirseAlStreamDeAlertas(vi.fn());
    bajaA();
    bajaA();
    expect(EventSourceFalso.abiertas).toHaveLength(1);
    bajaB();
    expect(EventSourceFalso.abiertas).toHaveLength(0);
  });
});
