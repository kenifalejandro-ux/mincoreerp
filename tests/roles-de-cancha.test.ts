/** tests/roles-de-cancha.test.ts
 *
 * Los dos roles de la migración 0085: `grifero` y `conductor_ruta`.
 *
 * El test central de este archivo es el del ORIGEN. Los demás verifican
 * puertas que cierra `requireRole`, que es un middleware probado y aburrido;
 * el del origen verifica una puerta que requireRole NO PUEDE cerrar, porque
 * el vale del tanque propio y la compra en grifo de ruta entran por el MISMO
 * endpoint y se distinguen por un campo del body. Si esa validación se cae,
 * el rol `conductor_ruta` sigue existiendo, la pantalla sigue mostrándolo
 * restringido, y un conductor puede vaciar el tanque de la empresa.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase } from "../src/server/config/database";

function serieUnica(): string {
  return `S${Math.floor(Math.random() * 1e8).toString(36)}`;
}

describe("combustible: roles de cancha (migración 0085)", () => {
  let tenantId: string;
  let slug: string;
  let tanqueId: number;
  let grifoId: number;
  let equipoId: number;
  const password = "ClaveDePrueba123";
  const admin = request.agent(app);
  const grifero = request.agent(app);
  const conductor = request.agent(app);
  const encargadoUrea = request.agent(app);
  const operador = request.agent(app);
  let seq = 0;
  const dniUnico = () => String(82000000 + seq++);

  /** Da de alta a alguien con ese rol y devuelve un agente ya logueado. */
  async function altaYLogin(agente: ReturnType<typeof request.agent>, rol: string) {
    const dni = dniUnico();
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre: `Persona ${rol}`, dni, password, rol });
    expect(alta.status).toBe(201);
    const entro = await agente
      .post("/api/auth/login")
      .send({ tenantSlug: slug, identificador: dni, password });
    expect(entro.status).toBe(200);
    return alta.body;
  }

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    slug = creado.tenant.slug;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: slug, email: creado.usuario.email, password });

    const tanque = await admin.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: idUnico("Tanque"),
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_punto: "fijo",
      capacidad_total: 50000,
      nivel_actual: 10000,
      requiere_documento: false,
    });
    expect(tanque.status).toBe(201);
    tanqueId = tanque.body.id;

    const grifo = await admin
      .post("/api/erp/combustible/grifos")
      .send({ nombre: idUnico("PRIMAX") });
    grifoId = grifo.body.id;

    const equipo = await admin
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("VQ"), tipo: "Volquete", tipo_medidor: "horometro" });
    equipoId = equipo.body.id;

    await altaYLogin(grifero, "grifero");
    await altaYLogin(conductor, "conductor_ruta");
    await altaYLogin(encargadoUrea, "encargado_urea");
    await altaYLogin(operador, "operador");
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  const valeDelTanque = (over: Record<string, unknown> = {}) => ({
    origen: "tanque_propio",
    combustible_id: tanqueId,
    tipo_combustible: "diesel_b5",
    tipo_destino: "equipo",
    equipo_id: equipoId,
    serie_talonario: serieUnica(),
    n_vale: 1,
    cantidad: 30,
    // El contómetro del surtidor tiene que coincidir con lo declarado -- lo
    // valida el propio módulo (ver validarFormaDespacho).
    lectura_contometro: 30,
    costo_unitario: 16.8,
    despachado_en: new Date().toISOString(),
    ...over,
  });

  const compraEnRuta = (over: Record<string, unknown> = {}) => ({
    origen: "compra_externa",
    grifo_id: grifoId,
    tipo_combustible: "diesel_b5",
    tipo_destino: "equipo",
    equipo_id: equipoId,
    serie_talonario: serieUnica(),
    n_vale: 1,
    cantidad: 40,
    lectura_horometro: 1000 + seq++ * 10,
    horas_abastecidas: 8,
    costo_unitario: 17.5,
    despachado_en: new Date().toISOString(),
    ...over,
  });

  // ── Lo que cada uno SÍ puede ─────────────────────────────────────────

  it("el grifero registra el vale del tanque", async () => {
    const res = await grifero.post("/api/erp/combustible/despachos").send(valeDelTanque());
    expect(res.status).toBe(201);
  });

  it("el conductor de ruta registra su compra en grifo externo", async () => {
    const res = await conductor.post("/api/erp/combustible/despachos").send(compraEnRuta());
    expect(res.status).toBe(201);
  });

  it("el grifero registra la recepción del camión", async () => {
    // Es quien está parado ahí cuando llega la cisterna. Hacer que espere a
    // un administrativo garantiza que se cargue de memoria horas después.
    const res = await grifero.post("/api/erp/combustible/recepciones").send({
      combustible_id: tanqueId,
      grifo_id: grifoId,
      cantidad: 500,
      costo_unitario: 16.5,
      recibido_en: new Date().toISOString(),
    });
    expect(res.status).toBe(201);
  });

  // Matriz robusta de perfiles (profile_user.xlsx, confirmado por Kenif
  // 2026-10-01): Operador parte con acceso amplio -- ve y opera casi todo
  // en Combustible y en el resto de módulos del ERP; cada tenant recorta
  // desde Administración → Configuración según sus propias políticas. Lo
  // que sigue siendo admin-only son las cosas sin fila en esa matriz
  // (configuración del tanque, reportes de segregación/controles que
  // auditan al propio operador, validar recepción) y Facturación.
  it("el operador en Combustible tiene acceso amplio por defecto (matriz robusta)", async () => {
    expect((await operador.post("/api/erp/combustible/lecturas").send(varilla(9200))).status).toBe(
      201
    );
    expect(
      (await operador.post("/api/erp/combustible/despachos").send(valeDelTanque())).status
    ).toBe(201);
    expect(
      (
        await operador.post("/api/erp/combustible/recepciones").send({
          combustible_id: tanqueId,
          grifo_id: grifoId,
          cantidad: 100,
          costo_unitario: 16,
          recibido_en: new Date().toISOString(),
        })
      ).status
    ).toBe(201);
    expect((await operador.get("/api/erp/combustible/config")).status).toBe(403);
    const desde = new Date(Date.now() - 3600_000).toISOString();
    const hasta = new Date().toISOString();
    expect(
      (await operador.get(`/api/erp/combustible/${tanqueId}/kardex?desde=${desde}&hasta=${hasta}`))
        .status
    ).toBe(200);
    expect((await operador.get("/api/facturacion/comprobantes")).status).toBe(403);
    expect(
      (
        await operador.post("/api/erp/combustible").send({
          codigo: idUnico("TQ"),
          tanque_nombre: idUnico("Tanque operador"),
          tipo_combustible: "diesel_b5",
          unidad: "gal",
          tipo_punto: "fijo",
          capacidad_total: 1000,
          nivel_actual: 0,
        })
      ).status
    ).toBe(201);
    expect(
      (
        await operador.post("/api/erp/equipos").send({
          placa_codigo: idUnico("VQ"),
          tipo: "Volquete",
          tipo_medidor: "horometro",
        })
      ).status
    ).toBe(201);
  });

  // ── El cruce que requireRole no puede frenar ─────────────────────────

  it("el conductor de ruta NO puede despachar del tanque de la empresa", async () => {
    // La misma URL que acaba de usar legítimamente, con otro `origen`.
    const res = await conductor.post("/api/erp/combustible/despachos").send(valeDelTanque());
    expect(res.status).toBe(403);
  });

  it("el grifero NO puede registrar compras en grifos de ruta", async () => {
    const res = await grifero.post("/api/erp/combustible/despachos").send(compraEnRuta());
    expect(res.status).toBe(403);
  });

  it("el rechazo por origen ocurre ANTES de escribir nada", async () => {
    // Un permiso que se evalúa después de escribir no es un permiso: si el
    // vale quedara creado y solo fallara la respuesta, el combustible ya
    // habría salido del tanque en los números.
    const vale = valeDelTanque();
    const res = await conductor.post("/api/erp/combustible/despachos").send(vale);
    expect(res.status).toBe(403);

    const lista = await admin.get("/api/erp/combustible/despachos").query({ pageSize: 200 });
    const rastro = lista.body.data.filter(
      (d: { serie_talonario: string }) => d.serie_talonario === vale.serie_talonario
    );
    expect(rastro).toHaveLength(0);
  });

  // ── Lo que ninguno de los dos puede ──────────────────────────────────

  it("el grifero NO anula un vale, ni siquiera el suyo", async () => {
    // Anular es la maniobra de fraude más limpia: se despachan 200 L de
    // verdad, se anula el vale, el combustible salió y el papel dice que no.
    const propio = await grifero.post("/api/erp/combustible/despachos").send(valeDelTanque());
    expect(propio.status).toBe(201);

    const res = await grifero
      .patch(`/api/erp/combustible/despachos/${propio.body.id}/anular`)
      .send({ motivo: "Me equivoqué al tipear" });
    expect(res.status).toBe(403);

    // Y el admin sí puede: la salida existe, solo que pasa por otra persona.
    const porElAdmin = await admin
      .patch(`/api/erp/combustible/despachos/${propio.body.id}/anular`)
      .send({ motivo: "El grifero avisó que lo tipeó mal" });
    expect(porElAdmin.status).toBe(200);
  });

  it("ninguno de los dos ve alertas, umbrales ni reportes", async () => {
    for (const agente of [grifero, conductor]) {
      expect((await agente.get("/api/erp/combustible/alertas")).status).toBe(403);
      expect((await agente.get("/api/erp/combustible/config")).status).toBe(403);
      expect((await agente.get("/api/erp/combustible/anomalias")).status).toBe(403);
      expect((await agente.get("/api/erp/combustible/bitacora")).status).toBe(403);
      expect((await agente.get(`/api/erp/combustible/${tanqueId}/kardex`)).status).toBe(403);
    }
  });

  it("ninguno de los dos crea, edita ni da de baja tanques", async () => {
    for (const agente of [grifero, conductor]) {
      const alta = await agente.post("/api/erp/combustible").send({
        codigo: idUnico("TQ"),
        tanque_nombre: idUnico("Clandestino"),
        tipo_combustible: "diesel_b5",
        unidad: "gal",
        tipo_punto: "fijo",
        capacidad_total: 1000,
        nivel_actual: 0,
      });
      expect(alta.status).toBe(403);
      expect((await agente.delete(`/api/erp/combustible/${tanqueId}`)).status).toBe(403);
    }
  });

  it("ninguno de los dos da de alta usuarios", async () => {
    for (const agente of [grifero, conductor]) {
      const res = await agente
        .post("/api/erp/usuarios")
        .send({ nombre: "Cómplice", dni: dniUnico(), password, rol: "admin" });
      expect(res.status).toBe(403);
    }
  });

  // ── Solo ven Combustible ─────────────────────────────────────────────

  it("los roles de cancha solo reciben el módulo de combustible en su sesión", async () => {
    // Y no porque alguien se acuerde de desmarcarles los demás módulos al
    // darlos de alta: lo dice el rol, así el primer olvido no le abre IPERC
    // a un conductor.
    const yo = await grifero.get("/api/auth/me");
    expect(yo.body.usuario.modulosPermitidos).toEqual(["combustible"]);

    // Y el resto de los módulos responde que no está disponible.
    expect((await grifero.get("/api/erp/equipos")).status).toBe(403);
    expect((await conductor.get("/api/erp/iperc")).status).toBe(403);
  });

  it("el conductor solo consulta unidades para despachar, no tanques ni el módulo Equipos", async () => {
    expect((await conductor.get("/api/erp/combustible")).status).toBe(403);
    expect((await conductor.get("/api/erp/equipos?pageSize=200")).status).toBe(403);

    const unidades = await conductor
      .get("/api/erp/combustible/equipos-destino")
      .query({ pageSize: 200 });
    expect(unidades.status).toBe(200);
    expect(unidades.body.data.some((equipo: { id: number }) => equipo.id === equipoId)).toBe(true);
  });

  it("Grifero y Conductor no acceden por API a pestañas ocultas por defecto", async () => {
    for (const agente of [grifero, conductor]) {
      expect((await agente.get("/api/erp/combustible/consumo-por-conductor")).status).toBe(403);
      expect((await agente.get("/api/erp/combustible/urea/estado")).status).toBe(403);
    }
    expect((await conductor.get(`/api/erp/combustible/${tanqueId}/lecturas`)).status).toBe(403);
  });

  it("Encargado de Urea solo ve Urea y no opera combustible ni módulos generales", async () => {
    const yo = await encargadoUrea.get("/api/auth/me");
    expect(yo.body.usuario.modulosPermitidos).toEqual(["combustible"]);
    expect((await encargadoUrea.get("/api/erp/combustible")).status).toBe(403);
    expect((await encargadoUrea.get("/api/erp/combustible/urea/estado")).status).toBe(200);
    expect((await encargadoUrea.get("/api/erp/equipos")).status).toBe(403);
    expect(
      (await encargadoUrea.get("/api/erp/combustible/equipos-destino?pageSize=200")).status
    ).toBe(200);

    const intentoCombustible = await encargadoUrea
      .post("/api/erp/combustible/despachos")
      .send(compraEnRuta({ producto: "combustible" }));
    expect(intentoCombustible.status).toBe(403);
  });

  // ── La varilla, que es configurable ──────────────────────────────────

  async function ponerVarillaDelGrifero(puede: boolean) {
    const actual = await admin.get("/api/erp/combustible/config");
    expect(actual.status).toBe(200);
    const res = await admin
      .put("/api/erp/combustible/config")
      // Devolverle la varilla al grifero AFLOJA (el que despacha vuelve a ser
      // el que mide), y desde la 5ª auditoría aflojar la config exige motivo,
      // igual que aflojar la ficha de un tanque.
      .send({
        ...actual.body,
        grifero_registra_varilla: puede,
        motivo_ajuste: "ajuste de prueba",
      });
    expect(res.status).toBe(200);
  }

  const varilla = (nivel: number) => ({
    combustible_id: tanqueId,
    nivel,
    leido_en: new Date().toISOString(),
  });

  it("por defecto el grifero toma varilla: es lo que hace hoy la mayoría", async () => {
    const config = await admin.get("/api/erp/combustible/config");
    expect(config.body.grifero_registra_varilla).toBe(true);

    const res = await grifero.post("/api/erp/combustible/lecturas").send(varilla(9000));
    expect(res.status).toBe(201);
  });

  it("si la empresa la separa, el grifero deja de poder medir", async () => {
    await ponerVarillaDelGrifero(false);
    try {
      const res = await grifero.post("/api/erp/combustible/lecturas").send(varilla(8900));
      expect(res.status).toBe(403);

      // El admin sigue pudiendo: se separó quién mide, no se apagó la varilla.
      expect((await admin.post("/api/erp/combustible/lecturas").send(varilla(8900))).status).toBe(
        201
      );
    } finally {
      await ponerVarillaDelGrifero(true);
    }
  });

  it("devolverle la varilla al grifero queda auditado como aflojamiento", async () => {
    // El que despacha vuelve a ser el que mide: la varilla deja de ser un
    // control independiente. Es una decisión legítima -- y el default-- pero
    // apagarla y volver a prenderla no puede pasar en silencio.
    await ponerVarillaDelGrifero(false);
    await ponerVarillaDelGrifero(true);

    const bitacora = await admin.get("/api/erp/combustible/bitacora").query({ pageSize: 50 });
    const reducciones = bitacora.body.data.filter(
      (e: { accion: string }) => e.accion === "combustible.config_vigilancia_reducida"
    );
    expect(reducciones.length).toBeGreaterThan(0);
  });

  // ── El grifero tampoco anula varillas ────────────────────────────────

  // Matriz robusta de perfiles (profile_user.xlsx, fila 21, confirmado por
  // Kenif 2026-10-01): "puede anular el mal tipeo pero justificando, deja
  // alerta". El riesgo sigue siendo el de siempre --una varilla que se puede
  // anular es una varilla que se puede hacer coincidir con lo que uno ya
  // declaró-- y lo que lo hace tolerable es que no pasa en silencio.
  it("el grifero anula su varilla mal tipeada, pero deja alerta con el motivo", async () => {
    const propia = await grifero.post("/api/erp/combustible/lecturas").send(varilla(8800));
    expect(propia.status).toBe(201);

    const res = await grifero
      .patch(`/api/erp/combustible/lecturas/${propia.body.lectura.id}/anular`)
      .send({ motivo: "Leí mal la regla" });
    expect(res.status).toBe(200);

    const alertas = await admin.get("/api/erp/combustible/alertas?pageSize=200");
    expect(alertas.status).toBe(200);
    const dejada = (alertas.body.data as { tipo: string; detalle: { motivo?: string } }[]).find(
      (a) => a.tipo === "lectura_anulada"
    );
    expect(dejada?.detalle.motivo).toBe("Leí mal la regla");
  });

  // El motivo no es opcional: sin él la anulación no se puede auditar.
  it("el grifero no puede anular sin justificar", async () => {
    const propia = await grifero.post("/api/erp/combustible/lecturas").send(varilla(8700));
    expect(propia.status).toBe(201);

    const res = await grifero
      .patch(`/api/erp/combustible/lecturas/${propia.body.lectura.id}/anular`)
      .send({});
    expect(res.status).toBe(400);
  });
});
