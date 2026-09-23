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
    expect(s.balance.muestraSuficiente).toBe(false);
    // Un intervalo se forma entre DOS lecturas, así que tres lecturas dan
    // dos intervalos (la `inicial` del alta se anuló en el setup).
    expect(s.balance.tamanioMuestra).toBe(2);
    expect(s.balance.piso).toBeUndefined();
    expect(s.balance.pct).toBeUndefined();
  });

  it("un tanque que cierra clavado cae al piso por dilatación, no a 0", async () => {
    // Sin piso mínimo, un tanque con historial perfecto quedaría con
    // tolerancia 0 y alertaría por la dilatación térmica del día siguiente.
    const tq = await crearTanque();
    let nivel = 10000;
    for (let i = 0; i < 11; i++) {
      await despachar(tq, 100, t(2, 8 + i));
      nivel -= 100;
      await leer(tq, nivel, t(2, 8 + i));
    }

    const s = await sugerencias(tq);
    expect(s.balance.muestraSuficiente).toBe(true);
    // 1 % de la capacidad (10.000), en litros. Antes esto se expresaba como
    // "sugerido: 1 %" y había que multiplicarlo a mano.
    expect(s.balance.piso).toBe(100);
    expect(s.balance.pct).toBe(0);
  });

  it("con ruido real, el piso queda por encima del ruido observado", async () => {
    // Cada intervalo pierde 50 L extra. Todos los tramos mueven lo mismo
    // (100 L de vale), así que la pendiente no es estimable y el ruido va
    // entero al piso -- que es lo correcto: es la opción que no crece.
    const tq = await crearTanque();
    let nivel = 10000;
    for (let i = 0; i < 11; i++) {
      await despachar(tq, 100, t(3, 8 + i));
      nivel -= 150;
      await leer(tq, nivel, t(3, 8 + i));
    }

    const s = await sugerencias(tq);
    expect(s.balance.muestraSuficiente).toBe(true);
    expect(s.balance.movimientoConDispersion).toBe(false);
    expect(s.balance.pct).toBe(0);
    expect(s.balance.piso).toBeGreaterThanOrEqual(50);
  });

  it("con tramos de tamaños distintos SÍ separa el piso del porcentaje", async () => {
    // El caso que el modelo viejo no podía representar. Se fabrica un tanque
    // cuyo error es 20 L fijos más el 2 % de lo despachado, y se comprueba
    // que el ajuste recupera los dos números por separado en vez de
    // promediarlos en uno solo.
    const tq = await crearTanque();
    // Tramos de tamaños muy distintos, todos dentro de la capacidad (10.000).
    const despachos = [50, 100, 150, 200, 300, 400, 500, 600, 700, 800, 900];
    let nivel = 9900;
    expect((await leer(tq, nivel, t(5, 0))).status).toBe(201);
    for (const [i, cantidad] of despachos.entries()) {
      expect((await despachar(tq, cantidad, t(5, i + 1))).status).toBe(201);
      nivel -= cantidad + (20 + cantidad * 0.02);
      expect((await leer(tq, nivel, t(5, i + 1))).status).toBe(201);
    }

    const s = await sugerencias(tq);
    expect(s.balance.muestraSuficiente).toBe(true);
    expect(s.balance.movimientoConDispersion).toBe(true);
    // La pendiente real: 2 % de lo movido.
    expect(s.balance.pct).toBeCloseTo(2, 1);
    // El piso queda en el mínimo por dilatación (1 % de 10.000 = 100), que
    // está por encima de los 20 L fijos reales. También es correcto: por
    // debajo de la dilatación el umbral alertaría por el clima.
    expect(s.balance.piso).toBe(100);
    // Y la traducción que hace legible el par: qué tolera en un tramo típico.
    expect(s.balance.movimientoTipico).toBe(400);
  });

  it("devuelve la muestra fila por fila, nunca solo los números", async () => {
    // El módulo no aplica sugerencias solo: la muestra puede estar
    // contaminada con robos reales y eso lo tiene que ver un humano.
    const tq = await crearTanque();
    let nivel = 10000;
    for (let i = 0; i < 11; i++) {
      nivel -= 100;
      await leer(tq, nivel, t(4, 8 + i));
    }

    const s = await sugerencias(tq);
    expect(s.balance.muestra).toHaveLength(s.balance.tamanioMuestra);
    expect(s.balance.muestra[0]).toHaveProperty("descuadreLitros");
    // La columna nueva: sin el movimiento de cada fila no se puede
    // reconstruir la recta ni entender por qué una fila tolera más que otra.
    expect(s.balance.muestra[0]).toHaveProperty("movimiento");
  });

  // ── El ciclo comparte el par con el tramo ─────────────────────────────

  it("el ciclo NO tiene su propia calibración: usa el par del balance", async () => {
    // Decisión de 0101, y es el punto del cambio de modelo. El tramo y el
    // ciclo miran las mismas dos varillas y los mismos medidores: el error
    // fijo y el proporcional son los mismos, y lo único que los distingue es
    // cuánto movimiento suma cada uno, que ya está en la fórmula de la
    // alerta. Calibrarlos por separado era pedir dos números que nada
    // obligaba a ser coherentes entre sí.
    const tq = await crearTanque();
    const s = await sugerencias(tq);
    expect(s.ciclo).toBeUndefined();
    expect(s).toHaveProperty("balance");
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
    // Mismos tramos que el balance: el mínimo se cuenta igual.
    expect(s.ventana.tamanioMuestra).toBe(s.balance.tamanioMuestra);
    expect(s.ventana.piso).toBeUndefined();
  });

  it("el error de la varilla NO se multiplica por la cantidad de tramos", async () => {
    // Una varilla que marca 100 L de más y de menos, alternando. Sin
    // movimiento en ningún tramo, la pendiente no se estima y el piso es
    // 2 × la desviación de los valores con signo: 2 × 104,4 = 208,8 L.
    //
    // Si el código multiplicara por √n (el error de diseño que se descartó),
    // con 11 tramos daría 692 L: un umbral que deja pasar el robo de a poco
    // que la ventana existe para agarrar.
    const tq = await tanqueConTramos(alternando(100, -100), 21);

    const s = await sugerencias(tq);
    expect(s.ventana.muestraSuficiente).toBe(true);
    expect(s.ventana.tamanioMuestra).toBe(11);
    expect(s.ventana.piso).toBeCloseTo(208.8, 0);
    expect(s.ventana.piso).toBeLessThan(300);
  });

  it("un robo constante corre el promedio pero NO sube la sugerencia", async () => {
    // El mismo ruido de ±100 L, con 50 L que se van en CADA tramo. La
    // desviación no cambia (correr todos los valores lo mismo no agranda la
    // dispersión), así que la sugerencia tiene que ser idéntica a la del
    // tanque limpio. Si el promedio entrara en la cuenta, el robo subiría el
    // umbral y se volvería invisible.
    const limpio = await sugerencias(await tanqueConTramos(alternando(100, -100), 22));
    const robado = await sugerencias(await tanqueConTramos(alternando(50, -150), 23));

    // El piso de la ventana sale de la dispersión alrededor de la recta, y
    // correr todos los valores lo mismo no agranda la dispersión.
    expect(robado.ventana.piso).toBe(limpio.ventana.piso);
    // El del balance, en cambio, sale de |x|: ese sí se infla con el robo, y
    // es la razón por la que la ventana necesita su propia cuenta.
    expect(robado.balance.piso).toBeGreaterThan(limpio.balance.piso);
  });

  it("sin ruido ni robo cae al piso por dilatación, igual que el balance", async () => {
    const tq = await tanqueConTramos(Array(11).fill(0), 24);

    const s = await sugerencias(tq);
    // 1 % de la capacidad del tanque de estos tests.
    expect(s.ventana.piso).toBe(s.balance.piso);
    expect(s.ventana.pct).toBe(0);
  });

  it("la ventana usa el MISMO porcentaje que el balance", async () => {
    // El error del medidor es una propiedad del medidor, no de la ventana
    // desde la que se lo mire. Y estimarlo con los valores con signo sería
    // absorber en la pendiente un robo proporcional al despacho.
    const tq = await crearTanque();
    const despachos = [50, 100, 150, 200, 300, 400, 500, 600, 700, 800, 900];
    let nivel = 9900;
    expect((await leer(tq, nivel, t(6, 0))).status).toBe(201);
    for (const [i, cantidad] of despachos.entries()) {
      expect((await despachar(tq, cantidad, t(6, i + 1))).status).toBe(201);
      nivel -= cantidad + cantidad * 0.02;
      expect((await leer(tq, nivel, t(6, i + 1))).status).toBe(201);
    }

    const s = await sugerencias(tq);
    expect(s.balance.pct).toBeGreaterThan(0);
    expect(s.ventana.pct).toBe(s.balance.pct);
  });

  // ── Las cuatro vienen juntas ──────────────────────────────────────────

  it("un solo request devuelve los tres pares", async () => {
    const tq = await crearTanque();
    const s = await sugerencias(tq);
    expect(s).toHaveProperty("diferencia");
    expect(s).toHaveProperty("balance");
    expect(s).toHaveProperty("ventana");
  });
});
