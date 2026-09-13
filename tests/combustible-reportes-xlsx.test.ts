/** tests/combustible-reportes-xlsx.test.ts
 *
 * Las dos descargas en .xlsx: el kardex y el detalle de calibración.
 *
 * Lo que se fija acá, en orden de importancia:
 *
 * 1. QUE EL ARCHIVO DIGA LO MISMO QUE LA PANTALLA. Los totales del kardex van
 *    como fórmulas, y la primera versión sumaba los vales ANULADOS: contra el
 *    tenant redteam daba 12.170 L de salidas donde la pantalla dice 11.270. En
 *    CI no hay planilla que evalúe fórmulas, así que se verifica que la
 *    fórmula saltee la columna de anulados.
 * 2. QUE LOS FALTANTES SEAN NÚMEROS, que es la razón de ser del .xlsx frente
 *    al CSV.
 * 3. QUE EL DETALLE DE CALIBRACIÓN MUESTRE LA MUESTRA ENTERA, fila por fila,
 *    y los números de la etiqueta como fórmulas -- también cuando todavía no
 *    alcanza para sugerir.
 * 4. Permisos y auditoría: son exportaciones de gerencia, y llevarse datos
 *    queda registrado.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { hojaPorNombre, nombresDeHojas } from "./xlsxLectura";
import { crearUsuarioService } from "../src/server/services/auth.service";
import { closeDatabase, withTenant } from "../src/server/config/database";

let seq = 0;
const serieUnica = () => `X${Date.now().toString(36).slice(-5)}${(seq++).toString(36)}`;

describe("combustible: reportes en .xlsx", () => {
  let tenantId: string;
  let tenantSlug: string;
  let equipoId: number;
  const password = "ClaveDePrueba123";
  const ag = request.agent(app);

  const hace = (dias: number) => new Date(Date.now() - dias * 24 * 3600 * 1000).toISOString();

  const leer = (tq: number, nivel: number, cuando: string) =>
    ag.post("/api/erp/combustible/lecturas").send({ combustible_id: tq, nivel, leido_en: cuando });

  /** Supertest trata como texto todo lo que no reconoce: un .xlsx tiene que
   *  llegar como bytes o el ZIP se corrompe al decodificarlo. Mismo patrón que
   *  la descarga de documentos-archivo.test.ts. */
  const bajar = (url: string, query?: Record<string, string>) => {
    const req = ag.get(url);
    if (query) req.query(query);
    return req.buffer(true).parse((res, callback) => {
      const partes: Buffer[] = [];
      res.on("data", (chunk: Buffer) => partes.push(chunk));
      res.on("end", () => callback(null, Buffer.concat(partes)));
    });
  };

  const periodo = () => ({ desde: hace(45), hasta: hace(0.2) });

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    tenantSlug = c.tenant.slug;
    await ag.post("/api/auth/login").send({ tenantSlug, email: c.usuario.email, password });
    const eq = await ag
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("VQ"), tipo: "Volquete" });
    equipoId = eq.body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  async function tanque(nivelInicial = 10000) {
    const r = await ag.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque xlsx",
      tipo_combustible: "diesel_b5",
      unidad: "L",
      tipo_punto: "fijo",
      capacidad_total: 20000,
      nivel_actual: nivelInicial,
      nivel_minimo: 2000,
      modo_vigilancia: "sin_vigilar",
    });
    expect(r.status).toBe(201);
    const tq = r.body.id as number;
    // Varilla ANTES del período: es el ancla del kardex, y deja el saldo
    // inicial limpio para que las cuentas del test sean las esperadas.
    expect((await leer(tq, nivelInicial, hace(50))).status).toBe(201);
    return tq;
  }

  const despachar = (tq: number, cantidad: number, cuando: string) =>
    ag.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tq,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipoId,
      serie_talonario: serieUnica(),
      n_vale: 1,
      cantidad,
      lectura_contometro: cantidad,
      costo_unitario: 16,
      despachado_en: cuando,
    });

  async function operador() {
    const email = idUnico("operador-xlsx") + "@test.local";
    await withTenant(tenantId, (client) =>
      crearUsuarioService(
        { tenantId, nombre: "Operador", email, password, rol: "operador" },
        client
      )
    );
    const agOp = request.agent(app);
    await agOp.post("/api/auth/login").send({ tenantSlug, email, password });
    return agOp;
  }

  // ── Kardex ────────────────────────────────────────────────────────────

  describe("kardex", () => {
    it("se sirve como planilla descargable con dos hojas", async () => {
      const tq = await tanque();
      await despachar(tq, 300, hace(10));

      const res = await bajar(`/api/erp/combustible/${tq}/kardex/xlsx`, periodo());
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("spreadsheetml.sheet");
      expect(res.headers["content-disposition"]).toContain(".xlsx");
      // Todo ZIP arranca con "PK".
      expect((res.body as Buffer).subarray(0, 2).toString()).toBe("PK");
      expect(nombresDeHojas(res.body)).toEqual(["Kardex", "Resumen"]);
    });

    it("escribe los faltantes como NÚMEROS, que es lo que el CSV no podía", async () => {
      const tq = await tanque(10000);
      await despachar(tq, 500, hace(10));
      await leer(tq, 9200, hace(5)); // teórico 9.500, medido 9.200: faltan 300

      const res = await bajar(`/api/erp/combustible/${tq}/kardex/xlsx`, periodo());
      const kardex = hojaPorNombre(res.body, "Kardex");

      expect(kardex).toContain("<v>-300</v>");
      expect(kardex).not.toContain("'-300");
    });

    it("un vale anulado queda en el detalle pero NO suma en los totales", async () => {
      const tq = await tanque(10000);
      await despachar(tq, 400, hace(12));
      const anulado = await despachar(tq, 900, hace(11));
      await ag
        .patch(`/api/erp/combustible/despachos/${anulado.body.id}/anular`)
        .send({ motivo: "error de tipeo" });

      const res = await bajar(`/api/erp/combustible/${tq}/kardex/xlsx`, periodo());
      const kardex = hojaPorNombre(res.body, "Kardex");
      const resumen = hojaPorNombre(res.body, "Resumen");

      // Evidencia: el vale anulado está en el detalle, marcado.
      expect(kardex).toContain("<v>900</v>");
      expect(kardex).toContain(">SÍ<");
      // Pero los totales lo saltean: la fórmula filtra la columna L (Anulado).
      // Con SUM a secas este archivo decía 1.300 L de salidas y la pantalla 400.
      expect(resumen).toMatch(/SUMIFS\(Kardex!F2:F\d+,Kardex!L2:L\d+,&quot;&lt;&gt;SÍ&quot;\)/);
      expect(resumen).toMatch(/SUMIFS\(Kardex!E2:E\d+,Kardex!L2:L\d+,&quot;&lt;&gt;SÍ&quot;\)/);
      expect(resumen).not.toMatch(/<f>SUM\(Kardex!F/);

      // Y el número de la pantalla, contra el que esa fórmula tiene que dar.
      const json = await ag.get(`/api/erp/combustible/${tq}/kardex`).query(periodo());
      expect(json.body.resumen.salidas).toBe(400);
    });

    it("suma solo los tramos negativos en el resumen", async () => {
      const tq = await tanque();
      await despachar(tq, 100, hace(10));

      const res = await bajar(`/api/erp/combustible/${tq}/kardex/xlsx`, periodo());
      const resumen = hojaPorNombre(res.body, "Resumen");

      expect(resumen).toMatch(/SUMIF\(Kardex!I2:I\d+,&quot;&lt;0&quot;\)/);
      expect(resumen).toMatch(/COUNTIF\(Kardex!I2:I\d+,&quot;&lt;0&quot;\)/);
    });

    it("queda auditado, con el formato", async () => {
      const tq = await tanque();
      await despachar(tq, 200, hace(10));
      await bajar(`/api/erp/combustible/${tq}/kardex/xlsx`, periodo());

      const log = await withTenant(tenantId, (c) =>
        c.query(
          `SELECT detalle FROM platform_audit_log
           WHERE tenant_id = $1 AND accion = 'combustible.kardex_exportar'
           ORDER BY id DESC LIMIT 1`,
          [tenantId]
        )
      );
      expect(log.rows[0].detalle.combustibleId).toBe(tq);
      expect(log.rows[0].detalle.formato).toBe("xlsx");
    });

    it("exige el período, igual que el CSV", async () => {
      const tq = await tanque();
      expect((await ag.get(`/api/erp/combustible/${tq}/kardex/xlsx`)).status).toBe(400);
    });

    it("un operador no puede llevárselo", async () => {
      const tq = await tanque();
      const agOp = await operador();
      const res = await agOp.get(`/api/erp/combustible/${tq}/kardex/xlsx`).query(periodo());
      expect(res.status).toBe(403);
    });
  });

  // ── Detalle de calibración ────────────────────────────────────────────

  describe("detalle de calibración", () => {
    const url = (tq: number) => `/api/erp/combustible/${tq}/sugerencia-umbral/xlsx`;

    it("trae una hoja por umbral y la explicación en palabras", async () => {
      const tq = await tanque();

      const res = await bajar(url(tq));
      expect(res.status).toBe(200);
      expect(res.headers["content-disposition"]).toContain(".xlsx");
      expect(nombresDeHojas(res.body)).toEqual([
        "Descuadre por tramo",
        "Ciclo",
        "Diferencia en recepción",
        "Cómo leerlo",
      ]);
    });

    it("muestra la muestra ENTERA, fila por fila, con los mismos números que la etiqueta", async () => {
      const tq = await tanque(10000);
      // Cuatro tramos: tres que cuadran y uno con faltante.
      await despachar(tq, 500, hace(20));
      await leer(tq, 9500, hace(19));
      await despachar(tq, 500, hace(15));
      await leer(tq, 9000, hace(14));
      await despachar(tq, 500, hace(10));
      await leer(tq, 8200, hace(9)); // faltan 300

      const sugerencia = await ag.get(`/api/erp/combustible/${tq}/sugerencia-umbral`);
      const n = sugerencia.body.descuadre.tamanioMuestra as number;
      expect(n).toBeGreaterThan(0);

      const hoja = hojaPorNombre((await bajar(url(tq))).body, "Descuadre por tramo");

      // Una fila de datos por cada medición de la muestra: el número de la
      // primera columna llega hasta n.
      expect(hoja).toContain(`<v>${n}</v>`);
      // El faltante, como número.
      expect(hoja).toContain("<v>-300</v>");
      // Los números de la etiqueta, como fórmulas y no pegados.
      expect(hoja).toContain("<f>AVERAGE(");
      expect(hoja).toContain("SQRT(");
      expect(hoja).toContain("n − 1");
      // El mismo recorte que hace el sistema: piso de 1 %, tope de 100 %.
      expect(hoja).toContain("MAX(1,MIN(100,");
    });

    it("se puede bajar aunque la muestra no alcance para sugerir", async () => {
      const tq = await tanque(10000);
      await despachar(tq, 500, hace(10));
      await leer(tq, 9500, hace(9));

      const sugerencia = await ag.get(`/api/erp/combustible/${tq}/sugerencia-umbral`);
      expect(sugerencia.body.descuadre.muestraSuficiente).toBe(false);

      const res = await bajar(url(tq));
      expect(res.status).toBe(200);
      const hoja = hojaPorNombre(res.body, "Descuadre por tramo");
      // Las pocas mediciones que hay, más la aclaración de que no alcanzan.
      expect(hoja).toContain("RESULTADOS");
      expect(hoja).toContain("faltan mediciones");
    });

    it("no ofrece la muestra en la pantalla cuando no alcanza, pero sí la manda", async () => {
      // La muestra viaja en la respuesta aunque no alcance -- es lo que usa la
      // exportación -- pero la pantalla sigue sin recibir ningún número.
      const tq = await tanque(10000);
      await despachar(tq, 500, hace(10));
      await leer(tq, 9500, hace(9));

      const res = await ag.get(`/api/erp/combustible/${tq}/sugerencia-umbral`);
      expect(res.body.descuadre.muestraSuficiente).toBe(false);
      expect(res.body.descuadre.sugerido).toBeUndefined();
      expect(Array.isArray(res.body.descuadre.muestra)).toBe(true);
    });

    it("una hoja sin mediciones lo dice, en vez de romper las fórmulas", async () => {
      const tq = await tanque();

      const hoja = hojaPorNombre((await bajar(url(tq))).body, "Diferencia en recepción");
      expect(hoja).toContain("Todavía no hay mediciones");
      expect(hoja).not.toContain("<f>");
    });

    it("queda auditado", async () => {
      const tq = await tanque();
      await bajar(url(tq));

      const log = await withTenant(tenantId, (c) =>
        c.query(
          `SELECT detalle FROM platform_audit_log
           WHERE tenant_id = $1 AND accion = 'combustible.calibracion_exportar'
           ORDER BY id DESC LIMIT 1`,
          [tenantId]
        )
      );
      expect(log.rows[0].detalle.combustibleId).toBe(tq);
    });

    it("un tanque inexistente da 404", async () => {
      expect((await ag.get(url(999999999))).status).toBe(404);
    });

    it("un operador no puede bajarlo", async () => {
      const tq = await tanque();
      const agOp = await operador();
      expect((await agOp.get(url(tq))).status).toBe(403);
    });

    it("no exporta el tanque de otro tenant", async () => {
      const tq = await tanque();
      const otro = await crearTenantDePrueba(password);
      try {
        const agOtro = request.agent(app);
        await agOtro
          .post("/api/auth/login")
          .send({ tenantSlug: otro.tenant.slug, email: otro.usuario.email, password });
        expect((await agOtro.get(url(tq))).status).toBe(404);
      } finally {
        await borrarTenantDePrueba(otro.tenant.id);
      }
    });
  });
});
