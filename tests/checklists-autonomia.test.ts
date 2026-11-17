/** tests/checklists-autonomia.test.ts
 *
 * Checklists funciona solo. La unidad es de OTRO módulo (Flota) y es opcional: el checklist se
 * identifica por la unidad, por un texto libre («Horno 4») o por las dos (migración 0189). Sin
 * Flota no se lee la tabla `equipos`: no hay 403 ni pantalla rota, solo se omite esa parte. Lo que
 * se fija:
 *
 * 1. Una empresa con SOLO Checklists llena, lista y abre checklists por texto, sin acceso a Flota.
 * 2. Sin unidad ni texto → 400 (no 500); un texto de puros espacios cuenta como vacío.
 * 3. Sin Flota, mandar `equipo_id` → 400 (se rechaza, no se ignora en silencio).
 * 4. El reintento por `cliente_uuid` no duplica, tampoco cuando el checklist es solo de texto.
 * 5. Con Flota la unidad sigue funcionando; el texto es opcional y puede ir junto con ella.
 * 6. Una empresa que PIERDE Flota deja de ver la placa de los checklists viejos (la fila conserva
 *    la unidad); si el módulo vuelve, reaparece.
 * 7. La base misma rechaza un checklist sin unidad y sin texto (CHECK de la migración 0189).
 */
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";
import { env } from "../src/server/config/env";
import { MODULOS } from "../src/modules/registry";

const BEARER = `Bearer ${env.platformAdminToken}`;
const PASSWORD = "ClaveDePrueba123";

type Empresa = Awaited<ReturnType<typeof crearTenantDePrueba>>;

describe("Checklists: autonomía de la unidad", () => {
  const empresas: Empresa[] = [];

  /** Una empresa con exactamente esos módulos habilitados. */
  const nueva = async (modulos: string[]) => {
    const e = await crearTenantDePrueba(PASSWORD);
    empresas.push(e);
    await ponerModulos(e, modulos);
    return e;
  };
  const ponerModulos = async (e: Empresa, modulos: string[]) => {
    const r = await request(app)
      .put(`/api/platform/tenants/${e.tenant.id}/modulos`)
      .set("Authorization", BEARER)
      .send({
        configuraciones: MODULOS.map((m) => ({
          modulo: m.id,
          estado: modulos.includes(m.id) ? "habilitado" : "deshabilitado",
        })),
      });
    expect(r.status).toBe(200);
  };
  // Los módulos del usuario viajan en el JWT: tras cambiarlos hay que entrar de nuevo.
  const sesion = async (e: Empresa) => {
    const agente = request.agent(app);
    const res = await agente
      .post("/api/auth/login")
      .send({ tenantSlug: e.tenant.slug, email: e.usuario.email, password: PASSWORD });
    expect(res.status).toBe(200);
    return agente;
  };
  type Agente = Awaited<ReturnType<typeof sesion>>;

  const plantilla = async (admin: Agente) => {
    const r = await admin.post("/api/erp/checklists/plantillas").send({
      nombre: idUnico("Pre-uso"),
      items: [{ descripcion: "Frenos" }, { descripcion: "Luces" }],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return Number(r.body.id);
  };
  const items = (estado: "bien" | "malo" = "bien") => [
    { descripcion: "Frenos", estado },
    { descripcion: "Luces", estado: "bien" as const },
  ];
  const listado = async (admin: Agente) => {
    const r = await admin.get("/api/erp/checklists?pageSize=100");
    expect(r.status).toBe(200);
    return r.body.data as {
      id: number;
      equipo_id: number | null;
      placa_codigo: string | null;
      activo_texto: string | null;
      resultado: string;
    }[];
  };

  afterAll(async () => {
    for (const e of empresas) await borrarTenantDePrueba(e.tenant.id);
    await closeDatabase();
  });

  it("una empresa con SOLO Checklists llena, lista y abre checklists por texto, sin tocar Flota", async () => {
    const e = await nueva(["checklists"]);
    const admin = await sesion(e);
    // De verdad es solo Checklists.
    expect((await admin.get("/api/erp/equipos")).status).toBe(403);

    const plantillaId = await plantilla(admin);
    const creado = await admin.post("/api/erp/checklists").send({
      plantilla_id: plantillaId,
      activo_texto: "Horno 4",
      items: items(),
    });
    expect(creado.status, JSON.stringify(creado.body)).toBe(201);
    expect(creado.body.equipo_id).toBeNull();
    expect(creado.body.activo_texto).toBe("Horno 4");
    expect(creado.body.resultado).toBe("bien");

    const filas = await listado(admin);
    const mia = filas.find((c) => c.id === creado.body.id);
    expect(mia).toMatchObject({ equipo_id: null, placa_codigo: null, activo_texto: "Horno 4" });

    const detalle = await admin.get(`/api/erp/checklists/${creado.body.id}`);
    expect(detalle.status).toBe(200);
    expect(detalle.body).toMatchObject({ placa_codigo: null, activo_texto: "Horno 4" });
    expect(detalle.body.items).toHaveLength(2);

    // El resultado "observado" no depende de que haya unidad.
    const malo = await admin.post("/api/erp/checklists").send({
      plantilla_id: plantillaId,
      activo_texto: "Andamio torre 3",
      items: items("malo"),
    });
    expect(malo.status).toBe(201);
    expect(malo.body.resultado).toBe("observado");
  });

  it("sin unidad ni texto responde 400, y un texto de puros espacios cuenta como vacío", async () => {
    const e = await nueva(["checklists"]);
    const admin = await sesion(e);
    const plantillaId = await plantilla(admin);

    const nada = await admin
      .post("/api/erp/checklists")
      .send({ plantilla_id: plantillaId, items: items() });
    expect(nada.status).toBe(400);

    const espacios = await admin
      .post("/api/erp/checklists")
      .send({ plantilla_id: plantillaId, activo_texto: "   ", items: items() });
    expect(espacios.status).toBe(400);

    // Texto demasiado largo: 400, no 500 por el VARCHAR(150).
    const largo = await admin
      .post("/api/erp/checklists")
      .send({ plantilla_id: plantillaId, activo_texto: "x".repeat(151), items: items() });
    expect(largo.status).toBe(400);
  });

  it("sin Flota, mandar equipo_id se rechaza con un 400 claro y no se crea nada", async () => {
    const e = await nueva(["checklists"]);
    const admin = await sesion(e);
    const plantillaId = await plantilla(admin);

    const r = await admin
      .post("/api/erp/checklists")
      .send({ plantilla_id: plantillaId, equipo_id: 1, activo_texto: "Horno 4", items: items() });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/Registro de unidades/);
    expect(await listado(admin)).toHaveLength(0);
  });

  it("el reintento con el mismo cliente_uuid no duplica, tampoco en un checklist solo de texto", async () => {
    const e = await nueva(["checklists"]);
    const admin = await sesion(e);
    const plantillaId = await plantilla(admin);
    const cuerpo = {
      cliente_uuid: crypto.randomUUID(),
      plantilla_id: plantillaId,
      activo_texto: "Compresor 2",
      items: items(),
    };

    const primero = await admin.post("/api/erp/checklists").send(cuerpo);
    expect(primero.status).toBe(201);
    const reintento = await admin.post("/api/erp/checklists").send(cuerpo);
    expect(reintento.status).toBe(200);
    expect(reintento.body.id).toBe(primero.body.id);
    expect(reintento.body.activo_texto).toBe("Compresor 2");
    expect(await listado(admin)).toHaveLength(1);
  });

  it("con Flota la unidad sigue funcionando, y puede ir sola, con texto, o el texto solo", async () => {
    const e = await nueva(["flota", "checklists"]);
    const admin = await sesion(e);
    const placa = idUnico("CK");
    const equipo = await admin
      .post("/api/erp/equipos")
      .send({ placa_codigo: placa, tipo: "Volquete" });
    expect(equipo.status, JSON.stringify(equipo.body)).toBe(201);
    const equipoId = Number(equipo.body.id);
    const plantillaId = await plantilla(admin);

    const soloUnidad = await admin
      .post("/api/erp/checklists")
      .send({ plantilla_id: plantillaId, equipo_id: equipoId, items: items() });
    expect(soloUnidad.status, JSON.stringify(soloUnidad.body)).toBe(201);

    const unidadYTexto = await admin.post("/api/erp/checklists").send({
      plantilla_id: plantillaId,
      equipo_id: equipoId,
      activo_texto: "Tolva trasera",
      items: items(),
    });
    expect(unidadYTexto.status).toBe(201);

    const soloTexto = await admin
      .post("/api/erp/checklists")
      .send({ plantilla_id: plantillaId, activo_texto: "Horno 4", items: items() });
    expect(soloTexto.status).toBe(201);

    const filas = await listado(admin);
    const por = (id: number) => filas.find((c) => c.id === id);
    expect(por(soloUnidad.body.id)).toMatchObject({
      equipo_id: equipoId,
      placa_codigo: placa,
      activo_texto: null,
    });
    expect(por(unidadYTexto.body.id)).toMatchObject({
      placa_codigo: placa,
      activo_texto: "Tolva trasera",
    });
    expect(por(soloTexto.body.id)).toMatchObject({ equipo_id: null, placa_codigo: null });

    const detalle = await admin.get(`/api/erp/checklists/${soloUnidad.body.id}`);
    expect(detalle.body.placa_codigo).toBe(placa);
  });

  it("una empresa que pierde Flota deja de ver la placa, conserva la unidad, y la recupera si vuelve", async () => {
    const e = await nueva(["flota", "checklists"]);
    let admin = await sesion(e);
    const placa = idUnico("CK");
    const equipo = await admin
      .post("/api/erp/equipos")
      .send({ placa_codigo: placa, tipo: "Volquete" });
    const equipoId = Number(equipo.body.id);
    const plantillaId = await plantilla(admin);
    const creado = await admin
      .post("/api/erp/checklists")
      .send({ plantilla_id: plantillaId, equipo_id: equipoId, items: items() });
    expect(creado.status).toBe(201);

    await ponerModulos(e, ["checklists"]);
    admin = await sesion(e);
    const sinFlota = (await listado(admin)).find((c) => c.id === creado.body.id);
    expect(sinFlota).toMatchObject({ equipo_id: equipoId, placa_codigo: null, activo_texto: null });
    const detalleSinFlota = await admin.get(`/api/erp/checklists/${creado.body.id}`);
    expect(detalleSinFlota.status).toBe(200);
    expect(detalleSinFlota.body.placa_codigo).toBeNull();

    await ponerModulos(e, ["flota", "checklists"]);
    admin = await sesion(e);
    const conFlota = (await listado(admin)).find((c) => c.id === creado.body.id);
    expect(conFlota?.placa_codigo).toBe(placa);
  });

  it("la base rechaza un checklist sin unidad y sin texto (CHECK de la migración 0189)", async () => {
    const e = await nueva(["checklists"]);
    const admin = await sesion(e);
    const plantillaId = await plantilla(admin);

    const insertar = (activoTexto: string | null) =>
      withTenant(e.tenant.id, (client) =>
        client.query(
          `INSERT INTO checklists (tenant_id, equipo_id, activo_texto, plantilla_id, usuario_id)
           VALUES ($1, NULL, $2, $3, $4)`,
          [e.tenant.id, activoTexto, plantillaId, e.usuario.id]
        )
      );

    await expect(insertar(null)).rejects.toMatchObject({ code: "23514" });
    await expect(insertar("   ")).rejects.toMatchObject({ code: "23514" });
    await expect(insertar("Horno 4")).resolves.toBeDefined();
  });
});
