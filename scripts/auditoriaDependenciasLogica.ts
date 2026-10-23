/** scripts/auditoriaDependenciasLogica.ts
 *
 * Qué avisos de `npm audit` frenan el CI. Lógica pura (sin red ni procesos): la usa
 * `auditoriaDependencias.ts` y la prueba `tests/auditoria-dependencias.test.ts`.
 *
 * `npm audit --audit-level=high` no deja ignorar un aviso concreto. Esto hace lo mismo (falla con
 * cualquier aviso alto o crítico) pero tolera los avisos de la lista de PERMITIDOS mientras su
 * excepción no haya vencido: cada excepción lleva su motivo y una fecha, y al vencer vuelve a fallar.
 */

export interface Permitido {
  /** El id del aviso, por ejemplo GHSA-xxxx-xxxx-xxxx. */
  id: string;
  /** Hasta cuándo se tolera, inclusive (AAAA-MM-DD). */
  vence: string;
  motivo: string;
}

interface Via {
  url?: string;
}

export interface ReporteAuditoria {
  vulnerabilities?: Record<string, { severity: string; via: (string | Via)[] }>;
}

export interface ResultadoAuditoria {
  fallas: string[];
  toleradas: string[];
  vencidas: string[];
}

const idDelAviso = (url: string | undefined) => /GHSA-[a-z0-9-]+/i.exec(url ?? "")?.[0] ?? null;

export function evaluarAuditoria(
  reporte: ReporteAuditoria,
  hoy: string,
  permitidos: Permitido[]
): ResultadoAuditoria {
  const vigentes = new Set(permitidos.filter((p) => p.vence >= hoy).map((p) => p.id));
  const vulnerabilidades = reporte.vulnerabilities ?? {};

  /** Un paquete se tolera si TODOS sus avisos están permitidos y vigentes; si su riesgo viene de
   *  otro paquete (`via` con un nombre), ese también tiene que tolerarse. */
  const tolerado = (nombre: string, visitando: Set<string>): boolean => {
    const v = vulnerabilidades[nombre];
    if (!v || visitando.has(nombre)) return true;
    const dentro = new Set(visitando).add(nombre);
    return v.via.every((via) => {
      if (typeof via === "string") return tolerado(via, dentro);
      const id = idDelAviso(via.url);
      return id !== null && vigentes.has(id);
    });
  };

  const fallas: string[] = [];
  const toleradas: string[] = [];
  for (const [nombre, v] of Object.entries(vulnerabilidades)) {
    if (v.severity !== "high" && v.severity !== "critical") continue;
    (tolerado(nombre, new Set()) ? toleradas : fallas).push(`${nombre} (${v.severity})`);
  }
  const vencidas = permitidos.filter((p) => p.vence < hoy).map((p) => p.id);
  return { fallas, toleradas, vencidas };
}
