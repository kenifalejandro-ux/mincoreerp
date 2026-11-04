/** tests/combustible-cisternas-listado.test.ts
 *
 * La pestaña "Cisternas": GET /despachos/cisternas. `saldo` son las cisternas que aún tienen
 * combustible; `historial`, las vaciadas y las de una recepción anulada (que se ven, marcadas, y
 * no se pueden repartir). Cada una trae su proveedor y sus salidas. Sin el módulo Flota la
 * pestaña responde igual: la salida a unidad sale sin placa.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase } from "../src/server/config/database";

type Agente = ReturnType<typeof request.agent>;

interface Salida {
  id: string;
  tipo: "unidad" | "tanqueta" | "tanque";
  cantidad: string;
  destino: string | null;
}
interface Cisterna {
  id: string;
  cantidad: string;
  salido: string;
  saldo: string;
  estado: "con_saldo" | "vaciada" | "anulada";
  recepcion_id: string;
  proveedor_id: number | null;
  proveedor: string | null;
  anulada_en: string | null;
  anulada_por_nombre: string | null;
  motivo_anulacion: string | null;
  salidas: Salida[];
}

const BASE = "/api/erp/combustible";

describe("combustible: listado de cisternas (pestaña Cisternas)", () => {
  let tenantId: string;
  let slug: string;
  const password = "ClaveDePrueba123";
  const admin = request.agent(app);
  let proveedor: number;
  let nombreProveedor: string;
  let principal: number;
  let seq = 0;
  let nVale = 5000;

  async function conRol(rol: string): Promise<{ agente: Agente; id: string; dni: string }> {
    const agente = request.agent(app);
    const dni = String(88700000 + Math.floor(Math.random() * 800000) + seq++);
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre: `Persona ${rol}`, dni, password, rol });
    expect(alta.status).toBe(201);
    await agente.post("/api/auth/login").send({ tenantSlug: slug, identificador: dni, password });
    return { agente, id: alta.body.id ?? alta.body.usuario?.id, dni };
  }

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    slug = creado.tenant.slug;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: slug, email: creado.usuario.email, password });
    nombreProveedor = idUnico("PROV");
    proveedor = (await admin.post(`${BASE}/grifos`).send({ nombre: nombreProveedor })).body.id;
    principal = (await admin.get("/api/erp/sedes")).body.sedes[0].grifos[0].id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
  });

  const listar = async (ag: Agente, query = ""): Promise<Cisterna[]> => {
    const r = await ag.get(`${BASE}/despachos/cisternas${query}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body;
  };
  const saldos = (ag: Agente = admin) => listar(ag, "?estado=saldo");
  const historial = (ag: Agente = admin) => listar(ag, "?estado=historial");
  const de = (lista: Cisterna[], recepcionId: number | string) =>
    lista.find((c) => Number(c.recepcion_id) === Number(recepcionId));

  async function equipo() {
    const r = await admin.post("/api/erp/equipos").send({
      placa_codigo: idUnico("CL"),
      tipo: "VOLQUETE",
      tipo_medidor: "horometro",
      grifo_interno_id: principal,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return { id: r.body.id as number, placa: r.body.placa_codigo as string };
  }

  async function tanque(nivel = 0, capacidad = 5000) {
    const t = await admin.post(`${BASE}`).send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque Cancha",
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_punto: "fijo",
      capacidad_total: capacidad,
      nivel_actual: nivel,
      requiere_documento: false,
      modo_excedente_recepcion: "flexible",
      grifo_interno_id: principal,
    });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    return { id: t.body.id as number, codigo: t.body.codigo as string };
  }

  async function cisterna(cantidad = 1000, proveedorId: number = proveedor) {
    // Tanque lleno: todo lo que se recibe es excedente y se queda en la cisterna.
    const tq = await tanque(2000, 2000);
    const rec = await admin.post(`${BASE}/recepciones`).send({
      combustible_id: tq.id,
      grifo_id: proveedorId,
      cantidad,
      costo_unitario: 16.5,
      recibido_en: new Date().toISOString(),
      reparto_excedente: [{ destino: "cisterna", cantidad }],
    });
    expect(rec.status, JSON.stringify(rec.body)).toBe(201);
    const linea = de(await saldos(), rec.body.id);
    expect(linea).toBeDefined();
    return { tq, recepcionId: Number(rec.body.id), lineaId: Number(linea!.id) };
  }

  const aUnidad = (lineaId: number, equipoId: number, cantidad: number) =>
    admin.post(`${BASE}/despachos`).send({
      origen: "excedente_recepcion",
      excedente_linea_id: lineaId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipoId,
      serie_talonario: "CLS",
      n_vale: nVale++,
      cantidad,
      lectura_horometro: 100 + seq++,
      costo_unitario: 1,
    });

  const aTanqueta = async (lineaId: number, cantidad: number) => {
    const tanqueta = (await admin.post(`${BASE}/tanquetas`).send({ grifo_interno_id: principal }))
      .body;
    const r = await admin.post(`${BASE}/despachos`).send({
      origen: "excedente_recepcion",
      excedente_linea_id: lineaId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "reserva_cubeta",
      tanqueta_destino_id: Number(tanqueta.id),
      cantidad,
      costo_unitario: 1,
      cliente_uuid: randomUUID(),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return tanqueta.codigo as string;
  };

  const alTanque = async (lineaId: number, destino: number, cantidad: number) => {
    const r = await admin.post(`${BASE}/despachos/cisterna-al-tanque`).send({
      linea_id: lineaId,
      combustible_id: destino,
      cantidad,
      cliente_uuid: randomUUID(),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  };

  it("con saldo: trae proveedor, estado y las salidas a unidad, tanqueta y tanque", async () => {
    const { recepcionId, lineaId } = await cisterna(1000);
    const unidad = await equipo();
    expect((await aUnidad(lineaId, unidad.id, 100)).status).toBe(201);
    const codigoTanqueta = await aTanqueta(lineaId, 200);
    const destino = await tanque(0);
    await alTanque(lineaId, destino.id, 300);

    const c = de(await saldos(), recepcionId)!;
    expect(c.estado).toBe("con_saldo");
    expect(c.proveedor).toBe(nombreProveedor);
    expect(c.proveedor_id).toBe(proveedor);
    expect(Number(c.saldo)).toBe(400);
    expect(Number(c.salido)).toBe(600);
    expect(c.anulada_en).toBeNull();
    const tipos = c.salidas.map((s) => s.tipo).sort();
    expect(tipos).toEqual(["tanque", "tanqueta", "unidad"]);
    expect(c.salidas.find((s) => s.tipo === "unidad")?.destino).toBe(unidad.placa);
    expect(c.salidas.find((s) => s.tipo === "tanqueta")?.destino).toBe(codigoTanqueta);
    expect(c.salidas.find((s) => s.tipo === "tanque")?.destino).toBe(destino.codigo);
    // Todavía tiene saldo: no está en el historial.
    expect(de(await historial(), recepcionId)).toBeUndefined();
  });

  it("vaciada: sale de 'saldo' y pasa al historial con todas sus salidas", async () => {
    const { recepcionId, lineaId } = await cisterna(500);
    const unidad = await equipo();
    expect((await aUnidad(lineaId, unidad.id, 500)).status).toBe(201);

    expect(de(await saldos(), recepcionId)).toBeUndefined();
    const c = de(await historial(), recepcionId)!;
    expect(c.estado).toBe("vaciada");
    expect(Number(c.saldo)).toBe(0);
    expect(c.salidas).toHaveLength(1);
  });

  it("una salida anulada no cuenta: ni en el saldo ni en la lista de salidas", async () => {
    const { recepcionId, lineaId } = await cisterna(500);
    const unidad = await equipo();
    const d = await aUnidad(lineaId, unidad.id, 200);
    expect(d.status).toBe(201);
    const anulado = await admin
      .patch(`${BASE}/despachos/${d.body.id}/anular`)
      .send({ motivo: "vale mal cargado" });
    expect(anulado.status, JSON.stringify(anulado.body)).toBe(200);

    const c = de(await saldos(), recepcionId)!;
    expect(Number(c.saldo)).toBe(500);
    expect(c.salidas).toEqual([]);
  });

  it("anulada: sale en el historial con quién y por qué, y no en 'saldo' ni se reparte", async () => {
    const { recepcionId, lineaId } = await cisterna(800);
    const ok = await admin
      .patch(`${BASE}/recepciones/${recepcionId}/anular`)
      .send({ motivo: "recepción duplicada" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);

    expect(de(await saldos(), recepcionId)).toBeUndefined();
    const c = de(await historial(), recepcionId)!;
    expect(c.estado).toBe("anulada");
    expect(c.anulada_en).not.toBeNull();
    expect(c.anulada_por_nombre).toBeTruthy();
    expect(c.motivo_anulacion).toBe("recepción duplicada");
    expect(c.salidas).toEqual([]);

    // Repartir una cisterna anulada devuelve error (400), nunca 201 ni 500.
    const unidad = await equipo();
    const reparto = await aUnidad(lineaId, unidad.id, 100);
    expect(reparto.status).toBeGreaterThanOrEqual(400);
    expect(reparto.status).toBeLessThan(500);
    const destino = await tanque(0);
    const pase = await admin.post(`${BASE}/despachos/cisterna-al-tanque`).send({
      linea_id: lineaId,
      combustible_id: destino.id,
      cantidad: 100,
      cliente_uuid: randomUUID(),
    });
    expect(pase.status).toBeGreaterThanOrEqual(400);
    expect(pase.status).toBeLessThan(500);
  });

  it("filtra por proveedor y no mezcla las de otro proveedor", async () => {
    const otro = (await admin.post(`${BASE}/grifos`).send({ nombre: idUnico("OTRO") })).body.id;
    const a = await cisterna(300, proveedor);
    const b = await cisterna(300, otro);

    const delProveedor = await listar(admin, `?estado=saldo&proveedor_id=${proveedor}`);
    expect(de(delProveedor, a.recepcionId)).toBeDefined();
    expect(de(delProveedor, b.recepcionId)).toBeUndefined();

    const delOtro = await listar(admin, `?estado=saldo&proveedor_id=${otro}`);
    expect(de(delOtro, b.recepcionId)).toBeDefined();
    expect(de(delOtro, a.recepcionId)).toBeUndefined();
  });

  it("un estado o un proveedor inválido es 400, y sin estado es 'saldo'", async () => {
    expect((await admin.get(`${BASE}/despachos/cisternas?estado=otro`)).status).toBe(400);
    expect((await admin.get(`${BASE}/despachos/cisternas?proveedor_id=abc`)).status).toBe(400);
    expect((await admin.get(`${BASE}/despachos/cisternas?proveedor_id=-1`)).status).toBe(400);
    const { recepcionId } = await cisterna(100);
    expect(de(await listar(admin), recepcionId)).toBeDefined();
  });

  it("ven la pestaña grifero, operador y Lectura; el conductor de ruta y el encargado de urea no", async () => {
    for (const rol of ["grifero", "operador", "lectura"]) {
      const { agente } = await conRol(rol);
      expect((await agente.get(`${BASE}/despachos/cisternas`)).status, rol).toBe(200);
    }
    for (const rol of ["conductor_ruta", "encargado_urea"]) {
      const { agente } = await conRol(rol);
      expect((await agente.get(`${BASE}/despachos/cisternas`)).status, rol).toBe(403);
    }
  });

  it("autonomía: sin el módulo Flota responde 200 y la salida a unidad sale sin placa", async () => {
    const { recepcionId, lineaId } = await cisterna(400);
    const unidad = await equipo();
    expect((await aUnidad(lineaId, unidad.id, 50)).status).toBe(201);
    const conFlota = de(await saldos(), recepcionId)!;
    expect(conFlota.salidas[0].destino).toBe(unidad.placa);

    const { id, dni } = await conRol("operador");
    const permisos = await admin.get(`/api/erp/usuarios/${id}/permisos`);
    expect(permisos.status).toBe(200);
    const modulos = permisos.body.modulos as { modulo: string; asignado: boolean; nivel: string }[];
    expect(modulos.some((m) => m.modulo === "flota" && m.asignado)).toBe(true);
    const guardado = await admin.put(`/api/erp/usuarios/${id}/permisos`).send({
      modulos: modulos.map((m) => ({
        modulo: m.modulo,
        asignado: m.modulo === "flota" ? false : m.asignado,
        nivel: m.nivel,
      })),
      alertasCorreo: permisos.body.alertasCorreo.map(
        (a: { modulo: string; recibeAlertas: boolean }) => ({
          modulo: a.modulo,
          recibeAlertas: a.recibeAlertas,
        })
      ),
      motivo: "prueba automatizada",
    });
    expect(guardado.status, JSON.stringify(guardado.body)).toBe(200);

    // Entra de nuevo: los módulos viajan en la sesión.
    const sinFlota = request.agent(app);
    await sinFlota.post("/api/auth/login").send({ tenantSlug: slug, identificador: dni, password });
    const r = await sinFlota.get(`${BASE}/despachos/cisternas?estado=saldo`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const c = de(r.body as Cisterna[], recepcionId)!;
    expect(c.salidas).toHaveLength(1);
    expect(c.salidas[0].tipo).toBe("unidad");
    expect(c.salidas[0].destino).toBeNull();
    expect(Number(c.salidas[0].cantidad)).toBe(50);
  });
});

describe("combustible: la pestaña Cisternas no cruza empresas", () => {
  const password = "ClaveDePrueba123";
  let tenantA: string;
  let tenantB: string;
  const adminA = request.agent(app);
  const adminB = request.agent(app);

  beforeAll(async () => {
    const a = await crearTenantDePrueba(password);
    const b = await crearTenantDePrueba(password);
    tenantA = a.tenant.id;
    tenantB = b.tenant.id;
    await adminA
      .post("/api/auth/login")
      .send({ tenantSlug: a.tenant.slug, email: a.usuario.email, password });
    await adminB
      .post("/api/auth/login")
      .send({ tenantSlug: b.tenant.slug, email: b.usuario.email, password });
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantA);
    await borrarTenantDePrueba(tenantB);
    await closeDatabase();
  });

  it("la empresa B no ve las cisternas de la A, ni en saldo ni en historial", async () => {
    const principal = (await adminA.get("/api/erp/sedes")).body.sedes[0].grifos[0].id;
    const prov = (await adminA.post(`${BASE}/grifos`).send({ nombre: idUnico("PA") })).body.id;
    const t = await adminA.post(`${BASE}`).send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque A",
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_punto: "fijo",
      capacidad_total: 2000,
      nivel_actual: 2000,
      requiere_documento: false,
      modo_excedente_recepcion: "flexible",
      grifo_interno_id: principal,
    });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    const rec = await adminA.post(`${BASE}/recepciones`).send({
      combustible_id: t.body.id,
      grifo_id: prov,
      cantidad: 100,
      costo_unitario: 16.5,
      recibido_en: new Date().toISOString(),
      reparto_excedente: [{ destino: "cisterna", cantidad: 100 }],
    });
    expect(rec.status, JSON.stringify(rec.body)).toBe(201);

    const deA = (await adminA.get(`${BASE}/despachos/cisternas?estado=saldo`)).body as Cisterna[];
    expect(deA.some((c) => Number(c.recepcion_id) === Number(rec.body.id))).toBe(true);
    for (const estado of ["saldo", "historial"]) {
      const deB = await adminB.get(`${BASE}/despachos/cisternas?estado=${estado}`);
      expect(deB.status).toBe(200);
      expect(deB.body).toEqual([]);
    }
    // Pedir el proveedor de la A desde la B tampoco trae nada.
    const cruzado = await adminB.get(`${BASE}/despachos/cisternas?proveedor_id=${prov}`);
    expect(cruzado.body).toEqual([]);
  });
});
