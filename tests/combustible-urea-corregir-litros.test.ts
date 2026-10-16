/** tests/combustible-urea-corregir-litros.test.ts
 *
 * Corregir los litros de un envase con historial (migración 0130): el caso
 * real de Kenif, cajas registradas a 16 L que eran de 20 L.
 *
 * Lo que defienden, en orden:
 *   1. Nadie lo puede hacer por defecto, ni el admin: el check se habilita
 *      persona por persona.
 *   2. La vista previa NO escribe nada, y lo que muestra es lo que se aplica.
 *   3. Cada fila del envase queda corregida (entradas, vales, compras en ruta,
 *      conteos) y el stock cuadra con lo que se ve en físico.
 *   4. El precio POR BULTO se conserva; los vales a promedio se recalculan,
 *      de cualquier envase.
 *   5. Nada se pierde: cada valor anterior queda en el registro.
 *   6. Nunca es silenciosa: hallazgo para gerencia, bitácora, y el hallazgo
 *      se puede congelar.
 */
import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";
import { correrConciliacion } from "../src/server/services/combustibleConciliacion.worker";

const DIA = 86400000;
const hace = (ms: number) => new Date(Date.now() - ms).toISOString();

describe("combustible: corregir los litros de un envase de urea", () => {
  let tenantId: string;
  let slug: string;
  const password = "ClaveDePrueba123";
  const admin = request.agent(app);
  let encargado: ReturnType<typeof request.agent>;
  let equipoId: number;
  let grifoUrea: number;
  let grifoRuta: number;
  let nVale = 1;
  const serie = `C${Math.floor(Math.random() * 1e8).toString(36)}`;
  let cajaId: number;

  const entrada = (presentacion: string, bultos: number, costoPorBulto: number) =>
    admin.post("/api/erp/combustible/recepciones").send({
      cliente_uuid: crypto.randomUUID(),
      producto: "urea",
      grifo_id: grifoUrea,
      presentacion,
      cantidad_bultos: bultos,
      costo_unitario: costoPorBulto,
      recibido_en: hace(2 * DIA),
    });

  const vale = (presentacion: string, bultos: number, extra: Record<string, unknown> = {}) =>
    admin.post("/api/erp/combustible/despachos").send({
      cliente_uuid: crypto.randomUUID(),
      producto: "urea",
      origen: "almacen",
      grifo_id: grifoUrea,
      tipo_destino: "equipo",
      equipo_id: equipoId,
      serie_talonario: serie,
      n_vale: nVale++,
      presentacion,
      cantidad_bultos: bultos,
      despachado_en: hace(DIA),
      ...extra,
    });

  const corregir = (quien: ReturnType<typeof request.agent>, id: number, cuerpo: object) =>
    quien.post(`/api/erp/combustible/urea/presentaciones/${id}/correccion`).send(cuerpo);
  const vistaPrevia = (quien: ReturnType<typeof request.agent>, id: number, cuerpo: object) =>
    quien
      .post(`/api/erp/combustible/urea/presentaciones/${id}/correccion/vista-previa`)
      .send(cuerpo);

  const fila = async (tabla: string, id: number, columnas: string) => {
    const r = await withTenant(tenantId, (c) =>
      c.query(`SELECT ${columnas} FROM ${tabla} WHERE id = $1 AND tenant_id = $2`, [id, tenantId])
    );
    return r.rows[0];
  };

  let entradaCajas: number;
  let entradaBolsas: number;
  const valesCaja: number[] = [];
  let valeBolsa: number;
  let compra: number;
  let conteo: number;

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    slug = c.tenant.slug;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: slug, email: c.usuario.email, password });

    equipoId = (
      await admin.post("/api/erp/equipos").send({ placa_codigo: idUnico("VC"), tipo: "VOLQUETE" })
    ).body.id;
    grifoUrea = (
      await admin.post("/api/erp/combustible/grifos").send({
        nombre: idUnico("UREACORR"),
        abastece_ruta: false,
        abastece_tanque: false,
        abastece_urea: true,
        abastece_urea_ruta: true,
      })
    ).body.id;
    grifoRuta = (
      await admin.post("/api/erp/combustible/grifos").send({
        nombre: idUnico("UREARUTA"),
        abastece_ruta: true,
        abastece_tanque: false,
        abastece_urea: true,
        abastece_urea_ruta: true,
      })
    ).body.id;

    // El encargado: operador con el check de corregir litros habilitado por
    // el admin. Es el único que lo va a tener.
    const email = `encargado-${idUnico("u")}@test.local`;
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre: "Noemí", email, password, rol: "operador" });
    expect(alta.status).toBe(201);
    const actuales = await admin.get(`/api/erp/usuarios/${alta.body.id}/permisos`);
    const cuerpoPermisos = {
      modulos: actuales.body.modulos.map(
        (m: { modulo: string; asignado: boolean; nivel: string }) => ({
          modulo: m.modulo,
          asignado: m.asignado,
          nivel: m.nivel,
        })
      ),
      pestanas: [{ modulo: "combustible", pestana: "urea:corregir_litros", permitido: true }],
      motivo: "encargada de urea",
    };
    const habilitar = await admin
      .put(`/api/erp/usuarios/${alta.body.id}/permisos`)
      .send(cuerpoPermisos);
    expect(habilitar.status, JSON.stringify(habilitar.body)).toBe(200);
    encargado = request.agent(app);
    expect(
      (await encargado.post("/api/auth/login").send({ tenantSlug: slug, email, password })).status
    ).toBe(200);

    // ── El historial de Kenif: la caja quedó a 16 L y era de 20 ──────────
    const e1 = await entrada("caja", 20, 20); // 320 L, S/ 20 la caja = 1.25/L
    expect(e1.status).toBe(201);
    entradaCajas = Number(e1.body.id);
    const e2 = await entrada("bolsa", 10, 8); // 40 L, S/ 8 la bolsa = 2.00/L
    expect(e2.status).toBe(201);
    entradaBolsas = Number(e2.body.id);
    for (let i = 0; i < 3; i++) {
      const v = await vale("caja", 1); // a promedio
      expect(v.status).toBe(201);
      valesCaja.push(Number(v.body.id));
    }
    const vb = await vale("bolsa", 2); // a promedio
    expect(vb.status).toBe(201);
    valeBolsa = Number(vb.body.id);

    const cr = await admin.post("/api/erp/combustible/despachos").send({
      cliente_uuid: crypto.randomUUID(),
      producto: "urea",
      origen: "compra_externa",
      grifo_id: grifoRuta,
      tipo_destino: "equipo",
      equipo_id: equipoId,
      comprobante_tipo: "boleta",
      comprobante_numero: `B001-${Math.floor(Math.random() * 1e8)}`,
      presentacion: "caja",
      cantidad_bultos: 2,
      costo_unitario: 50,
      despachado_en: hace(DIA),
    });
    expect(cr.status, JSON.stringify(cr.body)).toBe(201);
    compra = Number(cr.body.id);

    // Contaron 17 cajas y 8 bolsas: cuadra con los papeles (272 + 32 = 304).
    const ct = await admin.post("/api/erp/combustible/urea/conteos").send({
      cliente_uuid: crypto.randomUUID(),
      lineas: [
        { presentacion: "caja", cantidad_bultos: 17 },
        { presentacion: "bolsa", cantidad_bultos: 8 },
      ],
      contado_en: hace(3600000),
    });
    expect(ct.status, JSON.stringify(ct.body)).toBe(201);
    conteo = Number(ct.body.id);

    cajaId = (await admin.get("/api/erp/combustible/urea/presentaciones")).body.find(
      (p: { codigo: string }) => p.codigo === "caja"
    ).id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  // ── 1. Nadie por defecto ─────────────────────────────────────────────

  it("el admin NO puede corregir por defecto: el check nace apagado para todos", async () => {
    expect((await vistaPrevia(admin, cajaId, { litros: 20 })).status).toBe(403);
    expect((await corregir(admin, cajaId, { litros: 20, motivo: "x" })).status).toBe(403);
  });

  // ── 2. La vista previa ───────────────────────────────────────────────

  it("la vista previa dice exactamente qué cambia y NO escribe nada", async () => {
    const r = await vistaPrevia(encargado, cajaId, { litros: 20 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.litrosRegistrados).toEqual([16]);
    // Almacén: (320 + 40) − (48 + 8) = 304 → (400 + 40) − (60 + 8) = 372.
    expect(r.body.stockAlmacenL).toEqual({ antes: 304, despues: 372 });
    expect(r.body.envaseL).toEqual({ unidades: 17, antes: 272, despues: 340 });
    expect(r.body.filas).toEqual({ entradas: 1, vales: 3, comprasEnRuta: 1, conteos: 1 });
    // Los 3 vales de caja y el de bolsa van a promedio: el promedio se mueve.
    expect(r.body.valesRecosteados).toBe(4);
    expect(r.body.conteosSinDetalle).toBe(0);

    expect(Number((await fila("combustible_recepciones", entradaCajas, "cantidad")).cantidad)).toBe(
      320
    );
    const cat = await admin.get("/api/erp/combustible/urea/presentaciones");
    expect(Number(cat.body.find((p: { id: number }) => p.id === cajaId).litros)).toBe(16);
  });

  it("aplicar sin motivo es 400 y no cambia nada", async () => {
    const r = await corregir(encargado, cajaId, { litros: 20 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/motivo/i);
    expect(Number((await fila("combustible_recepciones", entradaCajas, "cantidad")).cantidad)).toBe(
      320
    );
  });

  // ── 3 y 4. Aplicada ──────────────────────────────────────────────────

  it("corrige todo el historial de la caja, conserva el precio por caja y cuadra el físico", async () => {
    const r = await corregir(encargado, cajaId, {
      litros: 20,
      motivo: "las cajas siempre fueron de 20 L; se dieron de alta con 16",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.resumen.stockAlmacenL).toEqual({ antes: 304, despues: 372 });

    // Entrada: 20 cajas × 20 L; S/ 20 la caja → 1.00 por litro.
    const e = await fila("combustible_recepciones", entradaCajas, "cantidad, costo_unitario");
    expect(Number(e.cantidad)).toBe(400);
    expect(Number(e.costo_unitario)).toBe(1);
    const renglonEntrada = await withTenant(tenantId, (c) =>
      c.query<{ factor_litros: string; litros: string; costo_por_bulto: string }>(
        `SELECT factor_litros, litros, costo_por_bulto FROM combustible_recepcion_urea_lineas
          WHERE recepcion_id = $1 AND tenant_id = $2`,
        [entradaCajas, tenantId]
      )
    );
    // El precio por caja de la factura no se toca: S/ 20.
    expect(
      renglonEntrada.rows.map((x) => [
        Number(x.factor_litros),
        Number(x.litros),
        Number(x.costo_por_bulto),
      ])
    ).toEqual([[20, 400, 20]]);
    // La entrada de bolsas no se toca.
    expect(
      Number((await fila("combustible_recepciones", entradaBolsas, "cantidad")).cantidad)
    ).toBe(40);

    // Vales de caja: 20 L cada uno; promedio (1.25 + 2.00)/2 → (1.00 + 2.00)/2.
    for (const id of valesCaja) {
      const v = await fila("combustible_despachos", id, "cantidad, costo_unitario, costo_origen");
      expect(Number(v.cantidad)).toBe(20);
      expect(Number(v.costo_unitario)).toBe(1.5);
      expect(v.costo_origen).toBe("promedio");
    }
    // El vale de bolsas: mismos litros, nuevo promedio.
    const vb = await fila("combustible_despachos", valeBolsa, "cantidad, costo_unitario");
    expect(Number(vb.cantidad)).toBe(8);
    expect(Number(vb.costo_unitario)).toBe(1.5);

    // Compra en ruta: 2 cajas a S/ 50 = S/ 100, ahora sobre 40 L.
    const c = await fila("combustible_despachos", compra, "cantidad, costo_unitario");
    expect(Number(c.cantidad)).toBe(40);
    expect(Number(c.costo_unitario)).toBe(2.5);

    // Conteo: 17 × 20 + 8 × 4 = 372, lo mismo que los papeles.
    expect(
      Number((await fila("combustible_conteos_urea", conteo, "cantidad_litros")).cantidad_litros)
    ).toBe(372);

    const estado = await admin.get("/api/erp/combustible/urea/estado");
    expect(estado.body.stock.stockL).toBe(372);
    const caja = estado.body.stock.envases.find((x: { codigo: string }) => x.codigo === "caja");
    expect(caja).toMatchObject({ unidades: 17, litros: 340, litrosRegistradosDistintos: [] });

    const cat = await admin.get("/api/erp/combustible/urea/presentaciones");
    expect(Number(cat.body.find((p: { id: number }) => p.id === cajaId).litros)).toBe(20);
  });

  // ── 5. Nada se pierde ────────────────────────────────────────────────

  it("cada fila corregida guarda su valor ANTES y DESPUÉS", async () => {
    const r = await withTenant(tenantId, (c) =>
      c.query<{ tabla: string; fila_id: string; antes: Record<string, number> }>(
        `SELECT f.tabla, f.fila_id, f.antes FROM combustible_urea_correccion_filas f
           JOIN combustible_urea_correcciones c ON c.id = f.correccion_id
          WHERE c.tenant_id = $1 ORDER BY f.id`,
        [tenantId]
      )
    );
    const tablas = r.rows.map((x) => x.tabla).sort();
    expect(tablas).toEqual(
      [
        "compra",
        "compra_renglon",
        "conteo",
        "conteo_renglon",
        "entrada",
        "entrada_renglon",
        // 3 vales de caja (litros y costo) + el de bolsas (solo costo).
        "vale",
        "vale",
        "vale",
        "vale",
        "vale_renglon",
        "vale_renglon",
        "vale_renglon",
      ].sort()
    );
    const laEntrada = r.rows.find((x) => x.tabla === "entrada")!;
    expect(laEntrada.antes).toMatchObject({ cantidad: 320, costo_unitario: 1.25 });
    const suRenglon = r.rows.find((x) => x.tabla === "entrada_renglon")!;
    expect(suRenglon.antes).toMatchObject({ factor_litros: 16, litros: 320 });
  });

  // ── 6. Nunca silenciosa ──────────────────────────────────────────────

  it("deja un hallazgo para gerencia, anclado a la corrección, y queda en la bitácora", async () => {
    const alerta = await withTenant(tenantId, (c) =>
      c.query<{ id: string; urea_correccion_id: string; detalle: Record<string, unknown> }>(
        `SELECT id, urea_correccion_id, detalle FROM combustible_alertas
          WHERE tenant_id = $1 AND tipo = 'urea_litros_corregidos'`,
        [tenantId]
      )
    );
    expect(alerta.rowCount).toBe(1);
    expect(alerta.rows[0].urea_correccion_id).not.toBeNull();
    expect(alerta.rows[0].detalle.motivo).toMatch(/siempre fueron de 20/);

    const log = await withTenant(tenantId, (c) =>
      c.query(
        `SELECT 1 FROM platform_audit_log
          WHERE tenant_id = $1 AND accion = 'combustible.urea_litros_corregidos'`,
        [tenantId]
      )
    );
    expect(log.rowCount).toBe(1);

    // Y si nadie lo explica, se congela con su ancla.
    await withTenant(tenantId, (c) =>
      c.query(
        `UPDATE combustible_alertas SET creado_en = now() - interval '10 days' WHERE id = $1`,
        [alerta.rows[0].id]
      )
    );
    await correrConciliacion(tenantId);
    const anomalia = await withTenant(tenantId, (c) =>
      c.query<{ urea_correccion_id: string }>(
        `SELECT urea_correccion_id FROM combustible_anomalias WHERE tenant_id = $1 AND alerta_id = $2`,
        [tenantId, alerta.rows[0].id]
      )
    );
    expect(anomalia.rowCount).toBe(1);
    expect(anomalia.rows[0].urea_correccion_id).toBe(alerta.rows[0].urea_correccion_id);
  });

  it("corregir a lo que ya está es 400: no hay nada que corregir", async () => {
    const r = await vistaPrevia(encargado, cajaId, { litros: 20 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/nada que corregir/i);
  });

  it("un envase sin movimientos es 409: sus litros se editan directo", async () => {
    const alta = await admin
      .post("/api/erp/combustible/urea/presentaciones")
      .send({ codigo: "lata", nombre: "Lata", litros: 3, es_referencia: false });
    expect(alta.status).toBe(201);
    const r = await vistaPrevia(encargado, Number(alta.body.id), { litros: 4 });
    expect(r.status).toBe(409);
  });

  it("un vale viejo sin costo_origen con precio declarado conserva su precio por balde", async () => {
    // Balde de 20 L: entrada a S/ 40 el balde (2.00/L), vale DECLARADO a S/ 60
    // el balde (3.00/L). Se le borra costo_origen: así quedaban los de antes.
    expect((await entrada("balde", 5, 40)).status).toBe(201);
    const v = await vale("balde", 1, { costo_unitario: 60 });
    expect(v.status).toBe(201);
    // Así quedó un vale viejo después de 0131: sin costo_origen y con su
    // renglón SIN precio por bulto (antes de 0130 no se sabía de dónde salía).
    await withTenant(tenantId, async (c) => {
      await c.query(`UPDATE combustible_despachos SET costo_origen = NULL WHERE id = $1`, [
        v.body.id,
      ]);
      await c.query(
        `UPDATE combustible_despacho_urea_lineas SET costo_por_bulto = NULL WHERE despacho_id = $1`,
        [v.body.id]
      );
    });

    const baldeId = (await admin.get("/api/erp/combustible/urea/presentaciones")).body.find(
      (p: { codigo: string }) => p.codigo === "balde"
    ).id;
    const previa = await vistaPrevia(encargado, baldeId, { litros: 25 });
    expect(previa.status).toBe(200);
    expect(previa.body.avisos.join(" ")).toMatch(/no guardaba/);

    const r = await corregir(encargado, baldeId, { litros: 25, motivo: "balde de 25 L" });
    expect(r.status).toBe(201);
    const despues = await fila(
      "combustible_despachos",
      Number(v.body.id),
      "cantidad, costo_unitario, costo_origen"
    );
    expect(Number(despues.cantidad)).toBe(25);
    // 3.00 × 20 / 25 = 2.40 por litro: S/ 60 el balde, igual que antes.
    expect(Number(despues.costo_unitario)).toBe(2.4);
    expect(despues.costo_origen).toBe("declarado");

    const regla = await withTenant(tenantId, (c) =>
      c.query<{ regla: string }>(
        `SELECT regla FROM combustible_urea_correccion_filas
          WHERE tenant_id = $1 AND tabla = 'vale' AND fila_id = $2`,
        [tenantId, v.body.id]
      )
    );
    expect(regla.rows.map((x) => x.regla)).toContain("inferido_declarado");
    // El precio por balde deducido queda guardado en el renglón: la próxima
    // corrección ya no tiene que adivinar.
    const renglon = await withTenant(tenantId, (c) =>
      c.query<{ costo_por_bulto: string }>(
        `SELECT costo_por_bulto FROM combustible_despacho_urea_lineas WHERE despacho_id = $1`,
        [v.body.id]
      )
    );
    expect(Number(renglon.rows[0].costo_por_bulto)).toBe(60);
  });

  it("más de dos decimales es 400: el catálogo guarda dos y la fila no cuadraría", async () => {
    const r = await vistaPrevia(encargado, cajaId, { litros: 3.785 });
    expect(r.status).toBe(400);
  });

  it("un perfil Lectura NO corrige aunque le marquen el check por error", async () => {
    const email = `lectura-${idUnico("u")}@test.local`;
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre: "Gerencia", email, password, rol: "lectura" });
    expect(alta.status).toBe(201);
    const actuales = await admin.get(`/api/erp/usuarios/${alta.body.id}/permisos`);
    const cuerpo = {
      modulos: actuales.body.modulos.map(
        (m: { modulo: string; asignado: boolean; nivel: string }) => ({
          modulo: m.modulo,
          asignado: m.asignado,
          nivel: m.nivel,
        })
      ),
      pestanas: [{ modulo: "combustible", pestana: "urea:corregir_litros", permitido: true }],
      motivo: "prueba: check marcado por error",
    };
    expect(
      (await admin.put(`/api/erp/usuarios/${alta.body.id}/permisos`).send(cuerpo)).status
    ).toBe(200);
    const lectura = request.agent(app);
    expect(
      (await lectura.post("/api/auth/login").send({ tenantSlug: slug, email, password })).status
    ).toBe(200);
    expect((await vistaPrevia(lectura, cajaId, { litros: 24 })).status).toBe(403);
    expect((await corregir(lectura, cajaId, { litros: 24, motivo: "x" })).status).toBe(403);
  });

  it("el conteo nuevo guarda su detalle por envase", async () => {
    const r = await withTenant(tenantId, (c) =>
      c.query<{ presentacion: string; cantidad_bultos: number; litros: string }>(
        `SELECT presentacion, cantidad_bultos, litros FROM combustible_conteo_urea_lineas
          WHERE tenant_id = $1 AND conteo_id = $2 ORDER BY presentacion`,
        [tenantId, conteo]
      )
    );
    expect(r.rows.map((x) => [x.presentacion, x.cantidad_bultos, Number(x.litros)])).toEqual([
      ["bolsa", 8, 32],
      ["caja", 17, 340],
    ]);
  });
});
