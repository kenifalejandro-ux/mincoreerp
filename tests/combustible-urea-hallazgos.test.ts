/** tests/combustible-urea-hallazgos.test.ts
 *
 * Entrega 4 del panel de urea: el conteo recargado (0118, vector 4 del ADR:
 * "anular conteos hasta que uno cuadre"), la franja de hallazgos y los
 * conteos en el reporte de segregación.
 *
 * El centro es el primer test: contar, ver que no cuadra, anular "por error"
 * y volver a contar algo que cuadra. Antes de esta entrega eso no dejaba
 * NINGUNA alerta que uniera los dos conteos.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";

/** Mismo mock que combustible-urea-stock.test.ts: el primitivo por donde
 *  pasan todos los correos, para probar la cadena entera y no solo la fila. */
const correos: { asunto: string; lineas: string[] }[] = [];
vi.mock("../src/server/shared/utils/alertaMailer", () => ({
  enviarCorreoAlerta: vi.fn(
    async (p: { destinatarios: unknown[]; asunto: string; lineas: string[] }) => {
      if (p.destinatarios.length > 0) correos.push({ asunto: p.asunto, lineas: p.lineas });
    }
  ),
}));

describe("combustible: hallazgos de urea (entrega 4)", () => {
  let tenantId: string;
  let slug: string;
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);
  let equipoId: number;
  let grifoUrea: number;
  let nVale = 1;
  const serie = `H${Math.floor(Math.random() * 1e6).toString(36)}`;

  const entrada = (cajas: number) =>
    agente.post("/api/erp/combustible/recepciones").send({
      cliente_uuid: crypto.randomUUID(),
      producto: "urea",
      grifo_id: grifoUrea,
      presentacion: "caja",
      cantidad_bultos: cajas,
      costo_unitario: 40,
      recibido_en: new Date().toISOString(),
    });
  const vale = (cajas: number) =>
    agente.post("/api/erp/combustible/despachos").send({
      cliente_uuid: crypto.randomUUID(),
      producto: "urea",
      origen: "compra_externa",
      grifo_id: grifoUrea,
      tipo_destino: "equipo",
      equipo_id: equipoId,
      serie_talonario: serie,
      n_vale: nVale++,
      presentacion: "caja",
      cantidad_bultos: cajas,
      despachado_en: new Date().toISOString(),
    });
  const conteo = (cajas: number) =>
    agente.post("/api/erp/combustible/urea/conteos").send({
      cliente_uuid: crypto.randomUUID(),
      presentacion: "caja",
      cantidad_bultos: cajas,
      contado_en: new Date().toISOString(),
    });
  const anular = (id: number, motivo: string) =>
    agente.patch(`/api/erp/combustible/urea/conteos/${id}/anular`).send({ motivo });
  const alertas = (tipo: string) =>
    withTenant(tenantId, (c) =>
      c.query<{ id: string; detalle: Record<string, unknown>; urea_conteo_id: string }>(
        `SELECT id, detalle, urea_conteo_id FROM combustible_alertas
          WHERE tenant_id = $1 AND tipo = $2 ORDER BY id`,
        [tenantId, tipo]
      )
    );
  const nuevoUsuario = async (rol: string) => {
    const email = `${rol}-${idUnico("u")}@test.local`;
    const alta = await agente.post("/api/erp/usuarios").send({ nombre: rol, email, password, rol });
    expect(alta.status).toBe(201);
    const a = request.agent(app);
    expect(
      (await a.post("/api/auth/login").send({ tenantSlug: slug, email, password })).status
    ).toBe(200);
    return { agente: a, id: alta.body.id as string };
  };

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
    grifoUrea = (
      await agente.post("/api/erp/combustible/grifos").send({
        nombre: idUnico("UREAPROV"),
        abastece_ruta: false,
        abastece_tanque: false,
        abastece_urea: true,
      })
    ).body.id;

    // Un destinatario real, para que los correos se manden (un tenant nuevo
    // no tiene ninguno, ver 0107). No puede ser el admin de la sesión: la API
    // no deja editar los permisos propios.
    const jefe = await nuevoUsuario("operador");
    const p = await agente.get(`/api/erp/usuarios/${jefe.id}/permisos`);
    const marcar = await agente.put(`/api/erp/usuarios/${jefe.id}/permisos`).send({
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

    // Stock teórico: 10 cajas (160 L) - 3 cajas (48 L) = 112 L.
    expect((await entrada(10)).status).toBe(201);
    expect((await vale(3)).status).toBe(201);
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  // ── El conteo recargado ───────────────────────────────────────────────

  it("anular un conteo que no cuadra y cargar uno que sí deja la alerta que los une", async () => {
    // 5 cajas = 80 L contra 112 esperados: faltan 32.
    const primero = await conteo(5);
    expect(primero.status).toBe(201);
    expect((await alertas("urea_descuadre_conteo")).rowCount).toBe(1);

    expect((await anular(Number(primero.body.id), "conté mal una caja")).status).toBe(200);

    // 7 cajas = 112 L: cuadra exacto. Antes de 0118 este conteo no generaba
    // nada -- y además el bloque de alertas cortaba con un return cuando no
    // había descuadre, así que ni siquiera se habría llegado a mirar.
    correos.length = 0;
    const segundo = await conteo(7);
    expect(segundo.status).toBe(201);

    const r = await alertas("urea_conteo_recargado");
    expect(r.rowCount).toBe(1);
    const d = r.rows[0].detalle;
    expect(Number(r.rows[0].urea_conteo_id)).toBe(Number(segundo.body.id));
    expect(d.conteoAnuladoId).toBe(Number(primero.body.id));
    expect(d.descuadreAnuladoL).toBe(-32);
    expect(d.descuadreNuevoL).toBe(0);
    expect(d.descuadreQueSeAchicoL).toBe(32);
    expect(d.motivoAnulacion).toBe("conté mal una caja");
    expect(d.anulacionesEnLaVentana).toBe(1);

    // La alerta del primer conteo SIGUE abierta: anular no la borra.
    expect((await alertas("urea_descuadre_conteo")).rowCount).toBe(1);

    // Y el correo sale, con el motivo adentro.
    const correo = correos.find((c) => c.asunto.includes("se anuló un conteo"));
    expect(correo).toBeTruthy();
    expect(correo!.lineas.join(" ")).toContain("conté mal una caja");
  });

  it("un recuento que muestra MÁS faltante que el anulado no alerta: no esconde nada", async () => {
    const previo = (await alertas("urea_conteo_recargado")).rowCount;
    // El vigente (112 L) se anula y se cuenta menos: 6 cajas = 96 L, -16.
    const vigente = await withTenant(tenantId, (c) =>
      c.query<{ id: string }>(
        `SELECT id FROM combustible_conteos_urea
          WHERE tenant_id = $1 AND anulada_en IS NULL ORDER BY id DESC LIMIT 1`,
        [tenantId]
      )
    );
    expect((await anular(Number(vigente.rows[0].id), "faltaba contar el depósito 2")).status).toBe(
      200
    );
    expect((await conteo(6)).status).toBe(201);
    expect((await alertas("urea_conteo_recargado")).rowCount).toBe(previo);
  });

  it("un conteo sin ninguna anulación en la ventana no alerta como recargado", async () => {
    // Base limpia de anulaciones recientes: se corre la ventana hacia atrás.
    await withTenant(tenantId, (c) =>
      c.query(
        `UPDATE combustible_conteos_urea SET anulada_en = now() - interval '10 days'
          WHERE tenant_id = $1 AND anulada_en IS NOT NULL`,
        [tenantId]
      )
    );
    const previo = (await alertas("urea_conteo_recargado")).rowCount;
    expect((await conteo(7)).status).toBe(201);
    expect((await alertas("urea_conteo_recargado")).rowCount).toBe(previo);
  });

  it("el recargado no se puede congelar si no entrara en el CHECK de anomalías", async () => {
    // Es un hallazgo: tiene que estar en las DOS listas. Si faltara en la de
    // anomalías, el worker de congelado fallaría en silencio al llegar a él.
    const r = await withTenant(tenantId, (c) =>
      c.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conname = 'combustible_anomalias_tipo_check'`
      )
    );
    expect(r.rows[0].def).toContain("urea_conteo_recargado");
  });

  // ── La franja de hallazgos ────────────────────────────────────────────

  it("la franja trae los hallazgos de urea abiertos, solo de urea", async () => {
    const r = await agente.get("/api/erp/combustible/urea/hallazgos");
    expect(r.status).toBe(200);
    const tipos = r.body.hallazgos.map((h: { tipo: string }) => h.tipo);
    expect(tipos).toContain("urea_conteo_recargado");
    expect(tipos).toContain("urea_descuadre_conteo");
    expect(r.body.total).toBe(r.body.hallazgos.length);
  });

  it("un hallazgo resuelto deja de aparecer en la franja", async () => {
    const antes = await agente.get("/api/erp/combustible/urea/hallazgos");
    const uno = antes.body.hallazgos[0];
    await withTenant(tenantId, (c) =>
      c.query(`UPDATE combustible_alertas SET resuelta_en = now() WHERE id = $1`, [uno.id])
    );
    const despues = await agente.get("/api/erp/combustible/urea/hallazgos");
    expect(despues.body.total).toBe(antes.body.total - 1);
    expect(despues.body.hallazgos.some((h: { id: number }) => h.id === uno.id)).toBe(false);
  });

  it("el encargado de urea NO ve la franja: son las alertas sobre su propio trabajo", async () => {
    const encargado = await nuevoUsuario("encargado_urea");
    expect((await encargado.agente.get("/api/erp/combustible/urea/hallazgos")).status).toBe(403);
  });

  it("un operador sí la ve", async () => {
    const op = await nuevoUsuario("operador");
    expect((await op.agente.get("/api/erp/combustible/urea/hallazgos")).status).toBe(200);
  });

  // ── Segregación ───────────────────────────────────────────────────────

  it("el reporte de segregación cuenta los conteos y marca los que son sobre lo propio", async () => {
    // 30 días: un test anterior corrió las anulaciones 10 días atrás para
    // vaciar la ventana del recargado, y el reporte las ubica por la fecha en
    // que se ANULARON.
    const r = await agente.get("/api/erp/combustible/reportes/segregacion").query({
      desde: new Date(Date.now() - 30 * 86400000).toISOString(),
      hasta: new Date(Date.now() + 86400000).toISOString(),
    });
    expect(r.status).toBe(200);
    const admin = r.body.personas.find((p: { conteos_urea: number }) => p.conteos_urea > 0);
    expect(admin).toBeTruthy();
    // Cuatro conteos cargados por el admin, que también cargó la entrada y el
    // vale de urea: los cuatro son "sobre lo propio". Es el riesgo que el
    // cliente confirmó, y ahora el reporte lo muestra.
    expect(admin.conteos_urea).toBe(4);
    expect(admin.conteos_urea_sobre_lo_propio).toBe(4);
    // Las dos anulaciones de conteo cuentan como anulaciones PROPIAS: el que
    // contó y el que anuló son la misma persona.
    expect(admin.anulaciones_propias).toBeGreaterThanOrEqual(2);
    expect(r.body.resumen.conteos_urea_sobre_lo_propio).toBe(4);
  });
});
