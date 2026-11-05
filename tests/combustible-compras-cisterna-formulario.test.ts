/** tests/combustible-compras-cisterna-formulario.test.ts
 *
 * Lo que sirve al formulario "Registrar compra" (migración 0174): el transportista y su RUC en la
 * compra, y GET /compras-cisterna/formulario con los proveedores de tanque, las sedes del alcance y
 * el precio de compra vigente de cada proveedor.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  app,
  cargarPrecioCombustible,
  crearTenantDePrueba,
  borrarTenantDePrueba,
  idUnico,
} from "./helpers";
import { closeDatabase } from "../src/server/config/database";

const BASE = "/api/erp/combustible";
const password = "ClaveDePrueba123";

interface DatosFormulario {
  proveedores: { id: number; nombre: string }[];
  sedes: { id: number; nombre: string; sede: string }[];
  precios: { grifo_id: number; tipo_combustible: string; precio_unitario: string }[];
}

const enDias = (n: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(
    new Date(Date.now() + n * 86_400_000)
  );

describe("combustible: formulario de compras de cisterna", () => {
  let tenantId: string;
  let slug: string;
  const admin = request.agent(app);
  let proveedor: number;
  let nombreProveedor: string;
  let grifoA: number;
  let grifoB: number;
  let seq = 0;
  let documento = 0;

  async function persona(rol: string) {
    const agente = request.agent(app);
    const dni = String(88800000 + Math.floor(Math.random() * 800000) + seq++);
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
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  const cuerpo = (extra: Record<string, unknown> = {}) => ({
    grifo_interno_id: grifoA,
    grifo_id: proveedor,
    tipo_combustible: "diesel_b5",
    tipo_documento: "guia_remision",
    numero_documento: `TRR1-${++documento}`,
    fecha_compra: enDias(0),
    llegada_estimada: enDias(3),
    cantidad_facturada: 11100,
    costo_unitario: 24.5,
    ...extra,
  });

  const formulario = async (ag = admin) => {
    const r = await ag.get(`${BASE}/compras-cisterna/formulario`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body as DatosFormulario;
  };

  describe("el transportista", () => {
    it("se guarda con su RUC y vuelve en la compra", async () => {
      const r = await admin
        .post(`${BASE}/compras-cisterna`)
        .send(
          cuerpo({ transportista: "CORPORACION KIME S.A.C.", transportista_ruc: "20602504655" })
        );
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body.transportista).toBe("CORPORACION KIME S.A.C.");
      expect(r.body.transportista_ruc).toBe("20602504655");
      const lista = (await admin.get(`${BASE}/compras-cisterna`)).body as {
        id: string;
        transportista: string | null;
      }[];
      expect(lista.find((c) => c.id === r.body.id)?.transportista).toBe("CORPORACION KIME S.A.C.");
    });

    it("es opcional: sin él, la compra se registra y queda vacío", async () => {
      const r = await admin.post(`${BASE}/compras-cisterna`).send(cuerpo());
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body.transportista).toBeNull();
      expect(r.body.transportista_ruc).toBeNull();
    });

    it("un RUC mal formado es 400, y un RUC sin nombre también; su gemelo válido entra", async () => {
      for (const malo of ["123", "2060250465A", "206025046555"]) {
        const r = await admin
          .post(`${BASE}/compras-cisterna`)
          .send(cuerpo({ transportista: "KIME", transportista_ruc: malo }));
        expect(r.status, malo).toBe(400);
      }
      const sinNombre = await admin
        .post(`${BASE}/compras-cisterna`)
        .send(cuerpo({ transportista_ruc: "20602504655" }));
      expect(sinNombre.status, JSON.stringify(sinNombre.body)).toBe(400);
      const bien = await admin
        .post(`${BASE}/compras-cisterna`)
        .send(cuerpo({ transportista: "KIME", transportista_ruc: "20602504655" }));
      expect(bien.status, JSON.stringify(bien.body)).toBe(201);
    });

    it("un nombre sin RUC, o con el RUC vacío, se acepta", async () => {
      const r = await admin
        .post(`${BASE}/compras-cisterna`)
        .send(cuerpo({ transportista: "KIME", transportista_ruc: "" }));
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body.transportista_ruc).toBeNull();
    });
  });

  describe("GET /compras-cisterna/formulario", () => {
    it("trae los proveedores de tanque activos, y no los de solo ruta ni los desactivados", async () => {
      const soloRuta = (
        await admin
          .post(`${BASE}/grifos`)
          .send({ nombre: idUnico("RUTA"), abastece_tanque: false, abastece_ruta: true })
      ).body;
      const inactivo = (await admin.post(`${BASE}/grifos`).send({ nombre: idUnico("OFF") })).body;
      await admin.put(`${BASE}/grifos/${inactivo.id}`).send({
        nombre: inactivo.nombre,
        activo: false,
        abastece_ruta: true,
        abastece_tanque: true,
        abastece_urea: false,
        abastece_urea_ruta: false,
      });
      const d = await formulario();
      const ids = d.proveedores.map((p) => p.id);
      expect(ids).toContain(proveedor);
      expect(ids).not.toContain(soloRuta.id);
      expect(ids).not.toContain(inactivo.id);
    });

    it("trae las sedes del alcance: un grifero asignado a un solo grifo no ve los demás", async () => {
      const todas = await formulario();
      expect(todas.sedes.map((s) => s.id)).toEqual(expect.arrayContaining([grifoA, grifoB]));
      // El formulario es de quien gestiona compras: un operador con ese permiso, acotado a B.
      const operador = await persona("operador");
      const actuales = (await admin.get(`/api/erp/usuarios/${operador.id}/permisos`)).body;
      const r = await admin.put(`/api/erp/usuarios/${operador.id}/permisos`).send({
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
        alcanceCombustible: { todo: false, sedes: [], grifos: [grifoB], surtidores: [] },
        motivo: "Encargada de la sede B",
      });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      await operador.entrar();
      const acotado = await formulario(operador.agente);
      expect(acotado.sedes.map((s) => s.id)).toEqual([grifoB]);
    });

    it("el precio es el vigente de HOY: el más reciente que ya rige, no el futuro ni el anulado", async () => {
      const pr = (await admin.post(`${BASE}/grifos`).send({ nombre: idUnico("PRECIO") })).body.id;
      const ayer = new Date(Date.now() - 86_400_000).toISOString();
      const antes = new Date(Date.now() - 5 * 86_400_000).toISOString();
      const manana = new Date(Date.now() + 86_400_000).toISOString();
      const vigente = await cargarPrecioCombustible(admin, {
        tipo_combustible: "diesel_b5",
        grifo_id: pr,
        precio_unitario: 24.4,
        vigente_desde: antes,
      });
      expect(vigente.status, JSON.stringify(vigente.body)).toBe(201);
      const nuevo = await cargarPrecioCombustible(admin, {
        tipo_combustible: "diesel_b5",
        grifo_id: pr,
        precio_unitario: 25.1,
        vigente_desde: ayer,
      });
      expect(nuevo.status).toBe(201);
      const futuro = await cargarPrecioCombustible(admin, {
        tipo_combustible: "diesel_b5",
        grifo_id: pr,
        precio_unitario: 99,
        vigente_desde: manana,
      });
      expect(futuro.status, JSON.stringify(futuro.body)).toBe(201);
      const d = await formulario();
      const filas = d.precios.filter(
        (p) => p.grifo_id === pr && p.tipo_combustible === "diesel_b5"
      );
      expect(filas).toHaveLength(1);
      expect(Number(filas[0].precio_unitario)).toBe(25.1);

      // Anulado el más reciente, rige el anterior.
      const anula = await admin
        .patch(`${BASE}/precios/${nuevo.body.id}/anular`)
        .send({ motivo: "se tipeó mal" });
      expect(anula.status, JSON.stringify(anula.body)).toBe(200);
      const despues = await formulario();
      const f2 = despues.precios.filter(
        (p) => p.grifo_id === pr && p.tipo_combustible === "diesel_b5"
      );
      expect(Number(f2[0].precio_unitario)).toBe(24.4);
    });

    it("solo para quien gestiona compras: el grifero y Lectura no lo ven, otra empresa no ve los datos de esta", async () => {
      const grifero = await persona("grifero");
      const lectura = await persona("lectura");
      expect((await grifero.agente.get(`${BASE}/compras-cisterna/formulario`)).status).toBe(403);
      expect((await lectura.agente.get(`${BASE}/compras-cisterna/formulario`)).status).toBe(403);

      const otra = request.agent(app);
      const o = await crearTenantDePrueba(password);
      try {
        await otra
          .post("/api/auth/login")
          .send({ tenantSlug: o.tenant.slug, email: o.usuario.email, password });
        const suyo = await formulario(otra);
        expect(suyo.proveedores.map((p) => p.id)).not.toContain(proveedor);
        expect(suyo.sedes.map((s) => s.id)).not.toContain(grifoA);
      } finally {
        await borrarTenantDePrueba(o.tenant.id);
      }
    });
  });
});
