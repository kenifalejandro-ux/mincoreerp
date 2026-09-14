/** tests/xlsx-util.test.ts
 *
 * El generador de .xlsx, que se escribió a mano para no meter una dependencia
 * en el backend (ver el encabezado de `xlsx.util.ts`).
 *
 * Lo que se fija acá, en orden de importancia:
 *
 * 1. QUE EL ARCHIVO ABRA. Un .xlsx mal armado no se degrada: Excel lo declara
 *    corrupto y no muestra NADA. Por eso se verifica el contenedor entero, no
 *    solo que la función devuelva bytes.
 * 2. QUE LOS NEGATIVOS SEAN NÚMEROS. Es el bug que este formato viene a
 *    resolver: en CSV hay que anteponer una comilla a todo lo que arranque
 *    con "-" para frenar la inyección de fórmulas, y eso convierte cada
 *    faltante en texto que Excel no suma. Acá el tipo de celda es explícito.
 * 3. QUE UN TEXTO CON "=" SIGA SIENDO TEXTO. La contracara de lo anterior: no
 *    alcanza con que los números anden si el motivo de anulación de un
 *    usuario se convierte en fórmula ejecutable.
 * 4. Que la salida sea determinista, para que dos descargas del mismo reporte
 *    den el mismo archivo y este test pueda comparar.
 */
import { describe, it, expect } from "vitest";
import { armarXlsx, letraColumna } from "../src/server/shared/utils/xlsx.util";
import { leerEntrada, nombresDePartes } from "./xlsxLectura";

describe("xlsx.util: el contenedor", () => {
  it("trae todas las partes obligatorias y cierra el directorio central", () => {
    const zip = armarXlsx([{ nombre: "Hoja", filas: [["a", 1]] }]);

    expect(nombresDePartes(zip)).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/worksheets/sheet1.xml",
    ]);

    // El fin del directorio central (PK\x05\x06) tiene que ser lo último del
    // archivo, o ningún lector lo reconoce como ZIP.
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);
    expect(zip.readUInt16LE(zip.length - 22 + 8)).toBe(6); // partes declaradas
  });

  it("escribe una hoja por cada una que se le pasa, con su relación", () => {
    const zip = armarXlsx([
      { nombre: "Detalle", filas: [["x"]] },
      { nombre: "Resumen", filas: [["y"]] },
    ]);

    expect(nombresDePartes(zip)).toContain("xl/worksheets/sheet2.xml");
    const workbook = leerEntrada(zip, "xl/workbook.xml");
    expect(workbook).toContain('name="Detalle"');
    expect(workbook).toContain('name="Resumen"');
    // Sin esta bandera, LibreOffice muestra las fórmulas vacías hasta que el
    // usuario toca una celda: el archivo se guarda sin resultados calculados.
    expect(workbook).toContain('fullCalcOnLoad="1"');
  });

  it("no acepta un libro sin hojas", () => {
    expect(() => armarXlsx([])).toThrow(/al menos una hoja/);
  });

  it("produce el mismo archivo byte por byte con el mismo contenido", () => {
    const filas = [["a", -300, { formula: "ABS(B1)" }]];
    expect(armarXlsx([{ nombre: "H", filas }])).toEqual(armarXlsx([{ nombre: "H", filas }]));
  });
});

describe("xlsx.util: las celdas", () => {
  const hoja = (filas: Parameters<typeof armarXlsx>[0][0]["filas"]) =>
    leerEntrada(armarXlsx([{ nombre: "H", filas }]), "xl/worksheets/sheet1.xml");

  it("escribe los números negativos COMO NÚMEROS, que es lo que el CSV no puede", () => {
    const xml = hoja([[-300, -2500.5]]);

    expect(xml).toContain("<v>-300</v>");
    expect(xml).toContain("<v>-2500.5</v>");
    // Lo que NO tiene que aparecer: la comilla de escape del CSV, que es
    // justamente lo que rompe la suma en Excel.
    expect(xml).not.toContain("'-300");
    expect(xml).not.toContain("inlineStr");
  });

  it("deja un texto que arranca con = como TEXTO, no como fórmula", () => {
    const xml = hoja([["=cmd|' /C calc'!A0"]]);

    expect(xml).toContain('t="inlineStr"');
    expect(xml).toContain("=cmd|&apos; /C calc&apos;!A0");
    // La única forma de que Excel ejecute algo es que esté en <f>, y ahí no
    // llega nada que venga de un dato.
    expect(xml).not.toContain("<f>");
  });

  it("escribe una fórmula pedida como tal, sin el = inicial", () => {
    const xml = hoja([[{ formula: "AVERAGE(C2:C28)" }]]);

    expect(xml).toContain("<f>AVERAGE(C2:C28)</f>");
    expect(xml).not.toContain("<f>=AVERAGE");
  });

  it("escapa los signos que romperían el XML y conserva los acentos", () => {
    const xml = hoja([['Recepción & <medición> "varilla"']]);

    expect(xml).toContain("Recepción &amp; &lt;medición&gt; &quot;varilla&quot;");
  });

  it("descarta los caracteres de control, que invalidan el archivo entero", () => {
    // Armado por código de carácter: escritos literales, estos caracteres serían
    // invisibles en el código fuente del test.
    const sucio = `motivo${String.fromCharCode(0)}con${String.fromCharCode(7)}basura`;
    const xml = hoja([[sucio]]);

    expect(xml).toContain("motivoconbasura");
  });

  it("omite NaN e Infinity en vez de escribir un archivo corrupto", () => {
    // Pasa de verdad: un promedio sobre un período sin mediciones da NaN.
    const xml = hoja([[NaN, Infinity, 0]]);

    expect(xml).not.toContain("NaN");
    expect(xml).not.toContain("Infinity");
    expect(xml).toContain("<v>0</v>");
  });

  it("marca en negrita solo lo que se le pide", () => {
    const xml = hoja([[{ valor: "Encabezado", negrita: true }, "normal"]]);

    expect(xml).toContain('s="1"');
    expect(xml).toContain('<c r="B1" t="inlineStr">');
  });

  it("aplica el formato de número pedido, también a una fórmula", () => {
    // Sin formato, una fórmula muestra "2895.601107233": Kenif lo marcó al
    // abrir la planilla, y el usuario no sabe qué decimales importan.
    const xml = hoja([
      [
        { valor: 2895.601107233, formato: "decimal" },
        { formula: "AVERAGE(A1:A1)", formato: "decimal", negrita: true },
        { valor: 27, formato: "entero" },
        { valor: 27, formato: "entero", negrita: true },
      ],
    ]);

    // El valor guardado queda entero: el formato solo cambia cómo se muestra.
    expect(xml).toContain('<c r="A1" s="2"><v>2895.601107233</v></c>');
    expect(xml).toContain('<c r="B1" s="3"><f>AVERAGE(A1:A1)</f></c>');
    expect(xml).toContain('<c r="C1" s="4"><v>27</v></c>');
    expect(xml).toContain('<c r="D1" s="5"><v>27</v></c>');
  });

  it("declara los seis estilos con los formatos predefinidos de 2 y 0 decimales", () => {
    const estilos = leerEntrada(armarXlsx([{ nombre: "H", filas: [["x"]] }]), "xl/styles.xml");

    expect(estilos).toContain('<cellXfs count="6">');
    // 4 = "#,##0.00" y 3 = "#,##0" en el estándar: no hace falta declararlos.
    expect(estilos).toMatch(/numFmtId="4" fontId="0"[^>]*applyNumberFormat="1"/);
    expect(estilos).toMatch(/numFmtId="3" fontId="1"[^>]*applyFont="1" applyNumberFormat="1"/);
  });

  it("saltea las celdas vacías en vez de escribirlas", () => {
    const xml = hoja([["a", null, "", "d"]]);

    expect(xml).toContain('r="A1"');
    expect(xml).toContain('r="D1"');
    expect(xml).not.toContain('r="B1"');
    expect(xml).not.toContain('r="C1"');
  });
});

describe("xlsx.util: las notas de celda", () => {
  it("una hoja sin notas no arrastra partes de comentarios", () => {
    const zip = armarXlsx([{ nombre: "H", filas: [["a"]] }]);
    expect(nombresDePartes(zip).some((n) => n.includes("comments"))).toBe(false);
    expect(leerEntrada(zip, "xl/worksheets/sheet1.xml")).not.toContain("legacyDrawing");
  });

  it("escribe el texto Y el recuadro: sin el VML, Excel no muestra la nota", () => {
    const zip = armarXlsx([
      { nombre: "Sin", filas: [["x"]] },
      {
        nombre: "Con",
        filas: [[null], [{ valor: "Promedio", negrita: true, nota: "Todo <junto> & repartido" }]],
      },
    ]);
    const partes = nombresDePartes(zip);

    // Las partes llevan el número de la hoja que las tiene, no un contador propio.
    expect(partes).toContain("xl/comments2.xml");
    expect(partes).toContain("xl/drawings/vmlDrawing2.vml");
    expect(partes).toContain("xl/worksheets/_rels/sheet2.xml.rels");

    const comentarios = leerEntrada(zip, "xl/comments2.xml");
    expect(comentarios).toContain('ref="A2"');
    expect(comentarios).toContain("Todo &lt;junto&gt; &amp; repartido");

    const vml = leerEntrada(zip, "xl/drawings/vmlDrawing2.vml");
    expect(vml).toContain("<x:Row>1</x:Row><x:Column>0</x:Column>");
    expect(vml).toContain("visibility:hidden");

    expect(leerEntrada(zip, "xl/worksheets/sheet2.xml")).toContain('<legacyDrawing r:id="rId2"/>');
    const tipos = leerEntrada(zip, "[Content_Types].xml");
    expect(tipos).toContain('PartName="/xl/comments2.xml"');
    expect(tipos).toContain('Extension="vml"');
  });
});

describe("xlsx.util: nombres y referencias", () => {
  it("numera las columnas más allá de la Z", () => {
    expect(letraColumna(0)).toBe("A");
    expect(letraColumna(25)).toBe("Z");
    expect(letraColumna(26)).toBe("AA");
    expect(letraColumna(27)).toBe("AB");
    expect(letraColumna(51)).toBe("AZ");
    expect(letraColumna(52)).toBe("BA");
  });

  it("recorta y limpia el nombre de hoja en vez de fallar la descarga", () => {
    const zip = armarXlsx([
      { nombre: "Detalle: kardex/tanque [TQ-01] con un nombre larguísimo", filas: [["x"]] },
      { nombre: "   ", filas: [["y"]] },
    ]);
    const workbook = leerEntrada(zip, "xl/workbook.xml");

    // 31 caracteres es el máximo que acepta Excel; los signos prohibidos
    // ([ ] : * ? / \) se reemplazan por espacio, y el recorte no deja
    // espacios colgando al final.
    expect(workbook).toContain('name="Detalle  kardex tanque  TQ-01"');
    expect(workbook).not.toContain("larguísimo");
    // Un nombre que queda vacío después de limpiar igual tiene que existir.
    expect(workbook).toContain('name="Hoja2"');
  });
});
