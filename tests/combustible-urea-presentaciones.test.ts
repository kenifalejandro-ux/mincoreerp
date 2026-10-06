/** tests/combustible-urea-presentaciones.test.ts
 *
 * El catálogo de envases de urea (migración 0116): los litros por bulto
 * dejaron de ser una constante del código y los edita la empresa. Ver
 * docs/architecture/urea-industrial.md (decisión 3).
 *
 * Lo que estos tests defienden, en orden de importancia:
 *
 *   1. CAMBIAR EL FACTOR NO REINTERPRETA EL HISTORIAL. Es la razón de ser de
 *      `factor_litros` en cada fila (0092) y el único motivo por el que esta
 *      pantalla se puede dar a un cliente sin romper el módulo anti-fraude.
 *      Si este test se cae, el cambio está mal hecho, no el test.
 *   2. Y sí mueve los movimientos NUEVOS -- si no, la pantalla no sirve.
 *   3. El motivo es obligatorio: sin él no se puede distinguir después
 *      "corregimos el envase" de "alguien movió el número antes del conteo".
 *   4. El código no se puede cambiar: es la mitad de la FK compuesta.
 *   5. Un envase desactivado no se puede usar para cargar, pero su historial
 *      se sigue leyendo.
 *   6. Aislamiento entre empresas (la FK compuesta lleva el tenant adentro).
 *   7. Solo admin configura.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";

function serieUnica(): string {
  return `P${Math.floor(Math.random() * 1e8).toString(36)}`;
}

interface PresentacionApi {
  id: number;
  codigo: string;
  nombre: string;
  litros: string;
  es_referencia: boolean;
  activa: boolean;
}

describe("combustible: catálogo de presentaciones de urea (migración 0116)", () => {
  let tenantId: string;
  let tenantSlug: string;
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);

  let equipoId: number;
  let grifoUrea: number;

  const listar = async (): Promise<PresentacionApi[]> => {
    const res = await agente.get("/api/erp/combustible/urea/presentaciones");
    expect(res.status).toBe(200);
    return res.body;
  };

  const porCodigo = async (codigo: string) => {
    const filas = await listar();
    const fila = filas.find((p) => p.codigo === codigo);
    if (!fila) throw new Error(`no existe la presentación ${codigo} en este tenant`);
    return fila;
  };

  /** El PUT es un reemplazo completo (mismo criterio que el resto del
   *  módulo): hay que mandar todos los campos editables, no solo el que
   *  cambia. Este helper los arma desde la fila vigente. */
  const editar = (fila: PresentacionApi, cambios: Record<string, unknown>) =>
    agente.put(`/api/erp/combustible/urea/presentaciones/${fila.id}`).send({
      nombre: fila.nombre,
      litros: Number(fila.litros),
      es_referencia: fila.es_referencia,
      activa: fila.activa,
      ...cambios,
    });

  function payloadUrea(overrides: Record<string, unknown> = {}) {
    return {
      producto: "urea",
      origen: "compra_externa",
      grifo_id: grifoUrea,
      tipo_destino: "equipo",
      equipo_id: equipoId,
      serie_talonario: serieUnica(),
      n_vale: 1,
      presentacion: "caja",
      cantidad_bultos: 2,
      despachado_en: new Date().toISOString(),
      ...overrides,
    };
  }

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    tenantSlug = creado.tenant.slug;
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug, email: creado.usuario.email, password });

    const equipo = await agente
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("VQ"), tipo: "VOLQUETE" });
    equipoId = equipo.body.id;

    const grifo = await agente.post("/api/erp/combustible/grifos").send({
      nombre: idUnico("UREAPROV"),
      abastece_ruta: false,
      abastece_tanque: false,
      abastece_urea: true,
    });
    grifoUrea = grifo.body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  // ── La siembra ────────────────────────────────────────────────────────

  it("una empresa nueva nace con bolsa/caja/balde y la caja como unidad de referencia", async () => {
    const filas = await listar();
    const porCod = Object.fromEntries(filas.map((p) => [p.codigo, p]));

    // Los valores VIGENTES, no los nuevos: corregir el 16 es una decisión
    // del cliente con su motivo, no un efecto colateral del deploy.
    expect(Number(porCod.bolsa.litros)).toBe(4);
    expect(Number(porCod.caja.litros)).toBe(16);
    expect(Number(porCod.balde.litros)).toBe(20);
    expect(filas.every((p) => p.activa)).toBe(true);

    // Una sola referencia, y es la caja (es en lo que el cliente compra).
    expect(filas.filter((p) => p.es_referencia).map((p) => p.codigo)).toEqual(["caja"]);
  });

  // ── 1 y 2: el histórico no se mueve, lo nuevo sí ──────────────────────

  it("cambiar la caja de 16 a 20 L NO toca el vale ya cargado, y sí el siguiente", async () => {
    const antes = await agente
      .post("/api/erp/combustible/despachos")
      .send(payloadUrea({ n_vale: 1 }));
    expect(antes.status).toBe(201);
    expect(Number(antes.body.factor_litros)).toBe(16);
    expect(Number(antes.body.cantidad)).toBe(32);

    const caja = await porCodigo("caja");
    const cambio = await editar(caja, {
      litros: 20,
      motivo: "El proveedor cambió la caja: 5 bolsas de 4 L en vez de 4",
    });
    expect(cambio.status).toBe(200);
    expect(Number(cambio.body.litros)).toBe(20);

    // El vale viejo, releído de la base: intacto. Esto es lo que hace que
    // la pantalla sea segura -- el factor está CONGELADO en la fila.
    const releido = await withTenant(tenantId, (c) =>
      c.query(`SELECT factor_litros, cantidad FROM combustible_despachos WHERE id = $1`, [
        antes.body.id,
      ])
    );
    expect(Number(releido.rows[0].factor_litros)).toBe(16);
    expect(Number(releido.rows[0].cantidad)).toBe(32);

    // Y el siguiente ya usa el factor nuevo.
    const despues = await agente
      .post("/api/erp/combustible/despachos")
      .send(payloadUrea({ n_vale: 2 }));
    expect(despues.status).toBe(201);
    expect(Number(despues.body.factor_litros)).toBe(20);
    expect(Number(despues.body.cantidad)).toBe(40);

    // Vuelta atrás para no condicionar los tests de abajo.
    await editar(await porCodigo("caja"), { litros: 16, motivo: "revertir: fin del test" });
  });

  it("el cambio de factor queda en auditoría con los dos valores y el motivo", async () => {
    const caja = await porCodigo("caja");
    const res = await editar(caja, { litros: 18, motivo: "pesaje del lote de agosto" });
    expect(res.status).toBe(200);

    const log = await withTenant(tenantId, (c) =>
      c.query<{ detalle: Record<string, unknown> }>(
        `SELECT detalle FROM platform_audit_log
          WHERE tenant_id = $1 AND accion = 'combustible.urea_presentacion_factor_cambiado'
          ORDER BY id DESC LIMIT 1`,
        [tenantId]
      )
    );
    expect(log.rowCount).toBe(1);
    expect(log.rows[0].detalle.litrosDe).toBe(16);
    expect(log.rows[0].detalle.litrosA).toBe(18);
    expect(log.rows[0].detalle.motivo).toContain("pesaje");
    // Cuántos movimientos quedaron con el factor viejo: es el dato que
    // distingue "lo corregimos antes de usarlo" de "lo movimos con 300
    // vales cargados encima".
    expect(Number(log.rows[0].detalle.movimientosConElFactorViejo)).toBeGreaterThan(0);

    await editar(await porCodigo("caja"), { litros: 16, motivo: "revertir: fin del test" });
  });

  it("una edición que NO mueve los litros se audita como edición común, no como cambio de factor", async () => {
    const balde = await porCodigo("balde");
    const res = await editar(balde, { nombre: "Balde grande", motivo: "así lo llaman en almacén" });
    expect(res.status).toBe(200);

    const log = await withTenant(tenantId, (c) =>
      c.query(
        `SELECT accion FROM platform_audit_log
          WHERE tenant_id = $1 AND accion LIKE 'combustible.urea_presentacion%'
          ORDER BY id DESC LIMIT 1`,
        [tenantId]
      )
    );
    expect(log.rows[0].accion).toBe("combustible.urea_presentacion_actualizar");
  });

  // ── 3: el motivo ──────────────────────────────────────────────────────

  it("editar sin motivo es 400", async () => {
    const caja = await porCodigo("caja");
    const res = await agente.put(`/api/erp/combustible/urea/presentaciones/${caja.id}`).send({
      nombre: caja.nombre,
      litros: 20,
      es_referencia: caja.es_referencia,
      activa: caja.activa,
    });
    expect(res.status).toBe(400);

    // Y no cambió nada.
    expect(Number((await porCodigo("caja")).litros)).toBe(16);
  });

  // ── 4: el código es inmutable ─────────────────────────────────────────

  it("el PUT no puede renombrar el código: es la mitad de la clave foránea", async () => {
    const caja = await porCodigo("caja");
    const res = await editar(caja, { codigo: "cajota", motivo: "intento de renombre" });
    expect(res.status).toBe(200);
    expect(res.body.codigo).toBe("caja");
    // Y el historial sigue encontrando su envase.
    expect((await listar()).some((p) => p.codigo === "cajota")).toBe(false);
  });

  // ── 5: desactivar no borra ────────────────────────────────────────────

  it("una presentación desactivada no sirve para cargar, pero su historial se sigue leyendo", async () => {
    const valeViejo = await agente
      .post("/api/erp/combustible/despachos")
      .send(payloadUrea({ presentacion: "bolsa", cantidad_bultos: 4, n_vale: 10 }));
    expect(valeViejo.status).toBe(201);

    const bolsa = await porCodigo("bolsa");
    const baja = await editar(bolsa, {
      activa: false,
      motivo: "el proveedor ya no vende bolsas suelta",
    });
    expect(baja.status).toBe(200);
    expect(baja.body.activa).toBe(false);

    const intento = await agente
      .post("/api/erp/combustible/despachos")
      .send(payloadUrea({ presentacion: "bolsa", cantidad_bultos: 1, n_vale: 11 }));
    expect(intento.status).toBe(400);
    expect(intento.body.error).toMatch(/desactivada/i);

    // El vale de antes sigue existiendo y legible, con su factor.
    const listado = await agente
      .get("/api/erp/combustible/despachos")
      .query({ producto: "urea", pageSize: "200" });
    const fila = listado.body.data.find((d: { id: number }) => d.id === valeViejo.body.id);
    expect(fila).toBeTruthy();
    expect(Number(fila.factor_litros)).toBe(4);

    await editar(await porCodigo("bolsa"), { activa: true, motivo: "revertir: fin del test" });
  });

  it("una presentación que no existe en esta empresa es 400, no un 500", async () => {
    const res = await agente
      .post("/api/erp/combustible/despachos")
      .send(payloadUrea({ presentacion: "bidon", n_vale: 20 }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no existe/i);
  });

  // ── Alta ──────────────────────────────────────────────────────────────

  it("dar de alta un envase propio y usarlo en un vale, sin migración ni deploy", async () => {
    const alta = await agente.post("/api/erp/combustible/urea/presentaciones").send({
      codigo: "bidon",
      nombre: "Bidón",
      litros: 10,
      es_referencia: false,
    });
    expect(alta.status).toBe(201);

    const vale = await agente
      .post("/api/erp/combustible/despachos")
      .send(payloadUrea({ presentacion: "bidon", cantidad_bultos: 3, n_vale: 30 }));
    expect(vale.status).toBe(201);
    expect(Number(vale.body.factor_litros)).toBe(10);
    expect(Number(vale.body.cantidad)).toBe(30);
  });

  it("repetir un código es 409, no un 500", async () => {
    const res = await agente
      .post("/api/erp/combustible/urea/presentaciones")
      .send({ codigo: "caja", nombre: "Caja bis", litros: 20 });
    expect(res.status).toBe(409);
  });

  it("marcar otra unidad de referencia desmarca la anterior -- nunca dos", async () => {
    const balde = await porCodigo("balde");
    const res = await editar(balde, {
      es_referencia: true,
      motivo: "ahora compramos por balde",
    });
    expect(res.status).toBe(200);

    const referencias = (await listar()).filter((p) => p.es_referencia).map((p) => p.codigo);
    expect(referencias).toEqual(["balde"]);

    await editar(await porCodigo("caja"), {
      es_referencia: true,
      motivo: "revertir: fin del test",
    });
    expect((await listar()).filter((p) => p.es_referencia).map((p) => p.codigo)).toEqual(["caja"]);
  });

  // ── Validación de los números ─────────────────────────────────────────

  it("un envase de 2.001 L o de 0 L es 400 -- un dedo de más multiplica el stock", async () => {
    const enorme = await agente
      .post("/api/erp/combustible/urea/presentaciones")
      .send({ codigo: "ibc_gigante", nombre: "IBC", litros: 2001 });
    expect(enorme.status).toBe(400);

    const cero = await agente
      .post("/api/erp/combustible/urea/presentaciones")
      .send({ codigo: "vacio", nombre: "Vacío", litros: 0 });
    expect(cero.status).toBe(400);
  });

  it("un código con mayúsculas o espacios es 400", async () => {
    const res = await agente
      .post("/api/erp/combustible/urea/presentaciones")
      .send({ codigo: "Caja Grande", nombre: "Caja grande", litros: 24 });
    expect(res.status).toBe(400);
  });

  // ── 7: solo admin configura ───────────────────────────────────────────

  it("un operador no puede crear ni editar envases (403), aunque vea la pestaña", async () => {
    const email = `op-presentaciones-${tenantSlug}@test.local`;
    const alta = await agente
      .post("/api/erp/usuarios")
      .send({ nombre: "Operador", email, password, rol: "operador" });
    expect(alta.status).toBe(201);

    const operador = request.agent(app);
    const sesion = await operador.post("/api/auth/login").send({ tenantSlug, email, password });
    expect(sesion.status).toBe(200);

    // Leer sí: los formularios de carga necesitan el desplegable.
    const lectura = await operador.get("/api/erp/combustible/urea/presentaciones");
    expect(lectura.status).toBe(200);

    const creando = await operador
      .post("/api/erp/combustible/urea/presentaciones")
      .send({ codigo: "clandestino", nombre: "Clandestino", litros: 5 });
    expect(creando.status).toBe(403);

    const caja = await porCodigo("caja");
    const editando = await operador
      .put(`/api/erp/combustible/urea/presentaciones/${caja.id}`)
      .send({
        nombre: caja.nombre,
        litros: 99,
        es_referencia: caja.es_referencia,
        activa: caja.activa,
        motivo: "no debería poder",
      });
    expect(editando.status).toBe(403);

    expect(Number((await porCodigo("caja")).litros)).toBe(16);
  });

  // ── 6: aislamiento entre empresas ─────────────────────────────────────

  it("el catálogo de una empresa es invisible e inmutable para otra", async () => {
    const otro = await crearTenantDePrueba(password);
    const agenteOtro = request.agent(app);
    await agenteOtro
      .post("/api/auth/login")
      .send({ tenantSlug: otro.tenant.slug, email: otro.usuario.email, password });

    try {
      // La otra empresa tiene su propio catálogo sembrado, con sus propios
      // ids -- no los de acá.
      const suyas = await agenteOtro.get("/api/erp/combustible/urea/presentaciones");
      expect(suyas.status).toBe(200);
      const mios = (await listar()).map((p) => p.id);
      expect(
        suyas.body.map((p: PresentacionApi) => p.id).some((id: number) => mios.includes(id))
      ).toBe(false);

      // Y el id de la caja de ESTA empresa no es editable desde allá: la
      // consulta del UPDATE lleva el tenant, así que no encuentra la fila.
      const caja = await porCodigo("caja");
      const intento = await agenteOtro
        .put(`/api/erp/combustible/urea/presentaciones/${caja.id}`)
        .send({
          nombre: "Caja ajena",
          litros: 500,
          es_referencia: true,
          activa: true,
          motivo: "intento cruzado",
        });
      expect(intento.status).toBe(404);

      expect(Number((await porCodigo("caja")).litros)).toBe(16);
      expect((await porCodigo("caja")).nombre).not.toBe("Caja ajena");
    } finally {
      await borrarTenantDePrueba(otro.tenant.id);
    }
  });
});
