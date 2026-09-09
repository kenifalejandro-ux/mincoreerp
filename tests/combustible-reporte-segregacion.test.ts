/** tests/combustible-reporte-segregacion.test.ts
 *
 * El último de los cuatro reportes que salieron de la charla sobre el rol del
 * auditor: ¿quién hace y quién controla?
 *
 * NO ACUSA, CUENTA. En una operación chica la respuesta a "¿la misma persona
 * despacha y revisa?" suele ser que sí, y eso no es un delito: es un riesgo
 * que hay que conocer para compensarlo. Un reporte que gritara "fraude" cada
 * vez que hay un solo operador se ignoraría en una semana.
 *
 * La distinción que importa está en las columnas de "propias": anular el vale
 * de OTRO deja dos personas en la historia; anular el PROPIO deja una sola, y
 * nadie más se entera.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";

let seq = 0;
const serie = () => `S${Date.now().toString(36).slice(-4)}${(seq++).toString(36)}`;

interface FilaPersona {
  persona: string;
  vales_cargados: number;
  lecturas_cargadas: number;
  anulaciones: number;
  anulaciones_propias: number;
  alertas_revisadas: number;
  autorevisiones: number;
}

describe("combustible: reporte de segregación de funciones", () => {
  let tenantId: string;
  let equipoId: number;
  let tanqueId: number;
  let miId: string;
  const password = "ClaveDePrueba123";
  const ag = request.agent(app);
  /** Un segundo usuario del MISMO tenant, para poder distinguir "anuló lo
   *  propio" de "anuló lo de otro" -- que es toda la gracia del reporte. */
  const ag2 = request.agent(app);
  const hace = (d: number) => new Date(Date.now() - d * 864e5).toISOString();

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    await ag
      .post("/api/auth/login")
      .send({ tenantSlug: c.tenant.slug, email: c.usuario.email, password });

    miId =
      (await ag.get("/api/auth/me")).body.id ?? (await ag.get("/api/auth/me")).body.usuario?.id;

    const e = await ag
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("VQ"), tipo: "Volquete" });
    equipoId = e.body.id;

    const t = await ag.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "T",
      tipo_combustible: "diesel_b5",
      unidad: "L",
      tipo_punto: "fijo",
      capacidad_total: 50000,
      nivel_actual: 40000,
      nivel_minimo: 2000,
      modo_vigilancia: "sin_vigilar",
    });
    tanqueId = t.body.id;

    // Segundo admin del tenant.
    const otro = await ag.post("/api/erp/usuarios").send({
      nombre: "Segundo Operador",
      email: `op${Date.now()}@test.local`,
      password,
      rol: "admin",
    });
    if (otro.status === 201) {
      await ag2.post("/api/auth/login").send({
        tenantSlug: c.tenant.slug,
        email: otro.body.email,
        password,
      });
      // Le habilitamos combustible si hace falta (el módulo se habilita por
      // usuario, ver platform_module_control).
      await withTenant(tenantId, (cl) =>
        cl.query(
          `INSERT INTO usuario_modulos (usuario_id, modulo) VALUES ($1, 'combustible')
           ON CONFLICT DO NOTHING`,
          [otro.body.id]
        )
      );
    }
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  const despachar = (agente: typeof ag, cantidad = 100) =>
    agente.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tanqueId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipoId,
      serie_talonario: serie(),
      n_vale: 1,
      cantidad,
      lectura_contometro: cantidad,
      costo_unitario: 16,
      despachado_en: hace(5),
    });

  const reporte = () =>
    ag
      .get("/api/erp/combustible/reportes/segregacion")
      .query({ desde: hace(30), hasta: new Date(Date.now() + 60_000).toISOString() });

  /** Mi propia fila del reporte, buscada por id y no por nombre: el nombre
   *  del usuario de prueba no es estable. */
  const mio = async () => {
    const r = await reporte();
    return (r.body.personas as (FilaPersona & { usuario_id: string })[]).find(
      (p) => p.usuario_id === miId
    );
  };

  it("cuenta lo que cada persona cargó", async () => {
    await despachar(ag);
    await despachar(ag);
    await ag
      .post("/api/erp/combustible/lecturas")
      .send({ combustible_id: tanqueId, nivel: 39000, leido_en: hace(4) });

    const res = await reporte();
    expect(res.status).toBe(200);
    const fila = (res.body.personas as FilaPersona[])[0];
    expect(fila.vales_cargados).toBeGreaterThanOrEqual(2);
    expect(fila.lecturas_cargadas).toBeGreaterThanOrEqual(1);
  });

  it("ANULAR LO PROPIO se cuenta aparte de anular en general", async () => {
    // Es la distinción que hace útil al reporte: anular el vale de otro deja
    // dos personas en la historia; anular el propio deja una sola.
    const antes = await mio();
    const d = await despachar(ag, 500);
    expect(d.status).toBe(201);
    const anul = await ag
      .patch(`/api/erp/combustible/despachos/${d.body.id}/anular`)
      .send({ motivo: "me equivoqué al tipear" });
    expect(anul.status).toBe(200);

    const ahora = await mio();
    expect(ahora!.anulaciones).toBe((antes?.anulaciones ?? 0) + 1);
    expect(ahora!.anulaciones_propias).toBe((antes?.anulaciones_propias ?? 0) + 1);
  });

  it("una lectura anulada por su propio autor también suma a propias", async () => {
    const antes = await mio();
    const l = await ag
      .post("/api/erp/combustible/lecturas")
      .send({ combustible_id: tanqueId, nivel: 38500, leido_en: hace(3) });
    await ag
      .patch(`/api/erp/combustible/lecturas/${l.body.lectura.id}/anular`)
      .send({ motivo: "se midió el tanque equivocado" });

    const ahora = await mio();
    expect(ahora!.anulaciones_propias).toBe((antes?.anulaciones_propias ?? 0) + 1);
  });

  it("la autorrevisión de alertas llega al reporte", async () => {
    // Cierra el círculo con el PR anterior: el cierre marca `autorevision`,
    // y acá se cuenta por persona.
    const d = await despachar(ag, 20000); // dispara alertas sobre el vale
    const lista = await ag.get("/api/erp/combustible/alertas").query({ pageSize: 300 });
    const propia = lista.body.data.find(
      (a: { despacho_id: number | null; resuelta_en: string | null }) =>
        a.despacho_id === d.body.id && a.resuelta_en === null
    );

    if (propia) {
      const antes = await mio();
      const res = await ag
        .patch(`/api/erp/combustible/alertas/${propia.id}/resolver`)
        .send({ motivo: "ok revisado" });
      expect(res.status).toBe(200);

      const ahora = await mio();
      expect(ahora!.alertas_revisadas).toBe((antes?.alertas_revisadas ?? 0) + 1);
      expect(ahora!.autorevisiones).toBe((antes?.autorevisiones ?? 0) + 1);
    }
  });

  it("el resumen mide la CONCENTRACIÓN, que es el dato que ordena todo", async () => {
    // Si una sola persona hizo el 100%, no hay segregación posible. Ese
    // número va antes que cualquier sospecha puntual.
    const res = await reporte();
    expect(res.body.resumen.personas).toBeGreaterThanOrEqual(1);
    expect(res.body.resumen.concentracion_pct).toBeGreaterThan(0);
    expect(res.body.resumen.concentracion_pct).toBeLessThanOrEqual(100);
  });

  it("un período vacío devuelve la lista vacía y concentración null, no 0%", async () => {
    // 0% diría "está bien repartido"; null dice "no hubo movimiento". No es
    // lo mismo y el reporte no puede confundirlos.
    const res = await ag
      .get("/api/erp/combustible/reportes/segregacion")
      .query({ desde: hace(400), hasta: hace(300) });
    expect(res.status).toBe(200);
    expect(res.body.personas).toEqual([]);
    expect(res.body.resumen.concentracion_pct).toBeNull();
  });

  it("exige el período", async () => {
    expect((await ag.get("/api/erp/combustible/reportes/segregacion")).status).toBe(400);
  });
});
