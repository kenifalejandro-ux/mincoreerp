/** tests/combustible-descuadre.test.ts
 *
 * El balance del tanque (migración 0074): entre dos lecturas de varilla,
 * ¿el nivel medido coincide con lo que los movimientos registrados
 * explican?
 *
 *     esperado  = nivel_anterior + recepciones − despachos
 *     descuadre = nivel_medido − esperado
 *
 * Es el control que faltaba y que da sentido a todo el módulo: combustible
 * que salió del tanque sin que ningún papel lo explique. Apareció simulando
 * el flujo completo -- se cargaron 4.000 L en vales, el tanque bajó 4.500, y
 * ninguno de los siete tipos de alerta existentes dijo nada, porque todos
 * miran su propia fila y ninguno hace el balance.
 *
 * Lo que estos tests fijan, más allá del happy path:
 *  - las DOS direcciones alertan (faltante Y sobrante: los vales que
 *    declaran de más también son fraude, solo que del otro lado);
 *  - con umbral en 0 (el default) no alerta NADA -- sin historial del tanque
 *    cualquier número sería inventado, mismo criterio que 0066/0069;
 *  - los movimientos ANULADOS no explican nada, así que un despacho anulado
 *    vuelve a abrir el faltante que "justificaba";
 *  - la primera lectura de un tanque nunca alerta: no hay contra qué
 *    balancear, y suponer que antes había 0 sería inventar el dato;
 *  - las recepciones se suman de vuelta -- si no, cargar el tanque entre dos
 *    lecturas se vería como un sobrante gigante.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase } from "../src/server/config/database";

function serieUnica(): string {
  return `S${Math.floor(Math.random() * 1e8).toString(36)}`;
}

describe("combustible: descuadre de inventario (migración 0074)", () => {
  let tenantId: string;
  let equipoId: number;
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });

    const equipo = await agente
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("EX"), tipo: "Excavadora" });
    equipoId = equipo.body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  /** Tanque de 20.000 L con nivel inicial 20.000. Con umbral 1%, la banda
   *  tolerada es de 200 L -- los tests de abajo se mueven a propósito por
   *  encima y por debajo de ese número.
   *
   *  Desde 0101 la tolerancia es `piso + % de lo movido`, así que el
   *  parámetro se sigue expresando como el porcentaje de capacidad DE ANTES
   *  y se traduce acá a su piso equivalente -- la misma cuenta que hace la
   *  migración sobre los tanques que ya existían. De esa forma estos tests
   *  siguen fijando exactamente las mismas bandas que fijaban, y que sigan
   *  pasando es la prueba de que el cambio de modelo no movió ninguna.
   *
   *  La parte proporcional (el % sobre lo movido) se prueba aparte, en
   *  tests/combustible-umbral-piso.test.ts. */
  async function crearTanque(umbralDescuadrePct: number | null, nivelInicial = 20000) {
    const res = await agente.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque de balance",
      tipo_combustible: "diesel_b5",
      unidad: "L",
      tipo_punto: "fijo",
      capacidad_total: 20000,
      nivel_actual: nivelInicial,
      umbral_descuadre_pct: umbralDescuadrePct === null ? null : 0,
      umbral_descuadre_piso:
        umbralDescuadrePct === null ? null : (20000 * umbralDescuadrePct) / 100,
    });
    expect(res.status).toBe(201);
    return res.body.id as number;
  }

  async function despachar(tanqueId: number, cantidad: number, cuandoISO: string) {
    const res = await agente.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tanqueId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipoId,
      serie_talonario: serieUnica(),
      n_vale: 1,
      cantidad,
      lectura_contometro: cantidad,
      costo_unitario: 16,
      despachado_en: cuandoISO,
    });
    expect(res.status).toBe(201);
    return res.body;
  }

  async function registrarLectura(tanqueId: number, nivel: number, cuandoISO: string) {
    const res = await agente
      .post("/api/erp/combustible/lecturas")
      .send({ combustible_id: tanqueId, nivel, leido_en: cuandoISO });
    expect(res.status).toBe(201);
    return res.body;
  }

  async function descuadresDe(tanqueId: number) {
    const res = await agente.get("/api/erp/combustible/alertas").query({ pageSize: 200 });
    return res.body.data.filter(
      (a: { tipo: string; combustible_id: number }) =>
        a.tipo === "descuadre_inventario" && a.combustible_id === tanqueId
    );
  }

  // Instantes fijos y separados, para que el orden de los movimientos no
  // dependa de cuánto tardó el test en correr (el corte del intervalo es por
  // `leido_en`, con precisión de minuto en el formulario real).
  const T0 = "2026-03-01T08:00:00.000Z";
  const T1 = "2026-03-01T09:00:00.000Z";
  const T2 = "2026-03-01T10:00:00.000Z";

  it("faltante: el nivel bajó más de lo que los vales explican", async () => {
    const tanqueId = await crearTanque(1);
    await registrarLectura(tanqueId, 20000, T0);
    await despachar(tanqueId, 4000, T1);

    // Deberían quedar 16.000; la varilla marca 15.500 -> faltan 500, muy por
    // encima de los 200 L tolerados (1% de 20.000). Es el caso real que
    // destapó todo esto.
    await registrarLectura(tanqueId, 15500, T2);

    const alertas = await descuadresDe(tanqueId);
    expect(alertas).toHaveLength(1);
    expect(alertas[0].detalle.sentido).toBe("falta");
    expect(alertas[0].detalle.descuadreLitros).toBe(-500);
    expect(alertas[0].detalle.esperado).toBe(16000);
    expect(alertas[0].detalle.nivelMedido).toBe(15500);
    expect(alertas[0].detalle.despachos).toBe(4000);
    expect(alertas[0].resuelta_en).toBeNull();
  });

  it("sobrante: los vales declaran más salida de la que hubo", async () => {
    const tanqueId = await crearTanque(1);
    await registrarLectura(tanqueId, 20000, T0);
    await despachar(tanqueId, 3000, T1);

    // Deberían quedar 17.000 y hay 17.900: sobran 900. Vales inflados, o
    // combustible cargado en el papel a una máquina que nunca lo recibió.
    await registrarLectura(tanqueId, 17900, T2);

    const alertas = await descuadresDe(tanqueId);
    expect(alertas).toHaveLength(1);
    expect(alertas[0].detalle.sentido).toBe("sobra");
    expect(alertas[0].detalle.descuadreLitros).toBe(900);
  });

  it("sin umbral configurado (null, el default) no alerta por grande que sea", async () => {
    const tanqueId = await crearTanque(null);
    await registrarLectura(tanqueId, 20000, T0);
    await despachar(tanqueId, 1000, T1);
    await registrarLectura(tanqueId, 10000, T2); // faltarían 9.000

    expect(await descuadresDe(tanqueId)).toHaveLength(0);
  });

  it("con umbral 0 (tolerancia cero) alerta por el faltante más chico", async () => {
    // El caso que motivó la migración 0075: el cliente que quiere saber de
    // cualquier litro que no cuadre. Antes el 0 apagaba la alerta y esto no
    // se podía pedir de ninguna forma.
    const tanqueId = await crearTanque(0);
    await registrarLectura(tanqueId, 20000, T0);
    await despachar(tanqueId, 1000, T1);
    await registrarLectura(tanqueId, 18999, T2); // falta 1 litro

    const alertas = await descuadresDe(tanqueId);
    expect(alertas).toHaveLength(1);
    expect(alertas[0].detalle.descuadreLitros).toBe(-1);
  });

  it("con umbral 0, un balance que cierra exacto NO alerta", async () => {
    // Tolerancia cero es "cualquier diferencia", no "alertar siempre": un
    // descuadre de 0 no es noticia.
    const tanqueId = await crearTanque(0);
    await registrarLectura(tanqueId, 20000, T0);
    await despachar(tanqueId, 1000, T1);
    await registrarLectura(tanqueId, 19000, T2);

    expect(await descuadresDe(tanqueId)).toHaveLength(0);
  });

  it("un descuadre dentro del umbral no alerta: es el ruido de la varilla", async () => {
    const tanqueId = await crearTanque(1);
    await registrarLectura(tanqueId, 20000, T0);
    await despachar(tanqueId, 1000, T1);
    // Faltan 150 sobre una banda de 200 -> dentro de lo esperable.
    await registrarLectura(tanqueId, 18850, T2);

    expect(await descuadresDe(tanqueId)).toHaveLength(0);
  });

  it("las recepciones se suman de vuelta, no cuentan como sobrante", async () => {
    const tanqueId = await crearTanque(1, 0);
    await registrarLectura(tanqueId, 0, T0);

    const grifo = await agente
      .post("/api/erp/combustible/grifos")
      .send({ nombre: idUnico("Proveedor"), abastece_tanque: true });
    expect(grifo.status).toBe(201);

    const recepcion = await agente.post("/api/erp/combustible/recepciones").send({
      combustible_id: tanqueId,
      grifo_id: grifo.body.id,
      cantidad: 18000,
      costo_unitario: 16,
      tipo_documento: "factura",
      numero_documento: idUnico("F001"),
      recibido_en: T1,
    });
    expect(recepcion.status).toBe(201);

    // Entraron 18.000 y la varilla los ve: el balance cierra exacto. Sin
    // sumar la recepción, esto se vería como +18.000 de sobrante.
    await registrarLectura(tanqueId, 18000, T2);

    expect(await descuadresDe(tanqueId)).toHaveLength(0);
  });

  it("la primera lectura de un tanque nunca alerta: no hay con qué balancear", async () => {
    // El alta ya deja una lectura `inicial`, así que este tanque arranca con
    // una sola: la de abajo es la primera que TIENE anterior.
    const tanqueId = await crearTanque(1, 20000);

    // Ninguna alerta por el alta en sí, aunque el nivel salga de la nada.
    expect(await descuadresDe(tanqueId)).toHaveLength(0);
  });

  /** LÍMITE CONOCIDO, fijado acá a propósito para que nadie lo "arregle" sin
   *  darse cuenta de lo que implica.
   *
   *  El balance es una foto del intervalo entre dos lecturas, tomada en el
   *  momento de la segunda. Anular un despacho DESPUÉS de que ese intervalo
   *  cerró no lo vuelve a abrir: la lectura siguiente balancea contra la
   *  última lectura, no contra el principio de los tiempos, y en ese tramo
   *  nuevo el despacho anulado ya no está.
   *
   *  Concretamente: si el vale de 4.000 L se anula al día siguiente, esos
   *  4.000 L NO reaparecen como faltante. No queda del todo suelto -- anular
   *  dispara su propia alerta `vale_anulado`, que va por correo y se revisa
   *  a mano -- pero el impacto sobre el inventario no se recalcula.
   *
   *  Cerrarlo requiere recomputar intervalos ya cerrados, y eso es trabajo
   *  del motor de conciliación (el worker), no de esta entrega: acá el
   *  disparador es la lectura, y una anulación no crea lecturas. */
  it("anular un despacho NO reabre el balance de un intervalo ya cerrado", async () => {
    const tanqueId = await crearTanque(1);
    await registrarLectura(tanqueId, 20000, T0);
    const despacho = await despachar(tanqueId, 4000, T1);
    await registrarLectura(tanqueId, 16000, T2); // cierra exacto, sin alerta
    expect(await descuadresDe(tanqueId)).toHaveLength(0);

    const anulacion = await agente
      .patch(`/api/erp/combustible/despachos/${despacho.id}/anular`)
      .send({ motivo: "Vale cargado por error en la simulación" });
    expect(anulacion.status).toBe(200);

    // La lectura siguiente balancea 16.000 contra 16.000, sin movimientos en
    // el medio: cierra, aunque el despacho que justificó la baja anterior ya
    // no exista.
    await registrarLectura(tanqueId, 16000, "2026-03-01T11:00:00.000Z");
    expect(await descuadresDe(tanqueId)).toHaveLength(0);
  });

  it("el descuadre se congela como anomalía, no se resuelve solo", async () => {
    // El tipo entró al CHECK de combustible_anomalias en 0074: combustible
    // sin explicar es un hallazgo permanente, a diferencia de `nivel_bajo`.
    const tanqueId = await crearTanque(1);
    await registrarLectura(tanqueId, 20000, T0);
    await despachar(tanqueId, 1000, T1);
    await registrarLectura(tanqueId, 18000, T2);

    const alertas = await descuadresDe(tanqueId);
    expect(alertas).toHaveLength(1);
    // Vive como alerta abierta hasta que el worker la congele a las 72h.
    expect(alertas[0].congelada_en ?? null).toBeNull();
    expect(alertas[0].resuelta_en).toBeNull();
  });
});
