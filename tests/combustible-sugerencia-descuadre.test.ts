/** tests/combustible-sugerencia-descuadre.test.ts
 *
 * El asistente de calibración extendido a los tres umbrales de descuadre:
 * tramo, ciclo y ventana.
 *
 * Por qué importa: el alta ahora carga valores PROVISIONALES (2% tramo, 3%
 * ciclo, 4% ventana), razonados sobre el error típico de una varilla pero no
 * medidos. Esto es lo que los reemplaza por números que salen del tanque real.
 *
 * Tramo y ciclo comparten `CombustibleService.calibrar`: promedio de |x| + 2
 * desvíos. La ventana usa `calibrarConSigno`: 2 desvíos de la diferencia con
 * signo, porque el error de cada varilla se cancela entre tramos seguidos. Los
 * tres: piso 1%, mínimo 10 muestras, nunca se aplica solo. Los valores de estos
 * tests están elegidos a mano, no al azar, para poder comparar contra la cuenta
 * esperada.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";

describe("combustible: calibración de los umbrales de descuadre", () => {
  let tenantId: string;
  let equipoId: number;
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);

  let seq = 0;
  const serieUnica = () => `S${Date.now().toString(36).slice(-6)}${(seq++).toString(36)}`;

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

  /** Capacidad 10.000 para que la cuenta sea fácil de seguir a mano: 100 L de
   *  descuadre son exactamente 1%. */
  async function crearTanque() {
    const res = await agente.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque de calibración",
      tipo_combustible: "diesel_b5",
      unidad: "L",
      tipo_punto: "fijo",
      capacidad_total: 10000,
      nivel_actual: 10000,
      modo_vigilancia: "sin_vigilar",
    });
    expect(res.status).toBe(201);
    const id = res.body.id as number;

    // La lectura `inicial` del alta se crea con NOW(), y los instantes de
    // estos tests son fijos y del pasado -- si se deja, queda al FINAL de la
    // muestra y desordena todos los intervalos. Anularla deja el historial
    // enteramente bajo control del test.
    await withTenant(tenantId, (c) =>
      c.query(
        `UPDATE combustible_lecturas SET anulada_en = now()
         WHERE combustible_id = $1 AND origen = 'inicial'`,
        [id]
      )
    );
    return id;
  }

  const leer = (tanqueId: number, nivel: number, cuando: string) =>
    agente
      .post("/api/erp/combustible/lecturas")
      .send({ combustible_id: tanqueId, nivel, leido_en: cuando });

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

  const sugerencias = async (tanqueId: number) => {
    const res = await agente.get(`/api/erp/combustible/${tanqueId}/sugerencia-umbral`);
    expect(res.status).toBe(200);
    return res.body;
  };

  /** Instantes fijos y espaciados: el orden de la muestra no puede depender
   *  de cuánto tardó el test en correr. */
  const t = (dia: number, hora: number) =>
    `2026-08-${String(dia).padStart(2, "0")}T${String(hora).padStart(2, "0")}:00:00.000Z`;

  // ── Umbral por tramo ──────────────────────────────────────────────────

  it("con menos de 10 intervalos no sugiere nada", async () => {
    const tq = await crearTanque();
    await leer(tq, 10000, t(1, 8));
    await leer(tq, 9900, t(1, 9));
    await leer(tq, 9800, t(1, 10));

    const s = await sugerencias(tq);
    expect(s.descuadre.muestraSuficiente).toBe(false);
    // Un intervalo se forma entre DOS lecturas, así que tres lecturas dan
    // dos intervalos (la `inicial` del alta se anuló en el setup).
    expect(s.descuadre.tamanioMuestra).toBe(2);
    expect(s.descuadre.sugerido).toBeUndefined();
  });

  it("un tanque que cierra clavado cae al piso de 1%, no a 0", async () => {
    // Sin piso, un tanque con historial perfecto quedaría con umbral 0 y
    // alertaría por la dilatación térmica del día siguiente.
    const tq = await crearTanque();
    let nivel = 10000;
    for (let i = 0; i < 11; i++) {
      await despachar(tq, 100, t(2, 8 + i));
      nivel -= 100;
      await leer(tq, nivel, t(2, 8 + i));
    }

    const s = await sugerencias(tq);
    expect(s.descuadre.muestraSuficiente).toBe(true);
    expect(s.descuadre.promedio).toBe(0);
    expect(s.descuadre.sugerido).toBe(1);
  });

  it("con ruido real, sugiere por encima del ruido observado", async () => {
    // Cada intervalo pierde 50 L extra sobre un tanque de 10.000 = 0,5%.
    // Muestra constante: promedio 0,5 y desvío 0, así que el sugerido cae al
    // piso de 1% -- que igual queda POR ENCIMA del ruido, que es el punto.
    const tq = await crearTanque();
    let nivel = 10000;
    for (let i = 0; i < 11; i++) {
      await despachar(tq, 100, t(3, 8 + i));
      nivel -= 150;
      await leer(tq, nivel, t(3, 8 + i));
    }

    const s = await sugerencias(tq);
    expect(s.descuadre.muestraSuficiente).toBe(true);
    expect(s.descuadre.promedio).toBeCloseTo(0.5, 1);
    expect(s.descuadre.sugerido).toBeGreaterThanOrEqual(0.5);
  });

  it("devuelve la muestra fila por fila, nunca solo el número", async () => {
    // El módulo no aplica sugerencias solo: la muestra puede estar
    // contaminada con robos reales y eso lo tiene que ver un humano.
    const tq = await crearTanque();
    let nivel = 10000;
    for (let i = 0; i < 11; i++) {
      nivel -= 100;
      await leer(tq, nivel, t(4, 8 + i));
    }

    const s = await sugerencias(tq);
    expect(s.descuadre.muestra).toHaveLength(s.descuadre.tamanioMuestra);
    expect(s.descuadre.muestra[0]).toHaveProperty("descuadreLitros");
    expect(s.descuadre.muestra[0]).toHaveProperty("descuadrePct");
  });

  // ── Umbral del ciclo ──────────────────────────────────────────────────

  it("sin recepciones no hay ciclos que medir", async () => {
    // Un ciclo va de una carga a la siguiente. Sin ninguna carga registrada,
    // el tanque no tiene ciclos cerrados por más lecturas que tenga.
    const tq = await crearTanque();
    let nivel = 10000;
    for (let i = 0; i < 11; i++) {
      nivel -= 100;
      await leer(tq, nivel, t(5, 8 + i));
    }

    const s = await sugerencias(tq);
    expect(s.ciclo.muestraSuficiente).toBe(false);
    expect(s.ciclo.tamanioMuestra).toBe(0);
  });

  it("el ciclo EN CURSO no entra en la muestra", async () => {
    // Todavía puede moverse: contarlo mediría menos acumulación de la que va
    // a terminar teniendo y tiraría la sugerencia para abajo.
    const tq = await crearTanque();
    const grifo = await agente
      .post("/api/erp/combustible/grifos")
      .send({ nombre: idUnico("G"), abastece_tanque: true });

    await leer(tq, 5000, t(6, 8));
    await agente.post("/api/erp/combustible/recepciones").send({
      combustible_id: tq,
      grifo_id: grifo.body.id,
      cantidad: 1000,
      costo_unitario: 16,
      tipo_documento: "factura",
      numero_documento: idUnico("F"),
      recibido_en: t(6, 9),
    });
    await leer(tq, 6000, t(6, 10));
    await leer(tq, 5900, t(6, 11));

    const s = await sugerencias(tq);
    // Hay UN ciclo, y está abierto: no se cerró porque no llegó otra carga.
    expect(s.ciclo.tamanioMuestra).toBe(0);
  });

  it("un ciclo cierra con la carga siguiente, y el descuadre acumula sus intervalos", async () => {
    // Diez ciclos para que la muestra alcance y el endpoint devuelva las
    // filas: es la única forma de verificar la aritmética del acumulado, que
    // es lo que este test existe para fijar.
    //
    // Cada ciclo tiene DOS intervalos y pierde 50 L en cada uno, así que el
    // acumulado del ciclo tiene que dar −100 (telescopan). Si el código
    // midiera solo el último intervalo daría −50, y el test lo agarra.
    const tq = await crearTanque();
    const grifo = await agente
      .post("/api/erp/combustible/grifos")
      .send({ nombre: idUnico("G"), abastece_tanque: true });

    const recepcion = (dia: number, hora: number) =>
      agente.post("/api/erp/combustible/recepciones").send({
        combustible_id: tq,
        grifo_id: grifo.body.id,
        cantidad: 1000,
        costo_unitario: 16,
        tipo_documento: "factura",
        numero_documento: idUnico("F"),
        recibido_en: t(dia, hora),
      });

    // El tanque tiene que despachar lo que recibe: sin eso el nivel sube 900
    // L netos por ciclo y a la quinta carga la recepción se rechaza por
    // capacidad (el tope son 10.000 con tolerancia 0).
    let nivel = 5000;
    await leer(tq, nivel, t(7, 6));
    for (let c = 0; c < 11; c++) {
      const dia = 7 + c;
      await recepcion(dia, 7);
      nivel += 1000;
      await leer(tq, nivel, t(dia, 8)); // abre el ciclo (y cierra el anterior)

      await despachar(tq, 1000, t(dia, 9));
      nivel -= 1000 + 50;
      await leer(tq, nivel, t(dia, 9)); // el vale explica 1000; faltan 50
      nivel -= 50;
      await leer(tq, nivel, t(dia, 10)); // faltan otros 50, sin vale
    }

    const s = await sugerencias(tq);
    // Once cargas: diez ciclos cerrados y el último todavía abierto.
    expect(s.ciclo.tamanioMuestra).toBe(10);
    expect(s.ciclo.muestraSuficiente).toBe(true);
    expect(s.ciclo.muestra[0].descuadreLitros).toBeCloseTo(-100, 0);
    // 100 L sobre un tanque de 10.000 = 1%.
    expect(s.ciclo.muestra[0].descuadrePct).toBeCloseTo(-1, 1);
    expect(s.ciclo.muestra[0].intervalos).toBe(2);
  });

  // ── Umbral de la ventana ──────────────────────────────────────────────

  /** Un tanque cuyos tramos dan exactamente `diferencias` (en litros), sin
   *  vales ni recepciones: cada varilla es la anterior más la diferencia. */
  async function tanqueConTramos(diferencias: number[], dia: number) {
    const tq = await crearTanque();
    let nivel = 9000;
    expect((await leer(tq, nivel, t(dia, 0))).status).toBe(201);
    for (const [i, d] of diferencias.entries()) {
      nivel += d;
      expect((await leer(tq, nivel, t(dia, i + 1))).status).toBe(201);
    }
    return tq;
  }

  /** 11 tramos que alternan +a y +b, empezando por +a. */
  const alternando = (a: number, b: number) =>
    Array.from({ length: 11 }, (_, i) => (i % 2 ? b : a));

  it("con menos de 10 tramos la ventana tampoco sugiere", async () => {
    const tq = await tanqueConTramos([100, -100, 100], 20);

    const s = await sugerencias(tq);
    expect(s.ventana.muestraSuficiente).toBe(false);
    // Mismos tramos que el umbral de descuadre: el mínimo se cuenta igual.
    expect(s.ventana.tamanioMuestra).toBe(s.descuadre.tamanioMuestra);
    expect(s.ventana.sugerido).toBeUndefined();
  });

  it("el error de la varilla NO se multiplica por la cantidad de tramos", async () => {
    // Una varilla que marca 100 L de más y de menos, alternando: +1 %, −1 %.
    // Promedio con signo 1/11 = 0,09 %; desviación √(10,909/10) = 1,044 %.
    // Sugerencia = 2 × 1,044 = 2,1 %.
    //
    // Si el código multiplicara por √n (el error de diseño que se descartó),
    // con 11 tramos daría 2 × 1,044 × √11 = 6,9 %: un umbral que deja pasar
    // el robo de a poco que la ventana existe para agarrar.
    const tq = await tanqueConTramos(alternando(100, -100), 21);

    const s = await sugerencias(tq);
    expect(s.ventana.muestraSuficiente).toBe(true);
    expect(s.ventana.tamanioMuestra).toBe(11);
    expect(s.ventana.promedio).toBeCloseTo(0.09, 2);
    expect(s.ventana.desviacion).toBeCloseTo(1.04, 2);
    expect(s.ventana.sugerido).toBe(2.1);
  });

  it("un robo constante corre el promedio pero NO sube la sugerencia", async () => {
    // El mismo ruido de ±100 L, con 50 L que se van en CADA tramo. La
    // desviación no cambia (correr todos los valores lo mismo no agranda la
    // dispersión), así que la sugerencia tiene que ser idéntica a la del
    // tanque limpio. Si el promedio entrara en la cuenta, el robo subiría el
    // umbral y se volvería invisible.
    const limpio = await sugerencias(await tanqueConTramos(alternando(100, -100), 22));
    const robado = await sugerencias(await tanqueConTramos(alternando(50, -150), 23));

    expect(robado.ventana.promedio).toBeCloseTo(limpio.ventana.promedio - 0.5, 2);
    expect(robado.ventana.desviacion).toBe(limpio.ventana.desviacion);
    expect(robado.ventana.sugerido).toBe(limpio.ventana.sugerido);
    // El umbral por tramo, en cambio, promedia |x|: ese sí se infla con el robo.
    expect(robado.descuadre.sugerido).toBeGreaterThan(limpio.descuadre.sugerido);
  });

  it("sin ruido ni robo cae al piso de 1 %, igual que los otros umbrales", async () => {
    const tq = await tanqueConTramos(Array(11).fill(0), 24);

    const s = await sugerencias(tq);
    expect(s.ventana.desviacion).toBe(0);
    expect(s.ventana.sugerido).toBe(1);
  });

  // ── Las cuatro vienen juntas ──────────────────────────────────────────

  it("un solo request devuelve las cuatro sugerencias", async () => {
    const tq = await crearTanque();
    const s = await sugerencias(tq);
    expect(s).toHaveProperty("diferencia");
    expect(s).toHaveProperty("descuadre");
    expect(s).toHaveProperty("ciclo");
    expect(s).toHaveProperty("ventana");
  });
});
