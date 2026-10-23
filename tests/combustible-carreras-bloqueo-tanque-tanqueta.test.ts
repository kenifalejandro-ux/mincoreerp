/** tests/combustible-carreras-bloqueo-tanque-tanqueta.test.ts
 *
 * Tres carreras de la auditoría de #316-#321 (hallazgos 7, 8 y 9). Ninguna se
 * reproduce de forma fiable en ráfagas normales (la ventana es de milisegundos),
 * así que cada test la FUERZA: detiene una de las dos operaciones a mitad con un
 * bloqueo de tabla, deja pasar a la otra y recién entonces suelta la primera.
 * Sin el bloqueo del tanque (o de la tanqueta) antes de validar, los tres fallan.
 *
 *  7. Retorno al pozo contra una recepción: el pozo no pasa de su capacidad.
 *  8. Retorno a otra tanqueta contra el reparto del excedente de una recepción:
 *     la tanqueta no pasa de su capacidad.
 *  9. Retorno al pozo contra anular una recepción: el costo promedio guardado es
 *     el mismo que sale de rehacerlo desde cero.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  app,
  crearTenantDePrueba,
  borrarTenantDePrueba,
  idUnico,
  recibirTanqueta,
} from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";
import { CombustibleRepository } from "../src/modules/combustible/combustible.repository";

describe("combustible: el tanque y la tanqueta se bloquean antes de validar (carreras)", () => {
  const password = "ClaveDePrueba123";
  const admin = request.agent(app);
  const repo = new CombustibleRepository();
  let tenantId: string;
  let principal: number;
  let proveedor: number;
  let fuenteId: number;
  let nVale = 1;
  let nAsig = 1;

  const hace = (dias: number) => new Date(Date.now() - dias * 24 * 3600 * 1000).toISOString();
  const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });
    principal = (await admin.get("/api/erp/sedes")).body.sedes[0].grifos[0].id;
    proveedor = (
      await admin
        .post("/api/erp/combustible/grifos")
        .send({ nombre: idUnico("Prov"), abastece_tanque: true })
    ).body.id;
    fuenteId = await tanque({ nivel: 9000, capacidad: 20000 });
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  async function tanque(o: {
    nivel: number;
    capacidad: number;
    flexible?: boolean;
    base?: boolean;
  }) {
    const r = await admin.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque de prueba",
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_punto: "fijo",
      capacidad_total: o.capacidad,
      nivel_actual: o.nivel,
      nivel_minimo: 100,
      requiere_documento: false,
      modo_vigilancia: "sin_vigilar",
      ...(o.flexible ? { modo_excedente_recepcion: "flexible" } : {}),
      grifo_interno_id: principal,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const id = r.body.id as number;
    if (o.base !== false) {
      const b = await admin
        .post("/api/erp/combustible/lecturas")
        .send({ combustible_id: id, nivel: o.nivel, leido_en: hace(50) });
      expect(b.status, JSON.stringify(b.body)).toBe(201);
    }
    return id;
  }

  const nuevaTanqueta = async () =>
    Number(
      (await admin.post("/api/erp/combustible/tanquetas").send({ grifo_interno_id: principal }))
        .body.id
    );

  /** Llena una tanqueta nueva desde la fuente, al costo dado, y la asigna a una unidad propia. */
  async function tanquetaAsignada(cantidad: number, costo = 16) {
    const id = await nuevaTanqueta();
    const unidad = (
      await admin.post("/api/erp/equipos").send({
        placa_codigo: idUnico("VQ"),
        tipo: "VOLQUETE",
        tipo_medidor: "horometro",
        grifo_interno_id: principal,
      })
    ).body.id;
    const v = await admin.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: fuenteId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "reserva_cubeta",
      tanqueta_destino_id: id,
      serie_talonario: "CAR",
      n_vale: nVale++,
      cantidad,
      lectura_contometro: cantidad,
      costo_unitario: costo,
    });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    const a = await admin
      .put(`/api/erp/combustible/tanquetas/${id}/asignar`)
      .send({ equipo_id: unidad, serie_talonario: "CAS", n_vale: nAsig++ });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    return id;
  }

  const recepcion = (tq: number, cantidad: number, costo: number, extra: object = {}) =>
    admin.post("/api/erp/combustible/recepciones").send({
      combustible_id: tq,
      grifo_id: proveedor,
      cantidad,
      costo_unitario: costo,
      recibido_en: new Date().toISOString(),
      ...extra,
    });

  const nivelTeorico = async (id: number) => {
    const r = await admin.get("/api/erp/combustible");
    const lista: { id: number; nivel_teorico: string | null }[] = r.body.data ?? r.body;
    return Number(lista.find((t) => t.id === id)!.nivel_teorico);
  };

  const tanquetaFila = async (id: number) => {
    const lista: { id: string; saldo: string; capacidad: string }[] = (
      await admin.get("/api/erp/combustible/tanquetas")
    ).body;
    return lista.find((t) => String(t.id) === String(id))!;
  };

  /** Toma un bloqueo en otra transacción y lo mantiene hasta `soltar()`. */
  async function retener(texto: string) {
    let soltar!: () => void;
    const fin = new Promise<void>((r) => (soltar = r));
    let tomado!: () => void;
    const listo = new Promise<void>((r) => (tomado = r));
    const tarea = withTenant(tenantId, async (client) => {
      await client.query(texto);
      tomado();
      await fin;
    });
    await listo;
    return { soltar, tarea };
  }

  it("7: un retorno al pozo y una recepción a la vez no lo dejan por encima de su capacidad", async () => {
    const pozo = await tanque({ nivel: 800, capacidad: 1000 });
    const tqt = await tanquetaAsignada(100);
    // Frena SOLO el INSERT de la recepción: ya validó (800 + 150) y espera.
    const freno = await retener("LOCK TABLE combustible_recepciones IN EXCLUSIVE MODE");
    // Las peticiones de supertest no salen hasta que alguien las espera: se envuelven
    // en una función async para que arranquen YA.
    const rec = (async () => recepcion(pozo, 150, 10))();
    await dormir(1200);
    // El retorno llega en medio: con el tanque bloqueado por la recepción, espera.
    const ret = recibirTanqueta(admin, tqt, { destino: "pozo", tanqueId: pozo });
    await dormir(800);
    freno.soltar();
    await freno.tarea;
    const [r, t] = await Promise.all([rec, ret]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    // Con la recepción ya dentro (950), al retorno no le caben 100 más.
    expect(t.status, JSON.stringify(t.body)).toBe(400);
    expect(await nivelTeorico(pozo)).toBeLessThanOrEqual(1000.005);
  }, 60000);

  it("8: un traslado y el reparto de excedente a la vez no dejan la tanqueta por encima de su capacidad", async () => {
    const lleno = await tanque({ nivel: 2000, capacidad: 2000, flexible: true });
    const destino = await tanquetaAsignada(180); // libre: 100
    const origen = await tanquetaAsignada(100);
    // Frena el INSERT de las líneas del reparto: la recepción ya validó el espacio.
    const freno = await retener("LOCK TABLE combustible_recepcion_excedentes IN EXCLUSIVE MODE");
    const rec = (async () =>
      recepcion(lleno, 100, 17, {
        reparto_excedente: [{ destino: "cubeta", cantidad: 100, tanqueta_id: destino }],
      }))();
    await dormir(1500);
    const traslado = recibirTanqueta(admin, origen, {
      destino: "tanqueta",
      tanquetaDestinoId: destino,
    });
    await dormir(800);
    freno.soltar();
    await freno.tarea;
    const [r, t] = await Promise.all([rec, traslado]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    // Con el excedente ya dentro (280), al traslado no le cabe nada.
    expect(t.status, JSON.stringify(t.body)).toBe(400);
    const fila = await tanquetaFila(destino);
    expect(Number(fila.saldo)).toBeLessThanOrEqual(Number(fila.capacidad) + 0.001);
  }, 60000);

  it("9: un retorno al pozo y anular una recepción a la vez dejan el costo promedio bien calculado", async () => {
    const pozo = await tanque({ nivel: 2000, capacidad: 10000, base: false });
    const rec = await recepcion(pozo, 100, 9);
    expect(rec.status, JSON.stringify(rec.body)).toBe(201);
    const tqt = await tanquetaAsignada(100, 30);
    const equipo = (
      await withTenant(tenantId, (c) =>
        c.query(
          `SELECT equipo_asignado_id FROM combustible_tanquetas WHERE tenant_id = $1 AND id = $2`,
          [tenantId, tqt]
        )
      )
    ).rows[0].equipo_asignado_id as number;
    let soltar!: () => void;
    const fin = new Promise<void>((r) => (soltar = r));
    let listo!: () => void;
    const lp = new Promise<void>((r) => (listo = r));
    // Lo mismo que hace registrarRetornoTanqueta (bloquea el tanque, inserta, rehace el
    // costo) y se queda sin confirmar mientras llega la anulación.
    const enCurso = withTenant(tenantId, async (client) => {
      await client.query(`SELECT 1 FROM combustible WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [
        tenantId,
        pozo,
      ]);
      await client.query(
        `INSERT INTO combustible_tanqueta_retornos
           (tenant_id, tanqueta_id, equipo_id, saldo_calculado, saldo_validado, destino,
            combustible_id, cantidad_pozo, costo_unitario_pozo)
         VALUES ($1, $2, $3, 100, 100, 'pozo', $4, 100, 30)`,
        [tenantId, tqt, equipo, pozo]
      );
      await repo.recalcularCostoPromedio(client, tenantId, pozo);
      listo();
      await fin;
    });
    await lp;
    const anular = (async () =>
      admin
        .patch(`/api/erp/combustible/recepciones/${rec.body.id}/anular`)
        .send({ motivo: "carrera de costo" }))();
    await dormir(1200);
    soltar();
    await enCurso;
    const a = await anular;
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const guardado = Number(
      (await admin.get("/api/erp/combustible").then((r) => (r.body.data ?? r.body) as unknown[]))
        .map((t) => t as { id: number; costo_promedio: string })
        .find((t) => t.id === pozo)!.costo_promedio
    );
    const rehecho = await withTenant(tenantId, (client) =>
      repo.recalcularCostoPromedio(client, tenantId, pozo)
    );
    expect(guardado).toBeCloseTo(rehecho, 3);
  }, 60000);
});
