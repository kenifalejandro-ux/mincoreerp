/** tests/proveedores-historial.test.ts
 *
 * «Historial y auditoría» del ecosistema: lo que se hizo con los proveedores, leído de la bitácora
 * (`platform_audit_log`, acciones `proveedores.*`).
 *
 * 1. Lógica pura: cómo se dice cada acción con palabras, sin datos sensibles y con un respaldo para una
 *    acción desconocida.
 * 2. API, en una empresa SOLO con Proveedores: el admin ve sus movimientos con quién, qué y sobre qué
 *    proveedor; filtra por tipo, fechas y proveedor; pagina con cursor; el operador y Lectura no entran;
 *    otra empresa no ve nada ajeno.
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba } from "./helpers";
import { closeDatabase, pool } from "../src/server/config/database";
import { env } from "../src/server/config/env";
import { MODULOS } from "../src/modules/registry";
import {
  PATRON_DE_CATEGORIA,
  describirEvento,
  proveedorDelEvento,
} from "../src/modules/proveedores/proveedores.historial";

const BEARER = `Bearer ${env.platformAdminToken}`;
const PASSWORD = "ClaveDePrueba123";

describe("describirEvento (lógica pura)", () => {
  it("dice el alta y la edición de un proveedor", () => {
    expect(describirEvento("proveedores.crear", { tipos: ["Combustible", "Urea"] })).toEqual({
      titulo: "Registró un proveedor",
      categoria: "proveedor",
      lineas: ["Abastece: Combustible y Urea"],
    });
    expect(describirEvento("proveedores.actualizar", { activo: false }).lineas).toEqual([
      "Queda desactivado",
    ]);
  });

  it("al eliminar dice quién era y cuántas cuentas bancarias se fueron, sin números", () => {
    expect(
      describirEvento("proveedores.eliminar", {
        nombre: "GRIFO X",
        codigo: "PRV-007",
        cuentasBorradas: 2,
      }).lineas
    ).toEqual(["GRIFO X · PRV-007", "Se fueron con él 2 cuentas bancarias"]);
    expect(
      describirEvento("proveedores.eliminar", { nombre: "GRIFO X", cuentasBorradas: 1 }).lineas
    ).toEqual(["GRIFO X", "Se fueron con él 1 cuenta bancaria"]);
    expect(describirEvento("proveedores.eliminar", { nombre: "GRIFO X" }).lineas).toEqual([
      "GRIFO X",
    ]);
  });

  it("dice el cambio de ciudad al editar un proveedor, por el nombre del campo", () => {
    expect(
      describirEvento("proveedores.actualizar", { activo: true, campos: ["ciudad"] }).lineas
    ).toEqual(["Queda activo", "Cambió: ciudad"]);
    expect(describirEvento("proveedores.actualizar", { activo: false }).lineas).toEqual([
      "Queda desactivado",
    ]);
  });

  it("dice los precios con su monto y su motivo", () => {
    expect(
      describirEvento("proveedores.precio_crear", {
        producto: "combustible",
        tipoCombustible: "diesel_b5",
        precioUnitario: 15.8,
        masivo: true,
      })
    ).toEqual({
      titulo: "Cargó un precio",
      categoria: "precios",
      lineas: ["Diésel B5 · S/ 15.80 por galón", "Carga masiva a varios proveedores"],
    });
    expect(
      describirEvento("proveedores.precio_crear", {
        producto: "urea",
        presentacion: "caja",
        precioPorBulto: 78,
      }).lineas
    ).toEqual(["Urea (caja) · S/ 78.00 por bulto"]);
    expect(
      describirEvento("proveedores.precio_anular", { producto: "urea", motivo: "Error de tipeo" })
        .lineas
    ).toEqual(["Urea", "Motivo: Error de tipeo"]);
  });

  it("dice los datos de la ficha por el nombre de los campos, nunca por su valor", () => {
    const e = describirEvento("proveedores.datos_editar", {
      campos: ["direccion", "formaPago", "plazoPagoDias"],
    });
    expect(e.categoria).toBe("ficha");
    expect(e.lineas).toEqual(["Cambió: dirección, forma de pago, plazo de pago"]);
  });

  it("dice las cuentas bancarias con los últimos 4 y nada más", () => {
    expect(
      describirEvento("proveedores.cuenta_cambiar_numero", {
        banco: "BCP",
        ultimos4Anteriores: "4567",
        ultimos4Nuevos: "8899",
      }).lineas
    ).toEqual(["BCP", "Número: •••• 4567 → •••• 8899"]);
    expect(describirEvento("proveedores.cuenta_ver", { ultimos4: "4567" })).toEqual({
      titulo: "Vio el número completo de una cuenta",
      categoria: "cuentas",
      lineas: ["Cuenta •••• 4567"],
    });
    expect(
      describirEvento("proveedores.cuenta_crear", { banco: "BBVA", ultimos4: "8899" }).lineas
    ).toEqual(["BBVA •••• 8899"]);
  });

  it("una acción desconocida se muestra con su nombre, no se esconde", () => {
    expect(describirEvento("proveedores.homologacion_aprobar", null)).toEqual({
      titulo: "homologacion aprobar",
      categoria: null,
      lineas: [],
    });
  });

  it("el proveedor del evento solo cuenta si es un entero positivo", () => {
    expect(proveedorDelEvento({ proveedorId: 12 })).toBe(12);
    for (const malo of [
      { proveedorId: "12" },
      { proveedorId: 0 },
      { proveedorId: 1.5 },
      {},
      null,
    ]) {
      expect(proveedorDelEvento(malo)).toBeNull();
    }
  });

  it("cada categoría reconoce sus acciones y no las de otra", () => {
    const coincide = (cat: keyof typeof PATRON_DE_CATEGORIA, accion: string) =>
      new RegExp(PATRON_DE_CATEGORIA[cat]).test(accion);
    expect(coincide("proveedor", "proveedores.crear")).toBe(true);
    expect(coincide("proveedor", "proveedores.precio_crear")).toBe(false);
    expect(coincide("precios", "proveedores.precio_anular")).toBe(true);
    expect(coincide("ficha", "proveedores.contacto_quitar")).toBe(true);
    expect(coincide("cuentas", "proveedores.cuenta_ver")).toBe(true);
    expect(coincide("compras", "proveedores.compra_habilitar")).toBe(true);
    expect(coincide("compras", "usuarios.crear")).toBe(false);
  });
});

type Empresa = Awaited<ReturnType<typeof crearTenantDePrueba>>;
type Agente = ReturnType<typeof request.agent>;

describe("GET /api/erp/proveedores/historial", () => {
  const empresas: Empresa[] = [];
  let a: Empresa; // solo Proveedores
  let b: Empresa;
  let admin: Agente;
  let adminB: Agente;
  let proveedorA: number;

  const entrar = async (email: string, e: Empresa) => {
    const ag = request.agent(app);
    const res = await ag
      .post("/api/auth/login")
      .send({ tenantSlug: e.tenant.slug, email, password: PASSWORD });
    expect(res.status).toBe(200);
    return ag;
  };
  const soloProveedores = async (e: Empresa) => {
    const r = await request(app)
      .put(`/api/platform/tenants/${e.tenant.id}/modulos`)
      .set("Authorization", BEARER)
      .send({
        configuraciones: MODULOS.map((m) => ({
          modulo: m.id,
          estado: m.id === "proveedores" ? "habilitado" : "deshabilitado",
        })),
      });
    expect(r.status).toBe(200);
  };
  const historial = (ag: Agente, consulta = "") =>
    ag.get(`/api/erp/proveedores/historial${consulta}`);
  const nuevoProveedor = (ag: Agente, nombre: string) =>
    ag.post("/api/erp/proveedores").send({
      nombre,
      ruc: "",
      abastece_tanque: false,
      abastece_ruta: true,
      abastece_urea: false,
      abastece_urea_ruta: false,
    });

  beforeAll(async () => {
    a = await crearTenantDePrueba(PASSWORD);
    b = await crearTenantDePrueba(PASSWORD);
    empresas.push(a, b);
    await soloProveedores(a);
    await soloProveedores(b);
    admin = await entrar(a.usuario.email, a);
    adminB = await entrar(b.usuario.email, b);

    // Movimientos de la empresa A: alta, edición de datos, contacto, precio cargado y anulado.
    const alta = await nuevoProveedor(admin, "GRIFO HISTORIAL");
    expect(alta.status, JSON.stringify(alta.body)).toBe(201);
    proveedorA = alta.body.id;
    expect(
      (
        await admin
          .put(`/api/erp/proveedores/${proveedorA}/ficha`)
          .send({ direccion: "Jr. Secreto 999", telefono: "064123456", moneda: "PEN" })
      ).status
    ).toBe(200);
    expect(
      (
        await admin.post(`/api/erp/proveedores/${proveedorA}/contactos`).send({
          nombre: "Rosa Quispe",
          telefono: "987654321",
          principal: true,
        })
      ).status
    ).toBe(201);
    const precio = await admin
      .post("/api/erp/proveedores/precios/combustible")
      .send({ tipo_combustible: "diesel_b5", grifo_ids: [proveedorA], precio_unitario: 15.8 });
    expect(precio.status, JSON.stringify(precio.body)).toBe(201);
    expect(
      (
        await admin
          .patch(`/api/erp/proveedores/precios/combustible/${precio.body[0].id}/anular`)
          .send({ motivo: "Error de tipeo" })
      ).status
    ).toBe(200);
    // Y uno de la empresa B, que A no debe ver.
    expect((await nuevoProveedor(adminB, "GRIFO DE B")).status).toBe(201);
  });

  afterAll(async () => {
    for (const e of empresas) await borrarTenantDePrueba(e.tenant.id);
    await closeDatabase();
  });

  it("el admin ve sus movimientos, de más nuevo a más viejo, con quién, qué y sobre qué proveedor", async () => {
    const r = await historial(admin);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    const titulos = r.body.eventos.map((e: { titulo: string }) => e.titulo);
    expect(titulos).toEqual([
      "Anuló un precio",
      "Cargó un precio",
      "Agregó un contacto",
      "Editó los datos y las condiciones de pago",
      "Registró un proveedor",
    ]);
    const anulado = r.body.eventos[0];
    expect(anulado).toMatchObject({
      accion: "proveedores.precio_anular",
      categoria: "precios",
      proveedorId: proveedorA,
      proveedorNombre: "GRIFO HISTORIAL",
    });
    expect(anulado.actor).toBeTruthy();
    expect(anulado.lineas).toEqual(["Combustible", "Motivo: Error de tipeo"]);
    expect(r.body.eventos[1].lineas).toEqual(["Diésel B5 · S/ 15.80 por galón"]);
    expect(r.body.siguiente).toBeNull();
    // Nada del contenido de la ficha: ni la dirección, ni el teléfono, ni el contacto.
    const texto = JSON.stringify(r.body);
    for (const secreto of ["Jr. Secreto 999", "064123456", "987654321", "Rosa Quispe"]) {
      expect(texto).not.toContain(secreto);
    }
    // Y nada de la empresa B.
    expect(texto).not.toContain("GRIFO DE B");
  });

  it("filtra por tipo, por proveedor y por fechas", async () => {
    const precios = await historial(admin, "?categoria=precios");
    expect(precios.body.eventos.map((e: { categoria: string }) => e.categoria)).toEqual([
      "precios",
      "precios",
    ]);
    const ficha = await historial(admin, "?categoria=ficha");
    expect(ficha.body.eventos).toHaveLength(2);

    const porNombre = await historial(admin, `?proveedor=${encodeURIComponent("historial")}`);
    expect(porNombre.body.eventos.length).toBeGreaterThanOrEqual(5);
    const sinCoincidencia = await historial(admin, "?proveedor=NOEXISTE");
    expect(sinCoincidencia.body).toEqual({ eventos: [], siguiente: null });

    const hoy = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date());
    expect((await historial(admin, `?desde=${hoy}&hasta=${hoy}`)).body.eventos).toHaveLength(5);
    expect((await historial(admin, "?hasta=2020-01-01")).body.eventos).toHaveLength(0);
    expect((await historial(admin, "?desde=2999-01-01")).body.eventos).toHaveLength(0);
    // Valores raros no rompen: se ignoran.
    expect((await historial(admin, "?desde=ayer&antesDe=x")).status).toBe(200);
  });

  it("un día que no existe se ignora (antes: 500 de Postgres) y una categoría del prototipo es 400", async () => {
    const sinFiltro = (await historial(admin)).body.eventos;
    for (const consulta of [
      "?desde=2026-02-31",
      "?hasta=2026-13-45",
      "?desde=2026-04-31&hasta=2026-00-10",
    ]) {
      const r = await historial(admin, consulta);
      expect(r.status, consulta).toBe(200);
      expect(r.body.eventos, consulta).toEqual(sinFiltro);
    }
    for (const categoria of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect((await historial(admin, `?categoria=${categoria}`)).status, categoria).toBe(400);
    }
  });

  it("pagina con cursor sin repetir ni saltear", async () => {
    const primera = await historial(admin, "?limite=2");
    expect(primera.body.eventos).toHaveLength(2);
    expect(primera.body.siguiente).toBe(primera.body.eventos[1].id);
    const segunda = await historial(admin, `?limite=2&antesDe=${primera.body.siguiente}`);
    const tercera = await historial(admin, `?limite=2&antesDe=${segunda.body.siguiente}`);
    const ids = [...primera.body.eventos, ...segunda.body.eventos, ...tercera.body.eventos].map(
      (e: { id: string }) => e.id
    );
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
    expect(tercera.body.siguiente).toBeNull();
    // El tope del tamaño de página: un `limite` enorme no trae más de 100.
    expect((await historial(admin, "?limite=999999")).status).toBe(200);
  });

  it("filtra por un proveedor exacto (la pestaña Historial de su ficha)", async () => {
    const r = await historial(admin, `?proveedorId=${proveedorA}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.eventos).toHaveLength(5);
    expect(r.body.eventos.every((e: { proveedorId: number }) => e.proveedorId === proveedorA)).toBe(
      true
    );
    // Con otra categoría se combinan los dos filtros.
    const fichas = await historial(admin, `?proveedorId=${proveedorA}&categoria=ficha`);
    expect(fichas.body.eventos).toHaveLength(2);
    // Uno que no existe (o de otra empresa) no trae nada.
    expect((await historial(admin, "?proveedorId=99999999")).body.eventos).toEqual([]);
    // Si hay id y nombre, manda el id.
    const mandaId = await historial(admin, `?proveedorId=${proveedorA}&proveedor=NADA`);
    expect(mandaId.body.eventos).toHaveLength(5);
  });

  it("un proveedorId que no es un entero positivo es 400", async () => {
    for (const malo of ["abc", "0", "-3", "1.5"]) {
      expect((await historial(admin, `?proveedorId=${malo}`)).status, malo).toBe(400);
    }
  });

  it("una categoría inválida es 400", async () => {
    expect((await historial(admin, "?categoria=otra")).status).toBe(400);
  });

  it("solo el admin: el operador y Lectura reciben 403", async () => {
    for (const rol of ["operador", "lectura"]) {
      const email = `${rol}-${a.tenant.slug}@test.local`;
      const alta = await admin
        .post("/api/erp/usuarios")
        .send({ nombre: `Persona ${rol}`, email, password: PASSWORD, rol });
      expect(alta.status, JSON.stringify(alta.body)).toBe(201);
      const ag = await entrar(email, a);
      expect((await historial(ag)).status, rol).toBe(403);
    }
  });

  it("otra empresa ve solo lo suyo", async () => {
    const r = await historial(adminB);
    expect(r.status).toBe(200);
    expect(r.body.eventos.map((e: { titulo: string }) => e.titulo)).toEqual([
      "Registró un proveedor",
    ]);
    expect(JSON.stringify(r.body)).not.toContain("GRIFO HISTORIAL");
    // Un evento de B con el id de un proveedor de A no resuelve el nombre de A.
    await pool.query(
      `INSERT INTO platform_audit_log (accion, tenant_id, usuario_id, detalle)
       VALUES ('proveedores.contacto_crear', $1, $2, $3::jsonb)`,
      [b.tenant.id, b.usuario.id, JSON.stringify({ proveedorId: proveedorA, contactoId: 1 })]
    );
    const conAjeno = await historial(adminB);
    expect(conAjeno.body.eventos[0].proveedorNombre).toBeNull();
    expect(JSON.stringify(conAjeno.body)).not.toContain("GRIFO HISTORIAL");
  });

  it("un evento sin proveedor ni detalle se muestra igual", async () => {
    await pool.query(
      `INSERT INTO platform_audit_log (accion, tenant_id, usuario_id, detalle)
       VALUES ('proveedores.contacto_quitar', $1, $2, NULL)`,
      [a.tenant.id, a.usuario.id]
    );
    const r = await historial(admin, "?limite=1");
    expect(r.body.eventos[0]).toMatchObject({
      titulo: "Quitó un contacto",
      proveedorId: null,
      proveedorNombre: null,
      lineas: [],
    });
  });
});
