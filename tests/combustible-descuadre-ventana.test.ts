/** tests/combustible-descuadre-ventana.test.ts
 *
 * Hallazgos 1 y 4 de la simulación adversaria, y el peor de los siete: el
 * único que se podía sostener PARA SIEMPRE.
 *
 * El descuadre del ciclo (0076) arranca en la primera lectura posterior a la
 * última recepción, así que cada carga de combustible BORRA el acumulado.
 * Robando 50 L por día de un tanque de 20.000 con umbral de 1% (= 200 L):
 * ningún tramo alerta, el ciclo va 50, 100, 150... y el jueves llega el
 * camión y vuelve a cero. Nunca llega a 200.
 *
 * El primer test de acá es esa simulación exacta, con el control viejo
 * callado y el nuevo hablando.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase } from "../src/server/config/database";

describe("combustible: descuadre acumulado en ventana deslizante (migración 0080)", () => {
  let tenantId: string;
  let grifoId: number;
  const password = "ClaveDePrueba123";
  const ag = request.agent(app);

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    await ag
      .post("/api/auth/login")
      .send({ tenantSlug: c.tenant.slug, email: c.usuario.email, password });

    const g = await ag
      .post("/api/erp/combustible/grifos")
      .send({ nombre: idUnico("Prov"), abastece_tanque: true });
    grifoId = g.body.id;

    await ag.put("/api/erp/combustible/config").send({
      ventana_gracia_horas: 72,
      dias_sin_medir: 3,
      dias_ventana_descuadre: 30,
      dias_carga_retroactiva: 3,
      llenados_por_dia_max: null,
      tope_diario_sin_capacidad_l: null,
    });
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  /** Tanque de 20.000 L. Umbrales: 1% por tramo y por ciclo (= 200 L), que
   *  es lo que la simulación configuró y esquivó; 2% en la ventana (= 400 L),
   *  más alto porque acumula treinta veces más mediciones. */
  async function tanque(ventanaPct: number | null = 2) {
    const r = await ag.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque vigilado",
      tipo_combustible: "diesel_b5",
      unidad: "L",
      tipo_punto: "fijo",
      capacidad_total: 20000,
      nivel_actual: 10000,
      nivel_minimo: 2000,
      modo_vigilancia: "personalizado",
      umbral_descuadre_pct: 1,
      umbral_descuadre_ciclo_pct: 1,
      umbral_descuadre_ventana_pct: ventanaPct,
    });
    expect(r.status).toBe(201);
    return r.body.id as number;
  }

  const hace = (dias: number) => new Date(Date.now() - dias * 24 * 3600 * 1000).toISOString();

  const leer = (tq: number, nivel: number, cuando: string) =>
    ag.post("/api/erp/combustible/lecturas").send({ combustible_id: tq, nivel, leido_en: cuando });

  const recibir = (tq: number, cantidad: number, cuando: string) =>
    ag.post("/api/erp/combustible/recepciones").send({
      combustible_id: tq,
      grifo_id: grifoId,
      cantidad,
      costo_unitario: 16,
      tipo_documento: "factura",
      numero_documento: idUnico("F"),
      recibido_en: cuando,
    });

  const alertasDe = async (tq: number, tipo: string) => {
    const r = await ag.get("/api/erp/combustible/alertas").query({ pageSize: 300 });
    return r.body.data.filter(
      (a: { tipo: string; combustible_id: number }) => a.tipo === tipo && a.combustible_id === tq
    );
  };

  // ── El robo que se sostenía para siempre ──────────────────────────────

  it("50 L por día con recepciones semanales: el ciclo calla, la ventana habla", async () => {
    const tq = await tanque();

    // 20 días de robo parejo. Sin despachos: cada varilla marca 50 L menos
    // de lo que debería. Cada tres días llega el camión y recarga -- que es
    // lo que reiniciaba el contador del ciclo.
    let nivel = 10000;
    for (let d = 20; d >= 1; d--) {
      nivel -= 50;
      const cuando = hace(d);
      if (d % 3 === 0) {
        await recibir(tq, 1000, cuando);
        nivel += 1000;
      }
      const res = await leer(tq, nivel, new Date(Date.parse(cuando) + 3600_000).toISOString());
      expect(res.status).toBe(201);
    }

    // El control por tramo: 50 L contra una tolerancia de 200. Mudo, como en
    // la simulación.
    expect(await alertasDe(tq, "descuadre_inventario")).toHaveLength(0);

    // La ventana: 20 tramos × -50 = -1.000 L contra una tolerancia de 400.
    const al = await alertasDe(tq, "descuadre_ventana");
    expect(al.length).toBeGreaterThan(0);
    const ultima = al[0];
    expect(ultima.detalle.sentido).toBe("falta");
    expect(Math.abs(Number(ultima.detalle.descuadreLitros))).toBeGreaterThan(400);
    expect(Math.round(Number(ultima.detalle.promedioPorTramo))).toBe(-50);
  });

  it("una recepción NO reinicia la cuenta: es toda la diferencia con el ciclo", async () => {
    const tq = await tanque();

    let nivel = 10000;
    for (let d = 10; d >= 1; d--) {
      nivel -= 60;
      await leer(tq, nivel, hace(d));
    }
    // Justo antes de la última varilla llega el camión. Para el ciclo, esto
    // borra todo lo anterior; para la ventana, no cambia nada.
    await recibir(tq, 2000, hace(0.5));
    nivel += 2000 - 60;
    await leer(tq, nivel, hace(0.2));

    const al = await alertasDe(tq, "descuadre_ventana");
    expect(al.length).toBeGreaterThan(0);
    // ~11 tramos de -60 = -660, muy por encima de los 400 tolerados.
    expect(Math.abs(Number(al[0].detalle.descuadreLitros))).toBeGreaterThan(400);
  });

  // ── Lo que NO debe alertar ────────────────────────────────────────────

  it("el error de varilla se cancela y no alerta: es lo que separa ruido de robo", async () => {
    // Mismo tamaño de error que el robo de arriba (±60 L), pero alternando
    // de signo, que es como se comporta una medición imprecisa de verdad. La
    // suma CON SIGNO lo anula; una suma de valores absolutos habría delatado
    // a este operador igual que a un ladrón.
    const tq = await tanque();

    let nivel = 10000;
    for (let d = 12; d >= 1; d--) {
      nivel += d % 2 === 0 ? 60 : -60;
      await leer(tq, nivel, hace(d));
    }

    expect(await alertasDe(tq, "descuadre_ventana")).toHaveLength(0);
  });

  it("sin umbral configurado no alerta, por más que falte", async () => {
    const tq = await tanque(null);
    let nivel = 10000;
    for (let d = 10; d >= 1; d--) {
      nivel -= 500;
      await leer(tq, nivel, hace(d));
    }
    expect(await alertasDe(tq, "descuadre_ventana")).toHaveLength(0);
  });

  it("un solo tramo no es una ventana: ese control ya existe por tramo", async () => {
    const tq = await tanque();
    await leer(tq, 19000, hace(2));
    expect(await alertasDe(tq, "descuadre_ventana")).toHaveLength(0);
  });

  it("lo que quedó fuera de la ventana ya no cuenta", async () => {
    // Es lo que la hace DESLIZANTE y no un acumulado eterno que nadie podría
    // bajar nunca. Las alertas de aquella época SÍ nacieron en su momento y
    // ahí siguen -- son evidencia. Lo que se prueba acá es que una medición
    // de hoy ya no arrastra un faltante de hace dos meses.
    const tq = await tanque();

    let nivel = 10000;
    for (let d = 60; d >= 40; d--) {
      nivel -= 100;
      await leer(tq, nivel, hace(d));
    }
    const historicas = (await alertasDe(tq, "descuadre_ventana")).length;

    // Dos mediciones recientes y limpias, con la ventana ya corrida.
    await leer(tq, nivel, hace(2));
    await leer(tq, nivel, hace(1));

    expect(await alertasDe(tq, "descuadre_ventana")).toHaveLength(historicas);
  });

  // ── Aflojar el control ────────────────────────────────────────────────

  it("bajar los días de la ventana queda auditado como reducción de vigilancia", async () => {
    // Bajarla de 30 a 7 le devuelve al que roba de a poco casi todo lo que
    // este control le sacó, y por eso cuenta como aflojar aunque el número
    // BAJE (al revés que la ventana de gracia).
    const base = {
      ventana_gracia_horas: 72,
      dias_sin_medir: 3,
      dias_carga_retroactiva: 3,
      llenados_por_dia_max: null,
      tope_diario_sin_capacidad_l: null,
    };
    await ag.put("/api/erp/combustible/config").send({ ...base, dias_ventana_descuadre: 30 });
    const res = await ag
      .put("/api/erp/combustible/config")
      .send({ ...base, dias_ventana_descuadre: 7 });
    expect(res.status).toBe(200);

    const bitacora = await ag.get("/api/erp/combustible/bitacora").query({ pageSize: 50 });
    const fila = bitacora.body.data.find(
      (f: { accion: string }) => f.accion === "combustible.config_vigilancia_reducida"
    );
    expect(fila).toBeDefined();
    const aflojados = fila.detalle.aflojados as { control: string }[];
    expect(aflojados.some((c) => c.control.includes("Ventana de descuadre"))).toBe(true);

    await ag.put("/api/erp/combustible/config").send({ ...base, dias_ventana_descuadre: 30 });
  });

  it("el umbral se guarda y vuelve en la ficha del tanque", async () => {
    const tq = await tanque(2.5);
    const res = await ag.get(`/api/erp/combustible/${tq}`);
    expect(Number(res.body.umbral_descuadre_ventana_pct)).toBe(2.5);
  });
});
