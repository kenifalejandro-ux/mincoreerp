/** tests/combustible-despachos.test.ts
 *
 * Fase B de combustible (ver docs/architecture/control-de-combustible.md,
 * puntos 1, 2 y 5, y migrations/0062). Cubre lo que el prompt cerrado de
 * ejecución pidió como criterio de terminado: happy path de los dos
 * orígenes, el 409 de vale duplicado, el 400 de contómetro, la validación
 * de tipo_medidor por equipo, y el motor de huecos (punto 1) como consulta
 * bajo demanda -- sin conciliación, sin anomalías, sin anulación (Fase D).
 *
 * Suma el catálogo de grifos + precios (migrations/0063): grifo_id
 * reemplaza al texto libre grifo_externo, costo_unitario es obligatorio en
 * los dos orígenes, y el "precio vigente" se resuelve a una fecha concreta
 * ignorando los precios anulados.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";

/** `serie_talonario` tiene 20 caracteres máximo (real: "A", "SERIE-2026-03") --
 *  `idUnico()` sola (con su timestamp completo) se pasa de largo, así que
 *  las series de este archivo usan un sufijo corto en vez de esa función. */
function serieUnica(): string {
  return `S${Math.floor(Math.random() * 1e8).toString(36)}`;
}

async function crearTanque(tenantId: string, capacidadTotal = 5000): Promise<number> {
  return withTenant(tenantId, async (client) => {
    const fila = await client.query(
      `INSERT INTO combustible (
         tenant_id, codigo, tanque_nombre, tipo_combustible, unidad, tipo_punto, capacidad_total
       )
       VALUES ($1, $2, 'Tanque despachos', 'diesel_b5', 'gal', 'fijo', $3) RETURNING id`,
      [tenantId, idUnico("TQ"), capacidadTotal]
    );
    return fila.rows[0].id;
  });
}

describe("combustible: despachos (Fase B)", () => {
  let tenantId: string;
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);

  let tanqueId: number;
  let equipoVolquete: number; // tipo_medidor = horometro
  let equipoTrailer: number; // tipo_medidor = odometro
  let equipoSinMedidor: number; // tipo_medidor sin configurar
  let grifoId: number;

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });

    tanqueId = await crearTanque(tenantId);

    const volquete = await agente
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("VQ"), tipo: "VOLQUETE", tipo_medidor: "horometro" });
    equipoVolquete = volquete.body.id;

    const trailer = await agente
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("TR"), tipo: "TRAILER", tipo_medidor: "odometro" });
    equipoTrailer = trailer.body.id;

    const sinMedidor = await agente
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("CM"), tipo: "CAMIONETA" });
    equipoSinMedidor = sinMedidor.body.id;

    const grifo = await agente
      .post("/api/erp/combustible/grifos")
      .send({ nombre: idUnico("PRIMAX") });
    grifoId = grifo.body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  function payloadTanquePropio(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      origen: "tanque_propio",
      combustible_id: tanqueId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipoVolquete,
      serie_talonario: serieUnica(),
      n_vale: 1,
      cantidad: 35,
      lectura_contometro: 35,
      costo_unitario: 16.8,
      despachado_en: new Date().toISOString(),
      ...overrides,
    };
  }

  /** Forma NUEVA (0109): comprobante del proveedor, sin vale. Es la que
   *  manda el frontend desde que la compra externa dejó de fingir que tenía
   *  un talonario. */
  function payloadCompra(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      origen: "compra_externa",
      grifo_id: grifoId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipoVolquete,
      comprobante_tipo: "boleta",
      comprobante_numero: `B001-${Math.floor(Math.random() * 1e8)}`,
      cantidad: 40,
      lectura_horometro: 9707,
      horas_abastecidas: 12,
      costo_unitario: 17.5,
      despachado_en: new Date().toISOString(),
      ...overrides,
    };
  }

  /** Forma ANTERIOR, con vale. Se conserva en los tests porque la API la
   *  sigue aceptando a propósito: en la cola offline puede haber despachos
   *  armados por la app vieja, y descartarlos sería perder un despacho real
   *  (ver el comentario del superRefine en combustible.schema.ts). */
  function payloadCompraExterna(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      origen: "compra_externa",
      grifo_id: grifoId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipoVolquete,
      serie_talonario: serieUnica(),
      n_vale: 1,
      cantidad: 40,
      lectura_horometro: 9707,
      horas_abastecidas: 12,
      costo_unitario: 17.5,
      despachado_en: new Date().toISOString(),
      ...overrides,
    };
  }

  it("happy path tanque_propio: crea el despacho con 201 y calcula costo_total", async () => {
    const res = await agente
      .post("/api/erp/combustible/despachos")
      .send(payloadTanquePropio({ cantidad: 35, costo_unitario: 16.8 }));
    expect(res.status).toBe(201);
    expect(res.body.origen).toBe("tanque_propio");
    expect(Number(res.body.combustible_id)).toBe(tanqueId);
    expect(res.body.lectura_horometro).toBeNull();
    // 35 * 16.8 = 588 -- calculado en la respuesta, nunca guardado aparte.
    expect(Number(res.body.costo_total)).toBeCloseTo(588, 2);
  });

  it("happy path compra_externa con horómetro: crea el despacho con 201", async () => {
    const res = await agente
      .post("/api/erp/combustible/despachos")
      .send(payloadCompraExterna({ equipo_id: equipoVolquete }));
    expect(res.status).toBe(201);
    expect(res.body.origen).toBe("compra_externa");
    expect(res.body.combustible_id).toBeNull();
    expect(Number(res.body.lectura_horometro)).toBe(9707);
  });

  it("happy path compra_externa con odómetro (equipo medido por km): 201", async () => {
    const res = await agente.post("/api/erp/combustible/despachos").send(
      payloadCompraExterna({
        equipo_id: equipoTrailer,
        lectura_horometro: undefined,
        lectura_odometro: 31197.7,
      })
    );
    expect(res.status).toBe(201);
    expect(Number(res.body.lectura_odometro)).toBe(31197.7);
  });

  it("409: el mismo N°VALE en la misma serie no se puede repetir", async () => {
    const serie = serieUnica();
    const primero = await agente
      .post("/api/erp/combustible/despachos")
      .send(payloadTanquePropio({ serie_talonario: serie, n_vale: 7 }));
    expect(primero.status).toBe(201);

    const repetido = await agente.post("/api/erp/combustible/despachos").send(
      payloadTanquePropio({
        serie_talonario: serie,
        n_vale: 7,
        cantidad: 20,
        lectura_contometro: 20,
      })
    );
    expect(repetido.status).toBe(409);
  });

  it("el mismo N°VALE SÍ puede repetirse en una serie DISTINTA", async () => {
    const a = await agente
      .post("/api/erp/combustible/despachos")
      .send(payloadTanquePropio({ serie_talonario: serieUnica(), n_vale: 3 }));
    const b = await agente
      .post("/api/erp/combustible/despachos")
      .send(payloadTanquePropio({ serie_talonario: serieUnica(), n_vale: 3 }));
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
  });

  it("400: el contómetro no coincide con la cantidad declarada (tanque_propio)", async () => {
    const res = await agente.post("/api/erp/combustible/despachos").send(
      payloadTanquePropio({
        cantidad: 35,
        lectura_contometro: 53, // transposición de dígitos
      })
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/contómetro/i);
  });

  it("400: compra_externa a un equipo sin tipo_medidor configurado", async () => {
    const res = await agente
      .post("/api/erp/combustible/despachos")
      .send(payloadCompraExterna({ equipo_id: equipoSinMedidor }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tipo de medidor/i);
  });

  it("400: un equipo que mide por horómetro no acepta lectura_odometro", async () => {
    const res = await agente.post("/api/erp/combustible/despachos").send(
      payloadCompraExterna({
        equipo_id: equipoVolquete, // horometro
        lectura_horometro: undefined,
        lectura_odometro: 12345,
      })
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/horómetro/i);
  });

  it("400 (Zod): compra_externa exige tipo_destino='equipo' -- no tiene sentido sin equipo", async () => {
    const res = await agente.post("/api/erp/combustible/despachos").send(
      payloadCompraExterna({
        tipo_destino: "planta",
        equipo_id: undefined,
      })
    );
    expect(res.status).toBe(400);
  });

  it("400 (Zod): tanque_propio sin combustible_id", async () => {
    const res = await agente
      .post("/api/erp/combustible/despachos")
      .send(payloadTanquePropio({ combustible_id: undefined }));
    expect(res.status).toBe(400);
  });

  it("400 (Zod): tipo_destino='equipo' exige equipo_id", async () => {
    const res = await agente
      .post("/api/erp/combustible/despachos")
      .send(payloadTanquePropio({ equipo_id: undefined }));
    expect(res.status).toBe(400);
  });

  it("cliente_uuid repetido no duplica el despacho (cola offline)", async () => {
    const clienteUuid = crypto.randomUUID();
    const cuerpo = payloadTanquePropio({ cliente_uuid: clienteUuid, n_vale: 99 });

    const primera = await agente.post("/api/erp/combustible/despachos").send(cuerpo);
    expect(primera.status).toBe(201);

    const reintento = await agente.post("/api/erp/combustible/despachos").send(cuerpo);
    expect(reintento.status).toBe(200);
    expect(reintento.body.id).toBe(primera.body.id);

    const total = await withTenant(tenantId, (client) =>
      client.query(
        `SELECT COUNT(*)::int AS total FROM combustible_despachos
         WHERE tenant_id = $1 AND serie_talonario = $2 AND n_vale = 99`,
        [tenantId, cuerpo.serie_talonario]
      )
    );
    expect(total.rows[0].total).toBe(1);
  });

  describe("GET /despachos/huecos -- consulta bajo demanda (punto 1)", () => {
    it("detecta el hueco correcto dentro de una serie, sin tocar otras series", async () => {
      const serie = serieUnica();
      for (const nVale of [1, 2, 4]) {
        const res = await agente
          .post("/api/erp/combustible/despachos")
          .send(payloadTanquePropio({ serie_talonario: serie, n_vale: nVale }));
        expect(res.status).toBe(201);
      }

      const huecos = await agente.get(
        `/api/erp/combustible/despachos/huecos?serie_talonario=${serie}`
      );
      expect(huecos.status).toBe(200);
      expect(huecos.body).toEqual({ serie, huecos: [3], ultimo: 4 });
    });

    it("una serie sin ningún vale devuelve huecos vacíos y ultimo null", async () => {
      const res = await agente.get(
        `/api/erp/combustible/despachos/huecos?serie_talonario=${serieUnica()}`
      );
      expect(res.status).toBe(200);
      expect(res.body.huecos).toEqual([]);
      expect(res.body.ultimo).toBeNull();
    });

    it("400 si falta el query param serie_talonario", async () => {
      const res = await agente.get("/api/erp/combustible/despachos/huecos");
      expect(res.status).toBe(400);
    });
  });

  describe("GET /despachos -- listado", () => {
    it("filtra por equipo_id", async () => {
      const serie = serieUnica();
      await agente
        .post("/api/erp/combustible/despachos")
        .send(
          payloadTanquePropio({ serie_talonario: serie, n_vale: 1, equipo_id: equipoVolquete })
        );
      await agente
        .post("/api/erp/combustible/despachos")
        .send(payloadTanquePropio({ serie_talonario: serie, n_vale: 2, equipo_id: equipoTrailer }));

      const res = await agente.get(`/api/erp/combustible/despachos?equipo_id=${equipoTrailer}`);
      expect(res.status).toBe(200);
      expect(
        res.body.data.every((d: { equipo_id: number }) => Number(d.equipo_id) === equipoTrailer)
      ).toBe(true);
      expect(
        res.body.data.some((d: { serie_talonario: string }) => d.serie_talonario === serie)
      ).toBe(true);
    });
  });

  describe("Grifos externos (migrations/0063)", () => {
    it("admin puede crear un grifo y aparece en el listado", async () => {
      const nombre = idUnico("VELASQUEZ");
      const res = await agente.post("/api/erp/combustible/grifos").send({ nombre });
      expect(res.status).toBe(201);
      expect(res.body.nombre).toBe(nombre);
      expect(res.body.activo).toBe(true);

      const listado = await agente.get("/api/erp/combustible/grifos");
      expect(listado.status).toBe(200);
      expect(listado.body.some((g: { id: number }) => g.id === res.body.id)).toBe(true);
    });

    it("409: no se puede repetir el nombre de un grifo en el mismo tenant", async () => {
      const nombre = idUnico("REPETIDO");
      const primero = await agente.post("/api/erp/combustible/grifos").send({ nombre });
      expect(primero.status).toBe(201);

      const repetido = await agente.post("/api/erp/combustible/grifos").send({ nombre });
      expect(repetido.status).toBe(409);
    });

    it("un despacho de compra_externa exige grifo_id (400 si falta)", async () => {
      const res = await agente
        .post("/api/erp/combustible/despachos")
        .send(payloadCompraExterna({ grifo_id: undefined }));
      expect(res.status).toBe(400);
    });
  });

  describe("Precios de combustible (migrations/0063)", () => {
    it("autocompletado: el precio vigente es el más reciente <= la fecha pedida, no el de hoy", async () => {
      const combustibleIdPropio = tanqueId;
      const base = Date.now();
      const hace10dias = new Date(base - 10 * 24 * 60 * 60 * 1000).toISOString();
      const hace5dias = new Date(base - 5 * 24 * 60 * 60 * 1000).toISOString();
      const ayer = new Date(base - 1 * 24 * 60 * 60 * 1000).toISOString();

      await agente.post("/api/erp/combustible/precios").send({
        tipo_combustible: "diesel_b5",
        combustible_id: combustibleIdPropio,
        precio_unitario: 15.0,
        vigente_desde: hace10dias,
      });
      await agente.post("/api/erp/combustible/precios").send({
        tipo_combustible: "diesel_b5",
        combustible_id: combustibleIdPropio,
        precio_unitario: 16.8,
        vigente_desde: hace5dias,
      });

      // Vale offline con fecha de ayer: tiene que resolver 16.8 (el
      // vigente A ESA FECHA), no un precio más nuevo que se cargue después.
      const vigenteAyer = await agente.get(
        `/api/erp/combustible/precios/vigente?tipo_combustible=diesel_b5&combustible_id=${combustibleIdPropio}&fecha=${ayer}`
      );
      expect(vigenteAyer.status).toBe(200);
      expect(Number(vigenteAyer.body.precio.precio_unitario)).toBeCloseTo(16.8, 2);

      // A la fecha de hace 10 días, todavía no existía el de 16.8.
      const vigenteHace10 = await agente.get(
        `/api/erp/combustible/precios/vigente?tipo_combustible=diesel_b5&combustible_id=${combustibleIdPropio}&fecha=${hace10dias}`
      );
      expect(Number(vigenteHace10.body.precio.precio_unitario)).toBeCloseTo(15.0, 2);
    });

    it("sin ningún precio cargado, 'vigente' devuelve null (no es error)", async () => {
      const otroTanque = await crearTanque(tenantId);
      const res = await agente.get(
        `/api/erp/combustible/precios/vigente?tipo_combustible=glp&combustible_id=${otroTanque}&fecha=${new Date().toISOString()}`
      );
      expect(res.status).toBe(200);
      expect(res.body.precio).toBeNull();
    });

    it("400 (Zod): un precio va exactamente a un tanque o a un grifo, nunca los dos ni ninguno", async () => {
      const ninguno = await agente.post("/api/erp/combustible/precios").send({
        tipo_combustible: "diesel_b5",
        precio_unitario: 16.8,
      });
      expect(ninguno.status).toBe(400);

      const losDos = await agente.post("/api/erp/combustible/precios").send({
        tipo_combustible: "diesel_b5",
        combustible_id: tanqueId,
        grifo_id: grifoId,
        precio_unitario: 16.8,
      });
      expect(losDos.status).toBe(400);
    });

    it("anular un precio: el 'vigente' cae al anterior no anulado, no queda en null", async () => {
      const otroGrifo = await agente
        .post("/api/erp/combustible/grifos")
        .send({ nombre: idUnico("ANULACION") });

      const viejo = await agente.post("/api/erp/combustible/precios").send({
        tipo_combustible: "diesel_b5",
        grifo_id: otroGrifo.body.id,
        precio_unitario: 17.0,
        vigente_desde: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      });
      const nuevoMalCargado = await agente.post("/api/erp/combustible/precios").send({
        tipo_combustible: "diesel_b5",
        grifo_id: otroGrifo.body.id,
        precio_unitario: 999, // typo real: sobraba un dígito
      });
      expect(nuevoMalCargado.status).toBe(201);

      const anulacion = await agente
        .patch(`/api/erp/combustible/precios/${nuevoMalCargado.body.id}/anular`)
        .send({ motivo: "se tipeó 999 en vez de 17.9" });
      expect(anulacion.status).toBe(200);
      expect(anulacion.body.anulada_en).not.toBeNull();

      const vigente = await agente.get(
        `/api/erp/combustible/precios/vigente?tipo_combustible=diesel_b5&grifo_id=${otroGrifo.body.id}&fecha=${new Date().toISOString()}`
      );
      // El anulado (999) queda descartado -- cae al anterior válido (17.0),
      // no al viejo... y NO devuelve null como si no hubiera ninguno.
      expect(Number(vigente.body.precio.precio_unitario)).toBeCloseTo(17.0, 2);
      expect(Number(vigente.body.precio.id)).toBe(Number(viejo.body.id));
    });

    it("409: un precio ya anulado no se puede volver a anular", async () => {
      const precio = await agente.post("/api/erp/combustible/precios").send({
        tipo_combustible: "diesel_b5",
        combustible_id: tanqueId,
        precio_unitario: 16.5,
      });
      const primeraAnulacion = await agente
        .patch(`/api/erp/combustible/precios/${precio.body.id}/anular`)
        .send({ motivo: "correccion" });
      expect(primeraAnulacion.status).toBe(200);

      const segundaAnulacion = await agente
        .patch(`/api/erp/combustible/precios/${precio.body.id}/anular`)
        .send({ motivo: "de nuevo" });
      expect(segundaAnulacion.status).toBe(409);
    });

    it("un despacho compra_externa acepta el costo_unitario editado a mano, sin importar el catálogo", async () => {
      // El autocompletado es responsabilidad del FRONTEND -- el endpoint de
      // despachos nunca resuelve precio por su cuenta, solo exige el campo.
      const res = await agente
        .post("/api/erp/combustible/despachos")
        .send(payloadCompraExterna({ costo_unitario: 18.35 }));
      expect(res.status).toBe(201);
      expect(Number(res.body.costo_unitario)).toBeCloseTo(18.35, 2);
      expect(Number(res.body.costo_total)).toBeCloseTo(40 * 18.35, 2);
    });
  });

  describe("comprobante del proveedor (0109)", () => {
    it("happy path: compra con boleta, sin vale -- 201 y la fila no tiene talonario", async () => {
      const res = await agente.post("/api/erp/combustible/despachos").send(payloadCompra());
      expect(res.status).toBe(201);
      expect(res.body.origen).toBe("compra_externa");
      expect(res.body.comprobante_tipo).toBe("boleta");
      expect(res.body.serie_talonario).toBeNull();
      expect(res.body.n_vale).toBeNull();
    });

    it("sin comprobante y sin vale: 400 -- la compra tiene que poder identificarse", async () => {
      const res = await agente
        .post("/api/erp/combustible/despachos")
        .send(payloadCompra({ comprobante_tipo: undefined, comprobante_numero: undefined }));
      expect(res.status).toBe(400);
    });

    it("comprobante Y vale juntos: 400 -- son dos formas excluyentes", async () => {
      const res = await agente
        .post("/api/erp/combustible/despachos")
        .send(payloadCompra({ serie_talonario: serieUnica(), n_vale: 7 }));
      expect(res.status).toBe(400);
    });

    it("el tanque propio rechaza el comprobante: es del proveedor de ruta", async () => {
      const res = await agente
        .post("/api/erp/combustible/despachos")
        .send(payloadTanquePropio({ comprobante_tipo: "boleta", comprobante_numero: "B-1" }));
      expect(res.status).toBe(400);
    });

    it("el tanque propio sigue exigiendo el vale", async () => {
      const res = await agente
        .post("/api/erp/combustible/despachos")
        .send(payloadTanquePropio({ serie_talonario: undefined, n_vale: undefined }));
      expect(res.status).toBe(400);
    });

    it("la misma boleta del mismo proveedor dos veces: 400 (red anti-duplicado de la cola offline)", async () => {
      const payload = payloadCompra();
      expect((await agente.post("/api/erp/combustible/despachos").send(payload)).status).toBe(201);
      const res = await agente.post("/api/erp/combustible/despachos").send(payload);
      // 409 y no 400: el dato está bien formado, el papel ya existe. Importa
      // que sea 4xx -- la cola offline descarta en vez de reintentar.
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/ya está registrada/i);
    });

    it("anular libera el comprobante: el mismo papel se puede recargar corregido", async () => {
      const payload = payloadCompra();
      const creado = await agente.post("/api/erp/combustible/despachos").send(payload);
      expect(creado.status).toBe(201);
      const anulado = await agente
        .patch(`/api/erp/combustible/despachos/${creado.body.id}/anular`)
        .send({ motivo: "cantidad mal tipeada" });
      expect(anulado.status).toBe(200);
      const recargado = await agente
        .post("/api/erp/combustible/despachos")
        .send({ ...payload, cantidad: 45 });
      expect(recargado.status).toBe(201);
    });

    it("la misma boleta en OTRO proveedor sí entra: cada grifo numera por su cuenta", async () => {
      const numero = `B001-${Math.floor(Math.random() * 1e8)}`;
      expect(
        (
          await agente
            .post("/api/erp/combustible/despachos")
            .send(payloadCompra({ comprobante_numero: numero }))
        ).status
      ).toBe(201);
      const otroGrifo = await agente
        .post("/api/erp/combustible/grifos")
        .send({ nombre: idUnico("PETROPLUS") });
      const res = await agente
        .post("/api/erp/combustible/despachos")
        .send(payloadCompra({ comprobante_numero: numero, grifo_id: otroGrifo.body.id }));
      expect(res.status).toBe(201);
    });

    it("un tipo de comprobante inventado se rechaza", async () => {
      const res = await agente
        .post("/api/erp/combustible/despachos")
        .send(payloadCompra({ comprobante_tipo: "recibo" }));
      expect(res.status).toBe(400);
    });

    it("una compra sin vale NO entra en la secuencia del talonario", async () => {
      const serie = serieUnica();
      // Dos vales reales del tanque propio, 1 y 2: sin huecos.
      for (const n of [1, 2]) {
        expect(
          (
            await agente
              .post("/api/erp/combustible/despachos")
              .send(payloadTanquePropio({ serie_talonario: serie, n_vale: n }))
          ).status
        ).toBe(201);
      }
      expect(
        (await agente.post("/api/erp/combustible/despachos").send(payloadCompra())).status
      ).toBe(201);
      const huecos = await agente.get(
        `/api/erp/combustible/despachos/huecos?serie_talonario=${serie}`
      );
      expect(huecos.status).toBe(200);
      expect(huecos.body.huecos).toEqual([]);
    });
  });
});
