/** tests/combustible-recepciones.test.ts
 *
 * Fase C de combustible (ver docs/architecture/control-de-combustible.md,
 * fila C de la hoja de ruta, y migrations/0064). Cubre lo que el prompt
 * cerrado de ejecución pidió como criterio de terminado:
 *
 *   - happy path: la recepción escribe `combustible.costo_promedio`
 *   - segunda recepción a otro costo -> promedio PONDERADO con el nivel
 *     medido, no un promedio simple
 *   - anulación -> replay completo, el promedio vuelve al valor anterior
 *   - bloqueo por capacidad, con y sin tolerancia
 *   - documento obligatorio según `combustible.requiere_documento`
 *   - grifo inexistente
 *   - aislamiento por tenant (RLS)
 *
 * Y una regla que NO estaba en el prompt pero salió de leer el código: si el
 * tanque no tiene lectura vigente anterior a la fecha de la recepción, se
 * rechaza en vez de asumir nivel 0 -- ver el comentario de
 * `validarRecepcion` en combustible.service.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";

/** Lee el costo promedio directo de la base -- lo que interesa verificar es
 *  la columna, no cómo la presenta el endpoint. */
async function costoPromedio(tenantId: string, combustibleId: number): Promise<number> {
  return withTenant(tenantId, async (client) => {
    const fila = await client.query<{ costo_promedio: string }>(
      `SELECT costo_promedio FROM combustible WHERE id = $1 AND tenant_id = $2`,
      [combustibleId, tenantId]
    );
    return Number(fila.rows[0].costo_promedio);
  });
}

describe("combustible: recepciones y costo ponderado (Fase C)", () => {
  let tenantId: string;
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);

  let grifoId: number;

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });

    const grifo = await agente
      .post("/api/erp/combustible/grifos")
      .send({ nombre: idUnico("CISTERNA") });
    grifoId = grifo.body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  /** Crea un tanque por la API (no con INSERT crudo): así queda con su
   *  lectura `origen='inicial'`, que es lo que le da nivel medido -- sin
   *  ella toda recepción se rechazaría (ver el test de "sin lectura
   *  vigente"). Ojo con esto al escribir tests nuevos de este módulo. */
  async function crearTanque(overrides: Partial<Record<string, unknown>> = {}) {
    const res = await agente.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque recepciones",
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_punto: "fijo",
      capacidad_total: 10000,
      nivel_actual: 1000,
      ...overrides,
    });
    expect(res.status).toBe(201);
    return res.body.id as number;
  }

  function payloadRecepcion(combustibleId: number, overrides: Record<string, unknown> = {}) {
    return {
      combustible_id: combustibleId,
      grifo_id: grifoId,
      cantidad: 500,
      costo_unitario: 16.5,
      tipo_documento: "factura",
      numero_documento: idUnico("F001"),
      recibido_en: new Date().toISOString(),
      ...overrides,
    };
  }

  // ── Costo ponderado ───────────────────────────────────────────────────

  it("la primera recepción FIJA el costo promedio en su propio costo unitario", async () => {
    const tanqueId = await crearTanque();
    // El tanque arranca con 1.000 gal de costo desconocido: no hay con qué
    // ponderar, así que la primera compra conocida define el promedio. Si
    // en vez de eso se partiera de promedio=0 y se aplicara la fórmula, el
    // resultado sería (1000*0 + 500*16.5)/1500 = 5.5 -- un número sin
    // significado. Ver recalcularCostoPromedio en el repository.
    const res = await agente
      .post("/api/erp/combustible/recepciones")
      .send(payloadRecepcion(tanqueId, { cantidad: 500, costo_unitario: 16.5 }));

    expect(res.status).toBe(201);
    expect(await costoPromedio(tenantId, tanqueId)).toBeCloseTo(16.5, 4);
  });

  it("la segunda recepción pondera contra el nivel MEDIDO, no contra la suma de recepciones", async () => {
    const tanqueId = await crearTanque({ nivel_actual: 1000 });

    const primera = await agente
      .post("/api/erp/combustible/recepciones")
      .send(payloadRecepcion(tanqueId, { cantidad: 500, costo_unitario: 10 }));
    expect(primera.status).toBe(201);
    expect(await costoPromedio(tenantId, tanqueId)).toBeCloseTo(10, 4);

    // Nueva lectura de varilla: el nivel medido pasa a 1.400 (bajó por
    // consumo). El ponderado de la segunda recepción tiene que usar ESE
    // 1.400, no "1.000 + 500 recibidos" -- registrar una recepción no mueve
    // el nivel, es la varilla la que manda (migración 0059).
    const lectura = await agente
      .post("/api/erp/combustible/lecturas")
      .send({ combustible_id: tanqueId, nivel: 1400 });
    expect(lectura.status).toBe(201);

    const segunda = await agente
      .post("/api/erp/combustible/recepciones")
      .send(payloadRecepcion(tanqueId, { cantidad: 600, costo_unitario: 20 }));
    expect(segunda.status).toBe(201);

    // (1400 * 10 + 600 * 20) / 2000 = 26000 / 2000 = 13
    expect(await costoPromedio(tenantId, tanqueId)).toBeCloseTo(13, 4);
  });

  it("registrar una recepción NO mueve el nivel del tanque", async () => {
    const tanqueId = await crearTanque({ nivel_actual: 800 });

    const antes = await agente.get(`/api/erp/combustible/${tanqueId}`);
    expect(Number(antes.body.nivel_actual)).toBe(800);

    const res = await agente
      .post("/api/erp/combustible/recepciones")
      .send(payloadRecepcion(tanqueId, { cantidad: 500 }));
    expect(res.status).toBe(201);

    // El nivel sigue siendo el medido con varilla. Es deliberado: si una
    // declaración de papel moviera el nivel, el tanque nunca podría delatar
    // una fuga real (ver el encabezado de migrations/0064).
    const despues = await agente.get(`/api/erp/combustible/${tanqueId}`);
    expect(Number(despues.body.nivel_actual)).toBe(800);
  });

  // ── Anulación y replay ────────────────────────────────────────────────

  it("anular la última recepción devuelve el promedio al valor anterior (replay)", async () => {
    const tanqueId = await crearTanque({ nivel_actual: 1000 });

    await agente
      .post("/api/erp/combustible/recepciones")
      .send(payloadRecepcion(tanqueId, { cantidad: 500, costo_unitario: 10 }));

    await agente
      .post("/api/erp/combustible/lecturas")
      .send({ combustible_id: tanqueId, nivel: 1400 });

    const segunda = await agente
      .post("/api/erp/combustible/recepciones")
      .send(payloadRecepcion(tanqueId, { cantidad: 600, costo_unitario: 20 }));
    expect(await costoPromedio(tenantId, tanqueId)).toBeCloseTo(13, 4);

    const anulada = await agente
      .patch(`/api/erp/combustible/recepciones/${segunda.body.id}/anular`)
      .send({ motivo: "se tipeó el costo de otra factura" });

    expect(anulada.status).toBe(200);
    // Vuelve al promedio que dejó la primera, no a 0 ni a un valor a medio
    // deshacer: el replay reproduce solo las vigentes.
    expect(await costoPromedio(tenantId, tanqueId)).toBeCloseTo(10, 4);
  });

  it("anular una recepción INTERMEDIA recalcula bien las posteriores", async () => {
    const tanqueId = await crearTanque({ nivel_actual: 1000 });

    // Este es el caso que hace imposible el update incremental: al anular la
    // del medio, la tercera tiene que recalcularse sobre una base distinta
    // de la que usó cuando se creó. Solo el replay completo lo resuelve.
    const primera = await agente
      .post("/api/erp/combustible/recepciones")
      .send(payloadRecepcion(tanqueId, { cantidad: 500, costo_unitario: 10 }));
    expect(primera.status).toBe(201);

    await agente
      .post("/api/erp/combustible/lecturas")
      .send({ combustible_id: tanqueId, nivel: 1000 });

    const segunda = await agente
      .post("/api/erp/combustible/recepciones")
      .send(payloadRecepcion(tanqueId, { cantidad: 1000, costo_unitario: 30 }));
    expect(segunda.status).toBe(201);

    await agente
      .post("/api/erp/combustible/lecturas")
      .send({ combustible_id: tanqueId, nivel: 1000 });

    const tercera = await agente
      .post("/api/erp/combustible/recepciones")
      .send(payloadRecepcion(tanqueId, { cantidad: 1000, costo_unitario: 20 }));
    expect(tercera.status).toBe(201);

    const anulada = await agente
      .patch(`/api/erp/combustible/recepciones/${segunda.body.id}/anular`)
      .send({ motivo: "factura duplicada del proveedor" });
    expect(anulada.status).toBe(200);

    // Sin la segunda quedan: primera fija promedio en 10; tercera pondera
    // (1000 * 10 + 1000 * 20) / 2000 = 15.
    expect(await costoPromedio(tenantId, tanqueId)).toBeCloseTo(15, 4);
  });

  it("anular TODAS las recepciones deja el promedio en 0", async () => {
    const tanqueId = await crearTanque();
    const unica = await agente
      .post("/api/erp/combustible/recepciones")
      .send(payloadRecepcion(tanqueId, { costo_unitario: 18 }));
    expect(await costoPromedio(tenantId, tanqueId)).toBeCloseTo(18, 4);

    await agente
      .patch(`/api/erp/combustible/recepciones/${unica.body.id}/anular`)
      .send({ motivo: "la cisterna nunca llegó" });

    // 0 = "no hay ninguna compra registrada de la que derivar costo", el
    // valor con el que nace la columna en 0057.
    expect(await costoPromedio(tenantId, tanqueId)).toBe(0);
  });

  it("anular dos veces la misma recepción da 409, no pisa el motivo original", async () => {
    const tanqueId = await crearTanque();
    const creada = await agente
      .post("/api/erp/combustible/recepciones")
      .send(payloadRecepcion(tanqueId));

    const primera = await agente
      .patch(`/api/erp/combustible/recepciones/${creada.body.id}/anular`)
      .send({ motivo: "motivo original" });
    expect(primera.status).toBe(200);

    const segunda = await agente
      .patch(`/api/erp/combustible/recepciones/${creada.body.id}/anular`)
      .send({ motivo: "intento de pisar el anterior" });
    expect(segunda.status).toBe(409);
  });

  it("anular exige motivo, y una recepción inexistente da 404", async () => {
    const tanqueId = await crearTanque();
    const creada = await agente
      .post("/api/erp/combustible/recepciones")
      .send(payloadRecepcion(tanqueId));

    const sinMotivo = await agente
      .patch(`/api/erp/combustible/recepciones/${creada.body.id}/anular`)
      .send({ motivo: "   " });
    expect(sinMotivo.status).toBe(400);

    const inexistente = await agente
      .patch("/api/erp/combustible/recepciones/999999999/anular")
      .send({ motivo: "no existe" });
    expect(inexistente.status).toBe(404);
  });

  // ── Bloqueo por capacidad + tolerancia ────────────────────────────────

  it("con tolerancia 0 rechaza la recepción que supera la capacidad", async () => {
    const tanqueId = await crearTanque({ capacidad_total: 1000, nivel_actual: 800 });

    // 800 medidos + 300 recibidos = 1.100 > 1.000 de capacidad.
    const res = await agente
      .post("/api/erp/combustible/recepciones")
      .send(payloadRecepcion(tanqueId, { cantidad: 300 }));

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("supera la capacidad del tanque");
  });

  it("con tolerancia 0 acepta la recepción que llega justo a la capacidad", async () => {
    const tanqueId = await crearTanque({ capacidad_total: 1000, nivel_actual: 800 });
    // 800 + 200 = 1.000 exacto: el bloqueo es por SUPERAR, no por igualar.
    const res = await agente
      .post("/api/erp/combustible/recepciones")
      .send(payloadRecepcion(tanqueId, { cantidad: 200 }));
    expect(res.status).toBe(201);
  });

  it("la tolerancia por tanque corre el techo del bloqueo", async () => {
    // 10% sobre 1.000 -> techo 1.100.
    const tanqueId = await crearTanque({
      capacidad_total: 1000,
      nivel_actual: 800,
      tolerancia_capacidad_pct: 10,
    });

    // 800 + 300 = 1.100, justo en el techo con tolerancia: pasa.
    const dentro = await agente
      .post("/api/erp/combustible/recepciones")
      .send(payloadRecepcion(tanqueId, { cantidad: 300 }));
    expect(dentro.status).toBe(201);

    // 800 + 350 = 1.150 > 1.100: ni con tolerancia entra.
    const fuera = await agente
      .post("/api/erp/combustible/recepciones")
      .send(payloadRecepcion(tanqueId, { cantidad: 350 }));
    expect(fuera.status).toBe(400);
    expect(fuera.body.error).toContain("tolerancia");
  });

  // ── Documento configurable ────────────────────────────────────────────

  it("con requiere_documento=true (default) la factura/guía es obligatoria", async () => {
    const tanqueId = await crearTanque();
    const res = await agente
      .post("/api/erp/combustible/recepciones")
      .send(payloadRecepcion(tanqueId, { tipo_documento: undefined, numero_documento: undefined }));

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("factura o guía");
  });

  it("con requiere_documento=false la recepción entra sin documento", async () => {
    const tanqueId = await crearTanque({ requiere_documento: false });
    const res = await agente
      .post("/api/erp/combustible/recepciones")
      .send(payloadRecepcion(tanqueId, { tipo_documento: undefined, numero_documento: undefined }));

    expect(res.status).toBe(201);
    expect(res.body.tipo_documento).toBeNull();
  });

  it("acepta guía de remisión además de factura", async () => {
    const tanqueId = await crearTanque();
    const res = await agente
      .post("/api/erp/combustible/recepciones")
      .send(payloadRecepcion(tanqueId, { tipo_documento: "guia_remision" }));

    expect(res.status).toBe(201);
    expect(res.body.tipo_documento).toBe("guia_remision");
  });

  it("rechaza un tipo_documento fuera del enum, y el número sin el tipo", async () => {
    const tanqueId = await crearTanque();

    const tipoInvalido = await agente
      .post("/api/erp/combustible/recepciones")
      .send(payloadRecepcion(tanqueId, { tipo_documento: "boleta" }));
    expect(tipoInvalido.status).toBe(400);

    // Un número sin tipo no dice qué documento es -- lo ataja Zod antes de
    // llegar al CHECK de 0064.
    const numeroSuelto = await agente
      .post("/api/erp/combustible/recepciones")
      .send(payloadRecepcion(tanqueId, { tipo_documento: undefined }));
    expect(numeroSuelto.status).toBe(400);
  });

  // ── Validaciones de referencia ────────────────────────────────────────

  it("rechaza un grifo inexistente y un tanque inexistente", async () => {
    const tanqueId = await crearTanque();

    const grifoMalo = await agente
      .post("/api/erp/combustible/recepciones")
      .send(payloadRecepcion(tanqueId, { grifo_id: 999999999 }));
    expect(grifoMalo.status).toBe(400);
    expect(grifoMalo.body.error).toContain("no existe en este tenant");

    const tanqueMalo = await agente
      .post("/api/erp/combustible/recepciones")
      .send(payloadRecepcion(999999999));
    expect(tanqueMalo.status).toBe(400);
    expect(tanqueMalo.body.error).toContain("no existe en este tenant");
  });

  it("rechaza la recepción si el tanque no tiene lectura vigente a esa fecha", async () => {
    const tanqueId = await crearTanque({ nivel_actual: 500 });

    // Fecha anterior al alta del tanque: la lectura `inicial` es posterior,
    // así que a ESA fecha el nivel es desconocido. Sin nivel no se puede ni
    // validar capacidad ni ponderar costo -- y asumir 0 valorizaría el
    // inventario sobre un número que nadie midió (migración 0059).
    const res = await agente
      .post("/api/erp/combustible/recepciones")
      .send(
        payloadRecepcion(tanqueId, { recibido_en: new Date("2020-01-01T10:00:00Z").toISOString() })
      );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("lectura vigente");
  });

  it("rechaza cantidad y costo_unitario no positivos", async () => {
    const tanqueId = await crearTanque();

    const cantidadCero = await agente
      .post("/api/erp/combustible/recepciones")
      .send(payloadRecepcion(tanqueId, { cantidad: 0 }));
    expect(cantidadCero.status).toBe(400);

    const costoNegativo = await agente
      .post("/api/erp/combustible/recepciones")
      .send(payloadRecepcion(tanqueId, { costo_unitario: -1 }));
    expect(costoNegativo.status).toBe(400);
  });

  // ── Idempotencia (doble clic) ─────────────────────────────────────────

  it("el mismo cliente_uuid no duplica la recepción ni cuenta dos veces en el promedio", async () => {
    const tanqueId = await crearTanque({ nivel_actual: 1000 });
    const clienteUuid = crypto.randomUUID();
    const payload = payloadRecepcion(tanqueId, {
      cantidad: 500,
      costo_unitario: 20,
      cliente_uuid: clienteUuid,
    });

    const primera = await agente.post("/api/erp/combustible/recepciones").send(payload);
    expect(primera.status).toBe(201);

    const reintento = await agente.post("/api/erp/combustible/recepciones").send(payload);
    // 200, no 201: no creó nada (ver el comentario en el controller).
    expect(reintento.status).toBe(200);
    expect(reintento.body.id).toBe(primera.body.id);

    const listado = await agente
      .get("/api/erp/combustible/recepciones")
      .query({ combustible_id: tanqueId });
    expect(listado.body.data).toHaveLength(1);
  });

  // ── Historial ─────────────────────────────────────────────────────────

  it("el historial resuelve nombres, calcula costo_total y marca las anuladas", async () => {
    const tanqueId = await crearTanque();
    const creada = await agente
      .post("/api/erp/combustible/recepciones")
      .send(payloadRecepcion(tanqueId, { cantidad: 400, costo_unitario: 15.5 }));

    const listado = await agente
      .get("/api/erp/combustible/recepciones")
      .query({ combustible_id: tanqueId });

    expect(listado.status).toBe(200);
    expect(listado.body.data).toHaveLength(1);
    const fila = listado.body.data[0];
    expect(fila.tanque_nombre).toBe("Tanque recepciones");
    expect(fila.grifo_nombre).toBeTruthy();
    expect(fila.registrada_por_nombre).toBeTruthy();
    // costo_total no se persiste, se calcula: 400 * 15.5 = 6.200.
    expect(Number(fila.costo_total)).toBeCloseTo(6200, 2);
    expect(fila.anulada_en).toBeNull();

    await agente
      .patch(`/api/erp/combustible/recepciones/${creada.body.id}/anular`)
      .send({ motivo: "prueba de historial" });

    const conAnulada = await agente
      .get("/api/erp/combustible/recepciones")
      .query({ combustible_id: tanqueId });
    // La anulada NO desaparece del historial: es evidencia, no ruido.
    expect(conAnulada.body.data).toHaveLength(1);
    expect(conAnulada.body.data[0].anulada_en).not.toBeNull();
    expect(conAnulada.body.data[0].motivo_anulacion).toBe("prueba de historial");
    expect(conAnulada.body.data[0].anulada_por_nombre).toBeTruthy();
  });

  // ── Diferencia facturado vs. medido (preparación de Fase D) ───────────

  it("calcula la diferencia cuando hay lectura antes y después -- el caso de la entrega corta", async () => {
    const tanqueId = await crearTanque({ nivel_actual: 13500, capacidad_total: 20000 });

    const recepcion = await agente
      .post("/api/erp/combustible/recepciones")
      .send(payloadRecepcion(tanqueId, { cantidad: 6000, costo_unitario: 15 }));
    expect(recepcion.status).toBe(201);

    // La cisterna facturó 6.000 pero al medir aparecen 19.300, no 19.500.
    await agente
      .post("/api/erp/combustible/lecturas")
      .send({ combustible_id: tanqueId, nivel: 19300 });

    const listado = await agente
      .get("/api/erp/combustible/recepciones")
      .query({ combustible_id: tanqueId });
    const fila = listado.body.data[0];

    // (19300 - 13500) + 0 despachos - 6000 = -200
    expect(Number(fila.diferencia_litros)).toBeCloseTo(-200, 2);
    expect(Number(fila.nivel_antes)).toBe(13500);
    expect(Number(fila.nivel_despues)).toBe(19300);
  });

  it("suma de vuelta los despachos hechos entre las dos lecturas", async () => {
    const tanqueId = await crearTanque({ nivel_actual: 10000, capacidad_total: 20000 });
    const equipo = await agente
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("EQ"), tipo: "VOLQUETE" });

    const recepcion = await agente
      .post("/api/erp/combustible/recepciones")
      .send(payloadRecepcion(tanqueId, { cantidad: 5000 }));
    expect(recepcion.status).toBe(201);

    // Se despacharon 300 después de la recepción y antes de volver a medir.
    const despacho = await agente.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tanqueId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipo.body.id,
      serie_talonario: `S${Math.floor(Math.random() * 1e8).toString(36)}`,
      n_vale: 1,
      cantidad: 300,
      lectura_contometro: 300,
      costo_unitario: 16,
    });
    expect(despacho.status).toBe(201);

    // Entró todo lo facturado: 10.000 + 5.000 - 300 = 14.700 exactos.
    await agente
      .post("/api/erp/combustible/lecturas")
      .send({ combustible_id: tanqueId, nivel: 14700 });

    const listado = await agente
      .get("/api/erp/combustible/recepciones")
      .query({ combustible_id: tanqueId });
    // Sin sumar de vuelta el despacho, esto daría -300 y parecería un faltante
    // donde solo hubo una salida legítima.
    expect(Number(listado.body.data[0].diferencia_litros)).toBeCloseTo(0, 2);
  });

  it("no inventa una diferencia cuando falta la lectura posterior", async () => {
    const tanqueId = await crearTanque({ nivel_actual: 1000 });
    await agente
      .post("/api/erp/combustible/recepciones")
      .send(payloadRecepcion(tanqueId, { cantidad: 500 }));

    const listado = await agente
      .get("/api/erp/combustible/recepciones")
      .query({ combustible_id: tanqueId });
    // Sin medición posterior no hay con qué comparar -- null, no 0.
    expect(listado.body.data[0].diferencia_litros).toBeNull();
  });

  // Hasta la 5ª auditoría, dos recepciones entre las mismas dos varillas
  // dejaban la diferencia en NULL ("no se puede atribuir a una sola"). Eso
  // era un interruptor de apagado: dos recepciones de 1 L bastaban para
  // borrar el control. Y dos cisternas el mismo día sin varilla en el medio
  // es operación normal. Ahora la diferencia se calcula contra el GRUPO, y se
  // dice que son varias entregas: no se acusa a un proveedor, pero el
  // faltante no desaparece.
  it("con dos recepciones en la misma ventana, la diferencia es del grupo", async () => {
    const tanqueId = await crearTanque({ nivel_actual: 1000, capacidad_total: 20000 });

    await agente
      .post("/api/erp/combustible/recepciones")
      .send(payloadRecepcion(tanqueId, { cantidad: 500 }));
    await agente
      .post("/api/erp/combustible/recepciones")
      .send(payloadRecepcion(tanqueId, { cantidad: 700 }));

    await agente
      .post("/api/erp/combustible/lecturas")
      .send({ combustible_id: tanqueId, nivel: 2100 });

    const listado = await agente
      .get("/api/erp/combustible/recepciones")
      .query({ combustible_id: tanqueId });
    // Faltan 100 L entre las dos entregas (1000 + 1200 − 2100). No se sabe de
    // cuál de las dos, y por eso la alerta las nombra a las dos; lo que ya no
    // pasa es que el faltante se pierda.
    for (const fila of listado.body.data) {
      expect(Number(fila.diferencia_litros)).toBe(-100);
      expect(Number(fila.entregas_en_grupo)).toBe(2);
      // 0101, hallazgo de la revisión adversaria: el listado tiene que traer
      // la cantidad del GRUPO (1200), no solo la de esta fila (500 o 700).
      // Sin esto el frontend no puede reconstruir la misma tolerancia
      // (piso + % de lo entregado) que usa la alerta real, y pinta "excede"
      // recepciones que el sistema nunca consideró sospechosas.
      expect(Number(fila.cantidad_del_grupo)).toBe(1200);
    }
  });

  // ── RLS ───────────────────────────────────────────────────────────────

  it("un tenant no ve ni puede anular las recepciones de otro", async () => {
    const tanqueId = await crearTanque();
    const propia = await agente
      .post("/api/erp/combustible/recepciones")
      .send(payloadRecepcion(tanqueId));
    expect(propia.status).toBe(201);

    const otro = await crearTenantDePrueba(password);
    const agenteOtro = request.agent(app);
    await agenteOtro
      .post("/api/auth/login")
      .send({ tenantSlug: otro.tenant.slug, email: otro.usuario.email, password });

    try {
      const listado = await agenteOtro.get("/api/erp/combustible/recepciones");
      expect(listado.status).toBe(200);
      expect(listado.body.data).toHaveLength(0);

      // 404 y no 403: para el otro tenant la fila sencillamente no existe --
      // ni siquiera se filtra que hay algo ahí.
      const anular = await agenteOtro
        .patch(`/api/erp/combustible/recepciones/${propia.body.id}/anular`)
        .send({ motivo: "intento cruzado" });
      expect(anular.status).toBe(404);

      // Y el tanque del otro tenant tampoco es alcanzable como destino.
      const cruzada = await agenteOtro
        .post("/api/erp/combustible/recepciones")
        .send(payloadRecepcion(tanqueId));
      expect(cruzada.status).toBe(400);
    } finally {
      await borrarTenantDePrueba(otro.tenant.id);
    }
  });
});
