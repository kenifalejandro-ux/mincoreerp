/** tests/combustible-sugerencia-umbral.test.ts
 *
 * El asistente de calibración. Nació para `umbral_diferencia_pct` (migración
 * 0066) y desde el PR de los tres umbrales sugiere también los dos de
 * descuadre -- la respuesta pasó de ser la sugerencia suelta a
 * `{ diferencia, descuadre, ciclo }`. Nunca guarda nada solo -- devuelve un número sugerido
 * MÁS la muestra completa que lo justifica, para que un admin la revise
 * antes de aceptarlo (ver el comentario largo de
 * CombustibleService.sugerirUmbralDiferencia).
 *
 * La fórmula (promedio de |diferencia_pct| + 2 desvíos, piso 1%) se prueba
 * con una muestra de valores elegidos a mano, no aleatorios, para poder
 * comparar contra el cálculo esperado.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { crearUsuarioService } from "../src/server/services/auth.service";
import { closeDatabase, withTenant } from "../src/server/config/database";

const HORA = 3600 * 1000;

describe("combustible: asistente de calibración de umbral (Fase D, entrega 3)", () => {
  let tenantId: string;
  let tenantSlug: string;
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    tenantSlug = creado.tenant.slug;
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  async function crearTanqueYGrifo() {
    const tanque = await agente.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque calibración",
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_punto: "fijo",
      capacidad_total: 100000,
      nivel_actual: 10000,
      requiere_documento: false,
    });
    const grifo = await agente
      .post("/api/erp/combustible/grifos")
      .send({ nombre: idUnico("CIST") });
    return { tanqueId: tanque.body.id as number, grifoId: grifo.body.id as number };
  }

  /** Arma `n` recepciones encadenadas lectura-recepción-lectura, cada una
   *  con una diferencia (en litros) elegida a mano vía `diferenciasLitros`.
   *
   *  `cantidades` permite que las entregas sean de TAMAÑOS distintos, que es
   *  lo que el modelo de 0101 necesita para poder separar el error fijo del
   *  proporcional: con todas las entregas iguales, la pendiente no se puede
   *  estimar y el sistema lo dice en vez de inventarla.
   *
   *  Devuelve los ids de las recepciones creadas, en orden. */
  async function construirMuestra(
    tanqueId: number,
    grifoId: number,
    diferenciasLitros: number[],
    nivelInicial = 10000,
    inicioMs = Date.now() - diferenciasLitros.length * 3 * HORA,
    cantidades?: number[]
  ) {
    const cantidadDe = (i: number) => cantidades?.[i] ?? 1000;
    let nivel = nivelInicial;
    const recepcionIds: number[] = [];

    await agente.post("/api/erp/combustible/lecturas").send({
      combustible_id: tanqueId,
      nivel,
      leido_en: new Date(inicioMs).toISOString(),
    });

    for (let i = 0; i < diferenciasLitros.length; i++) {
      const tRecepcion = inicioMs + (i * 2 + 1) * HORA;
      const tDespues = inicioMs + (i + 1) * 2 * HORA;

      const recepcion = await agente.post("/api/erp/combustible/recepciones").send({
        combustible_id: tanqueId,
        grifo_id: grifoId,
        cantidad: cantidadDe(i),
        costo_unitario: 16,
        recibido_en: new Date(tRecepcion).toISOString(),
      });
      expect(recepcion.status).toBe(201);
      recepcionIds.push(recepcion.body.id);

      nivel = nivel + cantidadDe(i) + diferenciasLitros[i];
      await agente.post("/api/erp/combustible/lecturas").send({
        combustible_id: tanqueId,
        nivel,
        leido_en: new Date(tDespues).toISOString(),
      });
    }

    return recepcionIds;
  }

  it("con menos de 10 recepciones atribuibles, dice que la muestra es insuficiente", async () => {
    const { tanqueId, grifoId } = await crearTanqueYGrifo();
    await construirMuestra(tanqueId, grifoId, [0, -10, 10]);

    const res = await agente.get(`/api/erp/combustible/${tanqueId}/sugerencia-umbral`);
    expect(res.status).toBe(200);
    expect(res.body.diferencia.muestraSuficiente).toBe(false);
    expect(res.body.diferencia.tamanioMuestra).toBe(3);
    expect(res.body.diferencia.minimoRequerido).toBe(10);
    expect(res.body.diferencia.piso).toBeUndefined();
    expect(res.body.diferencia.pct).toBeUndefined();
  });

  it("estima el PISO y el PORCENTAJE ajustando la recta contra lo entregado", async () => {
    const { tanqueId, grifoId } = await crearTanqueYGrifo();
    // Entregas de tamaños MUY distintos, con un error que crece con el
    // tamaño: 1 % de lo entregado, más 30 gal fijos que no dependen de nada.
    // Es el caso que el modelo viejo no podía representar -- un solo número
    // tenía que servir para la entrega de 500 y para la de 5.000.
    const cantidades = [500, 800, 1200, 1600, 2000, 2600, 3200, 4000, 4600, 5000];
    const diferencias = cantidades.map((c) => -(30 + c * 0.01));
    await construirMuestra(tanqueId, grifoId, diferencias, 10000, undefined, cantidades);

    const res = await agente.get(`/api/erp/combustible/${tanqueId}/sugerencia-umbral`);
    expect(res.status).toBe(200);
    const s = res.body.diferencia;
    expect(s.muestraSuficiente).toBe(true);
    expect(s.tamanioMuestra).toBe(10);

    // La recta recupera los dos números que se usaron para fabricar la
    // muestra: 1 % de pendiente y 30 gal de corte. El piso sugerido queda en
    // el mínimo por dilatación (1 % de 100.000 = 1.000) porque el corte real
    // es chiquito al lado de ese piso -- y eso también es correcto: por
    // debajo de la dilatación el umbral alertaría por el clima.
    expect(s.pct).toBeCloseTo(1, 1);
    expect(s.piso).toBe(1000);
    expect(s.movimientoConDispersion).toBe(true);
    expect(s.muestra).toHaveLength(10);
  });

  it("si todas las entregas son del mismo tamaño, NO inventa una pendiente", async () => {
    // El caso honesto: con entregas iguales, cualquier recta explica los
    // datos igual de bien. El sistema pone todo en el piso (que no crece) y
    // avisa que no pudo separar los dos términos, en vez de servir una
    // pendiente que es ruido con cara de medición.
    const { tanqueId, grifoId } = await crearTanqueYGrifo();
    await construirMuestra(tanqueId, grifoId, [-20, -10, 0, 10, 20, -20, -10, 0, 10, 20]);

    const res = await agente.get(`/api/erp/combustible/${tanqueId}/sugerencia-umbral`);
    expect(res.status).toBe(200);
    expect(res.body.diferencia.movimientoConDispersion).toBe(false);
    expect(res.body.diferencia.pct).toBe(0);
  });

  it("nunca sugiere un piso por debajo de la dilatación térmica", async () => {
    const { tanqueId, grifoId } = await crearTanqueYGrifo();
    // Diez recepciones SIN diferencia: la recta pasa exacto por el cero.
    await construirMuestra(tanqueId, grifoId, new Array(10).fill(0));

    const res = await agente.get(`/api/erp/combustible/${tanqueId}/sugerencia-umbral`);
    expect(res.body.diferencia.muestraSuficiente).toBe(true);
    // 1 % de la capacidad (100.000), en la unidad del tanque. Un tanque no
    // puede tolerar 0: el combustible cambia de volumen con la temperatura.
    expect(res.body.diferencia.piso).toBe(1000);
    expect(res.body.diferencia.pct).toBe(0);
  });

  it("una recepción anulada no cuenta para la muestra", async () => {
    const { tanqueId, grifoId } = await crearTanqueYGrifo();
    const ids = await construirMuestra(tanqueId, grifoId, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

    const antes = await agente.get(`/api/erp/combustible/${tanqueId}/sugerencia-umbral`);
    expect(antes.body.diferencia.tamanioMuestra).toBe(10);

    await agente
      .patch(`/api/erp/combustible/recepciones/${ids[0]}/anular`)
      .send({ motivo: "recepción de prueba, anulada a propósito" });

    const despues = await agente.get(`/api/erp/combustible/${tanqueId}/sugerencia-umbral`);
    expect(despues.body.diferencia.tamanioMuestra).toBe(9);
  });

  it("un tanque inexistente da 404", async () => {
    const res = await agente.get("/api/erp/combustible/999999999/sugerencia-umbral");
    expect(res.status).toBe(404);
  });

  it("un operador no puede pedir la sugerencia (visibilidad de gerencia)", async () => {
    const { tanqueId } = await crearTanqueYGrifo();
    const emailOperador = idUnico("operador-umbral") + "@test.local";
    await withTenant(tenantId, (client) =>
      crearUsuarioService(
        { tenantId, nombre: "Operador", email: emailOperador, password, rol: "operador" },
        client
      )
    );
    const agenteOperador = request.agent(app);
    await agenteOperador
      .post("/api/auth/login")
      .send({ tenantSlug, email: emailOperador, password });

    const res = await agenteOperador.get(`/api/erp/combustible/${tanqueId}/sugerencia-umbral`);
    expect(res.status).toBe(403);
  });

  it("un tenant no puede pedir la sugerencia del tanque de otro (RLS)", async () => {
    const { tanqueId } = await crearTanqueYGrifo();

    const otro = await crearTenantDePrueba(password);
    const agenteOtro = request.agent(app);
    await agenteOtro
      .post("/api/auth/login")
      .send({ tenantSlug: otro.tenant.slug, email: otro.usuario.email, password });

    try {
      const res = await agenteOtro.get(`/api/erp/combustible/${tanqueId}/sugerencia-umbral`);
      expect(res.status).toBe(404);
    } finally {
      await borrarTenantDePrueba(otro.tenant.id);
    }
  });
});
