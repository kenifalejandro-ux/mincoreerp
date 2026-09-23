/** tests/combustible-umbral-piso.test.ts
 *
 * EL UMBRAL COMO PISO FIJO + PORCENTAJE DE LO MOVIDO (migración 0101).
 *
 * Hasta acá la tolerancia de los tres controles de descuadre era
 * `capacidad × pct`: un número FIJO para todos los tramos del tanque. El
 * problema no era el número elegido sino el modelo -- el ruido tiene dos
 * fuentes que escalan distinto (la varilla, que no depende del movimiento;
 * los medidores, que sí), y con un solo parámetro el tramo tranquilo termina
 * pagando el ruido del tramo movido.
 *
 * El par de tests que lo demuestra es el segundo y el tercero: MISMO
 * descuadre de 160 L en el mismo tanque, uno alerta y el otro no, y la única
 * diferencia es cuánto combustible pasó por los medidores en el tramo.
 *
 * Los tests que fijan que las bandas VIEJAS no se movieron están en sus
 * archivos de siempre (combustible-descuadre, -ciclo-y-sin-medir,
 * -descuadre-ventana): ahí los umbrales se expresan como piso puro, que es
 * la misma traducción que la migración aplicó a los tanques existentes.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase } from "../src/server/config/database";

describe("combustible: el umbral es piso + % de lo movido (migración 0101)", () => {
  let tenantId: string;
  let grifoId: number;
  let equipoId: number;
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

    const e = await ag
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("EX"), tipo: "Excavadora" });
    equipoId = e.body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  const hace = (dias: number) => new Date(Date.now() - dias * 24 * 3600 * 1000).toISOString();

  /** Tanque de 20.000 L. Los umbrales se pasan como el par completo. */
  async function tanque(umbrales: Record<string, number | null> = {}) {
    const r = await ag.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque del piso",
      tipo_combustible: "diesel_b5",
      unidad: "L",
      tipo_punto: "fijo",
      capacidad_total: 20000,
      nivel_actual: 18000,
      modo_vigilancia: "personalizado",
      ...umbrales,
    });
    expect(r.status).toBe(201);
    return r.body.id as number;
  }

  const leer = (tq: number, nivel: number, cuando: string) =>
    ag.post("/api/erp/combustible/lecturas").send({ combustible_id: tq, nivel, leido_en: cuando });

  const despachar = (tq: number, cantidad: number, cuando: string) =>
    ag.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tq,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipoId,
      serie_talonario: idUnico("S").slice(0, 20),
      n_vale: 1,
      cantidad,
      lectura_contometro: cantidad,
      costo_unitario: 16,
      despachado_en: cuando,
    });

  const alertasDe = async (tq: number, tipo: string) => {
    const r = await ag.get("/api/erp/combustible/alertas").query({ pageSize: 300 });
    return r.body.data.filter(
      (a: { tipo: string; combustible_id: number }) => a.tipo === tipo && a.combustible_id === tq
    );
  };

  const ficha = async (tq: number) => (await ag.get(`/api/erp/combustible/${tq}`)).body;

  /** Un PUT completo con la ficha actual, cambiando solo lo que se pida.
   *  El PUT reemplaza la fila entera, así que hay que mandarla toda. */
  const editar = async (tq: number, cambios: Record<string, unknown>) => {
    const f = await ficha(tq);
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
      umbral_descuadre_pct: num(f.umbral_descuadre_pct),
      umbral_descuadre_ciclo_pct: num(f.umbral_descuadre_ciclo_pct),
      umbral_descuadre_ventana_pct: num(f.umbral_descuadre_ventana_pct),
      ...cambios,
    });
  };

  // ── El par (pct, piso) es atómico ────────────────────────────────────

  it("mandar el porcentaje sin piso deja el piso en 0, no en NULL", async () => {
    // El lado ESTRICTO: sin piso, la tolerancia es solo la parte
    // proporcional. Un llamador viejo que no conoce el campo endurece el
    // control, nunca lo afloja -- que es la única dirección segura para un
    // default que nadie eligió.
    const tq = await tanque({ umbral_descuadre_pct: 1 });
    const f = await ficha(tq);
    expect(Number(f.umbral_descuadre_pct)).toBe(1);
    expect(Number(f.umbral_descuadre_piso)).toBe(0);
  });

  it("umbral en NULL apaga el par entero: el piso también queda en NULL", async () => {
    // Un piso colgando de un umbral apagado sería un número que no hace
    // nada, esperando a que alguien encienda el control sin darse cuenta de
    // qué banda está heredando.
    const tq = await tanque({ umbral_descuadre_pct: null, umbral_descuadre_piso: 500 });
    const f = await ficha(tq);
    expect(f.umbral_descuadre_pct).toBeNull();
    expect(f.umbral_descuadre_piso).toBeNull();
  });

  it("omitir el piso en el PUT CONSERVA el que había", async () => {
    // La protección para la cola offline y para el formulario hasta que se
    // actualice: mandan los cuatro porcentajes y ningún piso, y no pueden
    // por eso bajarle la banda al tanque a 0 y llenar de falsos positivos.
    const tq = await tanque({ umbral_descuadre_pct: 0, umbral_descuadre_piso: 300 });
    const res = await editar(tq, {}); // sin ningún piso en el body
    expect(res.status).toBe(200);
    expect(Number((await ficha(tq)).umbral_descuadre_piso)).toBe(300);
  });

  // ── El corazón: la misma diferencia, dos veredictos ──────────────────

  it("un tramo SIN movimiento tolera solo el piso", async () => {
    const tq = await tanque({ umbral_descuadre_pct: 0.5, umbral_descuadre_piso: 150 });
    await leer(tq, 18000, hace(10));
    // Ni un despacho: el único ruido posible es el de las dos varillas, y
    // eso es exactamente lo que cubre el piso. 160 > 150 -> alerta.
    await leer(tq, 17840, hace(9));

    const al = await alertasDe(tq, "descuadre_inventario");
    expect(al).toHaveLength(1);
    expect(al[0].detalle.toleradoLitros).toBe(150);
    expect(al[0].detalle.movimiento).toBe(0);
    expect(al[0].detalle.descuadreLitros).toBe(-160);
  });

  it("el MISMO descuadre de 160 L NO alerta si por el tramo pasaron 3.000 L", async () => {
    // El test hermano del anterior, y la demostración entera del cambio.
    // Tolerancia = 150 + 0,5% de 3.000 = 165. Los mismos 160 L que en un
    // tramo quieto eran una anomalía, acá están dentro del ruido que los
    // medidores pueden justificar.
    //
    // Con el modelo viejo los dos casos toleraban lo mismo, y el número
    // tenía que servir para los dos: ajustado para este, el tramo quieto
    // regalaba tolerancia; ajustado para el quieto, este alertaba por ruido
    // de medidor.
    const tq = await tanque({ umbral_descuadre_pct: 0.5, umbral_descuadre_piso: 150 });
    await leer(tq, 18000, hace(10));
    await despachar(tq, 3000, hace(9.5));
    // Debería quedar en 15.000; la varilla marca 14.840.
    await leer(tq, 14840, hace(9));

    expect(await alertasDe(tq, "descuadre_inventario")).toHaveLength(0);
  });

  it("con el mismo tramo movido, 200 L sí pasan la línea", async () => {
    // Para que el test de arriba no pase por no haberse evaluado nada: el
    // control está vivo, lo que cambió es dónde está la línea (165 L).
    const tq = await tanque({ umbral_descuadre_pct: 0.5, umbral_descuadre_piso: 150 });
    await leer(tq, 18000, hace(10));
    await despachar(tq, 3000, hace(9.5));
    await leer(tq, 14800, hace(9));

    const al = await alertasDe(tq, "descuadre_inventario");
    expect(al).toHaveLength(1);
    expect(al[0].detalle.toleradoLitros).toBe(165);
    expect(al[0].detalle.piso).toBe(150);
    expect(al[0].detalle.movimiento).toBe(3000);
  });

  it("piso 0 y porcentaje 0 es tolerancia cero de verdad", async () => {
    const tq = await tanque({ umbral_descuadre_pct: 0, umbral_descuadre_piso: 0 });
    await leer(tq, 18000, hace(10));
    await leer(tq, 17999, hace(9));

    const al = await alertasDe(tq, "descuadre_inventario");
    expect(al).toHaveLength(1);
    expect(al[0].detalle.descuadreLitros).toBe(-1);
  });

  it("la recepción también cuenta como movimiento: suma, no resta", async () => {
    // El descuadre se calcula con signo porque el combustible entra y sale,
    // pero el ERROR de medición no se compensa entre una recepción y un
    // despacho -- cada medición aporta su propia incertidumbre. Un tramo con
    // 2.000 L recibidos y 2.000 despachados movió 4.000, no 0.
    const tq = await tanque({ umbral_descuadre_pct: 10, umbral_descuadre_piso: 0 });
    await leer(tq, 8000, hace(10));
    await ag.post("/api/erp/combustible/recepciones").send({
      combustible_id: tq,
      grifo_id: grifoId,
      cantidad: 2000,
      costo_unitario: 16,
      tipo_documento: "factura",
      numero_documento: idUnico("F"),
      recibido_en: hace(9.7),
    });
    await despachar(tq, 2000, hace(9.5));
    // Balance esperado 8.000; la varilla marca 7.700 (faltan 300).
    // Tolerancia = 0 + 10% de 4.000 = 400 -> no alerta.
    await leer(tq, 7700, hace(9));

    const al = await alertasDe(tq, "descuadre_inventario");
    expect(al).toHaveLength(0);
  });

  // ── Subir el piso es aflojar ─────────────────────────────────────────

  it("subir el piso sin motivo se rechaza, igual que subir el porcentaje", async () => {
    // Después de la migración el piso es, en la práctica, TODA la banda de
    // los tanques que ya existían. Sin esta regla se podía multiplicar la
    // tolerancia de un tanque y que la auditoría no lo distinguiera de
    // renombrarlo -- el hueco exacto que `evaluarAflojamiento` vino a cerrar.
    const tq = await tanque({ umbral_descuadre_pct: 0, umbral_descuadre_piso: 200 });

    const sinMotivo = await editar(tq, { umbral_descuadre_piso: 5000 });
    expect(sinMotivo.status).toBe(400);
    expect(sinMotivo.body.requiere_motivo).toBe(true);
    expect(
      (sinMotivo.body.aflojados as { control: string }[]).some((c) => c.control.includes("Piso"))
    ).toBe(true);

    const conMotivo = await editar(tq, {
      umbral_descuadre_piso: 5000,
      motivo_ajuste: "la varilla de este tanque resultó más ruidosa",
    });
    expect(conMotivo.status).toBe(200);
  });

  it("BAJAR el piso no pide motivo: endurecer nunca lo pide", async () => {
    const tq = await tanque({ umbral_descuadre_pct: 0, umbral_descuadre_piso: 500 });
    const res = await editar(tq, { umbral_descuadre_piso: 100 });
    expect(res.status).toBe(200);
    expect(Number((await ficha(tq)).umbral_descuadre_piso)).toBe(100);
  });

  // ── El vector que se cerró solo ──────────────────────────────────────

  it("subir la capacidad ya NO ensancha la banda de descuadre", async () => {
    // Con el modelo viejo los tres umbrales se medían como % de la
    // capacidad, así que pasar el tanque de 20.000 a 200.000 multiplicaba
    // por diez todas las bandas sin tocar ningún umbral. Era la forma más
    // discreta de apagar la vigilancia que tenía el modelo.
    //
    // Ahora la capacidad no entra en la cuenta: el mismo descuadre que
    // alertaba antes del cambio de ficha sigue alertando después.
    const tq = await tanque({ umbral_descuadre_pct: 0, umbral_descuadre_piso: 200 });
    await leer(tq, 18000, hace(10));
    await leer(tq, 17700, hace(9)); // −300 contra una banda de 200
    expect(await alertasDe(tq, "descuadre_inventario")).toHaveLength(1);

    const subida = await editar(tq, {
      capacidad_total: 200000,
      motivo_ajuste: "se amplió el tanque",
    });
    expect(subida.status).toBe(200);

    await leer(tq, 17400, hace(8)); // otros −300, misma banda de 200
    expect(await alertasDe(tq, "descuadre_inventario")).toHaveLength(2);
  });

  it("subir la capacidad sigue pidiendo motivo, pero por el techo de recepción", async () => {
    // La regla no se borró al cambiar el modelo: más capacidad sigue
    // aflojando por otros dos lados (el techo para aceptar una recepción y
    // el mínimo que abre un ciclo nuevo).
    const tq = await tanque({ umbral_descuadre_pct: 0, umbral_descuadre_piso: 200 });
    const res = await editar(tq, { capacidad_total: 200000 });
    expect(res.status).toBe(400);
    expect(
      (res.body.aflojados as { control: string }[]).some((c) => c.control.includes("Capacidad"))
    ).toBe(true);
  });

  // ── El ciclo comparte el piso con el tramo ───────────────────────────

  it("el ciclo usa el mismo piso que el tramo, sobre más movimiento", async () => {
    // Los dos controles miran las mismas dos varillas (la del arranque y la
    // de ahora), así que el error fijo es el mismo. Lo único que los separa
    // es cuánto movimiento acumula cada ventana -- ya no son dos números
    // elegidos por separado que pueden contradecirse.
    const tq = await tanque({
      umbral_descuadre_pct: 1,
      umbral_descuadre_piso: 100,
      umbral_descuadre_ciclo_pct: 1,
      umbral_descuadre_ciclo_piso: 100,
    });
    await leer(tq, 18000, hace(10));

    // Cuatro tramos de 1.000 L despachados con 90 L de faltante cada uno.
    // Por tramo: 90 contra 100 + 1% de 1.000 = 110 -> callan los cuatro.
    let nivel = 18000;
    for (let i = 0; i < 4; i++) {
      await despachar(tq, 1000, hace(9 - i * 0.5));
      nivel -= 1090;
      await leer(tq, nivel, hace(8.75 - i * 0.5));
    }
    expect(await alertasDe(tq, "descuadre_inventario")).toHaveLength(0);

    // El ciclo: 360 L de faltante contra 100 + 1% de 4.000 = 140. Habla.
    const al = await alertasDe(tq, "descuadre_ciclo");
    expect(al.length).toBeGreaterThan(0);
    expect(al[0].detalle.piso).toBe(100);
    expect(al[0].detalle.movimiento).toBe(4000);
    expect(al[0].detalle.toleradoLitros).toBe(140);
  });

  // ── La diferencia de recepción ───────────────────────────────────────

  it("la diferencia de recepción también suma piso + % de lo entregado", async () => {
    // Su base NO cambió con 0101 (siempre se midió contra lo entregado),
    // pero estrena piso: la diferencia se calcula con las dos varillas que
    // encierran la descarga, así que arrastra el mismo error fijo.
    const tq = await tanque({ umbral_diferencia_pct: 1, umbral_diferencia_piso: 100 });
    await leer(tq, 8000, hace(10));
    await ag.post("/api/erp/combustible/recepciones").send({
      combustible_id: tq,
      grifo_id: grifoId,
      cantidad: 5000,
      costo_unitario: 16,
      tipo_documento: "factura",
      numero_documento: idUnico("F"),
      recibido_en: hace(9.5),
    });
    // Facturaron 5.000 y entraron 4.860: faltan 140. Tolerancia = 100 + 1%
    // de 5.000 = 150 -> todavía dentro.
    await leer(tq, 12860, hace(9));
    await ag.post("/api/erp/combustible/conciliacion").send({});
    expect(await alertasDe(tq, "diferencia_recepcion")).toHaveLength(0);
  });
});
