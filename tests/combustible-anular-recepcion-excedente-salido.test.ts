/** tests/combustible-anular-recepcion-excedente-salido.test.ts
 *
 * Anular una recepción cuyo excedente ya salió de la tanqueta (por un retorno al
 * pozo o a otra tanqueta) dejaba la tanqueta en negativo y combustible en el
 * pozo sin compra que lo respaldara (auditoría de #316-#321, hallazgo 1). Ahora
 * se rechaza con 409 y no se toca nada. Si el excedente sigue en la tanqueta, la
 * anulación funciona como siempre.
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
import { closeDatabase } from "../src/server/config/database";

describe("combustible: anular una recepción con el excedente ya fuera de la tanqueta", () => {
  const password = "ClaveDePrueba123";
  const admin = request.agent(app);
  let tenantId: string;
  let principal: number;
  let proveedor: number;
  let nVale = 1;

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });
    principal = (await admin.get("/api/erp/sedes")).body.sedes[0].grifos[0].id;
    proveedor = (
      await admin
        .post("/api/erp/combustible/grifos")
        .send({ nombre: idUnico("Prov"), abastece_tanque: true })
    ).body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  async function tanque(nivel: number, capacidad: number, flexible = false) {
    const r = await admin.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque de prueba",
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_punto: "fijo",
      capacidad_total: capacidad,
      nivel_actual: nivel,
      nivel_minimo: 100,
      requiere_documento: false,
      modo_vigilancia: "sin_vigilar",
      ...(flexible ? { modo_excedente_recepcion: "flexible" } : {}),
      grifo_interno_id: principal,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const id = r.body.id as number;
    const base = await admin.post("/api/erp/combustible/lecturas").send({
      combustible_id: id,
      nivel,
      leido_en: new Date(Date.now() - 50 * 24 * 3600 * 1000).toISOString(),
    });
    expect(base.status, JSON.stringify(base.body)).toBe(201);
    return id;
  }

  const nuevaTanqueta = async () =>
    Number(
      (await admin.post("/api/erp/combustible/tanquetas").send({ grifo_interno_id: principal }))
        .body.id
    );

  /** Una recepción de 100 gal a un tanque lleno: todo el excedente va a una tanqueta con unidad. */
  async function recepcionConExcedente() {
    const lleno = await tanque(2000, 2000, true);
    const tanqueta = await nuevaTanqueta();
    const unidad = (
      await admin.post("/api/erp/equipos").send({
        placa_codigo: idUnico("VQ"),
        tipo: "VOLQUETE",
        tipo_medidor: "horometro",
        grifo_interno_id: principal,
      })
    ).body.id;
    const rec = await admin.post("/api/erp/combustible/recepciones").send({
      combustible_id: lleno,
      grifo_id: proveedor,
      cantidad: 100,
      costo_unitario: 17,
      recibido_en: new Date().toISOString(),
      reparto_excedente: [
        {
          destino: "cubeta",
          cantidad: 100,
          tanqueta_id: tanqueta,
          tanqueta_equipo_id: unidad,
          serie_talonario: "EXC",
          n_vale: nVale++,
        },
      ],
    });
    expect(rec.status, JSON.stringify(rec.body)).toBe(201);
    return { recepcionId: rec.body.id as number, tanqueta };
  }

  const saldoDe = async (id: number) => {
    const lista: { id: string; saldo: string }[] = (
      await admin.get("/api/erp/combustible/tanquetas")
    ).body;
    return Number(lista.find((t) => String(t.id) === String(id))!.saldo);
  };

  const nivelTeorico = async (tanqueId: number) => {
    const r = await admin.get("/api/erp/combustible");
    const lista: { id: number; nivel_teorico: string | null }[] = r.body.data ?? r.body;
    return Number(lista.find((t) => t.id === tanqueId)!.nivel_teorico);
  };

  const anular = (recepcionId: number) =>
    admin
      .patch(`/api/erp/combustible/recepciones/${recepcionId}/anular`)
      .send({ motivo: "error de digitación" });

  it("si el excedente volvió al pozo, no se anula: la tanqueta no queda en negativo", async () => {
    const { recepcionId, tanqueta } = await recepcionConExcedente();
    const pozo = await tanque(1000, 10000);
    const r = await recibirTanqueta(admin, tanqueta, { destino: "pozo", tanqueId: pozo });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await nivelTeorico(pozo)).toBe(1100);

    const an = await anular(recepcionId);
    expect(an.status, JSON.stringify(an.body)).toBe(409);
    expect(an.body.error).toContain("ya salió de la tanqueta");
    expect(await saldoDe(tanqueta)).toBe(0);
    expect(await nivelTeorico(pozo)).toBe(1100);
    // Sigue vigente: intentarlo otra vez da el mismo rechazo, no "ya anulada".
    const otra = await anular(recepcionId);
    expect(otra.status).toBe(409);
    expect(otra.body.error).toContain("ya salió de la tanqueta");
  });

  it("si el excedente pasó a otra tanqueta, tampoco se anula", async () => {
    const { recepcionId, tanqueta } = await recepcionConExcedente();
    const destino = await nuevaTanqueta();
    const r = await recibirTanqueta(admin, tanqueta, {
      destino: "tanqueta",
      tanquetaDestinoId: destino,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const an = await anular(recepcionId);
    expect(an.status, JSON.stringify(an.body)).toBe(409);
    expect(await saldoDe(tanqueta)).toBe(0);
    expect(await saldoDe(destino)).toBe(100);
  });

  it("si el excedente sigue en la tanqueta, se anula como siempre", async () => {
    const { recepcionId, tanqueta } = await recepcionConExcedente();
    expect(await saldoDe(tanqueta)).toBe(100);
    const an = await anular(recepcionId);
    expect(an.status, JSON.stringify(an.body)).toBe(200);
    expect(await saldoDe(tanqueta)).toBe(0);
    // Ya anulada: se dice eso, no que el excedente salió.
    const otra = await anular(recepcionId);
    expect(otra.status).toBe(409);
    expect(otra.body.error).toContain("ya estaba anulada");
  });
});
