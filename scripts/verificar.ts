/** scripts/verificar.ts
 *
 * La puerta ANTES de subir: corre en tu máquina lo mismo que el CI va a correr,
 * y si algo falla dice "ERROR EN: <paso>" y no deja hacer push.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────
 *
 * El pre-commit revisa secretos, lint y tipos. Nada revisaba los tests ni el
 * e2e antes de subir, y ahí fallaron los PR: cada ciclo de CI en el PR cuesta
 * minutos de espera y muchos tokens.
 *
 * ── Qué hace, en este orden (lo barato primero) ─────────────────────────
 *
 *   1. Migraciones: un número nuevo no puede chocar con uno que ya está en main.
 *   2. prettier, eslint y tsc de lo que cambió (raíz y client/ por separado).
 *   3. vitest del módulo tocado (si cambió algo compartido, además un "humo" de
 *      RLS y aislamiento; la suite entera la corre el CI, o --completo acá).
 *   4. e2e SOLO de los specs que creaste o modificaste: una vez en chromium,
 *      de a uno y sin reintentos. Que sean estables (5 veces seguidas) lo
 *      comprueba el CI en el PR (ver ci.yml), igual que los demás e2e: todos
 *      los specs en chromium en cada PR, y los 3 navegadores cada noche.
 *
 * Si 1 o 2 fallan, NO se levanta Docker: no tiene sentido gastar minutos en
 * tests de código que ni compila.
 *
 * Los pasos 3 y 4 corren contra un Postgres DESECHABLE en Docker (como el CI:
 * rol mincoreerp_app sin ser el bootstrap, para que RLS aplique). Tu base de
 * desarrollo no se toca: una migración de otra rama, aunque sea no aditiva, no
 * la rompe.
 *
 * ── Uso ─────────────────────────────────────────────────────────────────
 *
 *   npm run verificar                 lo de arriba, contra origin/main
 *   npm run verificar -- --rapido     solo pasos 1 y 2
 *   npm run verificar -- --completo   suite entera y todos los specs (chromium y firefox)
 *   npm run verificar -- --solo-e2e   salta vitest (para repetir solo el e2e)
 *
 * Lo corre solo el hook pre-push. Omitirlo es una decisión consciente y
 * visible: SKIP_VERIFICAR=1 git push   (o SKIP_E2E=1 si no hay Docker).
 *
 * Límite honesto: acá no se corren firefox ni webkit, ni los e2e que no
 * tocaste; eso lo cubre el CI. Lo que se atrapa acá es lo que se puede atrapar
 * barato y sin depender de la máquina: código que no compila, tests rotos y
 * specs nuevos que no son estables. Los tests en cuarentena (tag @inestable,
 * ver playwright.config.ts) no se corren en ningún paso que bloquee.
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { levantarBase } from "./baseDesechable";
import {
  colisionesDeMigraciones,
  seleccionarVerificacion,
  type Seleccion,
} from "./verificarSeleccion";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const RAPIDO = args.has("--rapido");
const COMPLETO = args.has("--completo");
const SOLO_E2E = args.has("--solo-e2e");

/** eslint reutiliza lo ya revisado (guardado bajo node_modules, que git ignora). */
const ESLINT_CACHE = ["--cache", "--cache-location", "node_modules/.cache/eslint/"];

const rojo = (s: string) => `\x1b[31m${s}\x1b[0m`;
const verde = (s: string) => `\x1b[32m${s}\x1b[0m`;
const amarillo = (s: string) => `\x1b[33m${s}\x1b[0m`;

interface Resultado {
  paso: string;
  ok: boolean;
  seg: number;
}
const resultados: Resultado[] = [];

function git(...a: string[]): string {
  const r = spawnSync("git", a, { cwd: raiz, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
}

/** Corre un paso. Si falla, muestra el final de su salida y "ERROR EN: …". */
function paso(
  nombre: string,
  comando: string,
  argumentos: string[],
  opciones: { cwd?: string; env?: NodeJS.ProcessEnv; mostrar?: boolean } = {}
): boolean {
  const t0 = Date.now();
  console.log(`\n▶ ${nombre}`);
  const r: SpawnSyncReturns<string> = spawnSync(comando, argumentos, {
    cwd: opciones.cwd ?? raiz,
    env: { ...process.env, ...opciones.env },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const ok = r.status === 0;
  const seg = Math.round((Date.now() - t0) / 1000);
  resultados.push({ paso: nombre, ok, seg });
  if (!ok) {
    const todas = `${r.stdout ?? ""}${r.stderr ?? ""}`
      .split("\n")
      .filter((l) => !l.startsWith('{"level"'));
    // El error de verdad suele quedar ANTES del final (Playwright, vitest):
    // se guarda todo y se muestran primero las líneas que dicen qué falló.
    const archivo = path.join(os.tmpdir(), `verificar-${nombre.replace(/\W+/g, "-")}.log`);
    fs.writeFileSync(archivo, todas.join("\n"));
    const fallas = todas
      .filter((l) =>
        /✘|✗|×|FAIL|Error:|AssertionError|error TS|Expected|Received|Timeout|timed out/.test(l)
      )
      .slice(0, 30);
    if (fallas.length > 0) console.log(`Lo que falló:\n${fallas.join("\n")}\n`);
    console.log(todas.slice(-25).join("\n"));
    console.log(`(salida completa: ${archivo})`);
    console.log(rojo(`❌ ERROR EN: ${nombre}  (${seg}s)`));
  } else {
    console.log(verde(`✔ ${nombre}  (${seg}s)`));
    if (opciones.mostrar) console.log(`${r.stdout}`.trim().split("\n").slice(-6).join("\n"));
  }
  return ok;
}

function archivosCambiados(base: string): string[] {
  const tracked = git("diff", "--name-only", "--diff-filter=ACMR", base).split("\n");
  const nuevos = git("ls-files", "--others", "--exclude-standard").split("\n");
  return [...new Set([...tracked, ...nuevos])].filter(
    (f) => f && fs.existsSync(path.join(raiz, f))
  );
}

const listar = (dir: string, patron: RegExp, prefijo: string) =>
  fs
    .readdirSync(path.join(raiz, dir))
    .filter((f) => patron.test(f))
    .map((f) => `${prefijo}${f}`);

// ── Docker desechable ────────────────────────────────────────────────────

const contenedor = `mincore_verificar_${process.pid}`;
let dockerArriba = false;

function bajarDocker() {
  if (!dockerArriba) return;
  // -v: borra también el volumen anónimo, para no dejar uno por corrida.
  spawnSync("docker", ["rm", "-fv", contenedor], { stdio: "ignore" });
  dockerArriba = false;
}
for (const s of ["SIGINT", "SIGTERM"] as const) {
  process.on(s, () => {
    bajarDocker();
    process.exit(130);
  });
}

function puertoLibre(desde: number): Promise<number> {
  return new Promise((resolve) => {
    const probar = (p: number) => {
      const srv = net.createServer();
      srv.once("error", () => probar(p + 1));
      srv.listen(p, () => srv.close(() => resolve(p)));
    };
    probar(desde);
  });
}

// ── Principal ────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  if (process.env.SKIP_VERIFICAR === "1") {
    console.log(
      amarillo("⚠️  Verificación OMITIDA (SKIP_VERIFICAR=1). El CI será la primera revisión.")
    );
    return 0;
  }
  spawnSync("git", ["fetch", "-q", "origin", "main"], { cwd: raiz, timeout: 20000 });
  const ref = git("rev-parse", "--verify", "-q", "origin/main") ? "origin/main" : "main";
  const base = git("merge-base", "HEAD", ref) || ref;

  const cambiados = archivosCambiados(base);
  const sel: Seleccion = seleccionarVerificacion(
    cambiados,
    listar("tests", /\.test\.ts$/, "tests/"),
    listar("e2e", /\.spec\.ts$/, "")
  );
  if (sel.nada) {
    console.log(verde("✔ Solo documentación (o sin cambios): nada que verificar."));
    return 0;
  }
  console.log(`Verificando ${cambiados.length} archivos cambiados contra ${ref}.`);
  sel.motivos.forEach((m) => console.log(`  • ${m}`));

  let fallo = false;

  // 1. Migraciones
  const nuevasMig = git("diff", "--name-only", "--diff-filter=A", base, "--", "migrations/")
    .split("\n")
    .filter(Boolean);
  if (nuevasMig.length > 0) {
    const enMain = git("ls-tree", "--name-only", ref, "migrations/").split("\n").filter(Boolean);
    const choques = colisionesDeMigraciones(nuevasMig, enMain);
    if (choques.length > 0) {
      console.log(`\n${choques.join("\n")}`);
      console.log(
        rojo("❌ ERROR EN: número de migración repetido (renombrá la tuya al siguiente libre)")
      );
      resultados.push({ paso: "migraciones", ok: false, seg: 0 });
      fallo = true;
    }
  }

  // 2. Formato, lint y tipos (raíz y client/ por separado: los de la raíz no cubren client/)
  const deRaiz = cambiados.filter((f) => !f.startsWith("client/"));
  const deClient = cambiados.filter((f) => f.startsWith("client/")).map((f) => f.slice(7));
  const formateable = /\.(ts|tsx|js|jsx|json|css|md|yml|yaml)$/;
  const linteable = /\.(ts|tsx)$/;

  const pr = deRaiz.filter((f) => formateable.test(f));
  if (pr.length) fallo = !paso("prettier (raíz)", "npx", ["prettier", "--check", ...pr]) || fallo;
  const pc = deClient.filter((f) => formateable.test(f));
  if (pc.length) {
    fallo =
      !paso("prettier (client)", "npx", ["prettier", "--check", ...pc], {
        cwd: path.join(raiz, "client"),
      }) || fallo;
  }
  const lr = deRaiz.filter((f) => linteable.test(f));
  if (lr.length)
    fallo =
      !paso("eslint (raíz)", "npx", ["eslint", "--max-warnings=0", ...ESLINT_CACHE, ...lr]) ||
      fallo;
  const lc = deClient.filter((f) => linteable.test(f));
  if (lc.length) {
    fallo =
      !paso("eslint (client)", "npx", ["eslint", "--max-warnings=0", ...ESLINT_CACHE, ...lc], {
        cwd: path.join(raiz, "client"),
      }) || fallo;
  }
  if (sel.backend) fallo = !paso("tipos (raíz)", "npx", ["tsc", "--noEmit"]) || fallo;
  if (sel.client) {
    fallo =
      !paso("tipos (client)", "npx", ["tsc", "--noEmit"], { cwd: path.join(raiz, "client") }) ||
      fallo;
  }

  if (fallo) {
    console.log(rojo("\n❌ Hay errores arriba. No se corren los tests: arreglalos primero."));
    return 1;
  }
  if (RAPIDO) return resumen(true);

  // 3 y 4. Tests y e2e, contra una base desechable
  const tests = COMPLETO ? "todos" : sel.tests;
  const specs = COMPLETO
    ? listar("e2e", /\.spec\.ts$/, "").map((s) => path.basename(s))
    : sel.specs;
  const hayTests = !SOLO_E2E && (tests === "todos" || tests.length > 0);
  const hayE2e = specs.length > 0 && process.env.SKIP_E2E !== "1";
  if (!hayTests && !hayE2e) {
    if (specs.length > 0)
      console.log(amarillo("⚠️  e2e OMITIDO (SKIP_E2E=1). El CI será la primera revisión."));
    return resumen(true);
  }

  console.log("\n▶ Base Postgres desechable (Docker)");
  const t0 = Date.now();
  dockerArriba = true;
  const envBase = await levantarBase(contenedor);
  if (!envBase) {
    console.log(
      rojo("❌ ERROR EN: Docker no está disponible, no puedo verificar tests ni e2e.") +
        "\n   Encendé Docker, o subí sabiendo que el CI es la primera revisión: SKIP_VERIFICAR=1 git push"
    );
    resultados.push({ paso: "base desechable", ok: false, seg: 0 });
    return resumen(false);
  }
  try {
    const migrar = paso("migraciones sobre la base nueva", "npx", ["tsx", "migrate.ts"], {
      env: envBase,
    });
    resultados.push({ paso: "base lista", ok: true, seg: Math.round((Date.now() - t0) / 1000) });
    if (!migrar) return resumen(false);

    let ok = true;
    if (hayTests) {
      const lista = tests === "todos" ? [] : tests;
      ok = paso(
        tests === "todos" ? "vitest (suite entera)" : `vitest (${lista.length} archivos)`,
        "npx",
        ["vitest", "run", ...lista],
        { env: envBase }
      );
    }
    if (hayE2e) {
      const puerto = String(await puertoLibre(3011));
      const modo = COMPLETO
        ? // Igual que el CI (1 reintento): firefox en esta máquina es más lento
          // que en el runner y un reintento absorbe ese ruido.
          ["--project=chromium", "--project=firefox", "--retries=1"]
        : // Una sola pasada: la repetición para cazar specs inestables (5 veces
          // seguidas) la hace el CI en el PR, que no ocupa esta máquina. Sin
          // reintentos (un reintento escondería un fallo real) y de a uno.
          ["--project=chromium", "--retries=0", "--workers=1"];
      const e2e = paso(
        COMPLETO
          ? `e2e chromium + firefox (${specs.length} specs)`
          : `e2e chromium (${specs.length} specs tocados)`,
        "npm",
        [
          "run",
          "e2e:local",
          "--",
          ...modo,
          // Con más margen de tiempo que el CI: una máquina de desarrollo es 2-3
          // veces más lenta que el runner, y un login de 31 s contra un límite
          // de 30 s no es un error del código. Un cuelgue de verdad (>90 s) o
          // una aserción rota siguen fallando.
          "--timeout=90000",
          // La cuarentena no bloquea en ningún lado (ver playwright.config.ts).
          // Si el spec tocado está entero en cuarentena, no hay nada que correr.
          "--grep-invert=@inestable",
          "--pass-with-no-tests",
          ...specs.map((s) => `e2e/${s}`),
        ],
        { env: { ...envBase, PORT: puerto } }
      );
      ok = e2e && ok;
    } else if (specs.length > 0) {
      console.log(amarillo("⚠️  e2e OMITIDO (SKIP_E2E=1). El CI será la primera revisión."));
    }
    return resumen(ok);
  } finally {
    bajarDocker();
  }
}

function resumen(ok: boolean): number {
  console.log("\n── Resumen ──");
  for (const r of resultados)
    console.log(`${r.ok ? verde("✔") : rojo("✘")} ${r.paso}  (${r.seg}s)`);
  console.log(
    ok
      ? verde("\n✅ Todo en orden: se puede subir.")
      : rojo("\n❌ NO subas todavía: arreglá lo marcado con ERROR EN.")
  );
  return ok ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    bajarDocker();
    console.error(
      rojo(`❌ ERROR EN: la verificación misma falló: ${err instanceof Error ? err.message : err}`)
    );
    process.exit(1);
  });
