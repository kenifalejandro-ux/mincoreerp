/** tests/proveedores-compras-api.test.ts
 *
 * Compras y recepciones (PR5): GET /api/erp/proveedores/compras, con base de datos.
 *
 * 1. Una empresa con SOLO el módulo `proveedores` (sin Combustible) ve las compras de cisterna con su
 *    estado y, si ya se recibió, lo descargado contra el documento.
 * 2. Mismas reglas que Combustible: quien gestiona compras (admin) ve todas; operador y Lectura solo las
 *    ya por llegar; sin la pestaña `cisternas`, 403.
 * 3. Con Combustible en la empresa rige el alcance por sede; sin él no hay alcance que aplicar.
 * 4. Otra empresa no ve estas compras.
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";
import { env } from "../src/server/config/env";
import { MODULOS } from "../src/modules/registry";

const BEARER = `Bearer ${env.platformAdminToken}`;
const PASSWORD = "ClaveDePrueba123";

type Empresa = Awaited<ReturnType<typeof crearTenantDePrueba>>;
type Agente = ReturnType<typeof request.agent>;
interface Compra {
  numeroDocumento: string;
  estado: string;
  total: number;
  sedeDeLlegada: string | null;
  motivoAnulacion: string | null;
  recepcion: { descargado: number; diferenciaGalones: number; fueraDeTolerancia: boolean } | null;
}
interface Respuesta {
  gestiona: boolean;
  tolerancia: number;
  compras: Compra[];
}

describe("Compras y recepciones (solo lectura)", () => {
  const empresas: Empresa[] = [];
  let a: Empresa; // solo Proveedores
  let b: Empresa; // otra empresa
  let c: Empresa; // Proveedores + Combustible, para el alcance por sede
  let admin: Agente;
  const docs = (r: Respuesta) => r.compras.map((x) => x.numeroDocumento).sort();

  const entrar = async (email: string, e: Empresa) => {
    const ag = request.agent(app);
    const res = await ag
      .post("/api/auth/login")
      .send({ tenantSlug: e.tenant.slug, email, password: PASSWORD });
    expect(res.status).toBe(200);
    return ag;
  };
  const modulos = async (e: Empresa, ids: string[]) => {
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
  const persona = async (ag: Agente, e: Empresa, rol: string) => {
    const email = `${rol}-${e.tenant.slug}@test.local`;
    const alta = await ag
      .post("/api/erp/usuarios")
      .send({ nombre: `Persona ${rol}`, email, password: PASSWORD, rol });
    expect(alta.status, JSON.stringify(alta.body)).toBe(201);
    return { id: alta.body.id as string, ag: await entrar(email, e) };
  };
  const dia = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

  /** Proveedor, sede y compras sembradas: registrada, por llegar, anulada y recibida. */
  const sembrar = async (e: Empresa, sufijo: string, sedeId?: number) =>
    withTenant(e.tenant.id, async (cl) => {
      const grifoInterno =
        sedeId ??
        (
          await cl.query<{ id: number }>(
            `SELECT id FROM grifos_internos WHERE tenant_id = $1 ORDER BY id LIMIT 1`,
            [e.tenant.id]
          )
        ).rows[0].id;
      const proveedor = (
        await cl.query<{ id: number }>(
          `INSERT INTO combustible_grifos (tenant_id, nombre, abastece_tanque) VALUES ($1,$2,true) RETURNING id`,
          [e.tenant.id, `PROVEEDOR ${sufijo}`]
        )
      ).rows[0].id;
      const nueva = async (
        doc: string,
        extra: { habilitada?: boolean; anulada?: boolean; llegada?: string }
      ) =>
        (
          await cl.query<{ id: number }>(
            `INSERT INTO combustible_compras_cisterna
               (tenant_id, grifo_interno_id, grifo_id, tipo_combustible, tipo_documento, numero_documento,
                fecha_compra, llegada_estimada, cantidad_facturada, costo_unitario,
                habilitada_en, anulada_en, motivo_anulacion)
             VALUES ($1,$2,$3,'diesel_b5','factura',$4,$5,$6,1000,15.5,$7,$8,$9) RETURNING id`,
            [
              e.tenant.id,
              grifoInterno,
              proveedor,
              `${doc}-${sufijo}`,
              dia(-5),
              extra.llegada ?? dia(10),
              extra.habilitada ? new Date() : null,
              extra.anulada ? new Date() : null,
              extra.anulada ? "factura duplicada" : null,
            ]
          )
        ).rows[0].id;
      await nueva("REG", {});
      await nueva("PORLLEGAR", { habilitada: true });
      await nueva("ANULADA", { anulada: true });
      const recibida = await nueva("RECIBIDA", { habilitada: true });
      const tanque = (
        await cl.query<{ id: number }>(
          `INSERT INTO combustible (tenant_id, tanque_nombre, capacidad_total, codigo, tipo_combustible, unidad, tipo_punto, grifo_interno_id)
           VALUES ($1,$2,5000,$3,'diesel_b5','gal','fijo',$4) RETURNING id`,
          [e.tenant.id, `Tanque ${sufijo}`, `TQ-${sufijo}`, grifoInterno]
        )
      ).rows[0].id;
      await cl.query(
        `INSERT INTO combustible_recepciones (tenant_id, combustible_id, grifo_id, cantidad, cantidad_derivada, costo_unitario, recibido_en, compra_id)
         VALUES ($1,$2,$3,900,50,15.5,now(),$4)`,
        [e.tenant.id, tanque, proveedor, recibida]
      );
      return { proveedor, grifoInterno };
    });

  beforeAll(async () => {
    a = await crearTenantDePrueba(PASSWORD);
    b = await crearTenantDePrueba(PASSWORD);
    c = await crearTenantDePrueba(PASSWORD);
    empresas.push(a, b, c);
    await modulos(a, ["proveedores"]);
    await modulos(b, ["proveedores"]);
    await modulos(c, ["proveedores", "combustible"]);
    await sembrar(a, "A");
    admin = await entrar(a.usuario.email, a);
  });

  afterAll(async () => {
    for (const e of empresas) await borrarTenantDePrueba(e.tenant.id);
    await closeDatabase();
  });

  it("sin Combustible, el admin ve todas las compras con su estado y la recepción de la recibida", async () => {
    const r = await admin.get("/api/erp/proveedores/compras");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const cuerpo = r.body as Respuesta;
    expect(cuerpo.gestiona).toBe(true);
    expect(cuerpo.tolerancia).toBe(3);
    const porDoc = Object.fromEntries(cuerpo.compras.map((x) => [x.numeroDocumento, x]));
    expect(porDoc["REG-A"].estado).toBe("registrada");
    expect(porDoc["PORLLEGAR-A"].estado).toBe("por_llegar");
    expect(porDoc["ANULADA-A"]).toMatchObject({
      estado: "anulada",
      motivoAnulacion: "factura duplicada",
    });
    expect(porDoc["RECIBIDA-A"].estado).toBe("recibida");
    expect(porDoc["RECIBIDA-A"].total).toBe(15500);
    // Descargado 900 al tanque + 50 repartidos contra 1000 del documento: llegó 50 gal menos.
    expect(porDoc["RECIBIDA-A"].recepcion).toMatchObject({
      descargado: 950,
      diferenciaGalones: -50,
      fueraDeTolerancia: true,
    });
  });

  it("cada compra trae su sede de llegada, «Sede · tanque», como se eligió al registrarla", async () => {
    const etiqueta = await withTenant(
      a.tenant.id,
      async (cl) =>
        (
          await cl.query<{ etiqueta: string }>(
            `SELECT s.nombre || ' · ' || g.nombre AS etiqueta
               FROM grifos_internos g JOIN sedes s ON s.id = g.sede_id AND s.tenant_id = g.tenant_id
              WHERE g.tenant_id = $1 ORDER BY g.id LIMIT 1`,
            [a.tenant.id]
          )
        ).rows[0].etiqueta
    );
    const r = await admin.get("/api/erp/proveedores/compras");
    const cuerpo = r.body as Respuesta;
    expect(cuerpo.compras.length).toBeGreaterThan(0);
    for (const compra of cuerpo.compras) expect(compra.sedeDeLlegada).toBe(etiqueta);
    expect(etiqueta).toContain(" · ");
  });

  it("el operador y Lectura solo ven las ya por llegar (como en Cisternas); sin la pestaña, 403", async () => {
    const operador = await persona(admin, a, "operador");
    const lectura = await persona(admin, a, "lectura");
    for (const ag of [operador.ag, lectura.ag]) {
      const r = await ag.get("/api/erp/proveedores/compras");
      expect(r.status).toBe(200);
      expect((r.body as Respuesta).gestiona).toBe(false);
      expect(docs(r.body)).toEqual(["PORLLEGAR-A"]);
    }
    // A un operador se le quita la pestaña Cisternas a mano.
    const permisos = await admin.get(`/api/erp/usuarios/${operador.id}/permisos`);
    const quitar = await admin.put(`/api/erp/usuarios/${operador.id}/permisos`).send({
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
          permitido: p.modulo === "combustible" && p.pestana === "cisternas" ? false : p.permitido,
        })
      ),
      motivo: "Sin cisternas",
    });
    expect(quitar.status, JSON.stringify(quitar.body)).toBe(200);
    const sin = await entrar(`operador-${a.tenant.slug}@test.local`, a);
    expect((await sin.get("/api/erp/proveedores/compras")).status).toBe(403);
  });

  it("otra empresa no ve estas compras", async () => {
    const adminB = await entrar(b.usuario.email, b);
    const r = await adminB.get("/api/erp/proveedores/compras");
    expect(r.status).toBe(200);
    expect((r.body as Respuesta).compras).toEqual([]);
  });

  it("con Combustible rige el alcance por sede: el operador asignado a una sola sede solo ve las de esa sede", async () => {
    const principal = await sembrar(c, "P");
    const otraSede = await withTenant(c.tenant.id, async (cl) => {
      const sede = (
        await cl.query<{ id: number }>(
          `INSERT INTO sedes (tenant_id, nombre) VALUES ($1,'Sede Dos') RETURNING id`,
          [c.tenant.id]
        )
      ).rows[0].id;
      return (
        await cl.query<{ id: number }>(
          `INSERT INTO grifos_internos (tenant_id, sede_id, nombre) VALUES ($1,$2,'Grifo Dos') RETURNING id`,
          [c.tenant.id, sede]
        )
      ).rows[0].id;
    });
    await sembrar(c, "D", otraSede);
    const adminC = await entrar(c.usuario.email, c);
    const todas = await adminC.get("/api/erp/proveedores/compras");
    expect(docs(todas.body)).toEqual(
      [
        "ANULADA-D",
        "ANULADA-P",
        "PORLLEGAR-D",
        "PORLLEGAR-P",
        "RECIBIDA-D",
        "RECIBIDA-P",
        "REG-D",
        "REG-P",
      ].sort()
    );
    const operador = await persona(adminC, c, "operador");
    await withTenant(c.tenant.id, async (cl) => {
      await cl.query(`UPDATE usuarios SET alcance_combustible = 'asignado' WHERE id = $1`, [
        operador.id,
      ]);
      await cl.query(
        `INSERT INTO usuario_accesos_combustible (tenant_id, usuario_id, grifo_interno_id) VALUES ($1,$2,$3)`,
        [c.tenant.id, operador.id, otraSede]
      );
    });
    const r = await operador.ag.get("/api/erp/proveedores/compras");
    expect(r.status).toBe(200);
    expect(docs(r.body)).toEqual(["PORLLEGAR-D"]);
    expect(principal.grifoInterno).not.toBe(otraSede);
  });
});
