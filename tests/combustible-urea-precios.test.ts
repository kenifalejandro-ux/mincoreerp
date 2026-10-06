/** tests/combustible-urea-precios.test.ts
 *
 * Catálogo de precios de urea y la alerta de precio fuera de catálogo
 * (migración 0121). Decisiones de Kenif, 2026-10-05: precio por proveedor y
 * presentación, marca como referencia, alerta con tolerancia del 10 %.
 *
 * Lo que estos tests defienden:
 *
 *   1. Una compra en ruta que declara un precio fuera de la tolerancia deja
 *      una alerta, en las DOS direcciones, y la compra se registra igual.
 *   2. Se compara contra el precio de la FECHA de la compra: el catálogo se
 *      apila, un precio nuevo no reinterpreta una compra vieja.
 *   3. Un precio anulado no cuenta; sin precio de catálogo no se compara.
 *   4. La tolerancia es config: NULL apaga, subirla afloja y pide motivo.
 *   5. Admin y operador cargan precios; el encargado de urea los LEE (para
 *      autocompletar) pero no los carga.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";

/** El primitivo por donde pasan todos los correos del módulo -- ver
 *  combustible-urea-stock.test.ts para el porqué. */
const correos: { asunto: string; lineas: string[] }[] = [];
vi.mock("../src/server/shared/utils/alertaMailer", () => ({
  enviarCorreoAlerta: vi.fn(
    async (p: { destinatarios: unknown[]; asunto: string; lineas: string[] }) => {
      if (p.destinatarios.length > 0) correos.push({ asunto: p.asunto, lineas: p.lineas });
    }
  ),
}));

describe("combustible: precios de urea (migración 0121)", () => {
  let tenantId: string;
  let slug: string;
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);
  let equipoId: number;
  let primax: number;
  let otro: number;
  let soloDiesel: number;

  const hace = (dias: number) => new Date(Date.now() - dias * 86400000).toISOString();

  const precio = (overrides: Record<string, unknown> = {}, quien = agente) =>
    quien.post("/api/erp/combustible/urea/precios").send({
      grifo_id: primax,
      presentacion: "caja",
      marca: "Green 32",
      precio_por_bulto: 50,
      vigente_desde: hace(30),
      ...overrides,
    });

  const compra = (lineas: { presentacion: string; precio: number; cajas?: number }[], extra = {}) =>
    agente.post("/api/erp/combustible/despachos").send({
      cliente_uuid: crypto.randomUUID(),
      producto: "urea",
      origen: "compra_externa",
      grifo_id: primax,
      tipo_destino: "equipo",
      equipo_id: equipoId,
      comprobante_tipo: "boleta",
      comprobante_numero: `B001-${Math.floor(Math.random() * 1e8)}`,
      lineas: lineas.map((l) => ({
        presentacion: l.presentacion,
        cantidad_bultos: l.cajas ?? 1,
        costo_unitario: l.precio,
      })),
      despachado_en: new Date().toISOString(),
      ...extra,
    });

  const alertasDe = async (despachoId: number) =>
    withTenant(tenantId, (c) =>
      c.query<{ detalle: Record<string, unknown> }>(
        `SELECT detalle FROM combustible_alertas
          WHERE tenant_id = $1 AND tipo = 'urea_precio_fuera_de_catalogo' AND despacho_id = $2`,
        [tenantId, despachoId]
      )
    );

  const config = async (cambios: Record<string, unknown>) => {
    const c = (await agente.get("/api/erp/combustible/config")).body;
    return agente.put("/api/erp/combustible/config").send({
      ventana_gracia_horas: c.ventana_gracia_horas,
      dias_sin_medir: c.dias_sin_medir,
      dias_ventana_descuadre: c.dias_ventana_descuadre,
      dias_carga_retroactiva: c.dias_carga_retroactiva,
      dias_sin_vigilancia: c.dias_sin_vigilancia,
      llenados_por_dia_max: c.llenados_por_dia_max,
      tope_diario_sin_capacidad_l: c.tope_diario_sin_capacidad_l,
      grifero_registra_varilla: c.grifero_registra_varilla,
      recepcion_requiere_validacion: c.recepcion_requiere_validacion,
      horas_para_validar_recepcion: c.horas_para_validar_recepcion,
      dias_sin_varilla_de_control: c.dias_sin_varilla_de_control,
      tope_diario_urea_l: c.tope_diario_urea_l,
      ratio_urea_diesel_max_pct: c.ratio_urea_diesel_max_pct,
      dias_sin_conteo_urea: c.dias_sin_conteo_urea,
      stock_minimo_urea_l: c.stock_minimo_urea_l,
      stock_maximo_urea_l: c.stock_maximo_urea_l,
      tolerancia_precio_urea_pct: c.tolerancia_precio_urea_pct,
      despacho_pide_medidor: c.despacho_pide_medidor,
      ...cambios,
    });
  };

  const nuevoUsuario = async (rol: string) => {
    const email = `${rol}-${idUnico("u")}@test.local`;
    const alta = await agente.post("/api/erp/usuarios").send({ nombre: rol, email, password, rol });
    expect(alta.status).toBe(201);
    const a = request.agent(app);
    expect(
      (await a.post("/api/auth/login").send({ tenantSlug: slug, email, password })).status
    ).toBe(200);
    return a;
  };

  const grifo = async (nombre: string, urea: boolean) =>
    (
      await agente.post("/api/erp/combustible/grifos").send({
        nombre: idUnico(nombre),
        abastece_ruta: true,
        abastece_tanque: false,
        abastece_urea: urea,
      })
    ).body.id as number;

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    slug = c.tenant.slug;
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug: slug, email: c.usuario.email, password });
    equipoId = (
      await agente.post("/api/erp/equipos").send({ placa_codigo: idUnico("VQ"), tipo: "VOLQUETE" })
    ).body.id;
    primax = await grifo("PRIMAX", true);
    otro = await grifo("REPSOL", true);
    soloDiesel = await grifo("PETRO", false);
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  // ── El catálogo ───────────────────────────────────────────────────────

  it("una empresa nueva arranca con tolerancia 10 % sin haber tocado la config", async () => {
    const c = await agente.get("/api/erp/combustible/config");
    expect(c.body.tolerancia_precio_urea_pct).toBe(10);
  });

  it("carga un precio y lo lista con proveedor, presentación y marca", async () => {
    const r = await precio();
    expect(r.status).toBe(201);
    const lista = await agente.get("/api/erp/combustible/urea/precios");
    expect(lista.status).toBe(200);
    const fila = lista.body.find((p: { id: number }) => p.id === r.body.id);
    expect(fila.proveedor).toBeTruthy();
    expect(fila.presentacion_nombre).toBe("Caja");
    expect(fila.marca).toBe("Green 32");
    expect(Number(fila.precio_por_bulto)).toBe(50);
  });

  it("un proveedor que no vende urea o una presentación inexistente: 400", async () => {
    expect((await precio({ grifo_id: soloDiesel })).status).toBe(400);
    expect((await precio({ presentacion: "bidon" })).status).toBe(400);
  });

  it("cargar un precio queda en la bitácora", async () => {
    const log = await withTenant(tenantId, (c) =>
      c.query(
        `SELECT 1 FROM platform_audit_log WHERE tenant_id = $1 AND accion = 'combustible.urea_precio_crear'`,
        [tenantId]
      )
    );
    expect(log.rowCount).toBeGreaterThan(0);
  });

  // ── 1. La alerta ──────────────────────────────────────────────────────

  it("dentro de la tolerancia no alerta", async () => {
    const r = await compra([{ presentacion: "caja", precio: 54 }]); // +8 %
    expect(r.status).toBe(201);
    expect((await alertasDe(r.body.id)).rowCount).toBe(0);
  });

  it("por arriba de la tolerancia alerta, y la compra se registra igual", async () => {
    const r = await compra([{ presentacion: "caja", precio: 80 }]); // +60 %
    expect(r.status).toBe(201);
    const a = await alertasDe(r.body.id);
    expect(a.rowCount).toBe(1);
    const desvios = a.rows[0].detalle.desvios as { desvioPct: number; precioCatalogo: number }[];
    expect(desvios).toHaveLength(1);
    expect(desvios[0].desvioPct).toBe(60);
    expect(desvios[0].precioCatalogo).toBe(50);
    expect(a.rows[0].detalle.toleranciaPct).toBe(10);
  });

  it("por abajo también alerta: catálogo viejo o boleta que no es lo que dice", async () => {
    const r = await compra([{ presentacion: "caja", precio: 30 }]); // -40 %
    expect(r.status).toBe(201);
    const a = await alertasDe(r.body.id);
    expect((a.rows[0].detalle.desvios as { desvioPct: number }[])[0].desvioPct).toBe(-40);
  });

  it("en una compra mixta se nombra solo el renglón que se aparta", async () => {
    expect((await precio({ presentacion: "bolsa", precio_por_bulto: 14 })).status).toBe(201);
    const r = await compra([
      { presentacion: "caja", precio: 50 },
      { presentacion: "bolsa", precio: 25 }, // +78,6 %
    ]);
    const desvios = (await alertasDe(r.body.id)).rows[0].detalle.desvios as {
      presentacion: string;
    }[];
    expect(desvios.map((d) => d.presentacion)).toEqual(["bolsa"]);
  });

  it("sin precio de catálogo para esa presentación, no se compara", async () => {
    const r = await compra([{ presentacion: "balde", precio: 999 }]);
    expect(r.status).toBe(201);
    expect((await alertasDe(r.body.id)).rowCount).toBe(0);
  });

  it("el precio de un proveedor no se usa para comparar otro", async () => {
    const r = await compra([{ presentacion: "caja", precio: 80 }], { grifo_id: otro });
    expect(r.status).toBe(201);
    expect((await alertasDe(r.body.id)).rowCount).toBe(0);
  });

  // ── 2. Se compara contra el precio de SU fecha ────────────────────────

  it("un precio nuevo no reinterpreta una compra anterior a su vigencia", async () => {
    // PRIMAX sube la caja a S/ 80 desde hace 2 días.
    expect((await precio({ precio_por_bulto: 80, vigente_desde: hace(2) })).status).toBe(201);

    // Una compra de HOY a 80: cuadra con el precio nuevo.
    const hoy = await compra([{ presentacion: "caja", precio: 80 }]);
    expect((await alertasDe(hoy.body.id)).rowCount).toBe(0);

    // Una compra de hace 10 días a 80 (offline que llegó tarde): se compara
    // contra el precio de ESE día, 50, y alerta.
    const vieja = await compra([{ presentacion: "caja", precio: 80 }], { despachado_en: hace(10) });
    expect(vieja.status).toBe(201);
    expect((await alertasDe(vieja.body.id)).rowCount).toBe(1);
  });

  // ── 3. Anular ─────────────────────────────────────────────────────────

  it("un precio anulado deja de contar y cae al anterior", async () => {
    const lista = (await agente.get("/api/erp/combustible/urea/precios")).body as {
      id: number;
      precio_por_bulto: string;
      presentacion: string;
      grifo_id: number;
    }[];
    const de80 = lista.find(
      (p) => p.grifo_id === primax && p.presentacion === "caja" && Number(p.precio_por_bulto) === 80
    )!;
    const anular = await agente
      .patch(`/api/erp/combustible/urea/precios/${de80.id}/anular`)
      .send({ motivo: "el aumento no se confirmó" });
    expect(anular.status).toBe(200);

    // Vuelve a regir el de 50: una compra de hoy a 80 alerta.
    const r = await compra([{ presentacion: "caja", precio: 80 }]);
    expect((await alertasDe(r.body.id)).rowCount).toBe(1);

    // Anular dos veces: 409. Uno que no existe: 404.
    expect(
      (
        await agente
          .patch(`/api/erp/combustible/urea/precios/${de80.id}/anular`)
          .send({ motivo: "otra vez" })
      ).status
    ).toBe(409);
    expect(
      (
        await agente
          .patch("/api/erp/combustible/urea/precios/99999999/anular")
          .send({ motivo: "no existe" })
      ).status
    ).toBe(404);
  });

  // ── 4. La tolerancia es config ────────────────────────────────────────

  it("subir la tolerancia o apagarla afloja y pide motivo", async () => {
    const subir = await config({ tolerancia_precio_urea_pct: 50 });
    expect(subir.status).toBe(400);
    expect(JSON.stringify(subir.body.aflojados)).toContain("Tolerancia de precio de urea");

    expect((await config({ tolerancia_precio_urea_pct: null })).status).toBe(400);

    const conMotivo = await config({
      tolerancia_precio_urea_pct: null,
      motivo_ajuste: "precios muy volátiles este mes",
    });
    expect(conMotivo.status).toBe(200);
    expect(conMotivo.body.tolerancia_precio_urea_pct).toBeNull();

    // Apagada: ni +60 % alerta.
    const r = await compra([{ presentacion: "caja", precio: 80 }]);
    expect((await alertasDe(r.body.id)).rowCount).toBe(0);
  });

  it("bajar la tolerancia endurece: se guarda sin motivo", async () => {
    expect((await config({ tolerancia_precio_urea_pct: 5 })).status).toBe(200);
  });

  it("es un hallazgo: está en el CHECK de anomalías", async () => {
    const r = await withTenant(tenantId, (c) =>
      c.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conname = 'combustible_anomalias_tipo_check'`
      )
    );
    expect(r.rows[0].def).toContain("urea_precio_fuera_de_catalogo");
  });

  // ── El correo ─────────────────────────────────────────────────────────

  it("con un destinatario marcado, la alerta de precio sale por correo", async () => {
    // Un tenant nuevo no tiene destinatarios (0107), y el admin no puede
    // editar sus propios permisos: se marca a un jefe de planta.
    const email = `jefe-precio-${idUnico("u")}@test.local`;
    const jefe = await agente
      .post("/api/erp/usuarios")
      .send({ nombre: "Jefe", email, password, rol: "operador" });
    const p = await agente.get(`/api/erp/usuarios/${jefe.body.id}/permisos`);
    const marcar = await agente.put(`/api/erp/usuarios/${jefe.body.id}/permisos`).send({
      modulos: p.body.modulos.map((m: { modulo: string; asignado: boolean; nivel: string }) => ({
        modulo: m.modulo,
        asignado: m.asignado,
        nivel: m.nivel,
      })),
      alertasCorreo: p.body.alertasCorreo.map((a: { modulo: string }) => ({
        modulo: a.modulo,
        recibeAlertas: a.modulo === "combustible",
      })),
      motivo: "prueba automatizada",
    });
    expect(marcar.status).toBe(200);

    correos.length = 0;
    // Tolerancia en 5 % (test anterior); catálogo de la caja en 50.
    const r = await compra([{ presentacion: "caja", precio: 70 }]);
    expect(r.status).toBe(201);
    const correo = correos.find((c) => c.asunto.includes("distinto del catálogo"));
    expect(correo).toBeTruthy();
    expect(correo!.lineas.join(" ")).toContain("S/ 70");
    expect(correo!.lineas.join(" ")).toContain("S/ 50");
  });

  // ── 5. Permisos ───────────────────────────────────────────────────────

  it("el operador carga precios", async () => {
    const op = await nuevoUsuario("operador");
    expect((await precio({ grifo_id: otro, precio_por_bulto: 52 }, op)).status).toBe(201);
  });

  it("el encargado de urea los lee para autocompletar, pero no los carga", async () => {
    const enc = await nuevoUsuario("encargado_urea");
    expect((await enc.get("/api/erp/combustible/urea/precios")).status).toBe(200);
    expect((await precio({ precio_por_bulto: 10 }, enc)).status).toBe(403);
  });
});
