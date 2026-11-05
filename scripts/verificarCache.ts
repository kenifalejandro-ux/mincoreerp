/** scripts/verificarCache.ts
 *
 * Registro de "este contenido ya pasó verificar en verde", para que el pre-push
 * no repita ~10 min sobre exactamente lo mismo.
 *
 * La clave es el árbol de git del ÁRBOL DE TRABAJO (lo que verificar revisa de
 * verdad: staged + sin stagear + untracked no ignorado), más la base contra la
 * que se comparó y el estado de migrations/ en origin/main (el chequeo de
 * números repetidos depende de él, y main puede cambiar sin que cambie tu árbol).
 *
 * El árbol se calcula con un índice temporal: el índice real no se toca. Tras
 * commitear todo, ese árbol es igual a HEAD^{tree}, así que el verde de antes
 * del commit sigue valiendo en el pre-push.
 *
 * El registro vive en node_modules/.cache (git lo ignora). Reinstalar
 * dependencias lo borra, y eso es lo correcto: cambió lo que se verificó.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Clave {
  arbol: string;
  base: string;
  migracionesMain: string;
}

export interface Entrada extends Clave {
  fecha: string;
}

const MAX_ENTRADAS = 20;

export const archivoRegistro = (raiz: string) =>
  path.join(raiz, "node_modules", ".cache", "verificar", "verde.json");

const mismaClave = (a: Clave, b: Clave) =>
  a.arbol === b.arbol && a.base === b.base && a.migracionesMain === b.migracionesMain;

/** Árbol de git del contenido actual del árbol de trabajo; "" si no se pudo. */
export function arbolDeTrabajo(raiz: string): string {
  const gitDir = spawnSync("git", ["rev-parse", "--git-path", "index"], {
    cwd: raiz,
    encoding: "utf8",
  });
  if (gitDir.status !== 0) return "";
  const indice = path.resolve(raiz, gitDir.stdout.trim());
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "verificar-indice-"));
  const copia = path.join(tmp, "index");
  try {
    if (fs.existsSync(indice)) fs.copyFileSync(indice, copia);
    const env = { ...process.env, GIT_INDEX_FILE: copia };
    const add = spawnSync("git", ["add", "-A"], { cwd: raiz, env, encoding: "utf8" });
    if (add.status !== 0) return "";
    const w = spawnSync("git", ["write-tree"], { cwd: raiz, env, encoding: "utf8" });
    return w.status === 0 ? w.stdout.trim() : "";
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function leerRegistro(archivo: string): Entrada[] {
  try {
    const datos: unknown = JSON.parse(fs.readFileSync(archivo, "utf8"));
    return Array.isArray(datos) ? (datos as Entrada[]) : [];
  } catch {
    return [];
  }
}

/** Una clave con algún dato vacío (git falló) nunca cuenta como verificada. */
export const claveValida = (c: Clave) => Boolean(c.arbol && c.base && c.migracionesMain);

export function yaVerificada(registro: Entrada[], clave: Clave): Entrada | undefined {
  if (!claveValida(clave)) return undefined;
  return registro.find((e) => mismaClave(e, clave));
}

export function agregarEntrada(registro: Entrada[], clave: Clave, fecha: string): Entrada[] {
  const sin = registro.filter((e) => !mismaClave(e, clave));
  return [...sin, { ...clave, fecha }].slice(-MAX_ENTRADAS);
}

export function grabarVerde(archivo: string, clave: Clave): void {
  if (!claveValida(clave)) return;
  fs.mkdirSync(path.dirname(archivo), { recursive: true });
  const nuevo = agregarEntrada(leerRegistro(archivo), clave, new Date().toISOString());
  fs.writeFileSync(archivo, JSON.stringify(nuevo, null, 2));
}
