/** tests/combustible-reporte-controles.test.ts
 *
 * El estado de la vigilancia DURANTE un período, que no es lo mismo que su
 * estado de hoy.
 *
 * Sale de la conversación sobre qué hace un auditor. El correo de
 * aflojamiento avisa en el momento, pero se esquiva eligiendo la hora: bajar
 * el umbral un viernes a la noche, sacar el sábado, reponerlo el domingo. El
 * lunes la ficha del tanque se ve impecable.
 *
 * Lo que el ladrón no puede hacer es reescribir el registro. Este reporte lee
 * esa historia y le pone al lado el número que la vuelve un hallazgo: cuánto
 * salió DESPUÉS de cada aflojamiento.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase } from "../src/server/config/database";

let seq = 0;
const serie = () => `S${Date.now().toString(36).slice(-4)}${(seq++).toString(36)}`;

interface EventoControl {
  cuando: string;
  accion: string;
  quien: string;
  combustible_id: number | null;
  motivo: string | null;
  aflojados: { control: string; de: string; a: string }[];
  despachado_despues_l: number;
  vales_despues: number;
}

describe("combustible: reporte de estado de los controles del período", () => {
  let tenantId: string;
  let equipoId: number;
  const password = "ClaveDePrueba123";
  const ag = request.agent(app);
  const hace = (d: number) => new Date(Date.now() - d * 864e5).toISOString();

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    await ag
      .post("/api/auth/login")
      .send({ tenantSlug: c.tenant.slug, email: c.usuario.email, password });
    const e = await ag
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("VQ"), tipo: "Volquete" });
    equipoId = e.body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  async function tanque(extra: Record<string, unknown> = {}) {
    const r = await ag.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "T",
      tipo_combustible: "diesel_b5",
      unidad: "L",
      tipo_punto: "fijo",
      capacidad_total: 20000,
      nivel_actual: 20000,
      nivel_minimo: 2000,
      modo_vigilancia: "personalizado",
      umbral_descuadre_pct: 1,
      umbral_descuadre_ciclo_pct: 1,
      umbral_descuadre_ventana_pct: 1,
      umbral_diferencia_pct: 1,
      ...extra,
    });
    expect(r.status).toBe(201);
    return r.body.id as number;
  }

  const editar = async (tq: number, cambios: Record<string, unknown>) => {
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
      umbral_descuadre_pct: num(f.umbral_descuadre_pct),
      umbral_descuadre_ciclo_pct: num(f.umbral_descuadre_ciclo_pct),
      umbral_descuadre_ventana_pct: num(f.umbral_descuadre_ventana_pct),
      ...cambios,
    });
  };

  const despachar = (tq: number, cantidad: number) =>
    ag.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tq,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipoId,
      serie_talonario: serie(),
      n_vale: 1,
      cantidad,
      lectura_contometro: cantidad,
      costo_unitario: 16,
      despachado_en: new Date().toISOString(),
    });

  const reporte = () =>
    ag
      .get("/api/erp/combustible/reportes/controles")
      .query({ desde: hace(30), hasta: new Date(Date.now() + 60_000).toISOString() });

  it("un aflojamiento aparece con quién, qué control y de cuánto a cuánto", async () => {
    const tq = await tanque();
    const r = await editar(tq, {
      umbral_descuadre_pct: 90,
      motivo_ajuste: "Varilla sin calibrar",
    });
    expect(r.status).toBe(200);

    const res = await reporte();
    expect(res.status).toBe(200);
    const evento = (res.body.eventos as EventoControl[]).find(
      (e) => e.combustible_id === tq && e.accion === "combustible.tanque_vigilancia_reducida"
    );
    expect(evento).toBeDefined();
    expect(evento!.motivo).toContain("Varilla");
    expect(evento!.aflojados.some((a) => a.a.includes("90"))).toBe(true);
    expect(evento!.quien).not.toBe("Sistema");
  });

  it("y al lado, lo que salió DESPUÉS: el número que lo vuelve un hallazgo", async () => {
    // Es toda la diferencia entre una anécdota ("alguien subió el umbral") y
    // una pregunta que hay que contestar ("y salieron 3.000 L").
    const tq = await tanque();
    await editar(tq, { umbral_descuadre_pct: 90, motivo_ajuste: "x" });
    expect((await despachar(tq, 3000)).status).toBe(201);

    const res = await reporte();
    const evento = (res.body.eventos as EventoControl[]).find(
      (e) => e.combustible_id === tq && e.accion === "combustible.tanque_vigilancia_reducida"
    );
    expect(evento!.despachado_despues_l).toBe(3000);
    expect(evento!.vales_despues).toBe(1);
  });

  it("un aflojamiento SIN movimiento después queda en cero, no se infla", async () => {
    const tq = await tanque();
    await editar(tq, { nivel_minimo: 100, motivo_ajuste: "x" });

    const res = await reporte();
    const evento = (res.body.eventos as EventoControl[]).find(
      (e) => e.combustible_id === tq && e.accion === "combustible.tanque_vigilancia_reducida"
    );
    expect(evento!.despachado_despues_l).toBe(0);
  });

  it("la FOTO de hoy: qué controles tiene apagado cada tanque", async () => {
    // Un control apagado ANTES del período no aparece como evento -- por eso
    // el reporte trae las dos cosas, la película y la foto.
    const ciego = await tanque({
      modo_vigilancia: "sin_vigilar",
      umbral_descuadre_pct: null,
      umbral_descuadre_ciclo_pct: null,
      umbral_descuadre_ventana_pct: null,
      umbral_diferencia_pct: null,
    });

    const res = await reporte();
    const fila = res.body.tanques.find((t: { id: number }) => t.id === ciego);
    expect(fila.vigilancia).toBe("ninguna");
    expect(fila.controles_apagados).toHaveLength(4);

    const vigilado = res.body.tanques.find(
      (t: { vigilancia: string }) => t.vigilancia === "completa"
    );
    expect(vigilado).toBeDefined();
  });

  it("el aflojamiento de configuración del tenant también entra", async () => {
    await ag.put("/api/erp/combustible/config").send({
      ventana_gracia_horas: 24,
      dias_sin_medir: 3,
      dias_ventana_descuadre: 30,
      dias_carga_retroactiva: 3,
      dias_sin_vigilancia: 7,
      llenados_por_dia_max: 2,
      tope_diario_sin_capacidad_l: 500,
    });
    await ag.put("/api/erp/combustible/config").send({
      ventana_gracia_horas: 8760,
      dias_sin_medir: 3,
      dias_ventana_descuadre: 30,
      dias_carga_retroactiva: 3,
      dias_sin_vigilancia: 7,
      llenados_por_dia_max: 2,
      tope_diario_sin_capacidad_l: 500,
    });

    const res = await reporte();
    const evento = (res.body.eventos as EventoControl[]).find(
      (e) => e.accion === "combustible.config_vigilancia_reducida"
    );
    expect(evento).toBeDefined();
    // No cuelga de un tanque: suma el movimiento de TODOS.
    expect(evento!.combustible_id).toBeNull();
  });

  it("el resumen suma los litros que se movieron con la vigilancia reducida", async () => {
    const res = await reporte();
    expect(res.body.resumen.eventos).toBeGreaterThan(0);
    expect(res.body.resumen.litros_bajo_vigilancia_reducida).toBeGreaterThan(0);
  });

  it("exige el período, igual que el kardex", async () => {
    expect((await ag.get("/api/erp/combustible/reportes/controles")).status).toBe(400);
  });

  it("un período sin aflojamientos devuelve la lista vacía, no un error", async () => {
    const res = await ag
      .get("/api/erp/combustible/reportes/controles")
      .query({ desde: hace(400), hasta: hace(300) });
    expect(res.status).toBe(200);
    expect(res.body.eventos).toEqual([]);
    // Pero la foto de hoy sigue estando: los tanques existen igual.
    expect(res.body.tanques.length).toBeGreaterThan(0);
  });
});
