/** tests/viajes-rutas-modulo.test.ts
 *
 * Las rutas de Viajes y Lugares tienen dos puertas: /api/erp/viajes/... (el
 * módulo `viajes`) y /api/erp/combustible/viajes/... (el alias que sigue
 * vivo para el cliente actual y para las marcas que los celulares dejaron en la
 * cola offline). Lo que se fija acá:
 *
 * 1. Que las dos puertas respondan lo mismo para quien tiene ambos módulos.
 * 2. Que la puerta NUEVA exija el módulo `viajes` y el alias siga exigiendo
 *    solo Combustible (Compra en ruta no puede depender de Viajes).
 * 3. Que el nivel "consultas" siga sin escribir por la puerta nueva.
 * 4. Que los permisos de pestaña no hayan cambiado: el conductor entra a
 *    "Mi viaje" y no a la lista de viajes de la oficina, por las dos puertas.
 * 5. Que el rollout por porcentaje deje a cada usuario dentro o fuera de
 *    Combustible y Viajes a la vez.
 * 6. Que la cola offline reconozca las rutas nuevas y las viejas.
 */
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { pool, withTenant, closeDatabase } from "../src/server/config/database";
import { env } from "../src/server/config/env";
import { MODULOS } from "../src/modules/registry";
import { obtenerModulosPermitidos } from "../src/server/services/auth.service";
import { moduloParaEncolar } from "../client/src/offline/rutasOffline";

const BEARER = `Bearer ${env.platformAdminToken}`;
const PASSWORD = "ClaveDePrueba123";

type Empresa = Awaited<ReturnType<typeof crearTenantDePrueba>>;

describe("rutas de Viajes: las dos puertas", () => {
  const empresas: Empresa[] = [];
  const nueva = async () => {
    const e = await crearTenantDePrueba(PASSWORD);
    empresas.push(e);
    return e;
  };
  const sesion = async (e: Empresa, email = e.usuario.email) => {
    const agente = request.agent(app);
    const res = await agente
      .post("/api/auth/login")
      .send({ tenantSlug: e.tenant.slug, email, password: PASSWORD });
    expect(res.status).toBe(200);
    return agente;
  };
  const ponerModulos = (e: Empresa, estados: Record<string, "habilitado" | "deshabilitado">) =>
    request(app)
      .put(`/api/platform/tenants/${e.tenant.id}/modulos`)
      .set("Authorization", BEARER)
      .send({
        configuraciones: MODULOS.map((m) => ({
          modulo: m.id,
          estado: estados[m.id] ?? "habilitado",
        })),
      });

  afterAll(async () => {
    for (const e of empresas) await borrarTenantDePrueba(e.tenant.id);
    await closeDatabase();
  });

  it("con los dos módulos, las dos puertas responden igual (lista, lugares, Mi viaje, conductores)", async () => {
    const e = await nueva();
    const admin = await sesion(e);
    const pares: [string, string][] = [
      ["/api/erp/viajes", "/api/erp/combustible/viajes"],
      ["/api/erp/viajes/lugares", "/api/erp/combustible/lugares"],
      ["/api/erp/viajes/mios", "/api/erp/combustible/viajes/mios"],
      ["/api/erp/viajes/conductores", "/api/erp/combustible/viajes/conductores"],
      ["/api/erp/viajes/resumen-conductores", "/api/erp/combustible/viajes/resumen-conductores"],
    ];
    for (const [nuevaRuta, vieja] of pares) {
      const a = await admin.get(nuevaRuta);
      const b = await admin.get(vieja);
      expect(a.status, nuevaRuta).toBe(200);
      expect(b.status, vieja).toBe(200);
      expect(a.body, nuevaRuta).toEqual(b.body);
    }
  });

  it("una escritura por la puerta nueva hace lo mismo que por el alias (crear un lugar)", async () => {
    const e = await nueva();
    const admin = await sesion(e);
    const porNueva = await admin
      .post("/api/erp/viajes/lugares")
      .send({ nombre: idUnico("Mina N") });
    const porVieja = await admin
      .post("/api/erp/combustible/lugares")
      .send({ nombre: idUnico("Mina V") });
    expect(porNueva.status).toBe(201);
    expect(porVieja.status).toBe(201);

    const todos = await admin.get("/api/erp/viajes/lugares");
    expect(todos.body.data).toHaveLength(2);
  });

  it("sin el módulo `viajes`: la puerta nueva da 403, el alias sigue y Compra en ruta sigue eligiendo su unidad", async () => {
    const e = await nueva();
    expect((await ponerModulos(e, { viajes: "deshabilitado" })).status).toBe(200);
    const admin = await sesion(e); // sesión nueva: los módulos viajan en el token

    const nuevaPuerta = await admin.get("/api/erp/viajes");
    expect(nuevaPuerta.status).toBe(403);
    expect(nuevaPuerta.body.message).toMatch(/Módulo no disponible/);
    expect((await admin.post("/api/erp/viajes/lugares").send({ nombre: "X" })).status).toBe(403);

    // El alias vive bajo Combustible: no depende de Viajes.
    expect((await admin.get("/api/erp/combustible/viajes")).status).toBe(200);
    // Lo que usa "Compra en ruta" para precargar la unidad del viaje.
    expect((await admin.get("/api/erp/combustible/viajes/mi-unidad")).status).toBe(200);
  });

  it("sin el módulo Combustible, la puerta nueva NO deja leer las cargas (lista, detalle, consumo, Mi viaje) pero sí programar y ver lugares", async () => {
    const e = await nueva();
    expect((await ponerModulos(e, { combustible: "deshabilitado" })).status).toBe(200);
    const admin = await sesion(e);

    // `pestanaPermitida` no comprueba el módulo: lo exige la propia puerta.
    for (const ruta of [
      "/api/erp/viajes",
      "/api/erp/viajes/resumen-conductores",
      "/api/erp/viajes/consumo",
      "/api/erp/viajes/1",
      "/api/erp/viajes/mios",
      "/api/erp/viajes/mios/historial",
    ]) {
      const res = await admin.get(ruta);
      expect(res.status, ruta).toBe(403);
      expect(res.body.message, ruta).toMatch(/Módulo no disponible/);
    }
    // Lo que no lee cargas sigue disponible: el catálogo de lugares y el alta.
    expect((await admin.get("/api/erp/viajes/lugares")).status).toBe(200);
    expect((await admin.get("/api/erp/viajes/conductores")).status).toBe(200);
    // El alias ya exigía Combustible por su propio montaje.
    expect((await admin.get("/api/erp/combustible/viajes")).status).toBe(403);
  });

  it("sin Flota (y por lo tanto sin Viajes) la puerta nueva da 403", async () => {
    const e = await nueva();
    expect(
      (await ponerModulos(e, { flota: "deshabilitado", viajes: "deshabilitado" })).status
    ).toBe(200);
    const admin = await sesion(e);
    expect((await admin.get("/api/erp/viajes")).status).toBe(403);
    expect((await admin.get("/api/erp/combustible/viajes")).status).toBe(200);
  });

  it("en nivel `consultas` de Viajes lee por la puerta nueva y NO escribe", async () => {
    const e = await nueva();
    await pool.query(
      `UPDATE usuario_modulos SET nivel = 'consultas' WHERE usuario_id = $1 AND modulo = 'viajes'`,
      [e.usuario.id]
    );
    const admin = await sesion(e);
    expect((await admin.get("/api/erp/viajes")).status).toBe(200);
    const escribe = await admin.post("/api/erp/viajes/lugares").send({ nombre: "X" });
    expect(escribe.status).toBe(403);
    expect(escribe.body.message).toMatch(/consultar/);
  });

  it("el conductor de ruta entra a Mi viaje y NO a la lista de la oficina, por las dos puertas", async () => {
    const e = await nueva();
    const admin = await sesion(e);
    const email = `${idUnico("conductor")}@test.local`;
    const alta = await admin.post("/api/erp/usuarios").send({
      nombre: "Conductor de prueba",
      email,
      password: PASSWORD,
      rol: "conductor_ruta",
      dni: "12345678",
    });
    expect(alta.status).toBe(201);
    const conductor = await sesion(e, email);

    for (const ruta of ["/api/erp/viajes/mios", "/api/erp/combustible/viajes/mios"]) {
      expect((await conductor.get(ruta)).status, ruta).toBe(200);
    }
    for (const ruta of ["/api/erp/viajes", "/api/erp/combustible/viajes"]) {
      expect((await conductor.get(ruta)).status, ruta).toBe(403);
    }
    // Y no puede crear nada: no tiene los módulos ni los roles de la oficina.
    expect((await conductor.post("/api/erp/viajes/lugares").send({ nombre: "X" })).status).toBe(
      403
    );
  });

  describe("rollout por porcentaje", () => {
    it("cada usuario queda dentro o fuera de Combustible, Viajes y Flota A LA VEZ", async () => {
      const e = await nueva();
      await pool.query(
        `UPDATE tenant_modulos SET estado = 'rollout', rollout_porcentaje = 40
          WHERE tenant_id = $1 AND modulo IN ('combustible', 'flota', 'viajes')`,
        [e.tenant.id]
      );
      const ids: string[] = [];
      await withTenant(e.tenant.id, async (c) => {
        for (let i = 0; i < 40; i++) {
          const u = await c.query(
            `INSERT INTO usuarios (tenant_id, nombre, dni, rol) VALUES ($1, $2, $3, 'operador') RETURNING id`,
            [e.tenant.id, `Rollout ${i}`, String(70000000 + i)]
          );
          ids.push(u.rows[0].id);
        }
      });
      await pool.query(
        `INSERT INTO usuario_modulos (usuario_id, modulo, nivel)
         SELECT u, m, 'operar' FROM unnest($1::uuid[]) AS u, unnest(ARRAY['combustible','flota','viajes']::modulo_erp[]) AS m
         ON CONFLICT DO NOTHING`,
        [ids]
      );

      let dentro = 0;
      for (const id of ids) {
        const ve = await obtenerModulosPermitidos(id, e.tenant.id, "operador");
        expect(ve.includes("viajes"), `viajes, usuario ${id}`).toBe(ve.includes("combustible"));
        // La pantalla de Viajes elige la unidad de Flota: no pueden separarse.
        expect(ve.includes("flota"), `flota, usuario ${id}`).toBe(ve.includes("combustible"));
        if (ve.includes("combustible")) dentro++;
      }
      // Con el 40 % hay gente dentro y gente fuera: si no, la comparación de arriba no probaría nada.
      expect(dentro).toBeGreaterThan(0);
      expect(dentro).toBeLessThan(ids.length);
    });
  });

  describe("cola offline", () => {
    it("reconoce las marcas de Mi viaje por la puerta nueva y por la vieja", () => {
      for (const sufijo of [
        "iniciar-mio",
        "cerrar-mio",
        "llegada-mia",
        "salida-mia",
        "descanso-mio",
        "descanso-mio/terminar",
        "mando/entregar",
        "mando/aceptar",
        "mando/retirar",
      ]) {
        expect(moduloParaEncolar(`/api/erp/viajes/12/${sufijo}`, "POST"), sufijo).toBe("viajes");
        expect(moduloParaEncolar(`/api/erp/combustible/viajes/12/${sufijo}`, "POST"), sufijo).toBe(
          "combustible"
        );
      }
    });

    it("NO encola lo que programa la oficina ni las lecturas", () => {
      expect(moduloParaEncolar("/api/erp/viajes", "POST")).toBeNull();
      expect(moduloParaEncolar("/api/erp/viajes/12/iniciar", "POST")).toBeNull();
      expect(moduloParaEncolar("/api/erp/viajes/lugares", "POST")).toBeNull();
      expect(moduloParaEncolar("/api/erp/viajes/12/iniciar-mio", "GET")).toBeNull();
    });
  });
});
