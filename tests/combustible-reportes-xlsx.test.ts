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
import { hojaPorNombre, nombresDeHojas, notasPorNombre } from "./xlsxLectura";
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

  /** Con `recomendado` se mandan los umbrales 2/2/3/4 % explícitos: el modo
   *  solo queda registrado, los valores los completa el formulario del
   *  navegador. Hacen falta para que la hoja de calibración arme la
   *  comparación contra el umbral de hoy. */
  async function tanque(nivelInicial = 10000, modo: "sin_vigilar" | "recomendado" = "sin_vigilar") {
    const r = await ag.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque xlsx",
      tipo_combustible: "diesel_b5",
      unidad: "L",
      tipo_punto: "fijo",
      capacidad_total: 20000,
      nivel_actual: nivelInicial,
      nivel_minimo: 2000,
      modo_vigilancia: modo,
      ...(modo === "recomendado"
        ? {
            umbral_diferencia_pct: 2,
            umbral_descuadre_pct: 2,
            umbral_descuadre_ciclo_pct: 3,
            umbral_descuadre_ventana_pct: 4,
          }
        : {}),
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
      // Pero los totales lo saltean: la fórmula filtra la columna L (Anulado / histórico).
      // Con SUM a secas este archivo decía 1.300 L de salidas y la pantalla 400.
      expect(resumen).toMatch(
        /SUMIFS\(Kardex!F2:F\d+,Kardex!L2:L\d+,&quot;&lt;&gt;SÍ&quot;,Kardex!L2:L\d+,&quot;&lt;&gt;HISTÓRICO&quot;\)/
      );
      expect(resumen).toMatch(
        /SUMIFS\(Kardex!E2:E\d+,Kardex!L2:L\d+,&quot;&lt;&gt;SÍ&quot;,Kardex!L2:L\d+,&quot;&lt;&gt;HISTÓRICO&quot;\)/
      );
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

    it("trae una hoja por par de números, en el orden del formulario", async () => {
      const tq = await tanque();

      const res = await bajar(url(tq));
      expect(res.status).toBe(200);
      expect(res.headers["content-disposition"]).toContain(".xlsx");
      // Ya no hay hoja de ciclo: desde 0101 el tramo y el ciclo comparten un
      // solo par (misma varilla, mismos medidores), y lo único que los
      // distingue es cuánto movimiento suma cada uno.
      expect(nombresDeHojas(res.body)).toEqual([
        "Diferencia en recepción",
        "Balance del tanque",
        "Ventana",
        "Cómo leerlo",
      ]);
    });

    it("ajusta la recta contra el movimiento, no contra la capacidad", async () => {
      const tq = await tanque(10000);
      await despachar(tq, 500, hace(10));
      await leer(tq, 9200, hace(9));

      const libro = (await bajar(url(tq))).body;
      const hoja = hojaPorNombre(libro, "Balance del tanque");
      const notas = Object.values(notasPorNombre(libro, "Balance del tanque")).join("\n");

      // Los dos números del ajuste, como fórmulas de planilla: si el archivo
      // no los calculara, no podría explicar la pantalla.
      expect(hoja).toContain("<f>IF($B$");
      expect(hoja).toContain("SLOPE(");
      expect(hoja).toContain("SUMSQ(");
      // El corte se calcula a mano (promedio − pendiente × promedio) y no con
      // INTERCEPT: tiene que usar la pendiente YA recortada a 0, no la cruda.
      expect(hoja).toContain("AVERAGE(");
      // La columna de movimiento y la del residuo, que son las nuevas.
      expect(hoja).toContain("Movimiento (");
      expect(hoja).toContain("Residuo (");
      // El porqué, en palabras.
      expect(notas).toContain("no depende de cuánto se movió");
      expect(notas).toContain("crece con el volumen que pasa por ellos");
    });

    it("la hoja de la ventana va CON SIGNO y no suma el nivel de la recta", async () => {
      const tq = await tanque(10000, "recomendado");
      await despachar(tq, 500, hace(10));
      await leer(tq, 9200, hace(9));

      const libro = (await bajar(url(tq))).body;
      const hoja = hojaPorNombre(libro, "Ventana");
      const notas = Object.values(notasPorNombre(libro, "Ventana")).join("\n");

      // Los mismos tramos que la hoja de balance, desarmados igual.
      expect(hoja).toMatch(/<f>D\d+-E\d+\+F\d+<\/f>/);
      expect(hoja).toMatch(/<f>H\d+-G\d+<\/f>/);
      // Con signo: la columna de la cuenta NO pasa por el valor absoluto.
      expect(hoja).toContain("Valor para la cuenta (con signo)");
      // El piso es 2 desviaciones SIN el corte, al revés que en el balance.
      expect(hoja).toMatch(/MAX\(\$B\$\d+,2\*\$B\$\d+\)/);
      expect(hoja).not.toMatch(/MAX\(0,\$B\$\d+\)\+2\*/);
      expect(hoja).toContain("los últimos 30 días");
      // El porqué, en palabras: el error de cada varilla se cancela, y el
      // nivel de la recta no entra porque ahí vive el robo sostenido.
      expect(notas).toContain("un robo se acumula siempre para el mismo lado");
      expect(notas).toContain("tolerar justo el robo");
    });

    it("desarma CADA tramo en su cuenta, con fórmulas", async () => {
      const tq = await tanque(10000);
      // Tres tramos: dos que cuadran y uno con faltante.
      await despachar(tq, 500, hace(20));
      await leer(tq, 9500, hace(19));
      await despachar(tq, 500, hace(15));
      await leer(tq, 9000, hace(14));
      await despachar(tq, 500, hace(10));
      await leer(tq, 8200, hace(9)); // teórico 8.500, medido 8.200: faltan 300

      const sugerencia = await ag.get(`/api/erp/combustible/${tq}/sugerencia-umbral`);
      const n = sugerencia.body.balance.tamanioMuestra as number;
      expect(n).toBeGreaterThan(0);

      const hoja = hojaPorNombre((await bajar(url(tq))).body, "Balance del tanque");

      // Una fila por tramo: el número de la primera columna llega hasta n.
      expect(hoja).toContain(`<v>${n}</v>`);
      // Los pasos del tramo con faltante, como datos: nivel anterior y medido.
      expect(hoja).toContain("<v>9000</v>");
      expect(hoja).toContain("<v>8200</v>");
      // Y la cuenta, como fórmula: teórico = anterior − despachos + recepciones,
      // diferencia = medido − teórico. Nada pegado.
      expect(hoja).toMatch(/<f>D\d+-E\d+\+F\d+<\/f>/);
      expect(hoja).toMatch(/<f>H\d+-G\d+<\/f>/);
      // Los pasos del ajuste, como fórmulas.
      expect(hoja).toContain("<f>AVERAGE(");
      expect(hoja).toContain("SQRT(");
      expect(hoja).toContain("MEDIAN(");
      // El piso mínimo por dilatación: 1 % de la capacidad.
      expect(hoja).toContain("<f>$B$5*1/100</f>");
    });

    it("deja afuera el tramo que toca la lectura inicial del alta", async () => {
      // El alta crea una lectura `inicial` con la fecha de hoy. Con varillas
      // anteriores cargadas, el tramo contra ella es basura: en el tenant
      // redteam aportaba el 82 % de la varianza y llevaba la sugerencia de
      // 1,8 % a 14,5 %. Desde 0101 ni siquiera entra en la muestra.
      const tq = await tanque(10000);
      await leer(tq, 9000, hace(9));

      const res = await ag.get(`/api/erp/combustible/${tq}/sugerencia-umbral`);
      // Hay TRES lecturas: la de hace 50 días que arma el helper, la de hace
      // 9, y la `inicial` que el alta fecha HOY. Eso da dos tramos posibles,
      // pero el segundo (hace 9 -> inicial) termina en la lectura del alta y
      // queda afuera. Antes de 0101 ese tramo entraba y podía dominar toda
      // la estadística: es un salto de 9.000 L contra un nivel que nadie
      // midió en cancha.
      expect(res.body.balance.tamanioMuestra).toBe(1);

      const hoja = hojaPorNombre((await bajar(url(tq))).body, "Balance del tanque");
      // Una sola fila de datos en la tabla: la #1, sin #2.
      expect(hoja).toContain("<v>1</v>");
      expect(hoja).not.toContain("<v>2</v>");
    });

    it("explica cada columna y cada resultado en palabras", async () => {
      const tq = await tanque(10000);
      await despachar(tq, 500, hace(10));
      await leer(tq, 9200, hace(9));

      const libro = (await bajar(url(tq))).body;
      const hoja = hojaPorNombre(libro, "Balance del tanque");
      const notas = Object.values(notasPorNombre(libro, "Balance del tanque")).join("\n");
      expect(hoja).toContain("¿HAY FILAS QUE NO REPRESENTAN AL TANQUE?");
      // Las explicaciones van en NOTAS de celda, no escritas al lado de los
      // números: ni la columna "QUÉ SIGNIFICA" ni el bloque de leyenda.
      expect(hoja).not.toContain("QUÉ SIGNIFICA");
      expect(hoja).not.toContain("CÓMO SE LEE CADA COLUMNA");
      expect(hoja).not.toContain("Lo que DEBERÍA haber");
      expect(notas).toContain("Lo que DEBERÍA haber");
    });

    it("las tres hojas explican sus resultados, no solo la del balance", async () => {
      const tq = await tanque(10000);
      const grifo = await ag
        .post("/api/erp/combustible/grifos")
        .send({ nombre: idUnico("G"), abastece_tanque: true });
      const recibir = (cantidad: number, cuando: string) =>
        ag.post("/api/erp/combustible/recepciones").send({
          combustible_id: tq,
          grifo_id: grifo.body.id,
          cantidad,
          costo_unitario: 16,
          tipo_documento: "factura",
          numero_documento: idUnico("F"),
          recibido_en: cuando,
        });

      expect((await recibir(4000, hace(20))).status).toBe(201);
      await leer(tq, 14000, hace(19));
      await despachar(tq, 500, hace(18));
      await leer(tq, 13400, hace(17));
      expect((await recibir(2000, hace(15))).status).toBe(201);
      await leer(tq, 15400, hace(14));

      const libro = (await bajar(url(tq))).body;
      for (const nombre of ["Balance del tanque", "Ventana", "Diferencia en recepción"]) {
        const notas = Object.values(notasPorNombre(libro, nombre)).join("\n");
        expect(hojaPorNombre(libro, nombre), nombre).not.toContain("QUÉ SIGNIFICA");
        // Los dos resultados y el piso mínimo, explicados en las tres.
        expect(notas, nombre).toContain("Cuánto se aparta una fila típica de la recta");
        expect(notas, nombre).toContain("alertando por el clima");
        expect(notas, nombre).toContain("Hace falta que las filas sean de tamaños distintos");
      }
    });

    it("pone el par configurado hoy, los dos números", async () => {
      const tq = await tanque(10000, "recomendado");
      await leer(tq, 9900, hace(9));

      const hoja = hojaPorNombre((await bajar(url(tq))).body, "Balance del tanque");
      // La cabecera lleva el piso Y el porcentaje: la tolerancia es la suma
      // de los dos, y mostrar uno solo sería mostrar media cuenta.
      expect(hoja).toContain("Piso configurado hoy (");
      expect(hoja).toContain("Porcentaje configurado hoy (%)");
    });

    it("compara lo de hoy contra la sugerencia, en filas concretas", async () => {
      const tq = await tanque(10000, "recomendado");
      await despachar(tq, 500, hace(10));
      await leer(tq, 9200, hace(9));

      const hoja = hojaPorNombre((await bajar(url(tq))).body, "Balance del tanque");
      expect(hoja).toContain("COMPARACIÓN: LO DE HOY CONTRA LA SUGERENCIA");
      expect(hoja).toContain("Filas que DEJARÍAN de alertar si se acepta la sugerencia");
      // Cada fila se compara contra SU tolerancia, no contra un número fijo:
      // piso + porcentaje × el movimiento de esa fila.
      expect(hoja).toMatch(/ABS\([A-Z]+\d+\)&gt;\$B\$\d+\+\$B\$\d+\/100\*[A-Z]+\d+/);
      // Con menos filas que el mínimo, la columna queda vacía: no hay
      // sugerencia que aceptar y mostrar un número inventado confunde.
      expect(hoja).toMatch(/IF\(\$B\$\d+&lt;\$B\$\d+,&quot;&quot;,/);
    });

    it("sin nada configurado no inventa la comparación", async () => {
      const tq = await tanque(10000, "sin_vigilar");
      await leer(tq, 9900, hace(9));

      const hoja = hojaPorNombre((await bajar(url(tq))).body, "Balance del tanque");
      expect(hoja).toContain("sin configurar");
      expect(hoja).not.toContain("COMPARACIÓN: LO DE HOY");
    });

    it("traduce el par a litros en un período típico", async () => {
      // El número que hace juzgable la sugerencia: "en un tramo normal de
      // este tanque, esto deja pasar X litros". Sin él hay que multiplicar a
      // mano el porcentaje por el movimiento para saber qué se está aceptando.
      const tq = await tanque(10000);
      await despachar(tq, 500, hace(10));
      await leer(tq, 9200, hace(9));

      const libro = (await bajar(url(tq))).body;
      const hoja = hojaPorNombre(libro, "Balance del tanque");
      const notas = Object.values(notasPorNombre(libro, "Balance del tanque")).join("\n");
      expect(hoja).toContain("Tolerancia en un período típico (");
      expect(notas).toContain("deja pasar X litros");
    });

    it("muestra los litros con 2 decimales y los conteos enteros", async () => {
      const tq = await tanque(10000);
      await leer(tq, 9900, hace(9));

      const hoja = hojaPorNombre((await bajar(url(tq))).body, "Balance del tanque");
      // Estilos del generador: 2/3 = decimal (normal/negrita), 4/5 = entero.
      expect(hoja).toMatch(/ s="2"/);
      expect(hoja).toMatch(/ s="4"/);
    });

    it("se puede bajar aunque la muestra no alcance para sugerir", async () => {
      const tq = await tanque(10000);
      await despachar(tq, 500, hace(10));
      await leer(tq, 9500, hace(9));

      const sugerencia = await ag.get(`/api/erp/combustible/${tq}/sugerencia-umbral`);
      expect(sugerencia.body.balance.muestraSuficiente).toBe(false);

      const res = await bajar(url(tq));
      expect(res.status).toBe(200);
      const hoja = hojaPorNombre(res.body, "Balance del tanque");
      // Las pocas mediciones que hay, más el bloque de resultados.
      expect(hoja).toContain("RESULTADOS");
      // El rótulo del conteo dice QUÉ se cuenta: en esta hoja, tramos.
      expect(hoja).toContain("Mínimo de tramos para que el sistema sugiera");
    });

    it("no ofrece números en la pantalla cuando no alcanza, pero sí manda la muestra", async () => {
      const tq = await tanque(10000);
      await despachar(tq, 500, hace(10));
      await leer(tq, 9500, hace(9));

      const res = await ag.get(`/api/erp/combustible/${tq}/sugerencia-umbral`);
      expect(res.body.balance.muestraSuficiente).toBe(false);
      expect(res.body.balance.piso).toBeUndefined();
      expect(res.body.balance.pct).toBeUndefined();
      expect(Array.isArray(res.body.balance.muestra)).toBe(true);
    });

    it("una hoja sin mediciones lo dice, en vez de romper las fórmulas", async () => {
      const tq = await tanque();

      const hoja = hojaPorNombre((await bajar(url(tq))).body, "Diferencia en recepción");
      expect(hoja).toContain("Todavía no hay entregas");
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
