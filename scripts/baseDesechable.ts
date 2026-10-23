/** scripts/baseDesechable.ts
 *
 * Postgres 16 desechable en Docker, como el del CI (rol mincoreerp_app sin ser
 * el bootstrap, para que RLS aplique). Lo usan `verificar` y `mapa-tests`.
 */
import { spawnSync } from "node:child_process";

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Levanta Postgres 16 como el CI y devuelve las variables PG_* para apuntarle. */
export async function levantarBase(contenedor: string): Promise<NodeJS.ProcessEnv | null> {
  if (spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0) return null;
  const clave = "ci_only_password";
  const run = spawnSync(
    "docker",
    [
      "run",
      "-d",
      "--name",
      contenedor,
      "-e",
      "POSTGRES_USER=postgres",
      "-e",
      `POSTGRES_PASSWORD=${clave}`,
      "-e",
      "POSTGRES_DB=mincoreerp",
      "-p",
      "127.0.0.1::5432",
      // La base vive en memoria y sin fsync: es desechable (se borra al
      // terminar) y los tests no necesitan que sobreviva a un corte de luz.
      // Nunca copiar esto a una base de desarrollo.
      "--tmpfs",
      "/var/lib/postgresql/data",
      "postgres:16",
      "-c",
      "fsync=off",
      "-c",
      "synchronous_commit=off",
      "-c",
      "full_page_writes=off",
    ],
    { encoding: "utf8" }
  );
  if (run.status !== 0) {
    console.log(run.stderr);
    return null;
  }
  // La imagen arranca, se reinicia una vez al terminar de inicializar, y recién
  // ahí acepta conexiones de verdad: hay que esperar el SEGUNDO "ready".
  for (let i = 0; i < 60; i++) {
    const logs = spawnSync("docker", ["logs", contenedor], { encoding: "utf8" });
    const listos = `${logs.stdout}${logs.stderr}`.split("ready to accept connections").length - 1;
    if (listos >= 2) break;
    await dormir(1000);
  }
  const sql =
    `CREATE ROLE mincoreerp_app WITH LOGIN PASSWORD '${clave}'; ` +
    "ALTER DATABASE mincoreerp OWNER TO mincoreerp_app; ALTER SCHEMA public OWNER TO mincoreerp_app;";
  spawnSync("docker", [
    "exec",
    contenedor,
    "psql",
    "-U",
    "postgres",
    "-d",
    "mincoreerp",
    "-c",
    sql,
  ]);
  const mapeo = spawnSync("docker", ["port", contenedor, "5432/tcp"], { encoding: "utf8" });
  const puerto = mapeo.stdout.trim().split("\n")[0]?.split(":").pop();
  if (!puerto) return null;
  return {
    PG_HOST: "127.0.0.1",
    PG_PORT: puerto,
    PG_USER: "mincoreerp_app",
    PG_PASSWORD: clave,
    PG_DATABASE: "mincoreerp",
  };
}
