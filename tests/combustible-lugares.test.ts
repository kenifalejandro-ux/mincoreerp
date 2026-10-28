/**tests/combustible-lugares.test.ts
 *
 * Lugares de los viajes (0123 + 0159): nombre, tipo (mina, ciudad, abastecimiento), ubicación y
 * estado. Se ataca la API: validación, nombres repetidos, ediciones simultáneas, un lugar
 * desactivado, el perfil Lectura y otro tenant.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";

const LUGARES = "/api/erp/combustible/lugares";

describe("combustible: lugares con tipo, ubicación y estado (0159)", () => {
  const tenants: string[] = [];
  const password = "ClaveDePrueba123";
  const admin = request.agent(app);
  let tenantId: string;
  let slug: string;
  let seq = 0;

  const crear = (nombre: string, extra: Record<string, unknown> = {}) =>
    admin.post(LUGARES).send({ nombre, ...extra });

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenants.push(creado.tenant.id);
    tenantId = creado.tenant.id;
    slug = creado.tenant.slug;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: slug, email: creado.usuario.email, password });
  });

  afterAll(async () => {
    for (const t of tenants) await borrarTenantDePrueba(t);
    await closeDatabase();
  });

  it("crea con tipo y ubicación, y el listado los devuelve", async () => {
    const nombre = idUnico("Mina");
    const r = await crear(nombre, { tipo: "mina", ubicacion: "  Hualgayoc, Cajamarca " });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({
      nombre,
      tipo: "mina",
      ubicacion: "Hualgayoc, Cajamarca",
      activo: true,
    });
    const lista = (await admin.get(LUGARES)).body.data as { id: number; tipo: string }[];
    expect(lista.find((l) => l.id === r.body.id)?.tipo).toBe("mina");
  });

  it("sin tipo ni ubicación sigue funcionando (quedan en null)", async () => {
    const r = await crear(idUnico("Solo nombre"));
    expect(r.status).toBe(201);
    expect(r.body.tipo).toBeNull();
    expect(r.body.ubicacion).toBeNull();
  });

  it("rechaza tipo fuera de la lista, ubicación larga y cuerpos mal formados con 400", async () => {
    expect((await crear(idUnico("X"), { tipo: "base_logistica" })).status).toBe(400);
    expect((await crear(idUnico("X"), { ubicacion: "a".repeat(121) })).status).toBe(400);
    expect((await crear(idUnico("X"), { tipo: 5 })).status).toBe(400);
    expect((await crear("   ")).status).toBe(400);
    expect((await crear("n".repeat(81))).status).toBe(400);
  });

  it("una ubicación vacía se guarda como null", async () => {
    const r = await crear(idUnico("Vacía"), { tipo: "ciudad", ubicacion: "   " });
    expect(r.status).toBe(201);
    expect(r.body.ubicacion).toBeNull();
  });

  it("PATCH cambia solo lo que llega y puede borrar la ubicación", async () => {
    const nombre = idUnico("Cambia");
    const { id } = (await crear(nombre, { tipo: "ciudad", ubicacion: "Lima" })).body;
    const solo = await admin.patch(`${LUGARES}/${id}`).send({ tipo: "abastecimiento" });
    expect(solo.status, JSON.stringify(solo.body)).toBe(200);
    expect(solo.body).toMatchObject({ nombre, tipo: "abastecimiento", ubicacion: "Lima" });

    const borra = await admin.patch(`${LUGARES}/${id}`).send({ ubicacion: null });
    expect(borra.body.ubicacion).toBeNull();
    const borraConVacio = await admin.patch(`${LUGARES}/${id}`).send({ ubicacion: "Ica" });
    expect(borraConVacio.body.ubicacion).toBe("Ica");
    expect(
      (await admin.patch(`${LUGARES}/${id}`).send({ ubicacion: "  " })).body.ubicacion
    ).toBeNull();

    const renombra = idUnico("Renombrado");
    const r = await admin.patch(`${LUGARES}/${id}`).send({ nombre: `  ${renombra} ` });
    expect(r.body.nombre).toBe(renombra);
    expect(r.body.tipo).toBe("abastecimiento");
  });

  it("PATCH sin cambios, con tipo inválido o con campos de más da 400", async () => {
    const { id } = (await crear(idUnico("Val"))).body;
    expect((await admin.patch(`${LUGARES}/${id}`).send({})).status).toBe(400);
    expect((await admin.patch(`${LUGARES}/${id}`).send({ tipo: "mina2" })).status).toBe(400);
    expect((await admin.patch(`${LUGARES}/${id}`).send({ activo: "no" })).status).toBe(400);
    expect((await admin.patch(`${LUGARES}/${id}`).send({ nombre: "" })).status).toBe(400);
  });

  it("un nombre repetido da 409, también con otras mayúsculas o espacios, al crear y al editar", async () => {
    const base = idUnico("Dup");
    expect((await crear(base)).status).toBe(201);
    expect((await crear(base.toUpperCase())).status).toBe(409);
    expect((await crear(`  ${base}  `)).status).toBe(409);

    const otro = (await crear(idUnico("Otro"))).body.id;
    const r = await admin.patch(`${LUGARES}/${otro}`).send({ nombre: base.toLowerCase() });
    expect(r.status).toBe(409);
    // Dejarlo con su propio nombre (otra mayúscula) no es un duplicado de sí mismo.
    const propio = (await admin.get(LUGARES)).body.data.find((l: { id: number }) => l.id === otro);
    expect(
      (await admin.patch(`${LUGARES}/${otro}`).send({ nombre: propio.nombre.toUpperCase() })).status
    ).toBe(200);
  });

  it("dos ediciones a la vez al mismo nombre: una gana y la otra recibe 409", async () => {
    const a = (await crear(idUnico("CarreraA"))).body.id;
    const b = (await crear(idUnico("CarreraB"))).body.id;
    const destino = idUnico("Destino");
    const [r1, r2] = await Promise.all([
      admin.patch(`${LUGARES}/${a}`).send({ nombre: destino }),
      admin.patch(`${LUGARES}/${b}`).send({ nombre: destino }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
  });

  it("dos ediciones a la vez al mismo lugar no se pisan campos entre sí", async () => {
    const { id } = (await crear(idUnico("Mismo"), { tipo: "ciudad" })).body;
    const [r1, r2] = await Promise.all([
      admin.patch(`${LUGARES}/${id}`).send({ tipo: "mina" }),
      admin.patch(`${LUGARES}/${id}`).send({ ubicacion: "Trujillo" }),
    ]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    const final = (await admin.get(LUGARES)).body.data.find((l: { id: number }) => l.id === id);
    expect(final).toMatchObject({ tipo: "mina", ubicacion: "Trujillo" });
  });

  it("desactivar es idempotente, no borra el lugar y se puede reactivar", async () => {
    const { id } = (await crear(idUnico("Baja"))).body;
    expect((await admin.patch(`${LUGARES}/${id}`).send({ activo: false })).body.activo).toBe(false);
    expect((await admin.patch(`${LUGARES}/${id}`).send({ activo: false })).status).toBe(200);
    const lista = (await admin.get(LUGARES)).body.data as { id: number; activo: boolean }[];
    expect(lista.find((l) => l.id === id)?.activo).toBe(false);
    expect((await admin.patch(`${LUGARES}/${id}`).send({ activo: true })).body.activo).toBe(true);
  });

  it("un lugar desactivado no se puede usar en un viaje nuevo, aunque ya tenga viajes", async () => {
    const origen = Number((await crear(idUnico("O"))).body.id);
    const destino = Number((await crear(idUnico("D"))).body.id);
    const eq = await admin.post("/api/erp/equipos").send({
      placa_codigo: idUnico("VQ"),
      tipo: "VOLQUETE",
      tipo_medidor: "odometro",
      conductor_nombre: "Juan Pérez",
      conductor_dni: String(41000000 + seq++),
    });
    expect(eq.status, JSON.stringify(eq.body)).toBe(201);
    const ahora = Date.now();
    const nuevo = (inicio: number) =>
      admin.post("/api/erp/combustible/viajes").send({
        equipo_id: Number(eq.body.id),
        origen_id: origen,
        destino_id: destino,
        inicio_en: new Date(ahora + inicio * 3_600_000).toISOString(),
        fin_en: new Date(ahora + (inicio + 1) * 3_600_000).toISOString(),
      });
    const primero = await nuevo(-10);
    expect(primero.status, JSON.stringify(primero.body)).toBe(201);

    expect((await admin.patch(`${LUGARES}/${destino}`).send({ activo: false })).status).toBe(200);
    const bloqueado = await nuevo(-5);
    expect(bloqueado.status).toBe(400);
    // El viaje que ya existía sigue ahí, con su lugar.
    const viejo = await admin.get(`/api/erp/combustible/viajes/${primero.body.id}`);
    expect(viejo.status).toBe(200);
  });

  it("ids inexistentes o desbordados dan 404, nunca 500", async () => {
    for (const id of ["999999999", "99999999999999999999999"]) {
      expect((await admin.patch(`${LUGARES}/${id}`).send({ activo: false })).status).toBe(404);
    }
    // No es numérico: la ruta ni existe.
    expect((await admin.patch(`${LUGARES}/abc`).send({ activo: false })).status).toBe(404);
  });

  it("Lectura puede ver pero no crear ni editar; el grifero no ve los lugares", async () => {
    const { id } = (await crear(idUnico("Perm"))).body;
    const entrar = async (rol: string) => {
      const agente = request.agent(app);
      const dni = String(87100000 + Math.floor(Math.random() * 800000) + seq++);
      const alta = await admin
        .post("/api/erp/usuarios")
        .send({ nombre: `Persona ${rol}`, dni, password, rol });
      expect(alta.status).toBe(201);
      await agente.post("/api/auth/login").send({ tenantSlug: slug, identificador: dni, password });
      return agente;
    };
    const lectura = await entrar("lectura");
    expect((await lectura.get(LUGARES)).status).toBe(200);
    expect((await lectura.post(LUGARES).send({ nombre: "X", tipo: "mina" })).status).toBe(403);
    expect((await lectura.patch(`${LUGARES}/${id}`).send({ activo: false })).status).toBe(403);
    const grifero = await entrar("grifero");
    expect((await grifero.patch(`${LUGARES}/${id}`).send({ activo: false })).status).toBe(403);
    // Nada cambió.
    const lista = (await admin.get(LUGARES)).body.data as { id: number; activo: boolean }[];
    expect(lista.find((l) => l.id === id)?.activo).toBe(true);
  });

  it("otro tenant no ve ni edita mis lugares, y sus nombres no chocan con los míos", async () => {
    const nombre = idUnico("Aislado");
    const mio = (await crear(nombre, { tipo: "mina" })).body.id;

    const otro = await crearTenantDePrueba(password);
    tenants.push(otro.tenant.id);
    const ajeno = request.agent(app);
    await ajeno
      .post("/api/auth/login")
      .send({ tenantSlug: otro.tenant.slug, email: otro.usuario.email, password });

    expect((await ajeno.get(LUGARES)).body.data).toHaveLength(0);
    expect((await ajeno.patch(`${LUGARES}/${mio}`).send({ activo: false })).status).toBe(404);
    expect((await ajeno.post(LUGARES).send({ nombre, tipo: "ciudad" })).status).toBe(201);
    const lista = (await admin.get(LUGARES)).body.data as { id: number; activo: boolean }[];
    expect(lista.find((l) => l.id === mio)?.activo).toBe(true);
  });

  it("la bitácora guarda quién, qué cambió y el antes y el después", async () => {
    const { id } = (await crear(idUnico("Bitácora"), { tipo: "ciudad" })).body;
    await admin.patch(`${LUGARES}/${id}`).send({ tipo: "mina" });
    await admin.patch(`${LUGARES}/${id}`).send({ activo: false });
    await admin.patch(`${LUGARES}/${id}`).send({ activo: true });

    const filas = await withTenant(tenantId, (c) =>
      c.query(
        `SELECT accion, actor_label, detalle FROM platform_audit_log
          WHERE tenant_id = $1 AND (detalle->>'lugarId')::bigint = $2
          ORDER BY id`,
        [tenantId, id]
      )
    );
    expect(filas.rows.map((f) => f.accion)).toEqual([
      "combustible.lugar_crear",
      "combustible.lugar_editar",
      "combustible.lugar_desactivar",
      "combustible.lugar_activar",
    ]);
    // Solo ids y nombres de campo: la bitácora no copia el contenido del tenant.
    expect(filas.rows[1].detalle).toEqual({ lugarId: Number(id), campos: ["tipo"] });
    expect(filas.rows[2].detalle.campos).toEqual(["activo"]);
    expect(filas.rows.every((f) => f.actor_label)).toBe(true);
  });

  it("un PATCH que no cambia nada no deja rastro en la bitácora", async () => {
    const nombre = idUnico("Sin cambio");
    const { id } = (await crear(nombre, { tipo: "mina" })).body;
    const r1 = await admin.patch(`${LUGARES}/${id}`).send({ nombre, tipo: "mina", activo: true });
    expect(r1.status).toBe(200);
    expect(
      (await admin.patch(`${LUGARES}/${id}`).send({ nombre: nombre.toUpperCase() })).status
    ).toBe(200); // mayúsculas distintas sí es un cambio...
    const filas = await withTenant(tenantId, (c) =>
      c.query(
        `SELECT accion FROM platform_audit_log
          WHERE tenant_id = $1 AND (detalle->>'lugarId')::bigint = $2 ORDER BY id`,
        [tenantId, id]
      )
    );
    // ...y el PATCH idéntico no: solo el alta y el cambio de mayúsculas.
    expect(filas.rows.map((f) => f.accion)).toEqual([
      "combustible.lugar_crear",
      "combustible.lugar_editar",
    ]);
  });

  it("un carácter de control en nombre o ubicación da 400, nunca 500", async () => {
    expect((await crear("a\u0000b")).status).toBe(400);
    expect((await crear(idUnico("N"), { ubicacion: "a\u0000b" })).status).toBe(400);
    expect((await crear("línea\nnueva")).status).toBe(400);
    const { id } = (await crear(idUnico("Ctl"))).body;
    expect((await admin.patch(`${LUGARES}/${id}`).send({ nombre: "x\u0000y" })).status).toBe(400);
    expect((await admin.patch(`${LUGARES}/${id}`).send({ ubicacion: "x\u0007" })).status).toBe(400);
  });

  it("los caracteres invisibles no esquivan el nombre único", async () => {
    const base = idUnico("Lima");
    expect((await crear(base)).status).toBe(201);
    expect((await crear(`${base}\u200B`)).status).toBe(409);
    expect((await crear(`${base.slice(0, 2)}\u00AD${base.slice(2)}`)).status).toBe(409);
    const otro = (await crear(idUnico("Otro"))).body.id;
    expect((await admin.patch(`${LUGARES}/${otro}`).send({ nombre: `${base}\uFEFF` })).status).toBe(
      409
    );
    // Solo invisibles = vacío.
    expect((await crear("\u200B\u200B")).status).toBe(400);
    // "é" compuesta y descompuesta son el mismo nombre.
    const e = idUnico("Sán");
    expect((await crear(e.normalize("NFC"))).status).toBe(201);
    expect((await crear(e.normalize("NFD"))).status).toBe(409);
  });

  it("un viaje con lugar desactivado se puede editar sin cambiar la ruta, pero no mudarlo a otro desactivado", async () => {
    const origen = Number((await crear(idUnico("EO"))).body.id);
    const destino = Number((await crear(idUnico("ED"))).body.id);
    const otro = Number((await crear(idUnico("EX"))).body.id);
    const eq = await admin.post("/api/erp/equipos").send({
      placa_codigo: idUnico("VQ"),
      tipo: "VOLQUETE",
      tipo_medidor: "odometro",
      conductor_nombre: "Juan Pérez",
      conductor_dni: String(42000000 + seq++),
    });
    expect(eq.status, JSON.stringify(eq.body)).toBe(201);
    const ahora = Date.now();
    const v = await admin.post("/api/erp/combustible/viajes").send({
      equipo_id: Number(eq.body.id),
      origen_id: origen,
      destino_id: destino,
      inicio_en: new Date(ahora - 10 * 3_600_000).toISOString(),
      fin_en: new Date(ahora - 9 * 3_600_000).toISOString(),
    });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    await admin.patch(`${LUGARES}/${destino}`).send({ activo: false });
    await admin.patch(`${LUGARES}/${otro}`).send({ activo: false });

    const url = `/api/erp/combustible/viajes/${v.body.id}`;
    const igual = await admin.put(url).send({
      origen_id: origen,
      destino_id: destino,
      observaciones: "corregido",
      motivo: "ajuste",
    });
    expect(igual.status, JSON.stringify(igual.body)).toBe(200);
    // Cambiar a un lugar desactivado distinto del que ya tenía sigue prohibido.
    const mudado = await admin
      .put(url)
      .send({ origen_id: origen, destino_id: otro, motivo: "cambio de destino" });
    expect(mudado.status).toBe(400);
  });
});
