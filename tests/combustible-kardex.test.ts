/** tests/combustible-kardex.test.ts
 *
 * El kardex del tanque: las tres historias del módulo (despachos,
 * recepciones, lecturas) en UNA línea de tiempo con saldo corriente. Es lo
 * primero que pide un auditor y hasta ahora no existía -- había tres
 * listados que nunca se cruzaban.
 *
 * Lo que estos tests fijan, en orden de importancia:
 *
 * 1. EL SALDO NO SE RE-ANCLA. Es LA decisión de diseño del reporte. Si cada
 *    varilla corrigiera el saldo al nivel medido, un robo de 50 L/día se
 *    vería como veinte filas de -50 (indistinguible del error de varilla) en
 *    vez de un -1.000 final que nadie puede explicar. Es la misma lección de
 *    la migración 0080 con las recepciones.
 * 2. Los anulados SE MUESTRAN pero no cuentan. Un vale anulado es evidencia;
 *    ocultarlo haría un reporte que se maquilla borrando filas.
 * 3. El orden dentro del mismo instante: los movimientos ANTES que la
 *    varilla, porque en la realidad se mide después de cargar.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase } from "../src/server/config/database";

let seq = 0;
const serieUnica = () => `S${Date.now().toString(36).slice(-5)}${(seq++).toString(36)}`;

interface FilaKardex {
  tipo: string;
  documento: string | null;
  entrada: number;
  salida: number;
  nivel_medido: number | null;
  saldo_teorico: number | null;
  dif_tramo: number | null;
  dif_acumulada: number | null;
  anulada: boolean;
  motivo_anulacion: string | null;
  usuario: string;
}

describe("combustible: kardex del tanque", () => {
  let tenantId: string;
  let equipoId: number;
  let grifoId: number;
  const password = "ClaveDePrueba123";
  const ag = request.agent(app);

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    await ag
      .post("/api/auth/login")
      .send({ tenantSlug: c.tenant.slug, email: c.usuario.email, password });

    const eq = await ag
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("VQ"), tipo: "Volquete" });
    equipoId = eq.body.id;

    const g = await ag
      .post("/api/erp/combustible/grifos")
      .send({ nombre: idUnico("Prov"), abastece_tanque: true });
    grifoId = g.body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  const hace = (dias: number) => new Date(Date.now() - dias * 24 * 3600 * 1000).toISOString();

  const leer = (tq: number, nivel: number, cuando: string) =>
    ag.post("/api/erp/combustible/lecturas").send({ combustible_id: tq, nivel, leido_en: cuando });

  async function tanque(nivelInicial = 20000) {
    const r = await ag.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque del kardex",
      tipo_combustible: "diesel_b5",
      unidad: "L",
      tipo_punto: "fijo",
      capacidad_total: 50000,
      nivel_actual: nivelInicial,
      nivel_minimo: 2000,
      modo_vigilancia: "sin_vigilar",
    });
    expect(r.status).toBe(201);
    const tq = r.body.id as number;

    // Varilla de base ANTERIOR al período consultado. Dos motivos, los dos
    // reales: (a) una recepción se rechaza si no hay lectura vigente previa
    // --se valoriza contra el nivel de ESE día, ver 0064--, y (b) es el caso
    // normal, el tanque ya venía midiéndose antes del período del informe.
    const base = await leer(tq, nivelInicial, hace(50));
    expect(base.status).toBe(201);
    return tq;
  }

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

  const despachar = (tq: number, cantidad: number, cuando: string) =>
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
      costo_unitario: 16,
      despachado_en: cuando,
    });

  /** El período del informe: entre la varilla de base (hace 50 días) y un
   *  rato antes de ahora. El corte final NO es cosmético: la lectura
   *  `inicial` que el alta crea se estampa con NOW(), y si entrara al
   *  período aparecería como una medición del final que nadie tomó. */
  const kardex = (tq: number) =>
    ag.get(`/api/erp/combustible/${tq}/kardex`).query({ desde: hace(45), hasta: hace(0.2) });

  // ── 1. La decisión de diseño ──────────────────────────────────────────

  it("el saldo teórico NO se corrige con la varilla: el faltante se acumula", async () => {
    // La simulación de robo, en versión reporte: 50 L por día que ningún
    // control por tramo levanta. Lo que tiene que quedar a la vista es el
    // total, no veinte renglones de -50.
    const tq = await tanque(20000);
    let real = 20000;
    for (let d = 20; d >= 1; d--) {
      real -= 50;
      expect((await leer(tq, real, hace(d))).status).toBe(201);
    }

    const res = await kardex(tq);
    expect(res.status).toBe(200);
    const filas: FilaKardex[] = res.body.filas;
    const varillas = filas.filter((f) => f.tipo === "lectura" && !f.anulada);

    // Sin movimientos declarados, el saldo teórico se queda quieto en el
    // ancla mientras el nivel real baja: la diferencia crece sola.
    const ultima = varillas[varillas.length - 1];
    expect(ultima.dif_acumulada).toBe(-1000);
    // Y cada tramo sigue mostrando los 50 de ese día -- las dos lecturas.
    expect(ultima.dif_tramo).toBe(-50);
    expect(res.body.resumen.descuadre_final).toBe(-1000);
  });

  it("el saldo corriente refleja entradas y salidas en orden", async () => {
    const tq = await tanque(10000);
    await recibir(tq, 5000, hace(10));
    await despachar(tq, 2000, hace(8));
    await leer(tq, 13000, hace(6));

    const filas: FilaKardex[] = (await kardex(tq)).body.filas;
    const rec = filas.find((f) => f.tipo === "recepcion")!;
    const des = filas.find((f) => f.tipo === "despacho")!;
    const lec = filas.filter((f) => f.tipo === "lectura").pop()!;

    expect(rec.saldo_teorico).toBe(15000); // 10.000 + 5.000
    expect(des.saldo_teorico).toBe(13000); // - 2.000
    expect(lec.saldo_teorico).toBe(13000); // la varilla no mueve el saldo
    expect(lec.nivel_medido).toBe(13000);
    expect(lec.dif_acumulada).toBe(0); // cuadra
  });

  it("las tres historias vienen en UNA lista ordenada por fecha", async () => {
    const tq = await tanque(10000);
    await despachar(tq, 300, hace(9));
    await recibir(tq, 1000, hace(7));
    await leer(tq, 10700, hace(5));

    const filas: FilaKardex[] = (await kardex(tq)).body.filas;
    const tipos = filas.map((f) => f.tipo);
    expect(tipos).toContain("despacho");
    expect(tipos).toContain("recepcion");
    expect(tipos).toContain("lectura");

    const fechas = (await kardex(tq)).body.filas.map((f: { ocurrido_en: string }) =>
      Date.parse(f.ocurrido_en)
    );
    expect([...fechas].sort((a, b) => a - b)).toEqual(fechas);
  });

  // ── 2. Los anulados ───────────────────────────────────────────────────

  it("un vale anulado se MUESTRA con su motivo pero no mueve el saldo", async () => {
    const tq = await tanque(10000);
    const d = await despachar(tq, 4000, hace(6));
    expect(d.status).toBe(201);
    await ag
      .patch(`/api/erp/combustible/despachos/${d.body.id}/anular`)
      .send({ motivo: "se tipeó el vale equivocado" });
    await leer(tq, 10000, hace(4));

    const filas: FilaKardex[] = (await kardex(tq)).body.filas;
    const anulado = filas.find((f) => f.tipo === "despacho")!;

    // Sigue en la lista: es evidencia.
    expect(anulado.anulada).toBe(true);
    expect(anulado.motivo_anulacion).toContain("equivocado");
    // Pero no participa de la cuenta -- si contara, la varilla marcaría
    // +4.000 de sobrante inventado.
    const lec = filas.filter((f) => f.tipo === "lectura").pop()!;
    expect(lec.saldo_teorico).toBe(10000);
    expect(lec.dif_acumulada).toBe(0);
    expect((await kardex(tq)).body.resumen.anulados).toBe(1);
  });

  it("una varilla anulada no genera diferencia: su número no es un dato bueno", async () => {
    const tq = await tanque(10000);
    const l = await leer(tq, 3000, hace(5)); // medición equivocada
    await ag
      .patch(`/api/erp/combustible/lecturas/${l.body.lectura.id}/anular`)
      .send({ motivo: "se midió el tanque equivocado" });

    const filas: FilaKardex[] = (await kardex(tq)).body.filas;
    const anulada = filas.find((f) => f.tipo === "lectura" && f.anulada)!;
    expect(anulada.dif_acumulada).toBeNull();
    expect(anulada.dif_tramo).toBeNull();
    expect((await kardex(tq)).body.resumen.descuadre_final).toBeNull();
  });

  // ── 3. Orden dentro del mismo instante ────────────────────────────────

  it("con la misma hora, la varilla ve el efecto de la recepción", async () => {
    // En cancha se mide DESPUÉS de cargar. Si la varilla se ordenara
    // primero, toda recepción cargada con la hora de su medición aparecería
    // como un descuadre gigante.
    const tq = await tanque(10000);
    const momento = hace(3);
    await recibir(tq, 5000, momento);
    await leer(tq, 15000, momento);

    const filas: FilaKardex[] = (await kardex(tq)).body.filas;
    const lec = filas.filter((f) => f.tipo === "lectura").pop()!;
    expect(lec.saldo_teorico).toBe(15000);
    expect(lec.dif_acumulada).toBe(0);
  });

  // ── 4. Contrato del endpoint ──────────────────────────────────────────

  it("el resumen trae lo que va al informe", async () => {
    const tq = await tanque(10000);
    await recibir(tq, 2000, hace(9));
    await despachar(tq, 500, hace(8));
    await leer(tq, 11400, hace(7));

    const r = (await kardex(tq)).body.resumen;
    expect(r.entradas).toBe(2000);
    expect(r.salidas).toBe(500);
    expect(r.mediciones).toBeGreaterThanOrEqual(1);
    expect(r.descuadre_final).toBe(-100); // 11.500 esperado, 11.400 medido
  });

  it("exige las dos fechas y rechaza un período dado vuelta", async () => {
    const tq = await tanque();
    expect((await ag.get(`/api/erp/combustible/${tq}/kardex`)).status).toBe(400);
    expect(
      (
        await ag
          .get(`/api/erp/combustible/${tq}/kardex`)
          .query({ desde: new Date().toISOString(), hasta: hace(10) })
      ).status
    ).toBe(400);
  });

  it("rechaza un período demasiado largo: el kardex no se pagina", async () => {
    const tq = await tanque();
    const res = await ag
      .get(`/api/erp/combustible/${tq}/kardex`)
      .query({ desde: hace(500), hasta: new Date().toISOString() });
    expect(res.status).toBe(400);
  });

  it("un tanque de otro tenant da 404, no el kardex ajeno", async () => {
    const otro = await crearTenantDePrueba(password);
    const agB = request.agent(app);
    await agB
      .post("/api/auth/login")
      .send({ tenantSlug: otro.tenant.slug, email: otro.usuario.email, password });
    try {
      const tq = await tanque();
      const res = await agB
        .get(`/api/erp/combustible/${tq}/kardex`)
        .query({ desde: hace(30), hasta: new Date().toISOString() });
      expect(res.status).toBe(404);
    } finally {
      await borrarTenantDePrueba(otro.tenant.id);
    }
  });

  it("fuera del período no entra nada", async () => {
    const tq = await tanque(10000);
    await despachar(tq, 700, hace(44));
    await leer(tq, 9300, hace(43));

    const res = await ag
      .get(`/api/erp/combustible/${tq}/kardex`)
      .query({ desde: hace(10), hasta: new Date().toISOString() });
    const tipos = res.body.filas.map((f: FilaKardex) => f.tipo);
    expect(tipos).not.toContain("despacho");
  });
});
