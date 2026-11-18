/** tests/tenant-cuotas.test.ts
 *
 * Cuotas operativas por tenant (migración 0033,
 * docs/architecture/cuotas-por-tenant.md).
 *
 * El caso central no es "bloquea al pasarse", sino los bordes que hacen que
 * una cuota sea usable o insufrible: que un tenant excedido siga pudiendo
 * LEER y BORRAR (si no, queda atrapado sin forma de bajar del límite), que
 * una importación masiva no se cuele con un solo cupo libre, y que el
 * límite de un tenant no afecte a otro.
 */
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico, dniUnico } from "./helpers";
import { env } from "../src/server/config/env";
import { pool, closeDatabase, withTenant } from "../src/server/config/database";
import {
  limiteEfectivo,
  usoActual,
  fijarCuotaTenant,
  resumenCuotasTenant,
  resolverLimite,
  invalidarCacheLimite,
  RECURSO_USUARIOS,
} from "../src/server/services/platformCuotas.service";

const BEARER = `Bearer ${env.platformAdminToken}`;
const password = "ClaveDePrueba123";
const tenantsCreados: string[] = [];

async function nuevoTenant() {
  const creado = await crearTenantDePrueba(password);
  tenantsCreados.push(creado.tenant.id);
  return creado;
}

/** Agente logueado como el admin del tenant, para pegarle a /api/erp/*. */
async function agenteDe(tenant: { slug: string }, email: string) {
  const agente = request.agent(app);
  await agente.post("/api/auth/login").send({ tenantSlug: tenant.slug, email, password });
  return agente;
}

afterAll(async () => {
  for (const id of tenantsCreados) await borrarTenantDePrueba(id);
  await closeDatabase();
});

describe("resolución del límite efectivo", () => {
  // Comparten un tenant: ninguno crea registros, solo leen/escriben su
  // propio override, y cada uno lo fija explícitamente antes de afirmar.
  // Crear uno por test son 6 altas contra POST /tenants, la operación más
  // cara de la suite (tiene rate limit propio).
  let compartido: Awaited<ReturnType<typeof nuevoTenant>>;
  async function tenantLimpio() {
    compartido ??= await nuevoTenant();
    await fijarCuotaTenant(compartido.tenant.id, "flota", undefined);
    return compartido.tenant;
  }

  it("sin override usa el default declarado en el registry", async () => {
    const tenant = await tenantLimpio();
    // equipos declara porDefecto: 2_000 en src/modules/registry.ts
    expect(await limiteEfectivo(tenant.id, "flota")).toBe(2000);
  });

  it("un override por tenant pisa el default", async () => {
    const tenant = await tenantLimpio();
    await fijarCuotaTenant(tenant.id, "flota", 5, "plan reducido de prueba");
    expect(await limiteEfectivo(tenant.id, "flota")).toBe(5);
  });

  it("limite=null significa ILIMITADO, distinto de no tener override", async () => {
    const tenant = await tenantLimpio();
    await fijarCuotaTenant(tenant.id, "flota", null, "cliente enterprise");
    expect(await limiteEfectivo(tenant.id, "flota")).toBeNull();
  });

  it("borrar el override devuelve al default del código, no a ilimitado", async () => {
    const tenant = await tenantLimpio();
    await fijarCuotaTenant(tenant.id, "flota", 5);
    await fijarCuotaTenant(tenant.id, "flota", undefined);
    expect(await limiteEfectivo(tenant.id, "flota")).toBe(2000);
  });

  it("rechaza fijar una cuota sobre un recurso que no existe", async () => {
    const tenant = await tenantLimpio();
    await expect(fijarCuotaTenant(tenant.id, "recurso_inventado", 10)).rejects.toThrow(
      /desconocido/i
    );
  });

  it("dashboard no tiene cuota: no crea registros propios", async () => {
    const tenant = await tenantLimpio();
    const recursos = (await resumenCuotasTenant(tenant.id)).map((c) => c.recurso);
    expect(recursos).not.toContain("dashboard");
    expect(recursos).toContain("flota");
    expect(recursos).toContain(RECURSO_USUARIOS);
  });
});

describe("bloqueo al exceder la cuota de un módulo", () => {
  it("deja crear hasta el límite y rechaza el siguiente con 403 y cuerpo estructurado", async () => {
    const { tenant, usuario } = await nuevoTenant();
    await fijarCuotaTenant(tenant.id, "flota", 2);
    const agente = await agenteDe(tenant, usuario.email);

    for (const n of [1, 2]) {
      const ok = await agente
        .post("/api/erp/equipos")
        .send({ placa_codigo: idUnico(`EQ-${n}`), tipo: "Camioneta" });
      expect(ok.status).toBe(201);
    }

    const rechazado = await agente
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("EQ-3"), tipo: "Camioneta" });

    expect(rechazado.status).toBe(403);
    expect(rechazado.body.error).toBe("cuota_excedida");
    expect(rechazado.body.recurso).toBe("flota");
    expect(rechazado.body.limite).toBe(2);
    expect(rechazado.body.uso).toBe(2);
  });

  it("un tenant excedido SIGUE pudiendo leer y borrar (si no, queda atrapado)", async () => {
    const { tenant, usuario } = await nuevoTenant();
    await fijarCuotaTenant(tenant.id, "flota", 1);
    const agente = await agenteDe(tenant, usuario.email);

    const creado = await agente
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("EQ"), tipo: "Camioneta" });
    expect(creado.status).toBe(201);
    // Ya está en el límite: la siguiente creación rebota.
    expect(
      (await agente.post("/api/erp/equipos").send({ placa_codigo: idUnico("EQ"), tipo: "X" }))
        .status
    ).toBe(403);

    // Leer sigue funcionando.
    const listado = await agente.get("/api/erp/equipos");
    expect(listado.status).toBe(200);

    // Borrar también — es la única forma de volver por debajo del límite.
    const borrado = await agente.delete(`/api/erp/equipos/${creado.body.id}`);
    expect(borrado.status).toBe(200);

    // Y liberado el cupo, se puede volver a crear.
    const despues = await agente
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("EQ"), tipo: "Camioneta" });
    expect(despues.status).toBe(201);
  });

  it("una importación masiva NO se cuela con un solo cupo libre", async () => {
    const { tenant, usuario } = await nuevoTenant();
    await fijarCuotaTenant(tenant.id, "repuestos", 3);
    const agente = await agenteDe(tenant, usuario.email);

    const lote = Array.from({ length: 10 }, (_, i) => ({
      codigo: idUnico(`R-${i}`),
      nombre: `Repuesto ${i}`,
      categoria: "General",
      stock: 1,
      stock_minimo: 1,
      stock_maximo: 5,
      precio: 10,
    }));

    const rechazado = await agente.post("/api/erp/repuestos/bulk").send(lote);

    expect(rechazado.status).toBe(403);
    expect(rechazado.body.error).toBe("cuota_excedida");
    // Nada se insertó: el chequeo corre ANTES del insert.
    expect(await usoActual(tenant.id, "repuestos")).toBe(0);
  });

  it("un lote que entra justo en el cupo sí pasa", async () => {
    const { tenant, usuario } = await nuevoTenant();
    await fijarCuotaTenant(tenant.id, "repuestos", 3);
    const agente = await agenteDe(tenant, usuario.email);

    const lote = Array.from({ length: 3 }, (_, i) => ({
      codigo: idUnico(`R-${i}`),
      nombre: `Repuesto ${i}`,
      categoria: "General",
      stock: 1,
      stock_minimo: 1,
      stock_maximo: 5,
      precio: 10,
    }));

    expect((await agente.post("/api/erp/repuestos/bulk").send(lote)).status).toBe(201);
    expect(await usoActual(tenant.id, "repuestos")).toBe(3);
  });

  it("la cuota de un tenant no afecta a otro", async () => {
    const a = await nuevoTenant();
    const b = await nuevoTenant();
    await fijarCuotaTenant(a.tenant.id, "flota", 0); // A no puede crear ninguno

    const agenteA = await agenteDe(a.tenant, a.usuario.email);
    const agenteB = await agenteDe(b.tenant, b.usuario.email);

    expect(
      (await agenteA.post("/api/erp/equipos").send({ placa_codigo: idUnico("A"), tipo: "X" }))
        .status
    ).toBe(403);
    expect(
      (await agenteB.post("/api/erp/equipos").send({ placa_codigo: idUnico("B"), tipo: "X" }))
        .status
    ).toBe(201);
  });

  it("un módulo ilimitado no bloquea nada", async () => {
    const { tenant, usuario } = await nuevoTenant();
    await fijarCuotaTenant(tenant.id, "flota", null);
    const agente = await agenteDe(tenant, usuario.email);

    for (let i = 0; i < 3; i++) {
      const res = await agente
        .post("/api/erp/equipos")
        .send({ placa_codigo: idUnico("EQ"), tipo: "Camioneta" });
      expect(res.status).toBe(201);
    }
  });

  it("el bloqueo queda auditado como failure", async () => {
    const { tenant, usuario } = await nuevoTenant();
    await fijarCuotaTenant(tenant.id, "flota", 0);
    const agente = await agenteDe(tenant, usuario.email);
    await agente.post("/api/erp/equipos").send({ placa_codigo: idUnico("EQ"), tipo: "X" });

    const auditoria = await pool.query(
      `SELECT resultado, detalle FROM platform_audit_log
       WHERE accion = 'cuota.bloqueo' AND tenant_id = $1 ORDER BY creado_en DESC LIMIT 1`,
      [tenant.id]
    );
    expect(auditoria.rows).toHaveLength(1);
    expect(auditoria.rows[0].resultado).toBe("failure");
    expect(auditoria.rows[0].detalle.recurso).toBe("flota");
  });
});

describe("cuota independiente por ruta (Repuestos: catálogo vs. movimientos)", () => {
  async function crearRepuesto(tenantId: string, stock: number): Promise<number> {
    const fila = await withTenant(tenantId, (client) =>
      client.query(
        `INSERT INTO repuestos (tenant_id, codigo, nombre, stock) VALUES ($1, $2, $3, $4) RETURNING id`,
        [tenantId, idUnico("CUOTA"), "Repuesto de prueba", stock]
      )
    );
    return fila.rows[0].id;
  }

  it("la cuota de movimientos AGOTADA no bloquea un alta de catálogo", async () => {
    const { tenant, usuario } = await nuevoTenant();
    await fijarCuotaTenant(tenant.id, "repuestos_movimientos", 0);
    const agente = await agenteDe(tenant, usuario.email);

    const alta = await agente.post("/api/erp/repuestos").send({
      codigo: idUnico("CAT"),
      nombre: "Repuesto nuevo",
      categoria: "General",
      stock: 5,
      stock_minimo: 1,
      stock_maximo: 10,
      precio: 10,
    });
    expect(alta.status).toBe(201);
  });

  it("la cuota de catálogo AGOTADA no bloquea un movimiento de stock", async () => {
    const { tenant, usuario } = await nuevoTenant();
    const repuestoId = await crearRepuesto(tenant.id, 100);
    await fijarCuotaTenant(tenant.id, "repuestos", 0);
    const agente = await agenteDe(tenant, usuario.email);

    const mov = await agente.post("/api/erp/repuestos/movimientos").send({
      cliente_uuid: crypto.randomUUID(),
      repuesto_id: repuestoId,
      tipo: "entrada",
      cantidad: 1,
    });
    expect(mov.status).toBe(201);
  });

  it("deja registrar movimientos hasta su propio límite y rechaza el siguiente sobre el recurso 'repuestos_movimientos'", async () => {
    const { tenant, usuario } = await nuevoTenant();
    const repuestoId = await crearRepuesto(tenant.id, 100);
    await fijarCuotaTenant(tenant.id, "repuestos_movimientos", 2);
    const agente = await agenteDe(tenant, usuario.email);

    for (let i = 0; i < 2; i++) {
      const ok = await agente.post("/api/erp/repuestos/movimientos").send({
        cliente_uuid: crypto.randomUUID(),
        repuesto_id: repuestoId,
        tipo: "entrada",
        cantidad: 1,
      });
      expect(ok.status).toBe(201);
    }

    const rechazado = await agente.post("/api/erp/repuestos/movimientos").send({
      cliente_uuid: crypto.randomUUID(),
      repuesto_id: repuestoId,
      tipo: "entrada",
      cantidad: 1,
    });
    expect(rechazado.status).toBe(403);
    expect(rechazado.body.error).toBe("cuota_excedida");
    expect(rechazado.body.recurso).toBe("repuestos_movimientos");
  });

  it("resumenCuotasTenant() lista 'repuestos' y 'repuestos_movimientos' como recursos aparte", async () => {
    const { tenant } = await nuevoTenant();
    const recursos = (await resumenCuotasTenant(tenant.id)).map((c) => c.recurso);
    expect(recursos).toContain("repuestos");
    expect(recursos).toContain("repuestos_movimientos");
  });
});

describe("cuota de Viajes y de lecturas del medidor (0191)", () => {
  const H = 3_600_000;
  const hora = (h: number) => new Date(Date.now() - 100 * H + h * H).toISOString();

  /** Una empresa con Flota y Viajes (todos los módulos, como nace), con su origen y destino. */
  async function conViajes() {
    const { tenant, usuario } = await nuevoTenant();
    const agente = await agenteDe(tenant, usuario.email);
    const lugar = async () =>
      Number((await agente.post("/api/erp/viajes/lugares").send({ nombre: idUnico("L") })).body.id);
    const origen = await lugar();
    const destino = await lugar();
    const unidad = async () => {
      const r = await agente.post("/api/erp/equipos").send({
        placa_codigo: idUnico("CV"),
        tipo: "VOLQUETE",
        tipo_medidor: "odometro",
        conductor_nombre: "Juan Pérez",
        conductor_dni: dniUnico(),
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return Number(r.body.id);
    };
    // Una unidad distinta por viaje: así no se pisan los horarios de la misma unidad.
    // OJO: la unidad se crea ANTES de armar la petición. Un `await` dentro del `.send()` de otra
    // petición del mismo agente de supertest rompe con «reading 'address'».
    const programar = async (h: number) => {
      const equipoId = await unidad();
      return agente.post("/api/erp/viajes").send({
        equipo_id: equipoId,
        origen_id: origen,
        destino_id: destino,
        salida_programada_en: hora(h),
      });
    };
    return { tenant, agente, programar, unidad };
  }

  it("deja crear viajes hasta su propio límite y rechaza el siguiente sobre el recurso 'viajes'", async () => {
    const { tenant, programar } = await conViajes();
    await fijarCuotaTenant(tenant.id, "viajes", 1);

    const primero = await programar(90);
    expect(primero.status, JSON.stringify(primero.body)).toBe(201);

    const rechazado = await programar(92);
    expect(rechazado.status).toBe(403);
    expect(rechazado.body.error).toBe("cuota_excedida");
    expect(rechazado.body.recurso).toBe("viajes");
  });

  it("la cuota de viajes AGOTADA no bloquea iniciar ni cerrar un viaje que ya existe", async () => {
    const { tenant, agente, programar } = await conViajes();
    const viaje = await programar(90);
    expect(viaje.status, JSON.stringify(viaje.body)).toBe(201);
    await fijarCuotaTenant(tenant.id, "viajes", 0);

    // Iniciar y cerrar no crean un viaje: el tope lleno no los toca (la base `cuota` los mediría).
    const inicio = await agente
      .post(`/api/erp/viajes/${viaje.body.id}/iniciar`)
      .send({ inicio_en: hora(91), medidor_inicio: 1000, motivo: "Marca de oficina" });
    expect(inicio.status, JSON.stringify(inicio.body)).toBe(200);
    const cierre = await agente
      .post(`/api/erp/viajes/${viaje.body.id}/cerrar`)
      .send({ fin_en: hora(95), medidor_fin: 1200, motivo: "Marca de oficina" });
    expect(cierre.status, JSON.stringify(cierre.body)).toBe(200);

    // Y crear uno nuevo sí está bloqueado.
    const nuevo = await programar(100);
    expect(nuevo.status).toBe(403);
    expect(nuevo.body.recurso).toBe("viajes");
  });

  it("la ruta del conductor (POST /crear-mio) también cuenta para el tope de viajes", async () => {
    const { tenant, agente } = await conViajes();

    // Con cupo, esta petición (cuerpo vacío) no llega a la cuota: falla por otra cosa.
    const conCupo = await agente.post("/api/erp/viajes/crear-mio").send({});
    expect(conCupo.body.error).not.toBe("cuota_excedida");

    await fijarCuotaTenant(tenant.id, "viajes", 0);
    const sinCupo = await agente.post("/api/erp/viajes/crear-mio").send({});
    expect(sinCupo.status).toBe(403);
    expect(sinCupo.body.error).toBe("cuota_excedida");
    expect(sinCupo.body.recurso).toBe("viajes");
  });

  it("las lecturas del medidor tienen su propio tope y ya no se miden contra el de equipos", async () => {
    const { tenant, agente, unidad } = await conViajes();
    const id = await unidad();
    const lectura = (valor: number, h: number) =>
      agente.post(`/api/erp/equipos/${id}/lecturas`).send({ valor, leido_en: hora(h) });

    // Con el tope de EQUIPOS agotado, crear una unidad se rechaza, pero registrar una lectura pasa.
    await fijarCuotaTenant(tenant.id, "flota", 0);
    const equipoNuevo = await agente
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("NUEVO"), tipo: "VOLQUETE" });
    expect(equipoNuevo.status).toBe(403);
    expect(equipoNuevo.body.recurso).toBe("flota");
    const primera = await lectura(1000, 10);
    expect(primera.status, JSON.stringify(primera.body)).toBe(201);

    // Con el de LECTURAS en 1 (ya hay una), la siguiente se rechaza sobre su propio recurso.
    await fijarCuotaTenant(tenant.id, "equipo_lecturas", 1);
    const segunda = await lectura(1100, 20);
    expect(segunda.status).toBe(403);
    expect(segunda.body.error).toBe("cuota_excedida");
    expect(segunda.body.recurso).toBe("equipo_lecturas");
  });

  it("resumenCuotasTenant() lista 'viajes' UNA vez (tiene dos rutas) y 'equipo_lecturas' aparte", async () => {
    const { tenant } = await nuevoTenant();
    const recursos = (await resumenCuotasTenant(tenant.id)).map((c) => c.recurso);
    expect(recursos.filter((r) => r === "viajes")).toHaveLength(1);
    expect(recursos).toContain("equipo_lecturas");
    // El catálogo de equipos sigue aparte del histórico de lecturas.
    expect(recursos).toContain("flota");
  });
});

describe("cuota de usuarios", () => {
  it("bloquea el alta cuando se llega al límite (cubre panel y SCIM: comparten servicio)", async () => {
    const { tenant } = await nuevoTenant();
    // El tenant ya tiene su admin, así que el límite 1 está consumido.
    await fijarCuotaTenant(tenant.id, RECURSO_USUARIOS, 1);

    const res = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/usuarios`)
      .set("Authorization", BEARER)
      .send({ nombre: "Segundo", email: idUnico("u") + "@test.dev", password });

    expect(res.status).toBe(403);
  });

  it("cuenta usuarios ACTIVOS: desactivar a alguien libera su cupo", async () => {
    const { tenant, usuario } = await nuevoTenant();
    await fijarCuotaTenant(tenant.id, RECURSO_USUARIOS, 1);

    // Con el admin activo, no entra nadie más.
    const bloqueado = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/usuarios`)
      .set("Authorization", BEARER)
      .send({ nombre: "Segundo", email: idUnico("u") + "@test.dev", password });
    expect(bloqueado.status).toBe(403);

    // Se desactiva al admin — "eliminar" un usuario acá es desactivarlo, y
    // eso tiene que devolver el cupo. Si se contaran filas, un tenant con
    // rotación de personal se quedaría sin cupo para siempre.
    await request(app)
      .patch(`/api/platform/tenants/${tenant.id}/usuarios/${usuario.id}/estado`)
      .set("Authorization", BEARER)
      .send({ activo: false });

    expect(await usoActual(tenant.id, RECURSO_USUARIOS)).toBe(0);

    const permitido = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/usuarios`)
      .set("Authorization", BEARER)
      .send({ nombre: "Segundo", email: idUnico("u") + "@test.dev", password });
    expect(permitido.status).toBe(201);
  });
});

describe("endpoints del panel", () => {
  it("GET devuelve uso y límite juntos de todos los recursos", async () => {
    const { tenant, usuario } = await nuevoTenant();
    const agente = await agenteDe(tenant, usuario.email);
    await agente.post("/api/erp/equipos").send({ placa_codigo: idUnico("EQ"), tipo: "Camioneta" });

    const res = await request(app)
      .get(`/api/platform/tenants/${tenant.id}/cuotas`)
      .set("Authorization", BEARER);

    expect(res.status).toBe(200);
    const equipos = res.body.cuotas.find((c: any) => c.recurso === "flota");
    expect(equipos.uso).toBe(1);
    expect(equipos.limite).toBe(2000);
    expect(equipos.excedido).toBe(false);

    const backups = res.body.cuotas.find((c: any) => c.recurso === "backup_bytes");
    expect(backups.unidad).toBe("bytes");
  });

  it("PUT fija el límite y el GET siguiente lo refleja", async () => {
    const { tenant } = await nuevoTenant();

    const res = await request(app)
      .put(`/api/platform/tenants/${tenant.id}/cuotas`)
      .set("Authorization", BEARER)
      .send({ recurso: "flota", limite: 7, motivo: "plan piloto" });

    expect(res.status).toBe(200);
    expect(res.body.cuotas.find((c: any) => c.recurso === "flota").limite).toBe(7);

    const guardado = await pool.query(
      `SELECT motivo FROM tenant_cuotas WHERE tenant_id = $1 AND recurso = 'flota'`,
      [tenant.id]
    );
    expect(guardado.rows[0].motivo).toBe("plan piloto");
  });

  it("PUT rechaza un recurso inexistente con 400", async () => {
    const { tenant } = await nuevoTenant();
    const res = await request(app)
      .put(`/api/platform/tenants/${tenant.id}/cuotas`)
      .set("Authorization", BEARER)
      .send({ recurso: "no_existe", limite: 5 });
    expect(res.status).toBe(400);
  });
});

describe("integración con la salud del tenant", () => {
  it("alerta cuando una cuota está cerca del límite, y cuando ya se excedió", async () => {
    const { tenant, usuario } = await nuevoTenant();
    await fijarCuotaTenant(tenant.id, "flota", 4);
    const agente = await agenteDe(tenant, usuario.email);

    // 3 de 4 = 75%: todavía sin alerta de cuota.
    for (let i = 0; i < 3; i++) {
      await agente
        .post("/api/erp/equipos")
        .send({ placa_codigo: idUnico("EQ"), tipo: "Camioneta" });
    }
    let salud = await request(app)
      .get(`/api/platform/tenants/${tenant.id}/salud`)
      .set("Authorization", BEARER);
    expect(salud.body.salud.alertas).not.toContain("cuota_cerca_del_limite");

    // 4 de 4 = 100%: excedido (el próximo se bloquea).
    await agente.post("/api/erp/equipos").send({ placa_codigo: idUnico("EQ"), tipo: "Camioneta" });
    salud = await request(app)
      .get(`/api/platform/tenants/${tenant.id}/salud`)
      .set("Authorization", BEARER);
    expect(salud.body.salud.alertas).toContain("cuota_excedida");
    expect(salud.body.salud.cuotas.find((c: any) => c.recurso === "flota").porcentaje).toBe(100);
  });
});

describe("cuota de backups por tamaño", () => {
  it("bloquea crear un backup nuevo cuando el acumulado llegó al límite", async () => {
    const { tenant } = await nuevoTenant();

    const primero = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/backups`)
      .set("Authorization", BEARER);
    expect(primero.status).toBe(201);
    expect(primero.body.backup.tamanoBytes).toBeGreaterThan(0);

    // Se fija el límite justo en lo que ya ocupa: el siguiente no entra.
    await fijarCuotaTenant(tenant.id, "backup_bytes", primero.body.backup.tamanoBytes);

    const segundo = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/backups`)
      .set("Authorization", BEARER);
    expect(segundo.status).toBe(403);
  });

  it("borrar los backups viejos (retención) libera la cuota", async () => {
    const { tenant } = await nuevoTenant();
    const backup = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/backups`)
      .set("Authorization", BEARER);
    await fijarCuotaTenant(tenant.id, "backup_bytes", backup.body.backup.tamanoBytes);

    expect(
      (
        await request(app)
          .post(`/api/platform/tenants/${tenant.id}/backups`)
          .set("Authorization", BEARER)
      ).status
    ).toBe(403);

    // Simula lo que hace el worker de retención al podar.
    await pool.query(`DELETE FROM tenant_backups WHERE tenant_id = $1`, [tenant.id]);
    expect(await usoActual(tenant.id, "backup_bytes")).toBe(0);

    expect(
      (
        await request(app)
          .post(`/api/platform/tenants/${tenant.id}/backups`)
          .set("Authorization", BEARER)
      ).status
    ).toBe(201);
  });
});

describe("medición del uso", () => {
  it("cuenta solo las filas del propio tenant (RLS + filtro explícito)", async () => {
    const a = await nuevoTenant();
    const b = await nuevoTenant();

    await withTenant(a.tenant.id, (client) =>
      client.query(`INSERT INTO equipos (tenant_id, placa_codigo, tipo) VALUES ($1, $2, 'X')`, [
        a.tenant.id,
        idUnico("EQ"),
      ])
    );

    expect(await usoActual(a.tenant.id, "flota")).toBe(1);
    expect(await usoActual(b.tenant.id, "flota")).toBe(0);
  });
});

describe("caché de resolverLimite()", () => {
  it("una escritura por fuera de fijarCuotaTenant queda stale hasta invalidar a mano", async () => {
    const { tenant } = await nuevoTenant();

    // Primera lectura: cachea "sin override" (cae al plan/registry).
    expect((await resolverLimite(tenant.id, "flota")).origen).not.toBe("override");

    // Se escribe el override directo a la tabla, sin pasar por
    // fijarCuotaTenant — nadie invalida el caché por esto.
    await pool.query(
      `INSERT INTO tenant_cuotas (tenant_id, recurso, limite) VALUES ($1, 'flota', 7)
       ON CONFLICT (tenant_id, recurso) DO UPDATE SET limite = 7`,
      [tenant.id]
    );
    expect((await resolverLimite(tenant.id, "flota")).origen).not.toBe("override"); // todavía cacheado

    await invalidarCacheLimite(tenant.id, "flota");
    const fresco = await resolverLimite(tenant.id, "flota");
    expect(fresco.origen).toBe("override");
    expect(fresco.limite).toBe(7);
  });

  it("fijarCuotaTenant invalida solo, sin necesidad de tocar el caché a mano", async () => {
    const { tenant } = await nuevoTenant();
    await resolverLimite(tenant.id, "flota"); // cachea el valor sin override

    await fijarCuotaTenant(tenant.id, "flota", 9, "prueba de invalidación");
    const r = await resolverLimite(tenant.id, "flota");
    expect(r.origen).toBe("override");
    expect(r.limite).toBe(9);
  });
});
