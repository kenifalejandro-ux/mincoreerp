/** tests/combustible-vale-retro-y-recargado.test.ts
 *
 * Hallazgos 2 y 3 del red team de operación. Ninguno se ataca bloqueando: los
 * dos mecanismos que explotan son deliberados y correctos, y lo que faltaba
 * era la señal.
 *
 * 2. EL VALE RETRO-FECHADO. `despachado_en` lo escribe quien carga; el evento
 *    de auditoría lo estampa el servidor. Fechando el vale antes de un
 *    aflojamiento, salía de la cuenta del reporte de controles. La señal es
 *    la distancia entre CUÁNDO PASÓ y CUÁNDO ENTRÓ: la cola offline produce
 *    horas, no semanas.
 *
 * 3. EL VALE RECARGADO. La unicidad de 0067 es parcial a propósito -- si
 *    anular el 00022 impidiera volver a cargarlo, corregir un tipeo borraría
 *    del sistema un despacho que sí ocurrió. Esa misma migración anticipó que
 *    el patrón sería la señal y dejó el detector sin escribir. Lo que importa
 *    no es que el número se reutilice, sino QUE LA CANTIDAD CAMBIE.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase } from "../src/server/config/database";

describe("combustible: vale retro-fechado y vale recargado (migración 0081)", () => {
  let tenantId: string;
  let equipoId: number;
  let tq: number;
  const password = "ClaveDePrueba123";
  const ag = request.agent(app);
  const hace = (dias: number) => new Date(Date.now() - dias * 864e5).toISOString();
  let seq = 0;
  const serie = () => `V${Date.now().toString(36).slice(-4)}${(seq++).toString(36)}`;

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
      dias_sin_medir: 30,
      dias_ventana_descuadre: 30,
      dias_carga_retroactiva: 3,
      llenados_por_dia_max: null,
      tope_diario_sin_capacidad_l: null,
    });
    const t = await ag.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "T",
      tipo_combustible: "diesel_b5",
      unidad: "L",
      tipo_punto: "fijo",
      capacidad_total: 50000,
      nivel_actual: 40000,
      nivel_minimo: 1000,
      modo_vigilancia: "sin_vigilar",
    });
    tq = t.body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  const despachar = (s: string, n: number, cantidad: number, cuando: string) =>
    ag.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tq,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipoId,
      serie_talonario: s,
      n_vale: n,
      cantidad,
      lectura_contometro: cantidad,
      costo_unitario: 16,
      despachado_en: cuando,
    });

  const alertasDe = async (tipo: string, s: string) => {
    const r = await ag.get("/api/erp/combustible/alertas").query({ pageSize: 400 });
    return (
      r.body.data as { tipo: string; serie_talonario: string; detalle: Record<string, unknown> }[]
    ).filter((a) => a.tipo === tipo && a.serie_talonario === s);
  };

  // ── 2. El vale retro-fechado ──────────────────────────────────────────

  it("un vale cargado 20 días después de su fecha alerta, sin bloquear", async () => {
    const s = serie();
    const r = await despachar(s, 1, 300, hace(20));
    // No bloquea: perder un vale real de cancha sería peor.
    expect(r.status).toBe(201);

    const al = await alertasDe("despacho_retroactivo", s);
    expect(al).toHaveLength(1);
    expect(Number(al[0].detalle.diasDeAtraso)).toBeGreaterThan(19);
    expect(Number(al[0].detalle.diasTolerados)).toBe(3);
  });

  it("un vale del día no alerta: es el caso normal", async () => {
    const s = serie();
    expect((await despachar(s, 1, 300, new Date().toISOString())).status).toBe(201);
    expect(await alertasDe("despacho_retroactivo", s)).toHaveLength(0);
  });

  it("dos días de atraso tampoco: es la cola offline haciendo su trabajo", async () => {
    // Un tanque sin señal sincroniza cuando el operador vuelve a base. Si eso
    // alertara, el control saltaría con el trabajo normal y se ignoraría.
    const s = serie();
    expect((await despachar(s, 1, 300, hace(2))).status).toBe(201);
    expect(await alertasDe("despacho_retroactivo", s)).toHaveLength(0);
  });

  // ── 3. El vale recargado ──────────────────────────────────────────────

  it("recargar un vale anulado con OTRA cantidad alerta y dice cuánto se movió", async () => {
    const s = serie();
    const primero = await despachar(s, 7, 900, new Date().toISOString());
    expect(primero.status).toBe(201);
    await ag
      .patch(`/api/erp/combustible/despachos/${primero.body.id}/anular`)
      .send({ motivo: "error de tipeo" });

    // El mismo número vuelve declarando 660 L menos.
    const segundo = await despachar(s, 7, 240, new Date().toISOString());
    expect(segundo.status).toBe(201);

    const al = await alertasDe("vale_recargado", s);
    expect(al).toHaveLength(1);
    expect(Number(al[0].detalle.cantidadAnulada)).toBe(900);
    expect(Number(al[0].detalle.cantidadNueva)).toBe(240);
    expect(Number(al[0].detalle.diferencia)).toBe(-660);
    // La dirección importa: recargar por menos es declarar que salió menos.
    expect(al[0].detalle.sentido).toBe("declara_menos");
  });

  it("recargar con la MISMA cantidad no alerta: se corrigió otra cosa", async () => {
    // El equipo, la hora, el contómetro. El combustible declarado no se movió,
    // así que marcarlo sería ruido -- y un control ruidoso se ignora.
    const s = serie();
    const primero = await despachar(s, 3, 400, new Date().toISOString());
    await ag
      .patch(`/api/erp/combustible/despachos/${primero.body.id}/anular`)
      .send({ motivo: "se cargó al equipo equivocado" });
    expect((await despachar(s, 3, 400, new Date().toISOString())).status).toBe(201);

    expect(await alertasDe("vale_recargado", s)).toHaveLength(0);
  });

  it("un vale nuevo, sin anulaciones previas, no alerta", async () => {
    const s = serie();
    await despachar(s, 1, 500, new Date().toISOString());
    expect(await alertasDe("vale_recargado", s)).toHaveLength(0);
  });

  it("cuenta las anulaciones acumuladas del número: el patrón es la señal", async () => {
    // Lo que 0067 dejó escrito: "un número con tres anulaciones y una vigente
    // queda visible como tal, y ese patrón, si se repite, es en sí mismo
    // señal para la conciliación".
    const s = serie();
    for (const cant of [800, 600]) {
      const d = await despachar(s, 9, cant, new Date().toISOString());
      await ag
        .patch(`/api/erp/combustible/despachos/${d.body.id}/anular`)
        .send({ motivo: "otra vez mal" });
    }
    await despachar(s, 9, 100, new Date().toISOString());

    // Dos recargas, dos alertas: la del 600 (con 1 anulación previa) y la del
    // 100 (con 2). Se busca por contenido y no por posición -- la lista viene
    // de la más nueva a la más vieja.
    const al = await alertasDe("vale_recargado", s);
    expect(al).toHaveLength(2);
    const tercera = al.find((a) => Number(a.detalle.anulacionesPrevias) === 2);
    expect(tercera).toBeDefined();
    // Compara contra la ÚLTIMA anulada, que es el estado del que se viene.
    expect(Number(tercera!.detalle.cantidadAnulada)).toBe(600);
    expect(Number(tercera!.detalle.cantidadNueva)).toBe(100);
  });

  // ── Aflojar el control nuevo ──────────────────────────────────────────

  it("subir los días de carga retroactiva queda auditado como aflojamiento", async () => {
    const base = {
      ventana_gracia_horas: 72,
      dias_sin_medir: 30,
      dias_ventana_descuadre: 30,
      llenados_por_dia_max: null,
      tope_diario_sin_capacidad_l: null,
    };
    await ag.put("/api/erp/combustible/config").send({ ...base, dias_carga_retroactiva: 3 });
    const r = await ag
      .put("/api/erp/combustible/config")
      .send({ ...base, dias_carga_retroactiva: 90 });
    expect(r.status).toBe(200);

    const bit = await ag.get("/api/erp/combustible/bitacora").query({ pageSize: 50 });
    const fila = bit.body.data.find(
      (f: { accion: string }) => f.accion === "combustible.config_vigilancia_reducida"
    );
    const aflojados = fila.detalle.aflojados as { control: string }[];
    expect(aflojados.some((c) => c.control.includes("carga retroactiva"))).toBe(true);

    await ag.put("/api/erp/combustible/config").send({ ...base, dias_carga_retroactiva: 3 });
  });
});
