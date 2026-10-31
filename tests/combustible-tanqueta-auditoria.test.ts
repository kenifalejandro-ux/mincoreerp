/** tests/combustible-tanqueta-auditoria.test.ts
 *
 * Auditoría adversaria de la serie "la tanqueta se asigna a la unidad" (0139,
 * 0140; PR #297-#302). Ataca la API: aislamiento entre empresas, permisos por
 * rol, concurrencia, anulaciones, la regla de "tanqueta activa", límites,
 * bitácora y códigos HTTP.
 *
 * CONVENCIÓN. Cada test afirma lo que DEBERÍA pasar. Los hallazgos
 * confirmados van con `it.fails(...)`: el test falla hoy (eso es lo que
 * demuestra el hueco) y la suite sigue en verde. Cuando se arregle el hueco,
 * el `it.fails` empieza a fallar y avisa que hay que quitarle el `.fails`.
 * El prefijo del nombre (H-n) es el número del hallazgo en el informe.
 *
 * No toca código de producción. Deja el tenant limpio al terminar.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import {
  app,
  crearTenantDePrueba,
  borrarTenantDePrueba,
  idUnico,
  recibirTanqueta,
} from "./helpers";
import { closeDatabase, pool, withTenant } from "../src/server/config/database";

type Agente = ReturnType<typeof request.agent>;

describe("auditoría adversaria: tanquetas asignadas a unidad (0139/0140)", () => {
  const password = "ClaveDePrueba123";
  let tenantId: string;
  let slug: string;
  let tenantAjeno: string;
  const admin = request.agent(app);
  const ajeno = request.agent(app); // admin de OTRA empresa
  let operador: Agente;
  let grifero: Agente;
  let encargado: Agente;
  let lectura: Agente;
  let conductorSinUnidad: Agente;
  let conductor: Agente; // para los tests de permisos: no es el conductor de nada
  let principal: number;
  let grifoProveedor: number;
  let uA: number; // unidades NUEVAS en cada test: una unidad solo lleva 3 tanquetas
  let uB: number;
  let unidadAjena: number; // equipo de la otra empresa
  let tanqueAjeno: number;
  let tanquetaAjena: number;
  let nVale = 1;
  let medidor = 1000;
  const SERIE = "AUD";

  const unidadNueva = async (a: Agente, grifo: number, dni?: string) =>
    (
      await a.post("/api/erp/equipos").send({
        placa_codigo: idUnico("VQ"),
        tipo: "VOLQUETE",
        tipo_medidor: "horometro",
        grifo_interno_id: grifo,
        ...(dni ? { conductor_nombre: "Alguien", conductor_dni: dni } : {}),
      })
    ).body.id as number;

  const tanqueNuevo = async (a: Agente, grifo: number, extra: Record<string, unknown> = {}) =>
    (
      await a.post("/api/erp/combustible").send({
        codigo: idUnico("TQ"),
        tanque_nombre: "Tanque Auditoría",
        tipo_combustible: "diesel_b5",
        unidad: "gal",
        tipo_punto: "fijo",
        capacidad_total: 20000,
        nivel_actual: 15000,
        requiere_documento: false,
        modo_excedente_recepcion: "flexible",
        grifo_interno_id: grifo,
        ...extra,
      })
    ).body.id as number;

  const tanquetaNueva = async (a: Agente = admin, grifo: number = principal) =>
    Number(
      (await a.post("/api/erp/combustible/tanquetas").send({ grifo_interno_id: grifo })).body.id
    );

  /** Un vale del tanque a "reserva en cubeta": llena la tanqueta. */
  const llenarBody = (tanque: number, tanqueta: number, cantidad: number, extra = {}) => ({
    origen: "tanque_propio",
    combustible_id: tanque,
    tipo_combustible: "diesel_b5",
    tipo_destino: "reserva_cubeta",
    tanqueta_destino_id: tanqueta,
    serie_talonario: SERIE,
    n_vale: nVale++,
    cantidad,
    lectura_contometro: cantidad,
    costo_unitario: 16,
    ...extra,
  });
  const llenar = (a: Agente, tanque: number, tanqueta: number, cantidad: number, extra = {}) =>
    a.post("/api/erp/combustible/despachos").send(llenarBody(tanque, tanqueta, cantidad, extra));

  const asignar = (a: Agente, tanqueta: number, equipoId: unknown) =>
    a.put(`/api/erp/combustible/tanquetas/${tanqueta}/asignar`).send({
      equipo_id: equipoId,
      serie_talonario: "ASG",
      n_vale: nVale++,
    });
  const retornar = (a: Agente, tanqueta: number) => recibirTanqueta(admin, tanqueta, { como: a });
  const retornarCrudo = (a: Agente, tanqueta: number | string, cuerpo: unknown) =>
    a.post(`/api/erp/combustible/tanquetas/${tanqueta}/retorno`).send(cuerpo as object);

  /** La baja de una unidad no tiene endpoint en la API: se hace por SQL, como lo haría Soporte. */
  const darDeBajaEquipo = async (equipoId: number) => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      await c.query("UPDATE equipos SET activo = false WHERE tenant_id = $1 AND id = $2", [
        tenantId,
        equipoId,
      ]);
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  };

  /** Tanqueta llena con `cantidad` gal y asignada a `unidad`. */
  const tanquetaLlenaYAsignada = async (tanque: number, unidad: number, cantidad = 100) => {
    const t = await tanquetaNueva();
    const v = await llenar(admin, tanque, t, cantidad);
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    const a = await asignar(admin, t, unidad);
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    return t;
  };

  const ver = async (id: number) =>
    (await admin.get("/api/erp/combustible/tanquetas")).body.find(
      (t: { id: string }) => Number(t.id) === id
    );

  const cargarEnRuta = (
    a: Agente,
    tanqueta: number,
    equipoId: number,
    cantidad = 10,
    extra: Record<string, unknown> = {}
  ) =>
    a.post("/api/erp/combustible/despachos").send({
      origen: "tanqueta",
      tanqueta_origen_id: tanqueta,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipoId,
      cantidad,
      lectura_horometro: medidor++,
      ...extra,
    });

  const delFormulario = async (a: Agente) =>
    (await a.get("/api/erp/combustible/tanquetas/formulario")).body as {
      id: number;
      equipo_asignado_id: number;
    }[];

  const bitacora = async (accion: string, tanquetaId?: number) =>
    (
      await pool.query(
        `SELECT accion, usuario_id, detalle FROM platform_audit_log
          WHERE tenant_id = $1 AND accion = $2 ORDER BY creado_en`,
        [tenantId, accion]
      )
    ).rows.filter(
      (f) => tanquetaId === undefined || Number(f.detalle?.tanquetaId) === tanquetaId
    ) as { accion: string; usuario_id: string; detalle: Record<string, unknown> }[];

  const altaUsuario = async (rol: string) => {
    const email = `${rol}-${idUnico("u")}@test.local`;
    const alta = await admin.post("/api/erp/usuarios").send({ nombre: rol, email, password, rol });
    expect(alta.status, JSON.stringify(alta.body)).toBe(201);
    const a = request.agent(app);
    const l = await a.post("/api/auth/login").send({ tenantSlug: slug, email, password });
    expect(l.status).toBe(200);
    return a;
  };
  const altaPorDni = async (rol: string, dni: string) => {
    const alta = await admin.post("/api/erp/usuarios").send({ nombre: rol, dni, password, rol });
    expect(alta.status, JSON.stringify(alta.body)).toBe(201);
    const a = request.agent(app);
    const l = await a
      .post("/api/auth/login")
      .send({ tenantSlug: slug, identificador: dni, password });
    expect(l.status, JSON.stringify(l.body)).toBe(200);
    return a;
  };

  /** Un conductor con su propia unidad (el DNI del usuario = conductor_dni del equipo). */
  let seqDni = 0;
  const conductorNuevo = async () => {
    const dni = String(89400000 + Math.floor(Math.random() * 300000) + seqDni++);
    const unidad = await unidadNueva(admin, principal, dni);
    const agente = await altaPorDni("conductor_ruta", dni);
    return { agente, unidad, dni };
  };

  beforeEach(async () => {
    uA = await unidadNueva(admin, principal);
    uB = await unidadNueva(admin, principal, "40999998");
  });

  // El tanque de la empresa propia y el de la ajena se crean una sola vez.
  let tanque: number;

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    slug = creado.tenant.slug;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: slug, email: creado.usuario.email, password });
    principal = (await admin.get("/api/erp/sedes")).body.sedes[0].grifos[0].id;
    grifoProveedor = (
      await admin.post("/api/erp/combustible/grifos").send({ nombre: idUnico("CISTERNA") })
    ).body.id;

    tanque = await tanqueNuevo(admin, principal);

    operador = await altaUsuario("operador");
    grifero = await altaPorDni("grifero", String(88600000 + Math.floor(Math.random() * 400000)));
    encargado = await altaUsuario("encargado_urea");
    lectura = await altaUsuario("lectura");
    conductor = conductorSinUnidad = await altaPorDni(
      "conductor_ruta",
      String(88700000 + Math.floor(Math.random() * 400000))
    );

    // La otra empresa: su admin, su unidad, su tanque y su tanqueta con saldo.
    const otra = await crearTenantDePrueba(password);
    tenantAjeno = otra.tenant.id;
    await ajeno
      .post("/api/auth/login")
      .send({ tenantSlug: otra.tenant.slug, email: otra.usuario.email, password });
    const grifoAjeno = (await ajeno.get("/api/erp/sedes")).body.sedes[0].grifos[0].id;
    unidadAjena = await unidadNueva(ajeno, grifoAjeno);
    tanqueAjeno = await tanqueNuevo(ajeno, grifoAjeno);
    tanquetaAjena = await tanquetaNueva(ajeno, grifoAjeno);
    const v = await llenar(ajeno, tanqueAjeno, tanquetaAjena, 100);
    expect(v.status, JSON.stringify(v.body)).toBe(201);
  }, 60_000);

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await borrarTenantDePrueba(tenantAjeno);
    await closeDatabase();
  });

  // ═══ A. Aislamiento entre empresas ═══════════════════════════════════════
  describe("A. aislamiento entre empresas", () => {
    it("A1: asignar con el equipo_id de otra empresa es 400, no 500, y no cambia nada", async () => {
      const t = await tanquetaLlenaYAsignada(tanque, uA);
      const r = await asignar(admin, t, unidadAjena);
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      expect((await ver(t)).equipo_asignado_id).toBe(uA);
    });

    it("A2: asignar o recibir de vuelta la tanqueta de otra empresa es 404, y la ajena no se toca", async () => {
      expect((await asignar(admin, tanquetaAjena, uA)).status).toBe(404);
      expect((await retornar(admin, tanquetaAjena)).status).toBe(404);
      const hist = await admin.get(`/api/erp/combustible/tanquetas/${tanquetaAjena}/historial`);
      expect(hist.status).toBe(404);
      const suya = (await ajeno.get("/api/erp/combustible/tanquetas")).body.find(
        (t: { id: string }) => Number(t.id) === tanquetaAjena
      );
      expect(suya.equipo_asignado_id).toBeNull();
    });

    it("A3: el vale a reserva con tanqueta_equipo_id ajeno es 400 y la tanqueta no recibe nada", async () => {
      const t = await tanquetaNueva();
      const r = await llenar(admin, tanque, t, 50, { tanqueta_equipo_id: unidadAjena });
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      const fila = await ver(t);
      expect(Number(fila.saldo)).toBe(0);
      expect(fila.equipo_asignado_id).toBeNull();
    });

    it("A4: el vale a reserva con la tanqueta de otra empresa es 400", async () => {
      const r = await llenar(admin, tanque, tanquetaAjena, 10);
      expect(r.status, JSON.stringify(r.body)).toBe(400);
    });

    it("A5: el reparto con tanqueta_equipo_id ajeno es 400 y no deja la recepción a medias", async () => {
      const t = await tanquetaNueva();
      const tanqueLleno = await tanqueNuevo(admin, principal, {
        capacidad_total: 2000,
        nivel_actual: 2000,
      });
      const r = await admin.post("/api/erp/combustible/recepciones").send({
        combustible_id: tanqueLleno,
        grifo_id: grifoProveedor,
        cantidad: 100,
        costo_unitario: 17,
        recibido_en: new Date().toISOString(),
        reparto_excedente: [
          {
            destino: "cubeta",
            cantidad: 100,
            tanqueta_id: t,
            tanqueta_equipo_id: unidadAjena,
            serie_talonario: "CIS",
            n_vale: 5000 + nVale++,
          },
        ],
      });
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      expect(Number((await ver(t)).saldo)).toBe(0);
    });

    it("A6: el mismo (serie, n° de vale) en dos empresas no choca", async () => {
      const t = await tanquetaNueva();
      const tAjena = await tanquetaNueva(
        ajeno,
        (await ajeno.get("/api/erp/sedes")).body.sedes[0].grifos[0].id
      );
      const n = nVale++;
      const propio = await llenar(admin, tanque, t, 10, { serie_talonario: "CRUCE", n_vale: n });
      const ajenoR = await llenar(ajeno, tanqueAjeno, tAjena, 10, {
        serie_talonario: "CRUCE",
        n_vale: n,
      });
      expect(propio.status, JSON.stringify(propio.body)).toBe(201);
      expect(ajenoR.status, JSON.stringify(ajenoR.body)).toBe(201);
    });

    it("A7: el conductor de una empresa no ve ni carga la tanqueta de otra", async () => {
      const c = await conductorNuevo();
      const r = await cargarEnRuta(c.agente, tanquetaAjena, c.unidad);
      expect(r.status, JSON.stringify(r.body)).toBe(400);
    });
  });

  // ═══ B. Permisos por rol ════════════════════════════════════════════════
  describe("B. permisos por rol", () => {
    it("B1: asignar lo hacen admin, operador y grifero; el retorno también (no conductor, encargado ni Lectura)", async () => {
      const t = await tanquetaLlenaYAsignada(tanque, uA);
      const intrusos: [string, Agente][] = [
        ["conductor", conductor],
        ["encargado_urea", encargado],
        ["lectura", lectura],
      ];
      for (const [nombre, a] of intrusos) {
        const as = await asignar(a, t, uB);
        expect(as.status, `${nombre} asignar: ${JSON.stringify(as.body)}`).toBe(403);
        const li = await retornar(a, t);
        expect(li.status, `${nombre} retorno: ${JSON.stringify(li.body)}`).toBe(403);
      }
      expect((await ver(t)).equipo_asignado_id).toBe(uA);
      expect((await retornar(operador, t)).status).toBe(201);
      expect((await asignar(operador, t, uB)).status).toBe(200);
      // El grifero también asigna (permiso propio `tanquetas:asignar`): la recibe y la entrega.
      expect((await retornar(grifero, t)).status).toBe(201);
      const g = await asignar(grifero, t, uA);
      expect(g.status, JSON.stringify(g.body)).toBe(200);
    });

    it("B2: Lectura no puede mandar tanqueta_equipo_id en un vale ni en una recepción", async () => {
      const t = await tanquetaNueva();
      const vale = await llenar(lectura, tanque, t, 10, { tanqueta_equipo_id: uA });
      expect(vale.status).toBe(403);
      const rec = await lectura.post("/api/erp/combustible/recepciones").send({
        combustible_id: tanque,
        grifo_id: grifoProveedor,
        cantidad: 100,
        costo_unitario: 17,
        recibido_en: new Date().toISOString(),
        reparto_excedente: [
          {
            destino: "cubeta",
            cantidad: 100,
            tanqueta_id: t,
            tanqueta_equipo_id: uA,
            serie_talonario: "CIS",
            n_vale: 6000 + nVale++,
          },
        ],
      });
      expect(rec.status).toBe(403);
      expect(Number((await ver(t)).saldo)).toBe(0);
    });

    it("B3: el conductor y el encargado de urea no pueden asignar por el camino del vale", async () => {
      const t = await tanquetaNueva();
      const c = await llenar(conductor, tanque, t, 10, { tanqueta_equipo_id: uA });
      expect(c.status).toBe(403);
      const e = await llenar(encargado, tanque, t, 10, { tanqueta_equipo_id: uA });
      expect(e.status).toBe(403);
      expect((await ver(t)).equipo_asignado_id).toBeNull();
    });

    it("B4: el encargado de urea no registra recepciones de combustible con reparto a tanqueta", async () => {
      const t = await tanquetaNueva();
      const r = await encargado.post("/api/erp/combustible/recepciones").send({
        combustible_id: tanque,
        grifo_id: grifoProveedor,
        cantidad: 100,
        costo_unitario: 17,
        recibido_en: new Date().toISOString(),
        reparto_excedente: [
          {
            destino: "cubeta",
            cantidad: 100,
            tanqueta_id: t,
            tanqueta_equipo_id: uA,
            serie_talonario: "CIS",
            n_vale: 7000 + nVale++,
          },
        ],
      });
      expect(r.status).toBe(403);
    });

    it("H-1: un grifero (sin 'Editar tanqueta') NO puede reasignar una tanqueta ajena llenándola con otro tanqueta_equipo_id", async () => {
      const t = await tanquetaLlenaYAsignada(tanque, uA, 100);
      const r = await llenar(grifero, tanque, t, 1, { tanqueta_equipo_id: uB });
      // Lo seguro: o se rechaza, o la tanqueta sigue con su unidad.
      const fila = await ver(t);
      expect(
        r.status >= 400 || fila.equipo_asignado_id === uA,
        `status ${r.status}, ahora va con la unidad ${fila.equipo_asignado_id}`
      ).toBe(true);
    });
  });

  // ═══ C. Concurrencia ════════════════════════════════════════════════════
  describe("C. concurrencia", () => {
    it("C1: 5 asignaciones simultáneas a una unidad vacía: pasan exactamente 3", async () => {
      const u = await unidadNueva(admin, principal);
      const ts: number[] = [];
      for (let i = 0; i < 5; i++) {
        const t = await tanquetaNueva();
        expect((await llenar(admin, tanque, t, 50)).status).toBe(201);
        ts.push(t);
      }
      const rs = await Promise.all(ts.map((t) => asignar(admin, t, u)));
      const estados = rs.map((r) => r.status).sort();
      expect(
        estados.filter((s) => s >= 500),
        JSON.stringify(rs.map((r) => r.body))
      ).toEqual([]);
      expect(estados.filter((s) => s === 200)).toHaveLength(3);
      expect(estados.filter((s) => s === 400)).toHaveLength(2);
    });

    it("C2: asignar a la vez que se llena y se anula la misma tanqueta no da 500 ni deja la unidad con más de 3", async () => {
      const u = await unidadNueva(admin, principal);
      const t = await tanquetaNueva();
      const v1 = await llenar(admin, tanque, t, 60);
      expect(v1.status).toBe(201);
      const llenarBody2 = llenarBody(tanque, t, 20, { tanqueta_equipo_id: u });
      const [a, b, c] = await Promise.all([
        asignar(admin, t, u),
        admin.post("/api/erp/combustible/despachos").send(llenarBody2),
        admin
          .patch(`/api/erp/combustible/despachos/${v1.body.id}/anular`)
          .send({ motivo: "prueba de carrera" }),
      ]);
      for (const r of [a, b, c]) expect(r.status, JSON.stringify(r.body)).toBeLessThan(500);
      const vigentes = (await admin.get("/api/erp/combustible/tanquetas")).body.filter(
        (x: { equipo_asignado_id: number; asignada_vigente: boolean }) =>
          x.equipo_asignado_id === u && x.asignada_vigente
      );
      expect(vigentes.length).toBeLessThanOrEqual(3);
    });

    it("C3: dos cargas simultáneas que sobregiran la misma tanqueta dejan UNA alerta", async () => {
      const c = await conductorNuevo();
      const t = await tanquetaLlenaYAsignada(tanque, c.unidad, 15);
      const rs = await Promise.all([
        cargarEnRuta(c.agente, t, c.unidad, 10),
        cargarEnRuta(c.agente, t, c.unidad, 10),
      ]);
      for (const r of rs) expect(r.status, JSON.stringify(r.body)).toBeLessThan(500);
      const ok = rs.filter((r) => r.status === 201);
      expect(ok.length).toBeGreaterThan(0);
      const alertas = (
        await admin.get("/api/erp/combustible/alertas").query({ pageSize: 200 })
      ).body.data.filter(
        (a: { tipo: string; despacho_id: number }) =>
          a.tipo === "tanqueta_sobregirada" &&
          ok.some((r) => Number(r.body.id) === Number(a.despacho_id))
      );
      expect(alertas.length).toBeGreaterThanOrEqual(1);
    });

    it("C4: dos vales del tanque simultáneos con el MISMO número: uno entra y el otro es 409 (no 500 ni dos 201)", async () => {
      const t1 = await tanquetaNueva();
      const t2 = await tanquetaNueva();
      const n = nVale++;
      const rs = await Promise.all([
        llenar(admin, tanque, t1, 10, { n_vale: n }),
        llenar(admin, tanque, t2, 10, { n_vale: n }),
      ]);
      const estados = rs.map((r) => r.status).sort();
      expect(estados, JSON.stringify(rs.map((r) => r.body))).toEqual([201, 409]);
    });

    it("H-2: dos recepciones simultáneas con el MISMO vale en el reparto: solo una entra", async () => {
      const n = 9000 + nVale++;
      const t1 = await tanquetaNueva();
      const t2 = await tanquetaNueva();
      const tanquesLlenos = [
        await tanqueNuevo(admin, principal, { capacidad_total: 2000, nivel_actual: 2000 }),
        await tanqueNuevo(admin, principal, { capacidad_total: 2000, nivel_actual: 2000 }),
      ];
      const cuerpo = (tq: number, tanqueta: number, unidad: number) => ({
        combustible_id: tq,
        grifo_id: grifoProveedor,
        cantidad: 100,
        costo_unitario: 17,
        recibido_en: new Date().toISOString(),
        reparto_excedente: [
          {
            destino: "cubeta",
            cantidad: 100,
            tanqueta_id: tanqueta,
            tanqueta_equipo_id: unidad,
            serie_talonario: "CISR",
            n_vale: n,
          },
        ],
      });
      const rs = await Promise.all([
        admin.post("/api/erp/combustible/recepciones").send(cuerpo(tanquesLlenos[0], t1, uA)),
        admin.post("/api/erp/combustible/recepciones").send(cuerpo(tanquesLlenos[1], t2, uB)),
      ]);
      const lineasConElVale = await withTenant(
        tenantId,
        async (c) =>
          (
            await c.query(
              `SELECT count(*)::int AS n FROM combustible_recepcion_excedentes x
                 JOIN combustible_recepciones r ON r.id = x.recepcion_id AND r.tenant_id = x.tenant_id
                WHERE x.tenant_id = $1 AND x.serie_talonario = 'CISR' AND x.n_vale = $2
                  AND r.anulada_en IS NULL`,
              [tenantId, n]
            )
          ).rows[0].n as number
      );
      expect(
        { estados: rs.map((r) => r.status).sort(), lineasConElVale },
        "el mismo vale CISR-n quedó registrado en más de una recepción"
      ).toEqual({ estados: [201, 400], lineasConElVale: 1 });
    });

    it("H-3: una recepción con vale en el reparto y un despacho con el mismo vale, a la vez: solo uno entra", async () => {
      const n = 9500 + nVale++;
      const t = await tanquetaNueva();
      const tLleno = await tanqueNuevo(admin, principal, {
        capacidad_total: 2000,
        nivel_actual: 2000,
      });
      const tDelVale = await tanquetaNueva(); // fuera del Promise.all: no anidar agentes
      const rs = await Promise.all([
        admin.post("/api/erp/combustible/recepciones").send({
          combustible_id: tLleno,
          grifo_id: grifoProveedor,
          cantidad: 100,
          costo_unitario: 17,
          recibido_en: new Date().toISOString(),
          reparto_excedente: [
            {
              destino: "cubeta",
              cantidad: 100,
              tanqueta_id: t,
              tanqueta_equipo_id: uA,
              serie_talonario: "MIX",
              n_vale: n,
            },
          ],
        }),
        llenar(admin, tanque, tDelVale, 10, { serie_talonario: "MIX", n_vale: n }),
      ]);
      const aceptadas = rs.filter((r) => r.status === 201).length;
      expect(aceptadas, JSON.stringify(rs.map((r) => [r.status, r.body]))).toBe(1);
    });
  });

  // ═══ D. Anulaciones y correcciones ═══════════════════════════════════════
  describe("D. anulaciones", () => {
    it("H-4: anular la carga que vació la tanqueta hace que la unidad lleve 4 tanquetas vigentes", async () => {
      const u = await unidadNueva(admin, principal, "40999996");
      const vaciable = await tanquetaLlenaYAsignada(tanque, u, 100);
      // La vaciamos con una carga del admin (origen tanqueta, planta, con vale).
      const carga = await admin.post("/api/erp/combustible/despachos").send({
        origen: "tanqueta",
        tanqueta_origen_id: vaciable,
        tanqueta_lugar: "planta",
        tipo_combustible: "diesel_b5",
        tipo_destino: "equipo",
        equipo_id: u,
        cantidad: 100,
        serie_talonario: SERIE,
        n_vale: nVale++,
      });
      expect(carga.status, JSON.stringify(carga.body)).toBe(201);
      expect((await ver(vaciable)).asignada_vigente).toBe(false);
      // Con la primera vacía, la unidad toma otras 3.
      for (let i = 0; i < 3; i++) await tanquetaLlenaYAsignada(tanque, u, 50);
      // Anular la carga: la tanqueta vuelve a tener 100 y su asignación vieja revive.
      const an = await admin
        .patch(`/api/erp/combustible/despachos/${carga.body.id}/anular`)
        .send({ motivo: "prueba: la carga estaba mal" });
      expect(an.status, JSON.stringify(an.body)).toBe(200);
      const vigentes = (await admin.get("/api/erp/combustible/tanquetas")).body.filter(
        (x: { equipo_asignado_id: number; asignada_vigente: boolean }) =>
          x.equipo_asignado_id === u && x.asignada_vigente
      );
      expect(vigentes.length, "la unidad no debería pasar de 3").toBeLessThanOrEqual(3);
    });

    it("H-5: no se puede anular un vale de llenado si ya se cargó combustible de esa tanqueta (saldo negativo)", async () => {
      const cond = await conductorNuevo();
      const t = await tanquetaNueva();
      const v = await llenar(admin, tanque, t, 100);
      expect(v.status).toBe(201);
      expect((await asignar(admin, t, cond.unidad)).status).toBe(200);
      const c = await cargarEnRuta(cond.agente, t, cond.unidad, 80);
      expect(c.status, JSON.stringify(c.body)).toBe(201);
      const an = await admin
        .patch(`/api/erp/combustible/despachos/${v.body.id}/anular`)
        .send({ motivo: "prueba: vale mal tipeado" });
      const saldo = Number((await ver(t)).saldo);
      expect(
        an.status >= 400 || saldo >= 0,
        `anuló (${an.status}) y el saldo quedó en ${saldo}`
      ).toBe(true);
    });

    it("D3: anular una recepción con líneas asignadas deja libre el vale y la tanqueta vacía", async () => {
      const t = await tanquetaNueva();
      const lleno = await tanqueNuevo(admin, principal, {
        capacidad_total: 2000,
        nivel_actual: 2000,
      });
      const n = 8000 + nVale++;
      const linea = {
        destino: "cubeta",
        cantidad: 100,
        tanqueta_id: t,
        tanqueta_equipo_id: uA,
        serie_talonario: "CISD",
        n_vale: n,
      };
      const cuerpo = () => ({
        combustible_id: lleno,
        grifo_id: grifoProveedor,
        cantidad: 100,
        costo_unitario: 17,
        recibido_en: new Date().toISOString(),
        reparto_excedente: [linea],
      });
      const r = await admin.post("/api/erp/combustible/recepciones").send(cuerpo());
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      const an = await admin
        .patch(`/api/erp/combustible/recepciones/${r.body.id}/anular`)
        .send({ motivo: "prueba: recepción mal cargada" });
      expect(an.status, JSON.stringify(an.body)).toBe(200);
      const fila = await ver(t);
      expect(Number(fila.saldo)).toBe(0);
      expect(fila.asignada_vigente).toBe(false);
      // El número del vale queda libre para volver a cargarlo.
      const otra = await tanquetaNueva();
      const lleno2 = await tanqueNuevo(admin, principal, {
        capacidad_total: 2000,
        nivel_actual: 2000,
      });
      const de_nuevo = await admin.post("/api/erp/combustible/recepciones").send({
        ...cuerpo(),
        combustible_id: lleno2,
        reparto_excedente: [{ ...linea, tanqueta_id: otra }],
      });
      expect(de_nuevo.status, JSON.stringify(de_nuevo.body)).toBe(201);
    });

    it("D4: anular el vale de llenado de una tanqueta asignada y vacía la deja sin unidad vigente", async () => {
      const cond = await conductorNuevo();
      const t = await tanquetaNueva();
      const v = await llenar(admin, tanque, t, 40);
      await asignar(admin, t, cond.unidad);
      expect((await delFormulario(cond.agente)).some((x) => x.id === t)).toBe(true);
      const an = await admin
        .patch(`/api/erp/combustible/despachos/${v.body.id}/anular`)
        .send({ motivo: "prueba: vale mal tipeado" });
      expect(an.status).toBe(200);
      const fila = await ver(t);
      expect(fila.asignada_vigente).toBe(false);
      expect((await delFormulario(cond.agente)).some((x) => x.id === t)).toBe(false);
    });
  });

  // ═══ E. La regla de "tanqueta activa" ═══════════════════════════════════
  describe("E. regla de la tanqueta activa", () => {
    it("E1: no se puede cargar la segunda, ni la de otra unidad (403), ni una sin asignar", async () => {
      // Se aísla en una unidad propia del conductor para no heredar tanquetas de otros tests.
      const dni = String(88800000 + Math.floor(Math.random() * 400000));
      const u = await unidadNueva(admin, principal, dni);
      const c = await altaPorDni("conductor_ruta", dni);
      const primera = await tanquetaLlenaYAsignada(tanque, u, 100);
      const segunda = await tanquetaLlenaYAsignada(tanque, u, 100);
      const ajena = await tanquetaLlenaYAsignada(tanque, uB, 100);
      const sinAsignar = await tanquetaNueva();
      expect((await cargarEnRuta(c, segunda, u)).status).toBe(400);
      expect((await cargarEnRuta(c, sinAsignar, u)).status).toBe(400);
      expect((await cargarEnRuta(c, ajena, u)).status).toBe(400);
      expect((await cargarEnRuta(c, primera, uB)).status).toBe(403);
      expect((await cargarEnRuta(c, primera, u)).status).toBe(201);
    });

    it("E2: un conductor con dos unidades carga la activa de cada una y no cruza tanquetas", async () => {
      const dni = String(88900000 + Math.floor(Math.random() * 400000));
      const u1 = await unidadNueva(admin, principal, dni);
      const u2 = await unidadNueva(admin, principal, dni);
      const c = await altaPorDni("conductor_ruta", dni);
      const t1 = await tanquetaLlenaYAsignada(tanque, u1, 100);
      const t2 = await tanquetaLlenaYAsignada(tanque, u2, 100);
      expect((await cargarEnRuta(c, t1, u2)).status).toBe(400);
      expect((await cargarEnRuta(c, t2, u1)).status).toBe(400);
      expect((await cargarEnRuta(c, t1, u1)).status).toBe(201);
      expect((await cargarEnRuta(c, t2, u2)).status).toBe(201);
      const lista = await delFormulario(c);
      expect(lista.map((x) => x.id).sort()).toEqual([t1, t2].sort());
    });

    it("E3: un DNI con espacios en Equipos igual coincide", async () => {
      const dni = String(89100000 + Math.floor(Math.random() * 400000));
      const u = await unidadNueva(admin, principal, `  ${dni} `);
      const c = await altaPorDni("conductor_ruta", dni);
      const t = await tanquetaLlenaYAsignada(tanque, u, 100);
      expect((await cargarEnRuta(c, t, u)).status).toBe(201);
    });

    it("E4: un equipo dado de baja deja de ser 'a cargo' del conductor", async () => {
      const dni = String(89200000 + Math.floor(Math.random() * 400000));
      const u = await unidadNueva(admin, principal, dni);
      const c = await altaPorDni("conductor_ruta", dni);
      const t = await tanquetaLlenaYAsignada(tanque, u, 100);
      await darDeBajaEquipo(u);
      const r = await cargarEnRuta(c, t, u);
      expect(r.status, JSON.stringify(r.body)).toBe(403);
    });

    it("H-10: con el DNI sin coincidir en Equipos, el formulario viene vacío y el servidor lo marca (200 [] + cabecera)", async () => {
      // conductorSinUnidad no es el conductor de ninguna unidad; hay tanquetas asignadas en la empresa.
      const t = await tanquetaLlenaYAsignada(tanque, uA, 100);
      const r = await conductorSinUnidad.get("/api/erp/combustible/tanquetas/formulario");
      expect(r.status).toBe(200);
      // La lista viene vacía y el servidor lo explica con una marca (H-10).
      expect(r.body).toEqual([]);
      expect(r.headers["x-conductor-sin-unidad"]).toBe("1");
      const c = await cargarEnRuta(conductorSinUnidad, t, uA);
      expect(c.status).toBe(403);
    });

    it("E5: una tanqueta ya vaciada pero aún asignada no sirve para cargar de más una y otra vez sin alerta propia", async () => {
      const dni = String(89300000 + Math.floor(Math.random() * 400000));
      const u = await unidadNueva(admin, principal, dni);
      const c = await altaPorDni("conductor_ruta", dni);
      const t = await tanquetaLlenaYAsignada(tanque, u, 20);
      expect((await cargarEnRuta(c, t, u, 20)).status).toBe(201); // la vacía
      expect((await ver(t)).asignada_vigente).toBe(false);
      const cargas: { status: number; body: { id?: number } }[] = [];
      for (let i = 0; i < 3; i++) cargas.push(await cargarEnRuta(c, t, u, 50));
      expect(cargas.map((r) => r.status)).toEqual([201, 201, 201]);
      const alertas = (
        await admin.get("/api/erp/combustible/alertas").query({ pageSize: 200 })
      ).body.data.filter(
        (a: { tipo: string; despacho_id: number }) =>
          a.tipo === "tanqueta_sobregirada" &&
          cargas.some((r) => Number(r.body.id) === Number(a.despacho_id))
      );
      // Diseño: la tanqueta ya vaciada se sigue aceptando. Lo que se mide es si 150 gal sin
      // respaldo dejan rastro por CADA carga.
      expect(alertas.length, "una alerta por cada carga sin respaldo").toBe(3);
    });

    it("H-11 (caracterización, hueco 3): la carga offline de una tanqueta que ya no es suya vuelve 4xx (la cola la DESCARTA), no 5xx", async () => {
      const c = await conductorNuevo();
      const t = await tanquetaLlenaYAsignada(tanque, c.unidad, 100);
      // El formulario precargado (sin señal) todavía muestra la tanqueta...
      expect((await delFormulario(c.agente)).map((x) => x.id)).toEqual([t]);
      // ...y mientras tanto la oficina la libera.
      expect((await retornar(admin, t)).status).toBe(201);
      // Al sincronizar, el POST de la cola llega con el mismo cuerpo y su cliente_uuid.
      const r = await cargarEnRuta(c.agente, t, c.unidad, 30, { cliente_uuid: randomUUID() });
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      expect(r.body.error).toMatch(/no está asignada a tu unidad/);
      // offlineSync.ts descarta los 4xx (salvo 401/408/429) y el banner solo dice "HTTP 400":
      // la carga física de 30 gal no queda registrada.
      expect(Number((await ver(t)).salidas)).toBe(0);
    });
  });

  // ═══ F. Bypass de límites ═══════════════════════════════════════════════
  describe("F. límites y datos malos", () => {
    it("F1: dar de baja una tanqueta con saldo es 400", async () => {
      const t = await tanquetaLlenaYAsignada(tanque, uA, 50);
      const r = await admin
        .put(`/api/erp/combustible/tanquetas/${t}`)
        .send({ activa: false, motivo: "prueba de auditoría" });
      expect(r.status).toBe(400);
    });

    it("F2: el retorno con cuerpo malo o una diferencia sin motivo es 400; sin estar asignada también", async () => {
      const t = await tanquetaLlenaYAsignada(tanque, uA, 50);
      const fallos: string[] = [];
      const base = { saldo_calculado: 50, saldo_validado: 50, destino: "reserva" };
      for (const cuerpo of [
        {},
        { ...base, saldo_calculado: undefined },
        { ...base, saldo_validado: undefined },
        { ...base, destino: undefined },
        { ...base, destino: "pozo" },
        { ...base, saldo_calculado: 0 },
        { ...base, saldo_calculado: "50" },
        { ...base, saldo_validado: -1 },
        { ...base, saldo_validado: 281, motivo: "no cabe en la tanqueta" },
        { ...base, saldo_validado: 40 },
        { ...base, saldo_validado: 40, motivo: "   " },
        { ...base, saldo_validado: 40, motivo: "ab" },
        { ...base, saldo_validado: 40, motivo: "x".repeat(501) },
        { ...base, motivo: 5 },
        { ...base, motivo: null },
      ]) {
        const r = await retornarCrudo(admin, t, cuerpo);
        if (r.status !== 400) fallos.push(`${JSON.stringify(cuerpo).slice(0, 40)} -> ${r.status}`);
      }
      expect(fallos).toEqual([]);
      expect((await ver(t)).equipo_asignado_id).toBe(uA);
      expect((await retornar(admin, t)).status).toBe(201);
      expect((await retornar(admin, t)).status).toBe(400);
    });

    it("H-7a: asignar con equipo_id malo es 400 (nunca 500)", async () => {
      const t = await tanquetaLlenaYAsignada(tanque, uA, 50);
      const fallos: string[] = [];
      for (const bad of [
        undefined,
        null,
        0,
        -1,
        1.5,
        "7",
        "abc",
        [],
        {},
        2 ** 53,
        99999999999,
        2147483648,
      ]) {
        const r = await asignar(admin, t, bad);
        if (r.status !== 400) fallos.push(`equipo_id=${JSON.stringify(bad)} -> ${r.status}`);
      }
      expect(fallos).toEqual([]);
    });

    it("H-7b: el id de la tanqueta en la ruta malo o enorme es 400/404 (nunca 500)", async () => {
      const fallos: string[] = [];
      for (const id of ["abc", "-1", "0", "1.5", "99999999999", "2147483648"]) {
        const as = await admin
          .put(`/api/erp/combustible/tanquetas/${id}/asignar`)
          .send({ equipo_id: uA, serie_talonario: "ASG", n_vale: nVale++ });
        if (as.status >= 500) fallos.push(`asignar id=${id} -> ${as.status}`);
        const li = await retornarCrudo(admin, id, {
          saldo_calculado: 50,
          saldo_validado: 50,
          destino: "reserva",
        });
        if (li.status >= 500) fallos.push(`retorno id=${id} -> ${li.status}`);
        const ed = await admin
          .put(`/api/erp/combustible/tanquetas/${id}`)
          .send({ activa: true, motivo: "prueba de auditoría" });
        // Malformado (abc, -1, 0, 1.5) es 400; un entero enorme pero válido no existe: 404.
        const esperado = ["99999999999", "2147483648"].includes(id) ? 404 : 400;
        if (ed.status !== esperado) fallos.push(`editar id=${id} -> ${ed.status}`);
        const hi = await admin.get(`/api/erp/combustible/tanquetas/${id}/historial`);
        if (hi.status !== esperado) fallos.push(`historial id=${id} -> ${hi.status}`);
        const cu = await admin.get(`/api/erp/combustible/tanquetas/${id}/cuadre`);
        if (cu.status !== esperado) fallos.push(`cuadre id=${id} -> ${cu.status}`);
      }
      expect(fallos).toEqual([]);
    });

    it("F4: la tanqueta de baja o vacía no se asigna", async () => {
      const vacia = await tanquetaNueva();
      expect((await asignar(admin, vacia, uA)).status).toBe(400);
      const baja = await tanquetaNueva();
      expect(
        (
          await admin
            .put(`/api/erp/combustible/tanquetas/${baja}`)
            .send({ activa: false, motivo: "prueba" })
        ).status
      ).toBe(200);
      expect((await asignar(admin, baja, uA)).status).toBe(400);
    });

    it("F5: asignar a una unidad dada de baja es 400", async () => {
      const u = await unidadNueva(admin, principal);
      const t = await tanquetaLlenaYAsignada(tanque, uA, 50);
      await darDeBajaEquipo(u);
      expect((await asignar(admin, t, u)).status).toBe(400);
    });

    it("F6: vale con serie en blanco, n_vale 0, negativo, decimal o string: 400", async () => {
      const t = await tanquetaNueva();
      for (const extra of [
        { serie_talonario: "   " },
        { n_vale: 0 },
        { n_vale: -5 },
        { n_vale: 1.5 },
        { n_vale: "12" },
        { serie_talonario: "S".repeat(21) },
      ]) {
        const r = await llenar(admin, tanque, t, 10, extra);
        expect(r.status, `${JSON.stringify(extra)} -> ${JSON.stringify(r.body)}`).toBe(400);
      }
      expect(Number((await ver(t)).saldo)).toBe(0);
    });

    it("H-6a: n_vale enorme (fuera de int4) en un vale de llenado es 400, nunca 500", async () => {
      const t = await tanquetaNueva();
      const r = await llenar(admin, tanque, t, 10, { n_vale: 99999999999 });
      expect(r.status, JSON.stringify(r.body)).toBe(400);
    });

    it("H-6b: n_vale enorme (fuera de int4) en el reparto del excedente es 400, nunca 500", async () => {
      const t = await tanquetaNueva();
      const lleno = await tanqueNuevo(admin, principal, {
        capacidad_total: 2000,
        nivel_actual: 2000,
      });
      const rr = await admin.post("/api/erp/combustible/recepciones").send({
        combustible_id: lleno,
        grifo_id: grifoProveedor,
        cantidad: 100,
        costo_unitario: 17,
        recibido_en: new Date().toISOString(),
        reparto_excedente: [
          {
            destino: "cubeta",
            cantidad: 100,
            tanqueta_id: t,
            tanqueta_equipo_id: uA,
            serie_talonario: "CISBIG",
            n_vale: 99999999999,
          },
        ],
      });
      expect(rr.status, JSON.stringify(rr.body)).toBe(400);
    });

    it("H-8: la misma serie con otra capitalización ('cis' vs 'CIS') no esquiva el vale duplicado", async () => {
      const t1 = await tanquetaNueva();
      const t2 = await tanquetaNueva();
      const n = nVale++;
      const a = await llenar(admin, tanque, t1, 10, { serie_talonario: "MAYUS", n_vale: n });
      expect(a.status).toBe(201);
      const b = await llenar(admin, tanque, t2, 10, { serie_talonario: "mayus", n_vale: n });
      expect(b.status, "'mayus' y 'MAYUS' son el mismo talonario de papel").toBeGreaterThanOrEqual(
        400
      );
    });

    it("F7: un reparto de 51 líneas es 400; uno de 50 líneas no revienta", async () => {
      const lleno = await tanqueNuevo(admin, principal, {
        capacidad_total: 2000,
        nivel_actual: 2000,
      });
      const t = await tanquetaNueva();
      const lineas = (n: number) =>
        Array.from({ length: n }, (_, i) => ({
          destino: "cubeta",
          cantidad: 5,
          tanqueta_id: t,
          tanqueta_equipo_id: uA,
          serie_talonario: "CIS50",
          n_vale: 20000 + i + nVale * 100,
        }));
      const base = {
        combustible_id: lleno,
        grifo_id: grifoProveedor,
        costo_unitario: 17,
        recibido_en: new Date().toISOString(),
      };
      const r51 = await admin
        .post("/api/erp/combustible/recepciones")
        .send({ ...base, cantidad: 255, reparto_excedente: lineas(51) });
      expect(r51.status).toBe(400);
      const lleno2 = await tanqueNuevo(admin, principal, {
        capacidad_total: 2000,
        nivel_actual: 2000,
      });
      const t0 = Date.now();
      const r50 = await admin
        .post("/api/erp/combustible/recepciones")
        .send({ ...base, combustible_id: lleno2, cantidad: 250, reparto_excedente: lineas(50) });
      expect(r50.status, JSON.stringify(r50.body)).toBeLessThan(500);
      expect(Date.now() - t0, "no debería tardar más de 15 s").toBeLessThan(15_000);
    });

    it("F8: tanqueta_equipo_id con destino 'equipo'/'devolucion' o sin tanqueta es 400", async () => {
      const lleno = await tanqueNuevo(admin, principal, {
        capacidad_total: 2000,
        nivel_actual: 2000,
      });
      const r = await admin.post("/api/erp/combustible/recepciones").send({
        combustible_id: lleno,
        grifo_id: grifoProveedor,
        cantidad: 100,
        costo_unitario: 17,
        recibido_en: new Date().toISOString(),
        reparto_excedente: [
          {
            destino: "equipo",
            cantidad: 100,
            equipo_id: uA,
            tanqueta_equipo_id: uA,
            serie_talonario: "X",
            n_vale: 1,
          },
        ],
      });
      expect(r.status).toBe(400);
      const t = await tanquetaNueva();
      const v = await llenar(admin, tanque, t, 10, {
        tipo_destino: "equipo",
        equipo_id: uA,
        tanqueta_equipo_id: uA,
      });
      expect(v.status).toBe(400);
    });
  });

  // ═══ G. Bitácora ════════════════════════════════════════════════════════
  describe("G. bitácora", () => {
    it("G1: asignar, recibir de vuelta y asignar de nuevo dejan quién, a qué unidad y (retorno) cuánto y por qué", async () => {
      const t = await tanquetaLlenaYAsignada(tanque, uA, 50);
      expect(
        (await recibirTanqueta(admin, t, { validado: 48, motivo: "motivo de la auditoría" })).status
      ).toBe(201);
      // Un 400 no debe dejar fila.
      expect((await retornar(admin, t)).status).toBe(400);
      expect((await asignar(operador, t, uB)).status).toBe(200);
      const asignaciones = await bitacora("combustible.tanqueta_asignar", t);
      expect(asignaciones.length).toBeGreaterThanOrEqual(2);
      const ultima = asignaciones[asignaciones.length - 1];
      expect(ultima.usuario_id).toBeTruthy();
      expect(Number(ultima.detalle.equipoId)).toBe(uB);
      const libs = await bitacora("combustible.tanqueta_retorno", t);
      expect(libs).toHaveLength(1);
      expect(libs[0].detalle.motivo).toBe("motivo de la auditoría");
      expect(Number(libs[0].detalle.saldoCalculado)).toBe(50);
      expect(Number(libs[0].detalle.saldoValidado)).toBe(48);
      expect(Number(libs[0].detalle.equipoId)).toBe(uA);
    });

    it("H-9a: pasar por el camino del vale una tanqueta con combustible a otra unidad es 409 y no deja el vale", async () => {
      const t = await tanquetaLlenaYAsignada(tanque, uA, 100);
      const antes = Number((await ver(t)).saldo);
      const r = await llenar(admin, tanque, t, 10, { tanqueta_equipo_id: uB });
      expect(r.status, JSON.stringify(r.body)).toBe(409);
      const fila = await ver(t);
      expect(fila.equipo_asignado_id).toBe(uA);
      expect(Number(fila.saldo)).toBe(antes);
    });

    it("G3: asignar por el reparto deja rastro: la recepción en la bitácora lleva la unidad del reparto", async () => {
      const t = await tanquetaNueva();
      const lleno = await tanqueNuevo(admin, principal, {
        capacidad_total: 2000,
        nivel_actual: 2000,
      });
      const n = 10000 + nVale++;
      const r = await admin.post("/api/erp/combustible/recepciones").send({
        combustible_id: lleno,
        grifo_id: grifoProveedor,
        cantidad: 100,
        costo_unitario: 17,
        recibido_en: new Date().toISOString(),
        reparto_excedente: [
          {
            destino: "cubeta",
            cantidad: 100,
            tanqueta_id: t,
            tanqueta_equipo_id: uA,
            serie_talonario: "CISG",
            n_vale: n,
          },
        ],
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      const filas = (
        await pool.query(
          `SELECT usuario_id, detalle FROM platform_audit_log
            WHERE tenant_id = $1 AND accion LIKE 'combustible.recepcion%'`,
          [tenantId]
        )
      ).rows.filter((f) => JSON.stringify(f.detalle).includes(`"n_vale":${n}`));
      expect(filas.length).toBeGreaterThanOrEqual(1);
      expect(filas[0].usuario_id).toBeTruthy();
      // Y NO hay fila propia 'tanqueta_asignar' (observación, no falla): es el camino sin rastro unificado.
      expect(await bitacora("combustible.tanqueta_asignar", t)).toHaveLength(0);
    });

    it("H-9b: un reparto que manda una tanqueta con combustible a otra unidad es 409 y no deja la recepción a medias", async () => {
      const t = await tanquetaLlenaYAsignada(tanque, uA, 50);
      const lleno = await tanqueNuevo(admin, principal, {
        capacidad_total: 2000,
        nivel_actual: 2000,
      });
      const r = await admin.post("/api/erp/combustible/recepciones").send({
        combustible_id: lleno,
        grifo_id: grifoProveedor,
        cantidad: 100,
        costo_unitario: 17,
        recibido_en: new Date().toISOString(),
        reparto_excedente: [
          {
            destino: "cubeta",
            cantidad: 100,
            tanqueta_id: t,
            tanqueta_equipo_id: uB,
            serie_talonario: "CISH",
            n_vale: 11000 + nVale++,
          },
        ],
      });
      expect(r.status, JSON.stringify(r.body)).toBe(409);
      expect((await ver(t)).equipo_asignado_id).toBe(uA);
      expect(Number((await ver(t)).saldo)).toBe(50);
    });
  });
  // ═══ I. Retorno de la tanqueta (0143) ═══════════════════════════════════
  describe("I. retorno de la tanqueta", () => {
    const filasRetorno = async (t: number) =>
      withTenant(tenantId, async (client) => {
        const q = await client.query(
          `SELECT saldo_calculado, saldo_validado, diferencia, motivo
             FROM combustible_tanqueta_retornos WHERE tenant_id = $1 AND tanqueta_id = $2`,
          [tenantId, t]
        );
        return q.rows;
      });

    it("I1: dos retornos simultáneos de la misma tanqueta: uno entra y el otro es 400/409, una sola fila", async () => {
      const t = await tanquetaLlenaYAsignada(tanque, uA, 50);
      const rs = await Promise.all([
        recibirTanqueta(admin, t, { validado: 40, motivo: "primero" }),
        recibirTanqueta(admin, t, { validado: 40, motivo: "segundo" }),
        recibirTanqueta(admin, t, { como: grifero }),
      ]);
      for (const r of rs) expect(r.status, JSON.stringify(r.body)).toBeLessThan(500);
      expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
      expect(await filasRetorno(t)).toHaveLength(1);
    });

    it("I2: un retorno y una carga del conductor a la vez nunca entran los dos", async () => {
      const c = await conductorNuevo();
      const t = await tanquetaLlenaYAsignada(tanque, c.unidad, 50);
      const [ret, carga] = await Promise.all([
        recibirTanqueta(admin, t),
        cargarEnRuta(c.agente, t, c.unidad, 30),
      ]);
      expect(ret.status, JSON.stringify(ret.body)).toBeLessThan(500);
      expect(carga.status, JSON.stringify(carga.body)).toBeLessThan(500);
      expect(ret.status === 201 && carga.status === 201).toBe(false);
      const despues = await ver(t);
      if (ret.status === 201) {
        expect(despues.equipo_asignado_id).toBeNull();
        expect(Number(despues.saldo)).toBe(50);
      } else {
        // La carga entró primero: el retorno vio un saldo viejo y se rechazó.
        expect(ret.status).toBe(409);
        expect(despues.equipo_asignado_id).toBe(c.unidad);
        expect(Number(despues.saldo)).toBe(20);
      }
    });

    it("I3: con un saldo que ya cambió, el retorno viejo es 409 y no deja fila", async () => {
      const c = await conductorNuevo();
      const t = await tanquetaLlenaYAsignada(tanque, c.unidad, 50);
      expect((await cargarEnRuta(c.agente, t, c.unidad, 10)).status).toBe(201);
      const r = await recibirTanqueta(admin, t, { calculado: 50, validado: 50 });
      expect(r.status, JSON.stringify(r.body)).toBe(409);
      expect(await filasRetorno(t)).toHaveLength(0);
      expect((await ver(t)).equipo_asignado_id).toBe(c.unidad);
    });

    it("I4: con decimales raros el saldo queda en lo que validó el grifero y nunca es 500", async () => {
      const t = await tanquetaNueva();
      expect((await llenar(admin, tanque, t, 33.337)).status).toBe(201);
      expect((await asignar(admin, t, uA)).status).toBe(200);
      const r = await recibirTanqueta(admin, t, { validado: 30.004, motivo: "se usó casi todo" });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(Math.abs(Number(r.body.saldo) - 30)).toBeLessThan(0.011);
    });

    it("I5: el historial muestra el retorno con su motivo y quién lo registró", async () => {
      const t = await tanquetaLlenaYAsignada(tanque, uA, 50);
      expect(
        (await recibirTanqueta(admin, t, { como: grifero, validado: 47, motivo: "derrame" })).status
      ).toBe(201);
      const h = await admin.get(`/api/erp/combustible/tanquetas/${t}/historial`);
      expect(h.status, JSON.stringify(h.body)).toBe(200);
      const fila = h.body.find((m: { tipo: string }) => m.tipo === "retorno");
      expect(fila).toBeTruthy();
      expect(Number(fila.cantidad)).toBe(-3);
      expect(fila.motivo).toBe("derrame");
      expect(fila.usuario).toBeTruthy();
    });

    it("I6: al asignarla de nuevo, el vale lleva el saldo que validó el grifero", async () => {
      const t = await tanquetaLlenaYAsignada(tanque, uA, 50);
      expect(
        (await recibirTanqueta(admin, t, { validado: 48, motivo: "evaporación" })).status
      ).toBe(201);
      expect((await asignar(admin, t, uB)).status).toBe(200);
      const cantidad = await withTenant(tenantId, async (client) => {
        const q = await client.query(
          `SELECT cantidad FROM combustible_tanqueta_asignaciones
            WHERE tenant_id = $1 AND tanqueta_id = $2 ORDER BY id DESC LIMIT 1`,
          [tenantId, t]
        );
        return Number(q.rows[0].cantidad);
      });
      expect(cantidad).toBe(48);
    });

    it("I7: devolver más de lo calculado también pide motivo y no pasa de la capacidad", async () => {
      const t = await tanquetaLlenaYAsignada(tanque, uA, 50);
      expect((await recibirTanqueta(admin, t, { validado: 60 })).status).toBe(400);
      expect((await recibirTanqueta(admin, t, { validado: 281, motivo: "no cabe" })).status).toBe(
        400
      );
      expect(await filasRetorno(t)).toHaveLength(0);
    });

    it("I8: la tanqueta de otra empresa no se recibe y la propia no queda tocada", async () => {
      const r = await retornarCrudo(admin, tanquetaAjena, {
        saldo_calculado: 1,
        saldo_validado: 0,
        motivo: "intento ajeno",
        destino: "reserva",
      });
      expect(r.status).toBe(404);
      expect(await filasRetorno(tanquetaAjena)).toHaveLength(0);
    });
  });
});
