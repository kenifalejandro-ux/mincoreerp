/** tests/combustible-urea-tiempo-real.test.ts
 *
 * Los eventos que alimentan el panel de Control de Urea en vivo (entrega 5).
 * El panel no pide nada por su cuenta: se entera por el stream de que algo
 * cambió y vuelve a pedir. Si un evento no sale, el panel queda mudo; si sale
 * de más, lo recarga sin motivo; si sale con datos de más, los ve quien no
 * debería. Estos tests atacan esas tres cosas contra la API real, leyendo el
 * buffer `eventos_tiempo_real` (el que el stream entrega y repone).
 *
 *   1. Cada acción de urea publica SU evento, con el producto.
 *   2. Lo que falla (400, 404, 409) no publica nada: no hay evento fantasma.
 *   3. El payload lleva solo ids y producto: ni litros, ni montos, ni nombres.
 *   4. Otro tenant no ve nada de esto (RLS del buffer).
 *   5. Un vale de diésel sale con producto "combustible": el panel de urea lo
 *      ignora en vez de recargarse con cada vale de tanque.
 */
import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";

interface EventoBuffer {
  id: string;
  tipo: string;
  payload: Record<string, unknown>;
}

describe("combustible: urea en tiempo real (entrega 5)", () => {
  let tenantId: string;
  let otroTenantId: string;
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);
  let equipoId: number;
  let grifoUrea: number;
  let tanqueId: number;
  let nVale = 1;
  const serie = `T${Math.floor(Math.random() * 1e6).toString(36)}`;

  /** Todo lo que se publicó en el tenant desde `marca`. */
  const eventosDesde = async (tenant: string, marca: string): Promise<EventoBuffer[]> =>
    (
      await withTenant(tenant, (c) =>
        c.query<EventoBuffer>(
          `SELECT id, tipo, payload FROM eventos_tiempo_real
            WHERE tenant_id = $1 AND id > $2 ORDER BY id ASC`,
          [tenant, marca]
        )
      )
    ).rows;

  const marca = async (tenant = tenantId): Promise<string> =>
    (
      await withTenant(tenant, (c) =>
        c.query<{ m: string }>(
          `SELECT COALESCE(MAX(id), 0)::text AS m FROM eventos_tiempo_real WHERE tenant_id = $1`,
          [tenant]
        )
      )
    ).rows[0].m;

  /** Los tipos publicados por `accion`, ya en orden. */
  const tiposTras = async (accion: () => Promise<unknown>) => {
    const antes = await marca();
    await accion();
    return eventosDesde(tenantId, antes);
  };

  const valeUrea = (extra: Record<string, unknown> = {}) =>
    agente.post("/api/erp/combustible/despachos").send({
      cliente_uuid: crypto.randomUUID(),
      producto: "urea",
      origen: "almacen",
      grifo_id: grifoUrea,
      tipo_destino: "equipo",
      equipo_id: equipoId,
      serie_talonario: serie,
      n_vale: nVale++,
      presentacion: "caja",
      cantidad_bultos: 1,
      despachado_en: new Date().toISOString(),
      ...extra,
    });

  const entradaUrea = () =>
    agente.post("/api/erp/combustible/recepciones").send({
      cliente_uuid: crypto.randomUUID(),
      producto: "urea",
      grifo_id: grifoUrea,
      presentacion: "caja",
      cantidad_bultos: 10,
      costo_unitario: 20,
      recibido_en: new Date().toISOString(),
    });

  const precio = (extra: Record<string, unknown> = {}) =>
    agente.post("/api/erp/combustible/urea/precios").send({
      grifo_id: grifoUrea,
      presentacion: "caja",
      marca: "Green 32",
      precio_por_bulto: 50,
      vigente_desde: new Date(Date.now() - 86400000).toISOString(),
      ...extra,
    });

  /** Cualquier dato de negocio que NO debe viajar por el stream. */
  const CLAVES_PROHIBIDAS = [
    "cantidad",
    "cantidad_bultos",
    "litros",
    "cantidad_litros",
    "costo_unitario",
    "precio_por_bulto",
    "precio",
    "total",
    "nombre",
    "proveedor",
    "motivo",
    "comprobante_numero",
  ];
  const sinDatosDeNegocio = (eventos: EventoBuffer[]) => {
    for (const e of eventos) {
      for (const clave of Object.keys(e.payload)) {
        expect(CLAVES_PROHIBIDAS, `el evento ${e.tipo} filtra "${clave}"`).not.toContain(clave);
      }
    }
  };

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });
    otroTenantId = (await crearTenantDePrueba(password)).tenant.id;

    equipoId = (
      await agente.post("/api/erp/equipos").send({ placa_codigo: idUnico("VT"), tipo: "VOLQUETE" })
    ).body.id;
    grifoUrea = (
      await agente.post("/api/erp/combustible/grifos").send({
        nombre: idUnico("UREATR"),
        abastece_ruta: true,
        abastece_tanque: false,
        abastece_urea: true,
      })
    ).body.id;
    tanqueId = (
      await agente.post("/api/erp/combustible").send({
        codigo: idUnico("TQ"),
        tanque_nombre: "Tanque tiempo real",
        tipo_combustible: "diesel_b5",
        unidad: "gal",
        tipo_punto: "fijo",
        capacidad_total: 20000,
        nivel_actual: 10000,
      })
    ).body.id;
    // Stock para poder despachar vales de almacén.
    expect((await entradaUrea()).status).toBe(201);
  });

  afterAll(async () => {
    await borrarTenantDePrueba(otroTenantId);
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  // ── 1. Cada acción publica su evento, con el producto ─────────────────

  it("un vale de almacén publica despacho_creado con producto urea", async () => {
    let id = 0;
    const eventos = await tiposTras(async () => {
      const r = await valeUrea();
      expect(r.status).toBe(201);
      id = r.body.id;
    });
    const e = eventos.find((x) => x.tipo === "combustible.despacho_creado");
    expect(e?.payload).toMatchObject({ despachoId: id, producto: "urea" });
    sinDatosDeNegocio(eventos);
  });

  it("una compra en ruta publica despacho_creado con producto urea", async () => {
    const eventos = await tiposTras(async () => {
      const r = await agente.post("/api/erp/combustible/despachos").send({
        cliente_uuid: crypto.randomUUID(),
        producto: "urea",
        origen: "compra_externa",
        grifo_id: grifoUrea,
        tipo_destino: "equipo",
        equipo_id: equipoId,
        comprobante_tipo: "boleta",
        comprobante_numero: `B001-${Math.floor(Math.random() * 1e8)}`,
        lineas: [{ presentacion: "caja", cantidad_bultos: 1, costo_unitario: 50 }],
        despachado_en: new Date().toISOString(),
      });
      expect(r.status).toBe(201);
    });
    const e = eventos.find((x) => x.tipo === "combustible.despacho_creado");
    expect(e?.payload.producto).toBe("urea");
    sinDatosDeNegocio(eventos);
  });

  it("adjuntar el comprobante de una compra publica comprobante_adjuntado con producto urea; el rechazo no publica", async () => {
    const FOTO = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]); // JPEG mínimo
    const OTRA = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 9]);
    const compra = await agente.post("/api/erp/combustible/despachos").send({
      cliente_uuid: crypto.randomUUID(),
      producto: "urea",
      origen: "compra_externa",
      grifo_id: grifoUrea,
      tipo_destino: "equipo",
      equipo_id: equipoId,
      comprobante_tipo: "boleta",
      comprobante_numero: `B001-${Math.floor(Math.random() * 1e8)}`,
      lineas: [{ presentacion: "caja", cantidad_bultos: 1, costo_unitario: 50 }],
      despachado_en: new Date().toISOString(),
    });
    expect(compra.status).toBe(201);
    const url = `/api/erp/combustible/urea/compras/${compra.body.id}/comprobante`;

    const adjuntado = await tiposTras(async () => {
      const r = await agente
        .post(url)
        .attach("archivo", FOTO, { filename: "boleta.jpg", contentType: "image/jpeg" });
      expect(r.status).toBe(201);
    });
    const e = adjuntado.find((x) => x.tipo === "combustible.comprobante_adjuntado");
    expect(e?.payload).toEqual({ despachoId: Number(compra.body.id), producto: "urea" });
    sinDatosDeNegocio(adjuntado);

    // Reemplazar sin motivo: 400, y no hay evento (la foto no cambió).
    const rechazado = await tiposTras(async () => {
      const r = await agente
        .post(url)
        .attach("archivo", OTRA, { filename: "otra.jpg", contentType: "image/jpeg" });
      expect(r.status).toBe(400);
    });
    expect(rechazado).toEqual([]);
  });

  it("anular un vale publica despacho_anulado con producto urea", async () => {
    const vale = await valeUrea();
    expect(vale.status).toBe(201);
    const eventos = await tiposTras(async () => {
      const r = await agente
        .patch(`/api/erp/combustible/despachos/${vale.body.id}/anular`)
        .send({ motivo: "vale mal tipeado" });
      expect(r.status).toBe(200);
    });
    const e = eventos.find((x) => x.tipo === "combustible.despacho_anulado");
    // El id viaja como número en las anulaciones (sale de la ruta).
    expect(e?.payload).toMatchObject({ despachoId: Number(vale.body.id), producto: "urea" });
    // El motivo queda en la bitácora, nunca en el stream.
    sinDatosDeNegocio(eventos);
  });

  it("una entrada publica recepcion_creada y anularla recepcion_anulada, ambas con producto urea", async () => {
    let recepcionId = 0;
    const creada = await tiposTras(async () => {
      const r = await entradaUrea();
      expect(r.status).toBe(201);
      recepcionId = r.body.id;
    });
    expect(creada.find((x) => x.tipo === "combustible.recepcion_creada")?.payload).toMatchObject({
      recepcionId,
      producto: "urea",
    });

    const anulada = await tiposTras(async () => {
      const r = await agente
        .patch(`/api/erp/combustible/recepciones/${recepcionId}/anular`)
        .send({ motivo: "entrada duplicada" });
      expect(r.status).toBe(200);
    });
    expect(anulada.find((x) => x.tipo === "combustible.recepcion_anulada")?.payload).toMatchObject({
      recepcionId: Number(recepcionId),
      producto: "urea",
    });
    sinDatosDeNegocio([...creada, ...anulada]);
  });

  it("un conteo físico publica urea_conteo_creado y anularlo urea_conteo_anulado", async () => {
    let conteoId = 0;
    const creado = await tiposTras(async () => {
      const r = await agente.post("/api/erp/combustible/urea/conteos").send({
        cliente_uuid: crypto.randomUUID(),
        presentacion: "caja",
        cantidad_bultos: 5,
        contado_en: new Date().toISOString(),
      });
      expect(r.status).toBe(201);
      conteoId = r.body.id;
    });
    expect(creado.map((e) => e.tipo)).toContain("combustible.urea_conteo_creado");

    const anulado = await tiposTras(async () => {
      const r = await agente
        .patch(`/api/erp/combustible/urea/conteos/${conteoId}/anular`)
        .send({ motivo: "conteo equivocado" });
      expect(r.status).toBe(200);
    });
    expect(anulado.map((e) => e.tipo)).toContain("combustible.urea_conteo_anulado");
    sinDatosDeNegocio([...creado, ...anulado]);
  });

  it("cargar y anular un precio publican urea_precios_cambiaron, solo con el id", async () => {
    let precioId = 0;
    const cargado = await tiposTras(async () => {
      const r = await precio();
      expect(r.status).toBe(201);
      precioId = r.body.id;
    });
    const eventoCarga = cargado.find((x) => x.tipo === "combustible.urea_precios_cambiaron");
    expect(eventoCarga?.payload).toEqual({ precioId });

    const anulado = await tiposTras(async () => {
      const r = await agente
        .patch(`/api/erp/combustible/urea/precios/${precioId}/anular`)
        .send({ motivo: "el precio no se confirmó" });
      expect(r.status).toBe(200);
    });
    expect(anulado.find((x) => x.tipo === "combustible.urea_precios_cambiaron")?.payload).toEqual({
      precioId,
    });
    sinDatosDeNegocio([...cargado, ...anulado]);
  });

  // ── 2. Lo que falla no publica nada ───────────────────────────────────

  it("un precio inválido (400) no publica ningún evento", async () => {
    const eventos = await tiposTras(async () => {
      const r = await precio({ presentacion: "bidon_que_no_existe" });
      expect(r.status).toBe(400);
    });
    expect(eventos).toEqual([]);
  });

  it("anular un precio inexistente (404) o ya anulado (409) no publica nada", async () => {
    const p = await precio();
    expect(p.status).toBe(201);
    expect(
      (
        await agente
          .patch(`/api/erp/combustible/urea/precios/${p.body.id}/anular`)
          .send({ motivo: "primera vez" })
      ).status
    ).toBe(200);

    const eventos = await tiposTras(async () => {
      expect(
        (
          await agente
            .patch(`/api/erp/combustible/urea/precios/${p.body.id}/anular`)
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
    expect(eventos).toEqual([]);
  });

  it("un vale rechazado (400/404) y una anulación inexistente no publican nada", async () => {
    const eventos = await tiposTras(async () => {
      // Cantidad inválida: el esquema lo rechaza antes de tocar la base.
      expect((await valeUrea({ cantidad_bultos: -3 })).status).toBe(400);
      expect(
        (
          await agente
            .patch("/api/erp/combustible/despachos/99999999/anular")
            .send({ motivo: "no existe" })
        ).status
      ).toBe(404);
      expect(
        (
          await agente
            .patch("/api/erp/combustible/recepciones/99999999/anular")
            .send({ motivo: "no existe" })
        ).status
      ).toBe(404);
    });
    expect(eventos).toEqual([]);
  });

  it("un vale repetido (mismo cliente_uuid, reintento sin señal) no publica un segundo evento", async () => {
    const uuid = crypto.randomUUID();
    const n = nVale++;
    const mandar = () => valeUrea({ cliente_uuid: uuid, n_vale: n });
    expect((await mandar()).status).toBe(201);

    const eventos = await tiposTras(async () => {
      const otra = await mandar();
      expect([200, 201, 409]).toContain(otra.status);
    });
    expect(eventos.filter((e) => e.tipo === "combustible.despacho_creado")).toEqual([]);
  });

  // ── 4. Aislamiento entre tenants ──────────────────────────────────────

  it("otro tenant no ve ni un solo evento de lo que hizo este", async () => {
    const marcaOtro = await marca(otroTenantId);
    await valeUrea();
    await precio();
    await entradaUrea();
    expect(await eventosDesde(otroTenantId, marcaOtro)).toEqual([]);

    // Y desde el otro tenant, el buffer de este es invisible aunque se pida
    // por id: el RLS filtra, no la aplicación.
    const visibles = await withTenant(otroTenantId, (c) =>
      c.query(`SELECT 1 FROM eventos_tiempo_real WHERE tenant_id = $1`, [tenantId])
    );
    expect(visibles.rowCount).toBe(0);
  });

  // ── 5. Diésel: el producto sale, para que urea lo ignore ──────────────

  it("un vale de diésel sale con producto combustible: el panel de urea lo ignora", async () => {
    const eventos = await tiposTras(async () => {
      const r = await agente.post("/api/erp/combustible/despachos").send({
        origen: "tanque_propio",
        combustible_id: tanqueId,
        tipo_combustible: "diesel_b5",
        tipo_destino: "equipo",
        equipo_id: equipoId,
        serie_talonario: serie,
        n_vale: nVale++,
        cantidad: 35,
        lectura_contometro: 35,
        costo_unitario: 16.8,
        despachado_en: new Date().toISOString(),
      });
      expect(r.status).toBe(201);
    });
    const e = eventos.find((x) => x.tipo === "combustible.despacho_creado");
    expect(e).toBeDefined();
    // El esquema lo deja en "combustible" por defecto: el panel de urea lo ignora.
    expect(e!.payload.producto).toBe("combustible");
  });
});
