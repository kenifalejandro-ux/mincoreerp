/** tests/auditoria-dependencias.test.ts
 *
 * Qué avisos de `npm audit` frenan el CI (scripts/auditoriaDependenciasLogica.ts): cualquier aviso
 * alto o crítico, salvo los que tienen una excepción vigente. Lógica pura sobre un reporte de
 * ejemplo con la forma real de `npm audit --json`.
 */
import { describe, it, expect } from "vitest";
import {
  evaluarAuditoria,
  type Permitido,
  type ReporteAuditoria,
} from "../scripts/auditoriaDependenciasLogica";

const aviso = (id: string) => ({ url: `https://github.com/advisories/${id}` });
const zod: ReporteAuditoria = {
  vulnerabilities: { zod: { severity: "high", via: [aviso("GHSA-mrhx-c7xc-m3w5")] } },
};
const permitidoZod: Permitido = {
  id: "GHSA-mrhx-c7xc-m3w5",
  vence: "2026-11-22",
  motivo: "prueba",
};

describe("evaluarAuditoria", () => {
  it("un aviso alto con excepción vigente se tolera", () => {
    const r = evaluarAuditoria(zod, "2026-10-23", [permitidoZod]);
    expect(r.fallas).toEqual([]);
    expect(r.toleradas).toEqual(["zod (high)"]);
  });

  it("el último día de la excepción todavía vale; al día siguiente vuelve a fallar", () => {
    expect(evaluarAuditoria(zod, "2026-11-22", [permitidoZod]).fallas).toEqual([]);
    const vencida = evaluarAuditoria(zod, "2026-11-23", [permitidoZod]);
    expect(vencida.fallas).toEqual(["zod (high)"]);
    expect(vencida.vencidas).toEqual(["GHSA-mrhx-c7xc-m3w5"]);
  });

  it("otro aviso alto o crítico, aunque sea del mismo paquete, no queda tolerado", () => {
    const reporte: ReporteAuditoria = {
      vulnerabilities: {
        zod: {
          severity: "high",
          via: [aviso("GHSA-mrhx-c7xc-m3w5"), aviso("GHSA-otro-aviso-nuevo")],
        },
        express: { severity: "critical", via: [aviso("GHSA-xxxx-yyyy-zzzz")] },
      },
    };
    const r = evaluarAuditoria(reporte, "2026-10-23", [permitidoZod]);
    expect(r.fallas.sort()).toEqual(["express (critical)", "zod (high)"]);
  });

  it("un paquete cuyo riesgo viene de otro se tolera solo si el otro se tolera", () => {
    const reporte: ReporteAuditoria = {
      vulnerabilities: {
        zod: { severity: "high", via: [aviso("GHSA-mrhx-c7xc-m3w5")] },
        "usa-zod": { severity: "high", via: ["zod"] },
        "usa-otro": { severity: "high", via: ["otro"] },
        otro: { severity: "high", via: [aviso("GHSA-sin-excepcion")] },
      },
    };
    const r = evaluarAuditoria(reporte, "2026-10-23", [permitidoZod]);
    expect(r.toleradas.sort()).toEqual(["usa-zod (high)", "zod (high)"]);
    expect(r.fallas.sort()).toEqual(["otro (high)", "usa-otro (high)"]);
  });

  it("los avisos moderados y bajos no frenan, igual que --audit-level=high", () => {
    const reporte: ReporteAuditoria = {
      vulnerabilities: {
        a: { severity: "moderate", via: [aviso("GHSA-aaaa-aaaa-aaaa")] },
        b: { severity: "low", via: [aviso("GHSA-bbbb-bbbb-bbbb")] },
      },
    };
    expect(evaluarAuditoria(reporte, "2026-10-23", []).fallas).toEqual([]);
  });

  it("sin avisos, o con un aviso sin id, el resultado es el esperado", () => {
    expect(evaluarAuditoria({}, "2026-10-23", [permitidoZod])).toEqual({
      fallas: [],
      toleradas: [],
      vencidas: [],
    });
    const sinId: ReporteAuditoria = {
      vulnerabilities: { x: { severity: "high", via: [{ url: "https://ejemplo.com/aviso" }] } },
    };
    expect(evaluarAuditoria(sinId, "2026-10-23", [permitidoZod]).fallas).toEqual(["x (high)"]);
  });
});
