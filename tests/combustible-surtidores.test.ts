/** tests/combustible-surtidores.test.ts
 *
 * Surtidores (migración 0098, entrega 2 de
 * docs/architecture/combustible-sedes-grifos-surtidores.md): el totalizador
 * pasa del tanque al surtidor, y un tanque puede tener varios.
 *
 * Método de siempre: atacar la API, y cada ataque con su GEMELO de control.
 * Los tests de #180 y #183 (combustible-totalizador*.test.ts) quedan como
 * estaban: son la prueba de que el caso simple no cambió.
 */
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { env } from "../src/server/config/env";
import { closeDatabase, pool, withTenant } from "../src/server/config/database";
import { guardarBackup, leerBackup } from "../src/server/services/platformBackupStorage";

const BEARER = `Bearer ${env.platformAdminToken}`;
const password = "ClaveDePrueba123";
const hace = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString();
/** Minutos desde ahora: los vales de un surtidor recién conectado tienen que
 *  ser POSTERIORES a la conexión (la conexión tiene historia). */
const en = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
let seq = 0;
const serieUnica = () => `U${Date.now().toString(36).slice(-5)}${(seq++).toString(36)}`;

type Agente = ReturnType<typeof request.agent>;

interface SurtidorDelTanque {
  id: number;
  nombre: string;
  usa_totalizador: boolean;
  compartido: boolean;
}

interface Alerta {
  tipo: string;
  combustible_id: number | null;
  detalle: Record<string, unknown>;
}

const tenantsCreados: string[] = [];

async function empresa() {
  const creado = await crearTenantDePrueba(password);
  tenantsCreados.push(creado.tenant.id);
  const admin = request.agent(app);
  await admin
    .post("/api/auth/login")
    .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });
  const equipo = await admin
    .post("/api/erp/equipos")
    .send({ placa_codigo: idUnico("EQ"), tipo: "Volquete" });
  const grifo = (await admin.get("/api/erp/sedes")).body.sedes[0].grifos[0].id as number;
  return {
    tenantId: creado.tenant.id,
    slug: creado.tenant.slug,
    admin,
    equipoId: equipo.body.id as number,
    grifo,
  };
}

async function tanque(ag: Agente, extra: Record<string, unknown> = {}) {
  const r = await ag.post("/api/erp/combustible").send({
    codigo: idUnico("TQ"),
    tanque_nombre: "Tanque con surtidores",
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
  expect(r.status).toBe(201);
  return r.body as { id: number; codigo: string; surtidores: SurtidorDelTanque[] };
}

async function surtidor(ag: Agente, grifo: number, usa = true) {
  const r = await ag.post("/api/erp/combustible/surtidores").send({
    grifo_interno_id: grifo,
    nombre: idUnico("S"),
    usa_totalizador: usa,
  });
  expect(r.status).toBe(201);
  return r.body.id as number;
}

const conectar = (ag: Agente, surtidorId: number, combustibleId: number) =>
  ag
    .post(`/api/erp/combustible/surtidores/${surtidorId}/conexiones`)
    .send({ combustible_id: combustibleId, motivo: "Instalación" });

const surtidoresDe = async (ag: Agente, tq: number) =>
  (await ag.get(`/api/erp/combustible/${tq}`)).body.surtidores as SurtidorDelTanque[];

function vale(
  ag: Agente,
  equipoId: number,
  tq: number,
  cantidad: number,
  cuando: string,
  extra: Record<string, unknown> = {}
) {
  return ag.post("/api/erp/combustible/despachos").send({
    origen: "tanque_propio",
    combustible_id: tq,
    tipo_combustible: "diesel_b5",
    tipo_destino: "equipo",
    equipo_id: equipoId,
    serie_talonario: serieUnica(),
    n_vale: 1,
    cantidad,
    lectura_contometro: cantidad,
    costo_unitario: 16,
    despachado_en: cuando,
    ...extra,
  });
}

async function alertasDe(ag: Agente, tq: number, tipo: string) {
  const r = await ag.get("/api/erp/combustible/alertas").query({ pageSize: 500 });
  return (r.body.data as Alerta[]).filter((a) => a.tipo === tipo && a.combustible_id === tq);
}

afterAll(async () => {
  for (const id of tenantsCreados) await borrarTenantDePrueba(id);
  await closeDatabase();
});

describe("surtidores: el caso simple no cambia", () => {
  it("todo tanque nace con su surtidor, con la casilla del formulario", async () => {
    const { admin } = await empresa();
    const t = await tanque(admin, { usa_totalizador: true, totalizador_tolerancia: 2 });
    expect(t.surtidores).toHaveLength(1);
    expect(t.surtidores[0]).toMatchObject({
      nombre: `Surtidor ${t.codigo}`,
      usa_totalizador: true,
    });
  });

  it("un vale sin surtidor toma el único del tanque", async () => {
    const { admin, equipoId, tenantId } = await empresa();
    const t = await tanque(admin);
    const r = await vale(admin, equipoId, t.id, 100, hace(1));
    expect(r.status).toBe(201);
    expect(r.body.surtidor_id).toBe(t.surtidores[0].id);

    // Un tanque insertado por SQL (tests viejos, scripts) nunca tuvo surtidor:
    // la base le crea el suyo al primer vale.
    const sql = await withTenant(tenantId, (c) =>
      c.query<{ id: number }>(
        `INSERT INTO combustible (tenant_id, codigo, tanque_nombre, tipo_combustible, unidad,
           tipo_punto, capacidad_total)
         VALUES ($1, $2, 'SQL', 'diesel_b5', 'L', 'fijo', 5000) RETURNING id`,
        [tenantId, idUnico("TQ")]
      )
    );
    const r2 = await vale(admin, equipoId, sql.rows[0].id, 100, hace(1));
    expect(r2.status).toBe(201);
    expect(r2.body.surtidor_id).not.toBeNull();
  });
});

describe("dos surtidores en un tanque", () => {
  it("cada cadena es independiente: vales alternados no dan saltos falsos", async () => {
    const { admin, equipoId, grifo } = await empresa();
    const t = await tanque(admin, { usa_totalizador: true });
    const s1 = t.surtidores[0].id;
    const s2 = await surtidor(admin, grifo);
    expect((await conectar(admin, s2, t.id)).status).toBe(201);

    // S1 cuenta desde 1000, S2 desde 50000: si fueran una sola cadena, cada
    // vale de un surtidor parecería un salto enorme del otro.
    const pasos: [number, number, number][] = [
      [s1, 100, 1000],
      [s2, 200, 50000],
      [s1, 100, 1100],
      [s2, 200, 50200],
      [s1, 100, 1200],
    ];
    let m = 1;
    for (const [s, cantidad, totalizador] of pasos) {
      const r = await vale(admin, equipoId, t.id, cantidad, en(m++), {
        surtidor_id: s,
        totalizador_lectura: totalizador,
      });
      expect(r.status).toBe(201);
    }
    expect(await alertasDe(admin, t.id, "totalizador_salto")).toHaveLength(0);
    expect(await alertasDe(admin, t.id, "totalizador_retroceso")).toHaveLength(0);

    // Ataque en S2: 50200 -> 50500 con un vale de 200: 100 sin vale.
    await vale(admin, equipoId, t.id, 200, en(10), {
      surtidor_id: s2,
      totalizador_lectura: 50500,
    });
    const [salto] = await alertasDe(admin, t.id, "totalizador_salto");
    expect(salto.detalle).toMatchObject({ surtidorId: s2, diferencia: 100 });
  });

  it("el vale sin surtidor se rechaza; la varilla exige los dos totalizadores", async () => {
    const { admin, equipoId, grifo } = await empresa();
    const t = await tanque(admin, { usa_totalizador: true });
    const s2 = await surtidor(admin, grifo);
    await conectar(admin, s2, t.id);

    const sin = await vale(admin, equipoId, t.id, 100, en(1), { totalizador_lectura: 1 });
    expect(sin.status).toBe(400);
    expect(sin.body.error).toMatch(/más de un surtidor/);

    const varilla = (cuerpo: Record<string, unknown>) =>
      admin
        .post("/api/erp/combustible/lecturas")
        .send({ combustible_id: t.id, nivel: 9000, ...cuerpo });
    const falta = await varilla({ totalizadores: [{ surtidor_id: s2, valor: 10 }] });
    expect(falta.status).toBe(400);
    expect(falta.body.error).toMatch(/usa totalizador/);
    // El campo viejo (un solo número) no dice de qué surtidor es.
    expect((await varilla({ totalizador_lectura: 10 })).status).toBe(400);
    const bien = await varilla({
      totalizadores: [
        { surtidor_id: t.surtidores[0].id, valor: 10 },
        { surtidor_id: s2, valor: 20 },
      ],
    });
    expect(bien.status).toBe(201);
  });
});

describe("un surtidor sobre dos tanques", () => {
  it("vale de cada tanque por el mismo surtidor, y el desglose del descuadre se omite", async () => {
    const { admin, equipoId, grifo } = await empresa();
    const vigilado = {
      modo_vigilancia: "personalizado",
      umbral_diferencia_pct: 1,
      umbral_descuadre_pct: 1,
      umbral_descuadre_ciclo_pct: 1,
      umbral_descuadre_ventana_pct: 2,
    };
    const t1 = await tanque(admin, vigilado);
    const t2 = await tanque(admin, vigilado);
    // Un surtidor con totalizador conectado a los dos. Se desconectan los
    // propios para que el compartido sea el único de cada uno.
    const s = await surtidor(admin, grifo);
    for (const t of [t1, t2]) {
      const propio = t.surtidores[0].id;
      const con = (await admin.get(`/api/erp/combustible/surtidores/${propio}/conexiones`)).body;
      await admin
        .patch(`/api/erp/combustible/surtidores/${propio}/conexiones/${con[0].id}/desconectar`)
        .send({ motivo: "Reemplazado por el surtidor común" });
      expect((await conectar(admin, s, t.id)).status).toBe(201);
    }
    expect((await surtidoresDe(admin, t1.id))[0]).toMatchObject({ id: s, compartido: true });

    const lectura = (tq: number, nivel: number, valor: number) =>
      admin.post("/api/erp/combustible/lecturas").send({
        combustible_id: tq,
        nivel,
        totalizadores: [{ surtidor_id: s, valor }],
      });
    expect((await lectura(t1.id, 10000, 1000)).status).toBe(201);
    expect(
      (
        await vale(admin, equipoId, t1.id, 300, new Date().toISOString(), {
          totalizador_lectura: 1300,
        })
      ).status
    ).toBe(201);
    expect(
      (
        await vale(admin, equipoId, t2.id, 200, new Date().toISOString(), {
          totalizador_lectura: 1500,
        })
      ).status
    ).toBe(201);
    // T1 bajó 900 con vales por 300: descuadre, pero sin desglose (el avance
    // del surtidor incluye lo que salió de T2).
    expect((await lectura(t1.id, 9100, 1500)).status).toBe(201);
    const [d] = await alertasDe(admin, t1.id, "descuadre_inventario");
    expect(d).toBeDefined();
    expect(d.detalle.desglose).toBeUndefined();
  });
});

describe("grifos: el surtidor va con sus tanques", () => {
  it("no se conecta un tanque de otro grifo", async () => {
    const { admin } = await empresa();
    const sede = (await admin.get("/api/erp/sedes")).body.sedes[0].id;
    const otro = (
      await admin.post("/api/erp/administracion/grifos").send({ sede_id: sede, nombre: "Otro" })
    ).body.id;
    const t = await tanque(admin, { grifo_interno_id: otro });
    const s = await surtidor(
      admin,
      (await admin.get("/api/erp/sedes")).body.sedes[0].grifos.find(
        (g: { nombre: string }) => g.nombre === "Principal"
      ).id
    );
    const r = await conectar(admin, s, t.id);
    expect(r.status).toBe(400);
    expect(r.body.message ?? r.body.error).toMatch(/grifos internos distintos/);
  });

  it("mover el tanque arrastra su surtidor; con uno compartido se rechaza", async () => {
    const { admin, grifo, tenantId } = await empresa();
    const sede = (await admin.get("/api/erp/sedes")).body.sedes[0].id;
    const norte = (
      await admin.post("/api/erp/administracion/grifos").send({ sede_id: sede, nombre: "Norte" })
    ).body.id;
    const t = await tanque(admin, { grifo_interno_id: grifo });
    const propio = t.surtidores[0].id;

    const mov = await admin
      .post(`/api/erp/combustible/${t.id}/mover-grifo`)
      .send({ grifo_interno_id: norte, motivo: "Mudanza a la planta norte" });
    expect(mov.status).toBe(200);
    const grifoDelSurtidor = await withTenant(tenantId, (c) =>
      c.query<{ grifo_interno_id: number }>(
        `SELECT grifo_interno_id FROM surtidores WHERE id = $1`,
        [propio]
      )
    );
    expect(grifoDelSurtidor.rows[0].grifo_interno_id).toBe(norte);

    // Compartido: un segundo tanque en Norte conectado al mismo surtidor.
    const t2 = await tanque(admin, { grifo_interno_id: norte });
    await conectar(admin, propio, t2.id);
    const rechazo = await admin
      .post(`/api/erp/combustible/${t.id}/mover-grifo`)
      .send({ grifo_interno_id: grifo, motivo: "Vuelve" });
    expect(rechazo.status).toBe(400);
    expect(rechazo.body.message ?? rechazo.body.error).toMatch(/también alimenta/);
  });
});

describe("la conexión tiene historia", () => {
  it("un vale sin red fechado antes de reconectar usa el surtidor de su fecha", async () => {
    const { admin, equipoId, grifo } = await empresa();
    const t = await tanque(admin);
    const viejo = t.surtidores[0].id;
    const con = (await admin.get(`/api/erp/combustible/surtidores/${viejo}/conexiones`)).body;
    await admin
      .patch(`/api/erp/combustible/surtidores/${viejo}/conexiones/${con[0].id}/desconectar`)
      .send({ motivo: "Se cambió el surtidor" });
    const nuevo = await surtidor(admin, grifo, false);
    await conectar(admin, nuevo, t.id);

    const tardio = await vale(admin, equipoId, t.id, 100, hace(2));
    expect(tardio.status).toBe(201);
    expect(tardio.body.surtidor_id).toBe(viejo);
    const hoy = await vale(admin, equipoId, t.id, 100, new Date(Date.now() + 60_000).toISOString());
    expect(hoy.body.surtidor_id).toBe(nuevo);
  });

  it("dar de baja el único surtidor deja al tanque sin poder despachar", async () => {
    const { admin, equipoId } = await empresa();
    const t = await tanque(admin);
    const s = t.surtidores[0].id;
    expect(
      (await admin.patch(`/api/erp/combustible/surtidores/${s}/baja`).send({ motivo: "Se retiró" }))
        .status
    ).toBe(200);
    const r = await vale(admin, equipoId, t.id, 100, new Date(Date.now() + 60_000).toISOString());
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/ningún surtidor conectado/);
  });
});

describe("aflojar y permisos", () => {
  it("apagar el totalizador de un surtidor pide motivo y queda como vigilancia reducida", async () => {
    const { admin, slug, grifo } = await empresa();
    const s = await surtidor(admin, grifo);
    const sinMotivo = await admin
      .put(`/api/erp/combustible/surtidores/${s}`)
      .send({ usa_totalizador: false });
    expect(sinMotivo.status).toBe(400);
    const conMotivo = await admin
      .put(`/api/erp/combustible/surtidores/${s}`)
      .send({ usa_totalizador: false, motivo: "El contador se rompió" });
    expect(conMotivo.status).toBe(200);
    const eventos = await admin
      .get("/api/erp/administracion/eventos")
      .query({ accion: "combustible.tanque_vigilancia_reducida" });
    expect(JSON.stringify(eventos.body)).toContain("El contador se rompió");

    // Solo el admin toca surtidores.
    const operador = request.agent(app);
    const dni = String(87100000 + Math.floor(Math.random() * 800000));
    await admin.post("/api/erp/usuarios").send({ nombre: "Op", dni, password, rol: "operador" });
    await operador.post("/api/auth/login").send({ tenantSlug: slug, identificador: dni, password });
    expect(
      (
        await operador
          .post("/api/erp/combustible/surtidores")
          .send({ grifo_interno_id: grifo, nombre: "X" })
      ).status
    ).toBe(403);
  });
});

describe("backup", () => {
  it("clonar a otra empresa remapea surtidores, conexiones y lo que leyó la varilla", async () => {
    const origen = await empresa();
    const t = await tanque(origen.admin, { usa_totalizador: true });
    const lect = await origen.admin
      .post("/api/erp/combustible/lecturas")
      .send({ combustible_id: t.id, nivel: 9000, totalizador_lectura: 4321 });
    expect(lect.status).toBe(201);

    const backup = await request(app)
      .post(`/api/platform/tenants/${origen.tenantId}/backups`)
      .set("Authorization", BEARER);
    expect(backup.status).toBe(201);
    const destino = await empresa();
    const restaurar = await request(app)
      .post(`/api/platform/backups/${backup.body.backup.id}/restaurar`)
      .set("Authorization", BEARER)
      .send({ targetTenantId: destino.tenantId, confirmar: true });
    expect(restaurar.status).toBe(200);

    const r = await withTenant(destino.tenantId, (c) =>
      c.query<{ valor: string; surtidor_tenant: string; conexiones: number }>(
        `SELECT lt.valor, s.tenant_id AS surtidor_tenant,
                (SELECT count(*)::int FROM surtidor_tanques) AS conexiones
           FROM combustible_lectura_totalizadores lt
           JOIN surtidores s ON s.id = lt.surtidor_id`
      )
    );
    expect(r.rows).toHaveLength(1);
    expect(Number(r.rows[0].valor)).toBe(4321);
    expect(r.rows[0].surtidor_tenant).toBe(destino.tenantId);
    expect(r.rows[0].conexiones).toBe(1);
  });

  it("un backup con las columnas viejas del totalizador (antes de 0099) se restaura igual", async () => {
    const origen = await empresa();
    const t = await tanque(origen.admin);
    await origen.admin
      .post("/api/erp/combustible/lecturas")
      .send({ combustible_id: t.id, nivel: 9000 });
    const backup = await request(app)
      .post(`/api/platform/tenants/${origen.tenantId}/backups`)
      .set("Authorization", BEARER);

    // Volverlo a como lo escribía el código anterior: con las columnas del
    // totalizador en el tanque y en la varilla, que 0099 borró.
    const fila = (
      await pool.query(`SELECT storage, storage_key FROM tenant_backups WHERE id = $1`, [
        backup.body.backup.id,
      ])
    ).rows[0];
    const contenido = JSON.parse(
      await leerBackup({ storage: fila.storage, key: fila.storage_key })
    );
    for (const f of contenido.tablas.combustible) {
      Object.assign(f, {
        usa_totalizador: true,
        totalizador_tolerancia: 2,
        totalizador_actual: 99,
      });
    }
    for (const f of contenido.tablas.combustible_lecturas) f.totalizador_lectura = 1234;
    await guardarBackup(fila.storage_key, JSON.stringify(contenido));

    const destino = await empresa();
    const r = await request(app)
      .post(`/api/platform/backups/${backup.body.backup.id}/restaurar`)
      .set("Authorization", BEARER)
      .send({ targetTenantId: destino.tenantId, confirmar: true });
    expect(r.status).toBe(200);
  });
});
