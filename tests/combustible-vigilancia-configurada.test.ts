/** tests/combustible-vigilancia-configurada.test.ts
 *
 * Que un tanque no pueda quedar ciego por descuido.
 *
 * El problema: los tres umbrales (`umbral_descuadre_pct`,
 * `umbral_descuadre_ciclo_pct`, `umbral_diferencia_pct`) nacen en NULL, y un
 * tanque sin ellos no detecta absolutamente nada -- pero en pantalla se ve
 * idéntico a uno bien configurado. Un tenant puede usar el módulo meses
 * creyendo que está protegido.
 *
 * El principio: convertir la omisión en una DECISIÓN. El caso "no vigilar"
 * sigue siendo válido; lo que deja de ser posible es llegar ahí sin haberlo
 * elegido.
 *
 * La etiqueta de la lista ("Sin vigilancia" / "Vigilancia parcial") se deriva
 * en el cliente de estos mismos tres campos, así que lo que se fija acá es el
 * contrato del que depende: que la API los devuelva tal como se guardaron,
 * distinguiendo NULL (sin configurar) de 0 (tolerancia cero, que SÍ vigila).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";

describe("combustible: la vigilancia del tanque es una decisión, no un descuido", () => {
  let tenantId: string;
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  function payload(extra: Record<string, unknown> = {}) {
    return {
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque de vigilancia",
      tipo_combustible: "diesel_b5",
      unidad: "L",
      tipo_punto: "fijo",
      capacidad_total: 20000,
      nivel_actual: 0,
      ...extra,
    };
  }

  const auditoriaDe = (accion: string) =>
    withTenant(tenantId, (c) =>
      c.query(
        `SELECT detalle FROM platform_audit_log
         WHERE tenant_id = $1 AND accion = $2 ORDER BY id DESC LIMIT 1`,
        [tenantId, accion]
      )
    );

  // ── Los tres estados que la lista tiene que poder distinguir ──────────

  it("sin vigilancia: los tres umbrales vuelven en NULL, no en 0", async () => {
    // La distinción es todo el punto. Si la API devolviera 0, la etiqueta
    // diría "vigilado" sobre un tanque que no mira nada.
    const res = await agente
      .post("/api/erp/combustible")
      .send(payload({ modo_vigilancia: "sin_vigilar" }));
    expect(res.status).toBe(201);
    expect(res.body.umbral_descuadre_pct).toBeNull();
    expect(res.body.umbral_descuadre_ciclo_pct).toBeNull();
    expect(res.body.umbral_diferencia_pct).toBeNull();
  });

  it("vigilancia parcial: los configurados vuelven con valor y los otros en NULL", async () => {
    const res = await agente.post("/api/erp/combustible").send(
      payload({
        modo_vigilancia: "personalizado",
        umbral_descuadre_pct: 1,
      })
    );
    expect(res.status).toBe(201);
    expect(Number(res.body.umbral_descuadre_pct)).toBe(1);
    expect(res.body.umbral_descuadre_ciclo_pct).toBeNull();
    expect(res.body.umbral_diferencia_pct).toBeNull();
  });

  it("vigilancia completa: los tres con valor", async () => {
    const res = await agente.post("/api/erp/combustible").send(
      payload({
        modo_vigilancia: "recomendado",
        umbral_descuadre_pct: 2,
        umbral_descuadre_ciclo_pct: 3,
        umbral_diferencia_pct: 2,
      })
    );
    expect(res.status).toBe(201);
    expect(Number(res.body.umbral_descuadre_pct)).toBe(2);
    expect(Number(res.body.umbral_descuadre_ciclo_pct)).toBe(3);
    expect(Number(res.body.umbral_diferencia_pct)).toBe(2);
  });

  it("el 0 NO es 'sin vigilancia': es tolerancia cero y vigila más que nadie", async () => {
    // Un `!umbral` en el cliente marcaría este tanque como desprotegido
    // siendo el más estricto de todos. La API tiene que dejarlo distinguible.
    const res = await agente.post("/api/erp/combustible").send(
      payload({
        modo_vigilancia: "personalizado",
        umbral_descuadre_pct: 0,
        umbral_descuadre_ciclo_pct: 0,
        umbral_diferencia_pct: 0,
      })
    );
    expect(res.status).toBe(201);
    expect(res.body.umbral_descuadre_pct).not.toBeNull();
    expect(Number(res.body.umbral_descuadre_pct)).toBe(0);
  });

  // ── La decisión queda registrada ──────────────────────────────────────

  it("la auditoría del alta guarda QUÉ se eligió y con qué números quedó", async () => {
    await agente.post("/api/erp/combustible").send(payload({ modo_vigilancia: "sin_vigilar" }));

    const log = await auditoriaDe("combustible.tanque_crear");
    const detalle = log.rows[0].detalle;
    // Sin esto, un tanque que nace ciego es indistinguible en el log de uno
    // bien configurado, y "nadie lo vigilaba" no se puede responder después.
    expect(detalle.modoVigilancia).toBe("sin_vigilar");
    // El umbral de la ventana deslizante (0080) entró tarde a este detalle:
    // el alta lo guardaba sin él, así que un tanque que nacía ciego de ESE
    // control se veía igual que uno configurado.
    expect(detalle.umbrales).toEqual({
      descuadre: null,
      ciclo: null,
      diferencia: null,
      ventana: null,
    });
  });

  it("elegir 'recomendado' queda en la auditoría con los valores aplicados", async () => {
    await agente.post("/api/erp/combustible").send(
      payload({
        modo_vigilancia: "recomendado",
        umbral_descuadre_pct: 2,
        umbral_descuadre_ciclo_pct: 3,
        umbral_diferencia_pct: 2,
      })
    );

    const log = await auditoriaDe("combustible.tanque_crear");
    expect(log.rows[0].detalle.modoVigilancia).toBe("recomendado");
    expect(log.rows[0].detalle.umbrales.ciclo).toBe(3);
  });

  it("la API sigue aceptando un alta SIN modo_vigilancia", async () => {
    // El formulario lo exige, la API no: romper por un dato que solo sirve
    // para el registro dejaría afuera a la cola offline y a cualquier script.
    // Queda como `null` en la auditoría, que es la verdad -- nadie eligió.
    const res = await agente.post("/api/erp/combustible").send(payload());
    expect(res.status).toBe(201);

    const log = await auditoriaDe("combustible.tanque_crear");
    expect(log.rows[0].detalle.modoVigilancia).toBeNull();
  });

  it("rechaza un modo_vigilancia inventado", async () => {
    const res = await agente
      .post("/api/erp/combustible")
      .send(payload({ modo_vigilancia: "mas_o_menos" }));
    expect(res.status).toBe(400);
  });

  // ── La carga masiva no puede ser la puerta de atrás ───────────────────

  it("la importación reporta cuántos tanques entraron sin vigilancia", async () => {
    // El formulario obliga a elegir; una planilla sin esas columnas entra
    // igual y los deja en NULL. No se bloquea -- pedir tres porcentajes por
    // fila en un Excel garantiza que se llenen con cualquier cosa -- pero
    // tiene que decirse, o la decisión se saltea sin que nadie se entere.
    const res = await agente
      .post("/api/erp/combustible/bulk")
      .send([payload(), payload(), payload({ umbral_descuadre_pct: 2 })]);

    expect(res.status).toBe(201);
    expect(res.body.insertados).toBe(3);
    expect(res.body.sinVigilancia).toBe(2);
  });

  it("una planilla CON umbrales no reporta nada: la decisión ya está tomada", async () => {
    const res = await agente.post("/api/erp/combustible/bulk").send([
      payload({
        umbral_descuadre_pct: 2,
        umbral_descuadre_ciclo_pct: 3,
        umbral_diferencia_pct: 2,
      }),
    ]);
    expect(res.status).toBe(201);
    expect(res.body.sinVigilancia).toBe(0);
  });

  it("la auditoría de la carga masiva también guarda el conteo sin vigilancia", async () => {
    await agente.post("/api/erp/combustible/bulk").send([payload(), payload()]);

    const log = await auditoriaDe("combustible.tanques_carga_masiva");
    expect(log.rows[0].detalle.cantidad).toBe(2);
    expect(log.rows[0].detalle.sinVigilancia).toBe(2);
  });
});
