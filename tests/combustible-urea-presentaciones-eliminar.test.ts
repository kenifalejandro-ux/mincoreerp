/** tests/combustible-urea-presentaciones-eliminar.test.ts
 *
 * Eliminar un envase de urea que NUNCA se usó (DELETE /urea/presentaciones/:id).
 * Con uso se da de baja (PUT activa=false, ya existía). Ver el diseño en
 * docs/architecture/urea-industrial.md.
 *
 * Lo que estos tests defienden, en orden de importancia:
 *
 *   1. UN ENVASE CON USO NO SE ELIMINA (409), venga el uso de la tabla que
 *      venga: vale, entrada, conteo, precio del catálogo o corrección de
 *      litros. Las siete claves foráneas del catálogo son la red de
 *      seguridad, pero el service tiene que decirlo con 409 antes de que un
 *      DELETE explote. Si este test se cae, se está borrando historial.
 *   2. El envase principal no se elimina ni se da de baja (409).
 *   3. El motivo es obligatorio; la bitácora guarda la FOTO del envase
 *      (la fila desaparece) y quién lo hizo.
 *   4. Eliminar a la vez que entra un movimiento: nunca un 500 ni un
 *      movimiento huérfano. O entra el movimiento y el envase queda, o se
 *      elimina y el movimiento se rechaza.
 *   5. Aislamiento entre empresas y permisos (solo admin).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";

interface PresentacionApi {
  id: number;
  codigo: string;
  nombre: string;
  litros: string;
  es_referencia: boolean;
  activa: boolean;
  movimientos: number;
  usos: number;
}

const BASE = "/api/erp/combustible/urea/presentaciones";

describe("combustible: eliminar un envase de urea sin uso", () => {
  let tenantId: string;
  let tenantSlug: string;
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);

  let equipoId: number;
  let grifoUrea: number;
  let nVale = 1;
  const serie = `E${Math.floor(Math.random() * 1e8).toString(36)}`;

  const listar = async (cli = agente): Promise<PresentacionApi[]> => {
    const res = await cli.get(BASE);
    expect(res.status).toBe(200);
    return res.body;
  };
  const buscar = async (codigo: string) => (await listar()).find((p) => p.codigo === codigo);

  /** Un envase nuevo, sin ningún uso. */
  const envaseNuevo = async (codigo: string, litros = 10) => {
    const alta = await agente
      .post(BASE)
      .send({ codigo, nombre: `Envase ${codigo}`, litros, es_referencia: false });
    expect(alta.status, JSON.stringify(alta.body)).toBe(201);
    return (await buscar(codigo))!;
  };

  const eliminar = (id: number, cuerpo: Record<string, unknown> = { motivo: "alta equivocada" }) =>
    agente.delete(`${BASE}/${id}`).send(cuerpo);

  const entrada = (presentacion: string, bultos = 1) =>
    agente.post("/api/erp/combustible/recepciones").send({
      cliente_uuid: crypto.randomUUID(),
      producto: "urea",
      grifo_id: grifoUrea,
      presentacion,
      cantidad_bultos: bultos,
      costo_unitario: 20,
      recibido_en: new Date().toISOString(),
    });

  const vale = (presentacion: string, bultos = 1) =>
    agente.post("/api/erp/combustible/despachos").send({
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
      despachado_en: new Date().toISOString(),
    });

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    tenantSlug = creado.tenant.slug;
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug, email: creado.usuario.email, password });

    const equipo = await agente
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("VE"), tipo: "VOLQUETE" });
    equipoId = equipo.body.id;

    const grifo = await agente.post("/api/erp/combustible/grifos").send({
      nombre: idUnico("UREAELIM"),
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

  // ── Eliminar lo que nunca se usó ──────────────────────────────────────

  it("un envase sin uso se elimina, desaparece de la lista y su código queda libre", async () => {
    const tambor = await envaseNuevo("tambor", 50);
    expect(tambor.usos).toBe(0);

    const res = await eliminar(tambor.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    expect(await buscar("tambor")).toBeUndefined();

    // El código quedó libre: se puede volver a dar de alta.
    const otraVez = await agente
      .post(BASE)
      .send({ codigo: "tambor", nombre: "Tambor", litros: 55, es_referencia: false });
    expect(otraVez.status).toBe(201);
  });

  it("la bitácora guarda la foto del envase, el motivo y quién lo eliminó", async () => {
    const galon = await envaseNuevo("galon", 3.78);
    expect((await eliminar(galon.id, { motivo: "lo di de alta por error" })).status).toBe(200);

    const log = await withTenant(tenantId, (c) =>
      c.query<{ detalle: Record<string, unknown>; usuario_id: string | null }>(
        `SELECT detalle, usuario_id FROM platform_audit_log
          WHERE tenant_id = $1 AND accion = 'combustible.urea_presentacion_eliminar'
          ORDER BY id DESC LIMIT 1`,
        [tenantId]
      )
    );
    expect(log.rowCount).toBe(1);
    expect(log.rows[0].detalle.codigo).toBe("galon");
    expect(log.rows[0].detalle.nombre).toBe("Envase galon");
    expect(Number(log.rows[0].detalle.litros)).toBe(3.78);
    expect(log.rows[0].detalle.motivo).toBe("lo di de alta por error");
    expect(log.rows[0].usuario_id).toBeTruthy();
  });

  it("sin motivo es 400 y el envase sigue ahí", async () => {
    const lata = await envaseNuevo("lata");
    for (const cuerpo of [{}, { motivo: "" }, { motivo: "   " }]) {
      const res = await eliminar(lata.id, cuerpo);
      expect(res.status).toBe(400);
    }
    expect(await buscar("lata")).toBeDefined();
  });

  it("un envase que no existe es 404", async () => {
    expect((await eliminar(99999999)).status).toBe(404);
  });

  // ── El principal ──────────────────────────────────────────────────────

  it("el envase principal no se elimina ni se da de baja (409): primero hay que elegir otro", async () => {
    const caja = (await buscar("caja"))!;
    expect(caja.es_referencia).toBe(true);

    const borrar = await eliminar(caja.id);
    expect(borrar.status).toBe(409);
    expect(borrar.body.error).toMatch(/principal/i);

    const baja = await agente.put(`${BASE}/${caja.id}`).send({
      nombre: caja.nombre,
      litros: Number(caja.litros),
      es_referencia: true,
      activa: false,
      motivo: "no debería poder",
    });
    expect(baja.status).toBe(409);
    expect(baja.body.error).toMatch(/principal/i);

    const despues = (await buscar("caja"))!;
    expect(despues.activa).toBe(true);
  });

  it("cuando otro envase pasa a ser el principal, el anterior ya se puede dar de baja", async () => {
    const frasco = await envaseNuevo("frasco", 5);
    const caja = (await buscar("caja"))!;

    const nuevoPrincipal = await agente.put(`${BASE}/${frasco.id}`).send({
      nombre: frasco.nombre,
      litros: Number(frasco.litros),
      es_referencia: true,
      activa: true,
    });
    expect(nuevoPrincipal.status).toBe(200);

    const baja = await agente.put(`${BASE}/${caja.id}`).send({
      nombre: caja.nombre,
      litros: Number(caja.litros),
      es_referencia: false,
      activa: false,
      motivo: "ya no es el principal",
    });
    expect(baja.status, JSON.stringify(baja.body)).toBe(200);

    // Se deja todo como estaba para los demás casos.
    const cajaBaja = (await buscar("caja"))!;
    await agente.put(`${BASE}/${cajaBaja.id}`).send({
      nombre: cajaBaja.nombre,
      litros: Number(cajaBaja.litros),
      es_referencia: true,
      activa: true,
    });
    const frascoAhora = (await buscar("frasco"))!;
    await agente.put(`${BASE}/${frascoAhora.id}`).send({
      nombre: frascoAhora.nombre,
      litros: Number(frascoAhora.litros),
      es_referencia: false,
      activa: true,
    });
    expect((await buscar("caja"))!.es_referencia).toBe(true);
  });

  // ── 1. Con uso no se elimina, venga de la tabla que venga ─────────────

  describe("un envase con uso NO se elimina (409), usado en…", () => {
    const comprobar = async (codigo: string) => {
      const envase = (await buscar(codigo))!;
      expect(envase.usos, "la lista tiene que contar el uso").toBeGreaterThan(0);

      const res = await eliminar(envase.id);
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.error).toMatch(/baja/i);
      expect(await buscar(codigo), "el envase no puede desaparecer").toBeDefined();
    };

    it("una entrada", async () => {
      await envaseNuevo("conentrada");
      expect((await entrada("conentrada")).status).toBe(201);
      await comprobar("conentrada");
    });

    it("un vale del almacén", async () => {
      await envaseNuevo("convale");
      const res = await vale("convale");
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      await comprobar("convale");
    });

    it("un conteo físico", async () => {
      await envaseNuevo("conconteo");
      const res = await agente.post("/api/erp/combustible/urea/conteos").send({
        cliente_uuid: crypto.randomUUID(),
        lineas: [{ presentacion: "conconteo", cantidad_bultos: 1 }],
        contado_en: new Date().toISOString(),
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      await comprobar("conconteo");
    });

    it("un precio del catálogo del proveedor (aunque no mueva el stock)", async () => {
      await envaseNuevo("conprecio");
      const grifoRuta = await agente.post("/api/erp/combustible/grifos").send({
        nombre: idUnico("UREAPRECIO"),
        abastece_ruta: true,
        abastece_tanque: false,
        abastece_urea: true,
      });
      const res = await agente.post("/api/erp/combustible/urea/precios").send({
        grifo_id: grifoRuta.body.id,
        presentacion: "conprecio",
        marca: "Green 32",
        precio_por_bulto: 40,
        vigente_desde: new Date(Date.now() - 86400000).toISOString(),
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      await comprobar("conprecio");
    });

    it("una corrección de litros", async () => {
      await envaseNuevo("concorreccion");
      await withTenant(tenantId, (c) =>
        c.query(
          `INSERT INTO combustible_urea_correcciones
             (tenant_id, presentacion, litros_antes, litros_despues, motivo, resumen)
           VALUES ($1, 'concorreccion', 16, 20, 'prueba', '{}'::jsonb)`,
          [tenantId]
        )
      );
      await comprobar("concorreccion");
    });

    it("y al darlo de baja sigue sin poder eliminarse (la baja no borra el uso)", async () => {
      const envase = (await buscar("conentrada"))!;
      const baja = await agente.put(`${BASE}/${envase.id}`).send({
        nombre: envase.nombre,
        litros: Number(envase.litros),
        es_referencia: false,
        activa: false,
        motivo: "ya no se compra",
      });
      // Tiene una unidad en el almacén: la baja la rechaza (409). Lo que
      // importa aquí es que NUNCA se pueda eliminar.
      expect([200, 409]).toContain(baja.status);
      expect((await eliminar(envase.id)).status).toBe(409);
      expect(await buscar("conentrada")).toBeDefined();
    });
  });

  it("la lista dice cuántos usos tiene cada envase (los de siembra, sin uso, en cero)", async () => {
    const filas = await listar();
    const bolsa = filas.find((p) => p.codigo === "bolsa")!;
    expect(bolsa.usos).toBe(0);
    const conVale = filas.find((p) => p.codigo === "convale")!;
    expect(conVale.usos).toBeGreaterThan(0);
  });

  // ── 4. Eliminar a la vez que entra un movimiento ──────────────────────

  it("eliminar a la vez que entra una entrada: nunca un 500 ni una entrada huérfana", async () => {
    const codigos = ["carrera1", "carrera2", "carrera3", "carrera4", "carrera5", "carrera6"];
    const envases = [];
    for (const codigo of codigos) envases.push(await envaseNuevo(codigo));

    const resultados = await Promise.all(
      envases.map(async (e) => {
        const [ent, del] = await Promise.all([entrada(e.codigo), eliminar(e.id)]);
        return { codigo: e.codigo, ent: ent.status, del: del.status };
      })
    );

    for (const r of resultados) {
      expect(r.ent, `entrada ${r.codigo}`).not.toBe(500);
      expect(r.del, `eliminar ${r.codigo}`).not.toBe(500);

      const sigue = (await buscar(r.codigo)) !== undefined;
      const huerfanas = await withTenant(tenantId, (c) =>
        c.query(
          `SELECT count(*)::int AS n FROM combustible_recepcion_urea_lineas
            WHERE tenant_id = $1 AND presentacion = $2`,
          [tenantId, r.codigo]
        )
      );
      const lineas = huerfanas.rows[0].n as number;

      if (r.ent === 201) {
        // Entró primero: el envase tiene que seguir y el DELETE decir 409.
        expect(r.del, `${r.codigo}: entró la entrada, no se podía eliminar`).toBe(409);
        expect(sigue).toBe(true);
        expect(lineas).toBe(1);
      } else {
        // Se eliminó primero: la entrada se rechazó y no dejó rastro.
        expect(r.del, `${r.codigo}: se eliminó, la entrada fue rechazada`).toBe(200);
        expect(sigue).toBe(false);
        expect(lineas).toBe(0);
      }
    }
  });

  // ── 5. Permisos y aislamiento ─────────────────────────────────────────

  it("un operador no puede eliminar envases (403)", async () => {
    const email = `operador-${idUnico("u")}@test.local`;
    const alta = await agente
      .post("/api/erp/usuarios")
      .send({ nombre: "Operador", email, password, rol: "operador" });
    expect(alta.status).toBe(201);
    const operador = request.agent(app);
    const sesion = await operador.post("/api/auth/login").send({ tenantSlug, email, password });
    expect(sesion.status).toBe(200);

    const envase = await envaseNuevo("protegido");
    const res = await operador.delete(`${BASE}/${envase.id}`).send({ motivo: "no debería" });
    expect(res.status).toBe(403);
    expect(await buscar("protegido")).toBeDefined();
  });

  it("una empresa no puede eliminar el envase de otra (404): la lectura no lo ve", async () => {
    const otro = await crearTenantDePrueba(password);
    try {
      const ajeno = request.agent(app);
      await ajeno.post("/api/auth/login").send({
        tenantSlug: otro.tenant.slug,
        email: otro.usuario.email,
        password,
      });

      const mio = await envaseNuevo("solomio");
      const res = await ajeno.delete(`${BASE}/${mio.id}`).send({ motivo: "intento ajeno" });
      expect(res.status).toBe(404);
      expect(await buscar("solomio")).toBeDefined();
    } finally {
      await borrarTenantDePrueba(otro.tenant.id);
    }
  });
});
