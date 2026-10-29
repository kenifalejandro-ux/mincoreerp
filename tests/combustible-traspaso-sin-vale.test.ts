/** tests/combustible-traspaso-sin-vale.test.ts
 *
 * Llenar una tanqueta desde el tanque SIN elegir unidad es un traspaso
 * interno y no lleva vale (migración 0161): el vale es de la entrega a la
 * unidad. Con unidad elegida todo sigue como antes y pide vale.
 *
 * Lo que fija este archivo:
 * 1. La excepción es ESTRECHA: solo "reserva en cubeta" + tanqueta + sin
 *    unidad. Cualquier otro despacho del tanque sigue exigiendo su vale.
 * 2. Serie y número van juntos o ninguno; un vale completo se sigue
 *    aceptando (un celular con la versión anterior lo manda así).
 * 3. La base lo impone aunque el schema no estuviera.
 * 4. El kardex y el historial lo nombran "Traspaso a tanqueta", sin un
 *    documento vacío.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";

const hace = (dias: number) => new Date(Date.now() - dias * 24 * 3600 * 1000).toISOString();

interface FilaKardex {
  tipo: string;
  referencia_id: string;
  documento: string | null;
  salida: number;
  anulada: boolean;
}

describe("combustible: llenar una tanqueta sin unidad no pide vale (0161)", () => {
  let tenantId: string;
  const password = "ClaveDePrueba123";
  const admin = request.agent(app);
  let principal: number;
  let tanqueId: number;
  let unidad: number;
  let nVale = 1;
  const serie = `TR${Date.now().toString(36).slice(-5)}`;

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await admin.post("/api/auth/login").send({
      tenantSlug: creado.tenant.slug,
      email: creado.usuario.email,
      password,
    });
    principal = (await admin.get("/api/erp/sedes")).body.sedes[0].grifos[0].id;
    unidad = (
      await admin.post("/api/erp/equipos").send({
        placa_codigo: idUnico("VQ"),
        tipo: "VOLQUETE",
        tipo_medidor: "horometro",
        grifo_interno_id: principal,
      })
    ).body.id;
    tanqueId = (
      await admin.post("/api/erp/combustible").send({
        codigo: idUnico("TQ"),
        tanque_nombre: "Tanque del traspaso",
        tipo_combustible: "diesel_b5",
        unidad: "gal",
        tipo_punto: "fijo",
        capacidad_total: 10000,
        nivel_actual: 8000,
        requiere_documento: false,
        grifo_interno_id: principal,
      })
    ).body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  const nuevaTanqueta = async () =>
    Number(
      (await admin.post("/api/erp/combustible/tanquetas").send({ grifo_interno_id: principal }))
        .body.id
    );

  /** Un vale del tanque a "reserva en cubeta" que llena `tanquetaId`, SIN
   *  vale ni unidad salvo que `extra` los ponga. */
  const traspasar = (tanquetaId: number, extra: Record<string, unknown> = {}) =>
    admin.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tanqueId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "reserva_cubeta",
      tanqueta_destino_id: tanquetaId,
      cantidad: 100,
      costo_unitario: 16,
      despachado_en: hace(5),
      ...extra,
      // El contómetro marca lo que salió: tiene que coincidir con la cantidad.
      lectura_contometro: extra.cantidad ?? 100,
    });

  const conVale = (extra: Record<string, unknown> = {}) => ({
    serie_talonario: serie,
    n_vale: nVale++,
    ...extra,
  });

  const kardex = () =>
    admin
      .get(`/api/erp/combustible/${tanqueId}/kardex`)
      .query({ desde: hace(45), hasta: hace(0.2) });

  const filaDeKardex = async (despachoId: number) =>
    ((await kardex()).body.filas as FilaKardex[]).find(
      (f) => f.referencia_id === String(despachoId) && f.tipo !== "lectura"
    );

  const ver = async (id: number) =>
    (await admin.get("/api/erp/combustible/tanquetas")).body.find(
      (t: { id: string }) => Number(t.id) === id
    );

  // ── 1. Lo que se acepta ───────────────────────────────────────────────

  it("sin unidad y sin vale: se acepta, llena la tanqueta y queda sin asignar", async () => {
    const t = await nuevaTanqueta();
    const r = await traspasar(t);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.serie_talonario).toBeNull();
    expect(r.body.n_vale).toBeNull();
    const fila = await ver(t);
    expect(Number(fila.saldo)).toBe(100);
    expect(fila.equipo_asignado_id).toBeNull();
  });

  it("un vale completo sin unidad también se acepta (cola de la versión anterior)", async () => {
    const t = await nuevaTanqueta();
    const body = conVale();
    const r = await traspasar(t, body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.serie_talonario).toBe(body.serie_talonario);
    expect(r.body.n_vale).toBe(body.n_vale);
    // Y ese número ya no se puede repetir.
    const repetido = await traspasar(await nuevaTanqueta(), {
      serie_talonario: body.serie_talonario,
      n_vale: body.n_vale,
    });
    expect(repetido.status, JSON.stringify(repetido.body)).toBe(409);
    expect(JSON.stringify(repetido.body)).toMatch(/ya está registrado/);
  });

  it("con unidad y con vale: como antes, llena y asigna", async () => {
    const t = await nuevaTanqueta();
    const r = await traspasar(t, conVale({ tanqueta_equipo_id: unidad }));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await ver(t)).equipo_asignado_id).toBe(unidad);
  });

  // ── 2. Lo que se rechaza ──────────────────────────────────────────────

  it("con unidad y SIN vale: 400, y la tanqueta no se llena", async () => {
    const t = await nuevaTanqueta();
    const r = await traspasar(t, { tanqueta_equipo_id: unidad });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain("serie_talonario");
    expect(JSON.stringify(r.body)).toContain("n_vale");
    expect(Number((await ver(t)).saldo)).toBe(0);
  });

  it("serie y número van juntos: solo uno de los dos es 400", async () => {
    const t = await nuevaTanqueta();
    const soloSerie = await traspasar(t, { serie_talonario: serie });
    expect(soloSerie.status).toBe(400);
    expect(JSON.stringify(soloSerie.body)).toContain("n_vale");
    const soloNumero = await traspasar(t, { n_vale: nVale++ });
    expect(soloNumero.status).toBe(400);
    expect(JSON.stringify(soloNumero.body)).toContain("serie_talonario");
    expect(Number((await ver(t)).saldo)).toBe(0);
  });

  it("un número de vale fuera de rango es 400, no 500", async () => {
    const t = await nuevaTanqueta();
    for (const n of [0, -3, 2147483648, 1.5]) {
      const r = await traspasar(t, { serie_talonario: serie, n_vale: n });
      expect(r.status, `n_vale=${n}`).toBe(400);
    }
  });

  it("la excepción es solo del traspaso: los demás despachos del tanque siguen pidiendo vale", async () => {
    const base = {
      origen: "tanque_propio",
      combustible_id: tanqueId,
      tipo_combustible: "diesel_b5",
      cantidad: 10,
      lectura_contometro: 10,
      costo_unitario: 16,
      despachado_en: hace(5),
    };
    const aEquipo = await admin
      .post("/api/erp/combustible/despachos")
      .send({ ...base, tipo_destino: "equipo", equipo_id: unidad, lectura_horometro: 10 });
    expect(aEquipo.status).toBe(400);
    const aPlanta = await admin
      .post("/api/erp/combustible/despachos")
      .send({ ...base, tipo_destino: "planta" });
    expect(aPlanta.status).toBe(400);
    const aReservaSinTanqueta = await admin
      .post("/api/erp/combustible/despachos")
      .send({ ...base, tipo_destino: "reserva_cubeta" });
    expect(aReservaSinTanqueta.status).toBe(400);
    expect(JSON.stringify(aReservaSinTanqueta.body)).toContain("serie_talonario");
  });

  // ── 3. La base lo impone aunque el schema no estuviera ────────────────

  it("la regla de la base: sin vale solo en reserva + tanqueta destino", async () => {
    const t = await nuevaTanqueta();
    const traspaso = await traspasar(t);
    expect(traspaso.status).toBe(201);
    const vale = await admin.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tanqueId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: unidad,
      lectura_horometro: 5,
      serie_talonario: serie,
      n_vale: nVale++,
      cantidad: 10,
      lectura_contometro: 10,
      costo_unitario: 16,
      despachado_en: hace(5),
    });
    expect(vale.status, JSON.stringify(vale.body)).toBe(201);

    // Un vale a un equipo al que se le borra el vale: la base lo rechaza.
    await expect(
      withTenant(tenantId, (c) =>
        c.query(
          `UPDATE combustible_despachos SET serie_talonario = NULL, n_vale = NULL
            WHERE tenant_id = $1 AND id = $2`,
          [tenantId, vale.body.id]
        )
      )
    ).rejects.toMatchObject({ code: "23514" });

    // Un traspaso al que se le quita la tanqueta destino: también.
    await expect(
      withTenant(tenantId, (c) =>
        c.query(
          `UPDATE combustible_despachos SET tanqueta_destino_id = NULL
            WHERE tenant_id = $1 AND id = $2`,
          [tenantId, traspaso.body.id]
        )
      )
    ).rejects.toMatchObject({ code: "23514" });

    // Y la mitad de un vale no existe para la base.
    await expect(
      withTenant(tenantId, (c) =>
        c.query(
          `UPDATE combustible_despachos SET n_vale = NULL
            WHERE tenant_id = $1 AND id = $2`,
          [tenantId, vale.body.id]
        )
      )
    ).rejects.toMatchObject({ code: "23514" });
  });

  // ── 4. Cómo se ve ─────────────────────────────────────────────────────

  it("el kardex lo llama traspaso, sin documento, con su salida como un despacho", async () => {
    const t = await nuevaTanqueta();
    const traspaso = await traspasar(t, { cantidad: 250 });
    expect(traspaso.status, JSON.stringify(traspaso.body)).toBe(201);
    const conUnidad = await traspasar(
      await nuevaTanqueta(),
      conVale({ tanqueta_equipo_id: unidad })
    );
    // La unidad ya puede llevar 3 tanquetas; este caso no depende de que entre.
    const fila = await filaDeKardex(traspaso.body.id);
    expect(fila).toBeDefined();
    expect(fila!.tipo).toBe("traspaso_tanqueta");
    expect(fila!.documento).toBeNull();
    expect(Number(fila!.salida)).toBe(250);
    expect(fila!.anulada).toBe(false);

    if (conUnidad.status === 201) {
      const conVal = await filaDeKardex(conUnidad.body.id);
      expect(conVal!.tipo).toBe("despacho");
      expect(conVal!.documento).toMatch(new RegExp(`^${serie}-\\d{5}$`));
    }
  });

  it("el historial de despachos trae la tanqueta destino y la serie vacía", async () => {
    const t = await nuevaTanqueta();
    const traspaso = await traspasar(t);
    const lista = await admin.get("/api/erp/combustible/despachos");
    expect(lista.status).toBe(200);
    const filas = lista.body.data as Array<Record<string, unknown>>;
    const fila = filas.find((f) => Number(f.id) === Number(traspaso.body.id));
    expect(fila).toBeDefined();
    expect(fila!.serie_talonario).toBeNull();
    expect(Number(fila!.tanqueta_destino_id)).toBe(t);
  });

  it("el CSV del kardex dice 'Traspaso a tanqueta' y no deja un documento vacío con guion", async () => {
    const t = await nuevaTanqueta();
    const creado = await traspasar(t, { cantidad: 77 });
    expect(creado.status, JSON.stringify(creado.body)).toBe(201);
    const res = await admin
      .get(`/api/erp/combustible/${tanqueId}/kardex/csv`)
      .query({ desde: hace(45), hasta: hace(0.2) });
    expect(res.status).toBe(200);
    const linea = res.text.split(/\r?\n/).find((l) => l.includes("Traspaso a tanqueta"));
    expect(linea).toBeDefined();
    expect(linea).not.toMatch(/null|undefined/);
    expect(linea).not.toMatch(/(^|[,;"])-([,;"]|$)/);
  });

  it("anular un traspaso funciona, sigue visible en el kardex y la tanqueta se vacía", async () => {
    const t = await nuevaTanqueta();
    const traspaso = await traspasar(t, { cantidad: 60 });
    expect(traspaso.status, JSON.stringify(traspaso.body)).toBe(201);
    const anul = await admin
      .patch(`/api/erp/combustible/despachos/${traspaso.body.id}/anular`)
      .send({ motivo: "se llenó la tanqueta equivocada" });
    expect(anul.status, JSON.stringify(anul.body)).toBe(200);
    expect(Number((await ver(t)).saldo)).toBe(0);
    const fila = await filaDeKardex(traspaso.body.id);
    expect(fila!.tipo).toBe("traspaso_tanqueta");
    expect(fila!.anulada).toBe(true);
  });
});
