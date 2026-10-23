/** scripts/mapaTests.ts
 *
 * Genera scripts/mapa-tests.json: qué funciones de src/ ejecuta cada archivo de
 * test. `verificar` lo usa para correr solo los tests que de verdad dependen de
 * lo que cambiaste, en vez del módulo entero (ver mapaTestsLogica.ts).
 *
 * ── Qué hace ────────────────────────────────────────────────────────────
 *
 * Levanta el mismo Postgres desechable que `verificar`, corre CADA archivo de
 * test por separado midiendo cobertura, resta lo que ya ejecuta solo arrancar
 * la app (tests/app-arranca.test.ts) y guarda el resultado. Tarda ~30 min (183
 * archivos, de a 2). Se corre una vez, y de nuevo cuando hay tests nuevos o un
 * módulo nuevo: `verificar` avisa si el mapa quedó viejo.
 *
 * ── Uso ─────────────────────────────────────────────────────────────────
 *
 *   npm run mapa-tests                 de a 2 archivos a la vez
 *   npm run mapa-tests -- --paralelo=3
 *
 * Los rangos de líneas son del commit actual, así que no se corre con cambios
 * sin guardar en src/, tests/ o migrations/. Si algún test falla no se escribe
 * nada: un mapa a medias haría correr de menos.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { levantarBase } from "./baseDesechable";
import {
  construirMapa,
  funcionesEjecutadas,
  mapaATexto,
  restarBase,
  type CoberturaFinal,
  type FuncionesPorArchivo,
} from "./mapaTestsLogica";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destino = path.join(raiz, "scripts", "mapa-tests.json");
const BASE = "app-arranca";
const paralelo = Number(process.argv.find((a) => a.startsWith("--paralelo="))?.split("=")[1] ?? 2);

const contenedor = `mincore_mapa_${process.pid}`;
const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), "mapa-tests-"));

function limpiar() {
  spawnSync("docker", ["rm", "-fv", contenedor], { stdio: "ignore" });
  fs.rmSync(carpeta, { recursive: true, force: true });
}
for (const s of ["SIGINT", "SIGTERM"] as const) {
  process.on(s, () => {
    limpiar();
    process.exit(130);
  });
}

const git = (...a: string[]) => spawnSync("git", a, { cwd: raiz, encoding: "utf8" }).stdout.trim();

/** Corre un archivo de test con cobertura; devuelve si pasó. */
function medir(nombre: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise((resolve) => {
    const cero = ["lines", "functions", "statements", "branches"].map(
      (m) => `--coverage.thresholds.${m}=0`
    );
    const p = spawn(
      "npx",
      [
        "vitest",
        "run",
        `tests/${nombre}.test.ts`,
        "--coverage.enabled=true",
        "--coverage.reporter=json",
        `--coverage.reportsDirectory=${path.join(carpeta, nombre)}`,
        ...cero,
      ],
      { cwd: raiz, env: { ...process.env, ...env }, stdio: "ignore" }
    );
    p.on("exit", (code) => resolve(code === 0));
  });
}

const leer = (nombre: string): FuncionesPorArchivo =>
  funcionesEjecutadas(
    JSON.parse(
      fs.readFileSync(path.join(carpeta, nombre, "coverage-final.json"), "utf8")
    ) as CoberturaFinal,
    raiz
  );

async function main(): Promise<number> {
  if (git("status", "--porcelain", "--", "src", "tests", "migrations")) {
    console.log("Hay cambios sin guardar en src/, tests/ o migrations/: commitealos o guardalos.");
    console.log("El mapa guarda rangos de líneas y tiene que corresponder a un commit.");
    return 1;
  }
  const nombres = fs
    .readdirSync(path.join(raiz, "tests"))
    .filter((f) => f.endsWith(".test.ts"))
    .map((f) => f.slice(0, -".test.ts".length))
    .sort();
  if (!nombres.includes(BASE)) {
    console.log(`Falta tests/${BASE}.test.ts (la línea base).`);
    return 1;
  }

  console.log("▶ Base Postgres desechable (Docker)");
  const env = await levantarBase(contenedor);
  if (!env) {
    console.log("Docker no está disponible.");
    return 1;
  }
  const migrar = spawnSync("npx", ["tsx", "migrate.ts"], {
    cwd: raiz,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  if (migrar.status !== 0) {
    console.log(`${migrar.stdout}${migrar.stderr}`.split("\n").slice(-15).join("\n"));
    return 1;
  }

  const t0 = Date.now();
  console.log(`▶ Midiendo ${nombres.length} archivos de test (de a ${paralelo})`);
  const fallidos: string[] = [];
  const medidos: Record<string, FuncionesPorArchivo> = {};
  let hechos = 0;

  const correr = async (nombre: string) => {
    const ok = await medir(nombre, env);
    hechos++;
    console.log(`  [${hechos}/${nombres.length}] ${ok ? "✔" : "✘"} ${nombre}`);
    if (ok) medidos[nombre] = leer(nombre);
    else fallidos.push(nombre);
  };

  // La línea base va primera y sola: a los demás se les resta contra ella.
  await correr(BASE);
  const base = medidos[BASE];
  if (!base) {
    console.log("La línea base no pasó: sin ella no se puede restar el arranque de la app.");
    return 1;
  }
  const pendientes = nombres.filter((n) => n !== BASE);
  const trabajador = async () => {
    for (let nombre = pendientes.shift(); nombre; nombre = pendientes.shift()) await correr(nombre);
  };
  await Promise.all(Array.from({ length: paralelo }, trabajador));

  if (fallidos.length > 0) {
    console.log(`\n✘ Fallaron ${fallidos.length} tests: ${fallidos.join(", ")}`);
    console.log("No se escribió el mapa. Corrélos solos (npx vitest run) y volvé a intentar.");
    return 1;
  }
  const propios: Record<string, FuncionesPorArchivo> = {};
  for (const n of Object.keys(medidos).filter((n) => n !== BASE))
    propios[n] = restarBase(medidos[n], base);
  const mapa = construirMapa(propios, git("rev-parse", "HEAD"), new Date().toISOString());
  fs.writeFileSync(destino, mapaATexto(mapa));
  const kb = Math.round(fs.statSync(destino).size / 1024);
  const min = Math.round((Date.now() - t0) / 60000);
  console.log(
    `\n✅ Mapa de ${Object.keys(mapa.tests).length} tests escrito en ${path.relative(raiz, destino)}`
  );
  console.log(`   ${kb} KB, commit ${mapa.commit.slice(0, 7)}, ${min} min`);
  return 0;
}

main()
  .then((code) => {
    limpiar();
    process.exit(code);
  })
  .catch((err) => {
    limpiar();
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
