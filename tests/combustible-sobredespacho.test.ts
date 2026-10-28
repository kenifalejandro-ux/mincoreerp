/** tests/combustible-sobredespacho.test.ts
 *
 * Fase D: se despachó más de lo que el tanque de esa unidad puede contener
 * (migraciones 0069 y 0070). El caso del punto 5 del documento: "EX-04
 * tiene tanque de 40 gal, Juan despacha 48".
 *
 * Lo que estos tests fijan, más allá del happy path:
 *  - NO bloquea: el vale entra igual (201), solo queda marcado -- si
 *    bloqueara, la excavadora se queda sin combustible por una duda de dato;
 *  - un equipo SIN capacidad configurada no dispara nada (es el estado
 *    inicial de todos, a propósito: sin dato real no se inventa uno);
 *  - la conversión gal/L se hace de verdad -- comparar 40 gal contra 48 L
 *    sin convertir daría una alerta falsa (48 L son 12,7 gal);
 *  - el sobredespacho se revisa A MANO, a diferencia del hueco, que se
 *    resuelve solo.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase } from "../src/server/config/database";

function serieUnica(): string {
  return `S${Math.floor(Math.random() * 1e8).toString(36)}`;
}

describe("combustible: sobredespacho (Fase D, migraciones 0069/0070)", () => {
  let tenantId: string;
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);

  // Un tanque por unidad, para poder probar la conversión en los dos sentidos.
  let tanqueGalId: number;
  let tanqueLitrosId: number;

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });

    const tanqueGal = await agente.post("/api/erp/combustible").send({
      codigo: idUnico("TQG"),
      tanque_nombre: "Tanque en galones",
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_punto: "fijo",
      capacidad_total: 20000,
      nivel_actual: 10000,
    });
    tanqueGalId = tanqueGal.body.id;

    const tanqueLitros = await agente.post("/api/erp/combustible").send({
      codigo: idUnico("TQL"),
      tanque_nombre: "Tanque en litros",
      tipo_combustible: "diesel_b5",
      unidad: "L",
      tipo_punto: "fijo",
      capacidad_total: 50000,
      nivel_actual: 30000,
    });
    tanqueLitrosId = tanqueLitros.body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  async function crearEquipo(capacidad?: { valor: number; unidad: "gal" | "L" }) {
    const res = await agente.post("/api/erp/equipos").send({
      placa_codigo: idUnico("EX"),
      tipo: "Excavadora",
      ...(capacidad
        ? { capacidad_tanque: capacidad.valor, capacidad_tanque_unidad: capacidad.unidad }
        : {}),
    });
    expect(res.status).toBe(201);
    return res.body;
  }

  async function despachar(equipoId: number, tanqueId: number, cantidad: number, serie: string) {
    return agente.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tanqueId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipoId,
      serie_talonario: serie,
      n_vale: 1,
      cantidad,
      lectura_contometro: cantidad,
      costo_unitario: 16.8,
      despachado_en: new Date().toISOString(),
    });
  }

  async function alertasDeSerie(serie: string) {
    const res = await agente.get("/api/erp/combustible/alertas").query({ pageSize: 200 });
    return res.body.data.filter((a: { serie_talonario: string }) => a.serie_talonario === serie);
  }

  it("despachar más que la capacidad NO bloquea el vale, pero lo marca", async () => {
    // El caso literal del documento: tanque de 40 gal, se despachan 48.
    const equipo = await crearEquipo({ valor: 40, unidad: "gal" });
    const serie = serieUnica();

    const despacho = await despachar(equipo.id, tanqueGalId, 48, serie);
    // Lo importante: 201, no 400 -- la unidad no se queda sin combustible.
    expect(despacho.status).toBe(201);

    const propias = await alertasDeSerie(serie);
    const alerta = propias.find((a: { tipo: string }) => a.tipo === "sobredespacho");
    expect(alerta).toBeDefined();
    expect(alerta.detalle.cantidad).toBe(48);
    expect(alerta.detalle.capacidad).toBe(40);
    expect(alerta.detalle.excesoPct).toBe(20);
    expect(alerta.resuelta_en).toBeNull();
  });

  it("un despacho que entra en el tanque no genera ninguna alerta", async () => {
    const equipo = await crearEquipo({ valor: 40, unidad: "gal" });
    const serie = serieUnica();

    const despacho = await despachar(equipo.id, tanqueGalId, 35, serie);
    expect(despacho.status).toBe(201);

    const propias = await alertasDeSerie(serie);
    expect(propias.filter((a: { tipo: string }) => a.tipo === "sobredespacho")).toHaveLength(0);
  });

  it("un equipo SIN capacidad configurada nunca dispara sobredespacho", async () => {
    // El estado inicial de todos los equipos (migración 0069): sin el dato
    // real no se compara contra nada, aunque la cantidad sea absurda.
    const equipo = await crearEquipo();
    const serie = serieUnica();

    const despacho = await despachar(equipo.id, tanqueGalId, 5000, serie);
    expect(despacho.status).toBe(201);

    const propias = await alertasDeSerie(serie);
    expect(propias.filter((a: { tipo: string }) => a.tipo === "sobredespacho")).toHaveLength(0);
  });

  it("convierte unidades: 48 LITROS a un tanque de 40 GALONES no es sobredespacho", async () => {
    // 48 L = 12,7 gal, ni cerca de llenar 40 gal. Sin conversión, comparar
    // 48 contra 40 daría una alerta falsa -- este test fija justamente eso.
    const equipo = await crearEquipo({ valor: 40, unidad: "gal" });
    const serie = serieUnica();

    const despacho = await despachar(equipo.id, tanqueLitrosId, 48, serie);
    expect(despacho.status).toBe(201);

    const propias = await alertasDeSerie(serie);
    expect(propias.filter((a: { tipo: string }) => a.tipo === "sobredespacho")).toHaveLength(0);
  });

  it("convierte unidades: 200 LITROS a un tanque de 40 GALONES sí es sobredespacho", async () => {
    // 200 L = 52,8 gal contra 40 gal de capacidad -- el mismo caso de arriba
    // pero del lado en que la conversión SÍ tiene que disparar.
    const equipo = await crearEquipo({ valor: 40, unidad: "gal" });
    const serie = serieUnica();

    const despacho = await despachar(equipo.id, tanqueLitrosId, 200, serie);
    expect(despacho.status).toBe(201);

    const propias = await alertasDeSerie(serie);
    const alerta = propias.find((a: { tipo: string }) => a.tipo === "sobredespacho");
    expect(alerta).toBeDefined();
    expect(alerta.detalle.unidadDespacho).toBe("L");
    expect(alerta.detalle.unidadCapacidad).toBe("gal");
  });

  // ── Compra en ruta (0158): sin tanque, la unidad la trae la boleta ─────

  async function comprarEnRuta(
    capacidad: { valor: number; unidad: "gal" | "L" },
    cantidad: number,
    unidad?: "gal" | "L"
  ) {
    const equipo = await agente.post("/api/erp/equipos").send({
      placa_codigo: idUnico("TR"),
      tipo: "TRAILER",
      tipo_medidor: "odometro",
      capacidad_tanque: capacidad.valor,
      capacidad_tanque_unidad: capacidad.unidad,
    });
    expect(equipo.status, JSON.stringify(equipo.body)).toBe(201);
    const grifo = await agente.post("/api/erp/combustible/grifos").send({
      nombre: idUnico("GRIFO"),
      abastece_ruta: true,
      abastece_tanque: false,
    });
    const r = await agente.post("/api/erp/combustible/compras-ruta").send({
      cliente_uuid: crypto.randomUUID(),
      grifo_id: grifo.body.id,
      comprobante_tipo: "boleta",
      comprobante_numero: idUnico("B"),
      equipo_id: equipo.body.id,
      despachado_en: new Date(Date.now() - 3_600_000).toISOString(),
      combustible: {
        tipo_combustible: "diesel_b5",
        cantidad,
        ...(unidad ? { unidad } : {}),
        costo_unitario: 4.5,
        lectura_odometro: 1000,
        horas_abastecidas: 5,
      },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const despachoId = r.body.despacho_combustible.id;
    const res = await agente.get("/api/erp/combustible/alertas").query({ pageSize: 200 });
    return (res.body.data as { tipo: string; despacho_id: number | null; detalle: never }[]).filter(
      (a) => a.tipo === "sobredespacho" && a.despacho_id === despachoId
    );
  }

  it("una compra en ruta de 100 gal a un tanque de 60 gal sí es sobredespacho", async () => {
    const alertas = await comprarEnRuta({ valor: 60, unidad: "gal" }, 100, "gal");
    expect(alertas).toHaveLength(1);
    expect(alertas[0].detalle).toMatchObject({
      cantidad: 100,
      unidadDespacho: "gal",
      capacidad: 60,
      unidadCapacidad: "gal",
    });
  });

  it("una compra en ruta sin unidad (cola vieja) se evalúa como galones", async () => {
    const alertas = await comprarEnRuta({ valor: 60, unidad: "gal" }, 100);
    expect(alertas).toHaveLength(1);
    expect(alertas[0].detalle).toMatchObject({ unidadDespacho: "gal" });
  });

  it("convierte: 100 LITROS comprados a un tanque de 60 GALONES no es sobredespacho", async () => {
    // 100 L = 26,4 gal. Sin la unidad de la boleta se leería como 100 gal y daría una alerta falsa.
    const alertas = await comprarEnRuta({ valor: 60, unidad: "gal" }, 100, "L");
    expect(alertas).toHaveLength(0);
  });

  it("convierte: 300 LITROS comprados a un tanque de 60 GALONES sí es sobredespacho", async () => {
    // 300 L = 79,2 gal contra 60 gal.
    const alertas = await comprarEnRuta({ valor: 60, unidad: "gal" }, 300, "L");
    expect(alertas).toHaveLength(1);
    expect(alertas[0].detalle).toMatchObject({ unidadDespacho: "L", unidadCapacidad: "gal" });
  });

  it("una compra en ruta que cabe en el tanque no genera alerta", async () => {
    const alertas = await comprarEnRuta({ valor: 60, unidad: "gal" }, 40, "gal");
    expect(alertas).toHaveLength(0);
  });

  it("la alerta de sobredespacho se revisa a mano (a diferencia del hueco)", async () => {
    const equipo = await crearEquipo({ valor: 40, unidad: "gal" });
    const serie = serieUnica();
    await despachar(equipo.id, tanqueGalId, 60, serie);

    const propias = await alertasDeSerie(serie);
    const alerta = propias.find((a: { tipo: string }) => a.tipo === "sobredespacho");

    const resuelta = await agente
      .patch(`/api/erp/combustible/alertas/${alerta.id}/resolver`)
      .send({ motivo: "Revisado y dado por bueno" });
    expect(resuelta.status).toBe(200);
    expect(resuelta.body.resuelta_en).not.toBeNull();
    // A mano = queda registrado QUIÉN la revisó, a diferencia de un hueco
    // que se resuelve solo y deja resuelta_por en NULL.
    expect(resuelta.body.resuelta_por).not.toBeNull();
  });

  // ── El dato del equipo ────────────────────────────────────────────────

  it("guarda y devuelve la capacidad con su unidad", async () => {
    const equipo = await crearEquipo({ valor: 78.5, unidad: "gal" });
    expect(Number(equipo.capacidad_tanque)).toBe(78.5);
    expect(equipo.capacidad_tanque_unidad).toBe("gal");

    const listado = await agente.get("/api/erp/equipos").query({ pageSize: 200 });
    const fila = listado.body.data.find((e: { id: number }) => e.id === equipo.id);
    expect(Number(fila.capacidad_tanque)).toBe(78.5);
  });

  it("un equipo nuevo sin capacidad la deja en NULL, no en 0", async () => {
    // 0 significaría "tanque de capacidad cero" y haría que CUALQUIER
    // despacho fuera sobredespacho. NULL es "sin configurar".
    const equipo = await crearEquipo();
    expect(equipo.capacidad_tanque).toBeNull();
    expect(equipo.capacidad_tanque_unidad).toBeNull();
  });

  it("rechaza la capacidad sin unidad, y la unidad sin capacidad", async () => {
    const soloNumero = await agente
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("EX"), tipo: "Excavadora", capacidad_tanque: 40 });
    expect(soloNumero.status).toBe(400);

    const soloUnidad = await agente
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("EX"), tipo: "Excavadora", capacidad_tanque_unidad: "gal" });
    expect(soloUnidad.status).toBe(400);
  });

  it("editar un equipo permite cargar la capacidad y también borrarla", async () => {
    const equipo = await crearEquipo();

    const conCapacidad = await agente.put(`/api/erp/equipos/${equipo.id}`).send({
      placa_codigo: equipo.placa_codigo,
      tipo: equipo.tipo,
      capacidad_tanque: 300,
      capacidad_tanque_unidad: "L",
    });
    expect(conCapacidad.status).toBe(200);
    expect(Number(conCapacidad.body.capacidad_tanque)).toBe(300);

    // Volver a "sin configurar" tiene que ser posible: si alguien cargó un
    // número mal, dejarlo vacío es mejor que dejarlo equivocado.
    const sinCapacidad = await agente
      .put(`/api/erp/equipos/${equipo.id}`)
      .send({ placa_codigo: equipo.placa_codigo, tipo: equipo.tipo });
    expect(sinCapacidad.status).toBe(200);
    expect(sinCapacidad.body.capacidad_tanque).toBeNull();
  });
});
