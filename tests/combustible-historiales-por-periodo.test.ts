/** tests/combustible-historiales-por-periodo.test.ts
 *
 * El filtro `?desde=&hasta=` de los tres historiales del módulo: lecturas
 * de varilla, despachos y recepciones.
 *
 * Hasta acá los tres devolvían los últimos 100 registros y nada más, así
 * que cualquier cosa anterior a esos 100 era inalcanzable desde la
 * pantalla. Con el filtro se puede pedir un período concreto -- el mismo
 * gesto que ya tenía el kardex.
 *
 * Lo que se cuida acá, además del filtro en sí:
 *
 *  1. **Que sin fechas todo siga exactamente como antes.** Las dos son
 *     opcionales, y eso es lo que hace que una pantalla vieja abierta en un
 *     navegador (que nunca las manda) no se rompa.
 *  2. **Que el filtro mire la fecha del HECHO y no la de la carga.** Un
 *     vale despachado en la cancha y cargado tres días después tiene que
 *     aparecer en el período en que se despachó. Si el filtro mirara
 *     `creado_en`, el historial escondería justamente los vales cargados en
 *     diferido -- que son los que más interesa poder revisar.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";

const MARZO = "2024-03-10T12:00:00.000Z";
const JUNIO = "2024-06-15T12:00:00.000Z";
const SETIEMBRE = "2024-09-20T12:00:00.000Z";

/** Un rango que cubre el día entero, como lo arma la pantalla a partir de
 *  los dos <input type="date">. */
const SOLO_JUNIO = { desde: "2024-06-01T00:00:00.000Z", hasta: "2024-06-30T23:59:59.999Z" };

function serieUnica(): string {
  return `S${Math.floor(Math.random() * 1e8).toString(36)}`;
}

describe("combustible: los historiales se pueden acotar por período", () => {
  let tenantId: string;
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);

  let tanqueId: number;
  let equipoId: number;
  let grifoId: number;
  const serie = serieUnica();

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });

    tanqueId = await withTenant(tenantId, async (client) => {
      const fila = await client.query(
        `INSERT INTO combustible (
           tenant_id, codigo, tanque_nombre, tipo_combustible, unidad, tipo_punto, capacidad_total
         )
         VALUES ($1, $2, 'Tanque período', 'diesel_b5', 'gal', 'fijo', 20000) RETURNING id`,
        [tenantId, idUnico("TQ")]
      );
      return fila.rows[0].id;
    });

    const equipo = await agente
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("VQ"), tipo: "VOLQUETE", tipo_medidor: "horometro" });
    equipoId = equipo.body.id;

    const grifo = await agente
      .post("/api/erp/combustible/grifos")
      .send({ nombre: idUnico("PRIMAX") });
    grifoId = grifo.body.id;

    // Una lectura, un despacho y una recepción en cada uno de los tres
    // meses. El filtro de junio tiene que dejar exactamente uno de cada.
    for (const [i, cuando] of [MARZO, JUNIO, SETIEMBRE].entries()) {
      const l = await agente
        .post("/api/erp/combustible/lecturas")
        .send({ combustible_id: tanqueId, nivel: 10000 - i * 100, leido_en: cuando });
      expect(l.status).toBe(201);

      const d = await agente.post("/api/erp/combustible/despachos").send({
        origen: "tanque_propio",
        combustible_id: tanqueId,
        tipo_combustible: "diesel_b5",
        tipo_destino: "equipo",
        equipo_id: equipoId,
        serie_talonario: serie,
        n_vale: i + 1,
        cantidad: 35,
        lectura_contometro: 35,
        costo_unitario: 16.8,
        despachado_en: cuando,
      });
      expect(d.status).toBe(201);

      const r = await agente.post("/api/erp/combustible/recepciones").send({
        combustible_id: tanqueId,
        grifo_id: grifoId,
        cantidad: 500,
        costo_unitario: 16.5,
        tipo_documento: "factura",
        numero_documento: idUnico("F001"),
        recibido_en: cuando,
      });
      expect(r.status).toBe(201);
    }
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  async function pedir(url: string, query: Record<string, string> = {}) {
    const res = await agente.get(url).query({ pageSize: "100", ...query });
    return res;
  }

  describe("sin fechas, el comportamiento de siempre", () => {
    it("lecturas devuelve todas", async () => {
      const res = await pedir(`/api/erp/combustible/${tanqueId}/lecturas`);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(3);
    });

    it("despachos devuelve todos", async () => {
      const res = await pedir("/api/erp/combustible/despachos");
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(3);
    });

    it("recepciones devuelve todas", async () => {
      const res = await pedir("/api/erp/combustible/recepciones");
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(3);
    });
  });

  describe("con las dos fechas, queda solo el período pedido", () => {
    it("lecturas", async () => {
      const res = await pedir(`/api/erp/combustible/${tanqueId}/lecturas`, SOLO_JUNIO);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].leido_en).toContain("2024-06-15");
    });

    it("despachos", async () => {
      const res = await pedir("/api/erp/combustible/despachos", SOLO_JUNIO);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].despachado_en).toContain("2024-06-15");
    });

    it("recepciones", async () => {
      const res = await pedir("/api/erp/combustible/recepciones", SOLO_JUNIO);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].recibido_en).toContain("2024-06-15");
    });
  });

  describe("cada punta se puede usar sola", () => {
    it("solo `desde` deja lo de esa fecha en adelante", async () => {
      const res = await pedir("/api/erp/combustible/despachos", { desde: JUNIO });
      expect(res.status).toBe(200);
      // Junio (el instante exacto, que entra por el >=) y setiembre.
      expect(res.body.data).toHaveLength(2);
    });

    it("solo `hasta` deja lo anterior a esa fecha", async () => {
      const res = await pedir("/api/erp/combustible/despachos", { hasta: JUNIO });
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
    });
  });

  describe("el total paginado también respeta el filtro", () => {
    it("no devuelve el total sin filtrar", async () => {
      const res = await pedir("/api/erp/combustible/recepciones", SOLO_JUNIO);
      // Si `COUNT(*) OVER()` quedara fuera del WHERE, la pantalla mostraría
      // "1 de 3" y ofrecería páginas que no existen.
      expect(res.body.pagination.total).toBe(1);
      expect(res.body.pagination.totalPages).toBe(1);
    });
  });

  describe("fechas que no se pueden atender", () => {
    it("rechaza el rango invertido con 400", async () => {
      const res = await pedir("/api/erp/combustible/despachos", {
        desde: SETIEMBRE,
        hasta: MARZO,
      });
      expect(res.status).toBe(400);
      expect(res.body.errors[0].message).toMatch(/anterior a la de fin/i);
    });

    it("rechaza una fecha que no es ISO con 400", async () => {
      const res = await pedir("/api/erp/combustible/despachos", { desde: "15/06/2024" });
      expect(res.status).toBe(400);
    });

    it("también las rechaza en lecturas y recepciones", async () => {
      const lecturas = await pedir(`/api/erp/combustible/${tanqueId}/lecturas`, {
        desde: "ayer",
      });
      expect(lecturas.status).toBe(400);
      const recepciones = await pedir("/api/erp/combustible/recepciones", { hasta: "ayer" });
      expect(recepciones.status).toBe(400);
    });
  });

  it("el vale cargado en diferido aparece en el período en que se DESPACHÓ", async () => {
    // El caso real: el grifero despacha en la cancha sin señal y el vale
    // entra al sistema días después. `creado_en` es hoy; `despachado_en`
    // es marzo. El historial de marzo tiene que mostrarlo.
    const enDiferido = await agente.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tanqueId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipoId,
      serie_talonario: serie,
      n_vale: 4,
      cantidad: 20,
      lectura_contometro: 20,
      costo_unitario: 16.8,
      despachado_en: "2024-03-11T08:00:00.000Z",
    });
    expect(enDiferido.status).toBe(201);

    const marzo = await pedir("/api/erp/combustible/despachos", {
      desde: "2024-03-01T00:00:00.000Z",
      hasta: "2024-03-31T23:59:59.999Z",
    });
    expect(marzo.status).toBe(200);
    expect(marzo.body.data.map((d: { n_vale: number }) => Number(d.n_vale)).sort()).toEqual([1, 4]);

    // Y NO aparece al filtrar por el día de hoy, que es cuando se cargó.
    const hoy = new Date();
    const inicioDeHoy = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate()).toISOString();
    const deHoy = await pedir("/api/erp/combustible/despachos", { desde: inicioDeHoy });
    expect(deHoy.body.data).toHaveLength(0);
  });
});
