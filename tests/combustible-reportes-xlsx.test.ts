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

    it("trae una hoja por umbral, en el orden del formulario, y la explicación en palabras", async () => {
      const tq = await tanque();

      const res = await bajar(url(tq));
      expect(res.status).toBe(200);
      expect(res.headers["content-disposition"]).toContain(".xlsx");
      // Mismo orden que los campos de la ficha del tanque: quien baja el
      // archivo desde un campo encuentra su hoja en el lugar que espera.
      expect(nombresDeHojas(res.body)).toEqual([
        "Diferencia en recepción",
        "Descuadre por tramo",
        "Ciclo",
        "Ventana",
        "Cómo leerlo",
      ]);
    });

    it("la hoja de la ventana hace la cuenta CON SIGNO, sin valor absoluto ni √n", async () => {
      const tq = await tanque(10000, "recomendado");
      await despachar(tq, 500, hace(10));
      await leer(tq, 9200, hace(9));

      const libro = (await bajar(url(tq))).body;
      const hoja = hojaPorNombre(libro, "Ventana");
      const notas = Object.values(notasPorNombre(libro, "Ventana")).join("\n");

      // Los mismos tramos que la hoja de descuadre, desarmados igual.
      expect(hoja).toMatch(/<f>D\d+-E\d+\+F\d+<\/f>/);
      expect(hoja).toMatch(/<f>H\d+-G\d+<\/f>/);
      // Con signo: ni la columna ni la fórmula del valor absoluto.
      expect(hoja).not.toContain("Valor absoluto");
      expect(hoja).not.toContain("ABS(");
      // Cuadrados contra el promedio CON SIGNO, que es el de la columna I.
      expect(hoja).toMatch(/<f>\(I\d+-\$B\$\d+\)\^2<\/f>/);
      expect(hoja).toContain("<f>AVERAGE(I");
      // Sugerencia = 2 desviaciones, sin sumar el promedio ni multiplicar por
      // la cantidad de tramos.
      expect(hoja).toMatch(/<f>IF\(\$B\$\d+&gt;1,2\*\$B\$\d+,&quot;&quot;\)<\/f>/);
      // No compara tramos sueltos contra el umbral: la alerta mira la suma.
      expect(hoja).not.toContain("¿Alerta con el umbral de hoy?");
      expect(hoja).toContain("COMPARACIÓN: EL UMBRAL DE HOY CONTRA LA SUGERENCIA");
      // La etiqueta de la pantalla, con "desviación" en vez de "promedio ±".
      expect(hoja).toContain(" mediciones, desviación ");
      expect(hoja).toContain("los últimos 30 días");
      // El porqué, en palabras: el error de cada varilla se cancela.
      expect(notas).toContain("se cancela con el tramo siguiente");
      expect(notas).toContain("un robo sistemático subiría el umbral");
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
      const n = sugerencia.body.descuadre.tamanioMuestra as number;
      expect(n).toBeGreaterThan(0);

      const hoja = hojaPorNombre((await bajar(url(tq))).body, "Descuadre por tramo");

      // Una fila por tramo: el número de la primera columna llega hasta n.
      expect(hoja).toContain(`<v>${n}</v>`);
      // Los pasos del tramo con faltante, como datos: nivel anterior y medido.
      expect(hoja).toContain("<v>9000</v>");
      expect(hoja).toContain("<v>8200</v>");
      // Y la cuenta, como fórmula: teórico = anterior − despachos + recepciones,
      // diferencia = medido − teórico. Nada pegado.
      expect(hoja).toMatch(/<f>D\d+-E\d+\+F\d+<\/f>/);
      expect(hoja).toMatch(/<f>H\d+-G\d+<\/f>/);
      // Los números de la etiqueta, como fórmulas.
      expect(hoja).toContain("<f>AVERAGE(");
      expect(hoja).toContain("SQRT(");
      expect(hoja).toContain("MEDIAN(");
      // El mismo recorte que hace el sistema: piso de 1 %, tope de 100 %.
      expect(hoja).toContain("MAX(1,MIN(100,");
    });

    it("marca la lectura inicial del alta, que no es una medición de cancha", async () => {
      // El alta del tanque crea una lectura `inicial` con la fecha de hoy. Con
      // varillas anteriores cargadas, el tramo contra ella es basura: en el
      // tenant redteam aportaba el 82 % de la varianza.
      const tq = await tanque(10000);
      await leer(tq, 9000, hace(9));

      const hoja = hojaPorNombre((await bajar(url(tq))).body, "Descuadre por tramo");
      expect(hoja).toContain("Lectura inicial del alta del tanque");
    });

    it("explica cada columna y cada resultado en palabras", async () => {
      const tq = await tanque(10000);
      await despachar(tq, 500, hace(10));
      await leer(tq, 9200, hace(9));

      const libro = (await bajar(url(tq))).body;
      const hoja = hojaPorNombre(libro, "Descuadre por tramo");
      const notas = Object.values(notasPorNombre(libro, "Descuadre por tramo")).join("\n");
      expect(hoja).toContain("LECTURA RÁPIDA");
      // Las explicaciones van en NOTAS de celda, no escritas al lado de los
      // números: ni la columna "QUÉ SIGNIFICA" ni el bloque de leyenda.
      expect(hoja).not.toContain("QUÉ SIGNIFICA");
      expect(hoja).not.toContain("CÓMO SE LEE CADA COLUMNA");
      expect(hoja).not.toContain("Lo que DEBERÍA haber");
      expect(notas).toContain("Lo que DEBERÍA haber");
    });

    it("las tres hojas explican sus resultados, no solo la de tramo", async () => {
      // Las tres salen de la misma función, pero el bloque de resultados solo
      // se arma con al menos una fila: hacen falta recepciones para que el
      // ciclo y la diferencia tengan algo que mostrar.
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
      // La segunda recepción cierra el primer ciclo.
      expect((await recibir(2000, hace(15))).status).toBe(201);
      await leer(tq, 15400, hace(14));

      const libro = (await bajar(url(tq))).body;
      for (const nombre of ["Descuadre por tramo", "Ciclo", "Diferencia en recepción"]) {
        const notas = Object.values(notasPorNombre(libro, nombre)).join("\n");
        expect(hojaPorNombre(libro, nombre), nombre).not.toContain("QUÉ SIGNIFICA");
        expect(notas, nombre).toContain("Cuánto suele variar el desajuste");
        expect(notas, nombre).toContain("Lo normal del tanque más un margen");
        // La de recepción ya calcula en %: no tiene paso de litros a porcentaje.
        if (nombre !== "Diferencia en recepción") {
          expect(notas, nombre).toContain("pasada a porcentaje del tanque");
        }
        expect(notas, nombre).toContain("Con piso de 1 %");
      }

      // Cada hoja reconstruye la etiqueta de SU campo, que no es la misma: el
      // de diferencia tiene su propio recuadro con otro texto. Con una sola
      // fórmula para las tres, el archivo decía otra cosa que la pantalla.
      expect(hojaPorNombre(libro, "Diferencia en recepción")).toContain(
        "Todavía no hay muestra suficiente para sugerir un umbral ("
      );
      expect(hojaPorNombre(libro, "Diferencia en recepción")).toContain(
        " recepciones con lectura antes y después)."
      );
      expect(hojaPorNombre(libro, "Diferencia en recepción")).toContain(" recepciones, promedio ");
      for (const nombre of ["Descuadre por tramo", "Ciclo", "Ventana"]) {
        expect(hojaPorNombre(libro, nombre), nombre).toContain(
          "). Hasta entonces, el valor de arriba es provisional."
        );
      }
    });

    it("pone el umbral de hoy también en litros", async () => {
      const tq = await tanque(10000, "recomendado");
      await leer(tq, 9900, hace(9));

      const hoja = hojaPorNombre((await bajar(url(tq))).body, "Descuadre por tramo");
      // Umbral % (B6) × capacidad (B5) / 100. Con 2 % y 20.000 L son 400 L.
      expect(hoja).toContain("<f>B6*B5/100</f>");
    });

    it("compara el umbral de hoy contra la sugerencia, en filas concretas", async () => {
      const tq = await tanque(10000, "recomendado");
      await despachar(tq, 500, hace(10));
      await leer(tq, 9200, hace(9));

      const hoja = hojaPorNombre((await bajar(url(tq))).body, "Descuadre por tramo");
      expect(hoja).toContain("COMPARACIÓN: EL UMBRAL DE HOY CONTRA LA SUGERENCIA");
      expect(hoja).toContain("Filas que DEJARÍAN de alertar si se acepta la sugerencia");
      // Cuenta filas contra una celda: COUNTIF(rango,">"&$B$n).
      expect(hoja).toMatch(/COUNTIF\([A-Z]+\d+:[A-Z]+\d+,&quot;&gt;&quot;&amp;\$B\$\d+\)/);
      // Con menos filas que el mínimo, la comparación queda vacía: no hay
      // sugerencia que aceptar y mostrar un número inventado confunde.
      expect(hoja).toMatch(/IF\(\$B\$\d+&lt;\$B\$\d+,&quot;&quot;,/);
    });

    it("sin umbral configurado no inventa la comparación", async () => {
      const tq = await tanque(10000, "sin_vigilar");
      await leer(tq, 9900, hace(9));

      const hoja = hojaPorNombre((await bajar(url(tq))).body, "Descuadre por tramo");
      expect(hoja).toContain("sin configurar");
      expect(hoja).toContain("sin umbral");
      expect(hoja).not.toContain("COMPARACIÓN: EL UMBRAL DE HOY");
    });

    it("empareja la etiqueta de la pantalla con los números del archivo", async () => {
      // La pantalla dice "promedio 1.93% ± 6.27%" y la hoja trabaja en litros:
      // sin este bloque no hay forma de encontrar el 6.27 en el archivo.
      const tq = await tanque(10000);
      await despachar(tq, 500, hace(10));
      await leer(tq, 9200, hace(9));

      const libro = (await bajar(url(tq))).body;
      const hoja = hojaPorNombre(libro, "Descuadre por tramo");
      expect(hoja).toContain("CÓMO LO MUESTRA LA PANTALLA");
      expect(hoja).toContain("Desviación en % de la capacidad");
      // La aclaración del ± vive en la nota del rótulo, no al lado del número.
      expect(Object.values(notasPorNombre(libro, "Descuadre por tramo")).join("\n")).toContain(
        "el ± NO significa"
      );
      // La etiqueta reconstruida con fórmula, con el mismo formato que la pantalla.
      expect(hoja).toContain("mediciones, promedio ");
    });

    it("muestra los litros con 2 decimales y los conteos enteros", async () => {
      const tq = await tanque(10000);
      await leer(tq, 9900, hace(9));

      const hoja = hojaPorNombre((await bajar(url(tq))).body, "Descuadre por tramo");
      // Estilos del generador: 2/3 = decimal (normal/negrita), 4/5 = entero.
      expect(hoja).toMatch(/ s="2"/);
      expect(hoja).toMatch(/ s="4"/);
    });

    it("en la hoja de recepciones el umbral en litros no aplica", async () => {
      const tq = await tanque(10000, "recomendado");

      const hoja = hojaPorNombre((await bajar(url(tq))).body, "Diferencia en recepción");
      expect(hoja).toContain("no aplica");
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
      // El rótulo del conteo dice QUÉ se cuenta: en esta hoja, tramos.
      expect(hoja).toContain("Mínimo de tramos para que el sistema sugiera");
      expect(hoja).toContain("No -- faltan tramos");
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
