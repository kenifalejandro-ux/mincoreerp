/** tests/eventos-sse-entrega.test.ts
 *
 * Que un evento publicado LLEGUE de verdad por el stream. Suena obvio, y
 * justamente por eso no estaba probado: `eventos-tiempo-real.test.ts` cubre
 * auth, replay por Last-Event-ID y aislamiento entre tenants, pero ninguna
 * prueba abría el stream y esperaba un evento en vivo.
 *
 * El agujero se pagó caro: la campanita de combustible se construyó sobre
 * este stream y no actualizaba nada. Kenif tuvo que borrar cookies para ver
 * una alerta que ya existía en la base, y durante semanas pareció un
 * problema del cliente.
 *
 * Estos tests usan `http` crudo y no supertest a propósito: supertest junta
 * la respuesta entera antes de resolver, que es exactamente lo que un
 * stream que nunca termina no hace.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba } from "./helpers";
import { closeDatabase } from "../src/server/config/database";
import { publicarEventoTenant } from "../src/server/services/realtimeEvents.service";

describe("SSE: los eventos llegan al cliente en vivo", () => {
  let tenantId: string;
  let cookie: string;
  let servidor: http.Server;
  let puerto: number;
  const password = "ClaveDePrueba123";

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;

    const agente = request.agent(app);
    const login = await agente
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });
    const setCookie = login.headers["set-cookie"];
    cookie = (Array.isArray(setCookie) ? setCookie : [setCookie])
      .map((c) => c.split(";")[0])
      .join("; ");

    await new Promise<void>((resolve) => {
      servidor = app.listen(0, () => {
        puerto = (servidor.address() as { port: number }).port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => servidor.close(() => resolve()));
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  /** Abre el stream y devuelve los trozos que lleguen hasta el timeout. No
   *  espera a que la respuesta termine: un SSE sano NUNCA termina. */
  function escucharStream(
    ms: number
  ): Promise<{ recibido: string; headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: puerto,
          path: "/api/eventos/stream",
          // Como un navegador: TODOS piden gzip. Sin esta cabecera el
          // middleware de compresión nunca actúa, y el test pasaba aunque en
          // el navegador los eventos se quedaran retenidos en el compresor.
          headers: { Cookie: cookie, "Accept-Encoding": "gzip, deflate, br" },
        },
        (res) => {
          let recibido = "";
          res.on("data", (trozo) => {
            recibido += trozo.toString();
          });
          setTimeout(() => {
            req.destroy();
            resolve({ recibido, headers: res.headers });
          }, ms);
        }
      );
      req.on("error", (err) => {
        // `destroy()` corta la conexión a propósito: ese error no es fallo.
        if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") reject(err);
      });
      req.end();
    });
  }

  it("un evento publicado después de conectar llega al stream", async () => {
    const escucha = escucharStream(3000);
    // Un respiro para que la suscripción a Redis quede establecida antes de
    // publicar: sin esto el evento saldría al vacío y el test sería flaky.
    await new Promise((r) => setTimeout(r, 500));

    await publicarEventoTenant(tenantId, "combustible.alerta_creada", {
      tipo: "descuadre_inventario",
      combustibleId: 1,
    });

    const { recibido } = await escucha;
    expect(recibido).toContain("event: combustible.alerta_creada");
    expect(recibido).toContain("descuadre_inventario");
  });

  it("la respuesta NO va comprimida: comprimir un stream lo bufferea y no llega nada", async () => {
    // `compression` está aplicado globalmente en app.ts y bufferea hasta
    // juntar 1 KB. Este test decía que el middleware salteaba solo el
    // `text/event-stream`, pero NO mandaba `Accept-Encoding`, así que el
    // compresor nunca entraba en juego. Con la cabecera que manda cualquier
    // navegador, el stream SÍ salía comprimido y los eventos (de pocos
    // bytes) no llegaban nunca: la campanita vivía del repaso cada 60 s.
    const { headers } = await escucharStream(800);
    expect(headers["content-type"]).toContain("text/event-stream");
    expect(headers["content-encoding"]).toBeUndefined();
  });

  it("manda la cabecera que evita el buffering de proxies intermedios", async () => {
    // Railway (y cualquier nginx de por medio) bufferea por defecto: sin
    // esto el stream llega igual de tarde aunque el servidor lo mande bien.
    const { headers } = await escucharStream(800);
    expect(headers["x-accel-buffering"]).toBe("no");
  });
});
