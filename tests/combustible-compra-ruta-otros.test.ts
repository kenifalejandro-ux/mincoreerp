/** tests/combustible-compra-ruta-otros.test.ts
 *
 * El grifo "Otros" de la compra en ruta (migraciones 0163 y 0164). Kenif,
 * 2026-10-21 y 2026-10-31: hay grifos donde se compra una o dos veces y no vale
 * darlos de alta, y tampoco deben crear un proveedor por conductor y por nombre.
 *
 * Cómo está hecho: UN proveedor interno oculto por empresa ("Otros (grifo no
 * frecuente)", `es_otros`); el nombre que escribe el conductor vive en el
 * despacho (`proveedor_otro`) y es lo que muestran el historial y los exportes.
 * Lo que estos tests defienden:
 *
 *   1. La compra con nombre escrito se guarda como cualquier otra y el
 *      historial muestra "Otros: <nombre>", marcada como no registrada.
 *   2. NINGÚN nombre crea un proveedor: siempre hay uno solo por empresa.
 *   3. Dos grifos distintos con la MISMA boleta no chocan (el índice único de
 *      comprobante distingue el nombre); el mismo grifo con la misma boleta sí,
 *      sin importar mayúsculas ni la forma Unicode del nombre.
 *   4. El reintento con el mismo cliente_uuid no duplica, y dos compras que
 *      estrenan "Otros" a la vez crean UN solo proveedor.
 *   5. Un nombre sin contenido (corto, invisible, solo signos) o mandar proveedor
 *      Y nombre es un 400, y el nombre no se acepta con un proveedor del catálogo.
 *   6. Ninguna lista de proveedores lo muestra.
 *   7. El conductor, que no puede dar de alta proveedores, sí puede comprar.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";

const NOMBRE_OCULTO = "Otros (grifo no frecuente)";

describe("combustible: compra en ruta con grifo Otros (migraciones 0163-0164)", () => {
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
  const soloUrea = { combustible: undefined, total_boleta: 100 };

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

  it("una compra con el nombre del grifo escrito se guarda y el historial lo muestra como no registrado", async () => {
    const body = cuerpoOtros("Grifo El Sol Norte");
    const r = await crear(body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);

    // Los dos productos, con su boleta y el nombre, igual que con un proveedor del catálogo.
    expect(r.body.despacho_combustible.comprobante_numero).toBe(body.comprobante_numero);
    expect(r.body.despacho_urea.proveedor_otro).toBe("Grifo El Sol Norte");
    expect(r.body.despacho_combustible.proveedor_otro).toBe("Grifo El Sol Norte");
    const grifoId = Number(r.body.compra.grifo_id);
    expect(Number(r.body.despacho_combustible.grifo_id)).toBe(grifoId);
    expect(Number(r.body.despacho_urea.grifo_id)).toBe(grifoId);

    const historial = await agente.get("/api/erp/combustible/compras-ruta");
    expect(historial.status).toBe(200);
    const fila = (
      historial.body as {
        comprobante_numero: string;
        proveedor: string;
        proveedor_no_registrado: boolean;
      }[]
    ).find((b) => b.comprobante_numero === body.comprobante_numero);
    expect(fila?.proveedor).toBe("Otros: Grifo El Sol Norte");
    expect(fila?.proveedor_no_registrado).toBe(true);
  });

  it("una compra con un proveedor del catálogo sigue saliendo como registrada", async () => {
    const body = cuerpoOtros("x", { proveedor_otro: undefined, grifo_id: grifoReal });
    const r = await crear(body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const historial = await agente.get("/api/erp/combustible/compras-ruta");
    const fila = (
      historial.body as {
        comprobante_numero: string;
        proveedor: string;
        proveedor_no_registrado: boolean;
      }[]
    ).find((b) => b.comprobante_numero === body.comprobante_numero);
    expect(fila?.proveedor).toBe(nombreGrifoReal);
    expect(fila?.proveedor_no_registrado).toBe(false);
  });

  it("el historial de compras de urea también muestra el nombre", async () => {
    const body = cuerpoOtros("Urea Express Sur", soloUrea);
    expect((await crear(body)).status).toBe(201);
    const r = await agente.get("/api/erp/combustible/urea/compras");
    expect(r.status).toBe(200);
    const fila = (
      r.body as {
        comprobante_numero: string;
        proveedor: string;
        proveedor_no_registrado: boolean;
      }[]
    ).find((b) => b.comprobante_numero === body.comprobante_numero);
    expect(fila?.proveedor).toBe("Otros: Urea Express Sur");
    expect(fila?.proveedor_no_registrado).toBe(true);
  });

  // ── 2. Ningún nombre crea un proveedor ────────────────────────────────

  it("doce nombres distintos NO crean proveedores: queda uno solo por empresa", async () => {
    for (let i = 0; i < 12; i++) {
      const r = await crear(cuerpoOtros(`Grifo suelto ${i} ${idUnico("s")}`, soloUrea));
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
    const ocultos = await proveedoresOtros();
    expect(ocultos.map((p) => p.nombre)).toEqual([NOMBRE_OCULTO]);
  });

  // ── 3. La misma boleta ────────────────────────────────────────────────

  it("dos grifos distintos con el MISMO número de boleta no chocan", async () => {
    const mismoNumero = numero();
    const a = await crear(
      cuerpoOtros("Grifo Uno Mismo Numero", { ...soloUrea, comprobante_numero: mismoNumero })
    );
    const b = await crear(
      cuerpoOtros("Grifo Dos Mismo Numero", { ...soloUrea, comprobante_numero: mismoNumero })
    );
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    // Cada uno es su propia boleta en el historial.
    const historial = await agente.get("/api/erp/combustible/compras-ruta");
    const filas = (historial.body as { comprobante_numero: string; proveedor: string }[]).filter(
      (f) => f.comprobante_numero === mismoNumero
    );
    expect(filas.map((f) => f.proveedor).sort()).toEqual([
      "Otros: Grifo Dos Mismo Numero",
      "Otros: Grifo Uno Mismo Numero",
    ]);
  });

  it("el mismo grifo con el mismo número es una boleta repetida, sin importar mayúsculas ni forma Unicode", async () => {
    const mismoNumero = numero();
    const nombre = "Grifo Sólo Repetido";
    const primera = await crear(
      cuerpoOtros(nombre, { ...soloUrea, comprobante_numero: mismoNumero })
    );
    expect(primera.status, JSON.stringify(primera.body)).toBe(201);
    for (const variante of [
      nombre,
      nombre.toUpperCase(),
      `  ${nombre.toLowerCase()}  `,
      nombre.normalize("NFD"),
    ]) {
      const r = await crear(
        cuerpoOtros(variante, { ...soloUrea, comprobante_numero: mismoNumero })
      );
      expect(r.status, `variante "${variante}"`).toBe(409);
    }
  });

  // ── 4. Reintento y carrera ────────────────────────────────────────────

  it("el reintento con el mismo cliente_uuid devuelve 200 y no duplica nada", async () => {
    const body = cuerpoOtros("Grifo Reintento");
    const primera = await crear(body);
    expect(primera.status, JSON.stringify(primera.body)).toBe(201);
    const segunda = await crear(body);
    expect(segunda.status).toBe(200);
    expect(await contarDespachos(body.comprobante_numero)).toBe(2);
  });

  it("el reintento con el mismo cliente_uuid y OTRO nombre es un 409", async () => {
    const body = cuerpoOtros("Grifo Huella Uno");
    expect((await crear(body)).status).toBe(201);
    const otro = await crear({ ...body, proveedor_otro: "Grifo Huella Dos" });
    expect(otro.status).toBe(409);
  });

  it("cuatro compras que estrenan Otros a la vez crean UN solo proveedor", async () => {
    // Una empresa nueva: sin el proveedor oculto todavía.
    const c = await crearTenantDePrueba(password);
    try {
      const a = request.agent(app);
      await a
        .post("/api/auth/login")
        .send({ tenantSlug: c.tenant.slug, email: c.usuario.email, password });
      const eq = (
        await a
          .post("/api/erp/equipos")
          .send({ placa_codigo: idUnico("VC"), tipo: "VOLQUETE", tipo_medidor: "horometro" })
      ).body.id;
      const respuestas = await Promise.all(
        [1, 2, 3, 4].map((i) =>
          crear(cuerpoOtros(`Grifo Carrera ${i}`, { ...soloUrea, equipo_id: eq }), a)
        )
      );
      for (const r of respuestas) expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(new Set(respuestas.map((r) => Number(r.body.compra.grifo_id))).size).toBe(1);
      const filas = await withTenant(c.tenant.id, (cl) =>
        cl.query(`SELECT 1 FROM combustible_grifos WHERE tenant_id = $1 AND es_otros`, [
          c.tenant.id,
        ])
      );
      expect(filas.rowCount).toBe(1);
    } finally {
      await borrarTenantDePrueba(c.tenant.id);
    }
  });

  // ── 5. Validación ─────────────────────────────────────────────────────

  it("un nombre sin contenido (corto, vacío, invisible o solo signos) es un 400", async () => {
    const malos: Record<string, string> = {
      corto: "ab",
      vacio: "",
      espacios: "    ",
      puntos: "....",
      guiones: "-----",
      simbolos: "€€€€",
      "cero-ancho": "​​​​",
      "marca-rtl": "‮‮‮",
    };
    for (const [clase, nombre] of Object.entries(malos)) {
      const r = await crear(cuerpoOtros(nombre));
      expect(r.status, `nombre ${clase}`).toBe(400);
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

  it("el nombre escrito no se acepta con un proveedor del catálogo en una compra suelta", async () => {
    const r = await agente.post("/api/erp/combustible/despachos").send({
      cliente_uuid: crypto.randomUUID(),
      producto: "urea",
      origen: "compra_externa",
      grifo_id: grifoReal,
      proveedor_otro: "Grifo Colado",
      tipo_destino: "equipo",
      equipo_id: equipoId,
      comprobante_tipo: "boleta",
      comprobante_numero: numero(),
      despachado_en: new Date().toISOString(),
      lineas: [{ presentacion: "caja", cantidad_bultos: 1, costo_unitario: 50 }],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(400);
  });

  // ── 6. Ninguna lista lo muestra ───────────────────────────────────────

  it("el proveedor oculto no sale en el catálogo, el formulario ni las listas de urea", async () => {
    expect((await crear(cuerpoOtros("Grifo Oculto De Prueba", soloUrea))).status).toBe(201);
    const rutas = [
      "/api/erp/combustible/grifos",
      "/api/erp/combustible/grifos/para-formulario",
      "/api/erp/combustible/urea/proveedores",
      "/api/erp/combustible/urea/proveedores?uso=externo",
    ];
    for (const ruta of rutas) {
      const r = await agente.get(ruta);
      expect(r.status, ruta).toBe(200);
      expect(JSON.stringify(r.body), ruta).not.toContain(NOMBRE_OCULTO);
    }
    // Y la lista sí funciona: trae el proveedor real que sembramos.
    const catalogo = await agente.get("/api/erp/combustible/grifos");
    expect(JSON.stringify(catalogo.body)).toContain(nombreGrifoReal);
  });

  // ── 7. El conductor ───────────────────────────────────────────────────

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
    // ...pero sí comprar en un grifo que escribe a mano, y ve su nombre en su historial.
    const body = cuerpoOtros("Grifo Del Conductor", soloUrea);
    const compra = await crear(body, conductor);
    expect(compra.status, JSON.stringify(compra.body)).toBe(201);
    const historial = await conductor.get("/api/erp/combustible/compras-ruta");
    const fila = (historial.body as { comprobante_numero: string; proveedor: string }[]).find(
      (b) => b.comprobante_numero === body.comprobante_numero
    );
    expect(fila?.proveedor).toBe("Otros: Grifo Del Conductor");
  });
});
