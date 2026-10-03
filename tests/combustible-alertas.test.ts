/** tests/combustible-alertas.test.ts
 *
 * Migración 0068: gerencia (rol admin) se entera al momento de un hueco de
 * talonario o de un vale anulado, sin esperar a que alguien note el hueco
 * ni al cierre de período (Fase D entrega 2, que sigue aparte).
 *
 * Detección 100% event-driven, sin cron: un hueco solo se puede probar
 * cuando aparece un vale más allá de él, así que el momento exacto es el
 * propio POST /despachos -- ver detectarHuecosRevelados en
 * combustible.repository.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { crearUsuarioService } from "../src/server/services/auth.service";
import { closeDatabase, withTenant } from "../src/server/config/database";

function serieUnica(): string {
  return `S${Math.floor(Math.random() * 1e8).toString(36)}`;
}

describe("combustible: alertas (Fase D, migración 0068)", () => {
  let tenantId: string;
  let tenantSlug: string;
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);

  let tanqueId: number;
  let equipoId: number;

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    tenantSlug = creado.tenant.slug;
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });

    const tanque = await agente.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque alertas",
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_punto: "fijo",
      capacidad_total: 20000,
      nivel_actual: 10000,
    });
    tanqueId = tanque.body.id;

    const equipo = await agente
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("EX"), tipo: "EXCAVADORA" });
    equipoId = equipo.body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  function payloadVale(serie: string, nVale: number, overrides: Record<string, unknown> = {}) {
    return {
      origen: "tanque_propio",
      combustible_id: tanqueId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipoId,
      serie_talonario: serie,
      n_vale: nVale,
      cantidad: 35,
      lectura_contometro: 35,
      costo_unitario: 16.8,
      despachado_en: new Date().toISOString(),
      ...overrides,
    };
  }

  it("un vale que salta un número genera una alerta hueco_detectado al momento", async () => {
    const serie = serieUnica();
    await agente.post("/api/erp/combustible/despachos").send(payloadVale(serie, 21));
    // Salta el 22 -- se revela apenas entra este insert, sin esperar nada.
    await agente.post("/api/erp/combustible/despachos").send(payloadVale(serie, 23));

    const alertas = await agente
      .get("/api/erp/combustible/alertas")
      .query({ solo_no_leidas: "true", pageSize: 100 });
    const alerta = alertas.body.data.find(
      (a: { tipo: string; serie_talonario: string; n_vale: number }) =>
        a.tipo === "hueco_detectado" && a.serie_talonario === serie && a.n_vale === 22
    );
    expect(alerta).toBeDefined();
    expect(alerta.resuelta_en).toBeNull();
  });

  it("un vale que salta dos números genera una alerta por cada uno", async () => {
    const serie = serieUnica();
    await agente.post("/api/erp/combustible/despachos").send(payloadVale(serie, 10));
    await agente.post("/api/erp/combustible/despachos").send(payloadVale(serie, 13));

    const alertas = await agente
      .get("/api/erp/combustible/alertas")
      .query({ solo_no_leidas: "true", pageSize: 100 });
    const propias = alertas.body.data.filter(
      (a: { tipo: string; serie_talonario: string }) =>
        a.tipo === "hueco_detectado" && a.serie_talonario === serie
    );
    expect(propias.map((a: { n_vale: number }) => a.n_vale).sort()).toEqual([11, 12]);
  });

  it("el vale tardío que llena el hueco lo resuelve solo, sin admin de por medio", async () => {
    const serie = serieUnica();
    await agente.post("/api/erp/combustible/despachos").send(payloadVale(serie, 30));
    await agente.post("/api/erp/combustible/despachos").send(payloadVale(serie, 32));

    // El vale 31 "estaba en la tablet sin señal" y recién ahora sincroniza.
    await agente.post("/api/erp/combustible/despachos").send(payloadVale(serie, 31));

    const alertas = await agente.get("/api/erp/combustible/alertas").query({ pageSize: 100 });
    const alerta = alertas.body.data.find(
      (a: { tipo: string; serie_talonario: string; n_vale: number }) =>
        a.tipo === "hueco_detectado" && a.serie_talonario === serie && a.n_vale === 31
    );
    expect(alerta).toBeDefined();
    expect(alerta.resuelta_en).not.toBeNull();
    // Lo resolvió el sistema, no una persona.
    expect(alerta.resuelta_por).toBeNull();
  });

  it("un vale que llena un número que nunca fue hueco no genera ni resuelve nada", async () => {
    const serie = serieUnica();
    const creado = await agente.post("/api/erp/combustible/despachos").send(payloadVale(serie, 1));
    expect(creado.status).toBe(201);

    const alertas = await agente.get("/api/erp/combustible/alertas").query({ pageSize: 100 });
    const propias = alertas.body.data.filter(
      (a: { serie_talonario: string }) => a.serie_talonario === serie
    );
    expect(propias).toHaveLength(0);
  });

  it("anular un vale genera una alerta vale_anulado con el motivo", async () => {
    const serie = serieUnica();
    const creado = await agente.post("/api/erp/combustible/despachos").send(payloadVale(serie, 1));

    await agente
      .patch(`/api/erp/combustible/despachos/${creado.body.id}/anular`)
      .send({ motivo: "se mojó con diésel" });

    const alertas = await agente.get("/api/erp/combustible/alertas").query({ pageSize: 100 });
    const alerta = alertas.body.data.find(
      (a: { tipo: string; serie_talonario: string }) =>
        a.tipo === "vale_anulado" && a.serie_talonario === serie
    );
    expect(alerta).toBeDefined();
    expect(alerta.n_vale).toBe(1);
    expect(alerta.detalle.motivo).toBe("se mojó con diésel");
    expect(alerta.resuelta_en).toBeNull();
  });

  it("marcar todas las alertas como leídas las saca del filtro de no leídas", async () => {
    const serie = serieUnica();
    await agente.post("/api/erp/combustible/despachos").send(payloadVale(serie, 1));
    await agente.post("/api/erp/combustible/despachos").send(payloadVale(serie, 3));

    const antes = await agente
      .get("/api/erp/combustible/alertas")
      .query({ solo_no_leidas: "true", pageSize: 200 });
    expect(
      antes.body.data.some((a: { serie_talonario: string }) => a.serie_talonario === serie)
    ).toBe(true);

    const marcado = await agente.patch("/api/erp/combustible/alertas/leidas").send({});
    expect(marcado.status).toBe(204);

    const despues = await agente
      .get("/api/erp/combustible/alertas")
      .query({ solo_no_leidas: "true", pageSize: 200 });
    expect(
      despues.body.data.some((a: { serie_talonario: string }) => a.serie_talonario === serie)
    ).toBe(false);
  });

  it("marcar leídas POR ID no toca las que no estaban en la lista", async () => {
    // El contrato del que depende la campanita desde el arreglo de
    // visibilidad. El body vacío marca TODAS las del tenant, y eso hizo
    // desaparecer una alerta de descuadre nueve segundos después de nacer,
    // sin que nadie la viera: quien apretó "marcar todas leídas" estaba
    // limpiando huecos viejos que sí tenía en pantalla.
    const serieVieja = serieUnica();
    await agente.post("/api/erp/combustible/despachos").send(payloadVale(serieVieja, 1));
    await agente.post("/api/erp/combustible/despachos").send(payloadVale(serieVieja, 3));

    const enPantalla = await agente
      .get("/api/erp/combustible/alertas")
      .query({ solo_no_leidas: "true", pageSize: 200 });
    const idsVisibles = enPantalla.body.data
      .filter((a: { serie_talonario: string }) => a.serie_talonario === serieVieja)
      .map((a: { id: number }) => a.id);
    expect(idsVisibles.length).toBeGreaterThan(0);

    // Llega una alerta NUEVA justo después de que la pantalla se dibujó.
    const serieNueva = serieUnica();
    await agente.post("/api/erp/combustible/despachos").send(payloadVale(serieNueva, 1));
    await agente.post("/api/erp/combustible/despachos").send(payloadVale(serieNueva, 3));

    const marcado = await agente
      .patch("/api/erp/combustible/alertas/leidas")
      .send({ ids: idsVisibles });
    expect(marcado.status).toBe(204);

    const despues = await agente
      .get("/api/erp/combustible/alertas")
      .query({ solo_no_leidas: "true", pageSize: 200 });
    // Las que se vieron: leídas. La que llegó después: intacta.
    expect(
      despues.body.data.some((a: { serie_talonario: string }) => a.serie_talonario === serieVieja)
    ).toBe(false);
    expect(
      despues.body.data.some((a: { serie_talonario: string }) => a.serie_talonario === serieNueva)
    ).toBe(true);
  });

  it("resolver manualmente solo aplica a vale_anulado, no a hueco_detectado", async () => {
    const serie = serieUnica();
    const creado = await agente.post("/api/erp/combustible/despachos").send(payloadVale(serie, 1));
    await agente.post("/api/erp/combustible/despachos").send(payloadVale(serie, 5));
    await agente
      .patch(`/api/erp/combustible/despachos/${creado.body.id}/anular`)
      .send({ motivo: "motivo válido" });

    const alertas = await agente.get("/api/erp/combustible/alertas").query({ pageSize: 200 });
    const alertaAnulacion = alertas.body.data.find(
      (a: { tipo: string; serie_talonario: string }) =>
        a.tipo === "vale_anulado" && a.serie_talonario === serie
    );
    const alertaHueco = alertas.body.data.find(
      (a: { tipo: string; serie_talonario: string }) =>
        a.tipo === "hueco_detectado" && a.serie_talonario === serie
    );

    const resueltaAnulacion = await agente
      .patch(`/api/erp/combustible/alertas/${alertaAnulacion.id}/resolver`)
      .send({ motivo: "Revisado y dado por bueno" });
    expect(resueltaAnulacion.status).toBe(200);
    expect(resueltaAnulacion.body.resuelta_en).not.toBeNull();
    expect(resueltaAnulacion.body.resuelta_por).not.toBeNull();

    // Un hueco se resuelve solo -- el endpoint de revisión manual no le
    // aplica, ni siquiera aunque siga sin explicarse.
    const intentoHueco = await agente
      .patch(`/api/erp/combustible/alertas/${alertaHueco.id}/resolver`)
      .send({ motivo: "Revisado y dado por bueno" });
    expect(intentoHueco.status).toBe(404);
  });

  it("resolver dos veces la misma alerta da 404 la segunda vez", async () => {
    const serie = serieUnica();
    const creado = await agente.post("/api/erp/combustible/despachos").send(payloadVale(serie, 1));
    await agente
      .patch(`/api/erp/combustible/despachos/${creado.body.id}/anular`)
      .send({ motivo: "motivo válido" });

    const alertas = await agente.get("/api/erp/combustible/alertas").query({ pageSize: 200 });
    const alerta = alertas.body.data.find(
      (a: { tipo: string; serie_talonario: string }) =>
        a.tipo === "vale_anulado" && a.serie_talonario === serie
    );

    const primera = await agente
      .patch(`/api/erp/combustible/alertas/${alerta.id}/resolver`)
      .send({ motivo: "Revisado y dado por bueno" });
    expect(primera.status).toBe(200);

    const segunda = await agente
      .patch(`/api/erp/combustible/alertas/${alerta.id}/resolver`)
      .send({ motivo: "Revisado y dado por bueno" });
    expect(segunda.status).toBe(404);
  });

  // Matriz robusta de perfiles (profile_user.xlsx, confirmado por Kenif
  // 2026-10-01): Operador parte con acceso amplio -- Alertas es Visible
  // para Operador, no exclusivo de gerencia.
  it("el operador sí puede ver alertas (matriz robusta de perfiles)", async () => {
    const emailOperador = idUnico("operador-alertas") + "@test.local";
    await withTenant(tenantId, (client) =>
      crearUsuarioService(
        { tenantId, nombre: "Operador", email: emailOperador, password, rol: "operador" },
        client
      )
    );
    const agenteOperador = request.agent(app);
    await agenteOperador
      .post("/api/auth/login")
      .send({ tenantSlug, email: emailOperador, password });

    const listado = await agenteOperador.get("/api/erp/combustible/alertas");
    expect(listado.status).toBe(200);
  });

  it("un tenant no ve las alertas de otro (RLS)", async () => {
    const serie = serieUnica();
    await agente.post("/api/erp/combustible/despachos").send(payloadVale(serie, 1));
    await agente.post("/api/erp/combustible/despachos").send(payloadVale(serie, 3));

    const otro = await crearTenantDePrueba(password);
    const agenteOtro = request.agent(app);
    await agenteOtro
      .post("/api/auth/login")
      .send({ tenantSlug: otro.tenant.slug, email: otro.usuario.email, password });

    try {
      const listado = await agenteOtro.get("/api/erp/combustible/alertas").query({ pageSize: 200 });
      expect(
        listado.body.data.some((a: { serie_talonario: string }) => a.serie_talonario === serie)
      ).toBe(false);
    } finally {
      await borrarTenantDePrueba(otro.tenant.id);
    }
  });
});
