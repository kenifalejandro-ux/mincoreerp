/** tests/proveedores-directorio.test.ts
 *
 * El Directorio de proveedores como la maqueta: la ciudad (columna «Lugar»), qué tan completa está la ficha y
 * el precio vigente de cada proveedor.
 *
 * 1. Lógica pura: los cinco datos que cuenta «ficha completa» (RUC, dirección, teléfono, contacto y condición de
 *    pago; la cuenta bancaria NO entra) y qué precio se muestra.
 * 2. API en una empresa SOLO con Proveedores: la ciudad se guarda en la ficha y sale en el listado; la ficha
 *    completa sube al cargar datos; el precio vigente aparece para quien ve precios y no viaja para quien no.
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";
import { env } from "../src/server/config/env";
import { MODULOS } from "../src/modules/registry";
import {
  calcularFichaCompleta,
  precioDelDirectorio,
  type DatosDeLaFicha,
} from "../src/modules/proveedores/proveedores.directorio";
import type { FilaPrecioDto } from "../src/modules/proveedores/proveedores.precios";

const BEARER = `Bearer ${env.platformAdminToken}`;
const PASSWORD = "ClaveDePrueba123";

const vacia: DatosDeLaFicha = {
  ruc: null,
  direccion: null,
  telefono: null,
  formaPago: null,
  tieneContacto: false,
  contactoConTelefono: false,
};

describe("calcularFichaCompleta (lógica pura)", () => {
  it("una ficha vacía está en 0 % y dice qué falta, en orden", () => {
    expect(calcularFichaCompleta(vacia)).toEqual({
      porcentaje: 0,
      faltan: ["RUC", "dirección", "teléfono", "contacto", "condición de pago"],
    });
  });

  it("cada dato suma 20 % y deja de faltar", () => {
    expect(calcularFichaCompleta({ ...vacia, ruc: "20123456789" })).toMatchObject({
      porcentaje: 20,
      faltan: ["dirección", "teléfono", "contacto", "condición de pago"],
    });
    expect(
      calcularFichaCompleta({
        ...vacia,
        ruc: "20123456789",
        direccion: "Av. 1",
        formaPago: "contado",
      })
    ).toMatchObject({ porcentaje: 60, faltan: ["teléfono", "contacto"] });
  });

  it("el teléfono lo da la empresa o alguno de sus contactos", () => {
    expect(calcularFichaCompleta({ ...vacia, telefono: "064123456" }).faltan).not.toContain(
      "teléfono"
    );
    expect(
      calcularFichaCompleta({ ...vacia, tieneContacto: true, contactoConTelefono: true }).faltan
    ).not.toContain("teléfono");
    // Un contacto sin teléfono cuenta como contacto pero no como teléfono.
    const solo = calcularFichaCompleta({ ...vacia, tieneContacto: true });
    expect(solo.faltan).toContain("teléfono");
    expect(solo.faltan).not.toContain("contacto");
  });

  it("completa es 100 %", () => {
    expect(
      calcularFichaCompleta({
        ruc: "20123456789",
        direccion: "Av. 1",
        telefono: "064123456",
        formaPago: "credito",
        tieneContacto: true,
        contactoConTelefono: false,
      })
    ).toEqual({ porcentaje: 100, faltan: [] });
  });
});

describe("precioDelDirectorio (lógica pura)", () => {
  const fila = (detalle: string, precio: number | null): FilaPrecioDto =>
    ({
      detalle,
      unidad: "galón",
      vigente: precio === null ? null : { id: 1, precio, desde: "2026-01-01", hasta: null },
    }) as unknown as FilaPrecioDto;

  it("muestra el primer precio vigente, o null si ninguno lo tiene", () => {
    expect(precioDelDirectorio([fila("Diésel B5", null), fila("GLP", 8.5)])).toEqual({
      producto: "GLP",
      precio: 8.5,
      unidad: "galón",
    });
    expect(precioDelDirectorio([fila("Diésel B5", null)])).toBeNull();
    expect(precioDelDirectorio([])).toBeNull();
  });
});

type Empresa = Awaited<ReturnType<typeof crearTenantDePrueba>>;
type Agente = ReturnType<typeof request.agent>;

describe("GET /api/erp/proveedores (Directorio)", () => {
  let a: Empresa;
  let admin: Agente;
  let operador: Agente;
  let proveedorId: number;

  const entrar = async (email: string) => {
    const ag = request.agent(app);
    const res = await ag
      .post("/api/auth/login")
      .send({ tenantSlug: a.tenant.slug, email, password: PASSWORD });
    expect(res.status).toBe(200);
    return ag;
  };
  const directorio = async (ag: Agente) => {
    const r = await ag.get("/api/erp/proveedores");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body as {
      id: number;
      ciudad: string | null;
      fichaCompleta: { porcentaje: number; faltan: string[] };
      precioVigente?: { producto: string; precio: number; unidad: string } | null;
    }[];
  };

  beforeAll(async () => {
    a = await crearTenantDePrueba(PASSWORD);
    const r = await request(app)
      .put(`/api/platform/tenants/${a.tenant.id}/modulos`)
      .set("Authorization", BEARER)
      .send({
        configuraciones: MODULOS.map((m) => ({
          modulo: m.id,
          estado: m.id === "proveedores" ? "habilitado" : "deshabilitado",
        })),
      });
    expect(r.status).toBe(200);
    proveedorId = await withTenant(
      a.tenant.id,
      async (cl) =>
        (
          await cl.query<{ id: number }>(
            `INSERT INTO combustible_grifos (tenant_id, nombre, abastece_ruta) VALUES ($1,'GRIFO DIR',true)
             RETURNING id`,
            [a.tenant.id]
          )
        ).rows[0].id
    );
    admin = await entrar(a.usuario.email);
    // Un operador SIN permisos de precios.
    const email = `operador-${a.tenant.slug}@test.local`;
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre: "Operador", email, password: PASSWORD, rol: "operador" });
    expect(alta.status, JSON.stringify(alta.body)).toBe(201);
    const id = alta.body.id as string;
    const permisos = await admin.get(`/api/erp/usuarios/${id}/permisos`);
    const guardado = await admin.put(`/api/erp/usuarios/${id}/permisos`).send({
      modulos: permisos.body.modulos.map(
        (m: { modulo: string; asignado: boolean; nivel: string }) => ({
          modulo: m.modulo,
          asignado: m.asignado,
          nivel: m.nivel,
        })
      ),
      pestanas: permisos.body.pestanas.map(
        (p: { modulo: string; pestana: string; permitido: boolean }) => ({
          modulo: p.modulo,
          pestana: p.pestana,
          permitido:
            p.modulo === "combustible" && p.pestana.endsWith(":precios") ? false : p.permitido,
        })
      ),
      motivo: "Sin precios",
    });
    expect(guardado.status, JSON.stringify(guardado.body)).toBe(200);
    operador = await entrar(email);
  });

  afterAll(async () => {
    await borrarTenantDePrueba(a.tenant.id);
    await closeDatabase();
  });

  it("un proveedor recién creado: sin ciudad, ficha en 20 % (solo el RUC cuenta si lo tiene) y sin precio", async () => {
    const [p] = await directorio(admin);
    expect(p).toMatchObject({ id: proveedorId, ciudad: null, precioVigente: null });
    expect(p.fichaCompleta.porcentaje).toBe(0);
    expect(p.fichaCompleta.faltan).toEqual([
      "RUC",
      "dirección",
      "teléfono",
      "contacto",
      "condición de pago",
    ]);
  });

  it("la ciudad y los datos de la ficha suben el porcentaje; el precio aparece para quien ve precios", async () => {
    const guardada = await admin.put(`/api/erp/proveedores/${proveedorId}/ficha`).send({
      ciudad: "  Huancayo ",
      direccion: "Av. Los Pinos 123",
      forma_pago: "credito",
      plazo_pago_dias: 30,
    });
    expect(guardada.status, JSON.stringify(guardada.body)).toBe(200);
    expect(guardada.body.ciudad).toBe("Huancayo");
    expect(
      (
        await admin.post(`/api/erp/proveedores/${proveedorId}/contactos`).send({
          nombre: "Rosa Quispe",
          telefono: "987654321",
          principal: true,
        })
      ).status
    ).toBe(201);
    const precio = await admin
      .post("/api/erp/proveedores/precios/combustible")
      .send({ tipo_combustible: "diesel_b5", grifo_ids: [proveedorId], precio_unitario: 15.8 });
    expect(precio.status, JSON.stringify(precio.body)).toBe(201);

    const [p] = await directorio(admin);
    expect(p.ciudad).toBe("Huancayo");
    // Dirección, condición de pago, contacto y su teléfono: 4 de 5 (falta el RUC).
    expect(p.fichaCompleta).toEqual({ porcentaje: 80, faltan: ["RUC"] });
  });

  it("quien no ve precios no recibe el campo, pero sí la ciudad y la ficha", async () => {
    const [p] = await directorio(operador);
    expect(p).not.toHaveProperty("precioVigente");
    expect(p.ciudad).toBe("Huancayo");
    expect(p.fichaCompleta.porcentaje).toBe(80);
  });

  it("el campo ciudad se valida (largo máximo) y se puede borrar", async () => {
    const put = (cuerpo: object) =>
      admin.put(`/api/erp/proveedores/${proveedorId}/ficha`).send(cuerpo);
    expect((await put({ ciudad: "x".repeat(81) })).status).toBe(400);
    expect((await put({ ciudad: "" })).body.ciudad).toBeNull();
  });
});
