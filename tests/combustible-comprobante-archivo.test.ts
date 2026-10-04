/** tests/combustible-comprobante-archivo.test.ts
 *
 * La foto (o el PDF) de la boleta de una compra en ruta -- migración 0109,
 * entrega 3. Integración HTTP contra Postgres real, con el driver "local"
 * que fija tests/setup.storage.ts para toda la suite: no hacen falta
 * credenciales de R2, y una máquina que sí las tenga no escribe en el
 * bucket real. El driver s3 en sí ya está cubierto por
 * tests/document-storage.test.ts.
 *
 * Lo que se prueba acá es lo que no se ve leyendo el código:
 *
 *  - que un tenant NO pueda bajar el comprobante de otro (el ataque que
 *    importa: la URL lleva un id numérico adivinable);
 *  - que el reintento de la cola offline (mismo archivo) se distinga de un
 *    reemplazo (archivo distinto), porque de eso depende que una foto no
 *    se pierda ni exija un motivo que la cola no puede dar;
 *  - que lo que se descarga sea BYTE A BYTE lo que se subió.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";

const FOTO = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]); // JPEG mínimo
const OTRA_FOTO = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 9]);

describe("combustible: comprobante adjunto de la compra en ruta (0109)", () => {
  let tenantId: string;
  let grifoId: number;
  let equipoId: number;
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);

  /** Otro tenant, con su propio admin: el que intenta leer lo ajeno. */
  let tenantVecinoId: string;
  const agenteVecino = request.agent(app);

  async function crearCompra(clienteUuid?: string): Promise<number> {
    const res = await agente.post("/api/erp/combustible/despachos").send({
      cliente_uuid: clienteUuid,
      origen: "compra_externa",
      grifo_id: grifoId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipoId,
      comprobante_tipo: "boleta",
      comprobante_numero: `B001-${Math.floor(Math.random() * 1e8)}`,
      cantidad: 40,
      lectura_horometro: Math.floor(Math.random() * 1e6),
      horas_abastecidas: 12,
      costo_unitario: 17.5,
      despachado_en: new Date().toISOString(),
    });
    expect(res.status).toBe(201);
    return res.body.id;
  }

  function subir(despachoId: number, contenido: Buffer, campos: Record<string, string> = {}) {
    const peticion = agente
      .post(`/api/erp/combustible/despachos/${despachoId}/comprobante`)
      .attach("archivo", contenido, { filename: "boleta.jpg", contentType: "image/jpeg" });
    for (const [campo, valor] of Object.entries(campos)) peticion.field(campo, valor);
    return peticion;
  }

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });

    const equipo = await agente
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("VOL"), tipo: "VOLQUETE", tipo_medidor: "horometro" });
    equipoId = equipo.body.id;

    const grifo = await agente
      .post("/api/erp/combustible/grifos")
      .send({ nombre: idUnico("PRIMAX") });
    grifoId = grifo.body.id;

    const vecino = await crearTenantDePrueba(password);
    tenantVecinoId = vecino.tenant.id;
    await agenteVecino
      .post("/api/auth/login")
      .send({ tenantSlug: vecino.tenant.slug, email: vecino.usuario.email, password });
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await borrarTenantDePrueba(tenantVecinoId);
    await closeDatabase();
  });

  it("adjunta la foto y la fila queda con el archivo", async () => {
    const despachoId = await crearCompra();
    const res = await subir(despachoId, FOTO);
    expect(res.status).toBe(201);
    expect(res.body.comprobante_nombre).toBe("boleta.jpg");
    expect(res.body.comprobante_mime).toBe("image/jpeg");
    expect(Number(res.body.comprobante_bytes)).toBe(FOTO.length);
    expect(res.body.comprobante_subido_en).not.toBeNull();
    // La ubicación interna en el bucket NO se publica: la descarga va por su
    // endpoint con permisos, y el cliente no tiene nada que hacer con la key.
    expect(res.body.comprobante_key).toBeUndefined();
    expect(res.body.comprobante_driver).toBeUndefined();
  });

  it("lo que se descarga es byte a byte lo que se subió", async () => {
    const despachoId = await crearCompra();
    await subir(despachoId, FOTO);
    const res = await agente
      .get(`/api/erp/combustible/despachos/${despachoId}/comprobante`)
      .buffer()
      .parse((respuesta, callback) => {
        const trozos: Buffer[] = [];
        respuesta.on("data", (t: Buffer) => trozos.push(t));
        respuesta.on("end", () => callback(null, Buffer.concat(trozos)));
      });
    expect(res.status).toBe(200);
    expect(Buffer.compare(res.body as Buffer, FOTO)).toBe(0);
  });

  it("reintento de la cola (MISMO archivo): 200 y no pide motivo", async () => {
    const despachoId = await crearCompra();
    expect((await subir(despachoId, FOTO)).status).toBe(201);
    const reintento = await subir(despachoId, FOTO);
    expect(reintento.status).toBe(200);
  });

  it("reemplazo (archivo DISTINTO) sin motivo: 400", async () => {
    const despachoId = await crearCompra();
    expect((await subir(despachoId, FOTO)).status).toBe(201);
    const res = await subir(despachoId, OTRA_FOTO);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/motivo/i);
  });

  it("reemplazo con motivo: 201 y queda el archivo nuevo", async () => {
    const despachoId = await crearCompra();
    await subir(despachoId, FOTO);
    const res = await subir(despachoId, OTRA_FOTO, { motivo: "la foto anterior salió cortada" });
    expect(res.status).toBe(201);
    expect(Number(res.body.comprobante_bytes)).toBe(OTRA_FOTO.length);
  });

  it("OTRO TENANT no puede descargar el comprobante: 404, no 403", async () => {
    const despachoId = await crearCompra();
    await subir(despachoId, FOTO);
    const res = await agenteVecino.get(`/api/erp/combustible/despachos/${despachoId}/comprobante`);
    // 404 y no 403 a propósito: un 403 confirmaría que ese id existe en
    // alguna parte. Para el vecino, esa compra sencillamente no existe.
    expect(res.status).toBe(404);
  });

  it("otro tenant tampoco puede SUBIRLE un archivo a una compra ajena", async () => {
    const despachoId = await crearCompra();
    const res = await agenteVecino
      .post(`/api/erp/combustible/despachos/${despachoId}/comprobante`)
      .attach("archivo", FOTO, { filename: "boleta.jpg", contentType: "image/jpeg" });
    expect(res.status).toBe(404);
  });

  it("una compra sin archivo adjunto devuelve 404 al descargar", async () => {
    const despachoId = await crearCompra();
    const res = await agente.get(`/api/erp/combustible/despachos/${despachoId}/comprobante`);
    expect(res.status).toBe(404);
  });

  it("un despacho que no existe: 404", async () => {
    const res = await subir(999999999, FOTO);
    expect(res.status).toBe(404);
  });

  it("un tipo de archivo no permitido se rechaza con 400", async () => {
    const despachoId = await crearCompra();
    const res = await agente
      .post(`/api/erp/combustible/despachos/${despachoId}/comprobante`)
      .attach("archivo", Buffer.from("MZ\x90\x00"), {
        filename: "virus.exe",
        contentType: "application/x-msdownload",
      });
    expect(res.status).toBe(400);
  });

  it("una compra ANULADA no acepta comprobante", async () => {
    const despachoId = await crearCompra();
    const anulada = await agente
      .patch(`/api/erp/combustible/despachos/${despachoId}/anular`)
      .send({ motivo: "cargada por error" });
    expect(anulada.status).toBe(200);
    const res = await subir(despachoId, FOTO);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/anulada/i);
  });

  it("un vale de TANQUE PROPIO no acepta comprobante: el archivo es de la compra en ruta", async () => {
    const tanqueId = await withTenant(tenantId, async (client) => {
      const fila = await client.query(
        `INSERT INTO combustible (
           tenant_id, codigo, tanque_nombre, tipo_combustible, unidad, tipo_punto, capacidad_total
         ) VALUES ($1, $2, 'Tanque comprobante', 'diesel_b5', 'gal', 'fijo', 5000) RETURNING id`,
        [tenantId, idUnico("TQ")]
      );
      return fila.rows[0].id as number;
    });
    const vale = await agente.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tanqueId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipoId,
      serie_talonario: idUnico("S").slice(0, 8),
      n_vale: 1,
      cantidad: 35,
      lectura_contometro: 35,
      costo_unitario: 16.8,
      despachado_en: new Date().toISOString(),
    });
    expect(vale.status).toBe(201);
    const res = await subir(vale.body.id, FOTO);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/comprobante de proveedor|compras en ruta/i);
  });

  describe("por cliente_uuid (la foto encolada offline)", () => {
    const subirPorUuid = (a: typeof agente, uuid: string, contenido = FOTO) =>
      a
        .post(`/api/erp/combustible/despachos/por-uuid/${uuid}/comprobante`)
        .attach("archivo", contenido, { filename: "boleta.jpg", contentType: "image/jpeg" });

    it("adjunta la foto a la compra registrada con ese uuid", async () => {
      const uuid = crypto.randomUUID();
      const despachoId = await crearCompra(uuid);
      const res = await subirPorUuid(agente, uuid);
      expect(res.status).toBe(201);
      expect(res.body.id).toBe(despachoId);
    });

    it("uuid que no corresponde a ninguna compra: 404", async () => {
      expect((await subirPorUuid(agente, crypto.randomUUID())).status).toBe(404);
    });

    it("uuid mal formado: 404 y no 500 (la cola reintenta los 5xx para siempre)", async () => {
      expect((await subirPorUuid(agente, "no-es-un-uuid")).status).toBe(404);
    });

    it("el uuid de OTRO tenant no resuelve: 404", async () => {
      const uuid = crypto.randomUUID();
      await crearCompra(uuid);
      expect((await subirPorUuid(agenteVecino, uuid)).status).toBe(404);
    });
  });
});
