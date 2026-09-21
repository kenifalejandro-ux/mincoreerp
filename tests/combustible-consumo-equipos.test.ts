/** tests/combustible-consumo-equipos.test.ts
 *
 * El reporte de consumo por equipo: separar "le roban" de "traga mucho"
 * comparando a cada equipo contra sus PARES (mismo tipo, marca y modelo) y
 * contra SU PASADO. Más dos arreglos del cálculo de consumo que ya existía:
 * la urea no se quema en el motor, y la carga sin horómetro sí.
 *
 * La historia de un año se inserta por SQL: la API no deja fechar un vale
 * meses atrás sin disparar las alertas de vale retroactivo, y acá lo que se
 * prueba es la lectura del reporte, no la carga.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";

const DIA = 24 * 3600 * 1000;
const haceDias = (d: number) => new Date(Date.now() - d * DIA).toISOString();
const serieUnica = () => `S${Math.floor(Math.random() * 1e8).toString(36)}`;

interface FilaConsumo {
  placa_codigo: string;
  diagnostico: string;
  lectura: string;
  medidor: string;
  periodo: { consumo: number; cargas: number } | null;
  pasado: { consumo: number } | null;
  pares: { cantidad: number; mediana: number } | null;
  vs_pares_pct: number | null;
  vs_pasado_pct: number | null;
  supera_maximo: boolean | null;
}

describe("combustible: reporte de consumo por equipo", () => {
  let tenantId: string;
  let slug: string;
  let tanqueId: number;
  let grifoUrea: number;
  const password = "ClaveDePrueba123";
  const admin = request.agent(app);
  const operador = request.agent(app);
  const serie = serieUnica();
  let nVale = 1;

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    slug = creado.tenant.slug;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: slug, email: creado.usuario.email, password });

    const dni = String(84900000 + Math.floor(Math.random() * 90000));
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre: "Operador", dni, password, rol: "operador" });
    expect(alta.status).toBe(201);
    await operador.post("/api/auth/login").send({ tenantSlug: slug, identificador: dni, password });

    const grifo = await admin.post("/api/erp/combustible/grifos").send({
      nombre: idUnico("UREA"),
      abastece_ruta: false,
      abastece_tanque: false,
      abastece_urea: true,
    });
    grifoUrea = grifo.body.id;

    tanqueId = await withTenant(tenantId, async (client) => {
      const r = await client.query(
        `INSERT INTO combustible (
           tenant_id, codigo, tanque_nombre, tipo_combustible, unidad, tipo_punto, capacidad_total
         ) VALUES ($1, $2, 'Tanque consumo', 'diesel_b5', 'L', 'fijo', 50000) RETURNING id`,
        [tenantId, idUnico("TQ")]
      );
      return r.rows[0].id;
    });
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  async function equipo(
    placa: string,
    marca: string | null,
    modelo: string | null,
    tipoMedidor: "horometro" | "odometro" = "horometro"
  ) {
    return withTenant(tenantId, async (client) => {
      const r = await client.query(
        `INSERT INTO equipos (tenant_id, placa_codigo, tipo, marca, modelo, tipo_medidor)
         VALUES ($1, $2, 'Volquete', $3, $4, $5) RETURNING id`,
        [tenantId, placa, marca, modelo, tipoMedidor]
      );
      return r.rows[0].id as number;
    });
  }

  async function cargar(
    equipoId: number,
    cantidad: number,
    cuando: string,
    medidor: { horometro?: number; odometro?: number } = {}
  ) {
    await withTenant(tenantId, (client) =>
      client.query(
        `INSERT INTO combustible_despachos (
           tenant_id, origen, combustible_id, tipo_combustible, tipo_destino, equipo_id,
           serie_talonario, n_vale, cantidad, lectura_contometro,
           lectura_horometro, lectura_odometro, costo_unitario, despachado_en
         ) VALUES ($1, 'tanque_propio', $2, 'diesel_b5', 'equipo', $3, $4, $5, $6, $6, $7, $8, 16, $9)`,
        [
          tenantId,
          tanqueId,
          equipoId,
          serie,
          nVale++,
          cantidad,
          medidor.horometro ?? null,
          medidor.odometro ?? null,
          cuando,
        ]
      )
    );
  }

  /** Seis cargas de 10 h en el año anterior a L/h = `pasado`, y cinco de 10 h
   *  en los últimos 30 días a L/h = `periodo`. */
  async function historia(equipoId: number, pasado: number | null, periodo: number) {
    let horometro = 1000;
    if (pasado !== null) {
      await cargar(equipoId, 200, haceDias(300), { horometro });
      for (const d of [250, 200, 150, 100, 60]) {
        horometro += 10;
        await cargar(equipoId, pasado * 10, haceDias(d), { horometro });
      }
    }
    for (const d of [25, 20, 15, 10, 5]) {
      horometro += 10;
      await cargar(equipoId, periodo * 10, haceDias(d), { horometro });
    }
  }

  const reporte = async (ag = admin) =>
    ag.get("/api/erp/combustible/reportes/consumo-equipos").query({
      desde: haceDias(30),
      hasta: new Date(Date.now() + 60_000).toISOString(),
    });

  it("separa el robo nuevo, el que traga desde siempre y el medidor inflado", async () => {
    const modelo = idUnico("777G");
    const normales = await Promise.all(
      ["N1", "N2", "N3"].map((p) => equipo(idUnico(p), "CAT", modelo))
    );
    for (const id of normales) await historia(id, 20, 20);

    // Igual a sus pares ahora, pero antes gastaba menos: CAMBIÓ.
    const subio = await equipo(idUnico("SUB"), "CAT", modelo);
    await historia(subio, 16, 20);
    // Cambió Y quedó por encima de los pares: lo más urgente.
    const ambos = await equipo(idUnico("AMB"), "CAT", modelo);
    await historia(ambos, 20, 26);
    // Siempre gastó 25: no cambió nada, pero está 25 % sobre sus pares.
    const traga = await equipo(idUnico("TRG"), "cat ", ` ${modelo.toLowerCase()}`);
    await historia(traga, 25, 25);
    // Gasta 15 donde los demás 20: el horómetro corre más que el motor.
    const inflado = await equipo(idUnico("INF"), "CAT", modelo);
    await historia(inflado, 20, 15);

    const r = await reporte();
    expect(r.status).toBe(200);
    const filas = r.body.equipos as FilaConsumo[];
    const de = async (id: number) => {
      const placa = await withTenant(tenantId, async (c) => {
        const q = await c.query(`SELECT placa_codigo FROM equipos WHERE id = $1`, [id]);
        return q.rows[0].placa_codigo as string;
      });
      return filas.find((f) => f.placa_codigo === placa)!;
    };

    const fAmbos = await de(ambos);
    expect(fAmbos.diagnostico).toBe("subio_y_alto");
    expect(fAmbos.periodo!.consumo).toBe(26);
    expect(fAmbos.pasado!.consumo).toBe(20);
    expect(fAmbos.vs_pasado_pct).toBe(30);

    const fSubio = await de(subio);
    expect(fSubio.diagnostico).toBe("subio");
    expect(fSubio.vs_pares_pct).toBe(0);

    // La marca y el modelo se comparan sin mayúsculas ni espacios de más.
    const fTraga = await de(traga);
    expect(fTraga.diagnostico).toBe("alto");
    expect(fTraga.pares!.cantidad).toBe(6);
    expect(fTraga.pares!.mediana).toBe(20);
    expect(fTraga.vs_pasado_pct).toBe(0);

    const fInflado = await de(inflado);
    expect(fInflado.diagnostico).toBe("bajo");
    expect(fInflado.lectura).toMatch(/adelantado/);

    // Gemelo de control: los normales tienen que salir normales, o el resto
    // de las lecturas no prueba nada.
    for (const id of normales) expect((await de(id)).diagnostico).toBe("normal");

    // Lo urgente arriba: el orden es parte del reporte.
    const orden = filas.map((f) => f.diagnostico);
    expect(orden.indexOf("subio_y_alto")).toBeLessThan(orden.indexOf("subio"));
    expect(orden.indexOf("subio")).toBeLessThan(orden.indexOf("alto"));
    expect(orden.indexOf("alto")).toBeLessThan(orden.indexOf("normal"));
  });

  it("sin pares ni pasado no inventa una comparación, y con pocas cargas no da consumo", async () => {
    const solo = await equipo(idUnico("HLX"), "Toyota", idUnico("Hilux"), "odometro");
    let km = 50000;
    for (const d of [25, 20, 15, 10, 5]) {
      km += 400;
      await cargar(solo, 40, haceDias(d), { odometro: km });
    }
    const pocas = await equipo(idUnico("POC"), "Volvo", idUnico("FMX"));
    await cargar(pocas, 200, haceDias(10), { horometro: 500 });
    await cargar(pocas, 200, haceDias(5), { horometro: 510 });

    const filas = (await reporte()).body.equipos as FilaConsumo[];
    const fSolo = filas.find((f) => f.placa_codigo.startsWith("HLX"))!;
    expect(fSolo.diagnostico).toBe("sin_referencia");
    expect(fSolo.medidor).toBe("odometro");
    expect(fSolo.periodo!.consumo).toBe(0.1); // 160 L / 1.600 km

    const fPocas = filas.find((f) => f.placa_codigo.startsWith("POC"))!;
    expect(fPocas.diagnostico).toBe("sin_datos");
    expect(fPocas.periodo).toBeNull();
  });

  it("las cargas sin horómetro también se queman: entran en el consumo", async () => {
    const id = await equipo(idUnico("SIN"), "Scania", idUnico("G450"));
    let horometro = 2000;
    await cargar(id, 200, haceDias(28), { horometro });
    for (const d of [24, 18, 12, 6]) {
      await cargar(id, 50, haceDias(d + 1)); // sin horómetro
      horometro += 10;
      await cargar(id, 200, haceDias(d), { horometro });
    }
    const f = ((await reporte()).body.equipos as FilaConsumo[]).find((x) =>
      x.placa_codigo.startsWith("SIN")
    )!;
    // (4 × 200 + 4 × 50) / 40 h = 25 L/h. Contando solo las cargas con
    // horómetro saldría 20, y el equipo parecería más sano de lo que es.
    expect(f.periodo!.consumo).toBe(25);
  });

  it("la sugerencia de consumo máximo también cuenta las cargas sin horómetro", async () => {
    const id = await equipo(idUnico("SUG"), "Scania", idUnico("G450"));
    let horometro = 3000;
    await cargar(id, 200, haceDias(100), { horometro });
    for (let i = 12; i >= 1; i--) {
      await cargar(id, 50, haceDias(i * 7 + 1));
      horometro += 10;
      await cargar(id, 200, haceDias(i * 7), { horometro });
    }
    const r = await admin.get(`/api/erp/combustible/equipos/${id}/sugerencia-consumo`);
    expect(r.status).toBe(200);
    expect(r.body.muestraSuficiente).toBe(true);
    expect(r.body.promedio).toBe(25);
  });

  it("solo el admin ve el reporte", async () => {
    expect((await reporte(operador)).status).toBe(403);
  });

  /** 200 L cada 10 h con máximo 20 L/h: justo en el borde. Entre la segunda
   *  y la tercera carga va `intermedio`; lo que se prueba es si cuenta. */
  async function escenario(intermedio: "urea" | "diesel_sin_horometro") {
    const equipo = await admin.post("/api/erp/equipos").send({
      placa_codigo: idUnico("VQ"),
      tipo: "Volquete",
      tipo_medidor: "horometro",
      consumo_maximo_l: 20,
    });
    expect(equipo.status).toBe(201);
    const tq = await admin.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque",
      tipo_combustible: "diesel_b5",
      unidad: "L",
      tipo_punto: "fijo",
      capacidad_total: 20000,
      nivel_actual: 10000,
      requiere_documento: false,
      modo_vigilancia: "personalizado",
      umbral_diferencia_pct: 1,
      umbral_descuadre_pct: null,
      umbral_descuadre_ciclo_pct: null,
      umbral_descuadre_ventana_pct: null,
    });
    expect(tq.status).toBe(201);
    const serie = serieUnica();
    let n = 1;
    const vale = (cantidad: number, minuto: number, horometro?: number) =>
      admin.post("/api/erp/combustible/despachos").send({
        origen: "tanque_propio",
        combustible_id: tq.body.id,
        tipo_combustible: "diesel_b5",
        tipo_destino: "equipo",
        equipo_id: equipo.body.id,
        serie_talonario: serie,
        n_vale: n++,
        cantidad,
        lectura_contometro: cantidad,
        ...(horometro !== undefined ? { lectura_horometro: horometro } : {}),
        costo_unitario: 16.8,
        despachado_en: new Date(Date.now() + minuto * 60_000).toISOString(),
      });

    expect((await vale(200, 1, 1000)).status).toBe(201);
    expect((await vale(200, 2, 1010)).status).toBe(201);
    if (intermedio === "urea") {
      const u = await admin.post("/api/erp/combustible/despachos").send({
        producto: "urea",
        origen: "compra_externa",
        grifo_id: grifoUrea,
        tipo_destino: "equipo",
        equipo_id: equipo.body.id,
        serie_talonario: serieUnica(),
        n_vale: 1,
        presentacion: "bolsa",
        cantidad_bultos: 4,
        despachado_en: new Date(Date.now() + 3 * 60_000).toISOString(),
      });
      expect(u.status).toBe(201);
    } else {
      expect((await vale(40, 3)).status).toBe(201);
    }
    expect((await vale(200, 4, 1020)).status).toBe(201);

    const r = await admin.get("/api/erp/combustible/alertas").query({ pageSize: 500 });
    return (r.body.data as { tipo: string; detalle: Record<string, unknown> }[]).filter(
      (a) => a.tipo === "consumo_excedido" && a.detalle.equipo === equipo.body.placa_codigo
    );
  }

  it("un vale de urea en el medio no dispara consumo_excedido", async () => {
    expect(await escenario("urea")).toHaveLength(0);
  });

  it("gemelo: los mismos litros de diésel sin horómetro SÍ lo disparan", async () => {
    expect((await escenario("diesel_sin_horometro")).length).toBeGreaterThan(0);
  });
});
