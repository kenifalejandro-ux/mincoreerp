/** tests/csp-mapa-satelite.test.ts
 *
 * La política de contenido del servidor deja bajar las imágenes del mapa satélite del Control TV (Esri)
 * y SOLO imágenes: ni scripts, ni conexiones, ni estilos de ese host. Sin la excepción el navegador
 * bloquea el satélite sin avisar; con una excepción de más, se abre una puerta que no hace falta.
 */
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { app } from "./helpers";
import { closeDatabase } from "../src/server/config/database";

const ESRI = "https://server.arcgisonline.com";

/** Una directiva de la política, como lista de fuentes. */
function directiva(csp: string, nombre: string): string[] {
  const linea = csp
    .split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith(`${nombre} `));
  return linea ? linea.split(/\s+/).slice(1) : [];
}

describe("CSP: imágenes del mapa satélite", () => {
  afterAll(async () => {
    await closeDatabase();
  });

  it("imgSrc permite el host de Esri, además de lo propio y los data:", async () => {
    const r = await request(app).get("/health");
    const csp = String(r.headers["content-security-policy"] ?? "");
    expect(csp, "la respuesta debe traer la política de contenido").not.toBe("");
    const img = directiva(csp, "img-src");
    expect(img).toContain(ESRI);
    expect(img).toContain("'self'");
    expect(img).toContain("data:");
  });

  it("el host de Esri no se cuela en scripts, conexiones, estilos, fuentes ni marcos", async () => {
    const csp = String((await request(app).get("/health")).headers["content-security-policy"]);
    for (const d of [
      "script-src",
      "connect-src",
      "style-src",
      "font-src",
      "frame-src",
      "default-src",
    ]) {
      expect(directiva(csp, d), d).not.toContain(ESRI);
    }
  });

  it("no se abrió imgSrc a cualquier sitio", async () => {
    const csp = String((await request(app).get("/health")).headers["content-security-policy"]);
    const img = directiva(csp, "img-src");
    expect(img).not.toContain("*");
    expect(img).not.toContain("https:");
    expect(img).not.toContain("http:");
  });
});
