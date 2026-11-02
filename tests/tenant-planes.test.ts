/** tests/tenant-planes.test.ts
 *
 * Planes: el escalón intermedio entre el override puntual de un tenant y el
 * default global del registry (migración 0034,
 * docs/architecture/cuotas-por-tenant.md).
 *
 * Lo que de verdad hay que blindar es la PRECEDENCIA y el manejo de
 * "ilimitado": si `NULL` (ilimitado) se confundiera con "sin dato", la
 * resolución caería al nivel siguiente y terminaría aplicando un tope a un
 * cliente que compró justamente lo contrario.
 */
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { env } from "../src/server/config/env";
import { pool, closeDatabase } from "../src/server/config/database";
import {
  resolverLimite,
  limiteEfectivo,
  fijarCuotaTenant,
  invalidarCacheLimite,
  invalidarCacheLimitesTenant,
} from "../src/server/services/platformCuotas.service";
import { asignarPlanATenantService } from "../src/server/services/platformPlanes.service";

const BEARER = `Bearer ${env.platformAdminToken}`;
const password = "ClaveDePrueba123";
const tenantsCreados: string[] = [];

const contexto = {
  ip: "127.0.0.1",
  actorType: "emergency_shared_secret" as const,
  actorLabel: "tests",
};

async function nuevoTenant() {
  const creado = await crearTenantDePrueba(password);
  tenantsCreados.push(creado.tenant.id);
  return creado;
}

afterAll(async () => {
  for (const id of tenantsCreados) await borrarTenantDePrueba(id);
  await closeDatabase();
});

describe("seed de planes", () => {
  it("los 4 planes existen con su código estable", async () => {
    const res = await request(app).get("/api/platform/planes").set("Authorization", BEARER);
    expect(res.status).toBe(200);
    const codigos = res.body.planes.map((p: any) => p.codigo).sort();
    expect(codigos).toEqual(["corporativo", "mediana", "mype", "pequena"]);
  });

  it("corporativo tiene los módulos ilimitados pero SÍ topea backups (es el único con costo real)", async () => {
    const res = await request(app)
      .get("/api/platform/planes/corporativo")
      .set("Authorization", BEARER);

    expect(res.body.plan.limites.usuarios).toBeNull();
    expect(res.body.plan.limites.flota).toBeNull();
    expect(res.body.plan.limites.checklists).toBeNull();
    expect(res.body.plan.limites.backup_bytes).toBe(100 * 1024 * 1024 * 1024);
  });

  it("se puede buscar un plan por UUID además de por código", async () => {
    const porCodigo = await request(app)
      .get("/api/platform/planes/mype")
      .set("Authorization", BEARER);
    const porUuid = await request(app)
      .get(`/api/platform/planes/${porCodigo.body.plan.id}`)
      .set("Authorization", BEARER);

    expect(porUuid.status).toBe(200);
    expect(porUuid.body.plan.codigo).toBe("mype");
  });

  it("vienen ordenados de MENOR a MAYOR, no alfabéticamente", async () => {
    // Por nombre quedaría "Corporativo, Mediana, MYPE, Pequeña": el plan más
    // grande primero y el más chico tercero, que en un selector invita a
    // asignar el equivocado. Ver migración 0035.
    const res = await request(app).get("/api/platform/planes").set("Authorization", BEARER);
    const nombres = res.body.planes.map((p: any) => p.nombre);
    expect(nombres).toEqual(["MYPE", "Pequeña", "Mediana", "Corporativo"]);
  });

  it("404 con un plan que no existe", async () => {
    const res = await request(app)
      .get("/api/platform/planes/inexistente")
      .set("Authorization", BEARER);
    expect(res.status).toBe(404);
  });
});

describe("precedencia: override > plan > registry", () => {
  // Estos 8 casos comparten UN tenant a propósito: crear uno por test son 8
  // altas contra POST /tenants, que tiene rate limit y es la operación más
  // cara de la suite. Compartirlo no los hace frágiles porque cada test fija
  // EXPLÍCITAMENTE los dos niveles que le importan (plan y override,
  // incluido "ninguno"), así que ninguno depende de lo que dejó el anterior.
  let compartido: Awaited<ReturnType<typeof nuevoTenant>>;

  /** Deja al tenant en un estado conocido: sin override y con el plan pedido. */
  async function estadoInicial(plan: string | null) {
    compartido ??= await nuevoTenant();
    await fijarCuotaTenant(compartido.tenant.id, "flota", undefined);
    await asignarPlanATenantService(compartido.tenant.id, plan, contexto);
    return compartido.tenant.id;
  }

  it("sin plan ni override usa el default del registry", async () => {
    const tenantId = await estadoInicial(null);
    const r = await resolverLimite(tenantId, "flota");
    expect(r.origen).toBe("registry");
    expect(r.limite).toBe(2000); // porDefecto de equipos en el registry
  });

  it("con plan asignado manda el plan sobre el registry", async () => {
    const tenantId = await estadoInicial("mype");
    const r = await resolverLimite(tenantId, "flota");
    expect(r.origen).toBe("plan");
    expect(r.limite).toBe(20); // MYPE
  });

  it("un override puntual manda sobre el plan", async () => {
    const tenantId = await estadoInicial("mype"); // equipos = 20 por plan
    await fijarCuotaTenant(tenantId, "flota", 35, "negociado aparte");

    const r = await resolverLimite(tenantId, "flota");
    expect(r.origen).toBe("override");
    expect(r.limite).toBe(35);
  });

  it("borrar el override devuelve el control al PLAN, no al registry", async () => {
    const tenantId = await estadoInicial("mype");
    await fijarCuotaTenant(tenantId, "flota", 35);
    await fijarCuotaTenant(tenantId, "flota", undefined); // borra el override

    const r = await resolverLimite(tenantId, "flota");
    expect(r.origen).toBe("plan");
    expect(r.limite).toBe(20);
  });

  it("ILIMITADO en el plan no cae al registry (null es un valor, no ausencia)", async () => {
    const tenantId = await estadoInicial("corporativo");
    const r = await resolverLimite(tenantId, "flota");
    expect(r.origen).toBe("plan");
    expect(r.limite).toBeNull(); // ilimitado, NO los 2000 del registry
  });

  it("ILIMITADO en el override no cae al plan", async () => {
    const tenantId = await estadoInicial("mype"); // equipos = 20 por plan
    await fijarCuotaTenant(tenantId, "flota", null, "cliente especial");

    const r = await resolverLimite(tenantId, "flota");
    expect(r.origen).toBe("override");
    expect(r.limite).toBeNull();
  });

  it("un recurso que el plan NO define cae al registry", async () => {
    const tenantId = await estadoInicial("mype");
    const plan = await request(app).get("/api/platform/planes/mype").set("Authorization", BEARER);
    // Se le saca a MYPE la fila de 'flota': el plan deja de opinar sobre
    // ese recurso. Es el mismo caso que un módulo NUEVO, que todavía no
    // tiene fila en ningún plan.
    await pool.query(`DELETE FROM plan_limites WHERE plan_id = $1 AND recurso = 'flota'`, [
      plan.body.plan.id,
    ]);
    // Este DELETE es directo a la tabla, sin pasar por fijarCuotaTenant ni
    // asignarPlanATenantService — así que hay que invalidar a mano el
    // caché de resolverLimite() (ver platformCuotas.service.ts), igual que
    // tendría que hacerlo cualquier código real que tocara plan_limites
    // por fuera del service.
    await invalidarCacheLimite(tenantId, "flota");
    try {
      const r = await resolverLimite(tenantId, "flota");
      expect(r.origen).toBe("registry");
      expect(r.limite).toBe(2000);
    } finally {
      await pool.query(
        `INSERT INTO plan_limites (plan_id, recurso, limite) VALUES ($1, 'flota', 20)`,
        [plan.body.plan.id]
      );
      await invalidarCacheLimite(tenantId, "flota");
    }
  });

  it("quitar el plan (null) devuelve al tenant a los defaults del registry", async () => {
    const tenantId = await estadoInicial("mype");
    expect(await limiteEfectivo(tenantId, "flota")).toBe(20);

    await asignarPlanATenantService(tenantId, null, contexto);
    const r = await resolverLimite(tenantId, "flota");
    expect(r.origen).toBe("registry");
    expect(r.limite).toBe(2000);
  });
});

describe("el enforcement respeta el plan", () => {
  async function agenteDe(tenant: { slug: string }, email: string) {
    const agente = request.agent(app);
    await agente.post("/api/auth/login").send({ tenantSlug: tenant.slug, email, password });
    return agente;
  }

  it("bloquea al llegar al límite DEL PLAN, no al del registry", async () => {
    const { tenant, usuario } = await nuevoTenant();
    // Se crea un plan a medida con un tope chico para no cargar 20 equipos.
    await pool.query(
      `INSERT INTO planes (codigo, nombre) VALUES ($1, 'Plan de prueba') ON CONFLICT DO NOTHING`,
      ["test-mini-" + Date.now()]
    );
    const codigo = (
      await pool.query(
        `SELECT codigo FROM planes WHERE codigo LIKE 'test-mini-%' ORDER BY creado_en DESC LIMIT 1`
      )
    ).rows[0].codigo;
    const planId = (await pool.query(`SELECT id FROM planes WHERE codigo = $1`, [codigo])).rows[0]
      .id;
    await pool.query(
      `INSERT INTO plan_limites (plan_id, recurso, limite) VALUES ($1, 'flota', 2)`,
      [planId]
    );

    try {
      await asignarPlanATenantService(tenant.id, codigo, contexto);
      const agente = await agenteDe(tenant, usuario.email);

      for (const n of [1, 2]) {
        const ok = await agente
          .post("/api/erp/equipos")
          .send({ placa_codigo: idUnico(`EQ-${n}`), tipo: "X" });
        expect(ok.status).toBe(201);
      }

      const rechazado = await agente
        .post("/api/erp/equipos")
        .send({ placa_codigo: idUnico("EQ-3"), tipo: "X" });
      expect(rechazado.status).toBe(403);
      expect(rechazado.body.limite).toBe(2); // el del plan, no los 2000 del registry
    } finally {
      await pool.query(`UPDATE tenants SET plan_id = NULL WHERE id = $1`, [tenant.id]);
      await pool.query(`DELETE FROM planes WHERE id = $1`, [planId]);
    }
  });

  it("un plan ilimitado no bloquea nada", async () => {
    const { tenant, usuario } = await nuevoTenant();
    await asignarPlanATenantService(tenant.id, "corporativo", contexto);
    const agente = await agenteDe(tenant, usuario.email);

    for (let i = 0; i < 3; i++) {
      const res = await agente
        .post("/api/erp/equipos")
        .send({ placa_codigo: idUnico("EQ"), tipo: "X" });
      expect(res.status).toBe(201);
    }
  });
});

describe("cambio de plan: nunca destruye datos", () => {
  it("bajar de plan deja al tenant EXCEDIDO pero conserva todo lo cargado", async () => {
    const { tenant, usuario } = await nuevoTenant();
    const agente = request.agent(app);
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug: tenant.slug, email: usuario.email, password });

    // Con el default del registry (2000) se cargan 3 equipos sin problema.
    for (let i = 0; i < 3; i++) {
      await agente.post("/api/erp/equipos").send({ placa_codigo: idUnico("EQ"), tipo: "X" });
    }

    // Se le fija un tope POR DEBAJO de lo que ya tiene.
    await fijarCuotaTenant(tenant.id, "flota", 1);

    // Los 3 equipos siguen ahí: bajar el tope no borra nada.
    const listado = await agente.get("/api/erp/equipos");
    expect(listado.status).toBe(200);
    expect(listado.body.pagination.total).toBe(3);

    // Pero no puede crear más.
    const rechazado = await agente
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("EQ"), tipo: "X" });
    expect(rechazado.status).toBe(403);
  });

  it("asignar un plan reporta qué recursos quedan excedidos, para poder advertirlo en el momento", async () => {
    const { tenant, usuario } = await nuevoTenant();
    const agente = request.agent(app);
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug: tenant.slug, email: usuario.email, password });
    for (let i = 0; i < 3; i++) {
      await agente.post("/api/erp/equipos").send({ placa_codigo: idUnico("EQ"), tipo: "X" });
    }

    // Se crea un plan con menos equipos de los que el tenant ya tiene.
    const codigo = "test-bajo-" + Date.now();
    const planId = (
      await pool.query(`INSERT INTO planes (codigo, nombre) VALUES ($1, 'Bajo') RETURNING id`, [
        codigo,
      ])
    ).rows[0].id;
    await pool.query(
      `INSERT INTO plan_limites (plan_id, recurso, limite) VALUES ($1, 'flota', 1)`,
      [planId]
    );

    try {
      const res = await request(app)
        .put(`/api/platform/tenants/${tenant.id}/plan`)
        .set("Authorization", BEARER)
        .send({ plan: codigo, motivo: "downgrade de prueba" });

      expect(res.status).toBe(200);
      expect(res.body.recursosExcedidos).toContain("flota");
    } finally {
      await pool.query(`UPDATE tenants SET plan_id = NULL WHERE id = $1`, [tenant.id]);
      await pool.query(`DELETE FROM planes WHERE id = $1`, [planId]);
    }
  });

  it("subir de plan levanta el tope sin tocar nada", async () => {
    const { tenant } = await nuevoTenant();
    await asignarPlanATenantService(tenant.id, "mype", contexto);
    expect(await limiteEfectivo(tenant.id, "flota")).toBe(20);

    await asignarPlanATenantService(tenant.id, "mediana", contexto);
    expect(await limiteEfectivo(tenant.id, "flota")).toBe(500);
  });
});

describe("API y auditoría", () => {
  it("PUT asigna el plan y el GET siguiente lo refleja", async () => {
    const { tenant } = await nuevoTenant();

    const res = await request(app)
      .put(`/api/platform/tenants/${tenant.id}/plan`)
      .set("Authorization", BEARER)
      .send({ plan: "pequena", motivo: "alta comercial" });

    expect(res.status).toBe(200);
    expect(res.body.plan.codigo).toBe("pequena");

    const leido = await request(app)
      .get(`/api/platform/tenants/${tenant.id}/plan`)
      .set("Authorization", BEARER);
    expect(leido.body.plan.codigo).toBe("pequena");
    expect(leido.body.plan.nombre).toBe("Pequeña");
  });

  it("el cambio de plan queda auditado con antes/después", async () => {
    const { tenant } = await nuevoTenant();
    await request(app)
      .put(`/api/platform/tenants/${tenant.id}/plan`)
      .set("Authorization", BEARER)
      .send({ plan: "mype" });
    await request(app)
      .put(`/api/platform/tenants/${tenant.id}/plan`)
      .set("Authorization", BEARER)
      .send({ plan: "mediana", motivo: "el cliente creció" });

    const auditoria = await pool.query(
      `SELECT detalle FROM platform_audit_log
       WHERE accion = 'asignar_plan_tenant' AND tenant_id = $1 ORDER BY creado_en DESC LIMIT 1`,
      [tenant.id]
    );
    expect(auditoria.rows).toHaveLength(1);
    expect(auditoria.rows[0].detalle.before.codigo).toBe("mype");
    expect(auditoria.rows[0].detalle.after.codigo).toBe("mediana");
    expect(auditoria.rows[0].detalle.motivo).toBe("el cliente creció");
  });

  it("no se puede asignar un plan desactivado (pero quien ya lo tiene lo conserva)", async () => {
    const { tenant } = await nuevoTenant();
    const codigo = "test-baja-" + Date.now();
    const planId = (
      await pool.query(
        `INSERT INTO planes (codigo, nombre, activo) VALUES ($1, 'De baja', false) RETURNING id`,
        [codigo]
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO plan_limites (plan_id, recurso, limite) VALUES ($1, 'flota', 7)`,
      [planId]
    );

    try {
      const res = await request(app)
        .put(`/api/platform/tenants/${tenant.id}/plan`)
        .set("Authorization", BEARER)
        .send({ plan: codigo });
      expect(res.status).toBe(400);

      // Un tenant que ya lo tenía (asignado antes de la baja) lo conserva:
      // dar de baja un plan no puede cambiarle los topes a nadie en silencio.
      await pool.query(`UPDATE tenants SET plan_id = $1 WHERE id = $2`, [planId, tenant.id]);
      expect(await limiteEfectivo(tenant.id, "flota")).toBe(7);
    } finally {
      await pool.query(`UPDATE tenants SET plan_id = NULL WHERE id = $1`, [tenant.id]);
      await pool.query(`DELETE FROM planes WHERE id = $1`, [planId]);
    }
  });

  it("?soloActivos=true no devuelve los planes dados de baja", async () => {
    const codigo = "test-oculto-" + Date.now();
    const planId = (
      await pool.query(
        `INSERT INTO planes (codigo, nombre, activo) VALUES ($1, 'Oculto', false) RETURNING id`,
        [codigo]
      )
    ).rows[0].id;
    try {
      const todos = await request(app).get("/api/platform/planes").set("Authorization", BEARER);
      const activos = await request(app)
        .get("/api/platform/planes?soloActivos=true")
        .set("Authorization", BEARER);

      expect(todos.body.planes.some((p: any) => p.codigo === codigo)).toBe(true);
      expect(activos.body.planes.some((p: any) => p.codigo === codigo)).toBe(false);
    } finally {
      await pool.query(`DELETE FROM planes WHERE id = $1`, [planId]);
    }
  });

  it("borrar un plan NO borra el tenant: queda sin plan y cae al registry", async () => {
    const { tenant } = await nuevoTenant();
    const codigo = "test-efimero-" + Date.now();
    const planId = (
      await pool.query(`INSERT INTO planes (codigo, nombre) VALUES ($1, 'Efímero') RETURNING id`, [
        codigo,
      ])
    ).rows[0].id;
    await pool.query(
      `INSERT INTO plan_limites (plan_id, recurso, limite) VALUES ($1, 'flota', 3)`,
      [planId]
    );
    await asignarPlanATenantService(tenant.id, codigo, contexto);
    expect(await limiteEfectivo(tenant.id, "flota")).toBe(3);

    await pool.query(`DELETE FROM planes WHERE id = $1`, [planId]);
    // Mismo motivo que en el test anterior: el ON DELETE SET NULL corre a
    // nivel de base, sin pasar por asignarPlanATenantService — nadie
    // invalidó el caché por nosotros.
    await invalidarCacheLimitesTenant(tenant.id);

    // ON DELETE SET NULL: el tenant sigue existiendo, sin plan.
    const sigueVivo = await pool.query(`SELECT plan_id FROM tenants WHERE id = $1`, [tenant.id]);
    expect(sigueVivo.rows).toHaveLength(1);
    expect(sigueVivo.rows[0].plan_id).toBeNull();
    expect(await limiteEfectivo(tenant.id, "flota")).toBe(2000);
  });
});

describe("el resumen de cuotas expone de dónde sale cada límite", () => {
  it("marca el origen: override, plan o registry", async () => {
    const { tenant } = await nuevoTenant();
    await asignarPlanATenantService(tenant.id, "mype", contexto);
    await fijarCuotaTenant(tenant.id, "usuarios", 3, "excepción");

    const res = await request(app)
      .get(`/api/platform/tenants/${tenant.id}/cuotas`)
      .set("Authorization", BEARER);

    const porRecurso = Object.fromEntries(res.body.cuotas.map((c: any) => [c.recurso, c]));
    expect(porRecurso.usuarios.origen).toBe("override");
    expect(porRecurso.usuarios.limite).toBe(3);
    expect(porRecurso.flota.origen).toBe("plan");
    expect(porRecurso.flota.limite).toBe(20);
  });
});
