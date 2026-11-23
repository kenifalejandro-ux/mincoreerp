/** scripts/auditoriaDependencias.ts
 *
 * El paso "Auditoría de dependencias" del CI (job backend): falla con cualquier aviso alto o
 * crítico de `npm audit`, salvo los de PERMITIDOS mientras su excepción no haya vencido.
 * Reglas en auditoriaDependenciasLogica.ts.
 *
 *   npm run auditoria
 */
import { spawnSync } from "node:child_process";
import {
  evaluarAuditoria,
  type Permitido,
  type ReporteAuditoria,
} from "./auditoriaDependenciasLogica";

/** Cada excepción se quita sola al vencer: renovarla es una decisión, no un descuido. */
const PERMITIDOS: Permitido[] = [];

const auditoria = spawnSync("npm", ["audit", "--json"], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
let reporte: ReporteAuditoria;
try {
  reporte = JSON.parse(auditoria.stdout) as ReporteAuditoria;
} catch {
  console.error("npm audit no devolvió un reporte que se pueda leer:");
  console.error(auditoria.stdout || auditoria.stderr);
  process.exit(1);
}

const hoy = new Date().toISOString().slice(0, 10);
const { fallas, toleradas, vencidas } = evaluarAuditoria(reporte, hoy, PERMITIDOS);

for (const t of toleradas) {
  console.log(`tolerado: ${t}`);
}
for (const p of PERMITIDOS.filter((x) => x.vence >= hoy)) {
  console.log(`  ${p.id} hasta ${p.vence}: ${p.motivo}`);
}
for (const id of vencidas) {
  console.error(`La excepción de ${id} venció: ya no se tolera.`);
}
if (fallas.length > 0) {
  console.error(`Avisos altos o críticos sin excepción: ${fallas.join(", ")}`);
  // En GitHub Actions queda como advertencia visible en el PR aunque el paso no frene.
  if (process.env.GITHUB_ACTIONS) {
    console.log(
      `::warning title=Auditoría de dependencias::Avisos sin excepción: ${fallas.join(", ")}`
    );
  }
  process.exit(1);
}
console.log("Auditoría de dependencias: sin avisos altos ni críticos fuera de las excepciones.");
