/** tests/pendientes-cola.test.ts
 *
 * Qué entradas de la cola se muestran como "pendiente de enviar" en cada
 * historial (client/src/offline/pendientesCola.ts). Lógica pura, sin DOM.
 */
import { describe, expect, it } from "vitest";

import { pendientesDeLaCola } from "../client/src/offline/pendientesCola";
import type { EntradaCola } from "../client/src/offline/offlineQueue";

const entrada = (
  url: string,
  body: object | undefined,
  extra: Partial<EntradaCola> = {}
): EntradaCola => ({
  clienteUuid: crypto.randomUUID(),
  usuarioId: "u1",
  moduloId: "combustible",
  url,
  metodo: "POST",
  body: body ? JSON.stringify(body) : undefined,
  creadoEn: 1,
  intentos: 0,
  ...extra,
});

const C = "/api/erp/combustible";

describe("pendientesDeLaCola", () => {
  it("una compra en ruta con combustible aparece en compras, y no en urea", () => {
    const e = entrada(`${C}/compras-ruta`, {
      comprobante_tipo: "Boleta",
      comprobante_numero: "B001-1",
      despachado_en: "2026-10-20T18:00:00.000Z",
      combustible: { tipo_combustible: "Diésel B5", cantidad: 12 },
    });
    const compras = pendientesDeLaCola([e], "compras");
    expect(compras).toHaveLength(1);
    expect(compras[0]?.titulo).toBe("Boleta B001-1");
    expect(compras[0]?.detalle).toContain("12 gal");
    expect(pendientesDeLaCola([e], "urea")).toHaveLength(0);
  });

  it("una compra con urea aparece también en el historial de urea", () => {
    const e = entrada(`${C}/compras-ruta`, {
      comprobante_tipo: "Factura",
      comprobante_numero: "F-9",
      urea: { lineas: [{ presentacion: "CAJA", cantidad_bultos: 2 }] },
    });
    const urea = pendientesDeLaCola([e], "urea");
    expect(urea).toHaveLength(1);
    expect(urea[0]?.detalle).toBe("Urea: 2× CAJA");
  });

  it("una compra de urea suelta (despachos) va al historial de urea", () => {
    const e = entrada(`${C}/despachos`, {
      producto: "urea",
      origen: "compra_externa",
      comprobante_tipo: "Boleta",
      comprobante_numero: "ffd",
      lineas: [{ presentacion: "CAJA", cantidad_bultos: 3 }],
    });
    expect(pendientesDeLaCola([e], "urea")).toHaveLength(1);
    expect(pendientesDeLaCola([e], "compras")).toHaveLength(0);
  });

  it("la carga desde tanqueta va a compras; un vale del tanque propio no", () => {
    const tanqueta = entrada(`${C}/despachos`, {
      origen: "tanqueta",
      cantidad: 5,
      tipo_combustible: "Diésel B5",
    });
    const vale = entrada(`${C}/despachos`, { origen: "tanque_propio", cantidad: 5 });
    expect(pendientesDeLaCola([tanqueta, vale], "compras")).toHaveLength(1);
  });

  it("las fotos, las lecturas y lo que no es POST no se muestran", () => {
    const foto = entrada(`${C}/compras-ruta/por-uuid/abc/comprobante`, undefined);
    const lectura = entrada(`${C}/lecturas`, { combustible_id: 1 });
    const put = entrada(`${C}/despachos`, { origen: "tanqueta" }, { metodo: "PUT" });
    expect(pendientesDeLaCola([foto, lectura, put], "compras")).toHaveLength(0);
  });

  it("un body corrupto no revienta y la más reciente va primero", () => {
    const mala = entrada(`${C}/despachos`, undefined, { body: "{no-json" });
    const a = entrada(
      `${C}/compras-ruta`,
      { comprobante_numero: "1", combustible: {} },
      { creadoEn: 1 }
    );
    const b = entrada(
      `${C}/compras-ruta`,
      { comprobante_numero: "2", combustible: {} },
      { creadoEn: 2 }
    );
    const r = pendientesDeLaCola([mala, a, b], "compras");
    expect(r.map((p) => p.titulo)).toEqual(["2", "1"]);
  });
});
