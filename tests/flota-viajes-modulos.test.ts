/** tests/flota-viajes-modulos.test.ts
 *
 * Los módulos `flota` (Gestión operacional de flota, antes `equipos`) y
 * `viajes` (migraciones 0165 y 0166). Lo que se fija acá:
 *
 * 1. Que el renombre no deje rastros: el enum no conserva `equipos` y los
 *    límites de cuota se identifican con el id nuevo (si no, el tope de
 *    unidades se ignoraría en silencio).
 * 2. Que el traspaso de accesos de 0166 le dé a cada empresa y a cada usuario
 *    lo que ya tenía, y nada más: `viajes` a quien tenía Combustible, `flota`
 *    solo a la empresa (nunca al usuario: le abriría Registro de unidades), y
 *    nada a quien no tenía Combustible. Y que correrlo dos veces no cambie nada.
 * 3. Que `viajes` exija `flota`, tanto al encenderlo desde plataforma como al
 *    calcular qué módulos ve cada usuario.
 * 4. Que el conductor de ruta entre a Viajes ("Mi viaje") y el resto de los
 *    perfiles de cancha no.
 * 5. Que la URL de Equipos no haya cambiado con el id.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { pool, closeDatabase } from "../src/server/config/database";
import { env } from "../src/server/config/env";
import { MODULOS } from "../src/modules/registry";
import {
  requireModulo,
  requireNivelParaEscribir,
} from "../src/server/shared/middlewares/modulo.middleware";
import {
  exportarPlataformaService,
  restaurarBackupPlataformaService,
} from "../src/server/services/platformBackupPlataforma.service";
import { guardarBackup, leerBackup } from "../src/server/services/platformBackupStorage";
import type { ContextoAuditoria } from "../src/server/services/platformAudit.service";

const BEARER = `Bearer ${env.platformAdminToken}`;
const PASSWORD = "ClaveDePrueba123";
const SQL_ACCESOS = fs.readFileSync(
  path.resolve(__dirname, "../migrations/0166_modulos_flota_viajes_accesos.sql"),
  "utf-8"
);

type Empresa = Awaited<ReturnType<typeof crearTenantDePrueba>>;

/** Prepara una empresa con Combustible y un usuario, corre el SQL de la
 *  migración y mira el resultado -- todo dentro de una transacción que se
 *  deshace.
 *
 *  La migración recorre TODAS las empresas y usuarios de la base. Con las tablas
 *  reales, otro archivo de test que borra su empresa justo en ese momento hace
 *  fallar la clave foránea (la migración copia una fila que ya no existe): la
 *  suite corre en paralelo. Por eso la migración se corre sobre copias TEMPORALES
 *  de `tenant_modulos`, `usuario_modulos` y `usuarios` (los nombres sin esquema
 *  resuelven primero a las temporales): solo ven lo que este test les pone, no
 *  bloquean ni leen nada de los demás, y el `ALTER TABLE usuarios` de la ventana
 *  NO FORCE cae sobre la copia y no toca la tabla real. Lo que se prueba es la
 *  lógica del SQL; el RLS y la clave foránea reales se comprobaron aparte. */
async function conTraspaso<T>(
  preparar: (c: import("pg").PoolClient) => Promise<void>,
  leer: (c: import("pg").PoolClient) => Promise<T>,
  pasadas = 1
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL lock_timeout = '10s'");
    for (const tabla of ["tenant_modulos", "usuario_modulos"]) {
      await c.query(
        `CREATE TEMP TABLE ${tabla} (LIKE public.${tabla} INCLUDING ALL) ON COMMIT DROP`
      );
    }
    await c.query(`CREATE TEMP TABLE usuarios (id uuid PRIMARY KEY) ON COMMIT DROP`);
    await preparar(c);
    // Los usuarios que el test dio de alta "existen" para la migración.
    await c.query(`INSERT INTO usuarios SELECT DISTINCT usuario_id FROM usuario_modulos`);
    for (let i = 0; i < pasadas; i++) await c.query(SQL_ACCESOS);
    return await leer(c);
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    c.release();
  }
}

describe("módulos flota y viajes", () => {
  const empresas: Empresa[] = [];
  const nueva = async () => {
    const e = await crearTenantDePrueba(PASSWORD);
    empresas.push(e);
    return e;
  };

  afterAll(async () => {
    for (const e of empresas) await borrarTenantDePrueba(e.tenant.id);
    await closeDatabase();
  });

  describe("el renombre de 0165", () => {
    it("el enum tiene `flota` y `viajes` y ya no tiene `equipos`", async () => {
      const r = await pool.query<{ m: string }>(
        `SELECT unnest(enum_range(NULL::modulo_erp))::text AS m`
      );
      const modulos = r.rows.map((x) => x.m);
      expect(modulos).toContain("flota");
      expect(modulos).toContain("viajes");
      expect(modulos).not.toContain("equipos");
    });

    it("los límites de cuota se identifican con `flota`: no queda ninguno con `equipos`", async () => {
      const planes = await pool.query(`SELECT 1 FROM plan_limites WHERE recurso = 'equipos'`);
      const empresasConTope = await pool.query(
        `SELECT 1 FROM tenant_cuotas WHERE recurso = 'equipos'`
      );
      expect(planes.rowCount).toBe(0);
      expect(empresasConTope.rowCount).toBe(0);
    });

    it("el módulo sigue montado en /api/erp/equipos y NO en /api/erp/flota", async () => {
      const e = await nueva();
      const admin = request.agent(app);
      await admin
        .post("/api/auth/login")
        .send({ tenantSlug: e.tenant.slug, email: e.usuario.email, password: PASSWORD })
        .expect(200);

      expect((await admin.get("/api/erp/equipos")).status).toBe(200);
      expect((await admin.get("/api/erp/flota")).status).toBe(404);
      // El registro lo dice explícito: el id gobierna el acceso, la ruta dónde se monta.
      const flota = MODULOS.find((m) => m.id === "flota");
      expect(flota?.ruta).toBe("equipos");
    });
  });

  describe("el traspaso de accesos de 0166", () => {
    it("una empresa con Combustible recibe `flota` y `viajes` con su mismo estado; el usuario, solo `viajes` con su mismo nivel", async () => {
      const e = await nueva();
      const r = await conTraspaso(
        async (c) => {
          await c.query(`DELETE FROM tenant_modulos WHERE tenant_id = $1`, [e.tenant.id]);
          await c.query(
            `INSERT INTO tenant_modulos (tenant_id, modulo, estado, rollout_porcentaje, version)
             VALUES ($1, 'combustible', 'rollout', 40, 'v2')`,
            [e.tenant.id]
          );
          await c.query(`DELETE FROM usuario_modulos WHERE usuario_id = $1`, [e.usuario.id]);
          await c.query(
            `INSERT INTO usuario_modulos (usuario_id, modulo, nivel) VALUES ($1, 'combustible', 'consultas')`,
            [e.usuario.id]
          );
        },
        async (c) => ({
          empresa: (
            await c.query(
              `SELECT modulo::text, estado, rollout_porcentaje, version FROM tenant_modulos
                WHERE tenant_id = $1 ORDER BY modulo::text`,
              [e.tenant.id]
            )
          ).rows,
          usuario: (
            await c.query(
              `SELECT modulo::text, nivel::text FROM usuario_modulos WHERE usuario_id = $1
                ORDER BY modulo::text`,
              [e.usuario.id]
            )
          ).rows,
        })
      );

      expect(r.empresa).toEqual([
        { modulo: "combustible", estado: "rollout", rollout_porcentaje: 40, version: "v2" },
        { modulo: "flota", estado: "rollout", rollout_porcentaje: 40, version: "v2" },
        { modulo: "viajes", estado: "rollout", rollout_porcentaje: 40, version: "v2" },
      ]);
      // `flota` NO: le abriría Registro de unidades a quien el administrador no se lo dio.
      expect(r.usuario).toEqual([
        { modulo: "combustible", nivel: "consultas" },
        { modulo: "viajes", nivel: "consultas" },
      ]);
    });

    it("una empresa y un usuario SIN Combustible no reciben nada", async () => {
      const e = await nueva();
      const r = await conTraspaso(
        async (c) => {
          await c.query(`DELETE FROM tenant_modulos WHERE tenant_id = $1`, [e.tenant.id]);
          await c.query(
            `INSERT INTO tenant_modulos (tenant_id, modulo, estado) VALUES ($1, 'repuestos', 'habilitado')`,
            [e.tenant.id]
          );
          await c.query(`DELETE FROM usuario_modulos WHERE usuario_id = $1`, [e.usuario.id]);
          await c.query(
            `INSERT INTO usuario_modulos (usuario_id, modulo, nivel) VALUES ($1, 'repuestos', 'operar')`,
            [e.usuario.id]
          );
        },
        async (c) => ({
          empresa: (
            await c.query(`SELECT modulo::text FROM tenant_modulos WHERE tenant_id = $1`, [
              e.tenant.id,
            ])
          ).rows.map((x) => x.modulo),
          usuario: (
            await c.query(`SELECT modulo::text FROM usuario_modulos WHERE usuario_id = $1`, [
              e.usuario.id,
            ])
          ).rows.map((x) => x.modulo),
        })
      );
      expect(r.empresa).toEqual(["repuestos"]);
      expect(r.usuario).toEqual(["repuestos"]);
    });

    it("una empresa con Combustible DESHABILITADO no recibe nada", async () => {
      const e = await nueva();
      const r = await conTraspaso(
        async (c) => {
          await c.query(`DELETE FROM tenant_modulos WHERE tenant_id = $1`, [e.tenant.id]);
          await c.query(
            `INSERT INTO tenant_modulos (tenant_id, modulo, estado) VALUES ($1, 'combustible', 'deshabilitado')`,
            [e.tenant.id]
          );
        },
        async (c) =>
          (
            await c.query(`SELECT modulo::text FROM tenant_modulos WHERE tenant_id = $1`, [
              e.tenant.id,
            ])
          ).rows.map((x) => x.modulo)
      );
      expect(r).toEqual(["combustible"]);
    });

    it("correrlo dos veces deja exactamente lo mismo (idempotente) y no pisa lo que se cambió después", async () => {
      const e = await nueva();
      const leer = async (c: import("pg").PoolClient) =>
        (
          await c.query(
            `SELECT modulo::text, estado FROM tenant_modulos WHERE tenant_id = $1 ORDER BY modulo::text`,
            [e.tenant.id]
          )
        ).rows;
      const prep = async (c: import("pg").PoolClient) => {
        await c.query(`DELETE FROM tenant_modulos WHERE tenant_id = $1`, [e.tenant.id]);
        await c.query(
          `INSERT INTO tenant_modulos (tenant_id, modulo, estado) VALUES
             ($1, 'combustible', 'habilitado'), ($1, 'viajes', 'deshabilitado')`,
          [e.tenant.id]
        );
      };
      const unaVez = await conTraspaso(prep, leer, 1);
      const dosVeces = await conTraspaso(prep, leer, 2);
      expect(dosVeces).toEqual(unaVez);
      // El `viajes` que el administrador ya había apagado se respeta.
      expect(unaVez.find((x) => x.modulo === "viajes")?.estado).toBe("deshabilitado");
    });
  });

  describe("`viajes` exige `flota`", () => {
    const configuracion = (estados: Record<string, "habilitado" | "deshabilitado">) =>
      MODULOS.map((m) => ({ modulo: m.id, estado: estados[m.id] ?? "habilitado" }));

    const ponerModulos = (
      tenantId: string,
      estados: Record<string, "habilitado" | "deshabilitado">
    ) =>
      request(app)
        .put(`/api/platform/tenants/${tenantId}/modulos`)
        .set("Authorization", BEARER)
        .send({ configuraciones: configuracion(estados) });

    const modulosQueVe = async (e: Empresa) => {
      const res = await request(app)
        .post("/api/auth/login")
        .send({ tenantSlug: e.tenant.slug, email: e.usuario.email, password: PASSWORD });
      expect(res.status).toBe(200);
      return res.body.usuario.modulosPermitidos as string[];
    };

    it("plataforma rechaza encender Viajes si la empresa no tiene Flota, y lo acepta con Flota", async () => {
      const e = await nueva();
      const sinFlota = await ponerModulos(e.tenant.id, { flota: "deshabilitado" });
      expect(sinFlota.status).toBe(400);
      expect(JSON.stringify(sinFlota.body)).toMatch(/requiere/i);

      const conFlota = await ponerModulos(e.tenant.id, {});
      expect(conFlota.status).toBe(200);
    });

    it("apagar los dos a la vez es válido", async () => {
      const e = await nueva();
      const res = await ponerModulos(e.tenant.id, {
        flota: "deshabilitado",
        viajes: "deshabilitado",
      });
      expect(res.status).toBe(200);
    });

    it("un usuario con `viajes` asignado NO lo ve si su empresa no tiene Flota (aunque la fila exista)", async () => {
      const e = await nueva();
      expect(await modulosQueVe(e)).toContain("viajes");

      // Por fuera de la API, que ya lo impediría: la empresa pierde Flota y el usuario conserva su fila.
      await pool.query(
        `UPDATE tenant_modulos SET estado = 'deshabilitado' WHERE tenant_id = $1 AND modulo = 'flota'`,
        [e.tenant.id]
      );
      const ve = await modulosQueVe(e);
      expect(ve).not.toContain("viajes");
      expect(ve).not.toContain("flota");
      expect(ve).toContain("combustible");
    });
  });

  describe("perfiles de cancha", () => {
    let e: Empresa;
    let admin: ReturnType<typeof request.agent>;

    beforeAll(async () => {
      e = await nueva();
      admin = request.agent(app);
      await admin
        .post("/api/auth/login")
        .send({ tenantSlug: e.tenant.slug, email: e.usuario.email, password: PASSWORD })
        .expect(200);
    });

    const permisosDeNuevo = async (rol: string) => {
      const alta = await admin.post("/api/erp/usuarios").send({
        nombre: `Perfil ${rol}`,
        email: `${idUnico(rol)}@test.local`,
        password: PASSWORD,
        rol,
      });
      expect(alta.status).toBe(201);
      const res = await admin.get(`/api/erp/usuarios/${alta.body.id}/permisos`);
      expect(res.status).toBe(200);
      const asignados = (res.body.modulos as { modulo: string; asignado: boolean; nivel: string }[])
        .filter((m) => m.asignado)
        .map((m) => `${m.modulo}:${m.nivel}`)
        .sort();
      return asignados;
    };

    it("el conductor de ruta nace con Combustible y Viajes (Mi viaje), sin Flota", async () => {
      expect(await permisosDeNuevo("conductor_ruta")).toEqual([
        "combustible:operar",
        "viajes:operar",
      ]);
    });

    it("el grifero y el encargado de urea siguen solo con Combustible", async () => {
      expect(await permisosDeNuevo("grifero")).toEqual(["combustible:operar"]);
      expect(await permisosDeNuevo("encargado_urea")).toEqual(["combustible:operar"]);
    });
  });

  describe("correcciones de la auditoría", () => {
    it("0166: una empresa con Combustible y `flota` deshabilitada (heredada de Equipos) queda con `flota` y `viajes` habilitados; un `viajes` apagado a mano se respeta", async () => {
      const e = await nueva();
      const r = await conTraspaso(
        async (c) => {
          await c.query(`DELETE FROM tenant_modulos WHERE tenant_id = $1`, [e.tenant.id]);
          await c.query(
            `INSERT INTO tenant_modulos (tenant_id, modulo, estado) VALUES
               ($1, 'combustible', 'habilitado'), ($1, 'flota', 'deshabilitado')`,
            [e.tenant.id]
          );
        },
        async (c) =>
          (
            await c.query(
              `SELECT modulo::text, estado FROM tenant_modulos WHERE tenant_id = $1 ORDER BY modulo::text`,
              [e.tenant.id]
            )
          ).rows
      );
      expect(r).toEqual([
        { modulo: "combustible", estado: "habilitado" },
        { modulo: "flota", estado: "habilitado" },
        { modulo: "viajes", estado: "habilitado" },
      ]);
    });

    it("el interruptor global rechaza encender Viajes si alguna empresa no tiene Flota, y apagar Flota si alguna tiene Viajes", async () => {
      const e = await nueva();
      // Esta empresa no tiene ni Flota ni Viajes; el resto de las de la base sí tienen ambos.
      await request(app)
        .put(`/api/platform/tenants/${e.tenant.id}/modulos`)
        .set("Authorization", BEARER)
        .send({
          configuraciones: MODULOS.map((m) => ({
            modulo: m.id,
            estado: m.id === "flota" || m.id === "viajes" ? "deshabilitado" : "habilitado",
          })),
        })
        .expect(200);

      const encender = await request(app)
        .put(`/api/platform/modulos/viajes/global`)
        .set("Authorization", BEARER)
        .send({ estado: "habilitado" });
      expect(encender.status).toBe(400);
      expect(JSON.stringify(encender.body)).toMatch(/requiere/i);

      // Otra empresa con Viajes encendido: apagar Flota para todas dejaría Viajes sin su base.
      const otra = await nueva();
      const apagar = await request(app)
        .put(`/api/platform/modulos/flota/global`)
        .set("Authorization", BEARER)
        .send({ estado: "deshabilitado" });
      expect(apagar.status).toBe(400);
      expect(JSON.stringify(apagar.body)).toMatch(/apágalo primero/i);
      const intacta = await pool.query(
        `SELECT estado FROM tenant_modulos WHERE tenant_id = $1 AND modulo = 'flota'`,
        [otra.tenant.id]
      );
      expect(intacta.rows[0].estado).toBe("habilitado");
    });

    it("un backup de plataforma anterior al renombre (con `equipos`, sin `viajes`) se restaura sin error", async () => {
      const contexto: ContextoAuditoria = {
        ip: "127.0.0.1",
        actorType: "platform_admin",
        actorLabel: "test",
      };
      const backup = await exportarPlataformaService(contexto);
      const ubicacion = { storage: backup.storage, key: backup.storageKey };
      const contenido = JSON.parse(await leerBackup(ubicacion));
      for (const tabla of ["tenant_modulos", "usuario_modulos"]) {
        contenido.tablas[tabla] = (contenido.tablas[tabla] as { modulo: string }[])
          .filter((f) => f.modulo !== "viajes")
          .map((f) => (f.modulo === "flota" ? { ...f, modulo: "equipos" } : f));
      }
      await guardarBackup(backup.storageKey, JSON.stringify(contenido));

      await expect(restaurarBackupPlataformaService(backup.id, contexto)).resolves.toBeDefined();
    });

    it("un token anterior al renombre (`equipos`) sigue abriendo Flota, y en consultas SIGUE sin escribir", () => {
      const pasa = (
        mw: (req: never, res: never, next: () => void) => void,
        usuario: object,
        metodo = "GET"
      ) => {
        let siguio = false;
        let estado = 0;
        const res = { status: (n: number) => ({ json: () => void (estado = n) }) };
        mw({ usuario, method: metodo } as never, res as never, () => (siguio = true));
        return { siguio, estado };
      };
      const viejo = { rol: "operador", modulosPermitidos: ["equipos"], modulosConsulta: [] };
      expect(pasa(requireModulo("flota"), viejo).siguio).toBe(true);
      expect(pasa(requireModulo("flota"), { ...viejo, modulosPermitidos: [] }).estado).toBe(403);

      const enConsulta = { ...viejo, modulosConsulta: ["equipos"] };
      expect(pasa(requireNivelParaEscribir("flota"), enConsulta, "POST").estado).toBe(403);
      expect(pasa(requireNivelParaEscribir("flota"), viejo, "POST").siguio).toBe(true);
    });
  });
});
