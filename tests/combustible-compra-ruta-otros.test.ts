/** tests/combustible-compra-ruta-otros.test.ts
 *
 * El proveedor "Otros" de la compra en ruta (migración 0163). Kenif,
 * 2026-10-21: hay grifos donde se compra una o dos veces y no vale darlos de
 * alta; el conductor escribe el nombre y el historial lo muestra.
 *
 * Cómo está hecho: cada nombre distinto es un proveedor INTERNO oculto
 * ("Otros: Grifo El Sol", `es_otros`). Lo que estos tests defienden:
 *
 *   1. La compra con nombre escrito se guarda como cualquier otra y el
 *      historial muestra el nombre.
 *   2. El mismo nombre se reutiliza (sin distinguir mayúsculas ni espacios
 *      repetidos); dos nombres distintos con la MISMA boleta no chocan --
 *      el motivo de haber elegido un proveedor por nombre y no uno solo.
 *   3. El reintento con el mismo cliente_uuid no duplica, y dos compras que
 *      estrenan el mismo nombre a la vez crean UN proveedor, no dos.
 *   4. Un nombre corto, vacío, o mandar proveedor Y nombre, es un 400.
 *   5. Ninguna lista de proveedores (catálogo, formulario, urea) los muestra.
 *   6. El conductor, que no puede dar de alta proveedores, sí puede comprar en
 *      "Otros": el servicio los crea por él.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";

describe("combustible: compra en ruta con proveedor Otros (migración 0163)", () => {
  let tenantId: string;
  let slug: string;
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);
  let equipoId: number;
  let grifoReal: number;
  let nombreGrifoReal: string;
  let horometro = 1000;

  const numero = () => `B001-${Math.floor(Math.random() * 1e8)}`;

  /** Combustible (40 gal × S/ 17.50) y urea (2 cajas × S/ 50), con el nombre
   *  del grifo escrito a mano en vez de un proveedor del catálogo. */
  const cuerpoOtros = (proveedorOtro: string, overrides: Record<string, unknown> = {}) => ({
    cliente_uuid: crypto.randomUUID(),
    proveedor_otro: proveedorOtro,
    comprobante_tipo: "boleta",
    comprobante_numero: numero(),
    equipo_id: equipoId,
    despachado_en: new Date().toISOString(),
    combustible: {
      tipo_combustible: "diesel_b5",
      cantidad: 40,
      costo_unitario: 17.5,
      lectura_horometro: (horometro += 10),
      horas_abastecidas: 12,
    },
    urea: { lineas: [{ presentacion: "caja", cantidad_bultos: 2, costo_unitario: 50 }] },
    ...overrides,
  });

  const crear = (body: Record<string, unknown>, quien = agente) =>
    quien.post("/api/erp/combustible/compras-ruta").send(body);

  /** Los proveedores ocultos de la empresa, tal como están en la base. */
  const proveedoresOtros = async (): Promise<{ id: number; nombre: string }[]> =>
    (
      await withTenant(tenantId, (cl) =>
        cl.query<{ id: number; nombre: string }>(
          `SELECT id, nombre FROM combustible_grifos
            WHERE tenant_id = $1 AND es_otros ORDER BY id`,
          [tenantId]
        )
      )
    ).rows;

  const contarDespachos = async (comprobante: string): Promise<number> =>
    (
      await withTenant(tenantId, (cl) =>
        cl.query(
          `SELECT 1 FROM combustible_despachos WHERE tenant_id = $1 AND comprobante_numero = $2`,
          [tenantId, comprobante]
        )
      )
    ).rowCount ?? 0;

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    slug = c.tenant.slug;
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug: slug, email: c.usuario.email, password });
    equipoId = (
      await agente
        .post("/api/erp/equipos")
        .send({ placa_codigo: idUnico("VQ"), tipo: "VOLQUETE", tipo_medidor: "horometro" })
    ).body.id;
    nombreGrifoReal = idUnico("PRIMAX");
    grifoReal = (
      await agente.post("/api/erp/combustible/grifos").send({
        nombre: nombreGrifoReal,
        abastece_ruta: true,
        abastece_tanque: false,
        abastece_urea: true,
        abastece_urea_ruta: true,
      })
    ).body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  // ── 1. La compra y el historial ───────────────────────────────────────

  it("una compra con el nombre del grifo escrito se guarda y el historial lo muestra", async () => {
    const body = cuerpoOtros("Grifo El Sol Norte");
    const r = await crear(body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);

    // Los dos productos, con su boleta, igual que con un proveedor del catálogo.
    expect(r.body.despacho_combustible.comprobante_numero).toBe(body.comprobante_numero);
    expect(r.body.despacho_urea.comprobante_numero).toBe(body.comprobante_numero);
    // Los dos despachos y la cabecera cuelgan del mismo proveedor oculto.
    const grifoId = Number(r.body.compra.grifo_id);
    expect(Number(r.body.despacho_combustible.grifo_id)).toBe(grifoId);
    expect(Number(r.body.despacho_urea.grifo_id)).toBe(grifoId);
    expect((await proveedoresOtros()).map((p) => p.nombre)).toContain("Otros: Grifo El Sol Norte");

    const historial = await agente.get("/api/erp/combustible/compras-ruta");
    expect(historial.status).toBe(200);
    const fila = (historial.body as { comprobante_numero: string; proveedor: string }[]).find(
      (b) => b.comprobante_numero === body.comprobante_numero
    );
    expect(fila?.proveedor).toBe("Otros: Grifo El Sol Norte");
  });

  it("solo urea con el nombre escrito también se guarda (el proveedor oculto vende urea en ruta)", async () => {
    const r = await crear(
      cuerpoOtros("Urea Express Sur", { combustible: undefined, total_boleta: 100 })
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.despacho_combustible).toBeNull();
  });

  // ── 2. Un proveedor por nombre ────────────────────────────────────────

  it("el mismo nombre se reutiliza, sin distinguir mayúsculas ni espacios repetidos", async () => {
    const antes = (await proveedoresOtros()).length;
    const a = await crear(cuerpoOtros("Grifo La Esquina"));
    const b = await crear(cuerpoOtros("  grifo   la   ESQUINA "));
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    expect(Number(b.body.compra.grifo_id)).toBe(Number(a.body.compra.grifo_id));
    // Un solo proveedor nuevo, no dos.
    expect((await proveedoresOtros()).length).toBe(antes + 1);
  });

  it("dos grifos distintos con el MISMO número de boleta no chocan", async () => {
    const mismoNumero = numero();
    const a = await crear(
      cuerpoOtros("Grifo Uno Mismo Numero", { comprobante_numero: mismoNumero })
    );
    const b = await crear(
      cuerpoOtros("Grifo Dos Mismo Numero", { comprobante_numero: mismoNumero })
    );
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    expect(Number(a.body.compra.grifo_id)).not.toBe(Number(b.body.compra.grifo_id));
    // El mismo grifo con el mismo número sí es una boleta repetida.
    const repetida = await crear(
      cuerpoOtros("Grifo Uno Mismo Numero", { comprobante_numero: mismoNumero })
    );
    expect(repetida.status).toBeGreaterThanOrEqual(400);
    expect(repetida.status).toBeLessThan(500);
  });

  // ── 3. Reintento y carrera ────────────────────────────────────────────

  it("el reintento con el mismo cliente_uuid devuelve 200 y no duplica nada", async () => {
    const body = cuerpoOtros("Grifo Reintento");
    const primera = await crear(body);
    expect(primera.status, JSON.stringify(primera.body)).toBe(201);
    const segunda = await crear(body);
    expect(segunda.status).toBe(200);
    expect(await contarDespachos(body.comprobante_numero)).toBe(2);
  });

  it("cuatro compras que estrenan el mismo nombre a la vez crean UN solo proveedor", async () => {
    const nombre = `Grifo Carrera ${idUnico("N")}`;
    const respuestas = await Promise.all(
      [1, 2, 3, 4].map(() =>
        crear(cuerpoOtros(nombre, { combustible: undefined, total_boleta: 100 }))
      )
    );
    for (const r of respuestas) expect(r.status, JSON.stringify(r.body)).toBe(201);
    const ids = new Set(respuestas.map((r) => Number(r.body.compra.grifo_id)));
    expect(ids.size).toBe(1);
    const creados = (await proveedoresOtros()).filter((p) => p.nombre === `Otros: ${nombre}`);
    expect(creados).toHaveLength(1);
  });

  // ── 4. Validación ─────────────────────────────────────────────────────

  it("un nombre de menos de 3 letras, vacío o solo espacios es un 400", async () => {
    for (const nombre of ["ab", "", "    "]) {
      const r = await crear(cuerpoOtros(nombre));
      expect(r.status, `nombre "${nombre}"`).toBe(400);
    }
  });

  it("un nombre de más de 80 letras es un 400", async () => {
    const r = await crear(cuerpoOtros("x".repeat(81)));
    expect(r.status).toBe(400);
  });

  it("mandar proveedor del catálogo Y nombre escrito, o ninguno de los dos, es un 400", async () => {
    const los2 = await crear(cuerpoOtros("Grifo Doble", { grifo_id: grifoReal }));
    expect(los2.status).toBe(400);
    const ninguno = await crear(cuerpoOtros("Grifo Ninguno", { proveedor_otro: undefined }));
    expect(ninguno.status).toBe(400);
  });

  // ── 5. Ninguna lista los muestra ──────────────────────────────────────

  it("los proveedores ocultos no salen en el catálogo, el formulario ni las listas de urea", async () => {
    await crear(cuerpoOtros("Grifo Oculto De Prueba"));
    const rutas = [
      "/api/erp/combustible/grifos",
      "/api/erp/combustible/grifos/para-formulario",
      "/api/erp/combustible/urea/proveedores",
      "/api/erp/combustible/urea/proveedores?uso=externo",
    ];
    for (const ruta of rutas) {
      const r = await agente.get(ruta);
      expect(r.status, ruta).toBe(200);
      expect(JSON.stringify(r.body), ruta).not.toContain("Otros:");
    }
    // Y la lista sí funciona: trae el proveedor real que sembramos.
    const catalogo = await agente.get("/api/erp/combustible/grifos");
    expect(JSON.stringify(catalogo.body)).toContain(nombreGrifoReal);
  });

  // ── 6. El conductor ───────────────────────────────────────────────────

  it("un conductor de ruta puede comprar en Otros aunque no pueda dar de alta proveedores", async () => {
    const dni = String(87300000 + Math.floor(Math.random() * 600000));
    const alta = await agente
      .post("/api/erp/usuarios")
      .send({ nombre: "Conductor Otros", dni, password, rol: "conductor_ruta" });
    expect(alta.status, JSON.stringify(alta.body)).toBe(201);
    const conductor = request.agent(app);
    expect(
      (
        await conductor
          .post("/api/auth/login")
          .send({ tenantSlug: slug, identificador: dni, password })
      ).status
    ).toBe(200);

    // No puede dar de alta un proveedor...
    const altaProveedor = await conductor
      .post("/api/erp/combustible/grifos")
      .send({ nombre: idUnico("MIO") });
    expect(altaProveedor.status).toBeGreaterThanOrEqual(400);
    // ...pero sí comprar en uno que escribe a mano.
    const compra = await crear(
      cuerpoOtros("Grifo Del Conductor", { combustible: undefined, total_boleta: 100 }),
      conductor
    );
    expect(compra.status, JSON.stringify(compra.body)).toBe(201);
    expect((await proveedoresOtros()).map((p) => p.nombre)).toContain("Otros: Grifo Del Conductor");
  });
});
