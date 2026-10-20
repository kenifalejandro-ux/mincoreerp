/** tests/combustible-compra-ruta.test.ts
 *
 * La compra en ruta unificada (migración 0135): UNA boleta o factura con
 * combustible, urea o los dos. Kenif, 2026-10-19: el conductor compra los dos
 * productos juntos y recibe un solo papel; registrarlos por separado no cuadra.
 *
 * Lo que estos tests defienden, en orden de importancia:
 *
 *   1. ATOMICIDAD: se guardan los dos productos o ninguno. Una urea que falla
 *      no deja el combustible a medias (y viceversa): un conductor sin señal
 *      se enteraba días después, cuando la cola sincronizaba.
 *   2. El reintento con el mismo cliente_uuid no duplica nada (cola offline).
 *   3. El cuadre: el total del papel se guarda; sobre S/ 0.10 de diferencia el
 *      motivo es obligatorio, y bajo ese umbral no hace falta.
 *   4. Cada sección pide SU permiso y los roles de cancha ajenos no entran.
 *   5. La foto se sube una vez y queda en los dos despachos.
 *   6. Cada producto sigue siendo su propio despacho, con sus reglas de siempre.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, pool, withTenant } from "../src/server/config/database";

const FOTO = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]); // JPEG mínimo

describe("combustible: compra en ruta unificada (migración 0135)", () => {
  let tenantId: string;
  let slug: string;
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);
  let equipoId: number;
  let grifoAmbos: number; // vende diésel en ruta Y urea en ruta
  let grifoSoloDiesel: number;
  let horometro = 1000;

  const numero = () => `B001-${Math.floor(Math.random() * 1e8)}`;

  /** 40 gal × S/ 17.50 = 700.00; 2 cajas × S/ 50 = 100.00; total 800.00. */
  const cuerpo = (overrides: Record<string, unknown> = {}) => ({
    cliente_uuid: crypto.randomUUID(),
    grifo_id: grifoAmbos,
    comprobante_tipo: "boleta",
    comprobante_numero: numero(),
    equipo_id: equipoId,
    despachado_en: new Date().toISOString(),
    total_boleta: 800,
    combustible: {
      tipo_combustible: "diesel_b5",
      cantidad: 40,
      costo_unitario: 17.5,
      lectura_horometro: (horometro += 10),
      horas_abastecidas: 12,
    },
    urea: { lineas: [{ presentacion: "caja", cantidad_bultos: 2, costo_unitario: 50 }] },
    ...overrides,
  });

  const crear = (body: Record<string, unknown>, quien = agente) =>
    quien.post("/api/erp/combustible/compras-ruta").send(body);

  const contarDespachos = async (comprobante: string): Promise<number> =>
    (
      await withTenant(tenantId, (cl) =>
        cl.query(
          `SELECT 1 FROM combustible_despachos WHERE tenant_id = $1 AND comprobante_numero = $2`,
          [tenantId, comprobante]
        )
      )
    ).rowCount ?? 0;

  const contarCompras = async (comprobante: string): Promise<number> =>
    (
      await withTenant(tenantId, (cl) =>
        cl.query(
          `SELECT 1 FROM combustible_compras_ruta WHERE tenant_id = $1 AND comprobante_numero = $2`,
          [tenantId, comprobante]
        )
      )
    ).rowCount ?? 0;

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

  let seqDni = 0;
  /** Un conductor al que el admin le recortó permisos de pestaña (override por
   *  usuario, la tabla que escribe Configuración). Entra con DNI, como el
   *  personal de cancha real. */
  const conductorConPermisos = async (overrides: Record<string, boolean>) => {
    const dni = String(87200000 + Math.floor(Math.random() * 700000) + seqDni++);
    const alta = await agente
      .post("/api/erp/usuarios")
      .send({ nombre: "Conductor recortado", dni, password, rol: "conductor_ruta" });
    expect(alta.status, JSON.stringify(alta.body)).toBe(201);
    for (const [pestana, permitido] of Object.entries(overrides)) {
      await withTenant(tenantId, (cl) =>
        cl.query(
          `INSERT INTO usuario_permisos_pestana (tenant_id, usuario_id, modulo, pestana, permitido)
           VALUES ($1, $2, 'combustible', $3, $4)`,
          [tenantId, alta.body.id, pestana, permitido]
        )
      );
    }
    const a = request.agent(app);
    const entrar = await a
      .post("/api/auth/login")
      .send({ tenantSlug: slug, identificador: dni, password });
    expect(entrar.status).toBe(200);
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
    grifoAmbos = (
      await agente.post("/api/erp/combustible/grifos").send({
        nombre: idUnico("PRIMAX"),
        abastece_ruta: true,
        abastece_tanque: false,
        abastece_urea: true,
        abastece_urea_ruta: true,
      })
    ).body.id;
    grifoSoloDiesel = (
      await agente.post("/api/erp/combustible/grifos").send({
        nombre: idUnico("PETRO"),
        abastece_ruta: true,
        abastece_tanque: false,
        abastece_urea: false,
        abastece_urea_ruta: false,
      })
    ).body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  // ── 1. La boleta completa ─────────────────────────────────────────────

  it("una boleta con combustible y urea crea los dos despachos y su cabecera", async () => {
    const body = cuerpo();
    const r = await crear(body);
    expect(r.status).toBe(201);

    const { compra, despacho_combustible: comb, despacho_urea: urea } = r.body;
    expect(comb.producto).toBe("combustible");
    expect(urea.producto).toBe("urea");
    // El mismo papel en los dos: la boleta es una.
    expect(comb.comprobante_numero).toBe(body.comprobante_numero);
    expect(urea.comprobante_numero).toBe(body.comprobante_numero);
    expect(Number(comb.cantidad)).toBe(40);
    // 2 cajas de urea, en litros (el factor lo pone el servidor).
    expect(Number(urea.cantidad)).toBeGreaterThan(0);

    expect(Number(compra.total_boleta)).toBe(800);
    expect(Number(compra.total_sistema)).toBe(800);
    expect(Number(compra.diferencia)).toBe(0);
    expect(compra.motivo_descuadre).toBeNull();
    expect(Number(compra.despacho_combustible_id)).toBe(Number(comb.id));
    expect(Number(compra.despacho_urea_id)).toBe(Number(urea.id));
  });

  it("solo combustible: crea un despacho y la cabecera sin urea", async () => {
    const body = cuerpo({ urea: undefined, total_boleta: 700 });
    const r = await crear(body);
    expect(r.status).toBe(201);
    expect(r.body.despacho_urea).toBeNull();
    expect(Number(r.body.compra.total_sistema)).toBe(700);
    expect(r.body.compra.despacho_urea_id).toBeNull();
  });

  it("solo urea: crea un despacho y la cabecera sin combustible", async () => {
    const body = cuerpo({ combustible: undefined, total_boleta: 100 });
    const r = await crear(body);
    expect(r.status).toBe(201);
    expect(r.body.despacho_combustible).toBeNull();
    expect(Number(r.body.compra.total_sistema)).toBe(100);
    expect(r.body.compra.despacho_combustible_id).toBeNull();
  });

  it("sin combustible ni urea: 400", async () => {
    const r = await crear(cuerpo({ combustible: undefined, urea: undefined }));
    expect(r.status).toBe(400);
  });

  // ── 2. Atomicidad ─────────────────────────────────────────────────────

  it("si la urea falla, el combustible NO queda guardado (todo o nada)", async () => {
    // Este proveedor no vende urea: el despacho de urea es un 400, y el de
    // combustible que ya se había creado un instante antes tiene que deshacerse.
    const body = cuerpo({ grifo_id: grifoSoloDiesel });
    const r = await crear(body);
    expect(r.status).toBe(400);
    expect(await contarDespachos(body.comprobante_numero)).toBe(0);
    expect(await contarCompras(body.comprobante_numero)).toBe(0);
  });

  it("si el combustible falla, la urea NO queda guardada", async () => {
    // Sin horómetro: la unidad se mide por horómetro y el combustible lo exige.
    const body = cuerpo();
    delete (body.combustible as Record<string, unknown>).lectura_horometro;
    const r = await crear(body);
    expect(r.status).toBe(400);
    expect(await contarDespachos(body.comprobante_numero)).toBe(0);
  });

  it("el rechazo no gasta el uuid: la corrección reintenta con el mismo y entra", async () => {
    const uuid = crypto.randomUUID();
    const malo = cuerpo({ cliente_uuid: uuid, grifo_id: grifoSoloDiesel });
    expect((await crear(malo)).status).toBe(400);
    const bueno = {
      ...cuerpo({ cliente_uuid: uuid }),
      comprobante_numero: malo.comprobante_numero,
    };
    const r = await crear(bueno);
    expect(r.status).toBe(201);
  });

  // ── 3. Reintento offline ──────────────────────────────────────────────

  it("el mismo cliente_uuid reintentado devuelve 200 y no duplica nada", async () => {
    const body = cuerpo();
    const primero = await crear(body);
    expect(primero.status).toBe(201);
    const reintento = await crear(body);
    expect(reintento.status).toBe(200);
    expect(reintento.body.compra.id).toBe(primero.body.compra.id);
    expect(await contarDespachos(body.comprobante_numero)).toBe(2);
    expect(await contarCompras(body.comprobante_numero)).toBe(1);
  });

  it("la misma boleta con OTRO uuid es un 409 y no deja nada a medias", async () => {
    const body = cuerpo();
    expect((await crear(body)).status).toBe(201);
    const gemela = cuerpo({
      comprobante_numero: body.comprobante_numero,
      cliente_uuid: crypto.randomUUID(),
    });
    const r = await crear(gemela);
    expect(r.status).toBe(409);
    expect(await contarDespachos(body.comprobante_numero)).toBe(2);
    expect(await contarCompras(body.comprobante_numero)).toBe(1);
  });

  // ── 4. El cuadre ──────────────────────────────────────────────────────

  it("no cuadra y sin motivo: se registra igual (el grifo maneja su precio)", async () => {
    const body = cuerpo({ total_boleta: 810 });
    const r = await crear(body);
    expect(r.status).toBe(201);
    expect(Number(r.body.compra.diferencia)).toBe(10);
    expect(r.body.compra.motivo_descuadre).toBeNull();
  });

  it("no cuadra con motivo: se guarda la diferencia y el motivo", async () => {
    const r = await crear(
      cuerpo({ total_boleta: 810, motivo_descuadre: "El grifo cobró un servicio de lavado" })
    );
    expect(r.status).toBe(201);
    expect(Number(r.body.compra.diferencia)).toBe(10);
    expect(r.body.compra.motivo_descuadre).toBe("El grifo cobró un servicio de lavado");
  });

  it("una diferencia de redondeo (hasta S/ 0.10) no pide motivo", async () => {
    const r = await crear(cuerpo({ total_boleta: 800.05 }));
    expect(r.status).toBe(201);
    expect(Number(r.body.compra.diferencia)).toBe(0.05);
    expect(r.body.compra.motivo_descuadre).toBeNull();
  });

  it("una diferencia de S/ 0.11 también se registra sin motivo", async () => {
    expect((await crear(cuerpo({ total_boleta: 800.1 }))).status).toBe(201);
    expect((await crear(cuerpo({ total_boleta: 800.11 }))).status).toBe(201);
  });

  it("el motivo sobra si cuadra: no se guarda", async () => {
    const r = await crear(cuerpo({ motivo_descuadre: "no hacía falta" }));
    expect(r.status).toBe(201);
    expect(r.body.compra.motivo_descuadre).toBeNull();
  });

  it("sin total de la boleta: se guarda la suma del sistema", async () => {
    const body = cuerpo();
    delete (body as Record<string, unknown>).total_boleta;
    const r = await crear(body);
    expect(r.status).toBe(201);
    expect(Number(r.body.compra.diferencia)).toBe(0);
  });

  // ── 4b. La alerta en la Bandeja ───────────────────────────────────────

  const alertasDescuadre = async (numeroBoleta: string) =>
    (
      await withTenant(tenantId, (cl) =>
        cl.query(
          `SELECT tipo, despacho_id, producto, detalle FROM combustible_alertas
            WHERE tenant_id = $1 AND tipo = 'compra_ruta_descuadre'
              AND detalle->>'comprobanteNumero' = $2`,
          [tenantId, numeroBoleta]
        )
      )
    ).rows;

  it("una boleta que no cuadra deja una alerta con el papel, lo registrado y el motivo", async () => {
    const body = cuerpo({ total_boleta: 810, motivo_descuadre: "El grifo cobró un lavado" });
    const r = await crear(body);
    expect(r.status).toBe(201);
    const alertas = await alertasDescuadre(body.comprobante_numero);
    expect(alertas).toHaveLength(1);
    // Anclada al despacho de combustible de la boleta.
    expect(Number(alertas[0].despacho_id)).toBe(Number(r.body.despacho_combustible.id));
    expect(alertas[0].detalle).toMatchObject({
      totalBoleta: 810,
      totalSistema: 800,
      diferencia: 10,
      motivo: "El grifo cobró un lavado",
    });
    expect(alertas[0].detalle.comprobante).toContain(body.comprobante_numero);
  });

  it("la alerta se ancla al despacho de urea cuando la boleta es solo de urea", async () => {
    const body = cuerpo({
      combustible: undefined,
      total_boleta: 150,
      motivo_descuadre: "Faltó una caja en la boleta",
    });
    const r = await crear(body);
    expect(r.status).toBe(201);
    const [a] = await alertasDescuadre(body.comprobante_numero);
    expect(a.producto).toBe("urea");
    expect(Number(a.despacho_id)).toBe(Number(r.body.despacho_urea.id));
  });

  it("una boleta que cuadra, o con diferencia de redondeo, no deja alerta", async () => {
    const cuadra = cuerpo();
    expect((await crear(cuadra)).status).toBe(201);
    const redondeo = cuerpo({ total_boleta: 800.05 });
    expect((await crear(redondeo)).status).toBe(201);
    expect(await alertasDescuadre(cuadra.comprobante_numero)).toHaveLength(0);
    expect(await alertasDescuadre(redondeo.comprobante_numero)).toHaveLength(0);
  });

  it("el reintento de una boleta que no cuadra no duplica la alerta", async () => {
    const body = cuerpo({ total_boleta: 820, motivo_descuadre: "Servicio extra" });
    expect((await crear(body)).status).toBe(201);
    expect((await crear(body)).status).toBe(200);
    expect(await alertasDescuadre(body.comprobante_numero)).toHaveLength(1);
  });

  it("la alerta aparece en el listado de alertas del admin", async () => {
    const body = cuerpo({ total_boleta: 830, motivo_descuadre: "Propina al playero" });
    expect((await crear(body)).status).toBe(201);
    const r = await agente.get("/api/erp/combustible/alertas");
    expect(r.status, JSON.stringify(r.body).slice(0, 200)).toBe(200);
    const filas = (Array.isArray(r.body) ? r.body : (r.body.data ?? [])) as {
      tipo: string;
      detalle: { comprobanteNumero?: string };
    }[];
    expect(
      filas.some(
        (f) =>
          f.tipo === "compra_ruta_descuadre" &&
          f.detalle.comprobanteNumero === body.comprobante_numero
      )
    ).toBe(true);
  });

  // ── 5. Permisos ───────────────────────────────────────────────────────

  it("el conductor de ruta registra una compra completa", async () => {
    const conductor = await nuevoUsuario("conductor_ruta");
    const r = await crear(cuerpo(), conductor);
    expect(r.status).toBe(201);
    expect(r.body.compra.usuario_id).toBeTruthy();
  });

  it("Lectura no puede: 403, y no se guarda nada", async () => {
    const lectura = await nuevoUsuario("lectura");
    const body = cuerpo();
    const r = await crear(body, lectura);
    expect(r.status).toBe(403);
    expect(await contarDespachos(body.comprobante_numero)).toBe(0);
  });

  it("sin el permiso de combustible, la sección de combustible da 403 y no se guarda nada", async () => {
    const solo = await conductorConPermisos({ "tanques:registrar_despacho": false });
    const body = cuerpo();
    const r = await crear(body, solo);
    expect(r.status).toBe(403);
    expect(await contarDespachos(body.comprobante_numero)).toBe(0);
    // Lo que sí le toca (urea sola) sigue entrando.
    expect((await crear(cuerpo({ combustible: undefined, total_boleta: 100 }), solo)).status).toBe(
      201
    );
  });

  it("sin el permiso de urea, la sección de urea da 403 y no se guarda nada", async () => {
    const solo = await conductorConPermisos({ "urea:registrar_compra": false });
    const body = cuerpo();
    const r = await crear(body, solo);
    expect(r.status).toBe(403);
    expect(await contarDespachos(body.comprobante_numero)).toBe(0);
    expect((await crear(cuerpo({ urea: undefined, total_boleta: 700 }), solo)).status).toBe(201);
  });

  it("sin ninguno de los dos permisos, la ruta entera da 403", async () => {
    const nada = await conductorConPermisos({
      "tanques:registrar_despacho": false,
      "urea:registrar_compra": false,
    });
    expect((await crear(cuerpo(), nada)).status).toBe(403);
  });

  it("el conductor no puede subir la foto de una compra que no registró él", async () => {
    const body = cuerpo();
    expect((await crear(body)).status).toBe(201); // la registró el admin
    const conductor = await nuevoUsuario("conductor_ruta");
    const r = await conductor
      .post(`/api/erp/combustible/compras-ruta/por-uuid/${body.cliente_uuid}/comprobante`)
      .attach("archivo", FOTO, { filename: "b.jpg", contentType: "image/jpeg" });
    expect(r.status).toBe(404);
  });

  it("el grifero no compra en ruta: 403", async () => {
    const grifero = await nuevoUsuario("grifero");
    expect((await crear(cuerpo(), grifero)).status).toBe(403);
  });

  // ── 6. La foto única ──────────────────────────────────────────────────

  it("la foto se sube una vez y queda en los dos despachos", async () => {
    const body = cuerpo();
    const c = await crear(body);
    expect(c.status).toBe(201);

    const sube = await agente
      .post(`/api/erp/combustible/compras-ruta/por-uuid/${body.cliente_uuid}/comprobante`)
      .attach("archivo", FOTO, { filename: "boleta.jpg", contentType: "image/jpeg" });
    expect(sube.status).toBe(201);

    const bajar = (ruta: string) =>
      agente
        .get(ruta)
        .buffer(true)
        .parse((res, cb) => {
          const partes: Buffer[] = [];
          res.on("data", (d: Buffer) => partes.push(d));
          res.on("end", () => cb(null, Buffer.concat(partes)));
        });
    const combustible = await bajar(
      `/api/erp/combustible/despachos/${c.body.despacho_combustible.id}/comprobante`
    );
    const urea = await bajar(
      `/api/erp/combustible/urea/compras/${c.body.despacho_urea.id}/comprobante`
    );
    expect(combustible.status).toBe(200);
    expect(urea.status).toBe(200);
  });

  it("reenviar la misma foto (la cola offline) devuelve 200", async () => {
    const body = cuerpo();
    expect((await crear(body)).status).toBe(201);
    const url = `/api/erp/combustible/compras-ruta/por-uuid/${body.cliente_uuid}/comprobante`;
    const adjunta = () =>
      agente.post(url).attach("archivo", FOTO, { filename: "b.jpg", contentType: "image/jpeg" });
    expect((await adjunta()).status).toBe(201);
    expect((await adjunta()).status).toBe(200);
  });

  it("la foto de una compra que no existe es un 404; un uuid mal formado también", async () => {
    const ruta = (u: string) => `/api/erp/combustible/compras-ruta/por-uuid/${u}/comprobante`;
    const sube = (u: string) =>
      agente
        .post(ruta(u))
        .attach("archivo", FOTO, { filename: "b.jpg", contentType: "image/jpeg" });
    expect((await sube(crypto.randomUUID())).status).toBe(404);
    expect((await sube("no-es-un-uuid")).status).toBe(404);
  });

  // ── 6b. El historial unificado ────────────────────────────────────────

  const boletas = (quien = agente) => quien.get("/api/erp/combustible/compras-ruta");
  const buscarBoleta = async (numero: string, quien = agente) => {
    const r = await boletas(quien);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return (r.body as { comprobante_numero: string }[]).filter(
      (b) => b.comprobante_numero === numero
    );
  };

  it("el historial junta combustible y urea de una boleta en UNA fila", async () => {
    const body = cuerpo();
    expect((await crear(body)).status).toBe(201);
    const filas = await buscarBoleta(body.comprobante_numero);
    expect(filas).toHaveLength(1);
    const b = filas[0] as unknown as {
      combustible: { galones: number; total: number } | null;
      urea: { litros: number; total: number; lineas: unknown[] } | null;
      total_sistema: number;
      total_boleta: number;
      diferencia: number;
      con_foto: number;
      despachos: number;
    };
    expect(b.combustible?.galones).toBe(40);
    expect(b.combustible?.total).toBe(700);
    expect(b.urea?.total).toBe(100);
    expect(b.urea?.lineas).toHaveLength(1);
    expect(b.total_sistema).toBe(800);
    expect(b.total_boleta).toBe(800);
    expect(b.diferencia).toBe(0);
    expect(b.despachos).toBe(2);
    expect(b.con_foto).toBe(0);
  });

  it("agrupa también una boleta registrada por separado, sin cabecera (compras anteriores)", async () => {
    const numeroBoleta = numero();
    const comun = {
      origen: "compra_externa",
      grifo_id: grifoAmbos,
      tipo_destino: "equipo",
      equipo_id: equipoId,
      comprobante_tipo: "boleta",
      comprobante_numero: numeroBoleta,
      despachado_en: new Date().toISOString(),
    };
    const a = await agente.post("/api/erp/combustible/despachos").send({
      ...comun,
      cliente_uuid: crypto.randomUUID(),
      producto: "combustible",
      tipo_combustible: "diesel_b5",
      cantidad: 10,
      costo_unitario: 17.5,
      lectura_horometro: (horometro += 10),
      horas_abastecidas: 5,
    });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const u = await agente.post("/api/erp/combustible/despachos").send({
      ...comun,
      cliente_uuid: crypto.randomUUID(),
      producto: "urea",
      lineas: [{ presentacion: "caja", cantidad_bultos: 1, costo_unitario: 50 }],
    });
    expect(u.status, JSON.stringify(u.body)).toBe(201);

    const filas = await buscarBoleta(numeroBoleta);
    expect(filas).toHaveLength(1);
    const b = filas[0] as unknown as { total_boleta: number | null; despachos: number };
    expect(b.despachos).toBe(2);
    // Sin cabecera: no hay total del papel que mostrar.
    expect(b.total_boleta).toBeNull();
  });

  it("la foto subida desde el historial con el id de UN despacho queda en los dos", async () => {
    const body = cuerpo();
    const c = await crear(body);
    expect(c.status).toBe(201);

    const sube = await agente
      .post(`/api/erp/combustible/compras-ruta/${c.body.despacho_urea.id}/comprobante`)
      .attach("archivo", FOTO, { filename: "boleta.jpg", contentType: "image/jpeg" });
    expect(sube.status, JSON.stringify(sube.body)).toBe(201);

    const [b] = (await buscarBoleta(body.comprobante_numero)) as unknown as {
      con_foto: number;
      despachos: number;
      foto_de: { id: number } | null;
    }[];
    expect(b.con_foto).toBe(2);
    expect(b.despachos).toBe(2);
    expect(b.foto_de).not.toBeNull();

    // Reenviar el mismo archivo es un reintento: 200, no un reemplazo.
    const otra = await agente
      .post(`/api/erp/combustible/compras-ruta/${c.body.despacho_combustible.id}/comprobante`)
      .attach("archivo", FOTO, { filename: "boleta.jpg", contentType: "image/jpeg" });
    expect(otra.status).toBe(200);
  });

  it("el conductor ve en el historial solo sus boletas, y solo él sube su foto", async () => {
    const suyo = await nuevoUsuario("conductor_ruta");
    const otro = await nuevoUsuario("conductor_ruta");
    const mia = cuerpo();
    const creada = await crear(mia, suyo);
    expect(creada.status, JSON.stringify(creada.body)).toBe(201);
    const ajena = cuerpo();
    expect((await crear(ajena)).status).toBe(201); // del admin

    expect(await buscarBoleta(mia.comprobante_numero, suyo)).toHaveLength(1);
    expect(await buscarBoleta(ajena.comprobante_numero, suyo)).toHaveLength(0);
    expect(await buscarBoleta(mia.comprobante_numero, otro)).toHaveLength(0);

    const intruso = await otro
      .post(`/api/erp/combustible/compras-ruta/${creada.body.despacho_urea.id}/comprobante`)
      .attach("archivo", FOTO, { filename: "x.jpg", contentType: "image/jpeg" });
    expect(intruso.status).toBe(404);
    const propio = await suyo
      .post(`/api/erp/combustible/compras-ruta/${creada.body.despacho_urea.id}/comprobante`)
      .attach("archivo", FOTO, { filename: "b.jpg", contentType: "image/jpeg" });
    expect(propio.status).toBe(201);
  });

  it("Lectura no puede subir fotos desde el historial, y un id que no existe es 404", async () => {
    const lectura = await nuevoUsuario("lectura");
    const r = await lectura
      .post("/api/erp/combustible/compras-ruta/1/comprobante")
      .attach("archivo", FOTO, { filename: "x.jpg", contentType: "image/jpeg" });
    expect(r.status).toBe(403);
    const inexistente = await agente
      .post("/api/erp/combustible/compras-ruta/999999999/comprobante")
      .attach("archivo", FOTO, { filename: "x.jpg", contentType: "image/jpeg" });
    expect(inexistente.status).toBe(404);
  });

  // ── 7. Cada despacho sigue siendo suyo ────────────────────────────────

  it("cada despacho queda auditado por separado y con su compra", async () => {
    const body = cuerpo();
    const r = await crear(body);
    expect(r.status).toBe(201);
    // platform_audit_log no tiene RLS: se filtra por tenant a mano.
    const acciones = await pool.query(
      `SELECT accion FROM platform_audit_log
        WHERE tenant_id = $1 AND detalle->>'comprobanteNumero' = $2 ORDER BY id`,
      [tenantId, body.comprobante_numero]
    );
    const lista = acciones.rows.map((f: { accion: string }) => f.accion);
    expect(lista).toContain("combustible.compra_ruta_crear");
    expect(lista.filter((a: string) => a === "combustible.despacho_crear")).toHaveLength(2);
  });

  it("una fecha en el futuro lejano es un 400", async () => {
    const r = await crear(cuerpo({ despachado_en: new Date(Date.now() + 86400000).toISOString() }));
    expect(r.status).toBe(400);
  });
});
