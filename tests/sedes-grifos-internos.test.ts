/** tests/sedes-grifos-internos.test.ts
 *
 * Sedes y grifos internos (migración 0097, entrega 1 de
 * docs/architecture/combustible-sedes-grifos-surtidores.md).
 *
 * Método de siempre: atacar la API, y cada ataque con su GEMELO de control.
 * Si el gemelo también fallara, el "rechazó" del ataque no probaría nada.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { env } from "../src/server/config/env";
import { closeDatabase, pool, withTenant } from "../src/server/config/database";
import { guardarBackup, leerBackup } from "../src/server/services/platformBackupStorage";

const BEARER = `Bearer ${env.platformAdminToken}`;
const password = "ClaveDePrueba123";
const hace = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString();
let seq = 0;
const serieUnica = () => `G${Date.now().toString(36).slice(-5)}${(seq++).toString(36)}`;

type Agente = ReturnType<typeof request.agent>;

interface Grifo {
  id: number;
  nombre: string;
  activo: boolean;
}
interface Sede {
  id: number;
  nombre: string;
  activo: boolean;
  grifos: Grifo[];
}

const tenantsCreados: string[] = [];

async function empresa() {
  const creado = await crearTenantDePrueba(password);
  tenantsCreados.push(creado.tenant.id);
  const admin = request.agent(app);
  await admin
    .post("/api/auth/login")
    .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });
  return {
    tenantId: creado.tenant.id,
    slug: creado.tenant.slug,
    admin,
    usuarioId: creado.usuario.id,
  };
}

async function conRol(admin: Agente, slug: string, rol: string) {
  const agente = request.agent(app);
  const dni = String(86100000 + Math.floor(Math.random() * 800000) + seq++);
  const alta = await admin
    .post("/api/erp/usuarios")
    .send({ nombre: `Persona ${rol}`, dni, password, rol });
  expect(alta.status).toBe(201);
  const entro = await agente
    .post("/api/auth/login")
    .send({ tenantSlug: slug, identificador: dni, password });
  expect(entro.status).toBe(200);
  return agente;
}

const sedes = async (ag: Agente) => (await ag.get("/api/erp/sedes")).body.sedes as Sede[];

async function grifoPrincipal(ag: Agente) {
  const [s] = await sedes(ag);
  return s.grifos[0].id;
}

async function nuevoGrifo(ag: Agente, sedeId: number, nombre = idUnico("Grifo")) {
  const r = await ag.post("/api/erp/administracion/grifos").send({ sede_id: sedeId, nombre });
  expect(r.status).toBe(201);
  return r.body.id as number;
}

const tanque = (ag: Agente, extra: Record<string, unknown> = {}) =>
  ag.post("/api/erp/combustible").send({
    codigo: idUnico("TQ"),
    tanque_nombre: "Tanque de planta",
    tipo_combustible: "diesel_b5",
    unidad: "L",
    tipo_punto: "fijo",
    capacidad_total: 20000,
    nivel_actual: 10000,
    nivel_minimo: 1000,
    requiere_documento: false,
    modo_vigilancia: "sin_vigilar",
    ...extra,
  });

const equipo = (ag: Agente, extra: Record<string, unknown> = {}) =>
  ag.post("/api/erp/equipos").send({ placa_codigo: idUnico("EQ"), tipo: "Volquete", ...extra });

const moverTanque = (ag: Agente, id: number, cuerpo: Record<string, unknown>) =>
  ag.post(`/api/erp/combustible/${id}/mover-grifo`).send(cuerpo);

afterAll(async () => {
  for (const id of tenantsCreados) await borrarTenantDePrueba(id);
  await closeDatabase();
});

describe("sedes y grifos internos: el caso simple no cambia nada", () => {
  it("una empresa nueva nace con su sede y su grifo Principal", async () => {
    const { admin } = await empresa();
    const lista = await sedes(admin);
    expect(lista).toHaveLength(1);
    expect(lista[0].nombre).toBe("Principal");
    expect(lista[0].grifos.map((g) => g.nombre)).toEqual(["Principal"]);
  });

  it("tanques y equipos sin grifo van solos al único grifo, por API y por SQL", async () => {
    const { admin, tenantId } = await empresa();
    const principal = await grifoPrincipal(admin);

    const t = await tanque(admin);
    expect(t.status).toBe(201);
    expect(t.body.grifo_interno_id).toBe(principal);
    const e = await equipo(admin);
    expect(e.status).toBe(201);
    expect(e.body.grifo_interno_id).toBe(principal);

    // Los tests y scripts viejos insertan por SQL sin saber de grifos.
    const porSql = await withTenant(tenantId, (c) =>
      c.query<{ grifo_interno_id: number }>(
        `INSERT INTO combustible (tenant_id, codigo, tanque_nombre, tipo_combustible, unidad,
           tipo_punto, capacidad_total)
         VALUES ($1, $2, 'SQL', 'diesel_b5', 'L', 'fijo', 5000) RETURNING grifo_interno_id`,
        [tenantId, idUnico("TQ")]
      )
    );
    expect(porSql.rows[0].grifo_interno_id).toBe(principal);
  });

  it("cada hecho copia su grifo al registrarse", async () => {
    const { admin, tenantId } = await empresa();
    const principal = await grifoPrincipal(admin);
    const t = await tanque(admin);
    const lectura = await admin
      .post("/api/erp/combustible/lecturas")
      .send({ combustible_id: t.body.id, nivel: 9000 });
    expect(lectura.status).toBe(201);
    const copia = await withTenant(tenantId, (c) =>
      c.query(`SELECT grifo_interno_id FROM combustible_lecturas WHERE id = $1`, [
        lectura.body.lectura.id,
      ])
    );
    expect(copia.rows[0].grifo_interno_id).toBe(principal);
  });
});

describe("administración de sedes y grifos", () => {
  let admin: Agente;
  let operador: Agente;
  let sedeId: number;

  beforeAll(async () => {
    const e = await empresa();
    admin = e.admin;
    operador = await conRol(admin, e.slug, "operador");
    sedeId = (await sedes(admin))[0].id;
  });

  it("solo el admin crea; cualquiera lista", async () => {
    const r = await operador.post("/api/erp/administracion/sedes").send({ nombre: "Norte" });
    expect(r.status).toBe(403);
    expect((await operador.get("/api/erp/sedes")).status).toBe(200);
    const ok = await admin.post("/api/erp/administracion/sedes").send({ nombre: "Norte" });
    expect(ok.status).toBe(201);
  });

  it("el nombre no se repite, sin importar mayúsculas ni espacios", async () => {
    const r = await admin.post("/api/erp/administracion/sedes").send({ nombre: "  norte " });
    expect(r.status).toBe(409);
    await nuevoGrifo(admin, sedeId, "Grifo Este");
    const dup = await admin
      .post("/api/erp/administracion/grifos")
      .send({ sede_id: sedeId, nombre: "GRIFO ESTE" });
    expect(dup.status).toBe(409);
  });
});

describe("con más de un grifo, el grifo es obligatorio", () => {
  let admin: Agente;
  let principal: number;
  let otro: number;

  beforeAll(async () => {
    const e = await empresa();
    admin = e.admin;
    principal = await grifoPrincipal(admin);
    otro = await nuevoGrifo(admin, (await sedes(admin))[0].id);
  });

  it("tanque y equipo sin grifo: 400; con grifo: 201", async () => {
    const sinT = await tanque(admin);
    expect(sinT.status).toBe(400);
    expect(sinT.body.error).toMatch(/grifo interno/);
    const conT = await tanque(admin, { grifo_interno_id: otro });
    expect(conT.status).toBe(201);
    expect(conT.body.grifo_interno_id).toBe(otro);

    const sinE = await equipo(admin);
    expect(sinE.status).toBe(400);
    expect((await equipo(admin, { grifo_interno_id: principal })).status).toBe(201);
  });

  it("la carga masiva sin grifo se rechaza entera", async () => {
    const fila = (codigo: string, extra: Record<string, unknown> = {}) => ({
      codigo,
      tanque_nombre: "Masivo",
      tipo_combustible: "diesel_b5",
      unidad: "L",
      tipo_punto: "fijo",
      capacidad_total: 5000,
      nivel_actual: 0,
      nivel_minimo: 0,
      ...extra,
    });
    const mal = await admin
      .post("/api/erp/combustible/bulk")
      .send([fila(idUnico("M")), fila(idUnico("M"), { grifo_interno_id: otro })]);
    expect(mal.status).toBe(400);
    const bien = await admin
      .post("/api/erp/combustible/bulk")
      .send([fila(idUnico("M"), { grifo_interno_id: otro })]);
    expect(bien.status).toBe(201);
  });

  it("el PUT no cambia el grifo: tiene su propio camino", async () => {
    const t = await tanque(admin, { grifo_interno_id: principal });
    const ficha = (await admin.get(`/api/erp/combustible/${t.body.id}`)).body;
    const r = await admin.put(`/api/erp/combustible/${t.body.id}`).send({
      codigo: ficha.codigo,
      tanque_nombre: ficha.tanque_nombre,
      tipo_combustible: ficha.tipo_combustible,
      unidad: ficha.unidad,
      tipo_punto: ficha.tipo_punto,
      capacidad_total: Number(ficha.capacidad_total),
      nivel_minimo: Number(ficha.nivel_minimo),
      moneda: ficha.moneda,
      activo: true,
      tolerancia_capacidad_pct: Number(ficha.tolerancia_capacidad_pct),
      modo_excedente_recepcion: ficha.modo_excedente_recepcion,
      limite_excedente_pct:
        ficha.limite_excedente_pct === null ? null : Number(ficha.limite_excedente_pct),
      requiere_documento: false,
      umbral_diferencia_pct: null,
      umbral_descuadre_pct: null,
      umbral_descuadre_ciclo_pct: null,
      umbral_descuadre_ventana_pct: null,
      grifo_interno_id: otro,
    });
    expect(r.status).toBe(400);
  });
});

describe("integridad entre empresas", () => {
  it("un tanque no puede apuntar al grifo de otra empresa, ni por API ni por SQL", async () => {
    const a = await empresa();
    const b = await empresa();
    const grifoDeB = await grifoPrincipal(b.admin);

    const r = await tanque(a.admin, { grifo_interno_id: grifoDeB });
    expect(r.status).toBe(400);
    // Gemelo: con su propio grifo pasa.
    expect(
      (await tanque(a.admin, { grifo_interno_id: await grifoPrincipal(a.admin) })).status
    ).toBe(201);

    // Por SQL, la clave compuesta lo rechaza aunque alguien se saltee el servicio.
    await expect(
      withTenant(a.tenantId, (c) =>
        c.query(
          `INSERT INTO combustible (tenant_id, codigo, tanque_nombre, tipo_combustible, unidad,
             tipo_punto, capacidad_total, grifo_interno_id)
           VALUES ($1, $2, 'X', 'diesel_b5', 'L', 'fijo', 5000, $3)`,
          [a.tenantId, idUnico("TQ"), grifoDeB]
        )
      )
    ).rejects.toMatchObject({ code: "23503" });
  });
});

describe("mover de grifo", () => {
  let admin: Agente;
  let operador: Agente;
  let tenantId: string;
  let principal: number;
  let norte: number;

  beforeAll(async () => {
    const e = await empresa();
    admin = e.admin;
    tenantId = e.tenantId;
    operador = await conRol(admin, e.slug, "operador");
    principal = await grifoPrincipal(admin);
    norte = await nuevoGrifo(admin, (await sedes(admin))[0].id, "Norte");
  });

  it("sin motivo, al mismo grifo o a uno dado de baja: 400; el operador: 403", async () => {
    const t = await tanque(admin, { grifo_interno_id: principal });
    expect((await moverTanque(admin, t.body.id, { grifo_interno_id: norte })).status).toBe(400);
    expect(
      (await moverTanque(admin, t.body.id, { grifo_interno_id: principal, motivo: "x" })).status
    ).toBe(400);
    expect(
      (await moverTanque(operador, t.body.id, { grifo_interno_id: norte, motivo: "x" })).status
    ).toBe(403);

    const cerrado = await nuevoGrifo(admin, (await sedes(admin))[0].id);
    await admin
      .patch(`/api/erp/administracion/grifos/${cerrado}/baja`)
      .send({ motivo: "Se cerró" });
    expect(
      (await moverTanque(admin, t.body.id, { grifo_interno_id: cerrado, motivo: "x" })).status
    ).toBe(400);
  });

  it("mover deja historial y bitácora, y no reescribe el pasado", async () => {
    const e = await equipo(admin, { grifo_interno_id: principal });
    const t = await tanque(admin, { grifo_interno_id: principal });
    const vale = (cuando: string) =>
      admin.post("/api/erp/combustible/despachos").send({
        origen: "tanque_propio",
        combustible_id: t.body.id,
        tipo_combustible: "diesel_b5",
        tipo_destino: "equipo",
        equipo_id: e.body.id,
        serie_talonario: serieUnica(),
        n_vale: 1,
        cantidad: 100,
        lectura_contometro: 100,
        costo_unitario: 16,
        despachado_en: cuando,
      });

    const antes = await vale(hace(3));
    expect(antes.status).toBe(201);

    const mov = await moverTanque(admin, t.body.id, {
      grifo_interno_id: norte,
      motivo: "La cisterna se llevó a la planta norte",
    });
    expect(mov.status).toBe(200);

    const despues = await vale(new Date().toISOString());
    // El vale que se cargó sin red HACE dos horas, cuando el tanque todavía
    // estaba en Principal, llega recién ahora.
    const tardio = await vale(hace(2));

    const copias = await withTenant(tenantId, (c) =>
      c.query<{ id: string; grifo_interno_id: number }>(
        `SELECT id, grifo_interno_id FROM combustible_despachos WHERE id = ANY($1::bigint[])`,
        [[antes.body.id, despues.body.id, tardio.body.id]]
      )
    );
    const grifoDe = (id: number) =>
      copias.rows.find((r) => Number(r.id) === Number(id))!.grifo_interno_id;
    expect(grifoDe(antes.body.id)).toBe(principal);
    expect(grifoDe(despues.body.id)).toBe(norte);
    expect(grifoDe(tardio.body.id)).toBe(principal);

    const hist = await admin.get(`/api/erp/combustible/${t.body.id}/movimientos-grifo`);
    expect(hist.body).toHaveLength(1);
    expect(hist.body[0]).toMatchObject({
      grifo_origen_id: principal,
      grifo_destino_id: norte,
      motivo: "La cisterna se llevó a la planta norte",
    });

    const eventos = await admin
      .get("/api/erp/administracion/eventos")
      .query({ accion: "combustible.tanque_mover_grifo" });
    expect(eventos.status).toBe(200);
    expect(JSON.stringify(eventos.body)).toContain("La cisterna se llevó a la planta norte");
  });

  it("mover un equipo también deja rastro", async () => {
    const e = await equipo(admin, { grifo_interno_id: principal });
    const r = await admin
      .post(`/api/erp/equipos/${e.body.id}/mover-grifo`)
      .send({ grifo_interno_id: norte, motivo: "Asignado a la obra norte" });
    expect(r.status).toBe(200);
    const hist = await admin.get(`/api/erp/equipos/${e.body.id}/movimientos-grifo`);
    expect(hist.body[0]).toMatchObject({ grifo_destino_id: norte });
  });

  it("un UPDATE por SQL sin motivo lo rechaza la base", async () => {
    const t = await tanque(admin, { grifo_interno_id: principal });
    await expect(
      withTenant(tenantId, (c) =>
        c.query(`UPDATE combustible SET grifo_interno_id = $1 WHERE id = $2`, [norte, t.body.id])
      )
    ).rejects.toThrow(/motivo/);
  });
});

describe("bajas y reactivaciones", () => {
  it("no se da de baja nada con cosas activas adentro", async () => {
    const { admin } = await empresa();
    const principal = await grifoPrincipal(admin);
    const sede = (await sedes(admin))[0].id;
    const sur = await nuevoGrifo(admin, sede, "Sur");
    const t = await tanque(admin, { grifo_interno_id: sur });

    const conTanque = await admin
      .patch(`/api/erp/administracion/grifos/${sur}/baja`)
      .send({ motivo: "Se cierra" });
    expect(conTanque.status).toBe(409);

    await moverTanque(admin, t.body.id, { grifo_interno_id: principal, motivo: "Cierre del sur" });
    expect(
      (
        await admin
          .patch(`/api/erp/administracion/grifos/${sur}/baja`)
          .send({ motivo: "Se cierra" })
      ).status
    ).toBe(200);

    // La sede todavía tiene Principal activo.
    expect(
      (await admin.patch(`/api/erp/administracion/sedes/${sede}/baja`).send({ motivo: "x" })).status
    ).toBe(409);

    // Reactivar: con motivo, y el grifo solo si su sede está activa.
    expect(
      (
        await admin
          .patch(`/api/erp/administracion/grifos/${sur}/reactivar`)
          .send({ motivo: "Reabre" })
      ).status
    ).toBe(200);
  });

  it("un grifo no se reactiva si su sede está dada de baja", async () => {
    const { admin } = await empresa();
    const nueva = await admin.post("/api/erp/administracion/sedes").send({ nombre: "Temporal" });
    const g = await nuevoGrifo(admin, nueva.body.id);
    await admin.patch(`/api/erp/administracion/grifos/${g}/baja`).send({ motivo: "x" });
    expect(
      (
        await admin
          .patch(`/api/erp/administracion/sedes/${nueva.body.id}/baja`)
          .send({ motivo: "x" })
      ).status
    ).toBe(200);
    expect(
      (await admin.patch(`/api/erp/administracion/grifos/${g}/reactivar`).send({ motivo: "x" }))
        .status
    ).toBe(409);
  });
});

describe("alertas", () => {
  it("la alerta copia el grifo donde ocurrió, también después de mover", async () => {
    const { admin, tenantId } = await empresa();
    const principal = await grifoPrincipal(admin);
    const norte = await nuevoGrifo(admin, (await sedes(admin))[0].id);
    const t = await tanque(admin, { grifo_interno_id: principal, nivel_minimo: 5000 });
    // Nivel bajo en Principal.
    await admin
      .post("/api/erp/combustible/lecturas")
      .send({ combustible_id: t.body.id, nivel: 1000 });
    await moverTanque(admin, t.body.id, { grifo_interno_id: norte, motivo: "Mudanza" });

    const alertas = await withTenant(tenantId, (c) =>
      c.query<{ tipo: string; grifo_interno_id: number }>(
        `SELECT tipo, grifo_interno_id FROM combustible_alertas WHERE combustible_id = $1`,
        [t.body.id]
      )
    );
    const nivelBajo = alertas.rows.find((a) => a.tipo === "nivel_bajo");
    expect(nivelBajo?.grifo_interno_id).toBe(principal);
  });
});

describe("backup", () => {
  async function backupDe(tenantId: string) {
    const r = await request(app)
      .post(`/api/platform/tenants/${tenantId}/backups`)
      .set("Authorization", BEARER);
    expect(r.status).toBe(201);
    return r.body.backup.id as string;
  }

  const restaurarEn = (backupId: string, targetTenantId: string) =>
    request(app)
      .post(`/api/platform/backups/${backupId}/restaurar`)
      .set("Authorization", BEARER)
      .send({ targetTenantId, confirmar: true });

  it("clonar a otra empresa remapea el grifo: nada queda apuntando al origen", async () => {
    const origen = await empresa();
    const norte = await nuevoGrifo(origen.admin, (await sedes(origen.admin))[0].id, "Norte");
    await tanque(origen.admin, { grifo_interno_id: norte });
    const backupId = await backupDe(origen.tenantId);

    const destino = await empresa();
    expect((await restaurarEn(backupId, destino.tenantId)).status).toBe(200);

    const r = await withTenant(destino.tenantId, (c) =>
      c.query<{ grifo: string }>(
        `SELECT g.nombre AS grifo FROM combustible t
           JOIN grifos_internos g ON g.id = t.grifo_interno_id AND g.tenant_id = t.tenant_id
          WHERE t.tenant_id = $1`,
        [destino.tenantId]
      )
    );
    expect(r.rows.map((f) => f.grifo)).toEqual(["Norte"]);
  });

  it("un backup anterior a las sedes se restaura y crea su Principal", async () => {
    const origen = await empresa();
    await tanque(origen.admin);
    await equipo(origen.admin);
    const backupId = await backupDe(origen.tenantId);

    // Degradarlo a como lo habría escrito el código anterior a 0097.
    const fila = (
      await pool.query(`SELECT storage, storage_key FROM tenant_backups WHERE id = $1`, [backupId])
    ).rows[0];
    const contenido = JSON.parse(
      await leerBackup({ storage: fila.storage, key: fila.storage_key })
    );
    delete contenido.tablas.sedes;
    delete contenido.tablas.grifos_internos;
    delete contenido.tablas.movimientos_grifo;
    // Tampoco existían los surtidores (0098), que cuelgan de los grifos.
    delete contenido.tablas.surtidores;
    delete contenido.tablas.surtidor_tanques;
    delete contenido.tablas.combustible_lectura_totalizadores;
    for (const filas of Object.values(contenido.tablas) as Record<string, unknown>[][]) {
      for (const f of filas) {
        delete f.grifo_interno_id;
        delete f.equipo_grifo_interno_id;
        delete f.surtidor_id;
      }
    }
    await guardarBackup(fila.storage_key, JSON.stringify(contenido));

    const destino = await empresa();
    expect((await restaurarEn(backupId, destino.tenantId)).status).toBe(200);

    const lista = await sedes(destino.admin);
    expect(lista).toHaveLength(1);
    expect(lista[0].grifos).toHaveLength(1);
    const principal = lista[0].grifos[0].id;
    const r = await withTenant(destino.tenantId, (c) =>
      c.query<{ t: number; e: number }>(
        `SELECT (SELECT grifo_interno_id FROM combustible LIMIT 1) AS t,
                (SELECT grifo_interno_id FROM equipos LIMIT 1) AS e`
      )
    );
    expect(r.rows[0]).toEqual({ t: principal, e: principal });
  });
});
