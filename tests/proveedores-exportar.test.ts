/** tests/proveedores-exportar.test.ts
 *
 * Exportar el Directorio a Excel. Lógica del cliente (las filas y el nombre del archivo) y API
 * `GET /api/erp/proveedores/exportar`: trae lo que ve la persona más dirección, teléfono y correo; con `ids`,
 * solo esos; el precio solo si ve precios; jamás cuentas bancarias; y cada exportación queda en la bitácora.
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba } from "./helpers";
import { closeDatabase, pool } from "../src/server/config/database";
import { env } from "../src/server/config/env";
import { MODULOS } from "../src/modules/registry";
import {
  filasDelExcel,
  nombreDelArchivo,
  type ProveedorParaExportar,
} from "../client/src/components/proveedores/filasProveedores";

const prov = (id: number, extra: Partial<ProveedorParaExportar> = {}): ProveedorParaExportar => ({
  id,
  codigo: `PRV-00${id}`,
  nombre: `PROVEEDOR ${id}`,
  ruc: null,
  activo: true,
  tipos: ["Combustible"],
  combustible: { interno: true, externo: false },
  urea: { interno: false, externo: false },
  ciudad: null,
  fichaCompleta: { porcentaje: 40, faltan: [] },
  direccion: null,
  telefono: null,
  correo: null,
  ...extra,
});

describe("filasDelExcel (lógica pura)", () => {
  it("una fila por proveedor con las columnas del directorio y los datos de contacto", () => {
    const [fila] = filasDelExcel([
      prov(1, {
        nombre: "GRIFO SANTA ROSA",
        ruc: "20123456789",
        ciudad: "Huancayo",
        direccion: "Av. Los Pinos 123",
        telefono: "064123456",
        correo: "ventas@grifo.pe",
        tipos: ["Combustible", "Urea"],
        combustible: { interno: false, externo: true },
        urea: { interno: true, externo: false },
        activo: false,
        fichaCompleta: { porcentaje: 80, faltan: [] },
      }),
    ]);
    expect(fila).toEqual({
      Código: "PRV-001",
      "Razón social": "GRIFO SANTA ROSA",
      RUC: "20123456789",
      Tipo: "Combustible, Urea",
      "Abastece a": "Interno y Externo",
      Ciudad: "Huancayo",
      Dirección: "Av. Los Pinos 123",
      Teléfono: "064123456",
      Correo: "ventas@grifo.pe",
      Estado: "Desactivado",
      "Ficha completa (%)": 80,
    });
  });

  it("lo que falta sale vacío, no «null»", () => {
    const [fila] = filasDelExcel([prov(2)]);
    expect(fila).toMatchObject({ RUC: "", Ciudad: "", Dirección: "", Teléfono: "", Correo: "" });
  });

  it("la columna de precio solo existe si la persona ve precios; sin precio dice «Sin precio»", () => {
    expect("Precio vigente" in filasDelExcel([prov(1)])[0]).toBe(false);
    const filas = filasDelExcel([
      prov(1, { precioVigente: { producto: "Diésel B5", precio: 15.8, unidad: "galón" } }),
      prov(2, { precioVigente: null }),
    ]);
    expect(filas[0]["Precio vigente"]).toBe("S/ 15.80 (Diésel B5)");
    expect(filas[1]["Precio vigente"]).toBe("Sin precio");
  });

  it("nunca trae cuentas bancarias, ni una columna de banco", () => {
    const columnas = Object.keys(filasDelExcel([prov(1)])[0])
      .join(" ")
      .toLowerCase();
    expect(columnas).not.toMatch(/banco|cuenta|titular|\bcci\b/);
  });

  it("el archivo se llama proveedores-AAAA-MM-DD.xlsx (día de Lima)", () => {
    expect(nombreDelArchivo(Date.parse("2026-11-23T03:00:00Z"))).toBe(
      "proveedores-2026-11-22.xlsx"
    );
    expect(nombreDelArchivo(Date.parse("2026-11-23T15:00:00Z"))).toBe(
      "proveedores-2026-11-23.xlsx"
    );
  });
});

const BEARER = `Bearer ${env.platformAdminToken}`;
const PASSWORD = "ClaveDePrueba123";
type Empresa = Awaited<ReturnType<typeof crearTenantDePrueba>>;
type Agente = ReturnType<typeof request.agent>;

describe("GET /api/erp/proveedores/exportar", () => {
  const empresas: Empresa[] = [];
  let a: Empresa;
  let b: Empresa;
  let admin: Agente;
  let adminB: Agente;
  let lectura: Agente;
  let id1: number;
  let id2: number;

  const entrar = async (email: string, e: Empresa) => {
    const ag = request.agent(app);
    const res = await ag
      .post("/api/auth/login")
      .send({ tenantSlug: e.tenant.slug, email, password: PASSWORD });
    expect(res.status).toBe(200);
    return ag;
  };
  const ponerModulos = async (e: Empresa, ids: string[]) => {
    const r = await request(app)
      .put(`/api/platform/tenants/${e.tenant.id}/modulos`)
      .set("Authorization", BEARER)
      .send({
        configuraciones: MODULOS.map((m) => ({
          modulo: m.id,
          estado: ids.includes(m.id) ? "habilitado" : "deshabilitado",
        })),
      });
    expect(r.status).toBe(200);
  };
  const nuevo = async (ag: Agente, nombre: string) => {
    const r = await ag.post("/api/erp/proveedores").send({
      nombre,
      ruc: "",
      abastece_tanque: false,
      abastece_ruta: true,
      abastece_urea: false,
      abastece_urea_ruta: false,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as number;
  };

  beforeAll(async () => {
    a = await crearTenantDePrueba(PASSWORD);
    b = await crearTenantDePrueba(PASSWORD);
    empresas.push(a, b);
    await ponerModulos(a, ["proveedores", "combustible"]);
    await ponerModulos(b, ["proveedores"]);
    admin = await entrar(a.usuario.email, a);
    adminB = await entrar(b.usuario.email, b);
    id1 = await nuevo(admin, "EXPORTABLE UNO");
    id2 = await nuevo(admin, "EXPORTABLE DOS");
    await nuevo(adminB, "DE OTRA EMPRESA");
    expect(
      (
        await admin.put(`/api/erp/proveedores/${id1}/ficha`).send({
          ciudad: "Lima",
          direccion: "Av. 1",
          telefono: "064123456",
          correo: "uno@grifo.pe",
        })
      ).status
    ).toBe(200);
    // Una cuenta bancaria: es lo que JAMÁS debe salir.
    const cuenta = await admin.post(`/api/erp/proveedores/${id1}/cuentas`).send({
      banco: "BBVA",
      tipo_cuenta: "corriente",
      moneda: "PEN",
      titular: "TITULAR SECRETO",
      numero: "00110012345678901234",
      principal: true,
    });
    expect(cuenta.status, JSON.stringify(cuenta.body)).toBe(201);
    const alta = await admin.post("/api/erp/usuarios").send({
      nombre: "Persona lectura",
      email: `lectura-${a.tenant.slug}@test.local`,
      password: PASSWORD,
      rol: "lectura",
    });
    expect(alta.status, JSON.stringify(alta.body)).toBe(201);
    lectura = await entrar(`lectura-${a.tenant.slug}@test.local`, a);
  });

  afterAll(async () => {
    for (const e of empresas) await borrarTenantDePrueba(e.tenant.id);
    await closeDatabase();
  });

  const auditorias = async () =>
    (
      await pool.query<{ detalle: Record<string, unknown> }>(
        `SELECT detalle FROM platform_audit_log
          WHERE tenant_id = $1 AND accion = 'proveedores.exportar' ORDER BY id`,
        [a.tenant.id]
      )
    ).rows.map((f) => f.detalle);

  it("trae el directorio de la empresa con dirección, teléfono y correo, y solo el de ella", async () => {
    const r = await admin.get("/api/erp/proveedores/exportar");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    const filas = r.body as {
      id: number;
      nombre: string;
      direccion: string | null;
      correo: string | null;
    }[];
    const uno = filas.find((f) => f.id === id1);
    expect(uno).toMatchObject({
      nombre: "EXPORTABLE UNO",
      ciudad: "Lima",
      direccion: "Av. 1",
      telefono: "064123456",
      correo: "uno@grifo.pe",
    });
    expect(filas.find((f) => f.id === id2)).toMatchObject({ direccion: null, correo: null });
    expect(JSON.stringify(filas)).not.toContain("DE OTRA EMPRESA");
  });

  it("jamás trae cuentas bancarias, ni el número ni los últimos dígitos ni el titular", async () => {
    const texto = JSON.stringify((await admin.get("/api/erp/proveedores/exportar")).body);
    // Ni siquiera una propiedad con ese nombre.
    expect(texto).not.toMatch(/"(banco|cuentas?|titular|numero_ultimos4|cci)"/i);
    for (const secreto of [
      "TITULAR SECRETO",
      "BBVA",
      "00110012345678901234",
      "901234",
      "corriente",
    ]) {
      expect(texto, secreto).not.toContain(secreto);
    }
  });

  it("con ids trae solo esos; una lista vacía, ninguno; una inválida, 400", async () => {
    const dos = await admin.get(`/api/erp/proveedores/exportar?ids=${id2}`);
    expect((dos.body as { id: number }[]).map((f) => f.id)).toEqual([id2]);
    expect((await admin.get("/api/erp/proveedores/exportar?ids=")).body).toEqual([]);
    for (const mala of ["abc", "1,x", "1,,2", "-3", "1.5"]) {
      expect((await admin.get(`/api/erp/proveedores/exportar?ids=${mala}`)).status, mala).toBe(400);
    }
    // `ids` repetido o con corchetes llega como arreglo: antes se ignoraba y exportaba TODO sin decirlo.
    for (const rara of [`ids=${id2}&ids=${id2}`, `ids[]=${id2}`, `ids[a]=${id2}`]) {
      expect((await admin.get(`/api/erp/proveedores/exportar?${rara}`)).status, rara).toBe(400);
    }
  });

  it("el precio vigente solo viaja para quien ve precios", async () => {
    const admin_ = (await admin.get("/api/erp/proveedores/exportar")).body as Record<
      string,
      unknown
    >[];
    expect(admin_.every((f) => "precioVigente" in f)).toBe(true);
    const sin = (await lectura.get("/api/erp/proveedores/exportar")).body as Record<
      string,
      unknown
    >[];
    expect(sin.length).toBeGreaterThan(0);
    expect(sin.some((f) => "precioVigente" in f)).toBe(false);
  });

  it("cada exportación queda en la bitácora con cuántos; no con el contenido", async () => {
    const antes = (await auditorias()).length;
    await admin.get("/api/erp/proveedores/exportar");
    await admin.get(`/api/erp/proveedores/exportar?ids=${id1},${id2}`);
    const nuevas = (await auditorias()).slice(antes);
    expect(nuevas).toHaveLength(2);
    expect(nuevas[0].filtrado).toBeUndefined();
    expect(nuevas[1]).toEqual({ filas: 2, filtrado: true });
    expect(JSON.stringify(nuevas)).not.toContain("EXPORTABLE");
    // El Historial lo dice.
    const h = await admin.get("/api/erp/proveedores/historial?categoria=proveedor");
    const e = (h.body.eventos as { titulo: string; lineas: string[] }[]).find(
      (x) =>
        x.titulo === "Exportó el directorio a Excel" &&
        x.lineas.includes("Solo lo filtrado en pantalla")
    );
    expect(e?.lineas).toEqual(["2 proveedores", "Solo lo filtrado en pantalla"]);
  });

  it("otra empresa solo exporta lo suyo", async () => {
    const r = await adminB.get("/api/erp/proveedores/exportar");
    expect((r.body as { nombre: string }[]).map((f) => f.nombre)).toEqual(["DE OTRA EMPRESA"]);
  });
});
