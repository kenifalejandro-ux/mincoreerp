/** scripts/e2eLocal.ts
 *
 * Corre la suite e2e de Playwright en la máquina de desarrollo, replicando
 * lo que hace el job `e2e-tests` de ci.yml — y dejando el entorno como
 * estaba al terminar.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────
 *
 * Hasta ahora, cada spec nuevo se descubría roto recién en CI: un selector
 * mal, un límite de rate limit compartido, un service worker que tapa la
 * intercepción. Cada uno de esos costó un ciclo completo de push + esperar
 * + leer el log, y el último costó tres. Todo eso es diagnosticable en un
 * minuto localmente, si el entorno está armado.
 *
 * ── Lo que el e2e necesita y no está en tu entorno normal ───────────────
 *
 *  1. Un tenant sembrado (`e2e`) con un admin conocido, y un segundo
 *     (`e2e-b`) que solo existe para que el spec de aislamiento tenga
 *     datos ajenos que intentar alcanzar.
 *  2. Un build del cliente con `VITE_DEFAULT_TENANT_SLUG=e2e` horneado
 *     adentro: Vite reemplaza esa variable por su valor literal en tiempo
 *     de BUILD, no la lee en runtime (ver LoginPage.tsx). Sin eso, el login
 *     de los specs no encuentra a qué empresa entrar.
 *
 * El punto (2) es el que hacía incómodo correr esto a mano: te dejaba el
 * `client/dist` apuntando al tenant de prueba en vez de al tuyo. Por eso
 * este script SIEMPRE reconstruye el cliente con tu configuración al
 * terminar — pase lo que pase, incluido Ctrl-C.
 *
 * ── Uso ─────────────────────────────────────────────────────────────────
 *
 *   npm run e2e:local
 *   npm run e2e:local -- e2e/capa-b-cliente-uuid.spec.ts
 *   npm run e2e:local -- --project=webkit --headed
 *
 * Todo lo que va después de `--` se le pasa tal cual a `playwright test`.
 */
import { spawnSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool, closeDatabase } from "../src/server/config/database";
import {
  apagarCambioObligatorioDelAdmin,
  onboardTenantService,
} from "../src/server/services/tenantOnboardingService";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const clientDir = path.join(raiz, "client");

/** Mismos valores que el job e2e-tests de ci.yml. Si allá cambian, acá
 *  también: los specs leen estos nombres de variable directamente. */
const TENANTS = [
  {
    tenantNombre: "E2E Test",
    tenantSlug: "e2e",
    adminNombre: "E2E Admin",
    adminEmail: "e2e@mincoreerp.test",
    adminPassword: "E2eTestPass!2026",
  },
  {
    tenantNombre: "E2E Test B",
    tenantSlug: "e2e-b",
    adminNombre: "E2E Admin B",
    adminEmail: "e2e-b@mincoreerp.test",
    adminPassword: "E2eTestPassB!2026",
  },
] as const;

const ENV_E2E: Record<string, string> = {
  E2E_TENANT_SLUG: TENANTS[0].tenantSlug,
  E2E_ADMIN_EMAIL: TENANTS[0].adminEmail,
  E2E_ADMIN_PASSWORD: TENANTS[0].adminPassword,
  E2E_TENANT_B_SLUG: TENANTS[1].tenantSlug,
  E2E_ADMIN_B_EMAIL: TENANTS[1].adminEmail,
  E2E_ADMIN_B_PASSWORD: TENANTS[1].adminPassword,
  // Los mismos tres límites que ci.yml sube, y por el mismo motivo: todos
  // los specs entran con el mismo usuario y los navegadores corren en
  // paralelo, así que los contadores de producción los estorban en vez de
  // proteger nada. Ver el comentario largo en ci.yml.
  RATE_LIMIT_MAX_REQUESTS: "100",
  LOGIN_EMAIL_RATE_LIMIT_MAX_REQUESTS: "100",
  ERP_RATE_LIMIT_USUARIO_MAX: "5000",
};

function correr(
  comando: string,
  args: string[],
  opciones: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
) {
  const res = spawnSync(comando, args, {
    cwd: opciones.cwd ?? raiz,
    env: opciones.env ?? process.env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  return res.status ?? 1;
}

async function sembrarTenantsSiFaltan(): Promise<void> {
  for (const tenant of TENANTS) {
    // `tenants` no tiene RLS (ver ALLOWLIST_SIN_RLS en rls-coverage.test.ts),
    // así que pool.query directo es correcto acá.
    const existe = await pool.query<{ id: string }>(`SELECT id FROM tenants WHERE slug = $1`, [
      tenant.tenantSlug,
    ]);
    let tenantId = existe.rows[0]?.id;

    if (tenantId) {
      console.log(`✓ tenant "${tenant.tenantSlug}" ya existe, se reusa`);
    } else {
      console.log(`→ sembrando tenant "${tenant.tenantSlug}"...`);
      const creado = await onboardTenantService(
        { ...tenant },
        {
          ip: "127.0.0.1",
          actorType: "system",
          actorLabel: "cli:e2e:local",
        }
      );
      tenantId = creado.tenant.id;
      console.log(`✓ tenant "${tenant.tenantSlug}" creado`);
    }

    // También para un tenant que ya existía: uno sembrado antes de que
    // existiera esta línea queda para siempre en la pantalla de "Poné tu
    // propia contraseña", y todo spec falla en el login. Es lo mismo que hace
    // ci.yml con --sinCambioObligatorio.
    await apagarCambioObligatorioDelAdmin(tenantId, tenant.adminEmail);
  }
}

/** Reconstruye el cliente leyendo tu client/.env normal — o sea, con TU
 *  VITE_DEFAULT_TENANT_SLUG, no el de prueba. Es lo que deja el entorno
 *  como estaba. */
function restaurarBuildNormal(): void {
  console.log("\n→ restaurando tu build del cliente (client/.env)...");
  const codigo = correr("npm", ["run", "build"], { cwd: clientDir });
  if (codigo !== 0) {
    console.error(
      "\n⚠️  El build de restauración FALLÓ. Tu client/dist quedó apuntando al tenant de\n" +
        "   prueba. Corré `npm run build` dentro de client/ para arreglarlo."
    );
  } else {
    console.log("✓ build normal restaurado");
  }
}

/** playwright.config.ts tiene `reuseExistingServer: !process.env.CI`, así
 *  que si ya hay algo escuchando en el puerto, Playwright NO levanta el
 *  suyo: reusa el que esté. Con `npm run dev` abierto en otra terminal eso
 *  significa correr los e2e contra un server que NO recibió ninguna de las
 *  variables de este script (los tres límites de rate limit) ni sirve el
 *  build que acabamos de compilar. Los tests fallarían por motivos que no
 *  tienen nada que ver con el código, o peor, pasarían por casualidad.
 *
 *  Falla ruidoso en vez de adivinar: es un minuto de confusión ahora
 *  contra media hora persiguiendo un fantasma después. */
function puertoOcupado(puerto: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port: puerto, host: "127.0.0.1" });
    const cerrar = (ocupado: boolean) => {
      socket.destroy();
      resolve(ocupado);
    };
    socket.setTimeout(1000);
    socket.once("connect", () => cerrar(true));
    socket.once("timeout", () => cerrar(false));
    socket.once("error", () => cerrar(false));
  });
}

async function main(): Promise<number> {
  const argsPlaywright = process.argv.slice(2);

  const puerto = Number(process.env.PORT ?? 3001);
  if (await puertoOcupado(puerto)) {
    throw new Error(
      `Hay algo escuchando en el puerto ${puerto} (¿'npm run dev' abierto?).\n` +
        `Playwright reusaría ESE server en vez de levantar el suyo, y ese no tiene las\n` +
        `variables que este script necesita ni sirve el build de prueba.\n` +
        `Cerrá ese proceso y volvé a correr.`
    );
  }

  // Por default, solo Chromium. No es pereza: en esta máquina de desarrollo
  // tanto WebKit como Firefox tienen la red rota contra localhost —
  // medido, no supuesto: los mismos 7 specs tardan 37s y pasan enteros en
  // Chromium, y en Firefox tardan 2.9 min y fallan 3, siempre esperando
  // respuestas que no llegan (el <select> existe pero nunca se llena porque
  // el GET no vuelve). Los mismos specs pasan en Firefox en CI.
  //
  // El objetivo de este script es un bucle rápido y confiable para
  // diagnosticar ANTES de pushear; los tres motores los cubre CI, que es
  // donde de verdad importa. Un default que falla por el entorno enseña a
  // ignorar los rojos, que es exactamente lo que no queremos.
  //
  // --project=firefox / --project=webkit siguen funcionando por si algún
  // día se arregla la red local.
  const pidieronProyecto = argsPlaywright.some((a) => a.startsWith("--project"));
  const proyectos = pidieronProyecto ? [] : ["--project=chromium"];
  if (!pidieronProyecto) {
    console.log("ℹ  Corriendo solo Chromium (Firefox y WebKit tienen la red rota en local).");
    console.log("   Los tres motores los cubre CI. Para forzar uno: --project=firefox\n");
  }

  console.log("→ aplicando migraciones pendientes...");
  if (correr("npm", ["run", "migrate"]) !== 0) throw new Error("Fallaron las migraciones");

  await sembrarTenantsSiFaltan();
  await closeDatabase();

  console.log("\n→ compilando el cliente con el tenant de prueba horneado...");
  const codigoBuild = correr("npm", ["run", "build"], {
    cwd: clientDir,
    env: { ...process.env, VITE_DEFAULT_TENANT_SLUG: TENANTS[0].tenantSlug },
  });
  if (codigoBuild !== 0) {
    // Sin build de prueba no hay nada que correr, pero el dist ya puede
    // haber quedado a medias — se restaura igual.
    restaurarBuildNormal();
    throw new Error("Falló el build del cliente");
  }

  console.log("\n→ corriendo Playwright...\n");
  // Playwright levanta el server solo (webServer en playwright.config.ts)
  // y le hereda este env, así que los límites de arriba llegan al backend.
  const codigoTests = correr("npx", ["playwright", "test", ...proyectos, ...argsPlaywright], {
    env: { ...process.env, ...ENV_E2E },
  });

  restaurarBuildNormal();

  if (codigoTests !== 0) {
    console.error("\n✗ Los e2e fallaron. El reporte HTML: npx playwright show-report");
    return codigoTests;
  }
  console.log("\n✓ e2e en verde");
  return 0;
}

// Ctrl-C a mitad de camino dejaría el dist con el tenant de prueba: se
// restaura antes de salir. Sin esto, el script cumpliría su promesa solo
// cuando termina bien, que es justo cuando menos importa.
for (const senal of ["SIGINT", "SIGTERM"] as const) {
  process.on(senal, () => {
    console.log(`\n\n⚠  Interrumpido (${senal}).`);
    restaurarBuildNormal();
    process.exit(130);
  });
}

// process.exit() explícito, igual que el resto de scripts/ — no es
// ceremonia: sin esto el proceso queda vivo para siempre después de
// terminar, porque los módulos del server que se importan acá dejan
// handles abiertos (pool, timers). La primera versión solo salía por el
// camino de FALLO, así que una corrida en verde se colgaba y una en rojo
// no: el bug se escondía justo cuando todo andaba bien.
main()
  .then((codigo) => process.exit(codigo))
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await closeDatabase().catch(() => {});
    process.exit(1);
  });
