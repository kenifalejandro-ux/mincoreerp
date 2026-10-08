/** tests/equipos-conductor-ruta-historial.test.ts
 *
 * Conductor y rutas de cada unidad, con historial (migración 0126). Se ataca
 * la API (y la base directo, donde la regla vive en un trigger) para ver que:
 *
 *  - todo cambio de conductor o de rutas pide motivo, y sin él NO cambia nada;
 *  - lo pasado no se reescribe, ni por la API ni por SQL directo;
 *  - una unidad puede tener varias rutas, o ninguna, sin que nadie lo asuma;
 *  - Lectura no puede escribir y otra empresa no ve ni toca nada.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, pool, withTenant } from "../src/server/config/database";
import { estadoDeUnidad, tipoLlevaConductor } from "../src/modules/equipos/equipos.estado";
import { EquiposRepository } from "../src/modules/equipos/equipos.repository";

const password = "ClaveDePrueba123";

describe("equipos: conductor y rutas con historial (0126)", () => {
  const tenants: string[] = [];
  let tenantId: string;
  let slug: string;
  const admin = request.agent(app);
  const ajeno = request.agent(app);
  let lima: number;
  let ica: number;
  let cusco: number;

  const lugar = async (agente: typeof admin, nombre: string) => {
    const r = await agente.post("/api/erp/combustible/lugares").send({ nombre });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return Number(r.body.id);
  };

  const crear = async (extra: Record<string, unknown> = {}) => {
    const r = await admin
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("EQ"), tipo: "Volquete", ...extra });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body;
  };

  /** El PUT reemplaza la ficha entera: se manda la placa y el tipo de siempre. */
  const editar = (e: { id: number; placa_codigo: string }, extra: Record<string, unknown>) =>
    admin
      .put(`/api/erp/equipos/${e.id}`)
      .send({ placa_codigo: e.placa_codigo, tipo: "Volquete", ...extra });

  const historial = async (id: number) =>
    (await admin.get(`/api/erp/equipos/${id}/historial`)).body;

  beforeAll(async () => {
    const a = await crearTenantDePrueba(password);
    tenants.push(a.tenant.id);
    tenantId = a.tenant.id;
    slug = a.tenant.slug;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: slug, email: a.usuario.email, password });

    const b = await crearTenantDePrueba(password);
    tenants.push(b.tenant.id);
    await ajeno
      .post("/api/auth/login")
      .send({ tenantSlug: b.tenant.slug, email: b.usuario.email, password });

    lima = await lugar(admin, idUnico("Lima"));
    ica = await lugar(admin, idUnico("Ica"));
    cusco = await lugar(admin, idUnico("Cusco"));
  });

  afterAll(async () => {
    for (const t of tenants) await borrarTenantDePrueba(t);
    await closeDatabase();
  });

  it("al dar de alta con conductor y dos rutas, el historial arranca con 'Alta del equipo'", async () => {
    const e = await crear({
      conductor_nombre: "Juan Pérez",
      conductor_dni: "40000001",
      rutas: [
        { origen_id: lima, destino_id: ica },
        { origen_id: ica, destino_id: cusco },
      ],
    });
    expect(e.rutas).toHaveLength(2);

    const h = await historial(e.id);
    expect(h.conductores).toHaveLength(1);
    expect(h.conductores[0]).toMatchObject({
      conductor_nombre: "Juan Pérez",
      conductor_dni: "40000001",
      hasta: null,
      motivo: "Alta del equipo",
    });
    expect(h.rutas).toHaveLength(2);
    expect(h.rutas.every((r: { hasta: string | null }) => r.hasta === null)).toBe(true);
  });

  it("cambiar el conductor SIN motivo da 400 y no cambia NADA (ni la ficha ni el historial)", async () => {
    const e = await crear({ conductor_nombre: "Juan Pérez", conductor_dni: "40000001" });
    const res = await editar(e, { conductor_nombre: "Pedro Ruiz", conductor_dni: "40000002" });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/motivo/i);

    const lista = (await admin.get("/api/erp/equipos?pageSize=200")).body.data;
    const ficha = lista.find((x: { id: number }) => x.id === e.id);
    expect(ficha.conductor_nombre).toBe("Juan Pérez");
    expect((await historial(e.id)).conductores).toHaveLength(1);
  });

  it("un motivo en blanco tampoco vale", async () => {
    const e = await crear({ conductor_nombre: "Juan Pérez", conductor_dni: "40000001" });
    const res = await editar(e, {
      conductor_nombre: "Pedro Ruiz",
      conductor_dni: "40000002",
      motivo_cambio: "   ",
    });
    expect(res.status).toBe(400);
  });

  it("con motivo: el conductor anterior queda CERRADO con su motivo y quién lo cerró", async () => {
    const e = await crear({ conductor_nombre: "Juan Pérez", conductor_dni: "40000001" });
    const res = await editar(e, {
      conductor_nombre: "Pedro Ruiz",
      conductor_dni: "40000002",
      motivo_cambio: "Juan pasó a la unidad V-9",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.conductor_nombre).toBe("Pedro Ruiz");

    const h = await historial(e.id);
    expect(h.conductores).toHaveLength(2);
    const [nuevo, viejo] = h.conductores;
    expect(nuevo).toMatchObject({ conductor_dni: "40000002", hasta: null });
    expect(nuevo.motivo).toBe("Juan pasó a la unidad V-9");
    expect(viejo.conductor_dni).toBe("40000001");
    expect(viejo.hasta).not.toBeNull();
    expect(viejo.motivo_cierre).toBe("Juan pasó a la unidad V-9");
    expect(viejo.cerrado_por).toBeTruthy();
  });

  it("guardar sin tocar conductor ni rutas no pide motivo ni toca el historial", async () => {
    const e = await crear({ conductor_nombre: "Juan Pérez", conductor_dni: "40000001" });
    const res = await editar(e, {
      conductor_nombre: "Juan Pérez",
      conductor_dni: "40000001",
      marca: "Volvo",
    });
    expect(res.status).toBe(200);
    expect((await historial(e.id)).conductores).toHaveLength(1);
  });

  it("quitar el conductor (vacío) con motivo cierra la asignación sin abrir otra", async () => {
    const e = await crear({ conductor_nombre: "Juan Pérez", conductor_dni: "40000001" });
    expect((await editar(e, {})).status).toBe(400);
    const res = await editar(e, { motivo_cambio: "Juan renunció" });
    expect(res.status).toBe(200);
    const h = await historial(e.id);
    expect(h.conductores).toHaveLength(1);
    expect(h.conductores[0].hasta).not.toBeNull();
  });

  it("las rutas: omitirlas no las toca; cambiarlas pide motivo; [] las quita todas", async () => {
    const e = await crear({ rutas: [{ origen_id: lima, destino_id: ica }] });

    // Sin hablar de rutas: se conservan.
    expect((await editar(e, { marca: "Scania" })).status).toBe(200);
    expect((await historial(e.id)).rutas).toHaveLength(1);

    // Cambio sin motivo: 400 y nada cambia.
    const sinMotivo = await editar(e, { rutas: [{ origen_id: lima, destino_id: cusco }] });
    expect(sinMotivo.status).toBe(400);
    expect((await historial(e.id)).rutas).toHaveLength(1);

    // Agregar una segunda y conservar la primera: la primera NO se reabre.
    const antes = (await historial(e.id)).rutas[0];
    const dos = await editar(e, {
      rutas: [
        { origen_id: lima, destino_id: ica },
        { origen_id: lima, destino_id: cusco },
      ],
      motivo_cambio: "Se suma el tramo a Cusco",
    });
    expect(dos.status, JSON.stringify(dos.body)).toBe(200);
    expect(dos.body.rutas).toHaveLength(2);
    const h = await historial(e.id);
    expect(h.rutas).toHaveLength(2);
    expect(h.rutas.find((r: { id: string }) => r.id === antes.id).desde).toBe(antes.desde);

    // Quitar todas.
    const ninguna = await editar(e, { rutas: [], motivo_cambio: "La unidad queda sin ruta fija" });
    expect(ninguna.status).toBe(200);
    expect(ninguna.body.rutas).toHaveLength(0);
    const fin = await historial(e.id);
    expect(fin.rutas).toHaveLength(2);
    expect(fin.rutas.every((r: { hasta: string | null }) => r.hasta !== null)).toBe(true);
  });

  it("una unidad puede no tener ninguna ruta: nada se asume", async () => {
    const e = await crear();
    expect(e.rutas).toEqual([]);
    expect((await historial(e.id)).rutas).toEqual([]);
  });

  it("rutas inválidas: origen = destino, lugar inexistente y lugar de OTRA empresa dan 400", async () => {
    const e = await crear();
    const igual = await editar(e, {
      rutas: [{ origen_id: lima, destino_id: lima }],
      motivo_cambio: "x",
    });
    expect(igual.status).toBe(400);

    const inexistente = await editar(e, {
      rutas: [{ origen_id: lima, destino_id: 999999999 }],
      motivo_cambio: "x",
    });
    expect(inexistente.status).toBe(400);

    const lugarAjeno = await lugar(ajeno, idUnico("Tacna"));
    const ajenoRes = await editar(e, {
      rutas: [{ origen_id: lima, destino_id: lugarAjeno }],
      motivo_cambio: "x",
    });
    expect(ajenoRes.status).toBe(400);
    expect((await historial(e.id)).rutas).toHaveLength(0);
  });

  it("un lugar dado de baja no se puede asignar a una ruta nueva", async () => {
    const baja = await lugar(admin, idUnico("Baja"));
    await withTenant(tenantId, (c) =>
      c.query(`UPDATE combustible_lugares SET activo = false WHERE id = $1`, [baja])
    );
    const e = await crear();
    const res = await editar(e, {
      rutas: [{ origen_id: lima, destino_id: baja }],
      motivo_cambio: "x",
    });
    expect(res.status).toBe(400);
  });

  it("LO PASADO NO SE REESCRIBE: la base rechaza editar una asignación, abierta o cerrada", async () => {
    const e = await crear({ conductor_nombre: "Juan Pérez", conductor_dni: "40000001" });
    await editar(e, {
      conductor_nombre: "Pedro Ruiz",
      conductor_dni: "40000002",
      motivo_cambio: "relevo",
    });
    const h = await historial(e.id);
    const cerrada = h.conductores[1].id;
    const vigente = h.conductores[0].id;

    const sql = (texto: string, params: unknown[]) =>
      withTenant(tenantId, (c) => c.query(texto, params));

    // Cambiar quién manejaba, en una fila cerrada.
    await expect(
      sql(`UPDATE equipo_conductores SET conductor_nombre = 'Otro' WHERE id = $1`, [cerrada])
    ).rejects.toThrow(/no se reescribe/);
    // Reabrir una cerrada.
    await expect(
      sql(`UPDATE equipo_conductores SET hasta = NULL, motivo_cierre = NULL WHERE id = $1`, [
        cerrada,
      ])
    ).rejects.toThrow();
    // Mover la fecha de cierre de una cerrada.
    await expect(
      sql(`UPDATE equipo_conductores SET hasta = now() WHERE id = $1`, [cerrada])
    ).rejects.toThrow(/ya está cerrada/);
    // Atribuirle el cambio a OTRA persona de la empresa.
    const altaOtro = await admin.post("/api/erp/usuarios").send({
      nombre: "Otra persona",
      dni: String(86300000 + Math.floor(Math.random() * 800000)),
      password,
      rol: "operador",
    });
    expect(altaOtro.status, JSON.stringify(altaOtro.body)).toBe(201);
    const intruso = String(altaOtro.body.id ?? altaOtro.body.usuario?.id);
    await withTenant(tenantId, (c) =>
      c.query(`UPDATE equipo_conductores SET usuario_id = NULL WHERE id = $1`, [cerrada])
    );
    await expect(
      sql(`UPDATE equipo_conductores SET usuario_id = $2 WHERE id = $1`, [cerrada, intruso])
    ).rejects.toThrow(/el autor de una asignación no cambia/);
    await expect(
      sql(`UPDATE equipo_conductores SET cerrado_por = $2 WHERE id = $1`, [cerrada, intruso])
    ).rejects.toThrow(/ya está cerrada/);
    // Pasar el autor a NULL (lo que hace ON DELETE SET NULL) sí se permite.
    await sql(`UPDATE equipo_conductores SET cerrado_por = NULL WHERE id = $1`, [cerrada]);
    // Reescribir la fecha de inicio de la vigente.
    await expect(
      sql(`UPDATE equipo_conductores SET desde = desde - interval '1 year' WHERE id = $1`, [
        vigente,
      ])
    ).rejects.toThrow(/no se reescribe/);
  });

  it("dos vigentes a la vez no pueden existir (índice único), ni por SQL directo", async () => {
    const e = await crear({ conductor_nombre: "Juan Pérez", conductor_dni: "40000001" });
    await expect(
      withTenant(tenantId, (c) =>
        c.query(
          `INSERT INTO equipo_conductores (tenant_id, equipo_id, conductor_nombre, motivo)
           VALUES ($1, $2, 'Intruso', 'x')`,
          [tenantId, e.id]
        )
      )
    ).rejects.toThrow(/duplicate|unique|único/i);
  });

  it("dos cambios simultáneos del conductor dejan UNA sola asignación vigente y en orden", async () => {
    // Se repite: la carrera solo se ve cuando las dos transacciones se solapan
    // (con now() de inicio de transacción fallaba ~1 de cada 10 veces).
    for (let ronda = 0; ronda < 8; ronda++) {
      const e = await crear({ conductor_nombre: "Juan Pérez", conductor_dni: "40000001" });
      const [a, b] = await Promise.all([
        editar(e, { conductor_nombre: "Ana", conductor_dni: "40000010", motivo_cambio: "A" }),
        editar(e, { conductor_nombre: "Beto", conductor_dni: "40000011", motivo_cambio: "B" }),
      ]);
      expect([a.status, b.status], `ronda ${ronda}: ${JSON.stringify([a.body, b.body])}`).toEqual([
        200, 200,
      ]);
      const h = await historial(e.id);
      expect(h.conductores).toHaveLength(3);
      expect(h.conductores.filter((c: { hasta: string | null }) => c.hasta === null)).toHaveLength(
        1
      );
      // Cada asignación cierra donde empieza la siguiente: sin huecos ni solapes.
      const cronologico = [...h.conductores].reverse();
      for (let i = 0; i < cronologico.length - 1; i++) {
        expect(cronologico[i].hasta).toBe(cronologico[i + 1].desde);
      }
    }
  }, 60000);

  it("la bitácora registra el cambio con el de/a y el motivo", async () => {
    const e = await crear({ conductor_nombre: "Juan Pérez", conductor_dni: "40000001" });
    await editar(e, {
      conductor_nombre: "Pedro Ruiz",
      conductor_dni: "40000002",
      motivo_cambio: "motivo-de-bitacora",
    });
    const r = await pool.query(
      `SELECT detalle FROM platform_audit_log
        WHERE tenant_id = $1 AND accion = 'equipos.cambiar_conductor'
          AND detalle->>'equipoId' = $2`,
      [tenantId, String(e.id)]
    );
    const fila = r.rows[0] as { detalle: Record<string, unknown> } | undefined;
    expect(fila?.detalle).toMatchObject({
      equipoId: e.id,
      motivo: "motivo-de-bitacora",
    });
    expect(String(fila?.detalle.de)).toContain("Juan Pérez");
    expect(String(fila?.detalle.a)).toContain("Pedro Ruiz");
  });

  it("otra empresa no ve el historial ni los lugares, y no puede editar la unidad", async () => {
    const e = await crear({
      conductor_nombre: "Juan Pérez",
      conductor_dni: "40000001",
      rutas: [{ origen_id: lima, destino_id: ica }],
    });
    expect((await ajeno.get(`/api/erp/equipos/${e.id}/historial`)).status).toBe(404);
    const suyos = (await ajeno.get("/api/erp/equipos/lugares")).body as { id: number }[];
    expect(suyos.some((l) => l.id === lima)).toBe(false);
    const res = await ajeno
      .put(`/api/erp/equipos/${e.id}`)
      .send({ placa_codigo: "X", tipo: "Volquete", motivo_cambio: "intruso" });
    expect(res.status).toBe(404);
    expect((await historial(e.id)).conductores).toHaveLength(1);
  });

  it("el selector de lugares de Equipos lista solo los activos de la empresa", async () => {
    const lugares = (await admin.get("/api/erp/equipos/lugares")).body as {
      id: number;
      nombre: string;
    }[];
    expect(lugares.map((l) => l.id)).toEqual(expect.arrayContaining([lima, ica, cusco]));
  });

  it("Lectura no puede cambiar conductor ni rutas (403), pero sí consultar el historial", async () => {
    const e = await crear({ conductor_nombre: "Juan Pérez", conductor_dni: "40000001" });
    const dni = String(86200000 + Math.floor(Math.random() * 800000));
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre: "Persona lectura", dni, password, rol: "lectura" });
    expect(alta.status, JSON.stringify(alta.body)).toBe(201);
    const lectura = request.agent(app);
    await lectura.post("/api/auth/login").send({ tenantSlug: slug, identificador: dni, password });

    const res = await lectura.put(`/api/erp/equipos/${e.id}`).send({
      placa_codigo: e.placa_codigo,
      tipo: "Volquete",
      conductor_nombre: "Intruso",
      motivo_cambio: "x",
    });
    expect(res.status).toBe(403);
    expect((await lectura.get(`/api/erp/equipos/${e.id}/historial`)).status).toBe(200);
    expect((await historial(e.id)).conductores).toHaveLength(1);
  });

  it("las unidades de un conductor, por DNI: las actuales primero y las pasadas con su cierre", async () => {
    const dni = String(70000000 + Math.floor(Math.random() * 999999));
    const a = await crear({ conductor_nombre: "Luis Quispe", conductor_dni: dni });
    const b = await crear({ conductor_nombre: "Luis Quispe", conductor_dni: dni });
    // El conductor deja la unidad A y pasa Marco.
    const cambio = await editar(a, {
      conductor_nombre: "Marco Vásquez",
      conductor_dni: "40000777",
      motivo_cambio: "Rotación de turno",
    });
    expect(cambio.status, JSON.stringify(cambio.body)).toBe(200);

    const res = await admin.get(`/api/erp/equipos/conductor/${dni}`);
    expect(res.status).toBe(200);
    const filas = res.body as {
      equipo_id: number;
      hasta: string | null;
      motivo_cierre: string | null;
    }[];
    expect(filas).toHaveLength(2);
    // La vigente (B) va primero; la pasada (A) trae por qué se cerró.
    expect(filas[0]).toMatchObject({ equipo_id: b.id, hasta: null });
    expect(filas[1]).toMatchObject({ equipo_id: a.id, motivo_cierre: "Rotación de turno" });
    expect(filas[1].hasta).not.toBeNull();
  });

  it("las unidades de un conductor: un DNI raro da 400 y otra empresa no ve nada", async () => {
    const dni = String(71000000 + Math.floor(Math.random() * 999999));
    await crear({ conductor_nombre: "Solo Mío", conductor_dni: dni });
    expect((await admin.get("/api/erp/equipos/conductor/12'%3B--")).status).toBe(400);
    expect((await admin.get(`/api/erp/equipos/conductor/${"9".repeat(16)}`)).status).toBe(400);

    const ajena = await ajeno.get(`/api/erp/equipos/conductor/${dni}`);
    expect(ajena.status).toBe(200);
    expect(ajena.body).toEqual([]);
  });

  it("exportar con ids trae solo esas unidades; sin ids, toda la flota; ids malos dan 400", async () => {
    const x = await crear();
    const y = await crear();
    const solo = await withTenant(tenantId, (c) =>
      EquiposRepository.findAllParaExportar(c, tenantId, [x.id])
    );
    expect(solo.map((f: { id: number }) => f.id)).toEqual([x.id]);
    const todo = await withTenant(tenantId, (c) =>
      EquiposRepository.findAllParaExportar(c, tenantId)
    );
    const idsTodo = todo.map((f: { id: number }) => f.id);
    expect(idsTodo).toEqual(expect.arrayContaining([x.id, y.id]));

    // Un id de otra empresa no devuelve nada, ni siquiera por el export.
    const ajenaFlota = await ajeno
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("AJ"), tipo: "Volquete" });
    const deOtro = await withTenant(tenantId, (c) =>
      EquiposRepository.findAllParaExportar(c, tenantId, [ajenaFlota.body.id])
    );
    expect(deOtro).toEqual([]);

    expect((await admin.get(`/api/erp/equipos/export/xlsx?ids=${x.id},${y.id}`)).status).toBe(200);
    expect((await admin.get("/api/erp/equipos/export/xlsx?ids=1,abc")).status).toBe(400);
    expect((await admin.get("/api/erp/equipos/export/xlsx?ids=1;DROP")).status).toBe(400);
    // Más de 1000 ids no entran en una URL razonable: se rechaza, no se corta.
    const muchos = Array.from({ length: 1001 }, (_, i) => i + 1).join(",");
    expect((await admin.get(`/api/erp/equipos/export/xlsx?ids=${muchos}`)).status).toBe(400);
  });

  it("'Activo' significa conductor vigente; bombonas y carretas siempre activas; baja = Inactivo", () => {
    const base = { activo: true, conductor_nombre: null, conductor_dni: null };
    expect(estadoDeUnidad({ ...base, tipo: "Volquete" })).toBe("Sin asignar");
    expect(estadoDeUnidad({ ...base, tipo: "Volquete", conductor_nombre: "Ana" })).toBe("Activo");
    expect(estadoDeUnidad({ ...base, tipo: "Volquete", conductor_dni: "40000001" })).toBe("Activo");
    expect(estadoDeUnidad({ ...base, tipo: "BOMBONA" })).toBe("Activo");
    expect(estadoDeUnidad({ ...base, tipo: "Carretas" })).toBe("Activo");
    expect(
      estadoDeUnidad({ ...base, tipo: "Volquete", activo: false, conductor_nombre: "Ana" })
    ).toBe("Inactivo");
    expect(tipoLlevaConductor("Perforadora")).toBe(true);
    expect(tipoLlevaConductor("Cargador frontal")).toBe(true);
  });

  it("el export a Excel no se rompe con conductor y rutas cargados", async () => {
    await crear({
      conductor_nombre: "Juan Exportable",
      conductor_dni: "40000099",
      rutas: [{ origen_id: lima, destino_id: ica }],
    });
    const res = await admin
      .get("/api/erp/equipos/export/xlsx")
      .buffer(true)
      .parse((r, cb) => {
        const partes: Buffer[] = [];
        r.on("data", (d: Buffer) => partes.push(d));
        r.on("end", () => cb(null, Buffer.concat(partes)));
      });
    expect(res.status).toBe(200);
    expect((res.body as Buffer).length).toBeGreaterThan(500);
  });
});
