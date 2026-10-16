/** tests/combustible-urea-presentaciones.test.ts
 *
 * El catálogo de envases de urea (migración 0116): los litros por bulto
 * dejaron de ser una constante del código y los edita la empresa. Ver
 * docs/architecture/urea-industrial.md (decisión 3).
 *
 * Lo que estos tests defienden, en orden de importancia:
 *
 *   1. LOS LITROS DE UN ENVASE CON MOVIMIENTOS NO SE CAMBIAN (409). Cada
 *      movimiento congeló sus litros (`factor_litros`, 0092): cambiarlos no
 *      corregiría el pasado, lo dejaría mezclado, y contar bultos daría un
 *      sobrante o faltante falso. Un envase de otro tamaño es OTRO envase.
 *      Si este test se cae, el cambio está mal hecho, no el test.
 *   2. Un envase SIN uso sí cambia de litros, con motivo y en auditoría.
 *   3. El motivo es obligatorio para cambiar litros o desactivar: sin él no
 *      se puede distinguir después "corregimos el envase" de "alguien movió
 *      el número antes del conteo". Renombrar no lo pide.
 *   3b. Un envase con stock en el almacén no se desactiva (409).
 *   4. El código no se puede cambiar: es la mitad de la FK compuesta.
 *   5. Un envase desactivado no se puede usar para cargar, pero su historial
 *      se sigue leyendo.
 *   6. Aislamiento entre empresas (la FK compuesta lleva el tenant adentro).
 *   7. Solo admin configura.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, pool, withTenant } from "../src/server/config/database";

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
  movimientos?: number;
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
      abastece_urea_ruta: true,
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

  /** Un envase nuevo, sin movimientos: el único al que se le pueden cambiar
   *  los litros. */
  const envaseSinUso = async (codigo: string, litros: number) => {
    const alta = await agente
      .post("/api/erp/combustible/urea/presentaciones")
      .send({ codigo, nombre: codigo, litros, es_referencia: false });
    expect(alta.status).toBe(201);
    return porCodigo(codigo);
  };

  it("un envase con movimientos NO cambia de litros (409) y no toca nada", async () => {
    const vale = await agente
      .post("/api/erp/combustible/despachos")
      .send(payloadUrea({ n_vale: 1 }));
    expect(vale.status).toBe(201);
    expect(Number(vale.body.renglones[0].factor_litros)).toBe(16);

    // Si se dejara, la caja quedaría mezclada: 16 L en el historial, 20 L en
    // el catálogo, y contar cajas daría un sobrante falso.
    const cambio = await editar(await porCodigo("caja"), {
      litros: 20,
      motivo: "el proveedor cambió la caja",
    });
    expect(cambio.status).toBe(409);
    expect(cambio.body.error).toMatch(/otro envase/i);

    expect(Number((await porCodigo("caja")).litros)).toBe(16);
    const releido = await withTenant(tenantId, (c) =>
      c.query(
        `SELECT l.factor_litros, d.cantidad
           FROM combustible_despachos d
           JOIN combustible_despacho_urea_lineas l ON l.despacho_id = d.id
          WHERE d.id = $1`,
        [vale.body.id]
      )
    );
    expect(Number(releido.rows[0].factor_litros)).toBe(16);
    expect(Number(releido.rows[0].cantidad)).toBe(32);

    // El listado avisa cuántos movimientos tiene, para que la pantalla no
    // ofrezca el cambio.
    expect(Number((await porCodigo("caja")).movimientos)).toBeGreaterThan(0);
  });

  it("si la caja cambió de tamaño, es OTRO envase: se da de alta y convive con la vieja", async () => {
    const alta = await agente
      .post("/api/erp/combustible/urea/presentaciones")
      .send({ codigo: "caja20", nombre: "Caja 20 L", litros: 20, es_referencia: false });
    expect(alta.status).toBe(201);
    const vale = await agente
      .post("/api/erp/combustible/despachos")
      .send(payloadUrea({ presentacion: "caja20", n_vale: 2 }));
    expect(vale.status).toBe(201);
    expect(Number(vale.body.cantidad)).toBe(40);
    expect(Number((await porCodigo("caja")).litros)).toBe(16);
  });

  it("un envase SIN uso sí cambia de litros, con motivo, y queda en auditoría", async () => {
    const lata = await envaseSinUso("lata", 10);
    const res = await editar(lata, { litros: 12, motivo: "se dio de alta con el número mal" });
    expect(res.status).toBe(200);
    expect(Number(res.body.litros)).toBe(12);

    const log = await withTenant(tenantId, (c) =>
      c.query<{ detalle: Record<string, unknown> }>(
        `SELECT detalle FROM platform_audit_log
          WHERE tenant_id = $1 AND accion = 'combustible.urea_presentacion_factor_cambiado'
          ORDER BY id DESC LIMIT 1`,
        [tenantId]
      )
    );
    expect(log.rowCount).toBe(1);
    expect(log.rows[0].detalle.litrosDe).toBe(10);
    expect(log.rows[0].detalle.litrosA).toBe(12);
    expect(log.rows[0].detalle.motivo).toContain("número mal");
    expect(Number(log.rows[0].detalle.movimientosConElFactorViejo)).toBe(0);
  });

  it("cambiar los litros sin motivo es 400, aunque el envase no tenga uso", async () => {
    const tambor = await envaseSinUso("tambor", 50);
    const res = await editar(tambor, { litros: 55 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/motivo/i);
    expect(Number((await porCodigo("tambor")).litros)).toBe(50);
  });

  it("renombrar no pide motivo y se audita como edición común", async () => {
    const res = await editar(await porCodigo("balde"), { nombre: "Balde grande" });
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

  it("un cambio de litros ESPERA al movimiento que está congelando esos litros: no hay carrera", async () => {
    // Un vale y un cambio de litros en el mismo instante: sin bloqueo, el
    // chequeo "no tiene movimientos" y el cambio no son atómicos y el vale
    // se cuela con el factor viejo. El movimiento toma la fila FOR SHARE
    // (resolverFactorPresentacionUrea) y el cambio FOR UPDATE.
    const bidon = await envaseSinUso("bidonx", 10);
    const movimiento = await pool.connect();
    try {
      await movimiento.query("BEGIN");
      await movimiento.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      await movimiento.query(
        `SELECT id FROM combustible_urea_presentaciones
          WHERE tenant_id = $1 AND codigo = 'bidonx' FOR SHARE`,
        [tenantId]
      );

      const cambio = editar(bidon, { litros: 12, motivo: "prueba de bloqueo" }).then((r) => r);
      const primero = await Promise.race([
        cambio.then(() => "terminó"),
        new Promise((r) => setTimeout(() => r("esperando"), 500)),
      ]);
      expect(primero).toBe("esperando");

      await movimiento.query("COMMIT");
      expect((await cambio).status).toBe(200);
    } finally {
      movimiento.release();
    }
  });

  it("desactivar un envase con stock en el almacén es 409: sus unidades quedarían atrapadas", async () => {
    const saco = await envaseSinUso("saco", 5);
    const entrada = await agente.post("/api/erp/combustible/recepciones").send({
      cliente_uuid: crypto.randomUUID(),
      producto: "urea",
      grifo_id: grifoUrea,
      presentacion: "saco",
      cantidad_bultos: 2,
      costo_unitario: 20,
      recibido_en: new Date().toISOString(),
    });
    expect(entrada.status).toBe(201);

    const baja = await editar(saco, { activa: false, motivo: "ya no lo compramos" });
    expect(baja.status).toBe(409);
    expect(baja.body.error).toMatch(/Quedan 2/);
    expect((await porCodigo("saco")).activa).toBe(true);
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
    expect(Number(fila.renglones[0].factor_litros)).toBe(4);

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
    expect(Number(vale.body.renglones[0].factor_litros)).toBe(10);
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
