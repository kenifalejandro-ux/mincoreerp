/** tests/combustible-bitacora.test.ts
 *
 * La bitácora del módulo para el propio tenant, y el aviso cuando alguien
 * afloja un control.
 *
 * El problema que resuelven: todo quedaba registrado, pero solo lo podía ver
 * el dueño del software desde el panel de plataforma. Un control que
 * únicamente revisa el proveedor no es un control de la empresa. Y nadie
 * recibía aviso al aflojar: quedaba escrito en un log que nadie abre, que es
 * exactamente como se planifica un robo (apagar, sacar, volver a prender).
 *
 * ⚠ EL TEST MÁS IMPORTANTE DE ESTE ARCHIVO es el de aislamiento entre
 * tenants. `platform_audit_log` NO tiene RLS -- está en la allowlist a
 * propósito porque el panel de plataforma la lee para todos. En esta consulta
 * el aislamiento lo garantiza un WHERE escrito a mano y NADA MÁS: si alguien
 * lo borra en un refactor, un admin ve la actividad de otras empresas y la
 * base no lo va a impedir.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { crearUsuarioService } from "../src/server/services/auth.service";
import { closeDatabase, withTenant } from "../src/server/config/database";

describe("combustible: bitácora del tenant y aviso de aflojamiento", () => {
  let tenantId: string;
  let tenantSlug: string;
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    tenantSlug = creado.tenant.slug;
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug, email: creado.usuario.email, password });
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  function payload(extra: Record<string, unknown> = {}) {
    return {
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque bitácora",
      tipo_combustible: "diesel_b5",
      unidad: "L",
      tipo_punto: "fijo",
      capacidad_total: 20000,
      nivel_actual: 0,
      nivel_minimo: 2000,
      modo_vigilancia: "personalizado",
      umbral_descuadre_pct: 1,
      ...extra,
    };
  }

  /** El PUT reemplaza la fila entera. */
  function edicion(t: Record<string, unknown>, cambios: Record<string, unknown> = {}) {
    return {
      codigo: t.codigo,
      tanque_nombre: t.tanque_nombre,
      tipo_combustible: t.tipo_combustible,
      unidad: t.unidad,
      tipo_punto: t.tipo_punto,
      capacidad_total: Number(t.capacidad_total),
      nivel_minimo: Number(t.nivel_minimo),
      moneda: t.moneda,
      activo: t.activo,
      tolerancia_capacidad_pct: Number(t.tolerancia_capacidad_pct),
      requiere_documento: t.requiere_documento,
      umbral_diferencia_pct:
        t.umbral_diferencia_pct === null ? null : Number(t.umbral_diferencia_pct),
      umbral_descuadre_pct: t.umbral_descuadre_pct === null ? null : Number(t.umbral_descuadre_pct),
      umbral_descuadre_ciclo_pct:
        t.umbral_descuadre_ciclo_pct === null ? null : Number(t.umbral_descuadre_ciclo_pct),
      umbral_descuadre_ventana_pct:
        t.umbral_descuadre_ventana_pct === null ? null : Number(t.umbral_descuadre_ventana_pct),
      ...cambios,
    };
  }

  const bitacora = async (query: Record<string, string> = {}) => {
    const res = await agente
      .get("/api/erp/combustible/bitacora")
      .query({ pageSize: 200, ...query });
    expect(res.status).toBe(200);
    return res.body.data as Array<{
      accion: string;
      usuario: string;
      detalle: Record<string, unknown>;
    }>;
  };

  // ── Aislamiento: lo que la base NO garantiza sola ─────────────────────

  it("un tenant NUNCA ve la bitácora de otro", async () => {
    // `platform_audit_log` no tiene RLS: si el WHERE por tenant_id se pierde
    // en un refactor, este test es lo único que lo detecta.
    const otro = await crearTenantDePrueba(password);
    try {
      const agenteOtro = request.agent(app);
      await agenteOtro
        .post("/api/auth/login")
        .send({ tenantSlug: otro.tenant.slug, email: otro.usuario.email, password });

      // El otro tenant crea un tanque con un código reconocible.
      const codigoAjeno = idUnico("AJENO");
      await agenteOtro.post("/api/erp/combustible").send(payload({ codigo: codigoAjeno }));

      // Y nuestro tenant crea el suyo.
      await agente.post("/api/erp/combustible").send(payload());

      const propia = await bitacora();
      expect(propia.length).toBeGreaterThan(0);
      expect(propia.some((f) => f.detalle.codigo === codigoAjeno)).toBe(false);
    } finally {
      await borrarTenantDePrueba(otro.tenant.id);
    }
  });

  it("un operador no puede ver la bitácora: es visibilidad de gerencia", async () => {
    const email = idUnico("operador-bitacora") + "@test.local";
    await withTenant(tenantId, (client) =>
      crearUsuarioService(
        { tenantId, nombre: "Operador", email, password, rol: "operador" },
        client
      )
    );
    const agenteOperador = request.agent(app);
    await agenteOperador.post("/api/auth/login").send({ tenantSlug, email, password });

    const res = await agenteOperador.get("/api/erp/combustible/bitacora");
    expect(res.status).toBe(403);
  });

  // ── Contenido ─────────────────────────────────────────────────────────

  it("registra el alta con quién la hizo", async () => {
    const codigo = idUnico("TQ");
    await agente.post("/api/erp/combustible").send(payload({ codigo }));

    const filas = await bitacora();
    const alta = filas.find(
      (f) => f.accion === "combustible.tanque_crear" && f.detalle.codigo === codigo
    );
    expect(alta).toBeDefined();
    // El nombre resuelto, no el UUID: la bitácora la lee una persona.
    expect(alta!.usuario).not.toMatch(/^[0-9a-f-]{36}$/);
  });

  it("aflojar un control queda con acción propia, valores y motivo", async () => {
    const creado = await agente.post("/api/erp/combustible").send(payload());
    await agente
      .put(`/api/erp/combustible/${creado.body.id}`)
      .send(
        edicion(creado.body, { umbral_descuadre_pct: 40, motivo_ajuste: "Varilla sin calibrar" })
      );

    const filas = await bitacora();
    const evento = filas.find((f) => f.accion === "combustible.tanque_vigilancia_reducida");
    expect(evento).toBeDefined();
    expect(evento!.detalle.motivo).toContain("Varilla");
    const aflojados = evento!.detalle.aflojados as Array<{ de: string; a: string }>;
    expect(aflojados[0].de).toBe("1%");
    expect(aflojados[0].a).toBe("40%");
  });

  it("filtra por período: es como pregunta un auditor", async () => {
    // Nadie audita "los últimos 100 registros": audita un mes.
    const filas = await bitacora({
      desde: "2020-01-01T00:00:00.000Z",
      hasta: "2020-12-31T00:00:00.000Z",
    });
    expect(filas).toHaveLength(0);
  });

  // ── Qué cuenta como aflojar (ampliado) ────────────────────────────────

  it("SUBIR LA CAPACIDAD afloja, aunque el porcentaje no se toque", async () => {
    // El caso más discreto de todos: los umbrales son % de la capacidad, así
    // que pasar de 20.000 a 200.000 convierte una banda de 200 L en una de
    // 2.000 sin tocar ningún umbral. En la auditoría se veía como una
    // corrección de ficha.
    const creado = await agente.post("/api/erp/combustible").send(payload());
    const res = await agente
      .put(`/api/erp/combustible/${creado.body.id}`)
      .send(edicion(creado.body, { capacidad_total: 200000 }));

    expect(res.status).toBe(400);
    expect(res.body.requiere_motivo).toBe(true);
    expect(res.body.error).toContain("Capacidad");
  });

  it("BAJAR la capacidad no pide motivo: estrecha las bandas", async () => {
    const creado = await agente.post("/api/erp/combustible").send(payload());
    const res = await agente
      .put(`/api/erp/combustible/${creado.body.id}`)
      .send(edicion(creado.body, { capacidad_total: 10000 }));
    expect(res.status).toBe(200);
  });

  it("bajar el nivel mínimo afloja: el aviso de reposición llega más tarde", async () => {
    const creado = await agente.post("/api/erp/combustible").send(payload());
    const res = await agente
      .put(`/api/erp/combustible/${creado.body.id}`)
      .send(edicion(creado.body, { nivel_minimo: 100 }));

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Nivel mínimo");
  });

  it("subir el nivel mínimo no pide nada: avisa antes", async () => {
    const creado = await agente.post("/api/erp/combustible").send(payload());
    const res = await agente
      .put(`/api/erp/combustible/${creado.body.id}`)
      .send(edicion(creado.body, { nivel_minimo: 5000 }));
    expect(res.status).toBe(200);
  });
});
