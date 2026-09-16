/** tests/auditoria-mutaciones.test.ts
 *
 * Que las mutaciones de cada módulo de negocio dejen rastro en
 * platform_audit_log. Los primeros tests son de humo puro ("¿pasó algo?");
 * los de repuestos/combustible/documentos, más nuevos, sí miran `accion` y
 * `detalle`, porque en esos casos hay criterio explícito que vale la pena
 * congelar: un bulk audita UNA fila con el conteo (no una por registro), y
 * un reintento idempotente NO vuelve a auditar.
 *
 * Contexto: repuestos, combustible y documentos NO auditaban nada, y este
 * archivo lo reportaba con it.todo() + un test de control negativo en vez
 * de forzar el comportamiento por su cuenta. El hueco se cerró: los
 * it.todo() y el control negativo se fueron, reemplazados por los describe
 * de abajo. Ver docs/adr/0002-contrato-de-modulo.md.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba } from "./helpers";
import { pool, withTenant, closeDatabase } from "../src/server/config/database";

afterAll(async () => {
  await closeDatabase();
});

async function filasDeAuditoria(tenantId: string): Promise<number> {
  const result = await pool.query(`SELECT count(*) FROM platform_audit_log WHERE tenant_id = $1`, [
    tenantId,
  ]);
  return Number(result.rows[0].count);
}

/** Las filas de una acción puntual, en orden de llegada. `detalle` vuelve ya
 *  parseado (la columna es jsonb). No hace falta esperarHasta(): a
 *  diferencia de las métricas por tenant, registrarAuditoria() se AWAITEA
 *  dentro del handler antes de responder, así que cuando supertest devuelve
 *  la respuesta la fila ya está commiteada. */
async function auditoriaDe(
  tenantId: string,
  accion: string
): Promise<{ detalle: Record<string, unknown> | null; resultado: string }[]> {
  const result = await pool.query(
    `SELECT detalle, resultado FROM platform_audit_log
     WHERE tenant_id = $1 AND accion = $2
     ORDER BY creado_en ASC, id ASC`,
    [tenantId, accion]
  );
  return result.rows;
}

describe("auditoría de mutaciones: equipos, checklists e iperc SÍ dejan rastro", () => {
  it("crear un equipo genera al menos una fila en platform_audit_log", async () => {
    const password = "ClaveDePrueba123";
    const creado = await crearTenantDePrueba(password);
    try {
      const agent = request.agent(app);
      await agent
        .post("/api/auth/login")
        .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });

      const filasAntes = await filasDeAuditoria(creado.tenant.id);

      const res = await agent
        .post("/api/erp/equipos")
        .send({ placa_codigo: "AUD-001", tipo: "Camión" });
      expect(res.status).toBe(201);

      expect(await filasDeAuditoria(creado.tenant.id)).toBeGreaterThan(filasAntes);
    } finally {
      await borrarTenantDePrueba(creado.tenant.id);
    }
  });

  it("crear un checklist genera al menos una fila en platform_audit_log", async () => {
    const password = "ClaveDePrueba123";
    const creado = await crearTenantDePrueba(password);
    try {
      const agent = request.agent(app);
      await agent
        .post("/api/auth/login")
        .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });

      const equipo = await agent
        .post("/api/erp/equipos")
        .send({ placa_codigo: "AUD-002", tipo: "Camión" });
      const plantilla = await agent
        .post("/api/erp/checklists/plantillas")
        .send({ nombre: "Plantilla auditoría", items: [{ descripcion: "Frenos" }] });

      const filasAntes = await filasDeAuditoria(creado.tenant.id);

      const res = await agent.post("/api/erp/checklists").send({
        equipo_id: equipo.body.id,
        plantilla_id: plantilla.body.id,
        items: [{ descripcion: "Frenos", estado: "bien" }],
      });
      expect(res.status).toBe(201);

      expect(await filasDeAuditoria(creado.tenant.id)).toBeGreaterThan(filasAntes);
    } finally {
      await borrarTenantDePrueba(creado.tenant.id);
    }
  });

  it("crear un IPERC genera al menos una fila en platform_audit_log", async () => {
    const password = "ClaveDePrueba123";
    const creado = await crearTenantDePrueba(password);
    try {
      const agent = request.agent(app);
      await agent
        .post("/api/auth/login")
        .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });

      const filasAntes = await filasDeAuditoria(creado.tenant.id);

      const res = await agent.post("/api/erp/iperc").send({
        area_frente: "Frente auditoría",
        items: [
          {
            etapa_actividad: "Traslado",
            peligro: "Terreno irregular",
            riesgo: "Caída",
            probabilidad: 2,
            severidad: 2,
            medidas_control: "EPP",
          },
        ],
      });
      expect(res.status).toBe(201);

      expect(await filasDeAuditoria(creado.tenant.id)).toBeGreaterThan(filasAntes);
    } finally {
      await borrarTenantDePrueba(creado.tenant.id);
    }
  });
});

describe("auditoría de mutaciones: repuestos", () => {
  let tenantId: string;
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
  });

  function repuestoDePrueba(codigo: string) {
    return {
      codigo,
      nombre: `Repuesto ${codigo}`,
      categoria: "General",
      stock: 10,
      stock_minimo: 1,
      stock_maximo: 100,
      precio: 10,
    };
  }

  it("crear, actualizar y eliminar dejan una fila cada uno, con el id en el detalle", async () => {
    const creado = await agente.post("/api/erp/repuestos").send(repuestoDePrueba("AUD-REP-CRUD"));
    expect(creado.status).toBe(201);
    const id = creado.body.id;

    expect(await auditoriaDe(tenantId, "repuestos.crear")).toEqual([
      { detalle: { repuestoId: id }, resultado: "success" },
    ]);

    // El PUT es un reemplazo completo, no un patch: actualizarRepuestoSchema
    // exige todos los campos.
    const actualizado = await agente
      .put(`/api/erp/repuestos/${id}`)
      .send({ ...repuestoDePrueba("AUD-REP-CRUD"), nombre: "Renombrado" });
    expect(actualizado.status).toBe(200);
    // El detalle lleva QUÉ cambió, con su valor viejo y el nuevo (5ª
    // auditoría): "alguien editó el repuesto 12" no permite reconstruir nada.
    // Es la misma regla que ya regía en combustible (`diffFicha`).
    expect(await auditoriaDe(tenantId, "repuestos.actualizar")).toEqual([
      {
        detalle: {
          repuestoId: id,
          cambios: [{ campo: "nombre", de: "Repuesto AUD-REP-CRUD", a: "Renombrado" }],
        },
        resultado: "success",
      },
    ]);

    const eliminado = await agente.delete(`/api/erp/repuestos/${id}`);
    expect(eliminado.status).toBe(200);
    expect(await auditoriaDe(tenantId, "repuestos.eliminar")).toEqual([
      { detalle: { repuestoId: id }, resultado: "success" },
    ]);
  });

  it("un 404 (actualizar algo que no existe) NO deja rastro: no hubo mutación", async () => {
    const antes = await filasDeAuditoria(tenantId);
    const res = await agente
      .put("/api/erp/repuestos/999999999")
      .send(repuestoDePrueba("AUD-REP-FANTASMA"));
    expect(res.status).toBe(404);
    expect(await filasDeAuditoria(tenantId)).toBe(antes);
  });

  it("la carga masiva deja UNA fila con el conteo, no una por repuesto", async () => {
    const filas = [
      repuestoDePrueba("AUD-REP-BULK-1"),
      repuestoDePrueba("AUD-REP-BULK-2"),
      repuestoDePrueba("AUD-REP-BULK-3"),
    ];
    const res = await agente.post("/api/erp/repuestos/bulk").send(filas);
    expect(res.status).toBe(201);

    expect(await auditoriaDe(tenantId, "repuestos.carga_masiva")).toEqual([
      { detalle: { cantidad: 3 }, resultado: "success" },
    ]);
  });

  it("registrar un movimiento deja rastro con el id del movimiento y del repuesto", async () => {
    const repuesto = await agente.post("/api/erp/repuestos").send(repuestoDePrueba("AUD-REP-MOV"));
    const res = await agente.post("/api/erp/repuestos/movimientos").send({
      cliente_uuid: crypto.randomUUID(),
      repuesto_id: repuesto.body.id,
      tipo: "entrada",
      cantidad: 5,
    });
    expect(res.status).toBe(201);

    const filas = await auditoriaDe(tenantId, "repuestos.registrar_movimiento");
    expect(filas).toContainEqual({
      detalle: {
        movimientoId: res.body.movimiento.id,
        repuestoId: repuesto.body.id,
        tipo: "entrada",
        estado: res.body.movimiento.estado,
      },
      resultado: "success",
    });
  });

  it("un movimiento RECHAZADO por stock insuficiente se audita con resultado 'failure'", async () => {
    // El rechazo persiste una fila en repuestos_movimientos (estado
    // 'rechazado', ver migrations/0048), así que es una mutación real y
    // además la señal operativa que interesa ver después -- mismo criterio
    // que `cuota.bloqueo`.
    const repuesto = await agente
      .post("/api/erp/repuestos")
      .send({ ...repuestoDePrueba("AUD-REP-RECHAZO"), stock: 1 });

    const res = await agente.post("/api/erp/repuestos/movimientos").send({
      cliente_uuid: crypto.randomUUID(),
      repuesto_id: repuesto.body.id,
      tipo: "salida",
      cantidad: 999,
    });
    expect(res.status).toBe(409);
    expect(res.body.movimiento.estado).toBe("rechazado");

    const filas = await auditoriaDe(tenantId, "repuestos.registrar_movimiento");
    expect(filas).toContainEqual({
      detalle: {
        movimientoId: res.body.movimiento.id,
        repuestoId: repuesto.body.id,
        tipo: "salida",
        estado: "rechazado",
      },
      resultado: "failure",
    });
  });
});

describe("auditoría de mutaciones: combustible", () => {
  let tenantId: string;
  let combustibleId: number;
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });

    // Combustible no expone un POST de creación de tanques -- se inserta
    // igual que en tests/idempotencia-offline-combustible.test.ts.
    // El nivel va como LECTURA, no como columna: `combustible.nivel_actual`
    // dejó de existir en la migración 0059.
    const fila = await withTenant(tenantId, async (client) => {
      const t = await client.query(
        `INSERT INTO combustible (
           tenant_id, codigo, tanque_nombre, tipo_combustible, unidad, tipo_punto,
           capacidad_total
         )
         VALUES ($1, 'TQ-TEST', $2, 'diesel_b5', 'gal', 'fijo', $3) RETURNING id`,
        [tenantId, "Tanque auditoría", 1000]
      );
      await client.query(
        `INSERT INTO combustible_lecturas (tenant_id, combustible_id, nivel, leido_en, origen)
         VALUES ($1, $2, 500, NOW(), 'inicial')`,
        [tenantId, t.rows[0].id]
      );
      return t;
    });
    combustibleId = fila.rows[0].id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
  });

  it("registrar una lectura deja rastro con el id de la lectura y del tanque", async () => {
    const res = await agente.post("/api/erp/combustible/lecturas").send({
      cliente_uuid: crypto.randomUUID(),
      combustible_id: combustibleId,
      nivel: 400,
    });
    expect(res.status).toBe(201);

    expect(await auditoriaDe(tenantId, "combustible.registrar_lectura")).toEqual([
      {
        detalle: { lecturaId: res.body.lectura.id, combustibleId },
        resultado: "success",
      },
    ]);
  });

  it("una varilla sobre un tanque inexistente (400) no deja rastro", async () => {
    const antes = await filasDeAuditoria(tenantId);
    const res = await agente
      .post("/api/erp/combustible/lecturas")
      .send({ combustible_id: 999999999, nivel: 10 });
    expect(res.status).toBe(400);
    expect(await filasDeAuditoria(tenantId)).toBe(antes);
  });
});

describe("auditoría de mutaciones: documentos", () => {
  let tenantId: string;
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
  });

  it("crear, actualizar y eliminar dejan una fila cada uno, con el id en el detalle", async () => {
    const creado = await agente.post("/api/erp/documentos").send({
      nombre_documento: "Licencia auditoría",
      responsable: "Juan Pérez",
      fecha_vencimiento: "2030-01-01",
    });
    expect(creado.status).toBe(201);
    const id = creado.body.id;

    expect(await auditoriaDe(tenantId, "documentos.crear")).toEqual([
      { detalle: { documentoId: id }, resultado: "success" },
    ]);

    // El PUT es un reemplazo completo, no un patch: actualizarDocumentoSchema
    // exige nombre_documento y fecha_vencimiento.
    const actualizado = await agente.put(`/api/erp/documentos/${id}`).send({
      nombre_documento: "Licencia auditoría",
      responsable: "Ana Torres",
      fecha_vencimiento: "2030-01-01",
    });
    expect(actualizado.status).toBe(200);
    expect(await auditoriaDe(tenantId, "documentos.actualizar")).toEqual([
      { detalle: { documentoId: id }, resultado: "success" },
    ]);

    const eliminado = await agente.delete(`/api/erp/documentos/${id}`);
    expect(eliminado.status).toBe(200);
    expect(await auditoriaDe(tenantId, "documentos.eliminar")).toEqual([
      { detalle: { documentoId: id }, resultado: "success" },
    ]);
  });

  it("la carga masiva deja UNA fila con el conteo, no una por documento", async () => {
    const res = await agente.post("/api/erp/documentos/bulk").send([
      { nombre_documento: "Bulk aud 1", responsable: "A", fecha_vencimiento: "2030-01-01" },
      { nombre_documento: "Bulk aud 2", responsable: "B", fecha_vencimiento: "2030-02-01" },
    ]);
    expect(res.status).toBe(201);

    expect(await auditoriaDe(tenantId, "documentos.carga_masiva")).toEqual([
      { detalle: { cantidad: 2 }, resultado: "success" },
    ]);
  });

  it("subir una versión de archivo deja rastro con el documento y la versión", async () => {
    const doc = await agente.post("/api/erp/documentos").send({
      nombre_documento: "Documento con archivo",
      responsable: "Juan Pérez",
      fecha_vencimiento: "2030-01-01",
    });

    const res = await agente
      .post(`/api/erp/documentos/${doc.body.id}/versiones`)
      .field("cliente_uuid", crypto.randomUUID())
      .attach("archivo", Buffer.from("%PDF-1.4\n%auditoria\n"), "auditoria.pdf");
    expect(res.status).toBe(201);

    expect(await auditoriaDe(tenantId, "documentos.subir_version")).toEqual([
      { detalle: { documentoId: doc.body.id, versionId: res.body.id }, resultado: "success" },
    ]);
  });
});

/** El punto de este describe: los endpoints que participan de la cola
 *  offline llegan al MISMO handler cuando el dispositivo drena la cola, así
 *  que no hacía falta tocar nada para que la auditoría funcione en ese
 *  camino -- pero "no hacía falta" es una hipótesis, y esto la prueba. Lo
 *  que sí importa verificar es el otro lado: un reintento con el mismo
 *  cliente_uuid (la respuesta original se perdió en la red, el dispositivo
 *  reenvía) NO debe auditar de nuevo, porque la mutación ya se auditó la
 *  primera vez. */
describe("auditoría de mutaciones: el reintento idempotente de la cola offline no audita dos veces", () => {
  let tenantId: string;
  let combustibleId: number;
  let repuestoId: number;
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });

    // Ídem: el nivel es una lectura, no una columna (migración 0059).
    const fila = await withTenant(tenantId, async (client) => {
      const t = await client.query(
        `INSERT INTO combustible (
           tenant_id, codigo, tanque_nombre, tipo_combustible, unidad, tipo_punto,
           capacidad_total
         )
         VALUES ($1, 'TQ-TEST', $2, 'diesel_b5', 'gal', 'fijo', $3) RETURNING id`,
        [tenantId, "Tanque reintento", 1000]
      );
      await client.query(
        `INSERT INTO combustible_lecturas (tenant_id, combustible_id, nivel, leido_en, origen)
         VALUES ($1, $2, 500, NOW(), 'inicial')`,
        [tenantId, t.rows[0].id]
      );
      return t;
    });
    combustibleId = fila.rows[0].id;

    const repuesto = await agente.post("/api/erp/repuestos").send({
      codigo: "AUD-REP-REINTENTO",
      nombre: "Repuesto reintento",
      categoria: "General",
      stock: 100,
      stock_minimo: 1,
      stock_maximo: 500,
      precio: 10,
    });
    repuestoId = repuesto.body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
  });

  it("repuestos: el mismo cliente_uuid dos veces deja UNA sola fila de auditoría", async () => {
    const cuerpo = {
      cliente_uuid: crypto.randomUUID(),
      repuesto_id: repuestoId,
      tipo: "entrada",
      cantidad: 3,
    };

    const primera = await agente.post("/api/erp/repuestos/movimientos").send(cuerpo);
    expect(primera.status).toBe(201);
    const reintento = await agente.post("/api/erp/repuestos/movimientos").send(cuerpo);
    expect(reintento.status).toBe(200);

    const filas = (await auditoriaDe(tenantId, "repuestos.registrar_movimiento")).filter(
      (f) => f.detalle?.movimientoId === primera.body.movimiento.id
    );
    expect(filas).toHaveLength(1);
  });

  it("combustible: el mismo cliente_uuid dos veces deja UNA sola fila de auditoría", async () => {
    const cuerpo = {
      cliente_uuid: crypto.randomUUID(),
      combustible_id: combustibleId,
      nivel: 420,
    };

    const primera = await agente.post("/api/erp/combustible/lecturas").send(cuerpo);
    expect(primera.status).toBe(201);
    const reintento = await agente.post("/api/erp/combustible/lecturas").send(cuerpo);
    expect(reintento.status).toBe(200);

    const filas = (await auditoriaDe(tenantId, "combustible.registrar_lectura")).filter(
      (f) => f.detalle?.lecturaId === primera.body.lectura.id
    );
    expect(filas).toHaveLength(1);
  });

  it("documentos: el mismo cliente_uuid dos veces deja UNA sola fila de auditoría", async () => {
    const cuerpo = {
      cliente_uuid: crypto.randomUUID(),
      nombre_documento: "Documento reintento",
      responsable: "Juan Pérez",
      fecha_vencimiento: "2030-01-01",
    };

    const primera = await agente.post("/api/erp/documentos").send(cuerpo);
    expect(primera.status).toBe(201);
    const reintento = await agente.post("/api/erp/documentos").send(cuerpo);
    expect(reintento.status).toBe(200);

    const filas = (await auditoriaDe(tenantId, "documentos.crear")).filter(
      (f) => f.detalle?.documentoId === primera.body.id
    );
    expect(filas).toHaveLength(1);
  });

  it("documentos: reimportar la misma planilla (misma clave de idempotencia) no audita de nuevo", async () => {
    const clave = crypto.randomUUID();
    const filas = [
      { nombre_documento: "Reimport 1", responsable: "A", fecha_vencimiento: "2030-01-01" },
    ];

    const primera = await agente
      .post("/api/erp/documentos/bulk")
      .set("Idempotency-Key", clave)
      .send(filas);
    expect(primera.status).toBe(201);

    const reintento = await agente
      .post("/api/erp/documentos/bulk")
      .set("Idempotency-Key", clave)
      .send(filas);
    expect(reintento.status).toBe(200);
    expect(reintento.body.yaImportado).toBe(true);

    expect(await auditoriaDe(tenantId, "documentos.carga_masiva")).toHaveLength(1);
  });
});
