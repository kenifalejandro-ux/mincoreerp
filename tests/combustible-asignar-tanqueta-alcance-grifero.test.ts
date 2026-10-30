/** tests/combustible-asignar-tanqueta-alcance-grifero.test.ts
 *
 * El grifero asigna tanquetas a unidades (permiso propio `tanquetas:asignar`,
 * que no le da editar ni dar de baja), pero solo a unidades de su sede. Antes
 * `PUT /asignar` era de admin y operador, y el retorno "a otra unidad" le dejaba
 * asignar a cualquiera, de cualquier sede (auditoría de #316-#321, hallazgo 2).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  app,
  crearTenantDePrueba,
  borrarTenantDePrueba,
  idUnico,
  recibirTanqueta,
} from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";

describe("combustible: el grifero asigna tanquetas, solo a unidades de su sede", () => {
  const password = "ClaveDePrueba123";
  const admin = request.agent(app);
  let tenantId: string;
  let slug: string;
  let principal: number;
  let otroGrifo: number;
  let fuenteId: number;
  let nVale = 1;
  let nAsig = 1;
  let grifero: Awaited<ReturnType<typeof persona>>;

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    slug = creado.tenant.slug;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: slug, email: creado.usuario.email, password });
    const sedes = (await admin.get("/api/erp/sedes")).body.sedes;
    principal = sedes[0].grifos[0].id;
    otroGrifo = (
      await admin
        .post("/api/erp/administracion/grifos")
        .send({ sede_id: sedes[0].id, nombre: idUnico("Grifo") })
    ).body.id;
    const f = await admin.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Fuente de prueba",
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_punto: "fijo",
      capacidad_total: 50000,
      nivel_actual: 40000,
      nivel_minimo: 100,
      requiere_documento: false,
      modo_vigilancia: "sin_vigilar",
      grifo_interno_id: principal,
    });
    expect(f.status, JSON.stringify(f.body)).toBe(201);
    fuenteId = f.body.id;
    // Un grifero con alcance SOLO al grifo principal.
    grifero = await persona("grifero");
    const r = await admin.put(`/api/erp/usuarios/${grifero.id}/permisos`).send({
      modulos: [],
      alcanceCombustible: { todo: false, sedes: [], grifos: [principal], surtidores: [] },
      motivo: "Alcance al grifo principal (prueba)",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    await grifero.entrar();
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  async function persona(rol: string) {
    const agente = request.agent(app);
    const dni = String(
      88400000 + Math.floor(Math.random() * 500000) + Math.floor(Math.random() * 1e4)
    );
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre: `P ${rol}`, dni, password, rol });
    expect(alta.status, JSON.stringify(alta.body)).toBe(201);
    const entrar = () =>
      agente.post("/api/auth/login").send({ tenantSlug: slug, identificador: dni, password });
    expect((await entrar()).status).toBe(200);
    return { agente, id: alta.body.id as string, entrar };
  }

  const unidad = async (grifo: number) =>
    Number(
      (
        await admin.post("/api/erp/equipos").send({
          placa_codigo: idUnico("VQ"),
          tipo: "VOLQUETE",
          tipo_medidor: "horometro",
          grifo_interno_id: grifo,
        })
      ).body.id
    );

  /** Una tanqueta de la sede principal con 100 gal, ya asignada a una unidad (la asigna el admin). */
  async function tanquetaAsignada() {
    const id = Number(
      (await admin.post("/api/erp/combustible/tanquetas").send({ grifo_interno_id: principal }))
        .body.id
    );
    const v = await admin.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: fuenteId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "reserva_cubeta",
      tanqueta_destino_id: id,
      serie_talonario: "ALC",
      n_vale: nVale++,
      cantidad: 100,
      lectura_contometro: 100,
      costo_unitario: 16,
    });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    const origen = await unidad(principal);
    const a = await admin
      .put(`/api/erp/combustible/tanquetas/${id}/asignar`)
      .send({ equipo_id: origen, serie_talonario: "ALA", n_vale: nAsig++ });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    return { id, origen };
  }

  const estado = async (id: number) => {
    const lista: { id: string; saldo: string; equipo_asignado_id: number | null }[] = (
      await admin.get("/api/erp/combustible/tanquetas")
    ).body;
    const t = lista.find((x) => String(x.id) === String(id))!;
    return { saldo: Number(t.saldo), unidad: t.equipo_asignado_id && Number(t.equipo_asignado_id) };
  };

  const nRetornos = (tanqueta: number) =>
    withTenant(tenantId, async (client) => {
      const r = await client.query(
        `SELECT count(*)::int AS n FROM combustible_tanqueta_retornos
          WHERE tenant_id = $1 AND tanqueta_id = $2`,
        [tenantId, tanqueta]
      );
      return r.rows[0].n as number;
    });

  const asignar = (
    como: { agente: ReturnType<typeof request.agent> },
    tanqueta: number,
    eq: number
  ) =>
    como.agente
      .put(`/api/erp/combustible/tanquetas/${tanqueta}/asignar`)
      .send({ equipo_id: eq, serie_talonario: "GRF", n_vale: 9000 + nAsig++ });

  it("el grifero asigna una tanqueta de su sede a una unidad de su sede", async () => {
    const t = await tanquetaAsignada();
    const destino = await unidad(principal);
    // La tanqueta va con otra unidad: primero se recibe de vuelta y queda libre.
    expect((await recibirTanqueta(admin, t.id)).status).toBe(201);
    const r = await asignar(grifero, t.id, destino);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await estado(t.id)).unidad).toBe(destino);
  });

  it("el grifero no asigna a una unidad de otra sede: 403 y la tanqueta no cambia", async () => {
    const t = await tanquetaAsignada();
    expect((await recibirTanqueta(admin, t.id)).status).toBe(201);
    const ajena = await unidad(otroGrifo);
    const r = await asignar(grifero, t.id, ajena);
    expect(r.status).toBe(403);
    expect(r.body.message).toContain("no es de tu sede");
    expect((await estado(t.id)).unidad).toBeFalsy();
  });

  it("el retorno 'a otra unidad' tampoco: una unidad de otra sede da 403 y no queda retorno a medias", async () => {
    const t = await tanquetaAsignada();
    const ajena = await unidad(otroGrifo);
    const r = await recibirTanqueta(admin, t.id, {
      como: grifero.agente,
      destino: "unidad",
      unidad: { equipo_id: ajena, serie_talonario: "GRF", n_vale: 9000 + nAsig++ },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(await nRetornos(t.id)).toBe(0);
    expect((await estado(t.id)).unidad).toBe(t.origen);
  });

  it("el retorno 'a otra unidad' del grifero sí funciona con una unidad de su sede", async () => {
    const t = await tanquetaAsignada();
    const propia = await unidad(principal);
    const r = await recibirTanqueta(admin, t.id, {
      como: grifero.agente,
      destino: "unidad",
      unidad: { equipo_id: propia, serie_talonario: "GRF", n_vale: 9000 + nAsig++ },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await estado(t.id)).unidad).toBe(propia);
  });

  it("el admin, que ve todas las sedes, asigna a una unidad de otro grifo", async () => {
    const t = await tanquetaAsignada();
    expect((await recibirTanqueta(admin, t.id)).status).toBe(201);
    const ajena = await unidad(otroGrifo);
    const r = await asignar({ agente: admin }, t.id, ajena);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });

  it("el conductor y Lectura siguen sin poder asignar", async () => {
    const t = await tanquetaAsignada();
    expect((await recibirTanqueta(admin, t.id)).status).toBe(201);
    const destino = await unidad(principal);
    for (const rol of ["conductor_ruta", "lectura"]) {
      const p = await persona(rol);
      const r = await asignar(p, t.id, destino);
      expect(r.status, rol).toBe(403);
    }
  });
});
