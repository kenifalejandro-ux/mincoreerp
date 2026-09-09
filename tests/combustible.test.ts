/** tests/combustible.test.ts
 *
 * Hasta la Fase A (migrations/0057) el módulo no tenía POST de creación
 * (ver combustible.routes.ts: solo GET y PUT /:id/nivel) -- los tanques se
 * cargaban directo en la base. El helper de abajo sigue insertando con
 * withTenant() para los tests de lecturas/nivel (no dependen de la validación
 * Zod del ABM nuevo), pero ya completa las columnas NOT NULL que agregó
 * 0057 -- sin esto, el INSERT crudo revienta.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { crearUsuarioService } from "../src/server/services/auth.service";
import { closeDatabase, withTenant } from "../src/server/config/database";
import { MAX_FILAS_CARGA_MASIVA_TANQUES } from "../src/server/schemas/combustible.schema";

/** El nivel va como LECTURA y no como columna del tanque: desde la migración
 *  0059 `combustible.nivel_actual` no existe -- el nivel se deriva de la
 *  última lectura vigente. Un tanque sin lecturas no tiene nivel que
 *  mostrar, así que el helper crea las dos filas. */
async function crearTanque(
  tenantId: string,
  data: { tanqueNombre: string; capacidadTotal: number; nivelActual: number }
): Promise<number> {
  return withTenant(tenantId, async (client) => {
    const fila = await client.query(
      `INSERT INTO combustible (
         tenant_id, codigo, tanque_nombre, tipo_combustible, unidad, tipo_punto,
         capacidad_total
       )
       VALUES ($1, $2, $3, 'diesel_b5', 'gal', 'fijo', $4) RETURNING id`,
      [tenantId, idUnico("TQ"), data.tanqueNombre, data.capacidadTotal]
    );
    const id = fila.rows[0].id;
    await client.query(
      `INSERT INTO combustible_lecturas (tenant_id, combustible_id, nivel, leido_en, origen)
       VALUES ($1, $2, $3, NOW(), 'inicial')`,
      [tenantId, id, data.nivelActual]
    );
    return id;
  });
}

/** El nivel vigente de un tanque leído directo de la base -- para asertar
 *  sin pasar por la API (ej. verificar que un tenant NO pudo tocar el
 *  tanque de otro). Reemplaza al viejo `SELECT nivel_actual FROM
 *  combustible`, que ya no existe. */
async function nivelEnBase(tenantId: string, combustibleId: number): Promise<number | null> {
  const res = await withTenant(tenantId, (client) =>
    client.query(
      `SELECT nivel FROM combustible_lecturas
       WHERE combustible_id = $1 AND anulada_en IS NULL
       ORDER BY leido_en DESC, id DESC LIMIT 1`,
      [combustibleId]
    )
  );
  return res.rows[0] ? Number(res.rows[0].nivel) : null;
}

/** Payload mínimo válido para POST /api/erp/combustible -- reutilizado por
 *  los tests de CRUD de abajo. Trae también nivel_minimo/moneda/activo:
 *  crearTanqueCombustibleSchema los tiene con default y los ignora si
 *  sobran, pero actualizarTanqueCombustibleSchema (PUT) los EXIGE -- este
 *  mismo payload sirve para los dos sin duplicar el helper. */
function payloadTanque(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    codigo: idUnico("TQ"),
    tanque_nombre: "Tanque de prueba",
    tipo_combustible: "diesel_b5",
    unidad: "gal",
    tipo_punto: "fijo",
    capacidad_total: 1000,
    nivel_minimo: 0,
    moneda: "PEN",
    activo: true,
    // Fase C (migrations/0064) -- mismo caso que moneda/activo: el POST los
    // completa por default, el PUT los exige.
    tolerancia_capacidad_pct: 0,
    requiere_documento: true,
    umbral_diferencia_pct: null,
    umbral_descuadre_pct: null,
    umbral_descuadre_ciclo_pct: null,
    umbral_descuadre_ventana_pct: null,
    ...overrides,
  };
}

describe("combustible: lectura, actualización de nivel y reglas de negocio", () => {
  let tenantId: string;
  let tenantSlug: string;
  let tanqueId: number;
  const password = "ClaveDePrueba123";
  const agentAdmin = request.agent(app);

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    tenantSlug = creado.tenant.slug;
    await agentAdmin
      .post("/api/auth/login")
      .send({ tenantSlug, email: creado.usuario.email, password });

    tanqueId = await crearTanque(tenantId, {
      tanqueNombre: "Tanque principal",
      capacidadTotal: 1000,
      nivelActual: 250,
    });
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
  });

  it("lista tanques y calcula 'porcentaje' en la BD, no en la app", async () => {
    const res = await agentAdmin.get("/api/erp/combustible");
    expect(res.status).toBe(200);
    const tanque = res.body.find((t: { id: number }) => t.id === tanqueId);
    expect(tanque).toBeTruthy();
    expect(Number(tanque.porcentaje)).toBe(25); // 250/1000 * 100
  });

  it("GET /:id devuelve el tanque con su porcentaje", async () => {
    const res = await agentAdmin.get(`/api/erp/combustible/${tanqueId}`);
    expect(res.status).toBe(200);
    expect(Number(res.body.porcentaje)).toBe(25);
  });

  it("GET /:id de un tanque inexistente da 404", async () => {
    const res = await agentAdmin.get("/api/erp/combustible/999999999");
    expect(res.status).toBe(404);
  });

  it("PUT /:id/nivel actualiza nivel_actual y recalcula porcentaje", async () => {
    const res = await agentAdmin
      .put(`/api/erp/combustible/${tanqueId}/nivel`)
      .send({ nivel_actual: 800 });
    expect(res.status).toBe(200);
    expect(Number(res.body.nivel_actual)).toBe(800);
    expect(Number(res.body.porcentaje)).toBe(80); // 800/1000 * 100
  });

  it("PUT nivel de un tanque inexistente da 404", async () => {
    const res = await agentAdmin
      .put("/api/erp/combustible/999999999/nivel")
      .send({ nivel_actual: 500 });
    expect(res.status).toBe(404);
  });

  it("PUT /:id/nivel deja rastro en el historial, no solo sobreescribe nivel_actual", async () => {
    const antes = await withTenant(tenantId, (client) =>
      client.query(
        `SELECT COUNT(*)::int AS total FROM combustible_lecturas WHERE combustible_id = $1`,
        [tanqueId]
      )
    );

    const res = await agentAdmin
      .put(`/api/erp/combustible/${tanqueId}/nivel`)
      .send({ nivel_actual: 900 });
    expect(res.status).toBe(200);
    expect(Number(res.body.nivel_actual)).toBe(900);

    const despues = await withTenant(tenantId, (client) =>
      client.query(
        `SELECT COUNT(*)::int AS total FROM combustible_lecturas WHERE combustible_id = $1`,
        [tanqueId]
      )
    );
    expect(despues.rows[0].total).toBe(antes.rows[0].total + 1);
  });

  it("un usuario con rol 'lectura' no puede actualizar el nivel (403), pero sí puede leer", async () => {
    const email = `lectura-combustible-${Date.now()}@test.local`;
    await withTenant(tenantId, (client) =>
      crearUsuarioService(
        { tenantId, nombre: "Solo lectura", email, password, rol: "lectura" },
        client
      )
    );

    const agentLectura = request.agent(app);
    await agentLectura.post("/api/auth/login").send({ tenantSlug, email, password });

    const lectura = await agentLectura.get("/api/erp/combustible");
    expect(lectura.status).toBe(200);

    const intentoUpdate = await agentLectura
      .put(`/api/erp/combustible/${tanqueId}/nivel`)
      .send({ nivel_actual: 100 });
    expect(intentoUpdate.status).toBe(403);
  });
});

describe("combustible: aislamiento entre tenants", () => {
  let tenantAId: string;
  let tenantBId: string;
  const password = "ClaveDePrueba123";

  afterAll(async () => {
    await borrarTenantDePrueba(tenantAId);
    await borrarTenantDePrueba(tenantBId);
  });

  it("un tenant no ve ni puede actualizar el tanque de otro", async () => {
    const a = await crearTenantDePrueba(password);
    const b = await crearTenantDePrueba(password);
    tenantAId = a.tenant.id;
    tenantBId = b.tenant.id;

    const tanqueDeB = await crearTanque(tenantBId, {
      tanqueNombre: "Tanque de B",
      capacidadTotal: 500,
      nivelActual: 100,
    });

    const agentA = request.agent(app);
    await agentA
      .post("/api/auth/login")
      .send({ tenantSlug: a.tenant.slug, email: a.usuario.email, password });

    const listadoDeA = await agentA.get("/api/erp/combustible");
    expect(listadoDeA.body.find((t: { id: number }) => t.id === tanqueDeB)).toBeUndefined();

    const getDirecto = await agentA.get(`/api/erp/combustible/${tanqueDeB}`);
    expect(getDirecto.status).toBe(404);

    const updateAjeno = await agentA
      .put(`/api/erp/combustible/${tanqueDeB}/nivel`)
      .send({ nivel_actual: 0 });
    expect(updateAjeno.status).toBe(404);

    // El nivel de B no debe haber cambiado a pesar del intento.
    expect(await nivelEnBase(tenantBId, tanqueDeB)).toBe(100);
  });

  it("un tenant no puede editar ni desactivar el tanque de otro (404)", async () => {
    const a = await crearTenantDePrueba(password);
    const b = await crearTenantDePrueba(password);
    tenantAId = a.tenant.id;
    tenantBId = b.tenant.id;

    const tanqueDeB = await crearTanque(tenantBId, {
      tanqueNombre: "Tanque de B",
      capacidadTotal: 500,
      nivelActual: 100,
    });

    const agentA = request.agent(app);
    await agentA
      .post("/api/auth/login")
      .send({ tenantSlug: a.tenant.slug, email: a.usuario.email, password });

    const updateAjeno = await agentA
      .put(`/api/erp/combustible/${tanqueDeB}`)
      .send(payloadTanque({ tanque_nombre: "Hackeado" }));
    expect(updateAjeno.status).toBe(404);

    const deleteAjeno = await agentA
      .delete(`/api/erp/combustible/${tanqueDeB}`)
      .send({ motivo: "Intento de baja cruzada entre tenants" });
    expect(deleteAjeno.status).toBe(404);

    const filaB = await withTenant(tenantBId, (client) =>
      client.query(`SELECT tanque_nombre, activo FROM combustible WHERE id = $1`, [tanqueDeB])
    );
    expect(filaB.rows[0].tanque_nombre).toBe("Tanque de B");
    expect(filaB.rows[0].activo).toBe(true);
  });
});

describe("combustible: ABM de tanques (Fase A)", () => {
  let tenantId: string;
  const password = "ClaveDePrueba123";
  const agent = request.agent(app);

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await agent
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
  });

  it("crea un tanque con los campos mínimos -- defaults de nivel_actual/nivel_minimo/moneda", async () => {
    const res = await agent.post("/api/erp/combustible").send(payloadTanque());
    expect(res.status).toBe(201);
    expect(Number(res.body.nivel_actual)).toBe(0);
    expect(Number(res.body.nivel_minimo)).toBe(0);
    expect(res.body.moneda).toBe("PEN");
    expect(res.body.activo).toBe(true);
    expect(Number(res.body.costo_promedio)).toBe(0);
    expect(Number(res.body.porcentaje)).toBe(0);
  });

  it("rechaza un tipo_combustible fuera del enum", async () => {
    const res = await agent
      .post("/api/erp/combustible")
      .send(payloadTanque({ tipo_combustible: "gasolina_84" }));
    expect(res.status).toBe(400);
  });

  it("rechaza capacidad_total <= 0 (guarda del schema, antes de tocar la base)", async () => {
    const res = await agent
      .post("/api/erp/combustible")
      .send(payloadTanque({ capacidad_total: 0 }));
    expect(res.status).toBe(400);
  });

  it("rechaza un código duplicado dentro del mismo tenant", async () => {
    const codigo = idUnico("DUP");
    const primero = await agent.post("/api/erp/combustible").send(payloadTanque({ codigo }));
    expect(primero.status).toBe(201);

    const segundo = await agent.post("/api/erp/combustible").send(payloadTanque({ codigo }));
    expect(segundo.status).toBe(500);
  });

  it("rechaza crear un tanque con nivel_actual mayor que capacidad_total + tolerancia", async () => {
    // 21.000 sobre una capacidad de 20.000 y tolerancia 0%: la misma
    // contradicción física que bloquea una recepción, pero en el alta.
    const res = await agent
      .post("/api/erp/combustible")
      .send(
        payloadTanque({ capacidad_total: 20000, nivel_actual: 21000, tolerancia_capacidad_pct: 0 })
      );
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("supera la capacidad del tanque");
  });

  it("acepta crear un tanque con nivel_actual dentro de la tolerancia declarada", async () => {
    const res = await agent
      .post("/api/erp/combustible")
      .send(
        payloadTanque({ capacidad_total: 20000, nivel_actual: 21000, tolerancia_capacidad_pct: 10 })
      );
    expect(res.status).toBe(201);
    expect(Number(res.body.nivel_actual)).toBe(21000);
  });

  it("rechaza bajar capacidad_total por PUT si el nivel actual del tanque ya la supera", async () => {
    const creado = await agent
      .post("/api/erp/combustible")
      .send(payloadTanque({ capacidad_total: 20000, nivel_actual: 15000 }));
    expect(creado.status).toBe(201);

    // Bajar la capacidad a 10.000 deja el nivel real (15.000) por encima --
    // mismo hueco que el nivel inicial, pero abierto por PUT en vez de POST.
    const res = await agent.put(`/api/erp/combustible/${creado.body.id}`).send({
      codigo: creado.body.codigo,
      tanque_nombre: creado.body.tanque_nombre,
      tipo_combustible: creado.body.tipo_combustible,
      unidad: creado.body.unidad,
      tipo_punto: creado.body.tipo_punto,
      capacidad_total: 10000,
      nivel_minimo: 0,
      moneda: "PEN",
      activo: true,
      tolerancia_capacidad_pct: 0,
      requiere_documento: true,
      umbral_diferencia_pct: null,
      umbral_descuadre_pct: null,
      umbral_descuadre_ciclo_pct: null,
      umbral_descuadre_ventana_pct: null,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("supera la capacidad que estás por guardar");
  });

  it("actualiza un tanque -- PUT no acepta nivel_actual, ese camino es /lecturas", async () => {
    const creado = await agent.post("/api/erp/combustible").send(payloadTanque());
    const res = await agent.put(`/api/erp/combustible/${creado.body.id}`).send({
      codigo: creado.body.codigo,
      tanque_nombre: "Editado",
      tipo_combustible: "gasolina_90",
      unidad: "L",
      tipo_punto: "surtidor",
      // Subir la capacidad ensancha todas las bandas (los umbrales son % de
      // ella), así que desde el PR de la bitácora cuenta como aflojar y pide
      // motivo. Este test no es sobre eso -- lo declara y sigue.
      capacidad_total: 2000,
      motivo_ajuste: "Se reemplazó el tanque por uno más grande",
      nivel_minimo: 50,
      moneda: "USD",
      activo: true,
      tolerancia_capacidad_pct: 0,
      requiere_documento: true,
      umbral_diferencia_pct: null,
      umbral_descuadre_pct: null,
      umbral_descuadre_ciclo_pct: null,
      umbral_descuadre_ventana_pct: null,
    });
    expect(res.status).toBe(200);
    expect(res.body.tanque_nombre).toBe("Editado");
    expect(res.body.tipo_punto).toBe("surtidor");
    // nivel_actual sigue el que tenía antes de editar, no lo tocó el PUT.
    expect(Number(res.body.nivel_actual)).toBe(0);
  });

  it("PUT /:id de un tanque inexistente da 404", async () => {
    const res = await agent.put("/api/erp/combustible/999999999").send(payloadTanque());
    expect(res.status).toBe(404);
  });

  it("DELETE es soft-delete: la fila y su historial de lecturas sobreviven", async () => {
    const creado = await agent.post("/api/erp/combustible").send(payloadTanque());
    const tanqueId = creado.body.id;

    await agent.post("/api/erp/combustible/lecturas").send({
      combustible_id: tanqueId,
      nivel: 42,
    });

    // Desde 0078 la baja exige motivo: es una reducción de vigilancia y queda
    // en la bitácora como tal, no como una edición más.
    const del = await agent
      .delete(`/api/erp/combustible/${tanqueId}`)
      .send({ motivo: "Tanque retirado de la sede" });
    expect(del.status).toBe(200);

    const filaDirecta = await withTenant(tenantId, (client) =>
      client.query(`SELECT activo FROM combustible WHERE id = $1`, [tanqueId])
    );
    expect(filaDirecta.rows[0].activo).toBe(false);

    const lecturas = await withTenant(tenantId, (client) =>
      client.query(
        `SELECT COUNT(*)::int AS total FROM combustible_lecturas WHERE combustible_id = $1`,
        [tanqueId]
      )
    );
    expect(lecturas.rows[0].total).toBeGreaterThan(0);

    // El tanque desactivado sigue apareciendo en el listado (soft-delete,
    // no desaparece) -- distinto de un DELETE real.
    const listado = await agent.get("/api/erp/combustible");
    const fila = listado.body.find((t: { id: number }) => t.id === tanqueId);
    expect(fila).toBeTruthy();
    expect(fila.activo).toBe(false);
  });

  it("DELETE de un tanque inexistente da 404", async () => {
    const res = await agent
      .delete("/api/erp/combustible/999999999")
      .send({ motivo: "Baja de un tanque que no existe" });
    expect(res.status).toBe(404);
  });

  it("un usuario con rol 'lectura' no puede crear tanques (403) pero sí puede listarlos", async () => {
    const email = `lectura-tanques-${Date.now()}@test.local`;
    const tenantSlugRes = await withTenant(tenantId, (client) =>
      client.query(`SELECT slug FROM tenants WHERE id = $1`, [tenantId])
    );
    await withTenant(tenantId, (client) =>
      crearUsuarioService(
        { tenantId, nombre: "Solo lectura", email, password, rol: "lectura" },
        client
      )
    );

    const agentLectura = request.agent(app);
    await agentLectura
      .post("/api/auth/login")
      .send({ tenantSlug: tenantSlugRes.rows[0].slug, email, password });

    const intento = await agentLectura.post("/api/erp/combustible").send(payloadTanque());
    expect(intento.status).toBe(403);

    const listado = await agentLectura.get("/api/erp/combustible");
    expect(listado.status).toBe(200);
  });

  it("carga masiva (bulk) inserta varios tanques y reimportar el mismo código actualiza", async () => {
    const codigo = idUnico("BULK");
    const primera = await agent
      .post("/api/erp/combustible/bulk")
      .send([payloadTanque({ codigo, tanque_nombre: "Versión 1" })]);
    expect(primera.status).toBe(201);
    expect(primera.body.insertados).toBe(1);

    const segunda = await agent
      .post("/api/erp/combustible/bulk")
      .send([payloadTanque({ codigo, tanque_nombre: "Versión 2" })]);
    expect(segunda.status).toBe(201);

    const listado = await agent.get("/api/erp/combustible");
    const filasConEseCodigo = listado.body.filter((t: { codigo: string }) => t.codigo === codigo);
    expect(filasConEseCodigo).toHaveLength(1);
    expect(filasConEseCodigo[0].tanque_nombre).toBe("Versión 2");
  });

  it("bulk rechaza un array vacío", async () => {
    const res = await agent.post("/api/erp/combustible/bulk").send([]);
    expect(res.status).toBe(400);
  });

  it("bulk rechaza más filas que el máximo permitido", async () => {
    const filas = Array.from({ length: MAX_FILAS_CARGA_MASIVA_TANQUES + 1 }, (_, i) =>
      payloadTanque({ codigo: `MAX-${i}` })
    );
    const res = await agent.post("/api/erp/combustible/bulk").send(filas);
    expect(res.status).toBe(400);
  });

  it("GET /:id/lecturas devuelve el histórico paginado del tanque", async () => {
    const creado = await agent.post("/api/erp/combustible").send(payloadTanque());
    const tanqueId = creado.body.id;

    await agent.post("/api/erp/combustible/lecturas").send({ combustible_id: tanqueId, nivel: 10 });
    await agent.post("/api/erp/combustible/lecturas").send({ combustible_id: tanqueId, nivel: 20 });

    const res = await agent.get(`/api/erp/combustible/${tanqueId}/lecturas`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
    expect(res.body.pagination.total).toBeGreaterThanOrEqual(2);
  });

  it("GET /:id/lecturas de un tanque inexistente da 404", async () => {
    const res = await agent.get("/api/erp/combustible/999999999/lecturas");
    expect(res.status).toBe(404);
  });
});

describe("combustible: una lectura no puede superar la capacidad del tanque", () => {
  let tenantId: string;
  const password = "ClaveDePrueba123";
  const agent = request.agent(app);
  let tanqueId: number;

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await agent
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });

    const tanque = await agent
      .post("/api/erp/combustible")
      .send(payloadTanque({ capacidad_total: 1000 }));
    tanqueId = tanque.body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
  });

  it("rechaza con 400 una lectura mayor que la capacidad, y NO la guarda", async () => {
    const res = await agent
      .post("/api/erp/combustible/lecturas")
      .send({ combustible_id: tanqueId, nivel: 5000 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/capacidad/i);

    // Ni la lectura entró al historial ni el tanque cambió de nivel.
    const lecturas = await agent.get(`/api/erp/combustible/${tanqueId}/lecturas`);
    expect(lecturas.body.data.some((l: { nivel: string }) => Number(l.nivel) === 5000)).toBe(false);
  });

  it("acepta una lectura EXACTAMENTE igual a la capacidad (el tanque lleno es válido)", async () => {
    const res = await agent
      .post("/api/erp/combustible/lecturas")
      .send({ combustible_id: tanqueId, nivel: 1000 });
    expect(res.status).toBe(201);
  });

  it("el endpoint legacy PUT /:id/nivel también bloquea, con 400 y no 404", async () => {
    // El legacy mapea "no existe en este tenant" a 404 por compatibilidad;
    // esto NO es eso -- el tanque existe, el dato es imposible.
    const res = await agent
      .put(`/api/erp/combustible/${tanqueId}/nivel`)
      .send({ nivel_actual: 99999 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/capacidad/i);
  });
});

describe("combustible: el historial dice QUIÉN registró cada lectura", () => {
  let tenantId: string;
  let nombreDelAdmin: string;
  const password = "ClaveDePrueba123";
  const agent = request.agent(app);

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    nombreDelAdmin = creado.usuario.nombre;
    await agent
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
  });

  it("una lectura manual trae el nombre de quien la registró", async () => {
    const t = await agent.post("/api/erp/combustible").send(payloadTanque());
    await agent
      .post("/api/erp/combustible/lecturas")
      .send({ combustible_id: t.body.id, nivel: 400 });

    const historial = await agent.get(`/api/erp/combustible/${t.body.id}/lecturas`);
    const manual = historial.body.data.find((l: { origen: string }) => l.origen === "manual");
    expect(manual.registrada_por_nombre).toBe(nombreDelAdmin);
  });

  it("la lectura `inicial` del alta no tiene autor: la genera el sistema, no una persona", async () => {
    const t = await agent.post("/api/erp/combustible").send(payloadTanque());
    const historial = await agent.get(`/api/erp/combustible/${t.body.id}/lecturas`);
    const inicial = historial.body.data.find((l: { origen: string }) => l.origen === "inicial");
    expect(inicial).toBeTruthy();
    expect(inicial.registrada_por_nombre).toBeNull();
  });

  it("una lectura ANULADA conserva a su autor original, además de quién la anuló", async () => {
    const t = await agent.post("/api/erp/combustible").send(payloadTanque());
    const lectura = await agent
      .post("/api/erp/combustible/lecturas")
      .send({ combustible_id: t.body.id, nivel: 400 });
    await agent
      .patch(`/api/erp/combustible/lecturas/${lectura.body.lectura.id}/anular`)
      .send({ motivo: "error de tipeo" });

    const historial = await agent.get(`/api/erp/combustible/${t.body.id}/lecturas`);
    const fila = historial.body.data.find((l: { id: number }) => l.id === lectura.body.lectura.id);
    // Los DOS nombres conviven: quién la cargó mal y quién la corrigió.
    // Perder el primero al anular sería tapar justo lo que hay que auditar.
    expect(fila.registrada_por_nombre).toBe(nombreDelAdmin);
    expect(fila.anulada_por_nombre).toBe(nombreDelAdmin);
  });
});

describe("combustible: el nivel siempre es la última lectura vigente (migración 0059)", () => {
  let tenantId: string;
  const password = "ClaveDePrueba123";
  const agent = request.agent(app);

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await agent
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
  });

  /** Los tres casos donde el UPDATE condicional viejo fallaba EN SILENCIO
   *  (ver el comentario de migrations/0059). Los tres tienen que aplicar
   *  ahora, porque el nivel ya no se guarda: se deriva. */

  it("dos lecturas con el MISMO leido_en: gana la última cargada", async () => {
    const t = await agent.post("/api/erp/combustible").send(payloadTanque());
    // Mismo instante exacto -- es lo que produce el input datetime-local del
    // formulario, que recorta a minutos.
    const momento = new Date(Date.now() + 60_000).toISOString();

    await agent
      .post("/api/erp/combustible/lecturas")
      .send({ combustible_id: t.body.id, nivel: 700, leido_en: momento });
    await agent
      .post("/api/erp/combustible/lecturas")
      .send({ combustible_id: t.body.id, nivel: 650, leido_en: momento });

    const res = await agent.get(`/api/erp/combustible/${t.body.id}`);
    expect(Number(res.body.nivel_actual)).toBe(650);
  });

  it("una lectura con la hora RECORTADA AL MINUTO justo después del alta no mueve el nivel", async () => {
    // Reproduce lo que hace el formulario: su input datetime-local recorta
    // los segundos. Si el tanque nació a las 15:36:42 y la lectura se
    // manda como 15:36:00, queda fechada ANTES del alta y el nivel sigue
    // siendo el inicial -- correcto según la regla ("gana la más reciente"),
    // pero sorprendente para quien acaba de cargarla.
    //
    // El frontend evita caer acá mandando la hora con segundos cuando el
    // operario NO tocó el campo (ver `horaEditadaAMano` en
    // CombustiblePanel.tsx). Este test fija el comportamiento del backend,
    // que es el que decide, y documenta por qué existe esa guarda.
    const t = await agent.post("/api/erp/combustible").send(payloadTanque({ nivel_actual: 900 }));
    const alMinuto = new Date();
    alMinuto.setSeconds(0, 0);

    const res = await agent.post("/api/erp/combustible/lecturas").send({
      combustible_id: t.body.id,
      nivel: 111,
      leido_en: alMinuto.toISOString(),
    });
    expect(res.status).toBe(201);

    const tanque = await agent.get(`/api/erp/combustible/${t.body.id}`);
    expect(Number(tanque.body.nivel_actual)).toBe(900);

    // La respuesta del POST ya trae el nivel resultante, que es lo que el
    // frontend usa para no anunciar un valor que la tabla contradice.
    expect(Number(res.body.tanque.nivel_actual)).toBe(900);
  });

  it("una lectura registrada en el mismo minuto que el alta del tanque sí aplica", async () => {
    const t = await agent.post("/api/erp/combustible").send(payloadTanque());
    // Sin leido_en: el service usa now(), que puede caer en el mismo
    // segundo que la creación. Antes eso hacía que el nivel no se moviera.
    const res = await agent
      .post("/api/erp/combustible/lecturas")
      .send({ combustible_id: t.body.id, nivel: 333 });
    expect(res.status).toBe(201);

    const tanque = await agent.get(`/api/erp/combustible/${t.body.id}`);
    expect(Number(tanque.body.nivel_actual)).toBe(333);
  });

  it("una lectura ANTERIOR a la última no pisa el nivel, pero sí queda en el historial", async () => {
    const t = await agent.post("/api/erp/combustible").send(payloadTanque());
    const base = Date.now();

    await agent.post("/api/erp/combustible/lecturas").send({
      combustible_id: t.body.id,
      nivel: 900,
      leido_en: new Date(base + 120_000).toISOString(),
    });
    // Llega después pero fue medida ANTES (corrección cargada tarde, o una
    // sincronización offline desordenada).
    await agent.post("/api/erp/combustible/lecturas").send({
      combustible_id: t.body.id,
      nivel: 400,
      leido_en: new Date(base + 60_000).toISOString(),
    });

    // El nivel sigue siendo el de la lectura MÁS RECIENTE en el tiempo, no
    // el de la última en llegar -- la protección offline se mantiene.
    const tanque = await agent.get(`/api/erp/combustible/${t.body.id}`);
    expect(Number(tanque.body.nivel_actual)).toBe(900);

    // Pero la lectura vieja no se perdió.
    const historial = await agent.get(`/api/erp/combustible/${t.body.id}/lecturas`);
    expect(historial.body.data.some((l: { nivel: string }) => Number(l.nivel) === 400)).toBe(true);
  });

  it("crear un tanque deja su nivel inicial en el historial, no solo en la ficha", async () => {
    const t = await agent.post("/api/erp/combustible").send(payloadTanque({ nivel_actual: 750 }));
    expect(Number(t.body.nivel_actual)).toBe(750);

    const historial = await agent.get(`/api/erp/combustible/${t.body.id}/lecturas`);
    const inicial = historial.body.data.find((l: { origen: string }) => l.origen === "inicial");
    expect(inicial).toBeTruthy();
    expect(Number(inicial.nivel)).toBe(750);
  });
});

describe("combustible: anulación de lecturas (migración 0058)", () => {
  let tenantId: string;
  let tenantSlug: string;
  const password = "ClaveDePrueba123";
  const agent = request.agent(app);

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    tenantSlug = creado.tenant.slug;
    await agent.post("/api/auth/login").send({ tenantSlug, email: creado.usuario.email, password });
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
  });

  /** Tanque nuevo + dos lecturas en orden cronológico. Devuelve los ids que
   *  hacen falta para anular y verificar el recálculo.
   *
   *  Los `leido_en` se calculan HACIA ADELANTE desde ahora, no con fechas
   *  fijas: `create` deja `fecha_actualizacion = NOW()`, y el UPDATE
   *  condicional de registrarLectura solo aplica una lectura si es
   *  POSTERIOR a esa marca. Con fechas fijas del pasado las lecturas se
   *  guardan pero no mueven `nivel_actual`, y el test mediría otra cosa. */
  async function tanqueConDosLecturas() {
    const tanque = await agent.post("/api/erp/combustible").send(payloadTanque());
    const base = Date.now();
    const primera = await agent.post("/api/erp/combustible/lecturas").send({
      combustible_id: tanque.body.id,
      nivel: 800,
      leido_en: new Date(base + 60_000).toISOString(),
    });
    const segunda = await agent.post("/api/erp/combustible/lecturas").send({
      combustible_id: tanque.body.id,
      nivel: 500,
      leido_en: new Date(base + 120_000).toISOString(),
    });
    return {
      tanqueId: tanque.body.id as number,
      primeraId: primera.body.lectura.id as number,
      segundaId: segunda.body.lectura.id as number,
    };
  }

  it("anular la lectura MÁS RECIENTE hace retroceder el nivel a la anterior", async () => {
    const { tanqueId, segundaId } = await tanqueConDosLecturas();

    const antes = await agent.get(`/api/erp/combustible/${tanqueId}`);
    expect(Number(antes.body.nivel_actual)).toBe(500);

    const res = await agent
      .patch(`/api/erp/combustible/lecturas/${segundaId}/anular`)
      .send({ motivo: "error de tipeo: se registró 500 en vez de 800" });
    expect(res.status).toBe(200);
    expect(res.body.lectura.anulada_en).toBeTruthy();

    // El nivel vuelve a la lectura vigente anterior -- esto es lo que el
    // UPDATE condicional de registrarLectura NO puede hacer solo (solo sabe
    // avanzar en el tiempo, ver recalcularNivelDesdeUltimaLectura).
    const despues = await agent.get(`/api/erp/combustible/${tanqueId}`);
    expect(Number(despues.body.nivel_actual)).toBe(800);
  });

  it("la lectura anulada NO se borra: sigue en el historial con su motivo y autor", async () => {
    const { tanqueId, segundaId } = await tanqueConDosLecturas();
    await agent
      .patch(`/api/erp/combustible/lecturas/${segundaId}/anular`)
      .send({ motivo: "se midió el tanque equivocado" });

    const historial = await agent.get(`/api/erp/combustible/${tanqueId}/lecturas`);
    const fila = historial.body.data.find((l: { id: number }) => l.id === segundaId);
    expect(fila).toBeTruthy();
    expect(Number(fila.nivel)).toBe(500); // el número original queda intacto
    expect(fila.motivo_anulacion).toBe("se midió el tanque equivocado");
    expect(fila.anulada_por_nombre).toBeTruthy();
  });

  it("anular una lectura que NO es la última deja el nivel donde está", async () => {
    const { tanqueId, primeraId } = await tanqueConDosLecturas();

    const res = await agent
      .patch(`/api/erp/combustible/lecturas/${primeraId}/anular`)
      .send({ motivo: "lectura vieja mal cargada" });
    expect(res.status).toBe(200);

    // La más reciente sigue vigente, así que manda ella.
    const despues = await agent.get(`/api/erp/combustible/${tanqueId}`);
    expect(Number(despues.body.nivel_actual)).toBe(500);
  });

  it("anular todas las lecturas manuales hace caer el nivel a la lectura inicial del alta", async () => {
    const { tanqueId, primeraId, segundaId } = await tanqueConDosLecturas();
    await agent
      .patch(`/api/erp/combustible/lecturas/${segundaId}/anular`)
      .send({ motivo: "anulo la segunda" });
    await agent
      .patch(`/api/erp/combustible/lecturas/${primeraId}/anular`)
      .send({ motivo: "anulo la primera" });

    // Crear el tanque genera una lectura `inicial` (migración 0059), que
    // sigue vigente -- el nivel cae a ella, no queda sin dato.
    const despues = await agent.get(`/api/erp/combustible/${tanqueId}`);
    expect(Number(despues.body.nivel_actual)).toBe(0);
  });

  it("sin NINGUNA lectura vigente el nivel es null, no 0: es desconocido, no vacío", async () => {
    const { tanqueId, primeraId, segundaId } = await tanqueConDosLecturas();
    const historial = await agent.get(`/api/erp/combustible/${tanqueId}/lecturas`);
    const inicial = historial.body.data.find((l: { origen: string }) => l.origen === "inicial");

    for (const id of [segundaId, primeraId, inicial.id]) {
      await agent.patch(`/api/erp/combustible/lecturas/${id}/anular`).send({ motivo: "anulo" });
    }

    const despues = await agent.get(`/api/erp/combustible/${tanqueId}`);
    // null y no 0: nadie midió el tanque, así que el nivel es desconocido.
    // Un 0 diría "está vacío", que es una afirmación distinta y falsa.
    expect(despues.body.nivel_actual).toBeNull();
    expect(despues.body.porcentaje).toBeNull();
  });

  it("el motivo es obligatorio: sin motivo, o vacío, rechaza con 400", async () => {
    const { segundaId } = await tanqueConDosLecturas();

    const sinMotivo = await agent
      .patch(`/api/erp/combustible/lecturas/${segundaId}/anular`)
      .send({});
    expect(sinMotivo.status).toBe(400);

    const vacio = await agent
      .patch(`/api/erp/combustible/lecturas/${segundaId}/anular`)
      .send({ motivo: "   " });
    expect(vacio.status).toBe(400);
  });

  it("anular dos veces la misma lectura da 409, sin pisar el motivo original", async () => {
    const { tanqueId, segundaId } = await tanqueConDosLecturas();
    const primera = await agent
      .patch(`/api/erp/combustible/lecturas/${segundaId}/anular`)
      .send({ motivo: "motivo original" });
    expect(primera.status).toBe(200);

    const segunda = await agent
      .patch(`/api/erp/combustible/lecturas/${segundaId}/anular`)
      .send({ motivo: "intento pisar el motivo" });
    expect(segunda.status).toBe(409);

    const historial = await agent.get(`/api/erp/combustible/${tanqueId}/lecturas`);
    const fila = historial.body.data.find((l: { id: number }) => l.id === segundaId);
    expect(fila.motivo_anulacion).toBe("motivo original");
  });

  it("anular una lectura inexistente da 404", async () => {
    const res = await agent
      .patch("/api/erp/combustible/lecturas/999999999/anular")
      .send({ motivo: "no existe" });
    expect(res.status).toBe(404);
  });

  it("un usuario con rol 'lectura' no puede anular (403)", async () => {
    const { segundaId } = await tanqueConDosLecturas();
    const email = `lectura-anular-${Date.now()}@test.local`;
    await withTenant(tenantId, (client) =>
      crearUsuarioService(
        { tenantId, nombre: "Solo lectura", email, password, rol: "lectura" },
        client
      )
    );

    const agentLectura = request.agent(app);
    await agentLectura.post("/api/auth/login").send({ tenantSlug, email, password });

    const res = await agentLectura
      .patch(`/api/erp/combustible/lecturas/${segundaId}/anular`)
      .send({ motivo: "no debería poder" });
    expect(res.status).toBe(403);
  });

  it("un tenant no puede anular la lectura de otro (404, y la lectura sigue vigente)", async () => {
    const { segundaId } = await tanqueConDosLecturas();

    const otro = await crearTenantDePrueba(password);
    const agentOtro = request.agent(app);
    await agentOtro
      .post("/api/auth/login")
      .send({ tenantSlug: otro.tenant.slug, email: otro.usuario.email, password });

    const res = await agentOtro
      .patch(`/api/erp/combustible/lecturas/${segundaId}/anular`)
      .send({ motivo: "lectura ajena" });
    expect(res.status).toBe(404);

    const sigueVigente = await withTenant(tenantId, (client) =>
      client.query(`SELECT anulada_en FROM combustible_lecturas WHERE id = $1`, [segundaId])
    );
    expect(sigueVigente.rows[0].anulada_en).toBeNull();

    await borrarTenantDePrueba(otro.tenant.id);
  });
});

describe("combustible: capacidad_total > 0 a nivel de base de datos", () => {
  let tenantId: string;
  const password = "ClaveDePrueba123";

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
  });

  it("un INSERT directo con capacidad_total <= 0 viola el CHECK de la migración 0057", async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;

    await expect(
      withTenant(tenantId, (client) =>
        client.query(
          `INSERT INTO combustible (
             tenant_id, codigo, tanque_nombre, tipo_combustible, unidad, tipo_punto, capacidad_total
           ) VALUES ($1, $2, 'Tanque inválido', 'diesel_b5', 'gal', 'fijo', 0)`,
          [tenantId, idUnico("NEG")]
        )
      )
    ).rejects.toThrow();
  });
});

// Un solo cierre de pool para todo el archivo -- closeDatabase() dentro de
// un afterAll de un describe individual rompería el segundo describe (ver
// el mismo comentario en equipos-checklist-iperc.test.ts).
afterAll(async () => {
  await closeDatabase();
});
