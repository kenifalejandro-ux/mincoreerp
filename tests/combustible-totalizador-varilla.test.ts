/** tests/combustible-totalizador-varilla.test.ts
 *
 * El totalizador también al tomar la varilla (migración 0096). Lo que se fija:
 *
 * 1. Obligatorio en la varilla si el tanque lo usa; ignorado si no.
 * 2. La varilla entra a la MISMA cadena que los vales, por valor, como un
 *    punto de 0 litros: lo que el totalizador avanzó y ningún vale explica
 *    salió por la manguera sin vale -- incluido lo que sale DESPUÉS del último
 *    vale, que antes no se veía.
 * 3. Los vales siguientes parten de la varilla; anular la varilla la saca.
 * 4. El descuadre de inventario del tramo se separa en "manguera sin vale"
 *    (firme) y "fuera del surtidor" (con el error de la varilla).
 *
 * Cada ataque va con su GEMELO de control: si el gemelo también alertara, el
 * "alertó" del ataque no probaría nada.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase } from "../src/server/config/database";

let seq = 0;
const serieUnica = () => `V${Date.now().toString(36).slice(-5)}${(seq++).toString(36)}`;

interface Alerta {
  tipo: string;
  combustible_id: number | null;
  detalle: Record<string, unknown>;
}

describe("combustible: totalizador en la varilla", () => {
  let tenantId: string;
  let equipoId: number;
  const password = "ClaveDePrueba123";
  const ag = request.agent(app);
  const hace = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString();

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    await ag
      .post("/api/auth/login")
      .send({ tenantSlug: c.tenant.slug, email: c.usuario.email, password });
    const eq = await ag
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("VT"), tipo: "Volquete" });
    equipoId = eq.body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  async function tanque(usa: boolean, conDescuadre = false) {
    const r = await ag.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque totalizador en varilla",
      tipo_combustible: "diesel_b5",
      unidad: "L",
      tipo_punto: "fijo",
      capacidad_total: conDescuadre ? 20000 : 50000,
      nivel_actual: 10000,
      nivel_minimo: 1000,
      requiere_documento: false,
      usa_totalizador: usa,
      ...(conDescuadre
        ? {
            modo_vigilancia: "personalizado",
            umbral_diferencia_pct: 1,
            umbral_descuadre_pct: 1,
            umbral_descuadre_ciclo_pct: 1,
            umbral_descuadre_ventana_pct: 2,
          }
        : { modo_vigilancia: "sin_vigilar" }),
    });
    expect(r.status).toBe(201);
    return r.body.id as number;
  }

  const vale = (tq: number, cantidad: number, cuando: string, totalizador?: number) =>
    ag.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tq,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipoId,
      serie_talonario: serieUnica(),
      n_vale: 1,
      cantidad,
      lectura_contometro: cantidad,
      ...(totalizador === undefined ? {} : { totalizador_lectura: totalizador }),
      costo_unitario: 16,
      despachado_en: cuando,
    });

  const varilla = (tq: number, nivel: number, cuando: string, totalizador?: number) =>
    ag.post("/api/erp/combustible/lecturas").send({
      combustible_id: tq,
      nivel,
      leido_en: cuando,
      ...(totalizador === undefined ? {} : { totalizador_lectura: totalizador }),
    });

  async function alertasDe(tq: number, tipo: string) {
    const r = await ag.get("/api/erp/combustible/alertas").query({ pageSize: 500 });
    return (r.body.data as Alerta[]).filter((a) => a.tipo === tipo && a.combustible_id === tq);
  }

  async function totalizadorActual(tq: number) {
    const r = await ag.get(`/api/erp/combustible/${tq}`);
    return Number(r.body.totalizador_actual);
  }

  it("el vale sin totalizador en un tanque que lo usa es 400, no 500", async () => {
    // 5xx haría que la cola offline lo reintente para siempre.
    const tq = await tanque(true);
    const r = await vale(tq, 100, hace(5));
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/usa totalizador/);
  });

  it("obligatorio en la varilla si el tanque lo usa; ignorado si no", async () => {
    const usa = await tanque(true);
    const sin = await varilla(usa, 10000, hace(5));
    expect(sin.status).toBe(400);
    expect(sin.body.error).toMatch(/usa totalizador/);
    expect((await varilla(usa, 10000, hace(5), 1000)).status).toBe(201);

    // La varilla cargada sin red cuando el control estaba prendido y que llega
    // con un tanque que ya no lo usa: se guarda, sin el dato.
    const noUsa = await tanque(false);
    const r = await varilla(noUsa, 10000, hace(5), 1234);
    expect(r.status).toBe(201);
    expect(r.body.lectura.totalizador_lectura).toBeNull();
    expect(await alertasDe(noUsa, "totalizador_salto")).toHaveLength(0);
  });

  it("lo que sale DESPUÉS del último vale se ve en la varilla; el gemelo sin robo no alerta", async () => {
    const tq = await tanque(true);
    expect((await vale(tq, 100, hace(10), 1000)).status).toBe(201);
    expect((await vale(tq, 300, hace(9), 1300)).status).toBe(201);

    // Gemelo: la varilla lee 1300, justo lo que dejó el último vale.
    expect((await varilla(tq, 9600, hace(4), 1300)).status).toBe(201);
    expect(await alertasDe(tq, "totalizador_salto")).toHaveLength(0);

    // Ataque: alguien sacó 80 L por la manguera sin hacer vale. Los vales
    // siguen consistentes entre sí; solo el segundo lector lo ve.
    expect((await varilla(tq, 9500, hace(2), 1380)).status).toBe(201);
    const [alerta] = await alertasDe(tq, "totalizador_salto");
    expect(alerta).toBeDefined();
    expect(alerta.detalle).toMatchObject({
      ancla: "varilla",
      avance: 80,
      declarado: 0,
      diferencia: 80,
      sobra: true,
    });
  });

  it("un totalizador de varilla que retrocede es totalizador_retroceso", async () => {
    const tq = await tanque(true);
    expect((await vale(tq, 100, hace(10), 2000)).status).toBe(201);
    expect((await vale(tq, 100, hace(9), 2100)).status).toBe(201);
    expect((await varilla(tq, 9800, hace(2), 1900)).status).toBe(201);
    const [r] = await alertasDe(tq, "totalizador_retroceso");
    expect(r.detalle).toMatchObject({
      ancla: "varilla",
      totalizador: 1900,
      totalizadorMayorPrevio: 2100,
    });
  });

  it("el vale siguiente parte de la varilla; sin ella, el mismo vale alerta", async () => {
    // Con varilla: 1300 -> varilla 1500 (200 sin vale) -> vale de 200 L en 1700.
    const con = await tanque(true);
    expect((await vale(con, 100, hace(10), 1000)).status).toBe(201);
    expect((await vale(con, 300, hace(9), 1300)).status).toBe(201);
    expect((await varilla(con, 9500, hace(4), 1500)).status).toBe(201);
    expect(await alertasDe(con, "totalizador_salto")).toHaveLength(1);
    expect((await vale(con, 200, hace(3), 1700)).status).toBe(201);
    // 1500 -> 1700 = 200 L: cuadra contra la varilla. No suma otra alerta.
    expect(await alertasDe(con, "totalizador_salto")).toHaveLength(1);

    // Gemelo: idéntico pero SIN la varilla. Ahora el vale compara contra el
    // anterior (1300): avanzó 400 y declara 200, y alerta. Prueba que arriba
    // fue la varilla la que entró en la cadena.
    const sin = await tanque(true);
    expect((await vale(sin, 100, hace(10), 1000)).status).toBe(201);
    expect((await vale(sin, 300, hace(9), 1300)).status).toBe(201);
    expect((await vale(sin, 200, hace(3), 1700)).status).toBe(201);
    expect(await alertasDe(sin, "totalizador_salto")).toHaveLength(1);
  });

  it("anular la varilla la saca de la cadena y del máximo del tanque", async () => {
    const tq = await tanque(true);
    expect((await vale(tq, 100, hace(10), 1000)).status).toBe(201);
    expect((await vale(tq, 300, hace(9), 1300)).status).toBe(201);
    const lect = await varilla(tq, 9500, hace(4), 1500);
    expect(lect.status).toBe(201);
    expect(await totalizadorActual(tq)).toBe(1500);

    const anul = await ag
      .patch(`/api/erp/combustible/lecturas/${lect.body.lectura.id}/anular`)
      .send({ motivo: "se tipeó mal el totalizador" });
    expect(anul.status).toBe(200);
    expect(await totalizadorActual(tq)).toBe(1300);

    // Un vale de 300 L que llega a 1600: contra el vale anterior (1300)
    // cuadra. Con la varilla en 1500 todavía en la cadena avanzaría 100 y
    // alertaría.
    expect((await vale(tq, 300, hace(1), 1600)).status).toBe(201);
    // Queda solo la alerta que la varilla ya había emitido: las alertas ya
    // emitidas no se reescriben (mismo criterio que con los vales).
    expect(await alertasDe(tq, "totalizador_salto")).toHaveLength(1);
  });

  it("una varilla fechada atrás se ubica por valor, sin falso retroceso", async () => {
    const tq = await tanque(true);
    expect((await vale(tq, 100, hace(10), 1000)).status).toBe(201);
    expect((await vale(tq, 400, hace(8), 1400)).status).toBe(201);
    // Gemelo: medida a las hace(9), cuando el totalizador estaba en 1000. Se
    // carga ahora, después del segundo vale, pero su lugar en el tiempo es
    // anterior a él: no hay retroceso.
    expect((await varilla(tq, 9900, hace(9), 1000)).status).toBe(201);
    expect(await alertasDe(tq, "totalizador_retroceso")).toHaveLength(0);
    // Ataque: la misma lectura pero medida DESPUÉS del segundo vale.
    expect((await varilla(tq, 9500, hace(7), 1000)).status).toBe(201);
    const [r] = await alertasDe(tq, "totalizador_retroceso");
    expect(r.detalle).toMatchObject({ ancla: "varilla", totalizadorMayorPrevio: 1400 });
  });

  it("el descuadre del tramo se separa en manguera sin vale y fuera del surtidor", async () => {
    const tq = await tanque(true, true);
    expect((await varilla(tq, 10000, hace(20), 1000)).status).toBe(201);
    expect((await vale(tq, 300, hace(15), 1300)).status).toBe(201);
    // Salieron 100 L por la manguera sin vale (T: 1300 -> 1400) y 500 L por
    // fuera del surtidor (balde, drenaje): el nivel baja 300 + 100 + 500.
    expect((await varilla(tq, 9100, hace(1), 1400)).status).toBe(201);

    const [d] = await alertasDe(tq, "descuadre_inventario");
    expect(d).toBeDefined();
    expect(d.detalle).toMatchObject({ descuadreLitros: -600, sentido: "falta" });
    expect(d.detalle.desglose).toEqual({
      avanceTotalizador: 400,
      mangueraSinVale: 100,
      fueraDelSurtidor: 500,
    });
    // Y la parte firme, la de la manguera, también salta sola en la cadena.
    expect(await alertasDe(tq, "totalizador_salto")).toHaveLength(1);
  });

  it("gemelo del desglose: sin totalizador el mismo descuadre alerta sin desglose", async () => {
    const tq = await tanque(false, true);
    expect((await varilla(tq, 10000, hace(20))).status).toBe(201);
    expect((await vale(tq, 300, hace(15))).status).toBe(201);
    expect((await varilla(tq, 9100, hace(1))).status).toBe(201);
    const [d] = await alertasDe(tq, "descuadre_inventario");
    expect(d).toBeDefined();
    expect(d.detalle.desglose).toBeUndefined();
  });

  it("el kardex y el historial de varillas muestran el totalizador", async () => {
    const tq = await tanque(true);
    expect((await vale(tq, 100, hace(10), 5000)).status).toBe(201);
    expect((await varilla(tq, 9900, hace(5), 5100)).status).toBe(201);

    const kardex = await ag.get(`/api/erp/combustible/${tq}/kardex`).query({
      desde: hace(24),
      hasta: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(kardex.status).toBe(200);
    const filas = kardex.body.filas as { tipo: string; totalizador: number | null }[];
    expect(filas.find((f) => f.tipo === "despacho")?.totalizador).toBe(5000);
    expect(filas.find((f) => f.tipo === "lectura" && f.totalizador === 5100)).toBeDefined();
    expect(filas.find((f) => f.tipo === "recepcion")).toBeUndefined();

    const lecturas = await ag.get(`/api/erp/combustible/${tq}/lecturas`);
    expect(
      (lecturas.body.data as { totalizador_lectura: string | null }[]).map((l) =>
        l.totalizador_lectura === null ? null : Number(l.totalizador_lectura)
      )
    ).toContain(5100);
  });
});
