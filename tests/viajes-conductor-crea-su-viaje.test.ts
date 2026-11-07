/** tests/viajes-conductor-crea-su-viaje.test.ts
 *
 * El conductor crea e inicia su propio viaje desde el celular (migración 0179):
 *   POST /api/erp/viajes/crear-mio
 * Se ataca la API: interruptor de la empresa (403 apagado), reintento con el mismo identificador
 * (no duplica), un viaje ya asignado o en curso (409 con el existente), dos envíos a la vez, la
 * unidad nueva "por completar" con su ruta, la placa repetida, y la alerta de estado que se abre al
 * crear y se cierra sola al terminar el viaje.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, pool, withTenant } from "../src/server/config/database";

type Agente = ReturnType<typeof request.agent>;

const password = "ClaveDePrueba123";

describe("viajes: el conductor crea su propio viaje (0179)", () => {
  let tenantId: string;
  let slug: string;
  const admin = request.agent(app);
  let a: number;
  let b: number;
  let seq = 0;

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    slug = c.tenant.slug;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: slug, email: c.usuario.email, password });
    a = Number(
      (await admin.post("/api/erp/viajes/lugares").send({ nombre: idUnico("Orig") })).body.id
    );
    b = Number(
      (await admin.post("/api/erp/viajes/lugares").send({ nombre: idUnico("Dest") })).body.id
    );
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  const interruptor = (activo: boolean) =>
    pool.query(`UPDATE tenants SET conductor_crea_viaje = $2 WHERE id = $1`, [tenantId, activo]);

  async function conductor(): Promise<{ agente: Agente; dni: string }> {
    const agente = request.agent(app);
    const dni = String(86300000 + Math.floor(Math.random() * 90000) + seq++);
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre: `Conductor Prueba ${dni}`, dni, password, rol: "conductor_ruta" });
    expect(alta.status, JSON.stringify(alta.body)).toBe(201);
    await agente.post("/api/auth/login").send({ tenantSlug: slug, identificador: dni, password });
    return { agente, dni };
  }

  const placaNueva = () =>
    `Z${Math.floor(Math.random() * 90000 + 10000)}`.slice(0, 3) + `-${seq++ + 100}`;
  const cuerpoNuevo = (placa: string, extra: Record<string, unknown> = {}) => ({
    id_cliente: randomUUID(),
    unidad_nueva: { placa, nombre: "Conductor de Prueba" },
    paradas: [a, b],
    medidor_inicio: 1000,
    ...extra,
  });
  const crear = (ag: Agente, body: Record<string, unknown>) =>
    ag.post("/api/erp/viajes/crear-mio").send(body);

  const alertas = (viajeId: number) =>
    withTenant(tenantId, async (c) => {
      const r = await c.query(
        `SELECT resuelta_en FROM combustible_alertas
          WHERE tenant_id = $1 AND viaje_id = $2 AND tipo = 'viaje_creado_por_conductor'`,
        [tenantId, viajeId]
      );
      return r.rows;
    });
  const contar = (sql: string, params: unknown[]) =>
    withTenant(tenantId, async (c) =>
      Number((await c.query(sql, [tenantId, ...params])).rows[0].n)
    );

  it("con el interruptor apagado (por defecto) responde 403 y nada se crea", async () => {
    await interruptor(false);
    const c = await conductor();
    const cfg = await c.agente.get("/api/erp/viajes/mios/config");
    expect(cfg.body.puede_crear_viaje).toBe(false);
    const placa = placaNueva();
    const r = await crear(c.agente, cuerpoNuevo(placa));
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(
      await contar(`SELECT count(*) AS n FROM equipos WHERE tenant_id = $1 AND placa_codigo = $2`, [
        placa,
      ])
    ).toBe(0);
  });

  it("sin el odómetro de salida, o con unidad y unidad nueva a la vez, responde 400", async () => {
    await interruptor(true);
    const c = await conductor();
    const sin = cuerpoNuevo(placaNueva());
    delete (sin as Record<string, unknown>).medidor_inicio;
    expect((await crear(c.agente, sin)).status).toBe(400);
    const dos = cuerpoNuevo(placaNueva(), { equipo_id: 1 });
    expect((await crear(c.agente, dos)).status).toBe(400);
  });

  it("unidad nueva: viaje en curso, unidad por completar con su ruta y alerta abierta; terminar el viaje la cierra", async () => {
    await interruptor(true);
    const c = await conductor();
    const placa = placaNueva();
    const cuerpo = cuerpoNuevo(placa);
    const r = await crear(c.agente, cuerpo);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.estado).toBe("en_curso");
    expect(r.body.creado_por_conductor).toBe(true);
    expect(r.body.equipo_por_completar).toBe(true);
    const id = Number(r.body.id);

    const eq = await withTenant(tenantId, (cl) =>
      cl.query(
        `SELECT e.tipo, e.por_completar, e.conductor_dni,
                (SELECT count(*) FROM equipo_rutas r WHERE r.equipo_id = e.id AND r.hasta IS NULL
                    AND r.origen_id = $3 AND r.destino_id = $4) AS rutas
           FROM equipos e WHERE e.tenant_id = $1 AND e.placa_codigo = $2`,
        [tenantId, placa.toUpperCase(), a, b]
      )
    );
    expect(eq.rows[0]).toMatchObject({
      tipo: "Por completar",
      por_completar: true,
      conductor_dni: c.dni,
    });
    expect(Number(eq.rows[0].rutas)).toBe(1);

    const abierta = await alertas(id);
    expect(abierta).toHaveLength(1);
    expect(abierta[0].resuelta_en).toBeNull();

    // Una marca intermedia no la cierra: solo terminar el viaje.
    const fin = await c.agente.post(`/api/erp/viajes/${id}/cerrar-mio`).send({
      medidor_fin: 1100,
      cliente_uuid: randomUUID(),
    });
    expect(fin.status, JSON.stringify(fin.body)).toBe(200);
    expect((await alertas(id))[0].resuelta_en).not.toBeNull();
  });

  it("el mismo identificador devuelve el viaje ya creado, sin duplicar viaje, unidad ni alerta", async () => {
    await interruptor(true);
    const c = await conductor();
    const cuerpo = cuerpoNuevo(placaNueva());
    const primero = await crear(c.agente, cuerpo);
    expect(primero.status, JSON.stringify(primero.body)).toBe(201);
    const otra = await crear(c.agente, cuerpo);
    expect(otra.status, JSON.stringify(otra.body)).toBe(200);
    expect(otra.body.id).toBe(primero.body.id);
    expect(
      await contar(
        `SELECT count(*) AS n FROM combustible_viajes WHERE tenant_id = $1 AND conductor_dni = $2`,
        [c.dni]
      )
    ).toBe(1);
    expect(await alertas(Number(primero.body.id))).toHaveLength(1);
  });

  it("con un viaje en curso no se crea otro: 409 y devuelve el que tiene", async () => {
    await interruptor(true);
    const c = await conductor();
    const primero = await crear(c.agente, cuerpoNuevo(placaNueva()));
    expect(primero.status).toBe(201);
    const segundo = await crear(c.agente, cuerpoNuevo(placaNueva()));
    expect(segundo.status, JSON.stringify(segundo.body)).toBe(409);
    expect(segundo.body.details.viaje.id).toBe(primero.body.id);
  });

  it("con un viaje ya programado por la oficina tampoco: 409", async () => {
    await interruptor(true);
    const c = await conductor();
    const u = await admin.post("/api/erp/equipos").send({
      placa_codigo: idUnico("PR"),
      tipo: "VOLQUETE",
      tipo_medidor: "odometro",
      conductor_nombre: "Titular",
      conductor_dni: c.dni,
    });
    const prog = await admin
      .post("/api/erp/viajes")
      .send({ equipo_id: Number(u.body.id), origen_id: a, destino_id: b });
    expect(prog.status, JSON.stringify(prog.body)).toBe(201);
    const r = await crear(c.agente, cuerpoNuevo(placaNueva()));
    expect(r.status).toBe(409);
    expect(r.body.details.viaje.id).toBe(prog.body.id);
  });

  it("dos envíos a la vez del mismo conductor dejan un solo viaje", async () => {
    await interruptor(true);
    const c = await conductor();
    const rs = await Promise.all([
      crear(c.agente, cuerpoNuevo(placaNueva())),
      crear(c.agente, cuerpoNuevo(placaNueva())),
    ]);
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(
      await contar(
        `SELECT count(*) AS n FROM combustible_viajes WHERE tenant_id = $1 AND conductor_dni = $2`,
        [c.dni]
      )
    ).toBe(1);
  });

  it("placa repetida (aunque cambie guion o mayúsculas): usa la unidad que ya existe, no crea otra", async () => {
    await interruptor(true);
    const c1 = await conductor();
    const c2 = await conductor();
    const placa = placaNueva();
    const p1 = await crear(c1.agente, cuerpoNuevo(placa));
    expect(p1.status, JSON.stringify(p1.body)).toBe(201);
    // El primero termina; el segundo escribe la misma placa distinta.
    await c1.agente
      .post(`/api/erp/viajes/${p1.body.id}/cerrar-mio`)
      .send({ medidor_fin: 1100, cliente_uuid: randomUUID() });
    const p2 = await crear(
      c2.agente,
      cuerpoNuevo(placa.toLowerCase().replace("-", " "), { medidor_inicio: 1100 })
    );
    expect(p2.status, JSON.stringify(p2.body)).toBe(201);
    expect(p2.body.equipo_id).toBe(p1.body.equipo_id);
    expect(
      await contar(
        `SELECT count(*) AS n FROM equipos
          WHERE tenant_id = $1 AND regexp_replace(upper(placa_codigo), '[^A-Z0-9]', '', 'g') = $2`,
        [placa.replace("-", "").toUpperCase()]
      )
    ).toBe(1);
  });

  it("con una unidad registrada, el conductor asignado en Equipos no cambia", async () => {
    await interruptor(true);
    const c = await conductor();
    const u = await admin.post("/api/erp/equipos").send({
      placa_codigo: idUnico("RG"),
      tipo: "VOLQUETE",
      tipo_medidor: "odometro",
      conductor_nombre: "Otro Titular",
      conductor_dni: String(40900000 + seq++),
    });
    expect(u.status, JSON.stringify(u.body)).toBe(201);
    const r = await crear(c.agente, {
      id_cliente: randomUUID(),
      equipo_id: Number(u.body.id),
      paradas: [a, b, a],
      medidor_inicio: 500,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.conductor_dni).toBe(c.dni);
    const eq = await withTenant(tenantId, (cl) =>
      cl.query(
        `SELECT conductor_dni, por_completar FROM equipos WHERE tenant_id = $1 AND id = $2`,
        [tenantId, Number(u.body.id)]
      )
    );
    expect(eq.rows[0].conductor_dni).toBe(u.body.conductor_dni);
    expect(eq.rows[0].por_completar).toBe(false);
  });
  it("el catálogo del celular: apagado no entrega nada; encendido trae lugares, unidades con su ruta y relevos sin DNI", async () => {
    const c = await conductor();
    const otro = await conductor();
    await interruptor(false);
    const apagado = await c.agente.get("/api/erp/viajes/mios/catalogo");
    expect(apagado.status).toBe(200);
    expect(apagado.body).toEqual({
      puede_crear_viaje: false,
      lugares: [],
      unidades: [],
      relevos: [],
    });

    await interruptor(true);
    const placa = idUnico("CT");
    const u = await admin.post("/api/erp/equipos").send({
      placa_codigo: placa,
      tipo: "VOLQUETE",
      tipo_medidor: "odometro",
      conductor_nombre: "Yo",
      conductor_dni: c.dni,
      rutas: [{ origen_id: a, destino_id: b }],
    });
    expect(u.status, JSON.stringify(u.body)).toBe(201);

    const r = await c.agente.get("/api/erp/viajes/mios/catalogo");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.puede_crear_viaje).toBe(true);
    expect(r.body.lugares.map((l: { id: number }) => l.id)).toEqual(expect.arrayContaining([a, b]));
    // La unidad que Equipos le asignó va primera, con su ruta.
    expect(r.body.unidades[0]).toMatchObject({
      id: Number(u.body.id),
      placa,
      asignada_a_mi: true,
      ruta: { origen_id: a, destino_id: b },
    });
    // Los relevos son otros conductores, sin DNI y sin él mismo.
    expect(r.body.relevos.length).toBeGreaterThan(0);
    for (const rel of r.body.relevos) {
      expect(Object.keys(rel).sort()).toEqual(["con_cuenta", "id", "nombre"]);
    }
    expect(JSON.stringify(r.body.relevos)).not.toContain(c.dni);
    expect(JSON.stringify(r.body.relevos)).toContain(otro.dni);
  });

  it("elegir al relevo por su id de usuario lo deja como relevo del viaje", async () => {
    await interruptor(true);
    const c = await conductor();
    const otro = await conductor();
    const cat = await c.agente.get("/api/erp/viajes/mios/catalogo");
    const relevo = cat.body.relevos.find((x: { nombre: string }) => x.nombre.includes(otro.dni));
    expect(relevo).toBeTruthy();
    const r = await crear(c.agente, cuerpoNuevo(placaNueva(), { relevo_usuario_id: relevo.id }));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.relevo_dni).toBe(otro.dni);
    // Un id que no es de un conductor activo se rechaza.
    const mal = await crear(
      (await conductor()).agente,
      cuerpoNuevo(placaNueva(), { relevo_usuario_id: randomUUID() })
    );
    expect(mal.status).toBe(400);
  });
  it("creado sin señal: el reenvío trae la hora del celular, que vale como salida, y no duplica", async () => {
    await interruptor(true);
    const c = await conductor();
    const marcado = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const base = cuerpoNuevo(placaNueva(), { marcado_en: marcado });
    const cuerpo = { ...base, cliente_uuid: base.id_cliente }; // lo que lee la cola del celular
    const r = await crear(c.agente, cuerpo);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.inicio_origen_hora).toBe("dispositivo");
    expect(Math.abs(Date.parse(r.body.inicio_en) - Date.parse(marcado))).toBeLessThan(1000);
    // Otro reenvío del mismo identificador (la cola no sabe si el primero llegó): el mismo viaje.
    const otra = await crear(c.agente, cuerpo);
    expect(otra.status).toBe(200);
    expect(otra.body.id).toBe(r.body.id);
  });

  it("la unidad «por completar» deja de serlo cuando la oficina le pone su tipo real", async () => {
    await interruptor(true);
    const c = await conductor();
    const placa = placaNueva();
    const r = await crear(c.agente, cuerpoNuevo(placa));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const id = Number(r.body.equipo_id);
    const lista = async () =>
      (await admin.get("/api/erp/equipos?page=1&pageSize=200")).body.data.find(
        (e: { id: number }) => e.id === id
      );
    expect((await lista()).por_completar).toBe(true);

    // Editar sin cambiar el tipo provisional no la completa.
    const igual = await admin.put(`/api/erp/equipos/${id}`).send({
      placa_codigo: placa.toUpperCase(),
      tipo: "Por completar",
      conductor_nombre: "Conductor de Prueba",
      conductor_dni: c.dni,
      marca: "Volvo",
    });
    expect(igual.status, JSON.stringify(igual.body)).toBe(200);
    expect((await lista()).por_completar).toBe(true);

    const hecho = await admin.put(`/api/erp/equipos/${id}`).send({
      placa_codigo: placa.toUpperCase(),
      tipo: "VOLQUETE",
      conductor_nombre: "Conductor de Prueba",
      conductor_dni: c.dni,
      marca: "Volvo",
    });
    expect(hecho.status, JSON.stringify(hecho.body)).toBe(200);
    expect((await lista()).por_completar).toBe(false);
  });
  it("la unidad asignada va primera en el catálogo aunque haya unidades sin conductor", async () => {
    await interruptor(true);
    const c = await conductor();
    // Unidades SIN conductor (dni nulo): antes del arreglo ordenaban antes que la asignada.
    for (let n = 0; n < 3; n++) {
      const sin = await admin.post("/api/erp/equipos").send({
        placa_codigo: idUnico("AA"),
        tipo: "VOLQUETE",
      });
      expect(sin.status, JSON.stringify(sin.body)).toBe(201);
    }
    const mia = await admin.post("/api/erp/equipos").send({
      placa_codigo: idUnico("ZZ"),
      tipo: "VOLQUETE",
      conductor_nombre: "Yo",
      conductor_dni: c.dni,
    });
    expect(mia.status, JSON.stringify(mia.body)).toBe(201);
    const r = await c.agente.get("/api/erp/viajes/mios/catalogo");
    expect(r.body.unidades[0]).toMatchObject({ id: Number(mia.body.id), asignada_a_mi: true });
    expect(r.body.unidades.filter((u: { asignada_a_mi: boolean }) => u.asignada_a_mi)).toHaveLength(
      1
    );
  });

  it("el motivo de salir en otra unidad queda en las observaciones del viaje", async () => {
    await interruptor(true);
    const c = await conductor();
    const u = await admin.post("/api/erp/equipos").send({
      placa_codigo: idUnico("MT"),
      tipo: "VOLQUETE",
      tipo_medidor: "odometro",
    });
    expect(u.status, JSON.stringify(u.body)).toBe(201);
    const r = await crear(c.agente, {
      id_cliente: randomUUID(),
      equipo_id: Number(u.body.id),
      paradas: [a, b],
      medidor_inicio: 10,
      motivo_unidad: "La mía está en taller",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const fila = await withTenant(tenantId, (cl) =>
      cl.query(`SELECT observaciones FROM combustible_viajes WHERE tenant_id = $1 AND id = $2`, [
        tenantId,
        Number(r.body.id),
      ])
    );
    expect(fila.rows[0].observaciones).toContain("La mía está en taller");
  });
  it("un relevo sin cuenta queda anotado en el viaje; no es relevo del sistema ni se mezcla con uno registrado", async () => {
    await interruptor(true);
    const c = await conductor();
    const r = await crear(c.agente, cuerpoNuevo(placaNueva(), { relevo_nombre: "Pedro Soto" }));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.relevo_dni).toBeNull();
    const fila = await withTenant(tenantId, (cl) =>
      cl.query(`SELECT observaciones FROM combustible_viajes WHERE tenant_id = $1 AND id = $2`, [
        tenantId,
        Number(r.body.id),
      ])
    );
    expect(fila.rows[0].observaciones).toContain("Relevo sin cuenta: Pedro Soto");

    const otro = await conductor();
    const cat = await otro.agente.get("/api/erp/viajes/mios/catalogo");
    const reg = cat.body.relevos[0];
    const mezcla = await crear(
      otro.agente,
      cuerpoNuevo(placaNueva(), { relevo_nombre: "Pedro Soto", relevo_usuario_id: reg.id })
    );
    expect(mezcla.status).toBe(400);
  });
  it("un conductor que solo está anotado en Equipos también se puede elegir de relevo, sin DNI y sin repetirse", async () => {
    await interruptor(true);
    const c = await conductor();
    const dniSinCuenta = String(41500000 + seq++);
    const nombre = `Jhuver Nicolas Julca ${idUnico("X").replace(/[0-9]/g, "")}`;
    // Dos unidades con el MISMO conductor (sin cuenta): sale una sola vez.
    for (let n = 0; n < 2; n++) {
      const u = await admin.post("/api/erp/equipos").send({
        placa_codigo: idUnico("EQ"),
        tipo: "VOLQUETE",
        conductor_nombre: nombre,
        conductor_dni: dniSinCuenta,
      });
      expect(u.status, JSON.stringify(u.body)).toBe(201);
    }
    const r = await c.agente.get("/api/erp/viajes/mios/catalogo");
    const filas = r.body.relevos.filter((x: { nombre: string }) => x.nombre === nombre);
    expect(filas).toHaveLength(1);
    expect(filas[0].con_cuenta).toBe(false);
    expect(filas[0].id).toMatch(/^eq:/);
    expect(JSON.stringify(r.body)).not.toContain(dniSinCuenta);
    // Un conductor de Equipos que SÍ tiene cuenta sale con su cuenta, no duplicado.
    const otro = await conductor();
    await admin.post("/api/erp/equipos").send({
      placa_codigo: idUnico("EC"),
      tipo: "VOLQUETE",
      conductor_nombre: "Otro con cuenta",
      conductor_dni: otro.dni,
    });
    const r2 = await c.agente.get("/api/erp/viajes/mios/catalogo");
    expect(
      r2.body.relevos.filter((x: { nombre: string }) => x.nombre === "Otro con cuenta")
    ).toHaveLength(0);
    expect(
      r2.body.relevos.filter((x: { nombre: string }) => x.nombre.includes(otro.dni))
    ).toHaveLength(1);
  });
  it("un lugar escrito a mano se agrega al catálogo una sola vez (sin importar mayúsculas) y el viaje lo usa", async () => {
    await interruptor(true);
    const c = await conductor();
    const c2 = await conductor();
    const nuevoLugar = `Chepén ${idUnico("L")}`;
    const r = await crear(c.agente, {
      id_cliente: randomUUID(),
      unidad_nueva: { placa: placaNueva(), nombre: "Conductor de Prueba" },
      paradas: [a, { nombre: nuevoLugar }],
      medidor_inicio: 1,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.destino).toBe(nuevoLugar);
    // Otro conductor escribe el mismo nombre en minúsculas: usa el mismo lugar, no crea otro.
    const r2 = await crear(c2.agente, {
      id_cliente: randomUUID(),
      unidad_nueva: { placa: placaNueva(), nombre: "Otro Conductor" },
      paradas: [{ nombre: nuevoLugar.toLowerCase() }, b],
      medidor_inicio: 1,
    });
    expect(r2.status, JSON.stringify(r2.body)).toBe(201);
    expect(Number(r2.body.origen_id)).toBe(Number(r.body.destino_id));
    expect(
      await contar(
        `SELECT count(*) AS n FROM combustible_lugares
          WHERE tenant_id = $1 AND lower(trim(nombre)) = lower($2)`,
        [nuevoLugar]
      )
    ).toBe(1);
  });
  it("las marcas de un viaje creado sin señal llegan por su id_cliente: llegada, salida, descanso y cierre", async () => {
    await interruptor(true);
    const c = await conductor();
    const base = cuerpoNuevo(placaNueva(), { paradas: [a, b, a] });
    const creado = await crear(c.agente, base);
    expect(creado.status, JSON.stringify(creado.body)).toBe(201);
    const marca = (ruta: string, extra: Record<string, unknown> = {}) =>
      c.agente
        .post(`/api/erp/viajes/por-cliente/${base.id_cliente}/${ruta}`)
        .send({ cliente_uuid: randomUUID(), ...extra });

    const llegada = await marca("llegada-mia", { orden: 1, medidor: 1010 });
    expect(llegada.status, JSON.stringify(llegada.body)).toBe(200);
    const desc = await marca("descanso-mio", { motivo: "Comer" });
    expect(desc.status, JSON.stringify(desc.body)).toBe(200);
    expect((await marca("descanso-mio/terminar")).status).toBe(200);
    expect((await marca("salida-mia", { orden: 1, medidor: 1011 })).status).toBe(200);
    const fin = await marca("cerrar-mio", { medidor_fin: 1100 });
    expect(fin.status, JSON.stringify(fin.body)).toBe(200);
    expect(fin.body.estado).toBe("cerrado");
    expect(fin.body.id).toBe(creado.body.id);
  });

  it("una marca por id_cliente de un viaje que no existe da 404, y no es de nadie más", async () => {
    await interruptor(true);
    const c = await conductor();
    const ajeno = await conductor();
    const sinViaje = await c.agente
      .post(`/api/erp/viajes/por-cliente/${randomUUID()}/llegada-mia`)
      .send({ cliente_uuid: randomUUID(), orden: 1 });
    expect(sinViaje.status).toBe(404);

    const base = cuerpoNuevo(placaNueva());
    expect((await crear(c.agente, base)).status).toBe(201);
    const robo = await ajeno.agente
      .post(`/api/erp/viajes/por-cliente/${base.id_cliente}/cerrar-mio`)
      .send({ cliente_uuid: randomUUID(), medidor_fin: 1100 });
    expect([403, 404]).toContain(robo.status);
  });

  it("el reenvío de una marca por id_cliente no se duplica", async () => {
    await interruptor(true);
    const c = await conductor();
    const base = cuerpoNuevo(placaNueva(), { paradas: [a, b, a] });
    expect((await crear(c.agente, base)).status).toBe(201);
    const uuid = randomUUID();
    const url = `/api/erp/viajes/por-cliente/${base.id_cliente}/llegada-mia`;
    const una = await c.agente.post(url).send({ cliente_uuid: uuid, orden: 1, medidor: 1010 });
    const otra = await c.agente.post(url).send({ cliente_uuid: uuid, orden: 1, medidor: 1010 });
    expect(una.status, JSON.stringify(una.body)).toBe(200);
    expect(otra.status, JSON.stringify(otra.body)).toBe(200);
  });
  it("con un relevo sin cuenta, «el relevo maneja» solo deja historial, se alterna y no se repite", async () => {
    await interruptor(true);
    const c = await conductor();
    const base = cuerpoNuevo(placaNueva(), { relevo_nombre: "Pedro Soto" });
    const creado = await crear(c.agente, base);
    expect(creado.status, JSON.stringify(creado.body)).toBe(201);
    expect(creado.body.relevo_sin_cuenta).toBe("Pedro Soto");
    const id = creado.body.id;
    const maneja = (quien: string, extra: Record<string, unknown> = {}) =>
      c.agente.post(`/api/erp/viajes/${id}/maneja-mio`).send({ quien, ...extra });

    const uno = await maneja("relevo", { cliente_uuid: randomUUID() });
    expect(uno.status, JSON.stringify(uno.body)).toBe(200);
    expect(uno.body.manejo.map((m: { quien: string }) => m.quien)).toEqual(["relevo"]);
    // No cambia turnos ni mando: el titular sigue siendo el del volante en el sistema.
    expect(uno.body.relevo_dni).toBeNull();
    // Dos veces lo mismo no tiene sentido.
    expect((await maneja("relevo")).status).toBe(409);
    const dos = await maneja("titular");
    expect(dos.status, JSON.stringify(dos.body)).toBe(200);
    expect(dos.body.manejo.map((m: { quien: string }) => m.quien)).toEqual(["relevo", "titular"]);
  });

  it("«el relevo maneja» por id_cliente (viaje creado sin señal) no duplica con el mismo identificador", async () => {
    await interruptor(true);
    const c = await conductor();
    const base = cuerpoNuevo(placaNueva(), { relevo_nombre: "Pedro Soto" });
    expect((await crear(c.agente, base)).status).toBe(201);
    const uuid = randomUUID();
    const url = `/api/erp/viajes/por-cliente/${base.id_cliente}/maneja-mio`;
    const una = await c.agente.post(url).send({ quien: "relevo", cliente_uuid: uuid });
    const otra = await c.agente.post(url).send({ quien: "relevo", cliente_uuid: uuid });
    expect(una.status, JSON.stringify(una.body)).toBe(200);
    expect(otra.status, JSON.stringify(otra.body)).toBe(200);
    expect(otra.body.manejo).toHaveLength(1);
  });

  it("sin relevo sin cuenta no hay «el relevo maneja», y un ajeno no puede anotarlo", async () => {
    await interruptor(true);
    const c = await conductor();
    const ajeno = await conductor();
    const sinRelevo = await crear(c.agente, cuerpoNuevo(placaNueva()));
    expect(sinRelevo.status).toBe(201);
    const r = await c.agente
      .post(`/api/erp/viajes/${sinRelevo.body.id}/maneja-mio`)
      .send({ quien: "relevo" });
    expect(r.status).toBe(409);

    const conRelevo = await crear(
      (await conductor()).agente,
      cuerpoNuevo(placaNueva(), { relevo_nombre: "Pedro Soto" })
    );
    const robo = await ajeno.agente
      .post(`/api/erp/viajes/${conRelevo.body.id}/maneja-mio`)
      .send({ quien: "relevo" });
    expect(robo.status).toBe(404);
  });
});
