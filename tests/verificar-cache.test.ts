/** tests/verificar-cache.test.ts
 *
 * El registro de "ya verificado en verde" (scripts/verificarCache.ts). Un falso
 * "ya verificado" deja subir código sin pasar la puerta: se prueba que cualquier
 * cambio de contenido, de base o de migraciones de main invalide la clave.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agregarEntrada,
  arbolDeTrabajo,
  grabarVerde,
  leerRegistro,
  yaVerificada,
  type Clave,
} from "../scripts/verificarCache";

const clave: Clave = { arbol: "aaa", base: "bbb", migracionesMain: "ccc" };

describe("registro de verde", () => {
  it("reconoce la misma clave y rechaza cualquier dato distinto", () => {
    const reg = agregarEntrada([], clave, "2026-11-05");
    expect(yaVerificada(reg, clave)).toBeDefined();
    expect(yaVerificada(reg, { ...clave, arbol: "x" })).toBeUndefined();
    expect(yaVerificada(reg, { ...clave, base: "x" })).toBeUndefined();
    expect(yaVerificada(reg, { ...clave, migracionesMain: "x" })).toBeUndefined();
  });

  it("una clave con datos vacíos nunca cuenta como verificada", () => {
    const vacia: Clave = { arbol: "", base: "", migracionesMain: "" };
    expect(yaVerificada(agregarEntrada([], vacia, "f"), vacia)).toBeUndefined();
  });

  it("guarda solo las últimas 20 y no duplica", () => {
    let reg = agregarEntrada([], clave, "f");
    reg = agregarEntrada(reg, clave, "g");
    expect(reg).toHaveLength(1);
    for (let i = 0; i < 30; i++) reg = agregarEntrada(reg, { ...clave, arbol: `t${i}` }, "f");
    expect(reg).toHaveLength(20);
  });

  it("archivo ausente o roto = registro vacío; grabar y leer vuelven igual", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vcache-"));
    const archivo = path.join(dir, "sub", "verde.json");
    expect(leerRegistro(archivo)).toEqual([]);
    grabarVerde(archivo, clave);
    expect(yaVerificada(leerRegistro(archivo), clave)).toBeDefined();
    fs.writeFileSync(archivo, "{roto");
    expect(leerRegistro(archivo)).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("arbolDeTrabajo (repo temporal)", () => {
  let repo = "";
  const git = (...a: string[]) =>
    spawnSync("git", a, { cwd: repo, encoding: "utf8" }).stdout.trim();

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "vcache-repo-"));
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    fs.writeFileSync(path.join(repo, ".gitignore"), "ignorado.txt\n");
    fs.writeFileSync(path.join(repo, "a.txt"), "uno\n");
    git("add", "-A");
    git("commit", "-qm", "base");
  });
  afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

  it("sin cambios coincide con HEAD^{tree}", () => {
    expect(arbolDeTrabajo(repo)).toBe(git("rev-parse", "HEAD^{tree}"));
  });

  it("cambiar una línea, o crear un archivo, cambia el árbol; lo ignorado no", () => {
    const limpio = arbolDeTrabajo(repo);
    fs.writeFileSync(path.join(repo, "ignorado.txt"), "x");
    expect(arbolDeTrabajo(repo)).toBe(limpio);
    fs.writeFileSync(path.join(repo, "a.txt"), "dos\n");
    const editado = arbolDeTrabajo(repo);
    expect(editado).not.toBe(limpio);
    fs.writeFileSync(path.join(repo, "nuevo.txt"), "n\n");
    expect(arbolDeTrabajo(repo)).not.toBe(editado);
  });

  it("no toca el índice real y, tras commitear todo, coincide con HEAD^{tree}", () => {
    expect(git("status", "--porcelain")).toContain("?? nuevo.txt"); // sigue sin stagear
    const antes = arbolDeTrabajo(repo);
    git("add", "-A");
    git("commit", "-qm", "cambios");
    expect(git("rev-parse", "HEAD^{tree}")).toBe(antes);
    expect(arbolDeTrabajo(repo)).toBe(antes);
  });
});
