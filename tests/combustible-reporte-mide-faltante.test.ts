/** tests/combustible-reporte-mide-faltante.test.ts
 *
 * El hallazgo 1 del red team de operación, convertido en regresión.
 *
 * MANIOBRA: subir los tres umbrales a 60 %, sacar combustible SIN EMITIR
 * VALE, y restaurar. Durante esa ventana el sistema calla a propósito --para
 * eso se subió el umbral-- así que el reporte del período es lo único que
 * queda. Y decía "0 L bajo vigilancia reducida", porque contaba despachos
 * DECLARADOS.
 *
 * Aflojar el umbral sirve justamente para NO declarar. El reporte medía todo
 * menos lo que el aflojamiento habilita, y un auditor leía "alguien subió el
 * umbral el viernes, salieron 0 litros" y cerraba el caso.
 *
 * Ahora trae también lo que dice la varilla, calculado ignorando el umbral:
 * el umbral decide si se ALERTA en el momento, nunca si el número existe
 * después.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase } from "../src/server/config/database";

describe("combustible: el reporte de controles mide el faltante, no solo lo declarado", () => {
  let tenantId: string;
  let equipoId: number;
  const password = "ClaveDePrueba123";
  const ag = request.agent(app);
  const hace = (h: number) => new Date(Date.now() - h * 3600e3).toISOString();
  let nVale = 0;

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    await ag
      .post("/api/auth/login")
      .send({ tenantSlug: c.tenant.slug, email: c.usuario.email, password });
    const e = await ag.post("/api/erp/equipos").send({
      placa_codigo: idUnico("VQ"),
      tipo: "Volquete",
      capacidad_tanque: 5000,
      capacidad_tanque_unidad: "L",
    });
    equipoId = e.body.id;
    await ag.put("/api/erp/combustible/config").send({
      ventana_gracia_horas: 72,
      dias_sin_medir: 3,
      dias_ventana_descuadre: 30,
      llenados_por_dia_max: 5,
      tope_diario_sin_capacidad_l: 5000,
    });
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  async function tanque() {
    const r = await ag.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "T",
      tipo_combustible: "diesel_b5",
      unidad: "L",
      tipo_punto: "fijo",
      capacidad_total: 20000,
      nivel_actual: 18000,
      nivel_minimo: 1000,
      tolerancia_capacidad_pct: 0,
      modo_vigilancia: "personalizado",
      umbral_descuadre_pct: 2,
      umbral_descuadre_ciclo_pct: 3,
      umbral_descuadre_ventana_pct: 4,
      umbral_diferencia_pct: 2,
    });
    expect(r.status).toBe(201);
    const tq = r.body.id as number;
    // Varilla de base anterior al período: sin ella no hay tramo que medir.
    await ag
      .post("/api/erp/combustible/lecturas")
      .send({ combustible_id: tq, nivel: 18000, leido_en: hace(200) });
    return tq;
  }

  const aflojar = async (tq: number) => {
    const f = (await ag.get(`/api/erp/combustible/${tq}`)).body;
    const num = (v: unknown) => (v === null ? null : Number(v));
    return ag.put(`/api/erp/combustible/${tq}`).send({
      codigo: f.codigo,
      tanque_nombre: f.tanque_nombre,
      tipo_combustible: f.tipo_combustible,
      unidad: f.unidad,
      tipo_punto: f.tipo_punto,
      moneda: f.moneda,
      activo: f.activo,
      capacidad_total: Number(f.capacidad_total),
      nivel_minimo: Number(f.nivel_minimo),
      tolerancia_capacidad_pct: Number(f.tolerancia_capacidad_pct),
      requiere_documento: f.requiere_documento,
      umbral_diferencia_pct: num(f.umbral_diferencia_pct),
      umbral_descuadre_pct: 60,
      umbral_descuadre_ciclo_pct: 60,
      umbral_descuadre_ventana_pct: 60,
      motivo_ajuste: "recalibración",
    });
  };

  /** Un instante levemente posterior a "ahora". El evento de auditoría se
   *  estampa con el reloj del servidor, así que una varilla fechada antes
   *  queda fuera de la ventana con toda razón -- en cancha se mide DESPUÉS
   *  de que alguien tocó la configuración. El margen de 1 h del schema lo
   *  admite. */
  const luego = (seg = 2) => new Date(Date.now() + seg * 1000).toISOString();

  const varilla = (tq: number, nivel: number, cuando: string) =>
    ag.post("/api/erp/combustible/lecturas").send({ combustible_id: tq, nivel, leido_en: cuando });

  const reporte = () =>
    ag.get("/api/erp/combustible/reportes/controles").query({
      desde: hace(300),
      hasta: new Date(Date.now() + 6e4).toISOString(),
    });

  // ── El ataque del red team ────────────────────────────────────────────

  it("el robo SIN VALE durante la ventana floja ahora aparece con su número", async () => {
    const tq = await tanque();
    expect((await aflojar(tq)).status).toBe(200);

    // Nadie emite vale. La varilla dice que faltan 3.000 L.
    expect((await varilla(tq, 15000, luego())).status).toBe(201);

    // El sistema NO alerta: es lo que el umbral en 60 % compró.
    const al = await ag.get("/api/erp/combustible/alertas").query({ pageSize: 100 });
    const suyas = (al.body.data as { combustible_id: number }[]).filter(
      (a) => a.combustible_id === tq
    );
    expect(suyas).toHaveLength(0);

    // Pero el reporte del período ahora sí lo dice.
    const r = await reporte();
    expect(r.status).toBe(200);
    const ev = r.body.eventos.find((e: { combustible_id: number }) => e.combustible_id === tq);
    expect(ev).toBeDefined();
    expect(ev.descuadre_medido_l).toBe(-3000);
    expect(ev.mediciones_despues).toBe(1);
    // Y lo declarado sigue en cero, que es la verdad: no hubo vales.
    expect(ev.despachado_despues_l).toBe(0);
  });

  it("un vale RETRO-FECHADO no puede esconder el faltante", async () => {
    // Hallazgo 2 del mismo red team: `despachado_en` lo escribe el usuario,
    // así que fechar el vale antes del aflojamiento lo saca de la cuenta de
    // lo declarado. La varilla no se puede retro-fechar contra la física: el
    // nivel medido es el que es.
    const tq = await tanque();
    await aflojar(tq);
    await ag.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tq,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipoId,
      serie_talonario: `R${Date.now().toString(36).slice(-4)}`,
      n_vale: ++nVale,
      cantidad: 2000,
      lectura_contometro: 2000,
      costo_unitario: 16,
      despachado_en: hace(48), // ← fechado ANTES del aflojamiento
    });
    await varilla(tq, 16000, luego());

    const r = await reporte();
    const ev = r.body.eventos.find((e: { combustible_id: number }) => e.combustible_id === tq);
    // Lo declarado se le escapa al filtro por fecha...
    expect(ev.despachado_despues_l).toBe(0);
    // ...pero lo medido no: la varilla vio bajar el tanque.
    expect(ev.descuadre_medido_l).toBeLessThan(0);
  });

  // ── Lo que NO debe hacer ──────────────────────────────────────────────

  it("sin mediciones en la ventana devuelve null, NO cero", async () => {
    // "No se midió" y "cuadra" no son lo mismo. Confundirlos sería repetir
    // exactamente el error que este arreglo corrige.
    const tq = await tanque();
    await aflojar(tq);
    // Nadie tomó varilla después del cambio.

    const r = await reporte();
    const ev = r.body.eventos.find((e: { combustible_id: number }) => e.combustible_id === tq);
    expect(ev.descuadre_medido_l).toBeNull();
    expect(ev.mediciones_despues).toBe(0);
    expect(r.body.resumen.sin_mediciones).toBeGreaterThan(0);
  });

  it("un tanque que cuadra durante la ventana floja marca cero, no un falso positivo", async () => {
    const tq = await tanque();
    await aflojar(tq);
    // Operación honesta: se despacha y la varilla lo confirma.
    await ag.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tq,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipoId,
      serie_talonario: `H${Date.now().toString(36).slice(-4)}`,
      n_vale: ++nVale,
      cantidad: 1200,
      lectura_contometro: 1200,
      costo_unitario: 16,
      despachado_en: luego(1),
    });
    await varilla(tq, 16800, luego(3)); // 18000 - 1200, exacto

    const r = await reporte();
    const ev = r.body.eventos.find((e: { combustible_id: number }) => e.combustible_id === tq);
    expect(ev.descuadre_medido_l).toBe(0);
    expect(ev.despachado_despues_l).toBe(1200);
  });

  it("el resumen toma el PEOR evento, no la suma", async () => {
    // Las ventanas de dos aflojamientos se superponen --las dos terminan al
    // final del período-- así que sumarlas contaría el mismo faltante dos
    // veces y el informe diría un número que no existe.
    const r = await reporte();
    expect(r.body.resumen).toHaveProperty("peor_descuadre_medido_l");
    expect(Math.abs(r.body.resumen.peor_descuadre_medido_l)).toBeGreaterThan(0);
  });
});
