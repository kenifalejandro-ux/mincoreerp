/** tests/repuestos.test.ts
 *
 * Repuestos no tenía ningún schema Zod para `POST /`, `PUT /:id` ni
 * `POST /bulk` -- mandaban `req.body` crudo a la query (documentado así en
 * repuestos.repository.ts), así que un campo NOT NULL faltante (ej.
 * `categoria`) volvía como un 500 de Postgres en vez de un default
 * razonable o un 400 claro. Mismo patrón que tuvo Documentos antes de
 * validarse (PR #81, tests/documentos.test.ts) -- este archivo cubre el
 * mismo tipo de casos, adaptado a que el bulk de Repuestos hace UPSERT por
 * `codigo` (`ON CONFLICT ... DO UPDATE`), no INSERT plano.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase } from "../src/server/config/database";
import { MAX_FILAS_CARGA_MASIVA } from "../src/server/schemas/repuestos.schema";

describe("repuestos: CRUD y carga masiva", () => {
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

  it("crea un repuesto con los campos mínimos", async () => {
    const res = await agent
      .post("/api/erp/repuestos")
      .send({ codigo: idUnico("MIN"), nombre: "Repuesto mínimo" });
    expect(res.status).toBe(201);
    expect(res.body.categoria).toBe("General");
    expect(res.body.stock).toBe(0);
    expect(res.body.stock_minimo).toBe(5);
    expect(res.body.stock_maximo).toBe(30);
    expect(Number(res.body.precio)).toBe(0);
  });

  it("actualiza un repuesto existente", async () => {
    const creado = await agent.post("/api/erp/repuestos").send({
      codigo: idUnico("UPD"),
      nombre: "Antes de editar",
      categoria: "Motor",
      stock: 10,
      stock_minimo: 2,
      stock_maximo: 20,
      precio: 5,
    });

    const res = await agent.put(`/api/erp/repuestos/${creado.body.id}`).send({
      codigo: creado.body.codigo,
      nombre: "Editado",
      categoria: "Frenos",
      stock: 15,
      stock_minimo: 3,
      stock_maximo: 25,
      precio: 8,
    });
    expect(res.status).toBe(200);
    expect(res.body.nombre).toBe("Editado");
    expect(res.body.categoria).toBe("Frenos");
    // El stock del body se IGNORA: la ficha no mueve existencias, eso es un
    // movimiento (5ª auditoría). Editar la ficha no puede ser la forma de
    // cuadrar un faltante sin dejar rastro.
    expect(res.body.stock).toBe(10);
  });

  it("carga masiva (bulk) inserta varios repuestos de una vez", async () => {
    const antes = await agent.get("/api/erp/repuestos?pageSize=1");
    const totalAntes = antes.body.pagination.total;

    const res = await agent.post("/api/erp/repuestos/bulk").send([
      { codigo: idUnico("B1"), nombre: "Bulk 1" },
      { codigo: idUnico("B2"), nombre: "Bulk 2" },
    ]);
    expect(res.status).toBe(201);
    expect(res.body.insertados).toBe(2);

    const despues = await agent.get("/api/erp/repuestos?pageSize=1");
    expect(despues.body.pagination.total).toBe(totalAntes + 2);
  });

  it("la carga masiva inserta en lotes: 1.200 filas cruzan el tamaño de lote sin perder ninguna", async () => {
    const antes = await agent.get("/api/erp/repuestos?pageSize=1");
    const totalAntes = antes.body.pagination.total;

    // 1.200 > TAMANO_LOTE (1.000): fuerza la segunda vuelta del loop de
    // lotes -- códigos únicos entre sí para que cada uno sea un INSERT
    // nuevo, no un upsert sobre el mismo.
    const prefijo = idUnico("LOTE");
    const filas = Array.from({ length: 1200 }, (_, i) => ({
      codigo: `${prefijo}-${i}`,
      nombre: `Repuesto de lote ${i}`,
    }));

    const res = await agent.post("/api/erp/repuestos/bulk").send(filas);
    expect(res.status).toBe(201);
    expect(res.body.insertados).toBe(1200);

    const despues = await agent.get("/api/erp/repuestos?pageSize=1");
    expect(despues.body.pagination.total).toBe(totalAntes + 1200);
  });

  it("reimportar el mismo código actualiza en vez de duplicar", async () => {
    const codigo = idUnico("UPSERT");
    const antes = await agent.get("/api/erp/repuestos?pageSize=1");
    const totalAntes = antes.body.pagination.total;

    const primera = await agent
      .post("/api/erp/repuestos/bulk")
      .send([{ codigo, nombre: "Versión 1", stock: 10 }]);
    expect(primera.status).toBe(201);

    const segunda = await agent
      .post("/api/erp/repuestos/bulk")
      .send([{ codigo, nombre: "Versión 2", stock: 99 }]);
    expect(segunda.status).toBe(201);

    // Mismo código: no crea una segunda fila, solo actualiza la que ya
    // existía (ON CONFLICT DO UPDATE, comportamiento preexistente).
    //
    // Con una excepción desde la 5ª auditoría: el STOCK no se pisa. La
    // existencia de un repuesto que ya existe sale de sus movimientos, no de
    // una planilla -- si no, reimportar un Excel viejo "corrige" el
    // inventario a un número que nadie contó.
    const despues = await agent.get("/api/erp/repuestos?pageSize=1");
    expect(despues.body.pagination.total).toBe(totalAntes + 1);

    const listado = await agent.get(`/api/erp/repuestos?pageSize=200`);
    const fila = listado.body.data.find((r: { codigo: string }) => r.codigo === codigo);
    expect(fila.nombre).toBe("Versión 2");
    expect(fila.stock).toBe(10);
  });

  it("un código repetido DENTRO del mismo lote no revienta la importación -- se queda con la última fila", async () => {
    // Postgres rechaza que un ON CONFLICT DO UPDATE afecte la misma fila
    // dos veces en la MISMA sentencia -- sin deduplicar antes de armar el
    // INSERT multi-fila, esto tiraría 500 en vez de importar. Dos filas
    // con el mismo código entran fácil en el primer lote de 1.000.
    const codigo = idUnico("DUP-LOTE");
    const antes = await agent.get("/api/erp/repuestos?pageSize=1");
    const totalAntes = antes.body.pagination.total;

    const res = await agent.post("/api/erp/repuestos/bulk").send([
      { codigo, nombre: "Primera del lote", stock: 1 },
      { codigo, nombre: "Segunda del lote (gana)", stock: 2 },
    ]);
    expect(res.status).toBe(201);

    const despues = await agent.get("/api/erp/repuestos?pageSize=1");
    expect(despues.body.pagination.total).toBe(totalAntes + 1);

    const listado = await agent.get(`/api/erp/repuestos?pageSize=200`);
    const fila = listado.body.data.find((r: { codigo: string }) => r.codigo === codigo);
    expect(fila.nombre).toBe("Segunda del lote (gana)");
    expect(fila.stock).toBe(2);
  });
});

describe("repuestos: validación de entrada (Zod)", () => {
  let tenantId: string;
  const password = "ClaveDePrueba123";
  const agent = request.agent(app);
  let repuestoId: number;

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await agent
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });

    const base = await agent
      .post("/api/erp/repuestos")
      .send({ codigo: idUnico("BASE"), nombre: "Repuesto base" });
    repuestoId = base.body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
  });

  // ── POST / ────────────────────────────────────────────────────────────

  it("rechaza un código vacío con 400 en vez de un 500 de Postgres", async () => {
    const res = await agent.post("/api/erp/repuestos").send({ codigo: "", nombre: "Sin código" });
    expect(res.status).toBe(400);
    expect(res.body.errors[0].field).toBe("codigo");
  });

  it("rechaza un código sin mandar (antes tiraba 500 por NOT NULL)", async () => {
    const res = await agent.post("/api/erp/repuestos").send({ nombre: "Sin código" });
    expect(res.status).toBe(400);
  });

  it("rechaza un nombre que excede el largo de la columna (200)", async () => {
    const res = await agent
      .post("/api/erp/repuestos")
      .send({ codigo: idUnico("LARGO"), nombre: "A".repeat(201) });
    expect(res.status).toBe(400);
  });

  // ── PUT /:id ──────────────────────────────────────────────────────────

  it("PUT con un campo faltante da 400 -- PUT no tiene defaults, a diferencia de POST", async () => {
    const res = await agent.put(`/api/erp/repuestos/${repuestoId}`).send({
      codigo: idUnico("PUT"),
      nombre: "Sin precio",
      categoria: "General",
      stock: 1,
      stock_minimo: 1,
      stock_maximo: 10,
      // falta precio
    });
    expect(res.status).toBe(400);
    expect(res.body.errors[0].field).toBe("precio");
  });

  // ── POST /bulk ────────────────────────────────────────────────────────

  it("bulk rechaza un cuerpo que no es un array", async () => {
    const res = await agent
      .post("/api/erp/repuestos/bulk")
      .send({ codigo: "X", nombre: "No soy un array" });
    expect(res.status).toBe(400);
  });

  it("bulk rechaza un array vacío", async () => {
    const res = await agent.post("/api/erp/repuestos/bulk").send([]);
    expect(res.status).toBe(400);
  });

  it("bulk rechaza el lote entero si UNA fila está mal, sin insertar nada", async () => {
    const antes = await agent.get("/api/erp/repuestos?pageSize=1");

    const res = await agent.post("/api/erp/repuestos/bulk").send([
      { codigo: idUnico("OK"), nombre: "Válida" },
      { codigo: "", nombre: "Inválida" },
    ]);
    expect(res.status).toBe(400);
    // El índice del array viaja en el campo del error: le permite al
    // cliente decir "fila N de tu planilla" en vez de un error genérico.
    expect(res.body.errors[0].field).toBe("1.codigo");

    const despues = await agent.get("/api/erp/repuestos?pageSize=1");
    expect(despues.body.pagination.total).toBe(antes.body.pagination.total);
  });

  it("bulk rechaza más filas que el máximo permitido", async () => {
    const filas = Array.from({ length: MAX_FILAS_CARGA_MASIVA + 1 }, (_, i) => ({
      codigo: `MAX-${i}`,
      nombre: `Fila ${i}`,
    }));
    const res = await agent.post("/api/erp/repuestos/bulk").send(filas);
    expect(res.status).toBe(400);
  });
});

// Un solo cierre de pool para todo el archivo -- closeDatabase() dentro de
// un afterAll de un describe individual rompería el segundo describe (ver
// el mismo comentario en tests/combustible.test.ts).
afterAll(async () => {
  await closeDatabase();
});
