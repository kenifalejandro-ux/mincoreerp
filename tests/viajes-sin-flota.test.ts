/** tests/viajes-sin-flota.test.ts
 *
 * Un viaje a una unidad ESCRITA A MANO (migración 0193): Viajes trabaja con lo que la empresa tiene
 * contratado, y sin el registro de unidades la unidad del viaje es la placa que se escribe. Lo que
 * se fija:
 *
 * 1. Con Flota todo sigue igual: elegir una unidad crea un viaje con ella; escribir la placa de una
 *    unidad registrada la TOMA (una sola regla, igual que el vale).
 * 2. Una placa que no es de ninguna unidad queda escrita: el viaje se crea, se ve en la lista y en
 *    el detalle con su placa, y se inicia y se cierra sin medidor previo.
 * 3. La unidad es UNA de las dos (el schema lo exige) y el conductor se escribe (no hay unidad de
 *    la que copiarlo): sin su DNI, 400.
 * 4. Una placa no está en dos viajes a la vez, sin importar mayúsculas ni guiones.
 * 5. Sin Flota en la EMPRESA: elegir una unidad registrada es un 400 claro, la placa escrita
 *    funciona, la lista de unidades sale vacía y el viaje se ve sin los datos de la unidad.
 * 6. La placa escrita no se cambia editando el viaje.
 *
 * La sesión se abre CON Flota y después se apaga por SQL: el JWT conserva sus módulos hasta el
 * próximo login, que es justo el caso en que la lectura tiene que decidir sola.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico, dniUnico } from "./helpers";
import { pool, closeDatabase } from "../src/server/config/database";

const PASSWORD = "ClaveDePrueba123";
const BASE = "/api/erp/viajes";
const hora = (min: number) => new Date(Date.now() + min * 60_000).toISOString();

describe("Viajes con la unidad escrita a mano", () => {
  let tenantId: string;
  const admin = request.agent(app);
  let origen: number;
  let destino: number;
  let equipoId: number;
  const placaRegistrada = idUnico("VR").toUpperCase();
  const dni = dniUnico();

  const flota = (estado: "habilitado" | "deshabilitado") =>
    pool.query(`UPDATE tenant_modulos SET estado = $2 WHERE tenant_id = $1 AND modulo = 'flota'`, [
      tenantId,
      estado,
    ]);

  const nuevaPlaca = () => `ZV${Math.floor(Math.random() * 1e6)}`;

  const viaje = (over: Record<string, unknown> = {}) =>
    admin.post(BASE).send({
      origen_id: origen,
      destino_id: destino,
      conductor_nombre: "Conductor Escrito",
      conductor_dni: dni,
      salida_programada_en: hora(90),
      ...over,
    });

  beforeAll(async () => {
    const c = await crearTenantDePrueba(PASSWORD);
    tenantId = c.tenant.id;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: c.tenant.slug, email: c.usuario.email, password: PASSWORD });
    origen = Number(
      (await admin.post(`${BASE}/lugares`).send({ nombre: idUnico("Origen") })).body.id
    );
    destino = Number(
      (await admin.post(`${BASE}/lugares`).send({ nombre: idUnico("Destino") })).body.id
    );
    const eq = await admin.post("/api/erp/equipos").send({
      placa_codigo: placaRegistrada,
      tipo: "VOLQUETE",
      tipo_medidor: "odometro",
      conductor_nombre: "Juan Pérez",
      conductor_dni: dniUnico(),
    });
    expect(eq.status, JSON.stringify(eq.body)).toBe(201);
    equipoId = Number(eq.body.id);
  });

  afterAll(async () => {
    await flota("habilitado");
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  it("CON Flota: elegir una unidad crea el viaje con ella; escribir la placa de una registrada la toma", async () => {
    const elegida = await viaje({ equipo_id: equipoId });
    expect(elegida.status, JSON.stringify(elegida.body)).toBe(201);
    expect(elegida.body.equipo_id).toBe(equipoId);
    expect(elegida.body.placa_sin_alta).toBeNull();

    // La placa escrita de una unidad registrada (con otras mayúsculas y un guion) es ESA unidad.
    const escrita = await viaje({
      placa_sin_alta: `${placaRegistrada.slice(0, 2)}-${placaRegistrada.slice(2).toLowerCase()}`,
      salida_programada_en: hora(200),
    });
    expect(escrita.status, JSON.stringify(escrita.body)).toBe(201);
    expect(escrita.body.equipo_id).toBe(equipoId);
    expect(escrita.body.placa_sin_alta).toBeNull();
  });

  it("una placa que no es de ninguna unidad queda escrita; se lista, se ve, se inicia y se cierra sin medidor previo", async () => {
    const placa = nuevaPlaca();
    const r = await viaje({ placa_sin_alta: placa.toLowerCase() });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.equipo_id).toBeNull();
    expect(r.body.placa_sin_alta).toBe(placa);
    expect(r.body.placa_codigo).toBe(placa);
    const id = r.body.id as number;

    const lista = await admin.get(BASE).query({ producto: "combustible" });
    expect(lista.status, JSON.stringify(lista.body)).toBe(200);
    const fila = lista.body.data.find((v: { id: number }) => v.id === id);
    expect(fila?.placa_codigo).toBe(placa);

    const detalle = await admin.get(`${BASE}/${id}`);
    expect(detalle.status, JSON.stringify(detalle.body)).toBe(200);
    expect(detalle.body.viaje.placa_codigo).toBe(placa);

    // Sin unidad registrada no hay medidor del que partir: ni se pide ni se bloquea.
    const previo = await admin.get(`${BASE}/${id}/medidor-previo`);
    expect(previo.status, JSON.stringify(previo.body)).toBe(200);
    expect(previo.body).toMatchObject({ tipo_medidor: null, valor: null });

    const inicio = await admin
      .post(`${BASE}/${id}/iniciar`)
      .send({ inicio_en: hora(-120), motivo: "Marca de oficina" });
    expect(inicio.status, JSON.stringify(inicio.body)).toBe(200);
    expect(inicio.body.estado).toBe("en_curso");

    const cierre = await admin
      .post(`${BASE}/${id}/cerrar`)
      .send({ fin_en: hora(-60), motivo: "Marca de oficina" });
    expect(cierre.status, JSON.stringify(cierre.body)).toBe(200);
    expect(cierre.body.estado).toBe("cerrado");
  });

  it("la unidad es una de las dos, y el conductor se escribe", async () => {
    const ambas = await viaje({ equipo_id: equipoId, placa_sin_alta: nuevaPlaca() });
    expect(ambas.status).toBe(400);
    const ninguna = await viaje();
    expect(ninguna.status).toBe(400);

    // Sin una unidad de la que copiar el conductor, hay que escribir su DNI.
    const sinDni = await viaje({ placa_sin_alta: nuevaPlaca(), conductor_dni: undefined });
    expect(sinDni.status, JSON.stringify(sinDni.body)).toBe(400);
    expect(JSON.stringify(sinDni.body)).toMatch(/DNI del conductor/);
  });

  it("una placa no está en dos viajes a la vez, sin importar mayúsculas ni guiones", async () => {
    const placa = nuevaPlaca();
    const a = await viaje({ placa_sin_alta: placa });
    const b = await viaje({
      placa_sin_alta: `${placa.slice(0, 3)}-${placa.slice(3).toLowerCase()}`,
      salida_programada_en: hora(300),
    });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    expect(b.body.placa_sin_alta).toBe(placa);

    const inicioA = await admin
      .post(`${BASE}/${a.body.id}/iniciar`)
      .send({ inicio_en: hora(-30), motivo: "Marca de oficina" });
    expect(inicioA.status, JSON.stringify(inicioA.body)).toBe(200);
    const inicioB = await admin
      .post(`${BASE}/${b.body.id}/iniciar`)
      .send({ inicio_en: hora(-10), motivo: "Marca de oficina" });
    expect(inicioB.status, JSON.stringify(inicioB.body)).toBe(409);
    expect(JSON.stringify(inicioB.body)).toMatch(/ya está en el viaje/);
  });

  it("SIN Flota: elegir una unidad registrada da 400, la placa escrita funciona y la lista de unidades sale vacía", async () => {
    await flota("deshabilitado");
    try {
      const elige = await viaje({ equipo_id: equipoId });
      expect(elige.status, JSON.stringify(elige.body)).toBe(400);
      expect(JSON.stringify(elige.body)).toMatch(/no tiene el módulo Flota/);

      // La placa de una unidad vieja NO se toma: sin Flota no se lee `equipos`.
      const escrita = await viaje({
        placa_sin_alta: placaRegistrada,
        salida_programada_en: hora(500),
      });
      expect(escrita.status, JSON.stringify(escrita.body)).toBe(201);
      expect(escrita.body.equipo_id).toBeNull();
      expect(escrita.body.placa_sin_alta).toBe(placaRegistrada.replace(/[^A-Z0-9]/g, ""));

      const unidades = await admin.get(`${BASE}/unidades`).query({ pageSize: 200 });
      expect(unidades.status, JSON.stringify(unidades.body)).toBe(200);
      expect(unidades.body.data).toEqual([]);

      // Un viaje que SÍ tenía unidad registrada se sigue viendo, sin los datos de la unidad.
      const lista = await admin.get(BASE).query({ producto: "combustible" });
      expect(lista.status, JSON.stringify(lista.body)).toBe(200);
      const deLaUnidad = lista.body.data.find(
        (v: { equipo_id: number | null }) => v.equipo_id === equipoId
      );
      expect(deLaUnidad).toBeDefined();
      expect(deLaUnidad.placa_codigo ?? null).toBeNull();
    } finally {
      await flota("habilitado");
    }
  });

  it("la placa escrita no se cambia editando el viaje, pero el resto sí", async () => {
    const r = await viaje({ placa_sin_alta: nuevaPlaca() });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const cambia = await admin
      .put(`${BASE}/${r.body.id}`)
      .send({ equipo_id: equipoId, motivo: "Se equivocó de unidad" });
    expect(cambia.status, JSON.stringify(cambia.body)).toBe(400);
    expect(JSON.stringify(cambia.body)).toMatch(/no se cambia/);

    const nota = await admin
      .put(`${BASE}/${r.body.id}`)
      .send({ observaciones: "Con carga de cal", motivo: "Dato de la oficina" });
    expect(nota.status, JSON.stringify(nota.body)).toBe(200);
    expect(nota.body.observaciones).toBe("Con carga de cal");
    expect(nota.body.placa_sin_alta).toMatch(/^ZV/);
  });
});
