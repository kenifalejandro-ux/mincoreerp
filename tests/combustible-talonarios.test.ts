/** tests/combustible-talonarios.test.ts
 *
 * GET /despachos/talonarios: el reporte de vales por serie del período (rango,
 * usados, litros, tramos que faltan con el vale de antes y de después). Usa la
 * misma consulta de huecos que /despachos/huecos, así que acá se prueba lo que
 * agrega: los tramos, los vecinos, el período y el aislamiento entre empresas.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";
import {
  agruparEnTramos,
  detallarVales,
  rangosQueQuedan,
  yaRegularizados,
} from "../src/modules/combustible/talonariosPeriodo";

function serieUnica(): string {
  return `T${Math.floor(Math.random() * 1e8).toString(36)}`.toUpperCase();
}

describe("agruparEnTramos (cálculo puro)", () => {
  it("junta consecutivos, ordena y quita repetidos", () => {
    expect(agruparEnTramos([1304, 1289, 1302, 1303, 1302])).toEqual([
      { desde: 1289, hasta: 1289 },
      { desde: 1302, hasta: 1304 },
    ]);
  });
  it("sin huecos no hay tramos", () => {
    expect(agruparEnTramos([])).toEqual([]);
  });
});

describe("detallarVales y yaRegularizados (cálculo puro)", () => {
  const tramo = (desde: number, hasta: number) => ({
    desde,
    hasta,
    cantidad: hasta - desde + 1,
    anterior: null,
    siguiente: null,
  });
  const baja = (desde: number, hasta: number, fecha: string) => ({
    desde,
    hasta,
    motivo: "roto",
    detalle: null,
    dado_por: "Admin",
    fecha,
  });

  it("abre el tramo en cada vale y marca los regularizados, aunque la baja cubra solo una parte", () => {
    const [t] = detallarVales([tramo(10, 13)], [baja(11, 12, "2026-11-12T10:00:00.000Z")]);
    expect(t.vales.map((v) => [v.n, v.baja !== null])).toEqual([
      [10, false],
      [11, true],
      [12, true],
      [13, false],
    ]);
    expect(t.explicados).toBe(2);
    expect(t.sin_explicar).toBe(2);
  });

  it("si un vale tiene dos regularizaciones, queda la más reciente", () => {
    const [t] = detallarVales(
      [tramo(5, 5)],
      [baja(5, 5, "2026-11-01T10:00:00.000Z"), baja(1, 9, "2026-11-12T10:00:00.000Z")]
    );
    expect(t.vales[0].baja?.fecha).toBe("2026-11-12T10:00:00.000Z");
  });

  it("yaRegularizados dice cuáles de la lista ya tienen regularización", () => {
    expect(yaRegularizados([1, 5, 9], [{ desde: 4, hasta: 6 }])).toEqual([5]);
    expect(yaRegularizados([1, 2], [])).toEqual([]);
  });
});

describe("rangosQueQuedan (cálculo puro)", () => {
  it("parte un rango al quitarle números del medio", () => {
    expect(rangosQueQuedan(10, 20, new Set([13, 14, 18]))).toEqual([
      { desde: 10, hasta: 12 },
      { desde: 15, hasta: 17 },
      { desde: 19, hasta: 20 },
    ]);
  });
  it("si se quita todo, no queda nada; si no se quita nada, queda igual", () => {
    expect(rangosQueQuedan(5, 6, new Set([5, 6]))).toEqual([]);
    expect(rangosQueQuedan(5, 8, new Set())).toEqual([{ desde: 5, hasta: 8 }]);
  });
});

describe("combustible: reporte de talonarios", () => {
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);
  const agenteOtro = request.agent(app);
  let tenantId: string;
  let tenantSlug: string;
  let otroTenantId: string;
  let tanqueId: number;
  let equipoId: number;

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    tenantSlug = creado.tenant.slug;
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });
    const otro = await crearTenantDePrueba(password);
    otroTenantId = otro.tenant.id;
    await agenteOtro
      .post("/api/auth/login")
      .send({ tenantSlug: otro.tenant.slug, email: otro.usuario.email, password });

    tanqueId = await withTenant(tenantId, async (client) => {
      const fila = await client.query(
        `INSERT INTO combustible (tenant_id, codigo, tanque_nombre, tipo_combustible, unidad, tipo_punto, capacidad_total)
         VALUES ($1, $2, 'Tanque talonarios', 'diesel_b5', 'gal', 'fijo', 5000) RETURNING id`,
        [tenantId, idUnico("TQ")]
      );
      return fila.rows[0].id;
    });
    const equipo = await agente
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("VQ"), tipo: "VOLQUETE", tipo_medidor: "horometro" });
    equipoId = equipo.body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await borrarTenantDePrueba(otroTenantId);
    await closeDatabase();
  });

  async function despachar(serie: string, nVale: number, cantidad = 35) {
    const res = await agente.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tanqueId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipoId,
      serie_talonario: serie,
      n_vale: nVale,
      cantidad,
      lectura_contometro: cantidad,
      costo_unitario: 16.8,
      despachado_en: new Date().toISOString(),
    });
    expect(res.status).toBe(201);
  }

  it("arma tramos, cuenta usados y suma galones, con el vale de antes y de después", async () => {
    const serie = serieUnica();
    for (const n of [1, 2, 4, 5, 9]) await despachar(serie, n);

    const res = await agente.get("/api/erp/combustible/despachos/talonarios");
    expect(res.status).toBe(200);
    const fila = res.body.series.find((s: { serie: string }) => s.serie === serie);
    expect(fila).toBeDefined();
    expect(fila.minimo).toBe(1);
    expect(fila.maximo).toBe(9);
    expect(fila.usados).toBe(5);
    expect(fila.faltan).toBe(4);
    expect(fila.galones).toBeCloseTo(175, 3);
    expect(fila.tramos).toHaveLength(2);
    expect(fila.tramos[0]).toMatchObject({ desde: 3, hasta: 3, cantidad: 1 });
    expect(fila.tramos[0].anterior.n).toBe(2);
    expect(fila.tramos[0].siguiente.n).toBe(4);
    expect(fila.tramos[1]).toMatchObject({ desde: 6, hasta: 8, cantidad: 3 });
    expect(fila.tramos[1].anterior.n).toBe(5);
    expect(fila.tramos[1].siguiente.n).toBe(9);
  });

  it("con más de 50 series, el corte deja las más recientes y la lista sale por nombre", async () => {
    // 51 series viejas con nombre que ordena ANTES que la nueva y una nueva que ordena DESPUÉS.
    const pasado = new Date(Date.now() - 20 * 24 * 3600 * 1000).toISOString();
    await withTenant(tenantId, async (client) => {
      for (let i = 0; i < 51; i++) {
        await client.query(
          `INSERT INTO combustible_despachos
             (tenant_id, producto, origen, combustible_id, tipo_combustible, tipo_destino, equipo_id,
              serie_talonario, n_vale, cantidad, lectura_contometro, costo_unitario, despachado_en)
           VALUES ($1, 'combustible', 'tanque_propio', $2, 'diesel_b5', 'equipo', $3,
                   $4, 1, 10, 10, 16, $5)`,
          [tenantId, tanqueId, equipoId, `AA${String(i).padStart(3, "0")}`, pasado]
        );
      }
    });
    const reciente = `ZZ${Math.floor(Math.random() * 1e6)}`;
    await despachar(reciente, 1);

    const res = await agente.get("/api/erp/combustible/despachos/talonarios");
    expect(res.status).toBe(200);
    const nombres = res.body.series.map((x: { serie: string }) => x.serie);
    expect(nombres).toContain(reciente);
    expect(nombres.length).toBeLessThanOrEqual(50);
    expect(nombres).toEqual([...nombres].sort((a: string, b: string) => a.localeCompare(b)));
  });

  it("una serie sin huecos sale completa", async () => {
    const serie = serieUnica();
    for (const n of [10, 11, 12]) await despachar(serie, n);
    const res = await agente.get("/api/erp/combustible/despachos/talonarios");
    const fila = res.body.series.find((s: { serie: string }) => s.serie === serie);
    expect(fila.faltan).toBe(0);
    expect(fila.tramos).toEqual([]);
  });

  it("un período sin despachos devuelve la lista vacía", async () => {
    const res = await agente.get(
      "/api/erp/combustible/despachos/talonarios?desde=2001-01-01T00:00:00Z&hasta=2001-01-31T00:00:00Z"
    );
    expect(res.status).toBe(200);
    expect(res.body.series).toEqual([]);
  });

  it("400 si el inicio del período es posterior al fin", async () => {
    const res = await agente.get(
      "/api/erp/combustible/despachos/talonarios?desde=2026-02-01T00:00:00Z&hasta=2026-01-01T00:00:00Z"
    );
    expect(res.status).toBe(400);
  });

  // El grifero no tiene el historial de despachos, pero sí ve sus talonarios (solo mirar).
  async function entrarComo(rol: string) {
    const dni = String(86300000 + Math.floor(Math.random() * 900000));
    const alta = await agente
      .post("/api/erp/usuarios")
      .send({ nombre: `Talonarios ${rol}`, dni, password, rol });
    expect(alta.status, JSON.stringify(alta.body)).toBe(201);
    const persona = request.agent(app);
    const entrar = await persona
      .post("/api/auth/login")
      .send({ tenantSlug, identificador: dni, password });
    expect(entrar.status).toBe(200);
    return persona;
  }

  it("el grifero y Lectura lo ven; el conductor no", async () => {
    const ruta = "/api/erp/combustible/despachos/talonarios";
    expect((await (await entrarComo("grifero")).get(ruta)).status).toBe(200);
    expect((await (await entrarComo("lectura")).get(ruta)).status).toBe(200);
    expect((await (await entrarComo("conductor_ruta")).get(ruta)).status).toBe(403);
  });

  describe("regularizar vales", () => {
    const ruta = "/api/erp/combustible/despachos/talonarios/bajas";
    const serieDe = async (serie: string) => {
      const r = await agente.get("/api/erp/combustible/despachos/talonarios");
      return r.body.series.find((x: { serie: string }) => x.serie === serie);
    };

    it("regulariza solo los vales elegidos y cuenta por vale", async () => {
      const serie = serieUnica();
      for (const n of [1, 2, 7]) await despachar(serie, n);
      // Faltan 3, 4, 5 y 6. Se regularizan el 3 y el 5, sueltos.
      const res = await agente
        .post(ruta)
        .send({ serie, numeros: [3, 5], motivo: "roto", detalle: "se mojó" });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.cantidad).toBe(2);

      const fila = await serieDe(serie);
      expect(fila.faltan).toBe(4);
      expect(fila.explicados).toBe(2);
      expect(fila.sin_explicar).toBe(2);
      const vales = fila.tramos[0].vales;
      expect(vales.map((v: { n: number }) => v.n)).toEqual([3, 4, 5, 6]);
      expect(vales[0].baja).toMatchObject({ motivo: "roto", detalle: "se mojó" });
      expect(vales[0].baja.dado_por).toBeTruthy();
      expect(vales[1].baja).toBeNull();
      expect(vales[2].baja).not.toBeNull();
      expect(fila.tramos[0].explicados).toBe(2);
    });

    it("varios números seguidos y uno suelto en una sola petición", async () => {
      const serie = serieUnica();
      for (const n of [1, 9]) await despachar(serie, n);
      const res = await agente.post(ruta).send({ serie, numeros: [2, 3, 4, 6], motivo: "perdido" });
      expect(res.status).toBe(201);
      const fila = await serieDe(serie);
      expect(fila.explicados).toBe(4);
      expect(fila.sin_explicar).toBe(3);
    });

    it("con «Otro» el detalle es obligatorio", async () => {
      const res = await agente.post(ruta).send({ serie: "X", numeros: [3], motivo: "otro" });
      expect(res.status).toBe(400);
    });

    it("rechaza una lista vacía, repetida o un motivo que no existe", async () => {
      const mal = [
        { serie: "X", numeros: [], motivo: "roto" },
        { serie: "X", numeros: [3, 3], motivo: "roto" },
        { serie: "X", numeros: [3], motivo: "me dio pereza" },
      ];
      for (const cuerpo of mal) expect((await agente.post(ruta).send(cuerpo)).status).toBe(400);
    });

    it("no se puede regularizar un número que ya tiene vale, y no se guarda nada", async () => {
      const serie = serieUnica();
      for (const n of [1, 2, 5]) await despachar(serie, n);
      const res = await agente.post(ruta).send({ serie, numeros: [3, 2], motivo: "perdido" });
      expect(res.status).toBe(409);
      expect((await serieDe(serie)).explicados).toBe(0);
    });

    it("no se regulariza dos veces el mismo vale", async () => {
      const serie = serieUnica();
      for (const n of [1, 6]) await despachar(serie, n);
      expect(
        (await agente.post(ruta).send({ serie, numeros: [2, 3], motivo: "perdido" })).status
      ).toBe(201);
      expect(
        (await agente.post(ruta).send({ serie, numeros: [3, 4], motivo: "perdido" })).status
      ).toBe(409);
      expect((await serieDe(serie)).explicados).toBe(2);
    });

    it("si después aparece uno de esos vales, deja de contar como faltante", async () => {
      const serie = serieUnica();
      for (const n of [1, 4]) await despachar(serie, n);
      await agente.post(ruta).send({ serie, numeros: [2, 3], motivo: "roto" });
      await despachar(serie, 3);
      const fila = await serieDe(serie);
      expect(fila.faltan).toBe(1);
      expect(fila.explicados).toBe(1);
      expect(fila.sin_explicar).toBe(0);
    });

    it("el grifero y Lectura no pueden regularizar; el operador sí", async () => {
      const serie = serieUnica();
      for (const n of [1, 5]) await despachar(serie, n);
      const cuerpo = { serie, numeros: [2, 3], motivo: "roto" };
      expect((await (await entrarComo("grifero")).post(ruta).send(cuerpo)).status).toBe(403);
      expect((await (await entrarComo("lectura")).post(ruta).send(cuerpo)).status).toBe(403);
      expect((await entrarComo("operador").then((p) => p.post(ruta).send(cuerpo))).status).toBe(
        201
      );
    });
  });

  describe("deshacer una regularización", () => {
    const ruta = "/api/erp/combustible/despachos/talonarios/bajas";
    const deshacer = `${ruta}/deshacer`;
    const serieDe = async (serie: string) => {
      const r = await agente.get("/api/erp/combustible/despachos/talonarios");
      return r.body.series.find((x: { serie: string }) => x.serie === serie);
    };
    const preparar = async (huecos: number[]) => {
      const serie = serieUnica();
      await despachar(serie, 1);
      await despachar(serie, Math.max(...huecos) + 1);
      expect(
        (await agente.post(ruta).send({ serie, numeros: huecos, motivo: "perdido", detalle: "d" }))
          .status
      ).toBe(201);
      return serie;
    };

    it("devuelve un vale a «sin explicar» y deja el resto regularizado", async () => {
      const serie = await preparar([2, 3, 4, 5]);
      const res = await agente.post(deshacer).send({ serie, numeros: [3], motivo: "me equivoqué" });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.cantidad).toBe(1);

      const fila = await serieDe(serie);
      expect(fila.explicados).toBe(3);
      expect(fila.sin_explicar).toBe(1);
      const vales = fila.tramos[0].vales;
      expect(vales.map((v: { n: number; baja: unknown }) => [v.n, v.baja !== null])).toEqual([
        [2, true],
        [3, false],
        [4, true],
        [5, true],
      ]);
      // Los que siguen regularizados conservan su motivo y su detalle.
      expect(vales[0].baja).toMatchObject({ motivo: "perdido", detalle: "d" });
    });

    it("no borra: la fila original queda anulada con quién, cuándo y por qué", async () => {
      const serie = await preparar([2, 3]);
      await agente.post(deshacer).send({ serie, numeros: [2, 3], motivo: "apareció el papel" });
      const filas = await withTenant(tenantId, (client) =>
        client.query(
          `SELECT desde, hasta, motivo_anulacion, anulada_en, anulada_por
             FROM combustible_vales_baja WHERE tenant_id = $1 AND serie = $2`,
          [tenantId, serie]
        )
      );
      expect(filas.rows).toHaveLength(1);
      expect(filas.rows[0].motivo_anulacion).toBe("apareció el papel");
      expect(filas.rows[0].anulada_en).not.toBeNull();
      expect(filas.rows[0].anulada_por).not.toBeNull();
      expect((await serieDe(serie)).explicados).toBe(0);
    });

    it("se puede volver a regularizar un vale que se deshizo", async () => {
      const serie = await preparar([2, 3]);
      await agente.post(deshacer).send({ serie, numeros: [2], motivo: "error" });
      expect((await agente.post(ruta).send({ serie, numeros: [2], motivo: "roto" })).status).toBe(
        201
      );
      const fila = await serieDe(serie);
      expect(fila.explicados).toBe(2);
      expect(fila.tramos[0].vales[0].baja.motivo).toBe("roto");
    });

    it("deshacer varios vales a la vez, de dos tramos distintos", async () => {
      const serie = await preparar([2, 3]);
      await despachar(serie, 8);
      await agente.post(ruta).send({ serie, numeros: [5, 6], motivo: "roto" });
      const res = await agente.post(deshacer).send({ serie, numeros: [3, 5], motivo: "revisión" });
      expect(res.status).toBe(201);
      expect((await serieDe(serie)).explicados).toBe(2);
    });

    it("el motivo es obligatorio y no se aceptan listas vacías ni repetidas", async () => {
      const serie = await preparar([2, 3]);
      const mal = [
        { serie, numeros: [2] },
        { serie, numeros: [2], motivo: "   " },
        { serie, numeros: [], motivo: "x" },
        { serie, numeros: [2, 2], motivo: "x" },
      ];
      for (const cuerpo of mal) expect((await agente.post(deshacer).send(cuerpo)).status).toBe(400);
    });

    it("rechaza un vale que no está regularizado y no cambia nada", async () => {
      const serie = await preparar([2, 3]);
      const res = await agente.post(deshacer).send({ serie, numeros: [3, 9], motivo: "x" });
      expect(res.status).toBe(409);
      expect((await serieDe(serie)).explicados).toBe(2);
    });

    it("el grifero y Lectura no pueden deshacer; el operador sí", async () => {
      const serie = await preparar([2, 3]);
      const cuerpo = { serie, numeros: [2], motivo: "x" };
      expect((await (await entrarComo("grifero")).post(deshacer).send(cuerpo)).status).toBe(403);
      expect((await (await entrarComo("lectura")).post(deshacer).send(cuerpo)).status).toBe(403);
      expect((await entrarComo("operador").then((p) => p.post(deshacer).send(cuerpo))).status).toBe(
        201
      );
    });
  });

  it("otra empresa no ve las series de esta", async () => {
    const res = await agenteOtro.get("/api/erp/combustible/despachos/talonarios");
    expect(res.status).toBe(200);
    expect(res.body.series).toEqual([]);
  });
});
