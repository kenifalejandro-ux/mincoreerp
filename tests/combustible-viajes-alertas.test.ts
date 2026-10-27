/** tests/combustible-viajes-alertas.test.ts
 *
 * Las alertas de un viaje en curso (migración 0156), las dos ESTADOS que nacen en el worker:
 *   - viaje_demorado: el tramo en el que va ya pasó lo que suele tardar (mediana de unidades del
 *     mismo tipo) más un margen (15 % y al menos 30 min), SIN contar el tiempo detenido.
 *   - viaje_detenido: hay una avería, accidente, huaico, bloqueo o tráfico abierto.
 * Se cierran solas cuando el viaje se anula, llega o la detención termina.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";
import { CombustibleService } from "../src/modules/combustible/combustible.service";
import { MODULOS } from "../src/modules/registry";
import { correrConciliacion } from "../src/server/services/combustibleConciliacion.worker";

const password = "ClaveDePrueba123";
const H = 3_600_000;
const hace = (h: number) => new Date(Date.now() - h * H).toISOString();

describe("combustible: alertas de un viaje en curso (0156)", () => {
  let tenantId: string;
  const admin = request.agent(app);
  let seq = 0;

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: c.tenant.slug, email: c.usuario.email, password });
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  const lugar = async (nombre: string) =>
    Number(
      (await admin.post("/api/erp/combustible/lugares").send({ nombre: idUnico(nombre) })).body.id
    );
  const unidad = async () => {
    const dni = String(42000000 + seq++);
    const r = await admin.post("/api/erp/equipos").send({
      placa_codigo: idUnico("VQ"),
      tipo: "VOLQUETE",
      tipo_medidor: "odometro",
      conductor_nombre: "Juan Pérez",
      conductor_dni: dni,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return { id: Number(r.body.id), dni };
  };
  const viaje = async (a: number, b: number, inicio: string, fin?: string) => {
    const u = await unidad();
    const r = await admin.post("/api/erp/combustible/viajes").send({
      equipo_id: u.id,
      origen_id: a,
      destino_id: b,
      inicio_en: inicio,
      ...(fin ? { fin_en: fin } : {}),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return { id: Number(r.body.id), dni: u.dni };
  };
  /** Tres viajes cerrados de 4 h en la ruta: lo que suele tardar son 240 min. */
  const historial = async (a: number, b: number, cuantos = 3) => {
    for (let i = 0; i < cuantos; i++) await viaje(a, b, hace(110 + i * 10), hace(106 + i * 10));
  };
  const descanso = (viajeId: number, dni: string, motivo: string, inicio: string, fin?: string) =>
    withTenant(tenantId, (c) =>
      c.query(
        `INSERT INTO combustible_viaje_descansos
           (tenant_id, viaje_id, conductor_dni, inicio_en, fin_en, motivo, donde, inicio_por, fin_por)
         VALUES ($1, $2, $3, $4, $5, $6, 'En ruta', 'oficina', $7)`,
        [tenantId, viajeId, dni, inicio, fin ?? null, motivo, fin ? "oficina" : null]
      )
    );
  const alertas = (viajeId: number, tipo: string) =>
    withTenant(tenantId, async (c) => {
      const r = await c.query(
        `SELECT resuelta_en, detalle FROM combustible_alertas
          WHERE tenant_id = $1 AND viaje_id = $2 AND tipo = $3 ORDER BY id`,
        [tenantId, viajeId, tipo]
      );
      return r.rows;
    });

  describe("al marcar el descanso (E15e): sin esperar al worker", () => {
    const marcar = (id: number, motivo: string) =>
      admin.post(`/api/erp/combustible/viajes/${id}/descanso`).send({ motivo });
    const terminar = (id: number) =>
      admin.post(`/api/erp/combustible/viajes/${id}/descanso/terminar`).send({});

    it("una avería abre la alerta de unidad detenida al instante, y terminarla la cierra", async () => {
      const a = await lugar("Tabaconas");
      const b = await lugar("Chirinos");
      const v = await viaje(a, b, hace(2));

      const r = await marcar(v.id, "Avería");
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      // Sin correr el worker: la alerta ya está, con el detalle de la detención.
      const abierta = await alertas(v.id, "viaje_detenido");
      expect(abierta).toHaveLength(1);
      expect(abierta[0].resuelta_en).toBeNull();
      expect(abierta[0].detalle).toMatchObject({ detencion: "Avería", motivo: "Avería" });

      const t = await terminar(v.id);
      expect(t.status, JSON.stringify(t.body)).toBe(200);
      const cerrada = await alertas(v.id, "viaje_detenido");
      expect(cerrada).toHaveLength(1);
      expect(cerrada[0].resuelta_en).not.toBeNull();

      // Otra avería después abre una alerta nueva (la anterior ya está cerrada).
      expect((await marcar(v.id, "Accidente")).status).toBe(200);
      const todas = await alertas(v.id, "viaje_detenido");
      expect(todas).toHaveLength(2);
      expect(todas[1].resuelta_en).toBeNull();
    });

    it("dormir no abre alerta", async () => {
      const a = await lugar("Huarango");
      const b = await lugar("Namora");
      const v = await viaje(a, b, hace(2));
      expect((await marcar(v.id, "Dormir")).status).toBe(200);
      expect(await alertas(v.id, "viaje_detenido")).toHaveLength(0);
    });

    it("si la alerta falla, el descanso se guarda igual y el worker la crea después", async () => {
      const a = await lugar("Chontali");
      const b = await lugar("Jaen Sur");
      const v = await viaje(a, b, hace(2));
      const espia = vi
        .spyOn(CombustibleService.prototype, "evaluarDetencionDeUnViaje")
        .mockRejectedValueOnce(new Error("falla de prueba"));
      try {
        const r = await marcar(v.id, "Huaico");
        expect(r.status, JSON.stringify(r.body)).toBe(200); // el descanso se guardó
      } finally {
        espia.mockRestore();
      }
      expect(await alertas(v.id, "viaje_detenido")).toHaveLength(0);
      const guardado = await withTenant(tenantId, (c) =>
        c.query(
          `SELECT 1 FROM combustible_viaje_descansos
            WHERE tenant_id = $1 AND viaje_id = $2 AND fin_en IS NULL`,
          [tenantId, v.id]
        )
      );
      expect(guardado.rows).toHaveLength(1);
      // La red de seguridad: el worker abre la alerta que faltó.
      await correrConciliacion(tenantId);
      expect(await alertas(v.id, "viaje_detenido")).toHaveLength(1);
    });
  });

  it("el registro de respaldo declara el viaje de la alerta: al clonar un tenant no queda apuntando al de origen", () => {
    const tablas = MODULOS.flatMap((m) => m.tablas ?? []) as {
      nombre: string;
      fks?: Record<string, string>;
    }[];
    const alertas = tablas.find((t) => t.nombre === "combustible_alertas");
    expect(alertas?.fks?.viaje_id).toBe("combustible_viajes");
    // Y el viaje va antes que la alerta: el restore necesita padres antes que hijos.
    const orden = tablas.map((t) => t.nombre);
    expect(orden.indexOf("combustible_viajes")).toBeLessThan(orden.indexOf("combustible_alertas"));
  });

  it("un viaje que pasó lo que suele tardar su tramo alerta una vez, y se cierra sola al anularlo", async () => {
    const a = await lugar("Chota");
    const b = await lugar("Cutervo");
    await historial(a, b);
    const v = await viaje(a, b, hace(6)); // 360 min en marcha contra 240 + 36 de margen

    await correrConciliacion(tenantId);
    const abiertas = await alertas(v.id, "viaje_demorado");
    expect(abiertas).toHaveLength(1);
    expect(abiertas[0].resuelta_en).toBeNull();
    expect(abiertas[0].detalle).toMatchObject({
      viajeNumero: expect.any(Number),
      de: expect.any(String),
      a: expect.any(String),
      esperadoMin: 240,
      baseDelHistorial: "tipo",
    });
    expect(Math.abs(Number(abiertas[0].detalle.demoraMin) - 120)).toBeLessThanOrEqual(2);

    // Otra corrida no duplica la alerta.
    await correrConciliacion(tenantId);
    expect(await alertas(v.id, "viaje_demorado")).toHaveLength(1);

    // Al anular el viaje, la alerta se resuelve sola.
    const an = await admin
      .post(`/api/erp/combustible/viajes/${v.id}/anular`)
      .send({ motivo: "Prueba" });
    expect(an.status, JSON.stringify(an.body)).toBe(200);
    await correrConciliacion(tenantId);
    const cerradas = await alertas(v.id, "viaje_demorado");
    expect(cerradas).toHaveLength(1);
    expect(cerradas[0].resuelta_en).not.toBeNull();
  });

  it("dentro del margen no alerta; sin historial suficiente tampoco, por tarde que vaya", async () => {
    const a = await lugar("Jaen");
    const b = await lugar("Bagua");
    await historial(a, b);
    const dentro = await viaje(a, b, hace(4.5)); // 270 min: dentro de 240 + 36
    const c = await lugar("Celendin");
    const d = await lugar("Gelig");
    await historial(c, d, 2); // solo 2 viajes: no se estima
    const sin = await viaje(c, d, hace(20));

    await correrConciliacion(tenantId);
    expect(await alertas(dentro.id, "viaje_demorado")).toHaveLength(0);
    expect(await alertas(sin.id, "viaje_demorado")).toHaveLength(0);
  });

  it("el tiempo detenido por una avería no cuenta como demora", async () => {
    const a = await lugar("Sapalache");
    const b = await lugar("Huambos");
    await historial(a, b);
    const v = await viaje(a, b, hace(6));
    // Estuvo 3 h con una avería ya resuelta: en marcha lleva 3 h, no 6.
    await descanso(v.id, v.dni, "Avería", hace(5), hace(2));

    await correrConciliacion(tenantId);
    expect(await alertas(v.id, "viaje_demorado")).toHaveLength(0);
    expect(await alertas(v.id, "viaje_detenido")).toHaveLength(0); // ya terminó
  });

  it("una avería abierta alerta como unidad detenida (no como demora) y se cierra al terminarla; dormir no alerta", async () => {
    const a = await lugar("Cochabamba");
    const b = await lugar("Querocoto");
    await historial(a, b);
    const conAveria = await viaje(a, b, hace(2));
    await descanso(conAveria.id, conAveria.dni, "Avería del radiador", hace(1));
    const durmiendo = await viaje(a, b, hace(2));
    await descanso(durmiendo.id, durmiendo.dni, "Dormir", hace(1));

    await correrConciliacion(tenantId);
    const det = await alertas(conAveria.id, "viaje_detenido");
    expect(det).toHaveLength(1);
    expect(det[0].detalle).toMatchObject({ detencion: "Avería", motivo: "Avería del radiador" });
    expect(await alertas(conAveria.id, "viaje_demorado")).toHaveLength(0);
    expect(await alertas(durmiendo.id, "viaje_detenido")).toHaveLength(0);

    // Otra corrida no duplica; al terminar la avería, la alerta se resuelve sola.
    await correrConciliacion(tenantId);
    expect(await alertas(conAveria.id, "viaje_detenido")).toHaveLength(1);
    await withTenant(tenantId, (c) =>
      c.query(
        `UPDATE combustible_viaje_descansos SET fin_en = now(), fin_por = 'oficina'
          WHERE tenant_id = $1 AND viaje_id = $2`,
        [tenantId, conAveria.id]
      )
    );
    await correrConciliacion(tenantId);
    const cerrada = await alertas(conAveria.id, "viaje_detenido");
    expect(cerrada).toHaveLength(1);
    expect(cerrada[0].resuelta_en).not.toBeNull();
  });
});
