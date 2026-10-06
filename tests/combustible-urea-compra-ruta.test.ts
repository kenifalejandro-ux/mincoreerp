/** tests/combustible-urea-compra-ruta.test.ts
 *
 * La urea comprada en ruta (migración 0119). Kenif, 2026-10-05: "también
 * compran urea cuando las unidades van en ruta, osea casi la misma lógica que
 * combustible".
 *
 * Lo que estos tests defienden, en orden de importancia:
 *
 *   1. Una compra en ruta NO baja el stock del almacén ni aparece en su
 *      kardex: esa urea nunca pasó por el depósito. Si lo bajara, el primer
 *      conteo físico daría un sobrante falso que taparía un faltante real.
 *   2. Pero SÍ cuenta para el tope diario de la unidad: partir la carga entre
 *      almacén y ruta no puede servir para esquivar el tope.
 *   3. La misma boleta puede traer diésel Y urea (un renglón por producto),
 *      pero la urea de una boleta no entra dos veces.
 *   4. El costo entra por bulto y se guarda por litro -- el bug de 0092 que
 *      valorizaba 10 cajas a S/ 40 en S/ 6.400.
 *   5. El conductor registra compras en ruta, no repartos del almacén.
 *   6. Cada ruta de la foto toca solo las compras de su producto.
 *   7. Los vales viejos de la cola offline ('compra_externa' + vale) siguen
 *      entrando, normalizados a 'almacen'.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";

const FOTO = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]); // JPEG mínimo

describe("combustible: compra de urea en ruta (migración 0119)", () => {
  let tenantId: string;
  let slug: string;
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);
  let equipoId: number;
  let grifoUrea: number; // vende urea Y diésel en ruta (el caso PRIMAX)
  let grifoSoloDiesel: number;
  let nVale = 1;
  const serie = `R${Math.floor(Math.random() * 1e6).toString(36)}`;

  const numero = () => `B001-${Math.floor(Math.random() * 1e8)}`;

  const compra = (overrides: Record<string, unknown> = {}, quien = agente) =>
    quien.post("/api/erp/combustible/despachos").send({
      cliente_uuid: crypto.randomUUID(),
      producto: "urea",
      origen: "compra_externa",
      grifo_id: grifoUrea,
      tipo_destino: "equipo",
      equipo_id: equipoId,
      comprobante_tipo: "boleta",
      comprobante_numero: numero(),
      presentacion: "caja",
      cantidad_bultos: 2,
      costo_unitario: 50, // POR CAJA, lo que dice la boleta
      despachado_en: new Date().toISOString(),
      ...overrides,
    });

  const vale = (cajas: number, overrides: Record<string, unknown> = {}) =>
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
      cantidad_bultos: cajas,
      despachado_en: new Date().toISOString(),
      ...overrides,
    });

  const entrada = (cajas: number, costoPorCaja: number) =>
    agente.post("/api/erp/combustible/recepciones").send({
      cliente_uuid: crypto.randomUUID(),
      producto: "urea",
      grifo_id: grifoUrea,
      presentacion: "caja",
      cantidad_bultos: cajas,
      costo_unitario: costoPorCaja,
      recibido_en: new Date().toISOString(),
    });

  const stock = async (): Promise<number> =>
    (await agente.get("/api/erp/combustible/urea/estado")).body.stock.stockL;

  const nuevoUsuario = async (rol: string, extra: Record<string, unknown> = {}) => {
    const email = `${rol}-${idUnico("u")}@test.local`;
    const alta = await agente
      .post("/api/erp/usuarios")
      .send({ nombre: rol, email, password, rol, ...extra });
    expect(alta.status).toBe(201);
    const a = request.agent(app);
    expect(
      (await a.post("/api/auth/login").send({ tenantSlug: slug, email, password })).status
    ).toBe(200);
    return a;
  };

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    slug = c.tenant.slug;
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug: slug, email: c.usuario.email, password });
    equipoId = (
      await agente
        .post("/api/erp/equipos")
        .send({ placa_codigo: idUnico("VQ"), tipo: "VOLQUETE", tipo_medidor: "horometro" })
    ).body.id;
    grifoUrea = (
      await agente.post("/api/erp/combustible/grifos").send({
        nombre: idUnico("PRIMAX"),
        abastece_ruta: true,
        abastece_tanque: false,
        abastece_urea: true,
      })
    ).body.id;
    grifoSoloDiesel = (
      await agente.post("/api/erp/combustible/grifos").send({
        nombre: idUnico("PETRO"),
        abastece_ruta: true,
        abastece_tanque: false,
        abastece_urea: false,
      })
    ).body.id;

    // Almacén: 10 cajas (160 L) entran, 3 (48 L) salen -> 112 L.
    expect((await entrada(10, 40)).status).toBe(201);
    expect((await vale(3)).status).toBe(201);
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  // ── 1. El stock ───────────────────────────────────────────────────────

  it("una compra en ruta queda como compra_externa, con su boleta y sin vale", async () => {
    const r = await compra();
    expect(r.status).toBe(201);
    expect(r.body.origen).toBe("compra_externa");
    expect(r.body.serie_talonario).toBeNull();
    expect(r.body.comprobante_tipo).toBe("boleta");
    expect(Number(r.body.cantidad)).toBe(32);
  });

  it("NO baja el stock del almacén ni aparece en su kardex", async () => {
    const antes = await stock();
    expect(antes).toBe(112);
    expect((await compra({ cantidad_bultos: 5 })).status).toBe(201);
    expect(await stock()).toBe(112);

    const k = await agente.get("/api/erp/combustible/urea/kardex").query({
      desde: new Date(Date.now() - 86400000).toISOString(),
      hasta: new Date(Date.now() + 86400000).toISOString(),
    });
    expect(k.status).toBe(200);
    // Una entrada y un vale: las compras en ruta no son movimientos del
    // depósito.
    expect(k.body.filas.map((f: { tipo: string }) => f.tipo)).toEqual(["entrada", "vale"]);
    expect(k.body.resumen.saldo_final).toBe(112);
  });

  it("un conteo después de compras en ruta cuadra: no hay sobrante fantasma", async () => {
    const c = await agente.post("/api/erp/combustible/urea/conteos").send({
      cliente_uuid: crypto.randomUUID(),
      presentacion: "caja",
      cantidad_bultos: 7, // 112 L, lo que de verdad hay en el depósito
      contado_en: new Date().toISOString(),
    });
    expect(c.status).toBe(201);
    const descuadres = await withTenant(tenantId, (cl) =>
      cl.query(
        `SELECT 1 FROM combustible_alertas WHERE tenant_id = $1 AND tipo = 'urea_descuadre_conteo'`,
        [tenantId]
      )
    );
    expect(descuadres.rowCount).toBe(0);
  });

  it("no genera alertas de talonario: no tiene vale de la empresa", async () => {
    const r = await withTenant(tenantId, (cl) =>
      cl.query(
        `SELECT tipo FROM combustible_alertas
          WHERE tenant_id = $1 AND tipo IN ('hueco_detectado', 'vale_fuera_de_orden', 'vale_recargado')`,
        [tenantId]
      )
    );
    expect(r.rowCount).toBe(0);
  });

  // ── 2. El tope diario suma las dos clases de salida ───────────────────

  it("el tope diario suma almacén y ruta: partir la carga no lo esquiva", async () => {
    const actual = await agente.get("/api/erp/combustible/config");
    const c = actual.body;
    // Ya recibió hoy: 48 (vale) + 32 + 80 (compras) = 160 L. Tope en 170: un
    // vale de 16 L cruza.
    const put = await agente.put("/api/erp/combustible/config").send({
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
      tope_diario_urea_l: 170,
      ratio_urea_diesel_max_pct: c.ratio_urea_diesel_max_pct,
      dias_sin_conteo_urea: c.dias_sin_conteo_urea,
      stock_minimo_urea_l: c.stock_minimo_urea_l,
      stock_maximo_urea_l: c.stock_maximo_urea_l,
      despacho_pide_medidor: c.despacho_pide_medidor,
    });
    expect(put.status).toBe(200);

    expect((await vale(1)).status).toBe(201);
    const topes = await withTenant(tenantId, (cl) =>
      cl.query<{ detalle: Record<string, unknown> }>(
        `SELECT detalle FROM combustible_alertas
          WHERE tenant_id = $1 AND tipo = 'tope_diario_excedido' AND producto = 'urea'`,
        [tenantId]
      )
    );
    expect(topes.rowCount).toBe(1);
    expect(Number(topes.rows[0].detalle.acumuladoL)).toBe(176);
  });

  // ── 3. La boleta ──────────────────────────────────────────────────────

  it("la misma boleta puede traer diésel y urea: un renglón por producto", async () => {
    const boleta = numero();
    const diesel = await agente.post("/api/erp/combustible/despachos").send({
      origen: "compra_externa",
      grifo_id: grifoUrea,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipoId,
      comprobante_tipo: "boleta",
      comprobante_numero: boleta,
      cantidad: 100,
      lectura_horometro: Math.floor(Math.random() * 1e6),
      horas_abastecidas: 10,
      costo_unitario: 17,
      despachado_en: new Date().toISOString(),
    });
    expect(diesel.status).toBe(201);
    // Antes de 0119 esto rebotaba como "boleta duplicada".
    expect((await compra({ comprobante_numero: boleta })).status).toBe(201);
    // Pero la urea de esa misma boleta no entra dos veces -- ni escrita
    // distinto.
    const otra = await compra({ comprobante_numero: ` ${boleta.toLowerCase()} ` });
    expect(otra.status).toBe(409);
  });

  it("sin comprobante, con vale y comprobante, o sin costo: 400", async () => {
    expect(
      (await compra({ comprobante_numero: undefined, comprobante_tipo: undefined })).status
    ).toBe(400);
    expect((await compra({ serie_talonario: serie, n_vale: 900 })).status).toBe(400);
    expect((await compra({ costo_unitario: undefined })).status).toBe(400);
  });

  it("un proveedor que no vende urea es 400", async () => {
    expect((await compra({ grifo_id: grifoSoloDiesel })).status).toBe(400);
  });

  // ── 4. El costo ───────────────────────────────────────────────────────

  it("el costo entra por bulto y se guarda por litro (el bug de 0092)", async () => {
    // Compra: 2 cajas a S/ 50 = S/ 100, no S/ 1.600.
    const c = await compra({ cantidad_bultos: 2, costo_unitario: 50 });
    expect(c.status).toBe(201);
    expect(Number(c.body.costo_unitario)).toBe(3.125); // 50 / 16
    expect(Number(c.body.costo_total)).toBe(100);

    // Entrada: 10 cajas a S/ 40 = S/ 400, no S/ 6.400.
    const e = await entrada(10, 40);
    expect(e.status).toBe(201);
    expect(Number(e.body.costo_unitario)).toBe(2.5);
    expect(Number(e.body.costo_total)).toBe(400);
  });

  it("un vale del almacén sin costo se valoriza con el promedio POR LITRO de las entradas", async () => {
    const v = await vale(2);
    expect(v.status).toBe(201);
    // Las dos entradas fueron a S/ 40 la caja = S/ 2,50 el litro.
    expect(Number(v.body.costo_unitario)).toBe(2.5);
    expect(Number(v.body.costo_total)).toBe(80);
  });

  // ── 5. El conductor ───────────────────────────────────────────────────

  it("el conductor registra la compra en ruta, pero no reparte del almacén", async () => {
    const conductor = await nuevoUsuario("conductor_ruta");
    expect((await compra({}, conductor)).status).toBe(201);

    const reparto = await conductor.post("/api/erp/combustible/despachos").send({
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
    });
    expect(reparto.status).toBe(403);
  });

  it("el encargado de urea y el conductor ven los proveedores de urea (antes: 403)", async () => {
    for (const rol of ["encargado_urea", "conductor_ruta"]) {
      const a = await nuevoUsuario(rol);
      const r = await a.get("/api/erp/combustible/urea/proveedores");
      expect(r.status).toBe(200);
      const ids = r.body.map((g: { id: number }) => g.id);
      expect(ids).toContain(grifoUrea);
      expect(ids).not.toContain(grifoSoloDiesel);
    }
  });

  // ── 6. La foto ────────────────────────────────────────────────────────

  it("la foto se sube por la cola (uuid), se ve, y cada ruta toca solo su producto", async () => {
    const uuid = crypto.randomUUID();
    const c = await compra({ cliente_uuid: uuid });
    expect(c.status).toBe(201);

    const sube = await agente
      .post(`/api/erp/combustible/urea/compras/por-uuid/${uuid}/comprobante`)
      .attach("archivo", FOTO, { filename: "boleta.jpg", contentType: "image/jpeg" });
    expect(sube.status).toBe(201);

    const baja = await agente
      .get(`/api/erp/combustible/urea/compras/${c.body.id}/comprobante`)
      .buffer(true)
      .parse((res, cb) => {
        const partes: Buffer[] = [];
        res.on("data", (d: Buffer) => partes.push(d));
        res.on("end", () => cb(null, Buffer.concat(partes)));
      });
    expect(baja.status).toBe(200);
    expect(Buffer.compare(baja.body as Buffer, FOTO)).toBe(0);

    // La ruta de combustible no abre la foto de una compra de urea...
    expect(
      (await agente.get(`/api/erp/combustible/despachos/${c.body.id}/comprobante`)).status
    ).toBe(404);
    // ...ni le sube una.
    const cruzada = await agente
      .post(`/api/erp/combustible/despachos/${c.body.id}/comprobante`)
      .attach("archivo", FOTO, { filename: "x.jpg", contentType: "image/jpeg" });
    expect(cruzada.status).toBe(404);
  });

  it("la ruta de combustible sigue funcionando para sus propias compras", async () => {
    // El riesgo concreto de este cambio: Express pasa `next` como tercer
    // argumento, y con un `.bind` el producto habría recibido una función --
    // toda subida de combustible daría 404. Este test lo ata.
    const diesel = await agente.post("/api/erp/combustible/despachos").send({
      origen: "compra_externa",
      grifo_id: grifoUrea,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipoId,
      comprobante_tipo: "factura",
      comprobante_numero: numero(),
      cantidad: 50,
      lectura_horometro: Math.floor(Math.random() * 1e6),
      horas_abastecidas: 8,
      costo_unitario: 17,
      despachado_en: new Date().toISOString(),
    });
    expect(diesel.status).toBe(201);
    const sube = await agente
      .post(`/api/erp/combustible/despachos/${diesel.body.id}/comprobante`)
      .attach("archivo", FOTO, { filename: "f.jpg", contentType: "image/jpeg" });
    expect(sube.status).toBe(201);
    // Y la de urea no la toca.
    expect(
      (await agente.get(`/api/erp/combustible/urea/compras/${diesel.body.id}/comprobante`)).status
    ).toBe(404);
  });

  // ── 8. Renglones (0120): "1 caja + 2 bolsas" ──────────────────────────

  it("una compra con varias presentaciones suma los litros y el costo de cada renglón", async () => {
    const r = await compra({
      presentacion: undefined,
      cantidad_bultos: undefined,
      costo_unitario: undefined,
      lineas: [
        { presentacion: "caja", cantidad_bultos: 1, costo_unitario: 50 },
        { presentacion: "bolsa", cantidad_bultos: 2, costo_unitario: 14 },
      ],
    });
    expect(r.status).toBe(201);
    // 16 + 2 × 4 = 24 L; 50 + 2 × 14 = S/ 78.
    expect(Number(r.body.cantidad)).toBe(24);
    expect(Number(r.body.costo_total)).toBeCloseTo(78, 1);
    // El detalle vive en los renglones, no en la fila (CHECK de 0120).
    expect(r.body.presentacion).toBeNull();
    expect(r.body.cantidad_bultos).toBeNull();

    const renglones = await withTenant(tenantId, (cl) =>
      cl.query<{ presentacion: string; litros: string; factor_litros: string }>(
        `SELECT presentacion, litros, factor_litros FROM combustible_despacho_urea_lineas
          WHERE despacho_id = $1 ORDER BY id`,
        [r.body.id]
      )
    );
    expect(renglones.rows.map((x) => x.presentacion)).toEqual(["caja", "bolsa"]);
    // Cada renglón congela su factor, y la suma es la cantidad del despacho.
    expect(renglones.rows.reduce((a, x) => a + Number(x.litros), 0)).toBe(24);
  });

  it("la forma de una sola presentación también queda como un renglón", async () => {
    const r = await compra({ cantidad_bultos: 3, costo_unitario: 48 });
    expect(r.status).toBe(201);
    const renglones = await withTenant(tenantId, (cl) =>
      cl.query(`SELECT 1 FROM combustible_despacho_urea_lineas WHERE despacho_id = $1`, [r.body.id])
    );
    expect(renglones.rowCount).toBe(1);
  });

  it("la misma presentación en dos renglones, o renglones y campos sueltos a la vez: 400", async () => {
    const repetida = await compra({
      presentacion: undefined,
      cantidad_bultos: undefined,
      costo_unitario: undefined,
      lineas: [
        { presentacion: "caja", cantidad_bultos: 1, costo_unitario: 50 },
        { presentacion: "caja", cantidad_bultos: 2, costo_unitario: 50 },
      ],
    });
    expect(repetida.status).toBe(400);

    const mezclada = await compra({
      lineas: [{ presentacion: "caja", cantidad_bultos: 1, costo_unitario: 50 }],
    });
    expect(mezclada.status).toBe(400);
  });

  it("el vale del almacén no acepta renglones: una presentación por vale", async () => {
    const r = await vale(1, {
      presentacion: undefined,
      cantidad_bultos: undefined,
      lineas: [{ presentacion: "caja", cantidad_bultos: 1, costo_unitario: 40 }],
    });
    expect(r.status).toBe(400);
  });

  it("un renglón con una presentación desactivada deshace la compra entera", async () => {
    const bolsa = (await agente.get("/api/erp/combustible/urea/presentaciones")).body.find(
      (p: { codigo: string }) => p.codigo === "bolsa"
    );
    await agente.put(`/api/erp/combustible/urea/presentaciones/${bolsa.id}`).send({
      nombre: bolsa.nombre,
      litros: Number(bolsa.litros),
      es_referencia: bolsa.es_referencia,
      activa: false,
      motivo: "prueba: renglón inválido",
    });
    const antes = await withTenant(tenantId, (cl) =>
      cl.query(`SELECT count(*)::int n FROM combustible_despachos WHERE tenant_id = $1`, [tenantId])
    );
    const r = await compra({
      presentacion: undefined,
      cantidad_bultos: undefined,
      costo_unitario: undefined,
      lineas: [
        { presentacion: "caja", cantidad_bultos: 1, costo_unitario: 50 },
        { presentacion: "bolsa", cantidad_bultos: 1, costo_unitario: 14 },
      ],
    });
    expect(r.status).toBe(400);
    const despues = await withTenant(tenantId, (cl) =>
      cl.query(`SELECT count(*)::int n FROM combustible_despachos WHERE tenant_id = $1`, [tenantId])
    );
    // Ni la compra a medias ni un renglón suelto: todo o nada.
    expect(despues.rows[0].n).toBe(antes.rows[0].n);
    await agente.put(`/api/erp/combustible/urea/presentaciones/${bolsa.id}`).send({
      nombre: bolsa.nombre,
      litros: Number(bolsa.litros),
      es_referencia: bolsa.es_referencia,
      activa: true,
      motivo: "revertir: fin del test",
    });
  });

  // ── 9. El historial (0120) ────────────────────────────────────────────

  it("el historial trae cada compra con sus renglones, su proveedor y si tiene foto", async () => {
    const r = await agente.get("/api/erp/combustible/urea/compras");
    expect(r.status).toBe(200);
    const mixta = r.body.find((c: { lineas: unknown[] }) => c.lineas.length === 2);
    expect(mixta).toBeTruthy();
    expect(mixta.lineas.map((l: { nombre: string }) => l.nombre)).toEqual(["Caja", "Bolsa"]);
    expect(mixta.proveedor).toBeTruthy();
    expect(mixta.placa_codigo).toBeTruthy();
    // Solo compras en ruta: ningún vale del almacén.
    expect(r.body.every((c: { comprobante_numero: string }) => c.comprobante_numero)).toBe(true);
  });

  it("reemplazar la foto exige motivo; adjuntar la primera, no", async () => {
    const c = await compra();
    const primera = await agente
      .post(`/api/erp/combustible/urea/compras/${c.body.id}/comprobante`)
      .attach("archivo", FOTO, { filename: "b.jpg", contentType: "image/jpeg" });
    expect(primera.status).toBe(201);

    const OTRA = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 9]);
    const sinMotivo = await agente
      .post(`/api/erp/combustible/urea/compras/${c.body.id}/comprobante`)
      .attach("archivo", OTRA, { filename: "b2.jpg", contentType: "image/jpeg" });
    expect(sinMotivo.status).toBe(400);

    const conMotivo = await agente
      .post(`/api/erp/combustible/urea/compras/${c.body.id}/comprobante`)
      .field("motivo", "la foto anterior era de otra boleta")
      .attach("archivo", OTRA, { filename: "b2.jpg", contentType: "image/jpeg" });
    expect(conMotivo.status).toBe(201);
  });

  // ── 7. La cola offline vieja ──────────────────────────────────────────  // ── 7. La cola offline vieja ──────────────────────────────────────────

  it("un vale viejo ('compra_externa' + vale) entra y queda como reparto del almacén", async () => {
    const antes = await stock();
    const viejo = await vale(1, { origen: "compra_externa" });
    expect(viejo.status).toBe(201);
    expect(viejo.body.origen).toBe("almacen");
    expect(await stock()).toBe(antes - 16);
  });

  it("'almacen' no existe para el combustible", async () => {
    const r = await agente.post("/api/erp/combustible/despachos").send({
      origen: "almacen",
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipoId,
      serie_talonario: serie,
      n_vale: nVale++,
      cantidad: 10,
      costo_unitario: 17,
    });
    expect(r.status).toBe(400);
  });
});
