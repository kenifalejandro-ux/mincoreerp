/** tests/combustible-sin-flota.test.ts
 *
 * Combustible lee las unidades de Flota solo para mostrar más (placa, medidor, conductor): el
 * módulo trabaja con lo que la empresa tiene contratado. Sin Flota en la EMPRESA esa lectura no se
 * hace: no se devuelve una unidad aunque su fila siga en la base (la empresa pudo tenerla y
 * apagarla), y las unidades se escriben a mano. Lo que se fija:
 *
 * 1. Con Flota todo sigue igual: el vale lleva la placa de su unidad y la lista de unidades las ofrece.
 * 2. Sin Flota: el historial no trae la placa de la unidad, la lista de unidades sale vacía, la
 *    sugerencia de consumo no encuentra la unidad y la unidad asignada al conductor es null.
 * 3. Sin Flota: elegir una unidad registrada es un 400 claro; escribir la placa funciona, y NO se
 *    engancha a una unidad vieja con esa placa (antes se convertía en esa unidad).
 * 4. Quien lee es el grifero o el conductor, que no tienen `flota` asignado: la regla es de la
 *    EMPRESA, no de la persona (un conductor con Flota en la empresa sigue viendo su placa).
 * 5. Al volver Flota, todo reaparece (apagar un módulo no borra sus datos).
 *
 * La sesión se abre CON Flota y después se apaga por SQL: el JWT conserva sus módulos hasta el
 * próximo login, que es justo el caso en que la lectura tiene que decidir sola. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico, dniUnico } from "./helpers";
import { pool, closeDatabase } from "../src/server/config/database";

const PASSWORD = "ClaveDePrueba123";
const BASE = "/api/erp/combustible";
const serieUnica = () => `S${Math.floor(Math.random() * 1e8).toString(36)}`.toUpperCase();

describe("Combustible sin Flota en la empresa", () => {
  let tenantId: string;
  let slug: string;
  let tanqueId: number;
  let equipoId: number;
  let valeId: number;
  let dniConductor: string;
  const placa = idUnico("SF").toUpperCase();
  const admin = request.agent(app);
  const conductor = request.agent(app);
  let n = 0;

  // «Sin Flota» es sin ningún módulo que mantenga unidades: también se apaga Mantenimiento, que
  // (como Flota) las ofrece. Con Mantenimiento solo se prueba en combustible-con-mantenimiento.test.ts.
  const flota = (estado: "habilitado" | "deshabilitado") =>
    pool.query(
      `UPDATE tenant_modulos SET estado = $2 WHERE tenant_id = $1 AND modulo IN ('flota', 'mantenimiento')`,
      [tenantId, estado]
    );

  const vale = (over: Record<string, unknown> = {}) =>
    admin.post(`${BASE}/despachos`).send({
      origen: "tanque_propio",
      combustible_id: tanqueId,
      tipo_combustible: "diesel_b5",
      serie_talonario: serieUnica(),
      n_vale: ++n,
      cantidad: 50,
      lectura_contometro: 50,
      costo_unitario: 27.5,
      despachado_en: new Date().toISOString(),
      ...over,
    });

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(PASSWORD);
    tenantId = creado.tenant.id;
    slug = creado.tenant.slug;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: slug, email: creado.usuario.email, password: PASSWORD });

    const tq = await admin.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque sin flota",
      tipo_combustible: "diesel_b5",
      unidad: "L",
      tipo_punto: "fijo",
      capacidad_total: 20000,
      nivel_actual: 10000,
      requiere_documento: false,
    });
    expect(tq.status, JSON.stringify(tq.body)).toBe(201);
    tanqueId = tq.body.id;

    // El conductor y la unidad que tiene asignada.
    dniConductor = dniUnico();
    const alta = await admin.post("/api/erp/usuarios").send({
      nombre: "Conductor SF",
      dni: dniConductor,
      password: PASSWORD,
      rol: "conductor_ruta",
    });
    expect(alta.status, JSON.stringify(alta.body)).toBe(201);
    const eq = await admin.post("/api/erp/equipos").send({
      placa_codigo: placa,
      tipo: "VOLQUETE",
      tipo_medidor: "odometro",
      conductor_nombre: "Conductor SF",
      conductor_dni: dniConductor,
    });
    expect(eq.status, JSON.stringify(eq.body)).toBe(201);
    equipoId = Number(eq.body.id);

    // Un vale a esa unidad, con Flota encendida.
    const v = await vale({ tipo_destino: "equipo", equipo_id: equipoId });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    valeId = Number(v.body.id);

    const entrar = await conductor
      .post("/api/auth/login")
      .send({ tenantSlug: slug, identificador: dniConductor, password: PASSWORD });
    expect(entrar.status, JSON.stringify(entrar.body)).toBe(200);
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  const filaDelVale = async () => {
    const lista = await admin.get(`${BASE}/despachos`);
    expect(lista.status).toBe(200);
    return (lista.body.data as Array<Record<string, unknown>>).find((f) => Number(f.id) === valeId);
  };

  it("CON Flota: el vale lleva la placa, la lista de unidades la ofrece y el conductor ve la suya", async () => {
    expect((await filaDelVale())?.placa_codigo).toBe(placa);

    const unidades = await admin.get(`${BASE}/equipos-destino`);
    expect(unidades.status).toBe(200);
    expect(
      (unidades.body.data as Array<{ placa_codigo: string }>).map((u) => u.placa_codigo)
    ).toContain(placa);

    const mia = await conductor.get(`${BASE}/mi-unidad-asignada`);
    expect(mia.status).toBe(200);
    expect(mia.body.data).toMatchObject({ equipo_id: equipoId, placa_codigo: placa });
  });

  it("SIN Flota: el historial no trae la placa, la lista de unidades sale vacía y nadie tiene unidad asignada", async () => {
    await flota("deshabilitado");
    try {
      // El vale sigue ahí (es de Combustible), pero la placa es dato de Flota: no se lee.
      const fila = await filaDelVale();
      expect(fila).toBeDefined();
      expect(fila?.placa_codigo ?? null).toBeNull();

      const unidades = await admin.get(`${BASE}/equipos-destino`);
      expect(unidades.status).toBe(200);
      expect(unidades.body.data).toEqual([]);

      // El conductor NO tiene `flota` asignado: lo decide la empresa, no él.
      const mia = await conductor.get(`${BASE}/mi-unidad-asignada`);
      expect(mia.status).toBe(200);
      expect(mia.body.data).toBeNull();

      const sugerencia = await admin.get(`${BASE}/equipos/${equipoId}/sugerencia-consumo`);
      expect(sugerencia.status).toBe(404);

      const consumo = await admin.get(`${BASE}/reportes/consumo-equipos`).query({
        desde: new Date(Date.now() - 30 * 86400_000).toISOString(),
        hasta: new Date(Date.now() + 60_000).toISOString(),
      });
      expect(consumo.status).toBe(200);
      expect(JSON.stringify(consumo.body)).not.toContain(placa);
    } finally {
      await flota("habilitado");
    }
  });

  it("SIN Flota: elegir una unidad registrada da un 400 claro, y escribir la placa funciona sin engancharse a la unidad vieja", async () => {
    await flota("deshabilitado");
    try {
      const elegida = await vale({ tipo_destino: "equipo", equipo_id: equipoId });
      expect(elegida.status, JSON.stringify(elegida.body)).toBe(400);
      expect(JSON.stringify(elegida.body)).toMatch(/no tiene el módulo Flota/);

      // Esa misma placa, escrita: antes se convertía en la unidad de Flota que la tenga.
      const escrita = await vale({ tipo_destino: "unidad_sin_alta", placa_sin_alta: placa });
      expect(escrita.status, JSON.stringify(escrita.body)).toBe(201);
      expect(escrita.body.tipo_destino).toBe("unidad_sin_alta");
      expect(escrita.body.equipo_id).toBeNull();
      expect(escrita.body.placa_sin_alta).toBe(placa.replace(/[^A-Z0-9]/g, ""));

      // Los destinos que nunca necesitaron unidad siguen igual.
      const planta = await vale({ tipo_destino: "planta" });
      expect(planta.status, JSON.stringify(planta.body)).toBe(201);
    } finally {
      await flota("habilitado");
    }
  });

  it("al volver Flota todo reaparece, y la placa escrita se engancha otra vez a su unidad", async () => {
    await flota("deshabilitado");
    await flota("habilitado");
    expect((await filaDelVale())?.placa_codigo).toBe(placa);
    const unidades = await admin.get(`${BASE}/equipos-destino`);
    expect(
      (unidades.body.data as Array<{ placa_codigo: string }>).map((u) => u.placa_codigo)
    ).toContain(placa);
    expect((await conductor.get(`${BASE}/mi-unidad-asignada`)).body.data).toMatchObject({
      equipo_id: equipoId,
    });
    const escrita = await vale({ tipo_destino: "unidad_sin_alta", placa_sin_alta: placa });
    expect(escrita.status, JSON.stringify(escrita.body)).toBe(201);
    expect(escrita.body.tipo_destino).toBe("equipo");
    expect(escrita.body.equipo_id).toBe(equipoId);
  });
});
