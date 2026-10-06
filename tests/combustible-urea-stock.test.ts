/** tests/combustible-urea-stock.test.ts
 *
 * Stock de urea: los dos umbrales globales, sus dos alertas y el asistente
 * (migración 0117). Ver docs/architecture/urea-industrial.md, decisiones 4 y 5.
 *
 * Lo que estos tests defienden:
 *
 *   1. NULL = no alerta. Los dos umbrales nacen apagados y mientras lo estén,
 *      el stock puede ir a donde quiera sin que nadie reciba nada.
 *   2. `urea_stock_bajo` es un ESTADO: una sola alerta por episodio (no una
 *      por vale), se auto-resuelve cuando entra una compra, y NO se congela
 *      como anomalía.
 *   3. `urea_stock_excedido` es un HALLAZGO: mira el stock PROYECTADO, así
 *      que atrapa comprar de a poco hasta llenar el depósito -- que es el
 *      vector que un tope por compra no ve. Y no bloquea la entrada.
 *   4. El mínimo por encima del máximo se RECHAZA: es el único caso de esta
 *      config que no se puede guardar.
 *   5. Bajar el mínimo o subir el máximo AFLOJA y pide motivo.
 *   6. El asistente nace diciendo "muestra insuficiente" y no se aplica solo.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";

/** Se mockea el PRIMITIVO, no cada mensaje: `enviarCorreoAlerta` es por donde
 *  pasan los veinte correos del módulo (ver alertaMailer.ts), así que un solo
 *  mock prueba la cadena entera -- que el evaluador devolvió el hallazgo, que
 *  el controller armó los parámetros bien y que la plantilla se renderizó.
 *
 *  Hace falta porque todo esto corre en un try/catch best-effort: si el
 *  correo se llamara con la forma equivocada, el error se loguearía y la
 *  alerta igual quedaría creada -- el test pasaría sin que el correo
 *  funcione. Pasó en 0092: cuatro correos de urea quedaron escritos y nunca
 *  enganchados, y ningún test lo notó durante veinte días.
 *
 *  Y además `setup.mailer.ts` deja `emailConfigured` en false para que la
 *  suite no mande correo real, así que sin mockear acá el primitivo saldría
 *  por el `return` temprano y no se ejercitaría nada. */
const correosEnviados: { asunto: string; titulo: string; lineas: string[] }[] = [];
vi.mock("../src/server/shared/utils/alertaMailer", () => ({
  enviarCorreoAlerta: vi.fn(
    async (params: {
      destinatarios: { email: string }[];
      asunto: string;
      titulo: string;
      lineas: string[];
    }) => {
      if (params.destinatarios.length === 0) return;
      correosEnviados.push({
        asunto: params.asunto,
        titulo: params.titulo,
        lineas: params.lineas,
      });
    }
  ),
}));

function serieUnica(): string {
  return `S${Math.floor(Math.random() * 1e8).toString(36)}`;
}

describe("combustible: stock de urea y sus umbrales (migración 0117)", () => {
  let tenantId: string;
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);

  let equipoId: number;
  let grifoUrea: number;
  let nVale = 1;

  /** La config completa, con los cambios encima. El PUT reemplaza la fila
   *  entera (ver el schema), así que hay que mandarla toda -- mismo patrón
   *  que `payloadEdicion` en combustible-endurecimiento.test.ts. */
  const configCon = async (cambios: Record<string, unknown>) => {
    const actual = await agente.get("/api/erp/combustible/config");
    expect(actual.status).toBe(200);
    const c = actual.body;
    return {
      ventana_gracia_horas: c.ventana_gracia_horas,
      dias_sin_medir: c.dias_sin_medir,
      dias_ventana_descuadre: c.dias_ventana_descuadre,
      dias_carga_retroactiva: c.dias_carga_retroactiva,
      dias_sin_vigilancia: c.dias_sin_vigilancia,
      llenados_por_dia_max: c.llenados_por_dia_max,
      tope_diario_sin_capacidad_l: c.tope_diario_sin_capacidad_l,
      grifero_registra_varilla: c.grifero_registra_varilla,
      recepcion_requiere_validacion: c.recepcion_requiere_validacion,
      horas_para_validar_recepcion: c.horas_para_validar_recepcion,
      dias_sin_varilla_de_control: c.dias_sin_varilla_de_control,
      tope_diario_urea_l: c.tope_diario_urea_l,
      ratio_urea_diesel_max_pct: c.ratio_urea_diesel_max_pct,
      dias_sin_conteo_urea: c.dias_sin_conteo_urea,
      stock_minimo_urea_l: c.stock_minimo_urea_l,
      stock_maximo_urea_l: c.stock_maximo_urea_l,
      despacho_pide_medidor: c.despacho_pide_medidor,
      ...cambios,
    };
  };

  const guardarConfig = async (cambios: Record<string, unknown>) =>
    agente.put("/api/erp/combustible/config").send(await configCon(cambios));

  /** Una entrada de urea: `cantidad_bultos` baldes de 20 L. */
  const entrada = (baldes: number) =>
    agente.post("/api/erp/combustible/recepciones").send({
      cliente_uuid: crypto.randomUUID(),
      producto: "urea",
      grifo_id: grifoUrea,
      presentacion: "balde",
      cantidad_bultos: baldes,
      costo_unitario: 30,
      recibido_en: new Date().toISOString(),
    });

  /** Un vale de urea: `baldes` de 20 L a la unidad. */
  const vale = (baldes: number) =>
    agente.post("/api/erp/combustible/despachos").send({
      cliente_uuid: crypto.randomUUID(),
      producto: "urea",
      origen: "compra_externa",
      grifo_id: grifoUrea,
      tipo_destino: "equipo",
      equipo_id: equipoId,
      serie_talonario: serieUnica(),
      n_vale: nVale++,
      presentacion: "balde",
      cantidad_bultos: baldes,
      despachado_en: new Date().toISOString(),
    });

  const alertas = async (tipo: string) =>
    withTenant(tenantId, (c) =>
      c.query<{ id: string; detalle: Record<string, unknown>; resuelta_en: Date | null }>(
        `SELECT id, detalle, resuelta_en FROM combustible_alertas
          WHERE tenant_id = $1 AND tipo = $2 ORDER BY id`,
        [tenantId, tipo]
      )
    );

  const stockActual = async (): Promise<number> => {
    const res = await agente.get("/api/erp/combustible/urea/estado");
    expect(res.status).toBe(200);
    return res.body.stock.stockL;
  };

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });

    const equipo = await agente
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("VQ"), tipo: "VOLQUETE" });
    equipoId = equipo.body.id;

    const grifo = await agente.post("/api/erp/combustible/grifos").send({
      nombre: idUnico("UREAPROV"),
      abastece_ruta: false,
      abastece_tanque: false,
      abastece_urea: true,
    });
    grifoUrea = grifo.body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  // ── 1. Nacen apagados ─────────────────────────────────────────────────

  it("una empresa nueva arranca con los dos umbrales en NULL y sin alertar nada", async () => {
    const config = await agente.get("/api/erp/combustible/config");
    expect(config.body.stock_minimo_urea_l).toBeNull();
    expect(config.body.stock_maximo_urea_l).toBeNull();

    // 200 L entran, 180 salen: el stock queda en 20, un número que sería
    // "bajo" con cualquier mínimo razonable. Sin umbral, nada.
    expect((await entrada(10)).status).toBe(201);
    expect((await vale(9)).status).toBe(201);
    expect(await stockActual()).toBe(20);

    expect((await alertas("urea_stock_bajo")).rowCount).toBe(0);
    expect((await alertas("urea_stock_excedido")).rowCount).toBe(0);
  });

  // ── 2. Stock bajo: un ESTADO ──────────────────────────────────────────

  it("con mínimo configurado, el vale que cruza la línea alerta UNA vez, no una por vale", async () => {
    // Stock actual: 20 L. Mínimo en 100 -> ya está por debajo, pero la alerta
    // nace con el próximo MOVIMIENTO (igual que nivel_bajo nace con la
    // próxima varilla, no al guardar la config).
    expect((await guardarConfig({ stock_minimo_urea_l: 100 })).status).toBe(200);
    expect((await alertas("urea_stock_bajo")).rowCount).toBe(0);

    // Subo el stock bien arriba del mínimo y después lo bajo cruzando.
    expect((await entrada(20)).status).toBe(201); // 20 + 400 = 420
    expect(await stockActual()).toBe(420);
    expect((await alertas("urea_stock_bajo")).rowCount).toBe(0);

    expect((await vale(17)).status).toBe(201); // 420 - 340 = 80 < 100
    expect(await stockActual()).toBe(80);

    const primera = await alertas("urea_stock_bajo");
    expect(primera.rowCount).toBe(1);
    expect(Number(primera.rows[0].detalle.stockL)).toBe(80);
    expect(Number(primera.rows[0].detalle.stockMinimoL)).toBe(100);
    expect(Number(primera.rows[0].detalle.faltanL)).toBe(20);

    // Tres vales más por debajo del mínimo: SIGUE habiendo UNA sola. Sin
    // esta deduplicación el control moriría por ruidoso -- diez vales en un
    // día serían diez avisos del mismo faltante.
    expect((await vale(1)).status).toBe(201);
    expect((await vale(1)).status).toBe(201);
    expect((await vale(1)).status).toBe(201);
    expect((await alertas("urea_stock_bajo")).rowCount).toBe(1);
  });

  it("la alerta de stock bajo se cierra SOLA cuando entra la compra que la arregla", async () => {
    const antes = await alertas("urea_stock_bajo");
    expect(antes.rows[0].resuelta_en).toBeNull();

    // Stock en 20 L (80 - 60). Entran 400 -> 420, muy por encima de 100.
    expect((await entrada(20)).status).toBe(201);

    const despues = await alertas("urea_stock_bajo");
    expect(despues.rowCount).toBe(1);
    expect(despues.rows[0].resuelta_en).not.toBeNull();
  });

  it("un episodio nuevo después de resolverse sí crea una alerta nueva", async () => {
    // Stock 420, mínimo 100. Bajo otra vez.
    expect((await vale(17)).status).toBe(201); // 420 - 340 = 80
    const todas = await alertas("urea_stock_bajo");
    expect(todas.rowCount).toBe(2);
    expect(todas.rows[1].resuelta_en).toBeNull();
  });

  it("el stock bajo NO entra en el CHECK de anomalías -- no se puede congelar", async () => {
    // Es la prueba de la decisión de 0117: un estado que se resuelve solo no
    // puede quedar como anomalía permanente. Si alguien lo agregara al CHECK
    // de anomalías "por simetría", el worker de congelado convertiría en
    // hallazgo permanente cada vez que la empresa se queda corta antes de la
    // compra del mes.
    const r = await withTenant(tenantId, (c) =>
      c.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conname = 'combustible_anomalias_tipo_check'`,
        []
      )
    );
    expect(r.rows[0].def).not.toContain("urea_stock_bajo");
    expect(r.rows[0].def).toContain("urea_stock_excedido");
  });

  // ── 3. Stock excedido: un HALLAZGO, y mira el PROYECTADO ──────────────

  it("comprar de a poco hasta llenar el depósito igual alerta: el techo mira el total", async () => {
    // Stock 80. Techo en 500. Tres compras de 160 L: ninguna sola pasa el
    // techo, la suma sí. Es el vector que un tope por COMPRA no ve y por el
    // que 0117 modeló el máximo como techo de almacén.
    expect(
      (await guardarConfig({ stock_minimo_urea_l: 100, stock_maximo_urea_l: 500 })).status
    ).toBe(200);

    expect((await entrada(8)).status).toBe(201); // 80 + 160 = 240
    expect((await alertas("urea_stock_excedido")).rowCount).toBe(0);

    expect((await entrada(8)).status).toBe(201); // 240 + 160 = 400
    expect((await alertas("urea_stock_excedido")).rowCount).toBe(0);

    const tercera = await entrada(8); // 400 + 160 = 560 > 500
    // NO bloquea: la entrada se registra igual, a propósito. Una compra sin
    // registrar es peor que una compra de más registrada.
    expect(tercera.status).toBe(201);
    expect(await stockActual()).toBe(560);

    const alerta = await alertas("urea_stock_excedido");
    expect(alerta.rowCount).toBe(1);
    expect(Number(alerta.rows[0].detalle.stockProyectadoL)).toBe(560);
    expect(Number(alerta.rows[0].detalle.stockMaximoL)).toBe(500);
    expect(Number(alerta.rows[0].detalle.excesoL)).toBe(60);
    // El correo necesita poder decir si el exceso vino de ESTA compra o de
    // que la anterior no se consumió.
    expect(Number(alerta.rows[0].detalle.litrosQueEntraron)).toBe(160);
    expect(Number(alerta.rows[0].detalle.stockPrevioL)).toBe(400);
  });

  it("el stock excedido NO se auto-resuelve: sigue siendo cierto aunque el stock baje", async () => {
    expect((await vale(20)).status).toBe(201); // 560 - 400 = 160
    const alerta = await alertas("urea_stock_excedido");
    expect(alerta.rowCount).toBe(1);
    expect(alerta.rows[0].resuelta_en).toBeNull();
  });

  // ── 4 y 5. La configuración ───────────────────────────────────────────

  it("mínimo por encima del máximo se rechaza con 400 -- es un dato imposible", async () => {
    const res = await guardarConfig({ stock_minimo_urea_l: 900, stock_maximo_urea_l: 500 });
    expect(res.status).toBe(400);

    // Y no cambió nada.
    const config = await agente.get("/api/erp/combustible/config");
    expect(Number(config.body.stock_minimo_urea_l)).toBe(100);
    expect(Number(config.body.stock_maximo_urea_l)).toBe(500);
  });

  it("BAJAR el mínimo afloja y pide motivo", async () => {
    // Es la dirección contraria a todos los topes del módulo, y por eso tiene
    // su propio bloque en evaluarAflojamientoConfig: bajar el mínimo de 100 a
    // 10 L no restringe nada, atrasa el aviso hasta que ya no haya con qué
    // trabajar.
    const sinMotivo = await guardarConfig({ stock_minimo_urea_l: 10 });
    expect(sinMotivo.status).toBe(400);
    expect(sinMotivo.body.requiere_motivo).toBe(true);
    expect(JSON.stringify(sinMotivo.body.aflojados)).toContain("Stock mínimo de urea");

    const conMotivo = await guardarConfig({
      stock_minimo_urea_l: 10,
      motivo_ajuste: "el depósito se mudó y ahora se compra semanal",
    });
    expect(conMotivo.status).toBe(200);
  });

  it("SUBIR el máximo afloja y pide motivo -- la dirección opuesta", async () => {
    const sinMotivo = await guardarConfig({ stock_maximo_urea_l: 5000 });
    expect(sinMotivo.status).toBe(400);
    expect(sinMotivo.body.requiere_motivo).toBe(true);
    expect(JSON.stringify(sinMotivo.body.aflojados)).toContain("Stock máximo de urea");
  });

  it("apagar cualquiera de los dos también afloja", async () => {
    const res = await guardarConfig({ stock_minimo_urea_l: null, stock_maximo_urea_l: null });
    expect(res.status).toBe(400);
    expect(res.body.requiere_motivo).toBe(true);
    const texto = JSON.stringify(res.body.aflojados);
    expect(texto).toContain("Stock mínimo de urea");
    expect(texto).toContain("Stock máximo de urea");
  });

  it("SUBIR el mínimo endurece: se guarda sin motivo", async () => {
    const res = await guardarConfig({ stock_minimo_urea_l: 150 });
    expect(res.status).toBe(200);
    expect(Number(res.body.stock_minimo_urea_l)).toBe(150);
  });

  // ── El estado que lee el panel ────────────────────────────────────────

  it("el estado trae el stock, los dos límites y la traducción a bultos", async () => {
    const res = await agente.get("/api/erp/combustible/urea/estado");
    expect(res.status).toBe(200);
    expect(res.body.stock.stockL).toBe(160);
    expect(Number(res.body.stock.stockMinimoL)).toBe(150);
    expect(Number(res.body.stock.stockMaximoL)).toBe(500);
    // La caja es la de referencia por default (16 L): 160 / 16 = 10.
    expect(res.body.stock.referencia.nombre).toBe("Caja");
    expect(res.body.stock.referencia.bultos).toBe(10);
  });

  it("el stock NEGATIVO se muestra con signo, no se tapa en 0", async () => {
    // Los vales declaran más urea de la que las entradas explican. Mostrarlo
    // en 0 taparía justo el síntoma que el módulo existe para encontrar
    // (lección de la 2ª simulación de robo: SUMA CON SIGNO).
    expect((await vale(20)).status).toBe(201); // 160 - 400 = -240
    const res = await agente.get("/api/erp/combustible/urea/estado");
    expect(res.body.stock.stockL).toBe(-240);
    expect(res.body.stock.referencia.bultos).toBe(-15);
  });

  // ── 6. El asistente ───────────────────────────────────────────────────

  it("el asistente nace diciendo muestra insuficiente, con cuánto falta", async () => {
    const res = await agente.get("/api/erp/combustible/urea/sugerencia-umbrales");
    expect(res.status).toBe(200);
    expect(res.body.diasHistorial).toBe(90);

    // Todos los vales de este test se cargaron HOY: hay un solo día con
    // consumo, muy por debajo del mínimo de muestra de 10 días.
    expect(res.body.stock.muestraSuficiente).toBe(false);
    expect(res.body.stock.diasConConsumo).toBe(1);
    expect(res.body.stock.minimoRequerido).toBe(10);
    expect(res.body.stock.nota).toContain("10 días");

    // El tope diario: el equipo tiene vales, pero de un solo día.
    expect(res.body.topeDiario.muestraSuficiente).toBe(false);

    // El ratio: este equipo nunca cargó diésel, así que no hay proporción.
    expect(res.body.ratio.muestraSuficiente).toBe(false);
    expect(res.body.ratio.equiposConLosDosProductos).toBe(0);

    // La advertencia va SIEMPRE, con muestra o sin ella.
    expect(res.body.advertencia).toContain("historial");
  });

  it("el asistente NO escribe la config -- solo sugiere", async () => {
    const antes = await agente.get("/api/erp/combustible/config");
    await agente.get("/api/erp/combustible/urea/sugerencia-umbrales");
    const despues = await agente.get("/api/erp/combustible/config");
    expect(despues.body.stock_minimo_urea_l).toEqual(antes.body.stock_minimo_urea_l);
    expect(despues.body.stock_maximo_urea_l).toEqual(antes.body.stock_maximo_urea_l);
    expect(despues.body.actualizado_en).toEqual(antes.body.actualizado_en);
  });

  // ── Los correos ───────────────────────────────────────────────────────

  it("con el admin marcado como destinatario, las dos alertas de stock SÍ mandan correo", async () => {
    // Un tenant nuevo arranca SIN destinatarios, ni el admin (0107). Mientras
    // nadie esté marcado, `admins` viene vacío y el bloque de correos no
    // corre -- que es exactamente por lo que este test existe aparte: sin
    // marcarlo, los otros 17 pasan sin ejercitar una sola línea de correo.
    //
    // Se marca a un jefe de planta y no al admin de la sesión porque la API
    // rechaza con 400 que alguien edite sus PROPIOS permisos -- un guard real
    // y correcto, que se descubrió escribiendo este test.
    const altaJefe = await agente.post("/api/erp/usuarios").send({
      nombre: "Jefe de planta",
      email: `jefe-urea-${idUnico("x")}@test.local`,
      password,
      rol: "operador",
    });
    expect(altaJefe.status).toBe(201);

    const permisos = await agente.get(`/api/erp/usuarios/${altaJefe.body.id}/permisos`);
    expect(permisos.status).toBe(200);
    const marcar = await agente.put(`/api/erp/usuarios/${altaJefe.body.id}/permisos`).send({
      modulos: permisos.body.modulos.map(
        (m: { modulo: string; asignado: boolean; nivel: string }) => ({
          modulo: m.modulo,
          asignado: m.asignado,
          nivel: m.nivel,
        })
      ),
      alertasCorreo: permisos.body.alertasCorreo.map((a: { modulo: string }) => ({
        modulo: a.modulo,
        recibeAlertas: a.modulo === "combustible",
      })),
      motivo: "prueba automatizada: ejercitar el correo de urea",
    });
    expect(marcar.status).toBe(200);

    // Stock actual: -240 L, mínimo 150, máximo 500. Una entrada grande lo
    // pasa del techo, y antes de eso cruza el mínimo hacia arriba.
    correosEnviados.length = 0;
    expect((await entrada(45)).status).toBe(201); // -240 + 900 = 660 > 500

    const excedido = correosEnviados.find((c) => c.asunto.includes("por encima del máximo"));
    expect(excedido).toBeTruthy();
    // Que el correo nombre el stock previo y lo que entró POR SEPARADO es el
    // punto: hay que poder ver si el exceso vino de esta compra sola o de que
    // la anterior no se consumió.
    expect(excedido!.lineas.join(" ")).toContain("900");
    expect(excedido!.lineas.join(" ")).toContain("660");
    expect(excedido!.lineas.join(" ")).toContain("500");

    // Y ahora el stock bajo: un vale que cruza los 150 L hacia abajo.
    correosEnviados.length = 0;
    expect((await vale(30)).status).toBe(201); // 660 - 600 = 60 < 150

    const bajo = correosEnviados.find((c) => c.asunto.includes("queda poca"));
    expect(bajo).toBeTruthy();
    expect(bajo!.lineas.join(" ")).toContain("60 L");
    // La traducción a la unidad de la empresa: 60 / 16 = 3.8 cajas. Nadie en
    // almacén cuenta litros, cuenta cajas.
    expect(bajo!.lineas.join(" ")).toContain("cajas");
  });

  it("el asistente es solo de admin: un operador recibe 403", async () => {
    const email = `op-stock-urea-${idUnico("x")}@test.local`;
    const alta = await agente
      .post("/api/erp/usuarios")
      .send({ nombre: "Operador", email, password, rol: "operador" });
    expect(alta.status).toBe(201);

    const creado = await agente.get("/api/erp/combustible/config");
    expect(creado.status).toBe(200);

    const operador = request.agent(app);
    const tenantSlug = (
      await withTenant(tenantId, (c) =>
        c.query<{ slug: string }>(`SELECT slug FROM tenants WHERE id = $1`, [tenantId])
      )
    ).rows[0].slug;
    const sesion = await operador.post("/api/auth/login").send({ tenantSlug, email, password });
    expect(sesion.status).toBe(200);

    const res = await operador.get("/api/erp/combustible/urea/sugerencia-umbrales");
    expect(res.status).toBe(403);
  });
});
