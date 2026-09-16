/** tests/combustible-grifos-roles.test.ts
 *
 * Los dos roles del catálogo de grifos (migrations/0065).
 *
 * `combustible_grifos` nació en Fase B para el grifo de ruta y la Fase C
 * reusó la misma tabla para el proveedor que llena el tanque propio. Como
 * entidad son lo mismo, pero el ROL importa: elegir el grifo equivocado en
 * una recepción atribuye el costo al proveedor que no fue, y de ahí sale
 * `combustible.costo_promedio`.
 *
 * Lo que se cubre acá, además de los defaults y la persistencia: que el
 * rechazo viva en el SERVIDOR. El filtro de los desplegables es comodidad --
 * una llamada directa a la API, o un frontend con el estado viejo en memoria,
 * tienen que chocar con la misma pared.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase } from "../src/server/config/database";

describe("combustible: roles del catálogo de grifos (migrations/0065)", () => {
  let tenantId: string;
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);

  let tanqueId: number;
  let equipoId: number;

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });

    // Por la API para que quede con su lectura `inicial` -- sin nivel medido
    // toda recepción se rechazaría antes de llegar a la validación de rol.
    const tanque = await agente.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque roles",
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_punto: "fijo",
      capacidad_total: 10000,
      nivel_actual: 1000,
    });
    tanqueId = tanque.body.id;

    const equipo = await agente
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("VQ"), tipo: "VOLQUETE", tipo_medidor: "horometro" });
    equipoId = equipo.body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  function crearGrifo(overrides: Record<string, unknown> = {}) {
    return agente
      .post("/api/erp/combustible/grifos")
      .send({ nombre: idUnico("GRIFO"), ...overrides });
  }

  function payloadRecepcion(grifoId: number, overrides: Record<string, unknown> = {}) {
    return {
      combustible_id: tanqueId,
      grifo_id: grifoId,
      cantidad: 100,
      costo_unitario: 16.5,
      tipo_documento: "factura",
      numero_documento: idUnico("F001"),
      recibido_en: new Date().toISOString(),
      ...overrides,
    };
  }

  function payloadDespachoExterno(grifoId: number, overrides: Record<string, unknown> = {}) {
    return {
      origen: "compra_externa",
      grifo_id: grifoId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipoId,
      serie_talonario: `S${Math.floor(Math.random() * 1e8).toString(36)}`,
      n_vale: 1,
      cantidad: 30,
      lectura_horometro: 1200,
      horas_abastecidas: 8,
      costo_unitario: 17,
      despachado_en: new Date().toISOString(),
      ...overrides,
    };
  }

  // ── Defaults y persistencia ───────────────────────────────────────────

  it("crear un grifo sin enviar los flags lo deja sirviendo para los dos roles", async () => {
    // Es lo que hace que la migración no rompa nada: todo grifo que ya existía
    // servía para todo, y sigue sirviendo para todo.
    const res = await crearGrifo();
    expect(res.status).toBe(201);
    expect(res.body.abastece_ruta).toBe(true);
    expect(res.body.abastece_tanque).toBe(true);
  });

  it("crea y edita un grifo con un solo rol", async () => {
    const creado = await crearGrifo({ abastece_ruta: false, abastece_tanque: true });
    expect(creado.status).toBe(201);
    expect(creado.body.abastece_ruta).toBe(false);
    expect(creado.body.abastece_tanque).toBe(true);

    const editado = await agente.put(`/api/erp/combustible/grifos/${creado.body.id}`).send({
      nombre: creado.body.nombre,
      activo: true,
      abastece_ruta: true,
      abastece_tanque: false,
      abastece_urea: false,
    });
    expect(editado.status).toBe(200);
    expect(editado.body.abastece_ruta).toBe(true);
    expect(editado.body.abastece_tanque).toBe(false);
  });

  it("el PUT exige los dos flags -- omitirlos es 400, no 'dejalos como estaban'", async () => {
    // Mismo criterio que el resto del módulo: el PUT reemplaza la fila entera.
    // Este test existe porque el toggle de activo/desactivado del frontend
    // mandaba solo { nombre, activo } y habría empezado a fallar en silencio.
    const creado = await crearGrifo();
    const res = await agente
      .put(`/api/erp/combustible/grifos/${creado.body.id}`)
      .send({ nombre: creado.body.nombre, activo: false });
    expect(res.status).toBe(400);
  });

  it("el listado del ABM devuelve TODOS los grifos, de cualquier rol", async () => {
    const soloRuta = await crearGrifo({ abastece_ruta: true, abastece_tanque: false });
    const soloTanque = await crearGrifo({ abastece_ruta: false, abastece_tanque: true });

    const listado = await agente.get("/api/erp/combustible/grifos");
    expect(listado.status).toBe(200);
    const ids = listado.body.map((g: { id: number }) => g.id);
    // El ABM tiene que poder administrar los dos: el filtro por rol es cosa de
    // cada desplegable, no del endpoint.
    expect(ids).toContain(soloRuta.body.id);
    expect(ids).toContain(soloTanque.body.id);
  });

  // ── El rechazo vive en el servidor ────────────────────────────────────

  it("rechaza una recepción cuyo grifo no abastece el tanque", async () => {
    const soloRuta = await crearGrifo({ abastece_ruta: true, abastece_tanque: false });

    const res = await agente
      .post("/api/erp/combustible/recepciones")
      .send(payloadRecepcion(soloRuta.body.id));

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("no está marcado como proveedor de tanque");
  });

  it("rechaza un despacho de compra externa cuyo grifo no abastece en ruta", async () => {
    const soloTanque = await crearGrifo({ abastece_ruta: false, abastece_tanque: true });

    const res = await agente
      .post("/api/erp/combustible/despachos")
      .send(payloadDespachoExterno(soloTanque.body.id));

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("no está marcado como grifo de ruta");
  });

  it("un grifo con los dos roles sirve para recepción Y para despacho", async () => {
    const ambos = await crearGrifo({ abastece_ruta: true, abastece_tanque: true });

    const recepcion = await agente
      .post("/api/erp/combustible/recepciones")
      .send(payloadRecepcion(ambos.body.id));
    expect(recepcion.status).toBe(201);

    const despacho = await agente
      .post("/api/erp/combustible/despachos")
      .send(payloadDespachoExterno(ambos.body.id));
    expect(despacho.status).toBe(201);
  });

  it("desmarcar el rol NO invalida lo ya registrado con ese grifo", async () => {
    // Cambiar la ficha es una corrección hacia adelante, no una reescritura de
    // la historia: los movimientos viejos siguen apuntando a su proveedor real
    // (mismo criterio que el resto del módulo -- nada se borra ni se reescribe).
    const grifo = await crearGrifo({ abastece_ruta: true, abastece_tanque: true });
    const recepcion = await agente
      .post("/api/erp/combustible/recepciones")
      .send(payloadRecepcion(grifo.body.id));
    expect(recepcion.status).toBe(201);

    await agente.put(`/api/erp/combustible/grifos/${grifo.body.id}`).send({
      nombre: grifo.body.nombre,
      activo: true,
      abastece_ruta: true,
      abastece_tanque: false,
      abastece_urea: false,
    });

    const listado = await agente
      .get("/api/erp/combustible/recepciones")
      .query({ combustible_id: tanqueId });
    const sigue = listado.body.data.find(
      (r: { id: number }) => String(r.id) === String(recepcion.body.id)
    );
    expect(sigue).toBeDefined();
    expect(sigue.grifo_nombre).toBe(grifo.body.nombre);

    // Pero una recepción NUEVA con ese grifo ya no entra.
    const nueva = await agente
      .post("/api/erp/combustible/recepciones")
      .send(payloadRecepcion(grifo.body.id));
    expect(nueva.status).toBe(400);
  });

  it("un grifo inexistente sigue dando 400 en los dos caminos", async () => {
    const recepcion = await agente
      .post("/api/erp/combustible/recepciones")
      .send(payloadRecepcion(999999999));
    expect(recepcion.status).toBe(400);
    expect(recepcion.body.error).toContain("no existe en este tenant");

    const despacho = await agente
      .post("/api/erp/combustible/despachos")
      .send(payloadDespachoExterno(999999999));
    expect(despacho.status).toBe(400);
  });

  // ── RLS ───────────────────────────────────────────────────────────────

  it("un tenant no ve los grifos de otro", async () => {
    const propio = await crearGrifo({ abastece_ruta: false, abastece_tanque: true });

    const otro = await crearTenantDePrueba(password);
    const agenteOtro = request.agent(app);
    await agenteOtro
      .post("/api/auth/login")
      .send({ tenantSlug: otro.tenant.slug, email: otro.usuario.email, password });

    try {
      const listado = await agenteOtro.get("/api/erp/combustible/grifos");
      expect(listado.status).toBe(200);
      const ids = listado.body.map((g: { id: number }) => g.id);
      expect(ids).not.toContain(propio.body.id);

      // Y no puede editarlo aunque sepa el id.
      const intento = await agenteOtro.put(`/api/erp/combustible/grifos/${propio.body.id}`).send({
        nombre: "Robado",
        activo: true,
        abastece_ruta: true,
        abastece_tanque: true,
        abastece_urea: true,
      });
      expect(intento.status).toBe(404);
    } finally {
      await borrarTenantDePrueba(otro.tenant.id);
    }
  });
});
