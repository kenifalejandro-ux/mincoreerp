/** tests/combustible-excedente-placa-escrita.test.ts
 *
 * El excedente de la recepción a una unidad ESCRITA A MANO (migración 0195). Una empresa sin Flota,
 * o con una unidad que la oficina aún no registró, escribe la placa; el excedente también. Hay dos
 * caminos y los dos se fijan:
 *
 *   A. Una línea del reparto con destino 'equipo' lleva la placa, y el vale que la regulariza tiene
 *      que ser de la MISMA unidad (la misma placa escrita).
 *   B. Lo que se quedó en la cisterna se reparte con vales: uno a una unidad escrita es válido.
 *
 * Y la regla de siempre: con Flota, una placa que es de una unidad registrada la toma; sin Flota en
 * la EMPRESA no se lee `equipos` (elegir una unidad registrada da un 400 claro).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { pool, closeDatabase } from "../src/server/config/database";

const PASSWORD = "ClaveDePrueba123";
const C = "/api/erp/combustible";

describe("excedente de la recepción a una unidad escrita a mano", () => {
  let tenantId: string;
  const admin = request.agent(app);
  let proveedor: number;
  let principal: number;
  let equipoId: number;
  const placaRegistrada = idUnico("EX").toUpperCase();
  let nVale = 3000;

  // «Sin Flota» es sin ningún módulo que mantenga unidades: también se apaga Mantenimiento, que
  // (como Flota) las ofrece. Con Mantenimiento solo se prueba en combustible-con-mantenimiento.test.ts.
  const flota = (estado: "habilitado" | "deshabilitado") =>
    pool.query(
      `UPDATE tenant_modulos SET estado = $2 WHERE tenant_id = $1 AND modulo IN ('flota', 'mantenimiento')`,
      [tenantId, estado]
    );
  const nuevaPlaca = () => `ZE${Math.floor(Math.random() * 1e6)}`;

  /** Un tanque lleno y flexible: toda la recepción es excedente. */
  const recepcion = async (reparto: Record<string, unknown>[], cantidad = 200) => {
    const t = await admin.post(C).send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque excedente",
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
    return admin.post(`${C}/recepciones`).send({
      combustible_id: t.body.id,
      grifo_id: proveedor,
      cantidad,
      costo_unitario: 16.5,
      recibido_en: new Date().toISOString(),
      reparto_excedente: reparto,
    });
  };

  const pendienteDe = async (recepcionId: number) =>
    (
      (await admin.get(`${C}/despachos/excedentes-pendientes`)).body as {
        id: string;
        recepcion_id: string;
        equipo_id: number | null;
        equipo: string | null;
      }[]
    ).find((p) => Number(p.recepcion_id) === Number(recepcionId));

  const vale = (lineaId: number, over: Record<string, unknown>, cantidad = 200) =>
    admin.post(`${C}/despachos`).send({
      origen: "excedente_recepcion",
      excedente_linea_id: lineaId,
      tipo_combustible: "diesel_b5",
      serie_talonario: "EXC",
      n_vale: nVale++,
      cantidad,
      costo_unitario: 1,
      ...over,
    });

  beforeAll(async () => {
    const c = await crearTenantDePrueba(PASSWORD);
    tenantId = c.tenant.id;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: c.tenant.slug, email: c.usuario.email, password: PASSWORD });
    proveedor = (await admin.post(`${C}/grifos`).send({ nombre: idUnico("CISTERNA") })).body.id;
    principal = (await admin.get("/api/erp/sedes")).body.sedes[0].grifos[0].id;
    const eq = await admin.post("/api/erp/equipos").send({
      placa_codigo: placaRegistrada,
      tipo: "VOLQUETE",
      tipo_medidor: "horometro",
      grifo_interno_id: principal,
    });
    expect(eq.status, JSON.stringify(eq.body)).toBe(201);
    equipoId = Number(eq.body.id);
  });

  afterAll(async () => {
    await flota("habilitado");
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  it("A: una línea del reparto a una placa escrita se regulariza con el vale de esa misma placa", async () => {
    const placa = nuevaPlaca();
    const rec = await recepcion([{ destino: "equipo", cantidad: 200, placa_sin_alta: placa }]);
    expect(rec.status, JSON.stringify(rec.body)).toBe(201);
    const pendiente = await pendienteDe(rec.body.id);
    expect(pendiente).toBeDefined();
    expect(pendiente?.equipo_id).toBeNull();
    expect(pendiente?.equipo).toBe(placa);

    // Otra placa no regulariza esa línea.
    const otra = await vale(Number(pendiente!.id), {
      tipo_destino: "unidad_sin_alta",
      placa_sin_alta: nuevaPlaca(),
    });
    expect(otra.status, JSON.stringify(otra.body)).toBe(400);
    expect(JSON.stringify(otra.body)).toMatch(/es para la unidad/);

    const ok = await vale(Number(pendiente!.id), {
      tipo_destino: "unidad_sin_alta",
      placa_sin_alta: placa,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.equipo_id).toBeNull();
    expect(ok.body.placa_sin_alta).toBe(placa);
    expect(await pendienteDe(rec.body.id)).toBeUndefined();
  });

  it("A: con Flota, la placa de una unidad registrada la toma, y la línea es de esa unidad", async () => {
    const rec = await recepcion([
      {
        destino: "equipo",
        cantidad: 200,
        placa_sin_alta: `${placaRegistrada.slice(0, 2)}-${placaRegistrada.slice(2).toLowerCase()}`,
      },
    ]);
    expect(rec.status, JSON.stringify(rec.body)).toBe(201);
    const pendiente = await pendienteDe(rec.body.id);
    expect(pendiente?.equipo_id).toBe(equipoId);
    expect(pendiente?.equipo).toBe(placaRegistrada);
  });

  it("A: la unidad de la línea es una de las dos, y solo el destino 'equipo' la lleva", async () => {
    const ambas = await recepcion([
      { destino: "equipo", cantidad: 200, equipo_id: equipoId, placa_sin_alta: nuevaPlaca() },
    ]);
    expect(ambas.status, JSON.stringify(ambas.body)).toBe(400);
    const aCisterna = await recepcion([
      { destino: "cisterna", cantidad: 200, placa_sin_alta: nuevaPlaca() },
    ]);
    expect(aCisterna.status, JSON.stringify(aCisterna.body)).toBe(400);
  });

  it("B: lo que quedó en la cisterna se reparte a una unidad escrita, y la salida muestra su placa", async () => {
    const rec = await recepcion([{ destino: "cisterna", cantidad: 200 }]);
    expect(rec.status, JSON.stringify(rec.body)).toBe(201);
    const cisternas = (await admin.get(`${C}/despachos/cisternas-con-saldo`)).body as {
      id: string;
      recepcion_id: string;
    }[];
    const linea = cisternas.find((c) => Number(c.recepcion_id) === Number(rec.body.id));
    expect(linea).toBeDefined();

    const placa = nuevaPlaca();
    const salida = await vale(
      Number(linea!.id),
      { tipo_destino: "unidad_sin_alta", placa_sin_alta: placa },
      80
    );
    expect(salida.status, JSON.stringify(salida.body)).toBe(201);
    expect(salida.body.equipo_id).toBeNull();

    const lista = await admin.get(`${C}/despachos/cisternas`).query({ estado: "saldo" });
    expect(lista.status, JSON.stringify(lista.body).slice(0, 300)).toBe(200);
    const texto = JSON.stringify(lista.body);
    expect(texto).toContain(placa);
    expect(texto).toMatch(/"tipo":"unidad"/);
  });

  it("SIN Flota: elegir una unidad registrada da 400, la placa escrita funciona y no se toma la unidad vieja", async () => {
    await flota("deshabilitado");
    try {
      const elige = await recepcion([{ destino: "equipo", cantidad: 200, equipo_id: equipoId }]);
      expect(elige.status, JSON.stringify(elige.body)).toBe(400);
      expect(JSON.stringify(elige.body)).toMatch(/no tiene el módulo Flota/);

      const rec = await recepcion([
        { destino: "equipo", cantidad: 200, placa_sin_alta: placaRegistrada },
      ]);
      expect(rec.status, JSON.stringify(rec.body)).toBe(201);
      const pendiente = await pendienteDe(rec.body.id);
      expect(pendiente?.equipo_id).toBeNull();
      expect(pendiente?.equipo).toBe(placaRegistrada.replace(/[^A-Z0-9]/g, ""));

      const ok = await vale(Number(pendiente!.id), {
        tipo_destino: "unidad_sin_alta",
        placa_sin_alta: placaRegistrada,
      });
      expect(ok.status, JSON.stringify(ok.body)).toBe(201);
      expect(ok.body.equipo_id).toBeNull();
    } finally {
      await flota("habilitado");
    }
  });
});
