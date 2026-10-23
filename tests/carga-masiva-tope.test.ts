/** tests/carga-masiva-tope.test.ts
 *
 * El tope de filas de las rutas /bulk se aplica ANTES de zod: zod procesa todos los elementos de
 * un array aunque ya pase su `.max()` (aviso GHSA-mrhx-c7xc-m3w5), y con 2 MB de cuerpo eso era
 * ~33 s de servidor bloqueado y ~860 MB. Se prueba sin sesión: el tope corta antes de llegar a
 * la autenticación, que es justo lo que protege.
 */
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { app } from "./helpers";
import { closeDatabase } from "../src/server/config/database";

const RUTAS_BULK = [
  "/api/erp/repuestos/bulk",
  "/api/erp/documentos/bulk",
  "/api/erp/equipos/bulk",
  "/api/erp/combustible/bulk",
];

describe("el tope de filas de /bulk corta antes de validar", () => {
  afterAll(async () => {
    await closeDatabase();
  });

  it.each(RUTAS_BULK)("%s rechaza 400.000 filas enseguida y dice por qué", async (ruta) => {
    const filas = JSON.stringify(new Array(400_000).fill({}));
    const t0 = Date.now();
    const res = await request(app).post(ruta).set("Content-Type", "application/json").send(filas);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("5000 filas");
    // Sin el tope zod tardaba ~20 s con esto; el margen es amplio para que un equipo cargado no lo vuelva inestable.
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("con 5000 filas la importación sigue su camino normal (sin sesión: 401)", async () => {
    const filas = JSON.stringify(new Array(5000).fill({}));
    const res = await request(app)
      .post("/api/erp/repuestos/bulk")
      .set("Content-Type", "application/json")
      .send(filas);
    expect(res.status).toBe(401);
  });

  it("un cuerpo que no es un arreglo no lo toca el tope", async () => {
    const res = await request(app).post("/api/erp/repuestos/bulk").send({ filas: [] });
    expect(res.status).toBe(401);
  });
});
