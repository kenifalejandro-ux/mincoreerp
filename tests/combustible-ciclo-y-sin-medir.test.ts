/** tests/combustible-ciclo-y-sin-medir.test.ts
 *
 * Los dos agujeros EXPLOTABLES que encontró la auditoría adversaria del
 * 2026-09-06 (migración 0076). Los dos se descubrieron ejecutando ataques
 * contra la API, no leyendo código, y por eso los tests de acá replican esos
 * ataques en vez de probar el camino feliz.
 *
 * 1. ROBO FRACCIONADO: el descuadre por tramo (0074) compara lectura contra
 *    lectura, así que un faltante repartido en porciones chicas -- cada una
 *    debajo de la banda -- no dispara nunca. La simulación sacó 600 L en
 *    cuatro tramos de 150 sin generar una sola alerta.
 *
 * 2. DEJAR DE MEDIR: sin lecturas no hay descuadre que calcular ni
 *    diferencia de recepción que comparar. No tomar la varilla apaga las dos
 *    detecciones de una, y no requiere entender nada del sistema.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";
import { correrConciliacion } from "../src/server/services/combustibleConciliacion.worker";

let seq = 0;
/** El schema limita `serie_talonario` a 20 caracteres e `idUnico` genera
 *  más: usarlo acá hacía fallar los despachos con 400 sin que se notara, y
 *  las pruebas pasaban en verde sin haber probado nada. */
const serieUnica = () => `S${Date.now().toString(36).slice(-6)}${(seq++).toString(36)}`;

describe("combustible: saldo del ciclo y tanque sin medir (migración 0076)", () => {
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
    const eq = await agente
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("EX"), tipo: "Excavadora" });
    equipoId = eq.body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  /** Tanque de 20.000 L. Tramo 1% (banda 200 L) y ciclo 2% (banda 400 L):
   *  la combinación que hace visible el robo fraccionado sin que cada
   *  medición individual haga ruido. */
  async function crearTanque(opts: { tramo?: number | null; ciclo?: number | null } = {}) {
    const res = await agente.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque del ciclo",
      tipo_combustible: "diesel_b5",
      unidad: "L",
      tipo_punto: "fijo",
      capacidad_total: 20000,
      nivel_actual: 20000,
      umbral_descuadre_pct: opts.tramo === undefined ? 1 : opts.tramo,
      umbral_descuadre_ciclo_pct: opts.ciclo === undefined ? 2 : opts.ciclo,
    });
    expect(res.status).toBe(201);
    return res.body.id as number;
  }

  const despachar = (tanqueId: number, cantidad: number, cuando: string) =>
    agente.post("/api/erp/combustible/despachos").send({
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
      despachado_en: cuando,
    });

  const leer = (tanqueId: number, nivel: number, cuando: string) =>
    agente
      .post("/api/erp/combustible/lecturas")
      .send({ combustible_id: tanqueId, nivel, leido_en: cuando });

  const alertasDe = async (tanqueId: number, tipo: string) => {
    const r = await agente.get("/api/erp/combustible/alertas").query({ pageSize: 200 });
    return r.body.data.filter(
      (a: { tipo: string; combustible_id: number }) =>
        a.tipo === tipo && a.combustible_id === tanqueId
    );
  };

  /** El ataque real: cuatro tramos de 1.000 L despachados, y en cada uno
   *  desaparecen 150 L extra. Cada tramo queda bajo la banda de 200, el
   *  acumulado llega a 600 (3% del tanque) y supera la de 400. */
  async function robarFraccionado(tanqueId: number, dia: string) {
    await leer(tanqueId, 20000, `${dia}T08:00:00.000Z`);
    let nivel = 20000;
    for (let i = 0; i < 4; i++) {
      const h = String(9 + i).padStart(2, "0");
      const d = await despachar(tanqueId, 1000, `${dia}T${h}:10:00.000Z`);
      expect(d.status).toBe(201);
      nivel = nivel - 1000 - 150;
      const l = await leer(tanqueId, nivel, `${dia}T${h}:30:00.000Z`);
      expect(l.status).toBe(201);
    }
    return nivel;
  }

  it("el robo fraccionado NO dispara el descuadre por tramo (por eso hacía falta el del ciclo)", async () => {
    const tq = await crearTanque({ ciclo: null }); // solo tramo configurado
    await robarFraccionado(tq, "2026-06-01");

    // Cada tramo perdió 150 sobre una banda de 200: invisible, uno por uno.
    expect(await alertasDe(tq, "descuadre_inventario")).toHaveLength(0);
  });

  it("el saldo del ciclo SÍ lo atrapa: 600 L en cuatro porciones chicas", async () => {
    const tq = await crearTanque();
    await robarFraccionado(tq, "2026-06-02");

    const ciclo = await alertasDe(tq, "descuadre_ciclo");
    expect(ciclo.length).toBeGreaterThan(0);
    const ultima = ciclo[0];
    expect(ultima.detalle.sentido).toBe("falta");
    // 20.000 − 4.000 despachados = 16.000 esperados; la varilla marcó 15.400.
    expect(Number(ultima.detalle.descuadreLitros)).toBe(-600);
    expect(Number(ultima.detalle.despachos)).toBe(4000);
    // Y el tramo, en paralelo, siguió sin decir nada: son dos preguntas
    // distintas sobre la misma lectura.
    expect(await alertasDe(tq, "descuadre_inventario")).toHaveLength(0);
  });

  it("sin umbral de ciclo configurado (null) no alerta, por grande que sea", async () => {
    const tq = await crearTanque({ tramo: null, ciclo: null });
    await robarFraccionado(tq, "2026-06-03");
    expect(await alertasDe(tq, "descuadre_ciclo")).toHaveLength(0);
  });

  it("un ciclo que cierra bien no genera nada", async () => {
    const tq = await crearTanque();
    await leer(tq, 20000, "2026-06-04T08:00:00.000Z");
    await despachar(tq, 3000, "2026-06-04T09:00:00.000Z");
    await leer(tq, 17000, "2026-06-04T10:00:00.000Z");
    expect(await alertasDe(tq, "descuadre_ciclo")).toHaveLength(0);
  });

  it("la recepción reinicia el ciclo: lo viejo no arrastra al período nuevo", async () => {
    const tq = await crearTanque();
    // Ciclo 1: se pierden 600 L.
    await robarFraccionado(tq, "2026-06-05");
    expect((await alertasDe(tq, "descuadre_ciclo")).length).toBeGreaterThan(0);

    const grifo = await agente
      .post("/api/erp/combustible/grifos")
      .send({ nombre: idUnico("G"), abastece_tanque: true });
    const rec = await agente.post("/api/erp/combustible/recepciones").send({
      combustible_id: tq,
      grifo_id: grifo.body.id,
      cantidad: 4000,
      costo_unitario: 16,
      tipo_documento: "factura",
      numero_documento: idUnico("F"),
      recibido_en: "2026-06-06T08:00:00.000Z",
    });
    expect(rec.status).toBe(201);

    const antes = (await alertasDe(tq, "descuadre_ciclo")).length;
    // Ciclo 2, limpio: 19.400 tras la carga, sale 1.000, quedan 18.400.
    await leer(tq, 19400, "2026-06-06T09:00:00.000Z");
    await despachar(tq, 1000, "2026-06-06T10:00:00.000Z");
    await leer(tq, 18400, "2026-06-06T11:00:00.000Z");

    // Sin reinicio, los 600 L del ciclo anterior seguirían contando y esto
    // alertaría de nuevo por un faltante que ya se reportó.
    expect(await alertasDe(tq, "descuadre_ciclo")).toHaveLength(antes);
  });

  // ── Tanque sin medir ──────────────────────────────────────────────────

  /** Empuja la última lectura del tanque al pasado. No hay forma de hacerlo
   *  por la API -- `leido_en` viaja en el body, pero el worker mira `now()`
   *  contra la lectura más reciente, así que hay que envejecer la fila. */
  async function envejecerLecturas(tanqueId: number, dias: number) {
    await withTenant(tenantId, (c) =>
      c.query(
        `UPDATE combustible_lecturas
         SET leido_en = now() - make_interval(days => $2)
         WHERE combustible_id = $1`,
        [tanqueId, dias]
      )
    );
  }

  /** `correrConciliacion(tenantId)` es la variante SIN advisory lock -- existe para
   *  tests y corridas manuales; la de producción
   *  (`correrConciliacionCoordinada`) toma un lock por tenant. Como recorre
   *  TODOS los tenants, dos archivos de test corriendo en paralelo la
   *  ejecutan sobre el mismo tenant a la vez y la deduplicación
   *  (`NOT EXISTS ... resuelta_en IS NULL`) puede ver "no hay alerta" en las
   *  dos transacciones e insertar dos.
   *
   *  Por eso acá se afirma "al menos una" en vez de "exactamente una": el
   *  conteo exacto sí se verifica en el test de abajo, que llama al worker
   *  tres veces en secuencia desde este mismo archivo. Aflojar esta
   *  aserción no tapa un bug de producción -- ahí el lock hace imposible la
   *  corrida concurrente sobre un mismo tenant. */
  it("un tanque que pasó el plazo sin varilla genera alerta", async () => {
    const tq = await crearTanque();
    await leer(tq, 20000, new Date().toISOString());
    await envejecerLecturas(tq, 10); // el plazo por defecto son 3 días

    await correrConciliacion(tenantId);

    const al = await alertasDe(tq, "tanque_sin_medir");
    expect(al.length).toBeGreaterThanOrEqual(1);
    expect(Number(al[0].detalle.plazoDias)).toBe(3);
    expect(Number(al[0].detalle.diasSinMedir)).toBeGreaterThanOrEqual(9);
  });

  it("no duplica la alerta aunque el worker corra varias veces", async () => {
    const tq = await crearTanque();
    await leer(tq, 20000, new Date().toISOString());
    await envejecerLecturas(tq, 10);

    await correrConciliacion(tenantId);
    await correrConciliacion(tenantId);
    await correrConciliacion(tenantId);

    expect(await alertasDe(tq, "tanque_sin_medir")).toHaveLength(1);
  });

  it("medir de nuevo cierra la alerta sola, sin que nadie la toque", async () => {
    const tq = await crearTanque();
    await leer(tq, 20000, new Date().toISOString());
    await envejecerLecturas(tq, 10);
    await correrConciliacion(tenantId);
    expect(await alertasDe(tq, "tanque_sin_medir")).toHaveLength(1);

    await leer(tq, 19000, new Date().toISOString());

    const al = await alertasDe(tq, "tanque_sin_medir");
    expect(al).toHaveLength(1);
    expect(al[0].resuelta_en).not.toBeNull();
    // La resolvió el sistema, no una persona.
    expect(al[0].resuelta_por).toBeNull();
  });

  it("un tanque dado de alta y NUNCA medido también alerta", async () => {
    // El caso que un INNER JOIN dejaría afuera, y el que más silenciosamente
    // se escaparía: el tanque que nunca tuvo una sola lectura vigente.
    const tq = await crearTanque();
    await withTenant(tenantId, (c) =>
      c.query(`UPDATE combustible_lecturas SET anulada_en = now() WHERE combustible_id = $1`, [tq])
    );

    await correrConciliacion(tenantId);

    const al = await alertasDe(tq, "tanque_sin_medir");
    expect(al).toHaveLength(1);
    expect(al[0].detalle.diasSinMedir).toBeNull();
    expect(al[0].detalle.ultimaLectura).toBeNull();
  });

  it("un tanque DESACTIVADO no alerta: ya no es parte de la operación", async () => {
    const tq = await crearTanque();
    await leer(tq, 20000, new Date().toISOString());
    await envejecerLecturas(tq, 10);
    await agente.delete(`/api/erp/combustible/${tq}`).send({ motivo: "Tanque fuera de servicio" });

    await correrConciliacion(tenantId);

    expect(await alertasDe(tq, "tanque_sin_medir")).toHaveLength(0);
  });
});
