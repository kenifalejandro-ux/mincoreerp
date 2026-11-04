/** tests/combustible-compras-cisterna.test.ts
 *
 * La compra de una cisterna, antes de que llegue (migración 0171): la encargada la registra, la
 * habilita a la cancha o la anula. La cancha solo ve las que ya están por llegar y de su sede.
 *
 * Método de siempre: cada ataque con su gemelo (el mismo pedido que sí debe funcionar), y otra
 * empresa para el aislamiento.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, pool } from "../src/server/config/database";

const BASE = "/api/erp/combustible";
const password = "ClaveDePrueba123";

type Agente = ReturnType<typeof request.agent>;

interface Compra {
  id: string;
  cliente_uuid: string;
  grifo_interno_id: number;
  proveedor: string;
  numero_documento: string;
  estado: "registrada" | "por_llegar" | "anulada";
  cantidad_facturada: string;
  motivo_anulacion: string | null;
}

const enDias = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

describe("combustible: compras de cisterna", () => {
  let tenantId: string;
  let otroTenantId: string;
  let slug: string;
  const admin = request.agent(app);
  const otraEmpresa = request.agent(app);
  let proveedor: number;
  let nombreProveedor: string;
  let grifoA: number;
  let grifoB: number;
  let seq = 0;

  async function persona(rol: string) {
    const agente = request.agent(app);
    const dni = String(88600000 + Math.floor(Math.random() * 800000) + seq++);
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre: `Persona ${rol}`, dni, password, rol });
    expect(alta.status).toBe(201);
    const entrar = () =>
      agente.post("/api/auth/login").send({ tenantSlug: slug, identificador: dni, password });
    expect((await entrar()).status).toBe(200);
    return { agente, id: alta.body.id as string, entrar };
  }

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    slug = c.tenant.slug;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: slug, email: c.usuario.email, password });
    nombreProveedor = idUnico("PROV");
    proveedor = (await admin.post(`${BASE}/grifos`).send({ nombre: nombreProveedor })).body.id;
    const sedes = (await admin.get("/api/erp/sedes")).body.sedes;
    grifoA = sedes[0].grifos[0].id;
    grifoB = (
      await admin
        .post("/api/erp/administracion/grifos")
        .send({ sede_id: sedes[0].id, nombre: "Grifo B" })
    ).body.id;

    const o = await crearTenantDePrueba(password);
    otroTenantId = o.tenant.id;
    await otraEmpresa
      .post("/api/auth/login")
      .send({ tenantSlug: o.tenant.slug, email: o.usuario.email, password });
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await borrarTenantDePrueba(otroTenantId);
    await closeDatabase();
  });

  let documento = 0;
  const cuerpo = (extra: Record<string, unknown> = {}) => ({
    grifo_interno_id: grifoA,
    grifo_id: proveedor,
    tipo_combustible: "diesel_b5",
    tipo_documento: "factura",
    numero_documento: `F001-${++documento}`,
    fecha_compra: enDias(0),
    llegada_estimada: enDias(5),
    cantidad_facturada: 12000,
    costo_unitario: 16.5,
    ...extra,
  });

  async function registrar(extra: Record<string, unknown> = {}, ag: Agente = admin) {
    const r = await ag.post(`${BASE}/compras-cisterna`).send(cuerpo(extra));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body as Compra;
  }

  const lista = async (ag: Agente): Promise<Compra[]> => {
    const r = await ag.get(`${BASE}/compras-cisterna`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body;
  };
  const de = (l: Compra[], id: string) => l.find((c) => c.id === id);

  it("registra una compra con su proveedor, factura y cantidad: queda registrada", async () => {
    const c = await registrar({ placa: "ABC-123", chofer: "Juan Pérez" });
    expect(c.estado).toBe("registrada");
    expect(c.proveedor).toBe(nombreProveedor);
    expect(Number(c.cantidad_facturada)).toBe(12000);
    expect(de(await lista(admin), c.id)).toBeDefined();
  });

  it("el estado por_llegar llega solo el día estimado, sin que nadie haga nada", async () => {
    const hoy = await registrar({ llegada_estimada: enDias(0) });
    const futura = await registrar({ llegada_estimada: enDias(3) });
    expect(hoy.estado).toBe("por_llegar");
    expect(futura.estado).toBe("registrada");
  });

  it("habilitar la pasa a por_llegar, y repetirlo no falla ni cambia quién la habilitó", async () => {
    const c = await registrar({ llegada_estimada: enDias(7) });
    const h = await admin.patch(`${BASE}/compras-cisterna/${c.id}/habilitar`);
    expect(h.status, JSON.stringify(h.body)).toBe(200);
    expect(h.body.estado).toBe("por_llegar");
    const antes = h.body.habilitada_en;
    const otra = await admin.patch(`${BASE}/compras-cisterna/${c.id}/habilitar`);
    expect(otra.status).toBe(200);
    expect(otra.body.habilitada_en).toBe(antes);
  });

  it("anular pide motivo, la deja anulada con su motivo y ya no se puede habilitar", async () => {
    const c = await registrar();
    const sinMotivo = await admin.patch(`${BASE}/compras-cisterna/${c.id}/anular`).send({});
    expect(sinMotivo.status).toBe(400);
    const a = await admin
      .patch(`${BASE}/compras-cisterna/${c.id}/anular`)
      .send({ motivo: "factura mal digitada" });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body.estado).toBe("anulada");
    expect(a.body.motivo_anulacion).toBe("factura mal digitada");
    expect((await admin.patch(`${BASE}/compras-cisterna/${c.id}/habilitar`)).status).toBe(409);
    expect(
      (await admin.patch(`${BASE}/compras-cisterna/${c.id}/anular`).send({ motivo: "otra vez" }))
        .status
    ).toBe(409);
  });

  it("la misma factura del mismo proveedor no se registra dos veces; anulada, sí", async () => {
    const c = await registrar({ numero_documento: "F777-1" });
    const repetida = await admin
      .post(`${BASE}/compras-cisterna`)
      .send(cuerpo({ numero_documento: "f777-1" }));
    expect(repetida.status, JSON.stringify(repetida.body)).toBe(409);
    await admin.patch(`${BASE}/compras-cisterna/${c.id}/anular`).send({ motivo: "error" });
    const denuevo = await admin
      .post(`${BASE}/compras-cisterna`)
      .send(cuerpo({ numero_documento: "F777-1" }));
    expect(denuevo.status, JSON.stringify(denuevo.body)).toBe(201);
  });

  it("un reintento con el mismo cliente_uuid devuelve la compra guardada sin crear otra", async () => {
    const uuid = randomUUID();
    const datos = cuerpo({ cliente_uuid: uuid });
    const primera = await admin.post(`${BASE}/compras-cisterna`).send(datos);
    expect(primera.status, JSON.stringify(primera.body)).toBe(201);
    const reintento = await admin.post(`${BASE}/compras-cisterna`).send(datos);
    expect(reintento.status, JSON.stringify(reintento.body)).toBe(200);
    expect(reintento.body.id).toBe(primera.body.id);
    const filas = (await lista(admin)).filter((c) => c.cliente_uuid === uuid);
    expect(filas).toHaveLength(1);
  });

  it("datos que no valen: 400 y no 500", async () => {
    const malos: Record<string, unknown>[] = [
      { cantidad_facturada: 0 },
      { cantidad_facturada: -5 },
      { costo_unitario: 0 },
      { numero_documento: "   " },
      { fecha_compra: "04-11-2026" },
      { llegada_estimada: enDias(-3) },
      { tipo_combustible: "agua" },
      { tipo_documento: "boleta" },
    ];
    for (const extra of malos) {
      const r = await admin.post(`${BASE}/compras-cisterna`).send(cuerpo(extra));
      expect(r.status, JSON.stringify(extra)).toBe(400);
    }
    // El gemelo: sin ninguno de esos defectos, el mismo pedido sí entra.
    expect((await admin.post(`${BASE}/compras-cisterna`).send(cuerpo())).status).toBe(201);
  });

  it("el proveedor tiene que existir, estar activo y ser de tanque", async () => {
    const soloRuta = (
      await admin
        .post(`${BASE}/grifos`)
        .send({ nombre: idUnico("RUTA"), abastece_tanque: false, abastece_ruta: true })
    ).body.id;
    const r1 = await admin.post(`${BASE}/compras-cisterna`).send(cuerpo({ grifo_id: soloRuta }));
    expect(r1.status, JSON.stringify(r1.body)).toBe(400);
    const r2 = await admin.post(`${BASE}/compras-cisterna`).send(cuerpo({ grifo_id: 99999999 }));
    expect(r2.status).toBe(400);
    const inactivo = (await admin.post(`${BASE}/grifos`).send({ nombre: idUnico("OFF") })).body.id;
    await admin.put(`${BASE}/grifos/${inactivo}`).send({
      nombre: idUnico("OFF"),
      activo: false,
      abastece_ruta: true,
      abastece_tanque: true,
      abastece_urea: false,
      abastece_urea_ruta: false,
    });
    const r3 = await admin.post(`${BASE}/compras-cisterna`).send(cuerpo({ grifo_id: inactivo }));
    expect(r3.status, JSON.stringify(r3.body)).toBe(400);
  });

  it("otra empresa no ve ni toca las compras de esta", async () => {
    const c = await registrar();
    expect(de(await lista(otraEmpresa), c.id)).toBeUndefined();
    expect((await otraEmpresa.patch(`${BASE}/compras-cisterna/${c.id}/habilitar`)).status).toBe(
      404
    );
    expect(
      (
        await otraEmpresa
          .patch(`${BASE}/compras-cisterna/${c.id}/anular`)
          .send({ motivo: "intruso" })
      ).status
    ).toBe(404);
    // Y la fila sigue intacta para su dueña.
    expect(de(await lista(admin), c.id)!.estado).not.toBe("anulada");
    // Una compra con el grifo o el proveedor de OTRA empresa tampoco entra.
    const ajeno = (await otraEmpresa.get("/api/erp/sedes")).body.sedes[0].grifos[0].id;
    const r = await admin
      .post(`${BASE}/compras-cisterna`)
      .send(cuerpo({ grifo_interno_id: ajeno }));
    expect([400, 404], JSON.stringify(r.body)).toContain(r.status);
  });

  describe("la cancha", () => {
    it("el grifero ve solo las compras por llegar, no las registradas ni las anuladas", async () => {
      const grifero = await persona("grifero");
      const registrada = await registrar({ llegada_estimada: enDias(9) });
      const hoy = await registrar({ llegada_estimada: enDias(0) });
      const habilitada = await registrar({ llegada_estimada: enDias(9) });
      await admin.patch(`${BASE}/compras-cisterna/${habilitada.id}/habilitar`);
      const anulada = await registrar({ llegada_estimada: enDias(0) });
      await admin.patch(`${BASE}/compras-cisterna/${anulada.id}/anular`).send({ motivo: "error" });

      const vistas = await lista(grifero.agente);
      expect(de(vistas, hoy.id)?.estado).toBe("por_llegar");
      expect(de(vistas, habilitada.id)?.estado).toBe("por_llegar");
      expect(de(vistas, registrada.id)).toBeUndefined();
      expect(de(vistas, anulada.id)).toBeUndefined();
      // El gemelo: quien gestiona sí ve las cuatro.
      const todas = await lista(admin);
      for (const c of [registrada, hoy, habilitada, anulada]) expect(de(todas, c.id)).toBeDefined();
    });

    it("el grifero no puede registrar, habilitar ni anular compras", async () => {
      const grifero = await persona("grifero");
      const c = await registrar();
      const crear = await grifero.agente.post(`${BASE}/compras-cisterna`).send(cuerpo());
      expect(crear.status).toBe(403);
      expect(
        (await grifero.agente.patch(`${BASE}/compras-cisterna/${c.id}/habilitar`)).status
      ).toBe(403);
      expect(
        (
          await grifero.agente
            .patch(`${BASE}/compras-cisterna/${c.id}/anular`)
            .send({ motivo: "x" })
        ).status
      ).toBe(403);
      expect(de(await lista(admin), c.id)!.estado).not.toBe("anulada");
    });

    it("el operador no gestiona compras por defecto; con el permiso, sí", async () => {
      const operador = await persona("operador");
      expect((await operador.agente.post(`${BASE}/compras-cisterna`).send(cuerpo())).status).toBe(
        403
      );
      const actuales = (await admin.get(`/api/erp/usuarios/${operador.id}/permisos`)).body;
      const dar = await admin.put(`/api/erp/usuarios/${operador.id}/permisos`).send({
        modulos: actuales.modulos.map(
          (m: { modulo: string; asignado: boolean; nivel: string }) => ({
            modulo: m.modulo,
            asignado: m.asignado,
            nivel: m.nivel,
          })
        ),
        pestanas: [
          { modulo: "combustible", pestana: "cisternas:registrar_compra", permitido: true },
        ],
        motivo: "Encargada de compras",
      });
      expect(dar.status, JSON.stringify(dar.body)).toBe(200);
      await operador.entrar();
      const ok = await operador.agente.post(`${BASE}/compras-cisterna`).send(cuerpo());
      expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    });

    it("Lectura ve la lista de compras por llegar pero no puede registrar", async () => {
      const lectura = await persona("lectura");
      const hoy = await registrar({ llegada_estimada: enDias(0) });
      expect(de(await lista(lectura.agente), hoy.id)).toBeDefined();
      expect((await lectura.agente.post(`${BASE}/compras-cisterna`).send(cuerpo())).status).toBe(
        403
      );
    });

    it("el alcance por sede: el grifero de otro grifo no ve la compra, ni puede registrarla ahí", async () => {
      const grifero = await persona("grifero");
      const r = await admin.put(`/api/erp/usuarios/${grifero.id}/permisos`).send({
        modulos: [],
        alcanceCombustible: { todo: false, sedes: [], grifos: [grifoB], surtidores: [] },
        motivo: "Asignar grifo B",
      });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      await grifero.entrar();

      const enA = await registrar({ grifo_interno_id: grifoA, llegada_estimada: enDias(0) });
      const enB = await registrar({ grifo_interno_id: grifoB, llegada_estimada: enDias(0) });
      const vistas = await lista(grifero.agente);
      expect(de(vistas, enB.id)).toBeDefined();
      expect(de(vistas, enA.id)).toBeUndefined();
    });
  });

  it("la compra queda aislada por RLS: sin el contexto de la empresa no se ve ninguna", async () => {
    await registrar();
    const cliente = await pool.connect();
    try {
      await cliente.query("BEGIN");
      await cliente.query("SELECT set_config('app.tenant_id', $1, true)", [otroTenantId]);
      const r = await cliente.query(
        "SELECT count(*)::int AS n FROM combustible_compras_cisterna WHERE tenant_id = $1",
        [tenantId]
      );
      expect(r.rows[0].n).toBe(0);
      await cliente.query("ROLLBACK");
    } finally {
      cliente.release();
    }
  });
});
