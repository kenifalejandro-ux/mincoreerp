/**src/modules/combutible/combustible.controller.ts */

import { Request, Response } from "express";
import { withTenant } from "../../server/config/database";
import { getTenantId } from "../../server/shared/utils/request";
import { parsePaginacion, armarRespuestaPaginada } from "../../server/shared/utils/pagination";
import { contextoAuditoriaModulo } from "../../server/shared/utils/moduleAudit";
import {
  registrarAuditoria,
  listarAuditoriaService,
} from "../../server/services/platformAudit.service";
import { publicarEventoTenant } from "../../server/services/realtimeEvents.service";
import { logger } from "../../server/config/logger";
import {
  enviarCorreoAlertaHueco,
  enviarCorreoAlertaAnulacion,
  enviarCorreoAlertaSobredespacho,
  enviarCorreoAlertaMedidor,
  enviarCorreoTotalizador,
  enviarCorreoAlertaNivelBajo,
  enviarCorreoAlertaDescuadre,
  enviarCorreoAlertaDescuadreCiclo,
  enviarCorreoVigilanciaReducida,
  enviarCorreoTopeDiario,
  enviarCorreoAlertaDescuadreVentana,
  enviarCorreoValeRetroactivo,
  enviarCorreoValeRecargado,
  enviarCorreoLecturaRetroactiva,
  enviarCorreoVarillaExacta,
  enviarCorreoRecepcionAnulada,
  enviarCorreoRecepcionDiscrepante,
  enviarCorreoRecepcionRetroactiva,
  enviarCorreoConsumoExcedido,
  enviarCorreoPrecintoAlterado,
  enviarCorreoPrecintoReemplazado,
} from "./combustibleAlertas.mailer";
import type {
  RegistrarLecturaCombustibleInput,
  CrearTanqueCombustibleInput,
  ActualizarTanqueCombustibleInput,
  CargaMasivaTanquesCombustibleInput,
  AnularLecturaCombustibleInput,
  CrearDespachoCombustibleInput,
  CrearGrifoCombustibleInput,
  ActualizarGrifoCombustibleInput,
  CrearPrecioCombustibleInput,
  AnularPrecioCombustibleInput,
  CrearRecepcionCombustibleInput,
  AnularRecepcionCombustibleInput,
  ValidarRecepcionCombustibleInput,
  AnularDespachoCombustibleInput,
  MarcarAlertasLeidasCombustibleInput,
  BajaTanqueCombustibleInput,
  ResolverAlertaCombustibleInput,
  ConfigCombustibleInput,
  KardexCombustibleQuery,
  PeriodoHistorialCombustibleQuery,
  CrearConteoUreaInput,
  AnularConteoUreaInput,
  CrearPuntoPrecintoInput,
  CambiarPrecintoInput,
  BajaPuntoPrecintoInput,
} from "../../server/schemas/combustible.schema";
import { FACTOR_LITROS_UREA } from "../../server/schemas/combustible.schema";
import { armarCsv } from "../../server/shared/utils/csv.util";
import {
  armarXlsx,
  CONTENT_TYPE_XLSX,
  letraColumna,
  type CeldaXlsx,
  type HojaXlsx,
} from "../../server/shared/utils/xlsx.util";
import { sanearNombreArchivo } from "../../server/services/documentStorage";
import { CombustibleService } from "./combustible.service";

const service = new CombustibleService();

// ====================== DETALLE DE CALIBRACIÓN (.xlsx) ======================
//
// Lo que tiene que lograr este archivo, en palabras de Kenif: "que sea lo más
// detallado posible, para que el tenant lo pueda entender". El punto de
// partida fue una etiqueta -- "Sugerencia: 14.5% (27 mediciones, promedio
// 1.93% ± 6.27%)" -- que al desarrollador del sistema le costó varios días de
// preguntas descifrar. Por eso cada hoja:
//
//  1. Desarma CADA fila en su cuenta (nivel anterior − despachos + recepciones
//     = teórico; medido − teórico = diferencia), con fórmulas.
//  2. Explica cada columna en una leyenda, arriba de la tabla.
//  3. Pone al lado de cada resultado qué significa, en palabras.
//  4. Compara el umbral de HOY contra la sugerencia, en tramos concretos: la
//     pregunta que importa no es "cuánto da la fórmula" sino "qué dejaría de
//     alertar si la acepto".
//  5. Termina con un veredicto automático.

type FormatoColumnaCalibracion = "decimal" | "entero" | "texto";

interface ColumnaCalibracion {
  encabezado: string;
  explicacion: string;
  formato: FormatoColumnaCalibracion;
}

/** Una celda de contexto: dato, o fórmula. En las fórmulas, `{n}` es la celda
 *  de la columna de contexto n (1 = la primera) en ESTA fila. Así la cuenta de
 *  cada fila se escribe sin conocer las letras: `{3}-{4}+{5}`. */
type CeldaContexto = string | number | null | { formula: string };

interface FilaCalibracion {
  contexto: CeldaContexto[];
  /** El número que entra en la estadística, o su fórmula (con `{n}`). */
  valor: number | { formula: string };
  observacion?: string;
}

interface OpcionesHojaCalibracion {
  nombre: string;
  titulo: string;
  queEsCadaFila: string;
  /** Qué es cada fila, en plural, para los rótulos del conteo ("tramos",
   *  "ciclos cerrados"): "filas" o "mediciones" a secas no dicen si el mínimo
   *  de 10 se cuenta en tramos o en ciclos, y en la hoja de ciclo se confunde. */
  queCuenta: string;
  cabecera: { codigo: string; nombre: string; capacidad: number; unidad: string };
  umbralHoyPct: string | number | null;
  /** La unidad EN LA QUE SE HACE LA CUENTA: litros/galones, o "%" cuando el
   *  denominador cambia por fila (el umbral de diferencia). */
  unidadValor: string;
  columnas: ColumnaCalibracion[];
  columnaValor: { encabezado: string; explicacion: string };
  filas: FilaCalibracion[];
  etiqueta: EtiquetaPantalla;
}

/** Cómo arma la pantalla la etiqueta de ESTE umbral, para reconstruirla igual.
 *  Cada campo del formulario la escribe a su manera (el de diferencia dice
 *  "recepciones con lectura antes y después", los otros "faltan mediciones"):
 *  una sola fórmula para todas dejaba al archivo diciendo otra cosa que la
 *  pantalla, que es justo lo que el bloque existe para evitar. */
interface EtiquetaPantalla {
  /** Con muestra insuficiente la pantalla escribe `${antes}${n}/${mínimo}${despues}`. */
  faltanAntes: string;
  faltanDespues: string;
  /** Qué cuenta la etiqueta con muestra suficiente: "27 mediciones". */
  contadas: string;
}

/** La etiqueta de descuadre, ciclo y ventana: las tres usan SugerenciaCompacta. */
const ETIQUETA_COMPACTA: EtiquetaPantalla = {
  faltanAntes: "Sugerencia automática: faltan mediciones (",
  faltanDespues: "). Hasta entonces, el valor de arriba es provisional.",
  contadas: "mediciones",
};

const dec = (celda: { valor?: number | string | null; formula?: string }, negrita = false) =>
  ({ ...celda, formato: "decimal", negrita }) as CeldaXlsx;
const ent = (celda: { valor?: number | string | null; formula?: string }, negrita = false) =>
  ({ ...celda, formato: "entero", negrita }) as CeldaXlsx;
const titulo = (texto: string): CeldaXlsx => ({ valor: texto, negrita: true });
/** Un rótulo con su explicación en una NOTA de la celda, no en una columna
 *  al lado: escrita junto a los números la planilla parecía un borrador (lo
 *  pidió Kenif). La nota aparece al pasar el mouse por el rótulo. */
const concepto = (texto: string, nota: string): CeldaXlsx => ({
  valor: texto,
  negrita: true,
  nota,
});

/** Filas fijas de la cabecera: las fórmulas de más abajo apuntan a ellas. */
const FILA_CAPACIDAD = 5;
const FILA_UMBRAL_PCT = 6;
const FILA_UMBRAL_L = 7;

/** Título, tanque, capacidad y umbral de hoy (en % y en la unidad de la
 *  cuenta), más la fila en blanco que la separa de la tabla. */
function cabeceraDeCalibracion(
  o: OpcionesHojaCalibracion,
  notaUmbralEnUnidad: string
): CeldaXlsx[][] {
  const enPorcentaje = o.unidadValor === "%";
  const umbralHoy = o.umbralHoyPct === null ? null : Number(o.umbralHoyPct);
  return [
    [titulo(o.titulo)],
    [o.queEsCadaFila],
    [],
    [titulo("Tanque"), `${o.cabecera.codigo} -- ${o.cabecera.nombre}`],
    [
      concepto(`Capacidad (${o.cabecera.unidad})`, "Cuánto le cabe al tanque."),
      ent({ valor: o.cabecera.capacidad }),
    ],
    [
      concepto(
        "Umbral configurado hoy (%)",
        enPorcentaje
          ? "El que tiene cargado hoy la ficha del tanque. Se mide sobre lo facturado en cada entrega."
          : "El que tiene cargado hoy la ficha del tanque, en porcentaje de la capacidad."
      ),
      // Texto y no 0 cuando no hay umbral: 0 es tolerancia cero de verdad
      // (alerta por cualquier litro), y NULL es "no vigila".
      umbralHoy !== null ? dec({ valor: umbralHoy }) : "sin configurar",
    ],
    [
      concepto(
        `Umbral configurado hoy (${enPorcentaje ? o.cabecera.unidad : o.unidadValor})`,
        notaUmbralEnUnidad
      ),
      enPorcentaje
        ? "no aplica"
        : umbralHoy !== null
          ? dec({ formula: `B${FILA_UMBRAL_PCT}*B${FILA_CAPACIDAD}/100` })
          : "sin configurar",
    ],
    [],
  ];
}

/** Las celdas de una fila de la muestra hasta el valor inclusive: el número de
 *  fila, las columnas de contexto y el valor que entra en la estadística. */
function celdasDeLaMuestra(
  o: OpcionesHojaCalibracion,
  f: FilaCalibracion,
  indice: number,
  fila: number
): CeldaXlsx[] {
  const expandir = (formula: string) =>
    formula.replace(/\{(\d+)\}/g, (_, i: string) => `${letraColumna(Number(i))}${fila}`);

  const celdas: CeldaXlsx[] = [ent({ valor: indice + 1 })];
  f.contexto.forEach((c, j) => {
    const formato = o.columnas[j].formato;
    if (c !== null && typeof c === "object") {
      const conFormula = { formula: expandir(c.formula) };
      celdas.push(formato === "entero" ? ent(conFormula) : dec(conFormula));
    } else if (formato === "texto" || typeof c === "string" || c === null) {
      celdas.push(c);
    } else {
      celdas.push(formato === "entero" ? ent({ valor: c }) : dec({ valor: c }));
    }
  });
  celdas.push(
    typeof f.valor === "number"
      ? dec({ valor: f.valor })
      : dec({ formula: expandir(f.valor.formula) })
  );
  return celdas;
}

/** Aviso para la fila cuyo tramo termina en la lectura `inicial` del alta.
 *  Esa lectura no es una medición de cancha: es el número que se escribió al
 *  registrar el tanque. Si quedó al final de la historia (se cargó historial
 *  con fecha anterior al alta), el tramo contra ella es basura y puede dominar
 *  toda la estadística -- en el tenant redteam aportaba el 82 % de la varianza. */
const OBSERVACION_LECTURA_INICIAL =
  "Lectura inicial del alta del tanque: es el nivel que se escribió al registrarlo, no una " +
  "medición de cancha. Si quedó al final de la historia es porque se cargó historial con fecha " +
  "anterior al alta, y esta fila NO refleja el comportamiento del tanque: conviene eliminarla " +
  "antes de mirar la sugerencia.";

const fechaLima = (d: string | Date) =>
  new Date(d).toLocaleString("es-PE", { timeZone: "America/Lima" });

/** Reproduce EXACTAMENTE `CombustibleService.calibrar`: valor absoluto,
 *  promedio, varianza con n − 1, promedio + 2 desviaciones, piso de 1 % y tope
 *  de 100 %, redondeo a un decimal. Si el archivo diera otro número que la
 *  pantalla, no serviría para explicarla. */
function hojaDeCalibracion(o: OpcionesHojaCalibracion): HojaXlsx {
  const enPorcentaje = o.unidadValor === "%";
  const u = o.unidadValor;
  const k = o.columnas.length;
  const hayUmbral = o.umbralHoyPct !== null;

  // Columnas: A = #, B.. = contexto, y después las fijas.
  const cValor = letraColumna(1 + k);
  const cAbs = letraColumna(2 + k);
  const cCuad = letraColumna(3 + k);

  const filas = cabeceraDeCalibracion(
    o,
    enPorcentaje
      ? "Este umbral no tiene un valor fijo en litros: depende de cuánto se facturó en cada entrega."
      : "El mismo umbral en litros: un tramo que se desajusta más que esto, hoy alerta."
  );

  // ── Encabezados de la tabla, con su explicación en la nota ────────────
  const encabezados: { encabezado: string; explicacion: string }[] = [
    { encabezado: "#", explicacion: "Número de fila." },
    ...o.columnas,
    o.columnaValor,
    {
      encabezado: "Valor absoluto",
      explicacion:
        "La diferencia sin signo. Para medir la precisión, un sobrante de 500 revela lo mismo que un faltante de 500.",
    },
    {
      encabezado: "(absoluto − promedio)²",
      explicacion:
        "Paso intermedio para la desviación: qué tan lejos queda cada fila del promedio, elevado al cuadrado.",
    },
    {
      encabezado: "¿Alerta con el umbral de hoy?",
      explicacion: "SÍ si esa fila supera el umbral configurado hoy.",
    },
    {
      encabezado: "¿Alertaría con la sugerencia?",
      explicacion:
        "SÍ si esa fila supera la sugerencia final. Las que dicen SÍ en la columna anterior y quedan vacías acá son las que dejarían de alertar.",
    },
    { encabezado: "Observación", explicacion: "Avisos sobre filas que merecen atención." },
  ];
  filas.push(encabezados.map((c) => concepto(c.encabezado, c.explicacion)));

  const n = o.filas.length;
  const anchos = [
    46,
    ...o.columnas.map((c) => (c.formato === "texto" ? 22 : 15)),
    16,
    15,
    20,
    16,
    16,
    70,
  ];

  if (n === 0) {
    filas.push([], [`Todavía no hay ${o.queCuenta} para calcular nada.`]);
    return { nombre: o.nombre, filas, anchos };
  }

  const PRIMERA = filas.length + 1;
  const ULTIMA = PRIMERA + n - 1;

  // Filas del bloque de resultados, calculadas de antemano: las columnas de la
  // tabla apuntan a celdas (promedio, sugerencia) que quedan más abajo.
  const R = ULTIMA + 2;
  // R+2, R+3 y R+4 son 'cuadraron', 'fila más grande' y 'mediana': informativas,
  // ninguna fórmula apunta a ellas.
  const FILA_N = R + 1;
  const FILA_PROMEDIO = R + 5;
  const FILA_SUMA = R + 6;
  const FILA_VARIANZA = R + 7;
  const FILA_DESVIACION = R + 8;
  const FILA_SUGERENCIA = R + 9;
  const FILA_SUGERENCIA_PCT = enPorcentaje ? FILA_SUGERENCIA : R + 10;
  const FILA_FINAL_PCT = enPorcentaje ? R + 10 : R + 11;
  const FILA_FINAL_UNIDAD = enPorcentaje ? FILA_FINAL_PCT : R + 12;
  // El mínimo va justo después de la sugerencia final, en los dos modos.
  const FILA_MINIMO = FILA_FINAL_UNIDAD + 1;
  // Contra qué se compara cada fila: en la misma unidad que el valor absoluto.
  const FILA_UMBRAL_COMPARABLE = enPorcentaje ? FILA_UMBRAL_PCT : FILA_UMBRAL_L;

  o.filas.forEach((f, i) => {
    const fila = PRIMERA + i;
    const celdas = celdasDeLaMuestra(o, f, i, fila);

    celdas.push(
      dec({ formula: `ABS(${cValor}${fila})` }),
      dec({ formula: `(${cAbs}${fila}-$B$${FILA_PROMEDIO})^2` }),
      hayUmbral
        ? { formula: `IF(${cAbs}${fila}>$B$${FILA_UMBRAL_COMPARABLE},"SÍ","")` }
        : "sin umbral",
      {
        // Con menos filas que el mínimo el sistema no sugiere nada: decir "SÍ,
        // alertaría" contra un número que la pantalla no muestra confunde.
        formula: `IF($B$${FILA_N}<$B$${FILA_MINIMO},"",IF(${cAbs}${fila}>$B$${FILA_FINAL_UNIDAD},"SÍ",""))`,
      },
      f.observacion ?? null
    );
    filas.push(celdas);
  });

  const rAbs = `${cAbs}${PRIMERA}:${cAbs}${ULTIMA}`;
  const rCuad = `${cCuad}${PRIMERA}:${cCuad}${ULTIMA}`;
  const siHayDos = (formula: string) => `IF($B$${FILA_N}>1,${formula},"")`;
  const B = (fila: number) => `$B$${fila}`;

  // ── Resultados ────────────────────────────────────────────────────────
  filas.push([], [titulo("RESULTADOS")]);
  filas.push(
    [
      concepto(`Cantidad de ${o.queCuenta} (n)`, "Cuántas filas de la tabla entran en el cálculo."),
      ent({ formula: `COUNT(${rAbs})` }),
    ],
    [
      concepto(
        "Filas que cuadraron perfecto (diferencia 0)",
        "Cuántas no tuvieron ninguna diferencia. Si son la mayoría, lo normal del tanque es cuadrar."
      ),
      ent({ formula: `COUNTIF(${rAbs},0)` }),
    ],
    [
      concepto(
        `Fila más grande (${u})`,
        "El desajuste más grande de la lista. Si es muchas veces el promedio, es un caso raro que conviene revisar."
      ),
      dec({ formula: `MAX(${rAbs})` }),
    ],
    [
      concepto(
        `Mediana (${u})`,
        "El valor del medio si ordenás las filas de menor a mayor. Si es muy distinta del promedio, pocas filas grandes lo están inflando."
      ),
      dec({ formula: `MEDIAN(${rAbs})` }),
    ],
    [
      concepto(
        `Promedio por fila (${u})`,
        "Todo el desajuste repartido en partes iguales entre las filas. Ojo: no es lo que pasa en una fila típica, es un reparto."
      ),
      dec({ formula: `AVERAGE(${rAbs})` }, true),
    ],
    [
      concepto(
        "Suma de los cuadrados",
        "Paso intermedio: la suma de la columna '(absoluto − promedio)²'."
      ),
      dec({ formula: `SUM(${rCuad})` }),
    ],
    [
      concepto(
        "Varianza = suma ÷ (n − 1)",
        "Paso intermedio, en unidades al cuadrado: no tiene sentido físico por sí sola."
      ),
      dec({ formula: siHayDos(`${B(FILA_SUMA)}/(${B(FILA_N)}-1)`) }),
    ],
    [
      concepto(
        `Desviación = √varianza (${u})`,
        "Cuánto suele variar el desajuste de una fila a otra. Chica = el tanque se comporta parejo. Mucho mayor que el promedio = hay filas muy distintas del resto."
      ),
      dec({ formula: siHayDos(`SQRT(${B(FILA_VARIANZA)})`) }, true),
    ],
    [
      concepto(
        `Sugerencia = promedio + 2 × desviación (${u})`,
        "Lo normal del tanque más un margen de dos veces lo que suele variar, para que la variación normal no haga sonar la alarma."
      ),
      dec({ formula: siHayDos(`${B(FILA_PROMEDIO)}+2*${B(FILA_DESVIACION)}`) }, true),
    ]
  );
  if (!enPorcentaje) {
    filas.push([
      concepto(
        "Sugerencia en % de la capacidad",
        "La sugerencia de arriba, pasada a porcentaje del tanque."
      ),
      dec({ formula: siHayDos(`${B(FILA_SUGERENCIA)}/${B(FILA_CAPACIDAD)}*100`) }),
    ]);
  }
  filas.push([
    concepto(
      "Sugerencia final (%) -- la que muestra la pantalla",
      "Con piso de 1 % (por debajo alertaría por la dilatación del combustible con el calor) y tope de 100 %, redondeada a un decimal."
    ),
    dec({ formula: siHayDos(`ROUND(MAX(1,MIN(100,${B(FILA_SUGERENCIA_PCT)})),1)`) }, true),
  ]);
  if (!enPorcentaje) {
    filas.push([
      concepto(
        `Sugerencia final (${u})`,
        "La sugerencia final en litros: el umbral que quedaría si aprietan 'Usar este valor'."
      ),
      dec({ formula: siHayDos(`${B(FILA_FINAL_PCT)}*${B(FILA_CAPACIDAD)}/100`) }, true),
    ]);
  }
  filas.push(
    [
      concepto(
        `Mínimo de ${o.queCuenta} para que el sistema sugiera`,
        "Con menos, cualquier número sería inventado, y la pantalla no muestra ninguno."
      ),
      ent({ valor: 10 }),
    ],
    [
      concepto(
        "¿El sistema muestra la sugerencia?",
        "Sí cuando la cantidad de arriba llega al mínimo. Mientras diga No, la pantalla no propone ningún número y el umbral de hoy es provisional."
      ),
      { formula: `IF(${B(FILA_N)}>=${B(FILA_MINIMO)},"Sí","No -- faltan ${o.queCuenta}")` },
    ]
  );

  // ── Cómo lo muestra la pantalla ───────────────────────────────────────
  // La pantalla escribe "promedio 1.93% ± 6.27%" y el bloque de arriba trabaja
  // en litros (385,93 y 1.254,84): sin este puente, quien abre el archivo no
  // puede emparejar la etiqueta con ningún número. Lo marcó Kenif: "en el
  // excel no hay ese dato de ± 6.27 %".
  const P0 = filas.length + 2; // la fila del título queda en P0
  const FILA_PROM_PCT = P0 + 2;
  const FILA_DESV_PCT = P0 + 3;
  const aPct = (fila: number) => (enPorcentaje ? B(fila) : `${B(fila)}/${B(FILA_CAPACIDAD)}*100`);
  filas.push(
    [],
    [titulo("CÓMO LO MUESTRA LA PANTALLA")],
    [
      concepto(
        "La etiqueta, tal cual",
        "El texto exacto que aparece en la ficha del tanque, armado con los números de esta hoja. Sirve para comprobar que la pantalla y el archivo dicen lo mismo."
      ),
      {
        // Primero el mínimo: con menos filas la desviación puede estar vacía y
        // ROUND("") da error.
        formula:
          `IF(${B(FILA_N)}<${B(FILA_MINIMO)},` +
          `"${o.etiqueta.faltanAntes}"&${B(FILA_N)}&"/"&${B(FILA_MINIMO)}&"${o.etiqueta.faltanDespues}",` +
          `"Sugerencia: "&ROUND(${B(FILA_FINAL_PCT)},1)&"% ("&${B(FILA_N)}&" ${o.etiqueta.contadas}, promedio "` +
          `&ROUND(${B(FILA_PROM_PCT)},2)&"% ± "&ROUND(${B(FILA_DESV_PCT)},2)&"%)")`,
      },
    ],
    [
      concepto(
        enPorcentaje ? "Promedio (%)" : "Promedio en % de la capacidad",
        enPorcentaje
          ? "Es el 'promedio' de la etiqueta. En esta hoja la cuenta ya va en porcentaje."
          : "Es el 'promedio' de la etiqueta: el promedio por fila de arriba, dividido por la capacidad del tanque."
      ),
      dec({ formula: siHayDos(aPct(FILA_PROMEDIO)) }),
    ],
    [
      concepto(
        enPorcentaje ? "Desviación (%)" : "Desviación en % de la capacidad",
        (enPorcentaje
          ? "Es el número que la etiqueta pone después del '±'. "
          : "Es el número que la etiqueta pone después del '±': la desviación de arriba, dividida por la capacidad. ") +
          "OJO: el ± NO significa 'más o menos'. Es la desviación, la misma de arriba, escrita en porcentaje."
      ),
      dec({ formula: siHayDos(aPct(FILA_DESVIACION)) }),
    ],
    [
      concepto(
        "Sugerencia final (%)",
        "Es el primer número de la etiqueta, el que aplica el botón 'Usar este valor'. Vacío mientras falten mediciones: la pantalla no muestra ninguno."
      ),
      dec({ formula: `IF(${B(FILA_N)}<${B(FILA_MINIMO)},"",${B(FILA_FINAL_PCT)})` }),
    ]
  );

  // ── Comparación ───────────────────────────────────────────────────────
  if (hayUmbral) {
    const C0 = filas.length + 2; // la fila del título queda en C0
    const FILA_HOY = C0 + 1;
    const FILA_SUG = C0 + 2;
    const FILA_ALERTAN_HOY = C0 + 4;
    const FILA_ALERTARIAN = C0 + 5;
    filas.push(
      [],
      [titulo("COMPARACIÓN: EL UMBRAL DE HOY CONTRA LA SUGERENCIA")],
      [
        concepto(`Umbral de hoy (${u})`, "El que está configurado ahora."),
        dec({ formula: B(FILA_UMBRAL_COMPARABLE) }),
      ],
      [
        concepto(
          `Sugerencia final (${u})`,
          "El que quedaría si se acepta la sugerencia. Vacío mientras haya menos filas que el mínimo: todavía no hay sugerencia que aceptar."
        ),
        dec({ formula: `IF(${B(FILA_N)}<${B(FILA_MINIMO)},"",${B(FILA_FINAL_UNIDAD)})` }),
      ],
      [
        concepto(
          `Diferencia (${u})`,
          "Positiva: la sugerencia es MÁS tolerante que hoy (alerta menos). Negativa: es más estricta."
        ),
        dec({ formula: `IF(${B(FILA_SUG)}="","",${B(FILA_SUG)}-${B(FILA_HOY)})` }),
      ],
      [
        concepto(
          "Filas de esta lista que alertan con el umbral de hoy",
          "Cuántas superan el umbral configurado ahora."
        ),
        ent({ formula: `COUNTIF(${rAbs},">"&${B(FILA_HOY)})` }),
      ],
      [
        concepto(
          "Filas que alertarían con la sugerencia",
          "Cuántas superarían el umbral sugerido."
        ),
        ent({ formula: `IF(${B(FILA_SUG)}="","",COUNTIF(${rAbs},">"&${B(FILA_SUG)}))` }),
      ],
      [
        concepto(
          "Filas que DEJARÍAN de alertar si se acepta la sugerencia",
          "Buscalas en la tabla: SÍ en '¿Alerta con el umbral de hoy?' y vacío en '¿Alertaría con la sugerencia?'. Si alguna fue un faltante real, aceptar la sugerencia lo haría invisible."
        ),
        ent(
          {
            formula: `IF(${B(FILA_ALERTARIAN)}="","",${B(FILA_ALERTAN_HOY)}-${B(FILA_ALERTARIAN)})`,
          },
          true
        ),
      ]
    );
  }

  // ── Lectura rápida ────────────────────────────────────────────────────
  filas.push(
    [],
    [titulo("LECTURA RÁPIDA")],
    [
      concepto(
        "Desviación ÷ promedio",
        "Cuántas veces la variación supera al desajuste promedio. Hasta 1: filas parejas. Más de 2: hay filas muy distintas del resto que inflan la sugerencia."
      ),
      dec({
        formula: `IF(AND(${B(FILA_N)}>1,${B(FILA_PROMEDIO)}>0),${B(FILA_DESVIACION)}/${B(FILA_PROMEDIO)},"")`,
      }),
    ],
    [
      concepto(
        "Veredicto",
        "Una conclusión en una línea: si hay filas suficientes, y si la muestra es pareja o tiene casos raros que conviene revisar antes de aceptar la sugerencia."
      ),
      {
        // Primero el mínimo: con menos de 10 filas la desviación puede estar
        // vacía, y en Excel un texto vacío comparado contra un número da
        // VERDADERO -- el veredicto diría CUIDADO sin motivo.
        formula:
          `IF(${B(FILA_N)}<${B(FILA_MINIMO)},` +
          `"Todavía no hay filas suficientes: el sistema no sugiere nada y el umbral de hoy sigue siendo provisional.",` +
          `IF(AND(${B(FILA_PROMEDIO)}>0,${B(FILA_DESVIACION)}>2*${B(FILA_PROMEDIO)}),` +
          `"CUIDADO: hay filas muy distintas del resto (ver 'Fila más grande'). Revisalas antes de aceptar la sugerencia: si alguna fue un robo o un error de carga, la sugerencia lo estaría tolerando.",` +
          `"La muestra es pareja: la sugerencia refleja el comportamiento normal del tanque."))`,
        negrita: true,
      },
    ]
  );

  return { nombre: o.nombre, filas, anchos };
}

/** La hoja de la VENTANA. Aparte de `hojaDeCalibracion` porque la cuenta es
 *  otra (ver `CombustibleService.calibrarConSigno`): la diferencia va CON
 *  SIGNO, la sugerencia es 2 desviaciones sin sumar el promedio, y no hay
 *  columnas de "¿alerta esta fila?" -- la alerta de ventana mira una SUMA de
 *  tramos, no un tramo suelto, así que comparar cada fila contra el umbral
 *  diría algo que el sistema no hace.
 *
 *  Reproduce EXACTAMENTE el estadístico del servicio: si el archivo diera otro
 *  número que la pantalla, no serviría para explicarla. */
function hojaDeCalibracionVentana(o: OpcionesHojaCalibracion): HojaXlsx {
  const u = o.unidadValor;
  const cValor = letraColumna(1 + o.columnas.length);
  const cCuad = letraColumna(2 + o.columnas.length);
  const hayUmbral = o.umbralHoyPct !== null;

  const filas = cabeceraDeCalibracion(
    o,
    "El mismo umbral en litros: si la suma CON SIGNO de los tramos de la ventana se aleja más que esto de cero, hoy alerta."
  );

  filas.push(
    [
      { encabezado: "#", explicacion: "Número de fila." },
      ...o.columnas,
      o.columnaValor,
      {
        encabezado: "(diferencia − promedio)²",
        explicacion:
          "Paso intermedio para la desviación: qué tan lejos queda cada fila del promedio CON SIGNO, elevado al cuadrado.",
      },
      { encabezado: "Observación", explicacion: "Avisos sobre filas que merecen atención." },
    ].map((c) => concepto(c.encabezado, c.explicacion))
  );

  const n = o.filas.length;
  const anchos = [46, ...o.columnas.map((c) => (c.formato === "texto" ? 22 : 15)), 16, 22, 70];

  if (n === 0) {
    filas.push([], [`Todavía no hay ${o.queCuenta} para calcular nada.`]);
    return { nombre: o.nombre, filas, anchos };
  }

  const PRIMERA = filas.length + 1;
  const ULTIMA = PRIMERA + n - 1;
  const rValor = `${cValor}${PRIMERA}:${cValor}${ULTIMA}`;
  const rCuad = `${cCuad}${PRIMERA}:${cCuad}${ULTIMA}`;

  // Filas del bloque de resultados, calculadas de antemano: la columna de
  // cuadrados apunta al promedio, que queda más abajo.
  const R = ULTIMA + 2;
  const FILA_N = R + 1;
  const FILA_PROMEDIO = R + 4;
  const FILA_SUMA = R + 5;
  const FILA_VARIANZA = R + 6;
  const FILA_DESVIACION = R + 7;
  const FILA_SUGERENCIA = R + 8;
  const FILA_SUGERENCIA_PCT = R + 9;
  const FILA_FINAL_PCT = R + 10;
  const FILA_FINAL_UNIDAD = R + 11;
  const FILA_MINIMO = R + 12;

  const B = (fila: number) => `$B$${fila}`;
  const siHayDos = (formula: string) => `IF(${B(FILA_N)}>1,${formula},"")`;

  o.filas.forEach((f, i) => {
    const fila = PRIMERA + i;
    filas.push([
      ...celdasDeLaMuestra(o, f, i, fila),
      dec({ formula: `(${cValor}${fila}-${B(FILA_PROMEDIO)})^2` }),
      f.observacion ?? null,
    ]);
  });

  // ── Resultados ────────────────────────────────────────────────────────
  filas.push(
    [],
    [titulo("RESULTADOS")],
    [
      concepto(`Cantidad de ${o.queCuenta} (n)`, "Cuántas filas de la tabla entran en el cálculo."),
      ent({ formula: `COUNT(${rValor})` }),
    ],
    [
      concepto(
        "Filas que cuadraron perfecto (diferencia 0)",
        "Cuántas no tuvieron ninguna diferencia. Si son la mayoría, lo normal del tanque es cuadrar."
      ),
      ent({ formula: `COUNTIF(${rValor},0)` }),
    ],
    [
      concepto(
        `Suma con signo de toda la muestra (${u})`,
        "Faltantes y sobrantes se descuentan entre sí. NO es lo que mira la alerta: la alerta suma solo los tramos de su ventana de días, y esta tabla puede traer más historia."
      ),
      dec({ formula: `SUM(${rValor})` }),
    ],
    [
      concepto(
        `Promedio con signo por tramo (${u})`,
        "La tendencia: cerca de 0 = la varilla se equivoca para los dos lados, que es ruido. Lejos de 0 = falta (o sobra) siempre para el mismo lado, y eso NO es ruido. No entra en la sugerencia: si entrara, un robo sistemático subiría el umbral y se volvería invisible."
      ),
      dec({ formula: `AVERAGE(${rValor})` }, true),
    ],
    [
      concepto(
        "Suma de los cuadrados",
        "Paso intermedio: la suma de la columna '(diferencia − promedio)²'."
      ),
      dec({ formula: `SUM(${rCuad})` }),
    ],
    [
      concepto(
        "Varianza = suma ÷ (n − 1)",
        "Paso intermedio, en unidades al cuadrado: no tiene sentido físico por sí sola."
      ),
      dec({ formula: siHayDos(`${B(FILA_SUMA)}/(${B(FILA_N)}-1)`) }),
    ],
    [
      concepto(
        `Desviación = √varianza (${u})`,
        "Cuánto se mueve la diferencia de un tramo a otro alrededor de su tendencia: el ruido de la varilla. Es también el ruido de la ventana entera, porque el error de cada varilla se cancela con el tramo siguiente (ver 'Cómo leerlo')."
      ),
      dec({ formula: siHayDos(`SQRT(${B(FILA_VARIANZA)})`) }, true),
    ],
    [
      concepto(
        `Sugerencia = 2 × desviación (${u})`,
        "Dos veces el ruido, para que la variación normal no haga sonar la alarma. Sin sumar el promedio y sin multiplicar por la cantidad de tramos: las dos cosas inflarían el umbral por encima del ruido real."
      ),
      dec({ formula: siHayDos(`2*${B(FILA_DESVIACION)}`) }, true),
    ],
    [
      concepto(
        "Sugerencia en % de la capacidad",
        "La sugerencia de arriba, pasada a porcentaje del tanque."
      ),
      dec({ formula: siHayDos(`${B(FILA_SUGERENCIA)}/${B(FILA_CAPACIDAD)}*100`) }),
    ],
    [
      concepto(
        "Sugerencia final (%) -- la que muestra la pantalla",
        "Con piso de 1 % (por debajo alertaría por la dilatación del combustible con el calor y por el error acumulado del contómetro) y tope de 100 %, redondeada a un decimal."
      ),
      dec({ formula: siHayDos(`ROUND(MAX(1,MIN(100,${B(FILA_SUGERENCIA_PCT)})),1)`) }, true),
    ],
    [
      concepto(
        `Sugerencia final (${u})`,
        "La sugerencia final en litros: el umbral que quedaría si aprietan 'Usar este valor'."
      ),
      dec({ formula: siHayDos(`${B(FILA_FINAL_PCT)}*${B(FILA_CAPACIDAD)}/100`) }, true),
    ],
    [
      concepto(
        `Mínimo de ${o.queCuenta} para que el sistema sugiera`,
        "Con menos, cualquier número sería inventado, y la pantalla no muestra ninguno."
      ),
      ent({ valor: 10 }),
    ],
    [
      concepto(
        "¿El sistema muestra la sugerencia?",
        "Sí cuando la cantidad de arriba llega al mínimo. Mientras diga No, la pantalla no propone ningún número y el umbral de hoy es provisional."
      ),
      { formula: `IF(${B(FILA_N)}>=${B(FILA_MINIMO)},"Sí","No -- faltan ${o.queCuenta}")` },
    ]
  );

  // ── Cómo lo muestra la pantalla ───────────────────────────────────────
  const FILA_DESV_PCT = filas.length + 4; // título, etiqueta, y esta
  filas.push(
    [],
    [titulo("CÓMO LO MUESTRA LA PANTALLA")],
    [
      concepto(
        "La etiqueta, tal cual",
        "El texto exacto que aparece en la ficha del tanque, armado con los números de esta hoja. Sirve para comprobar que la pantalla y el archivo dicen lo mismo."
      ),
      {
        // Primero el mínimo: con menos filas la desviación puede estar vacía y
        // ROUND("") da error.
        formula:
          `IF(${B(FILA_N)}<${B(FILA_MINIMO)},` +
          `"${o.etiqueta.faltanAntes}"&${B(FILA_N)}&"/"&${B(FILA_MINIMO)}&"${o.etiqueta.faltanDespues}",` +
          `"Sugerencia: "&ROUND(${B(FILA_FINAL_PCT)},1)&"% ("&${B(FILA_N)}&" ${o.etiqueta.contadas}, desviación "` +
          `&ROUND(${B(FILA_DESV_PCT)},2)&"%)")`,
      },
    ],
    [
      concepto(
        "Desviación en % de la capacidad",
        "Es el número que la etiqueta pone después de 'desviación': la desviación de arriba, dividida por la capacidad."
      ),
      dec({ formula: siHayDos(`${B(FILA_DESVIACION)}/${B(FILA_CAPACIDAD)}*100`) }),
    ],
    [
      concepto(
        "Sugerencia final (%)",
        "Es el primer número de la etiqueta, el que aplica el botón 'Usar este valor'. Vacío mientras falten mediciones: la pantalla no muestra ninguno."
      ),
      dec({ formula: `IF(${B(FILA_N)}<${B(FILA_MINIMO)},"",${B(FILA_FINAL_PCT)})` }),
    ]
  );

  // ── Comparación ───────────────────────────────────────────────────────
  // Sin conteo de filas que alertan: la ventana no compara tramos sueltos.
  if (hayUmbral) {
    const FILA_HOY = filas.length + 3;
    const FILA_SUG = FILA_HOY + 1;
    filas.push(
      [],
      [titulo("COMPARACIÓN: EL UMBRAL DE HOY CONTRA LA SUGERENCIA")],
      [
        concepto(`Umbral de hoy (${u})`, "El que está configurado ahora."),
        dec({ formula: B(FILA_UMBRAL_L) }),
      ],
      [
        concepto(
          `Sugerencia final (${u})`,
          "El que quedaría si se acepta la sugerencia. Vacío mientras haya menos filas que el mínimo: todavía no hay sugerencia que aceptar."
        ),
        dec({ formula: `IF(${B(FILA_N)}<${B(FILA_MINIMO)},"",${B(FILA_FINAL_UNIDAD)})` }),
      ],
      [
        concepto(
          `Diferencia (${u})`,
          "Positiva: la sugerencia es MÁS tolerante que hoy (alerta menos). Negativa: es más estricta."
        ),
        dec({ formula: `IF(${B(FILA_SUG)}="","",${B(FILA_SUG)}-${B(FILA_HOY)})` }),
      ]
    );
  }

  // ── Lectura rápida ────────────────────────────────────────────────────
  filas.push(
    [],
    [titulo("LECTURA RÁPIDA")],
    [
      concepto(
        "Veredicto",
        "Una conclusión en una línea: si hay filas suficientes, y si alguna fila queda tan lejos del resto que infla la desviación."
      ),
      {
        // Primero el mínimo, por lo mismo que en las otras hojas. "Muy lejos" =
        // a más de 3 desviaciones del promedio, para arriba o para abajo: con
        // una lectura inicial mal fechada adentro, la desviación sale inflada y
        // la sugerencia con ella.
        formula:
          `IF(${B(FILA_N)}<${B(FILA_MINIMO)},` +
          `"Todavía no hay filas suficientes: el sistema no sugiere nada y el umbral de hoy sigue siendo provisional.",` +
          `IF(OR(MAX(${rValor})-${B(FILA_PROMEDIO)}>3*${B(FILA_DESVIACION)},${B(FILA_PROMEDIO)}-MIN(${rValor})>3*${B(FILA_DESVIACION)}),` +
          `"CUIDADO: hay filas muy lejos del resto. Revisalas antes de aceptar la sugerencia (por ejemplo la lectura inicial del alta): una sola fila así infla la desviación, y con ella el umbral.",` +
          `"La muestra es pareja: la sugerencia refleja el ruido normal de la varilla de este tanque."))`,
        negrita: true,
      },
    ]
  );

  return { nombre: o.nombre, filas, anchos };
}

/** La explicación en palabras, dentro del mismo archivo. Existe porque la
 *  etiqueta de la pantalla le costó días de preguntas al desarrollador del
 *  sistema: si a él no le alcanzó, al administrador de la mina tampoco. */
const HOJA_COMO_LEERLO: HojaXlsx = {
  nombre: "Cómo leerlo",
  anchos: [34, 110],
  filas: [
    [{ valor: "Cómo leer este archivo", negrita: true }],
    [],
    [
      { valor: "Qué es la sugerencia", negrita: true },
      "El sistema mira cuánto se desajustó este tanque en el pasado y propone un umbral un poco por encima de lo normal, para no alertar por el error propio de la varilla.",
    ],
    [
      null,
      "No sale del consumo: sale de las DIFERENCIAS entre lo que midió la varilla y lo que explican los vales y las recepciones.",
    ],
    [],
    [{ valor: "QUÉ HAY EN CADA HOJA", negrita: true }],
    [
      { valor: "Diferencia en recepción", negrita: true },
      "Cada fila es una entrega de combustible: lo facturado contra lo que subió la varilla.",
    ],
    [
      { valor: "Descuadre por tramo", negrita: true },
      "Cada fila es un tramo: el espacio entre dos varillas seguidas, con los vales y recepciones del medio. 28 varillas dan 27 tramos.",
    ],
    [
      { valor: "Ciclo", negrita: true },
      "Cada fila es un ciclo: desde una recepción hasta la siguiente. Suma las diferencias de todos sus tramos.",
    ],
    [
      { valor: "Ventana", negrita: true },
      "Los mismos tramos que 'Descuadre por tramo', con otra cuenta: la diferencia CON SIGNO y la sugerencia de 2 desviaciones, sin sumar el promedio. Ver 'LA VENTANA, EN PALABRAS' más abajo.",
    ],
    [],
    [{ valor: "LA VENTANA, EN PALABRAS", negrita: true }],
    [
      { valor: "Con signo", negrita: true },
      "La alerta suma los tramos respetando el + y el −: un faltante y un sobrante se descuentan. Por eso esa hoja no tiene la columna 'Valor absoluto'.",
    ],
    [
      { valor: "Por qué no crece con los tramos", negrita: true },
      "Cada tramo arranca en la varilla donde terminó el anterior. Si una varilla marca 100 de más, el tramo que termina en ella da +100 y el siguiente −100: se cancelan. La suma de 60 tramos arrastra el error de dos varillas, igual que un tramo solo.",
    ],
    [
      { valor: "Por qué no suma el promedio", negrita: true },
      "Un robo que se lleva siempre lo mismo corre el promedio para el lado negativo, pero no agranda la desviación. Si el promedio entrara en la sugerencia, ese robo subiría el umbral y se volvería invisible.",
    ],
    [
      { valor: "Lo que no cubre", negrita: true },
      "El error del contómetro, que sí se acumula con cada despacho. Lo cubre el piso de 1 % hasta conocer la tolerancia real del medidor.",
    ],
    [],
    [{ valor: "LOS NÚMEROS, EN PALABRAS", negrita: true }],
    [
      { valor: "Promedio", negrita: true },
      "Todo el desajuste repartido en partes iguales. Ejemplo: 10.420 L en 27 tramos = 386 L por tramo. Ningún tramo tiene por qué haber dado 386: es un reparto.",
    ],
    [
      { valor: "Mediana", negrita: true },
      "El tramo del medio al ordenarlos. Si la mayoría dio 0, la mediana es 0 aunque el promedio dé 386: eso significa que pocos tramos grandes inflan el promedio.",
    ],
    [
      { valor: "Desviación", negrita: true },
      "Cuánto suele variar el desajuste de un tramo a otro. Si todos los tramos dieran lo mismo, sería 0. La pantalla la muestra en porcentaje después de un '±' (por ejemplo '± 6.27%'): ese ± NO significa 'más o menos', es la desviación.",
    ],
    [
      { valor: "Sugerencia", negrita: true },
      "Promedio + 2 desviaciones: lo normal del tanque más un margen, para que la variación normal no alerte.",
    ],
    [],
    [
      { valor: "LA ADVERTENCIA", negrita: true },
      "La sugerencia aprende de la historia del tanque. Si en esa historia hubo un robo o un error de carga, la fórmula lo toma como normal y PROPONE TOLERARLO.",
    ],
    [],
    [{ valor: "CÓMO REVISARLO", negrita: true }],
    [
      { valor: "1", negrita: true },
      "Mirá el bloque LECTURA RÁPIDA al final de la hoja: el veredicto te dice si la muestra es pareja o tiene casos raros.",
    ],
    [
      { valor: "2", negrita: true },
      "Mirá 'Filas que DEJARÍAN de alertar si se acepta la sugerencia'. Si es más de 0, buscá cuáles son en la tabla antes de aceptar nada.",
    ],
    [
      { valor: "3", negrita: true },
      "Ordená la tabla por 'Valor absoluto', de mayor a menor. Si los primeros uno o dos son mucho más grandes que el resto, son episodios, no el comportamiento del tanque.",
    ],
    [
      { valor: "4", negrita: true },
      "Para ver la sugerencia sin esos casos: ELIMINÁ LA FILA ENTERA (clic derecho sobre el número de fila, a la izquierda -> Eliminar filas). Las fórmulas se recalculan solas.",
    ],
    [
      null,
      "NO borres solo el valor de la celda: una celda vacía cuenta como un tramo que cuadró perfecto, y el resultado queda mal (la cantidad de filas no baja).",
    ],
    [],
    [{ valor: "SEÑALES RÁPIDAS", negrita: true }],
    [
      { valor: "Promedio contra mediana", negrita: true },
      "Si el promedio es mucho mayor que la mediana, hay pocos casos grandes arrastrando todo para arriba.",
    ],
    [
      { valor: "Desviación contra promedio", negrita: true },
      "Si la desviación es más del doble del promedio, la muestra tiene casos raros. No aceptes la sugerencia sin mirar la tabla.",
    ],
    [
      { valor: "Lectura inicial del alta", negrita: true },
      "Si una fila dice en Observación que es la lectura inicial del alta, no es una medición de cancha: es el nivel que se escribió al registrar el tanque. Conviene eliminarla antes de calibrar.",
    ],
  ],
};

export class CombustibleController {
  async getAll(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const data = await withTenant(tenantId, (client) => service.getAll(client, tenantId));
      res.json(data);
    } catch {
      res.status(500).json({ error: "Error al obtener combustible" });
    }
  }

  async getById(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);
      const data = await withTenant(tenantId, (client) => service.getById(client, tenantId, id));

      if (!data) {
        return res.status(404).json({ error: "No encontrado" });
      }

      res.json(data);
    } catch {
      res.status(500).json({ error: "Error al obtener combustible" });
    }
  }

  async create(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const data = req.validatedBody as CrearTanqueCombustibleInput;
      const nuevo = await withTenant(tenantId, (client) => service.create(client, tenantId, data));
      await registrarAuditoria({
        accion: "combustible.tanque_crear",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: {
          combustibleId: nuevo.id,
          codigo: nuevo.codigo,
          // Cómo se decidió vigilarlo, y con qué números quedó. Sin esto, un
          // tanque que nace ciego es indistinguible en el log de uno bien
          // configurado -- y "nadie lo vigilaba" es justo lo que hay que
          // poder responder después.
          modoVigilancia: data.modo_vigilancia ?? null,
          umbrales: {
            descuadre: data.umbral_descuadre_pct,
            ciclo: data.umbral_descuadre_ciclo_pct,
            diferencia: data.umbral_diferencia_pct,
            ventana: data.umbral_descuadre_ventana_pct,
          },
        },
        contexto: contextoAuditoriaModulo(req),
      });

      // UN TANQUE QUE NACE CIEGO AVISA, igual que aflojar uno existente.
      //
      // La tercera auditoría encontró la asimetría: bajar un umbral de un
      // tanque vigilado exige motivo y despierta a todos los admins por
      // correo, pero dar de alta un tanque nuevo SIN NINGÚN umbral --que deja
      // exactamente el mismo agujero, y es más fácil-- solo quedaba en un
      // log. Se comprobó en la simulación: se despacharon 5.000 L de un
      // tanque nuevo cuya varilla decía que faltaban 10.000, y no saltó nada.
      //
      // No se bloquea el alta: "sin vigilar por ahora" es una decisión
      // legítima (un tanque recién instalado todavía no tiene historial con
      // el que calibrar los umbrales). Lo que no puede ser es silenciosa.
      const sinVigilancia =
        data.umbral_descuadre_pct === null &&
        data.umbral_descuadre_ciclo_pct === null &&
        data.umbral_descuadre_ventana_pct === null;

      if (sinVigilancia) {
        try {
          const admins = await withTenant(tenantId, (client) =>
            service.findAdminsConCombustibleHabilitado(client, tenantId)
          );
          await enviarCorreoVigilanciaReducida(admins, {
            quien: req.usuario!.nombre ?? req.usuario!.email ?? "Un administrador",
            objeto: `el tanque nuevo ${nuevo.codigo} — ${nuevo.tanque_nombre}`,
            motivo: `Se dio de alta con la vigilancia en "${data.modo_vigilancia ?? "sin definir"}"`,
            cambios: [
              {
                control: "Umbrales de descuadre (tramo, ciclo y ventana)",
                de: "—",
                a: "sin configurar (no alerta)",
              },
            ],
          });
        } catch (err) {
          logger.warn(
            { err, tenantId, combustibleId: nuevo.id },
            "No se pudo avisar del alta de un tanque sin vigilancia"
          );
        }
      }

      await publicarEventoTenant(tenantId, "combustible.tanque_creado", {
        combustibleId: nuevo.id,
      });
      res.status(201).json(nuevo);
    } catch (err) {
      if (err instanceof Error && err.message.includes("supera la capacidad del tanque")) {
        res.status(400).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: "Error al crear el tanque" });
    }
  }

  async update(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);
      const data = req.validatedBody as ActualizarTanqueCombustibleInput;

      // El estado ANTES del cambio, para saber si este PUT afloja alguna
      // vigilancia. Se lee en su propia transacción y no dentro del update
      // porque el resultado decide si el update llega a ocurrir.
      const antes = await withTenant(tenantId, (client) => service.getById(client, tenantId, id));
      if (!antes) {
        return res.status(404).json({ error: "No encontrado" });
      }

      // El tipo de combustible solo escala si el tanque YA tiene historial
      // (en uno recién creado, cambiarlo es terminar de darlo de alta).
      const conHistorial = await withTenant(tenantId, (client) =>
        service.tieneMovimientos(client, tenantId, id)
      );
      const aflojados = service.evaluarAflojamiento(antes, data, conHistorial);
      if (aflojados.length > 0 && !data.motivo_ajuste) {
        // 400 y no un guardado silencioso: aflojar un control anti-fraude es
        // una acción correctiva, y el módulo ya exige motivo para las otras
        // (anular una lectura, anular un vale). El mensaje enumera QUÉ se
        // está aflojando para que quien lo lea sepa a qué está diciendo que
        // sí -- puede estar tocando un umbral sin haberse dado cuenta.
        const detalle = aflojados.map((c) => `${c.control}: ${c.de} → ${c.a}`).join("; ");
        return res.status(400).json({
          error:
            `Este cambio reduce la vigilancia del tanque (${detalle}). ` +
            `Indicá el motivo para dejarlo registrado.`,
          requiere_motivo: true,
          aflojados,
        });
      }

      const cambios = service.diffFicha(antes, data);

      const actualizado = await withTenant(tenantId, async (client) => {
        const fila = await service.update(client, tenantId, id, data);
        // Si este PUT configuró algún umbral de descuadre, el tanque dejó de
        // estar ciego: la alerta que lo reportaba se cierra sola, igual que
        // "sin medir" cuando llega una lectura. El problema dejó de existir,
        // no lo revisó nadie.
        if (
          data.umbral_descuadre_pct !== null ||
          data.umbral_descuadre_ciclo_pct !== null ||
          data.umbral_descuadre_ventana_pct !== null
        ) {
          await service.resolverSinVigilanciaSiExiste(client, tenantId, id);
        }
        return fila;
      });

      if (!actualizado) {
        return res.status(404).json({ error: "No encontrado" });
      }

      await registrarAuditoria({
        accion:
          aflojados.length > 0
            ? "combustible.tanque_vigilancia_reducida"
            : "combustible.tanque_actualizar",
        tenantId,
        usuarioId: req.usuario!.id,
        // Cuando se afloja, el detalle lleva QUÉ cambió y POR QUÉ. Una acción
        // distinta (`tanque_vigilancia_reducida`) además la hace filtrable:
        // buscar quién apagó un control ya no obliga a leer todos los
        // cambios de tanque uno por uno.
        // `cambios` va SIEMPRE: todo campo que se movió, con su valor viejo
        // y nuevo. Antes una edición no clasificada como aflojamiento dejaba
        // solo `{ combustibleId }` -- y las tres auditorías adversarias
        // encontraron huecos exactamente ahí. La visibilidad es automática;
        // lo que escala (motivo + correo) sigue siendo una lista declarada.
        detalle:
          aflojados.length > 0
            ? { combustibleId: id, cambios, aflojados, motivo: data.motivo_ajuste }
            : { combustibleId: id, cambios },
        contexto: contextoAuditoriaModulo(req),
      });
      if (aflojados.length > 0) {
        // Nunca bloquea la respuesta: el cambio ya está guardado y auditado.
        // Que falle el SMTP no puede deshacer eso ni devolverle un error al
        // admin por algo que sí se aplicó.
        try {
          const admins = await withTenant(tenantId, (client) =>
            service.findAdminsConCombustibleHabilitado(client, tenantId)
          );
          await enviarCorreoVigilanciaReducida(admins, {
            quien: req.usuario!.nombre ?? req.usuario!.email ?? "Un administrador",
            objeto: `${actualizado.codigo} — ${actualizado.tanque_nombre}`,
            motivo: data.motivo_ajuste ?? "",
            cambios: aflojados,
          });
        } catch (err) {
          logger.warn({ err, tenantId, combustibleId: id }, "No se pudo avisar del aflojamiento");
        }
      }

      await publicarEventoTenant(tenantId, "combustible.tanque_actualizado", {
        combustibleId: id,
      });
      res.json(actualizado);
    } catch (err) {
      if (
        err instanceof Error &&
        (err.message.includes("supera la capacidad que estás por guardar") ||
          err.message.includes("no se puede cambiar la unidad"))
      ) {
        res.status(400).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: "Error al actualizar el tanque" });
    }
  }

  /** Soft-delete exclusivamente -- ver CombustibleRepository.softDelete: un
   *  DELETE real borraría en cascada el historial de combustible_lecturas. */
  async delete(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);
      const { motivo } = req.validatedBody as BajaTanqueCombustibleInput;

      const desactivado = await withTenant(tenantId, (client) =>
        service.softDelete(client, tenantId, id)
      );

      if (!desactivado) {
        return res.status(404).json({ error: "No encontrado" });
      }

      // Dar de baja un tanque APAGA su vigilancia: sale de la alerta de "sin
      // medir" y deja de balancearse. Por eso va con la misma acción de
      // auditoría que aflojar un umbral y con el mismo correo -- pedía menos
      // que subir un porcentaje, que era exactamente al revés.
      await registrarAuditoria({
        accion: "combustible.tanque_vigilancia_reducida",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: {
          combustibleId: id,
          aflojados: [
            { control: "Tanque dado de baja", de: "activo", a: "desactivado (no se vigila)" },
          ],
          motivo,
        },
        contexto: contextoAuditoriaModulo(req),
      });
      try {
        const admins = await withTenant(tenantId, (client) =>
          service.findAdminsConCombustibleHabilitado(client, tenantId)
        );
        await enviarCorreoVigilanciaReducida(admins, {
          quien: req.usuario!.nombre ?? req.usuario!.email ?? "Un administrador",
          objeto: `${desactivado.codigo} — ${desactivado.tanque_nombre}`,
          motivo,
          cambios: [
            { control: "Tanque dado de baja", de: "activo", a: "desactivado (no se vigila)" },
          ],
        });
      } catch (err) {
        logger.warn({ err, tenantId, combustibleId: id }, "No se pudo avisar de la baja");
      }
      await publicarEventoTenant(tenantId, "combustible.tanque_eliminado", {
        combustibleId: id,
      });
      res.json({ message: "Tanque desactivado" });
    } catch {
      res.status(500).json({ error: "Error al desactivar el tanque" });
    }
  }

  async bulk(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const rows = req.validatedBody as CargaMasivaTanquesCombustibleInput;
      const { creados, omitidos } = await withTenant(tenantId, (client) =>
        service.createBulk(client, tenantId, rows)
      );
      // La carga masiva es la puerta de atrás del alta: el formulario obliga
      // a elegir cómo se vigila el tanque, pero una planilla sin esas
      // columnas entra igual y deja los umbrales en NULL. No se bloquea --
      // pedir tres porcentajes por fila en un Excel garantiza que se llenen
      // con cualquier cosa -- pero SÍ se cuenta y se devuelve, para que el
      // cliente lo diga en pantalla y quede en la auditoría.
      //
      // Los TRES de descuadre, que son los que dejan el tanque ciego.
      // `umbral_diferencia_pct` no cuenta: vigila la factura del proveedor,
      // no el faltante (mismo criterio que la alerta de 0082). Antes miraba
      // ese en lugar del de la ventana y contaba mal.
      const sinVigilancia = rows.filter(
        (f) =>
          !omitidos.includes(f.codigo) &&
          f.umbral_descuadre_pct === null &&
          f.umbral_descuadre_ciclo_pct === null &&
          f.umbral_descuadre_ventana_pct === null
      ).length;

      // UNA fila de auditoría con el conteo, no una por tanque -- mismo
      // criterio que repuestos.carga_masiva (RepuestosController.bulk).
      await registrarAuditoria({
        accion: "combustible.tanques_carga_masiva",
        tenantId,
        usuarioId: req.usuario!.id,
        // Los omitidos van con nombre y apellido: "la planilla no cambió el
        // tanque TQ-01" es exactamente lo que alguien va a preguntar cuando
        // vea que su corrección no se aplicó.
        detalle: { cantidad: creados.length, sinVigilancia, omitidos },
        contexto: contextoAuditoriaModulo(req),
      });

      // Un tanque que nace ciego avisa, igual que por el formulario (#156):
      // entrar por Excel no puede ser la forma de esquivar el aviso.
      if (sinVigilancia > 0) {
        try {
          const admins = await withTenant(tenantId, (client) =>
            service.findAdminsConCombustibleHabilitado(client, tenantId)
          );
          await enviarCorreoVigilanciaReducida(admins, {
            quien: req.usuario!.nombre ?? req.usuario!.email ?? "Un administrador",
            objeto: `${sinVigilancia} tanque(s) importados por planilla`,
            motivo: "Se importaron sin ningún umbral de descuadre configurado",
            cambios: [
              {
                control: "Umbrales de descuadre (tramo, ciclo y ventana)",
                de: "—",
                a: "sin configurar (no alerta)",
              },
            ],
          });
        } catch (err) {
          logger.warn(
            { err, tenantId },
            "No se pudo avisar de los tanques importados sin vigilancia"
          );
        }
      }

      await publicarEventoTenant(tenantId, "combustible.tanques_carga_masiva", {
        cantidad: creados.length,
      });
      res.status(201).json({
        insertados: creados.length,
        sinVigilancia,
        // Lo que la planilla NO tocó, y por qué. La carga masiva da de alta;
        // editar un tanque existente pasa por su ficha, que compara los
        // valores, pide motivo si el cambio afloja un control y avisa.
        omitidos,
        data: creados,
      });
    } catch (err) {
      if (err instanceof Error && err.message.includes("supera la capacidad")) {
        res.status(400).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: "Error en importación masiva" });
    }
  }

  /** GET /:id/lecturas -- el histórico de aforos del tanque, que hasta acá
   *  era dato muerto (se guardaba en cada lectura pero no había forma de
   *  consultarlo salvo entrar a la base directo). Acepta período opcional
   *  (`?desde=&hasta=`), igual que los otros dos historiales. */
  async getLecturas(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);

      const tanque = await withTenant(tenantId, (client) => service.getById(client, tenantId, id));
      if (!tanque) {
        return res.status(404).json({ error: "No encontrado" });
      }

      const paginacion = parsePaginacion(req.query);
      const { desde, hasta } = req.validatedQuery as PeriodoHistorialCombustibleQuery;
      const filas = await withTenant(tenantId, (client) =>
        service.getLecturas(client, tenantId, id, paginacion, { desde, hasta })
      );
      res.json(armarRespuestaPaginada(filas, paginacion));
    } catch {
      res.status(500).json({ error: "Error al obtener el histórico de lecturas" });
    }
  }

  /** GET /:id/sugerencia-umbral -- entrega 3 de Fase D, el asistente de
   *  calibración de `umbral_diferencia_pct`. Nunca guarda nada: devuelve
   *  el número sugerido y la muestra que lo justifica, y es el admin quien
   *  decide (guardando desde PUT /:id, que ya existe) si lo usa tal cual,
   *  lo ajusta, o lo descarta. */
  async getSugerenciaUmbral(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);

      const tanque = await withTenant(tenantId, (client) => service.getById(client, tenantId, id));
      if (!tanque) {
        return res.status(404).json({ error: "No encontrado" });
      }

      // Las cuatro sugerencias juntas: el formulario las muestra al lado de sus
      // respectivos campos y el usuario decide cuál acepta. Van en un solo
      // request porque salen del mismo historial del tanque.
      //
      // `ventana` se agregó después que las otras tres: el panel la trata como
      // opcional, para que un backend viejo durante un deploy no le apague las
      // demás.
      const sugerencias = await withTenant(tenantId, (client) =>
        service.sugerirUmbrales(client, tenantId, id)
      );
      res.json(sugerencias);
    } catch {
      res.status(500).json({ error: "Error al calcular la sugerencia de umbral" });
    }
  }

  /** GET /:id/sugerencia-umbral/xlsx -- de dónde sale la sugerencia.
   *
   *  Nace de un problema concreto: la etiqueta dice
   *  `Sugerencia: 14.5% (27 mediciones, promedio 1.93% ± 6.27%)` y al lado
   *  tiene un botón que la aplica de un clic. Nadie que no sepa estadística
   *  puede decidir con eso, y el número es peligroso -- se calcula sobre el
   *  historial del tanque, así que si adentro hubo un robo, la fórmula
   *  propone tolerarlo.
   *
   *  Este archivo abre la caja: la muestra fila por fila, y los cuatro
   *  números de la etiqueta como FÓRMULAS vivas. Con eso el que decide puede
   *  ordenar por valor, ver los dos casos raros que inflan todo, borrarlos y
   *  mirar cómo cambia la sugerencia -- que es exactamente el trabajo que hoy
   *  hay que hacer a mano para saber si el número sirve. */
  /** GET /config/sugerencia-topes -- los dos topes diarios sugeridos desde el
   *  historial. Propone, no aplica: ver CombustibleService.sugerirTopesDiarios. */
  async getSugerenciaTopes(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const sugerencia = await withTenant(tenantId, (client) =>
        service.sugerirTopesDiarios(client, tenantId)
      );
      res.json(sugerencia);
    } catch {
      res.status(500).json({ error: "Error al calcular la sugerencia de topes" });
    }
  }

  /** GET /equipos/:equipoId/sugerencia-consumo -- el consumo máximo sugerido
   *  desde el historial del propio equipo. Mismo contrato que la sugerencia
   *  de umbrales del tanque: devuelve la muestra entera y nunca aplica nada.
   *  Vive en Combustible y no en Equipos porque la muestra son los vales. */
  async getSugerenciaConsumo(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const equipoId = Number(req.params.equipoId);
      const sugerencia = await withTenant(tenantId, (client) =>
        service.sugerirConsumoMaximo(client, tenantId, equipoId)
      );
      if (!sugerencia) {
        res.status(404).json({ error: "Equipo no encontrado" });
        return;
      }
      res.json(sugerencia);
    } catch {
      res.status(500).json({ error: "Error al calcular la sugerencia de consumo" });
    }
  }

  async getSugerenciaUmbralXlsx(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);

      const tanque = await withTenant(tenantId, (client) => service.getById(client, tenantId, id));
      if (!tanque) {
        res.status(404).json({ error: "Tanque no encontrado" });
        return;
      }

      const { diferencia, descuadre, ciclo, ventana } = await withTenant(tenantId, (client) =>
        service.sugerirUmbrales(client, tenantId, id)
      );

      const capacidad = Number(tanque.capacidad_total);
      const u = tanque.unidad;
      const cabecera = {
        codigo: tanque.codigo,
        nombre: tanque.tanque_nombre,
        capacidad,
        unidad: u,
      };

      type PuntoDescuadre = {
        descuadreLitros: number;
        leidoEn: string | Date;
        leidoEnAnterior: string | Date;
        nivelAnterior: number;
        despachos: number;
        recepciones: number;
        nivelMedido: number;
        origen: string;
      };
      type PuntoCiclo = {
        descuadreLitros: number;
        intervalos: number;
        desde: string | Date;
        hasta: string | Date;
      };
      type PuntoDiferencia = {
        cantidad: number;
        recibidoEn: string | Date;
        documento: string | null;
        nivelAntes: number;
        nivelDespues: number;
        salidas: number;
      };
      const muestraDescuadre = (descuadre.muestra ?? []) as PuntoDescuadre[];
      const muestraCiclo = (ciclo.muestra ?? []) as PuntoCiclo[];
      const muestraDiferencia = (diferencia.muestra ?? []) as PuntoDiferencia[];

      // Descuadre y ventana muestran los MISMOS tramos, desarmados igual: lo
      // único que cambia entre las dos hojas es la cuenta de abajo.
      const tramos = {
        columnas: [
          {
            encabezado: "Varilla anterior",
            formato: "texto",
            explicacion: "Fecha y hora de la varilla con la que se compara.",
          },
          {
            encabezado: "Esta varilla",
            formato: "texto",
            explicacion: "Fecha y hora de la varilla de este tramo.",
          },
          {
            encabezado: `Nivel anterior (${u})`,
            formato: "decimal",
            explicacion: "Lo que marcó la varilla anterior.",
          },
          {
            encabezado: `Despachos (${u})`,
            formato: "decimal",
            explicacion: "Lo que salió por vales entre las dos varillas.",
          },
          {
            encabezado: `Recepciones (${u})`,
            formato: "decimal",
            explicacion: "Lo que entró por recepciones entre las dos varillas.",
          },
          {
            encabezado: `Saldo teórico (${u})`,
            formato: "decimal",
            explicacion: "Lo que DEBERÍA haber: nivel anterior − despachos + recepciones.",
          },
          {
            encabezado: `Medido (${u})`,
            formato: "decimal",
            explicacion: "Lo que marcó esta varilla.",
          },
        ] satisfies ColumnaCalibracion[],
        columnaValor: {
          encabezado: `Diferencia (${u})`,
          explicacion: "Medido − saldo teórico. Negativo = faltó combustible. Positivo = sobró.",
        },
        filas: muestraDescuadre.map((m) => ({
          contexto: [
            fechaLima(m.leidoEnAnterior),
            fechaLima(m.leidoEn),
            m.nivelAnterior,
            m.despachos,
            m.recepciones,
            { formula: "{3}-{4}+{5}" },
            m.nivelMedido,
          ],
          valor: { formula: "{7}-{6}" },
          observacion: m.origen === "inicial" ? OBSERVACION_LECTURA_INICIAL : undefined,
        })),
      };

      // En el mismo orden que los campos del formulario del tanque.
      const libro = armarXlsx([
        hojaDeCalibracion({
          nombre: "Diferencia en recepción",
          queCuenta: "entregas",
          titulo: "Umbral de diferencia -- de dónde sale la sugerencia",
          queEsCadaFila:
            "Cada fila es una ENTREGA de combustible: lo facturado contra lo que realmente subió " +
            "la varilla. Solo entran las entregas con varilla antes Y después, y sin otra entrega " +
            "en el medio.",
          cabecera,
          umbralHoyPct: tanque.umbral_diferencia_pct,
          // El único que se mide en PORCENTAJE: su base es la cantidad de cada
          // entrega, que cambia en cada fila. Con un denominador distinto por
          // fila, promediar litros daría otra cosa que lo que calcula el sistema.
          unidadValor: "%",
          columnas: [
            {
              encabezado: "Fecha de la entrega",
              formato: "texto",
              explicacion: "Cuándo se recibió el combustible.",
            },
            {
              encabezado: "Documento",
              formato: "texto",
              explicacion: "Factura o guía de remisión de la entrega.",
            },
            {
              encabezado: `Facturado (${u})`,
              formato: "decimal",
              explicacion: "Lo que dice el documento.",
            },
            {
              encabezado: `Varilla antes (${u})`,
              formato: "decimal",
              explicacion: "Nivel medido antes de descargar.",
            },
            {
              encabezado: `Varilla después (${u})`,
              formato: "decimal",
              explicacion: "Nivel medido después de descargar.",
            },
            {
              encabezado: `Salidas en el medio (${u})`,
              formato: "decimal",
              explicacion: "Lo que salió por vales entre las dos varillas.",
            },
            {
              encabezado: `Subió realmente (${u})`,
              formato: "decimal",
              explicacion: "Varilla después − varilla antes + salidas en el medio.",
            },
            {
              encabezado: `Diferencia (${u})`,
              formato: "decimal",
              explicacion: "Subió realmente − facturado. Negativo = llegó menos de lo facturado.",
            },
          ],
          columnaValor: {
            encabezado: "Diferencia (%)",
            explicacion:
              "Diferencia ÷ facturado × 100. Se mide sobre lo FACTURADO en cada entrega, no sobre la capacidad del tanque.",
          },
          filas: muestraDiferencia.map((m) => ({
            contexto: [
              fechaLima(m.recibidoEn),
              m.documento,
              m.cantidad,
              m.nivelAntes,
              m.nivelDespues,
              m.salidas,
              { formula: "{5}-{4}+{6}" },
              { formula: "{7}-{3}" },
            ],
            valor: { formula: "{8}/{3}*100" },
          })),
          // El campo de diferencia no usa SugerenciaCompacta: tiene su propio
          // recuadro, con otro texto.
          etiqueta: {
            faltanAntes: "Todavía no hay muestra suficiente para sugerir un umbral (",
            faltanDespues: " recepciones con lectura antes y después).",
            contadas: "recepciones",
          },
        }),
        hojaDeCalibracion({
          nombre: "Descuadre por tramo",
          queCuenta: "tramos",
          titulo: "Umbral de descuadre -- de dónde sale la sugerencia",
          queEsCadaFila:
            "Cada fila es un TRAMO: el espacio entre dos varillas seguidas, con los vales y " +
            "recepciones que pasaron en el medio. Con 28 varillas hay 27 tramos: la primera no " +
            "tiene una anterior contra la cual compararse.",
          cabecera,
          umbralHoyPct: tanque.umbral_descuadre_pct,
          unidadValor: u,
          ...tramos,
          etiqueta: ETIQUETA_COMPACTA,
        }),
        hojaDeCalibracion({
          nombre: "Ciclo",
          queCuenta: "ciclos cerrados",
          titulo: "Umbral acumulado del ciclo -- de dónde sale la sugerencia",
          queEsCadaFila:
            "Cada fila es un CICLO: desde una recepción hasta la siguiente, sumando las " +
            "diferencias de todos sus tramos. El ciclo en curso no entra: todavía puede moverse.",
          cabecera,
          umbralHoyPct: tanque.umbral_descuadre_ciclo_pct,
          unidadValor: u,
          columnas: [
            {
              encabezado: "Inicio del ciclo",
              formato: "texto",
              explicacion: "Primera varilla después de la recepción que abrió el ciclo.",
            },
            {
              encabezado: "Fin del ciclo",
              formato: "texto",
              explicacion: "Última varilla antes de la recepción siguiente.",
            },
            {
              encabezado: "Tramos del ciclo",
              formato: "entero",
              explicacion: "Cuántos tramos entre varillas se sumaron en ese ciclo.",
            },
          ],
          columnaValor: {
            encabezado: `Diferencia acumulada del ciclo (${u})`,
            explicacion:
              "La suma de las diferencias de todos los tramos del ciclo. Negativo = faltó. Positivo = sobró.",
          },
          filas: muestraCiclo.map((m) => ({
            contexto: [fechaLima(m.desde), fechaLima(m.hasta), m.intervalos],
            valor: m.descuadreLitros,
          })),
          etiqueta: ETIQUETA_COMPACTA,
        }),
        hojaDeCalibracionVentana({
          nombre: "Ventana",
          queCuenta: "tramos",
          titulo: "Umbral acumulado de la ventana -- de dónde sale la sugerencia",
          queEsCadaFila:
            "Cada fila es un TRAMO, los mismos de la hoja 'Descuadre por tramo'. La alerta suma " +
            `CON SIGNO los tramos de los últimos ${ventana.diasVentana} días, sin cortar en ` +
            "ninguna recepción. La cuenta de esta hoja es otra: la diferencia va con signo y la " +
            "sugerencia es 2 desviaciones, sin sumar el promedio.",
          cabecera,
          umbralHoyPct: tanque.umbral_descuadre_ventana_pct,
          unidadValor: u,
          ...tramos,
          etiqueta: ETIQUETA_COMPACTA,
        }),
        HOJA_COMO_LEERLO,
      ]);

      await registrarAuditoria({
        accion: "combustible.calibracion_exportar",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: {
          combustibleId: id,
          codigo: tanque.codigo,
          tramos: muestraDescuadre.length,
          ciclos: muestraCiclo.length,
          recepciones: muestraDiferencia.length,
        },
        contexto: contextoAuditoriaModulo(req),
      });

      const archivo = sanearNombreArchivo(`calibracion-${tanque.codigo}.xlsx`);
      res.setHeader("Content-Type", CONTENT_TYPE_XLSX);
      res.setHeader("Content-Disposition", `attachment; filename="${archivo}"`);
      res.send(libro);
    } catch {
      res.status(500).json({ error: "Error al exportar el detalle de calibración" });
    }
  }

  /** PATCH /lecturas/:lecturaId/anular -- marca una lectura mal cargada
   *  como anulada (con motivo obligatorio) y recalcula el nivel del tanque.
   *  La fila NUNCA se borra ni se edita: queda como evidencia de que hubo
   *  un error y quién lo corrigió. Ver migrations/0058. */
  async anularLectura(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const lecturaId = Number(req.params.lecturaId);
      const { motivo } = req.validatedBody as AnularLecturaCombustibleInput;

      const resultado = await withTenant(tenantId, async (client) => {
        const anulada = await service.anularLectura(
          client,
          tenantId,
          lecturaId,
          req.usuario!.id,
          motivo
        );
        if (anulada) return { estado: "anulada" as const, ...anulada };

        // El UPDATE no afectó nada: o la lectura no existe en este tenant,
        // o ya estaba anulada. Hay que distinguirlo para no responder 404
        // ante algo que sí existe (y viceversa).
        const existente = await service.getLecturaPorId(client, tenantId, lecturaId);
        return existente ? { estado: "ya_anulada" as const } : { estado: "inexistente" as const };
      });

      if (resultado.estado === "inexistente") {
        return res.status(404).json({ error: "Lectura no encontrada" });
      }
      if (resultado.estado === "ya_anulada") {
        // 409 y no 400: no es un dato mal formado, es un rechazo por el
        // ESTADO actual del recurso -- mismo criterio que el stock
        // insuficiente de repuestos.
        return res.status(409).json({ error: "Esta lectura ya estaba anulada" });
      }

      await registrarAuditoria({
        accion: "combustible.anular_lectura",
        tenantId,
        usuarioId: req.usuario!.id,
        // Solo ids y la referencia, nunca el contenido de negocio -- mismo
        // criterio que el resto de moduleAudit. El motivo SÍ va: es la
        // razón de una acción correctiva, justo lo que la auditoría tiene
        // que poder responder después.
        detalle: {
          lecturaId,
          combustibleId: resultado.lectura.combustible_id,
          motivo,
        },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "combustible.lectura_anulada", {
        lecturaId,
        combustibleId: resultado.lectura.combustible_id,
      });

      res.json({ lectura: resultado.lectura, tanque: resultado.tanque });
    } catch {
      res.status(500).json({ error: "Error al anular la lectura" });
    }
  }

  /** POST /combustible/lecturas -- crea una lectura histórica y, si es la
   *  más reciente, actualiza `nivel_actual` (ver
   *  CombustibleRepository.registrarLectura). Único endpoint de Combustible
   *  que participa de la cola offline: `combustible_id` viaja en el body a
   *  propósito, no en la URL -- el motor offline del cliente
   *  (rutasOffline.ts) solo matchea rutas literales, sin parámetros. */
  async registrarLectura(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const data = req.validatedBody as RegistrarLecturaCombustibleInput;

      // Si el grifero toma varilla o no lo decide cada empresa (0085), así
      // que no se puede resolver con requireRole: hay que leer la config.
      // Solo se consulta cuando el que llama es grifero -- para admin y
      // operador la respuesta es siempre sí, y no vale una query por lectura.
      if (req.usuario!.rol === "grifero") {
        const puede = await withTenant(tenantId, (client) =>
          service.grifieroRegistraVarilla(client, tenantId)
        );
        if (!puede) {
          res.status(403).json({
            error: "En esta empresa la varilla la toman el administrador o un operador",
          });
          return;
        }
      }

      const { fila, creado } = await withTenant(tenantId, (client) =>
        service.registrarLectura(client, tenantId, req.usuario!.id, data)
      );

      // Reintento de un envío que ya se había guardado (la respuesta
      // original se perdió en la red). No se publica el evento de nuevo --
      // eso ya pasó la primera vez. 200 y no 201 porque esta llamada no
      // creó nada, pero sí es un éxito para la cola offline del dispositivo.
      if (!creado) {
        res.status(200).json(fila ?? { error: "Esta lectura ya se había registrado" });
        return;
      }

      await registrarAuditoria({
        accion: "combustible.registrar_lectura",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { lecturaId: fila!.lectura.id, combustibleId: data.combustible_id },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "combustible.lectura_registrada", {
        lecturaId: fila!.lectura.id,
        combustibleId: data.combustible_id,
        nivel: data.nivel,
      });
      await this.procesarLecturaRegistrada(tenantId, {
        combustibleId: data.combustible_id,
        lecturaId: Number(fila!.lectura.id),
        nivel: data.nivel,
        // pg devuelve TIMESTAMPTZ como Date; el balance necesita el mismo
        // instante exacto que quedó guardado (no `data.leido_en`, que es
        // opcional en el body y puede venir sin definir).
        leidoEn: new Date(fila!.lectura.leido_en).toISOString(),
        rolQueMidio: req.usuario!.rol,
        quienMidio: req.usuario!.nombre ?? req.usuario!.email ?? "Alguien",
      });
      res.status(201).json(fila);
    } catch (err) {
      // Los dos casos van con 400: son datos que se contradicen a sí mismos
      // (un tanque que no existe, un nivel imposible para ese tanque), no
      // fallas del servidor. El 4xx además hace que la cola offline los
      // descarte sin reintentar y los reporte, en vez de reintentar para
      // siempre algo que nunca va a entrar (ver esErrorPermanente() en
      // client/src/offline/offlineSync.ts).
      if (
        err instanceof Error &&
        (err.message.includes("no existe en este tenant") ||
          err.message.includes("supera la capacidad del tanque") ||
          // Precintos (0095): falta el número de un punto, o el punto no es
          // de este tanque. Corregible con el tanque delante.
          err.message.includes("usa precintos") ||
          err.message.includes("no es de este tanque"))
      ) {
        res.status(400).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: "Error al registrar lectura de combustible" });
    }
  }

  // ── Despachos (Fase B) ─────────────────────────────────────────────────

  /** POST /despachos -- crea el vale digital. Único endpoint de despachos
   *  que participa de la cola offline (ver registry.ts): equipo_id/
   *  combustible_id viajan en el body a propósito, mismo motivo que
   *  combustible_id en /lecturas (rutasOffline.ts solo matchea rutas
   *  literales, sin parámetros). */
  async crearDespacho(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const data = req.validatedBody as CrearDespachoCombustibleInput;

      // Los roles de cancha (0085) comparten este endpoint con los de
      // oficina, pero cada uno tiene UN solo origen permitido -- y eso
      // depende del body, no de la ruta, así que requireRole no puede
      // verlo. Antes de tocar la base: un permiso que se evalúa después de
      // escribir no es un permiso.
      const noPermitido = service.motivoOrigenNoPermitido(req.usuario!.rol, data.origen);
      if (noPermitido) {
        res.status(403).json({ error: noPermitido });
        return;
      }

      const { fila, creado } = await withTenant(tenantId, (client) =>
        service.crearDespacho(client, tenantId, req.usuario!.id, data)
      );

      // Reintento de un envío que ya se había guardado -- mismo criterio
      // que registrarLectura: 200 (no 201, no creó nada) para que la cola
      // offline lo dé por sincronizado sin duplicar auditoría ni evento.
      if (!creado) {
        res.status(200).json(fila ?? { error: "Este despacho ya se había registrado" });
        return;
      }

      await registrarAuditoria({
        accion: "combustible.despacho_crear",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: {
          despachoId: fila!.id,
          origen: data.origen,
          serieTalonario: data.serie_talonario,
          nVale: data.n_vale,
        },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "combustible.despacho_creado", {
        despachoId: fila!.id,
      });
      await this.procesarAlertasDespachoCreado(tenantId, fila!.id, data);
      res.status(201).json(fila);
    } catch (err) {
      if (err instanceof Error && err.message.includes("ya está registrado")) {
        // 409: no es un dato mal formado, es el mismo vale tipeado dos
        // veces -- mismo criterio que el vale duplicado del punto 5.
        res.status(409).json({ error: err.message });
        return;
      }
      if (
        err instanceof Error &&
        (err.message.includes("el contómetro marcó") ||
          err.message.includes("no existe en este tenant") ||
          err.message.includes("no tiene tipo de medidor configurado") ||
          err.message.includes("se mide por") ||
          err.message.includes("está desactivado y no puede despachar") ||
          err.message.includes("y el vale dice") ||
          // Grifo del rol equivocado (migrations/0065).
          err.message.includes("no está marcado como") ||
          // Salto de numeración imposible de tipeo (5ª auditoría).
          err.message.includes("salta"))
      ) {
        // Todos estos son datos que se contradicen a sí mismos o a una
        // fila que el propio request referenció mal -- 400, corregible ahí
        // mismo con el papel en la mano (ver el punto 5 del documento).
        res.status(400).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: "Error al registrar el despacho" });
    }
  }

  /** PATCH /despachos/:despachoId/anular -- la válvula de escape del punto 3
   *  del documento de diseño. Mismo mecanismo exacto que anularLectura y
   *  anularPrecio: 404 si no existe en este tenant, 409 si ya estaba anulada
   *  (para no pisar el motivo y el autor de la anulación original, que son la
   *  evidencia de quién corrigió qué). */
  async anularDespacho(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const despachoId = Number(req.params.despachoId);
      const { motivo } = req.validatedBody as AnularDespachoCombustibleInput;

      const resultado = await withTenant(tenantId, async (client) => {
        const anulado = await service.anularDespacho(
          client,
          tenantId,
          despachoId,
          req.usuario!.id,
          motivo
        );
        if (anulado) return { estado: "anulada" as const, despacho: anulado };

        const existente = await service.getDespachoPorId(client, tenantId, despachoId);
        return existente ? { estado: "ya_anulada" as const } : { estado: "inexistente" as const };
      });

      if (resultado.estado === "inexistente") {
        res.status(404).json({ error: "Despacho no encontrado" });
        return;
      }
      if (resultado.estado === "ya_anulada") {
        res.status(409).json({ error: "Este despacho ya estaba anulado" });
        return;
      }

      await registrarAuditoria({
        accion: "combustible.despacho_anular",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: {
          despachoId,
          serieTalonario: resultado.despacho.serie_talonario,
          nVale: resultado.despacho.n_vale,
          motivo,
        },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "combustible.despacho_anulado", { despachoId });
      await this.procesarAlertaAnulacion(
        tenantId,
        despachoId,
        resultado.despacho.serie_talonario,
        resultado.despacho.n_vale,
        motivo
      );
      res.json(resultado.despacho);
    } catch {
      res.status(500).json({ error: "Error al anular el despacho" });
    }
  }

  /** Best-effort, mismo contrato "nunca lanza" que publicarEventoTenant():
   *  corre después de que la transacción de crearDespacho ya confirmó, así
   *  que un fallo acá no puede convertir un 201 real en un 500. */
  private async procesarAlertasDespachoCreado(
    tenantId: string,
    despachoId: number,
    data: CrearDespachoCombustibleInput
  ) {
    // UREA: rama completamente separada -- ver procesarAlertasDespachoUrea().
    // Los controles de abajo (sobredespacho, medidor inconsistente, consumo
    // excedido) hablan de conceptos que la urea no tiene (tanque, capacidad
    // en gal/L, horómetro como control PRINCIPAL) y mezclarlos acá sería
    // repetir el mismo error que forzó a reescribir el CHECK de la migración
    // 0092: dos formas de vale distintas no comparten una sola validación.
    if (data.producto === "urea") {
      await this.procesarAlertasDespachoUrea(tenantId, despachoId, data);
      return;
    }

    const serieTalonario = data.serie_talonario;
    const nVale = data.n_vale;
    try {
      const {
        huecos,
        exceso,
        medidor,
        fueraDeOrden,
        tope,
        retro,
        recargado,
        consumo,
        totalizador,
        admins,
      } = await withTenant(tenantId, async (client) => {
        // El vale que acaba de llegar puede estar llenando un hueco ya
        // alertado (offline que sincronizó) -- esto corre siempre, sin
        // condicionar, y no hace nada si no había ninguna alerta abierta.
        //
        // Si el hueco YA se había congelado como anomalía, no lo resuelve
        // (la anomalía es inmutable): devuelve `llegoTarde` y se registra
        // el despacho_tardio del punto 4 -- que alguien se acuerde de un
        // vale dos días después es una señal, no algo a corregir en
        // silencio.
        const { llegoTarde } = await service.resolverAlertaHuecoSiExiste(
          client,
          tenantId,
          "combustible",
          serieTalonario,
          nVale
        );

        const huecos = await service.detectarHuecosRevelados(
          client,
          tenantId,
          "combustible",
          serieTalonario,
          despachoId,
          nVale
        );

        // Vale cargado POR DEBAJO del máximo de su serie (0077). Si venía a
        // llenar un hueco alertado, `llegoTarde`/el UPDATE de arriba ya lo
        // explicaron y no hay nada que reportar: lo sospechoso es el vale
        // desordenado que NADIE estaba esperando.
        const maxAnterior = await service.detectarValeFueraDeOrden(
          client,
          tenantId,
          "combustible",
          serieTalonario,
          despachoId,
          nVale
        );
        const huecoLoEsperaba = await service.existioHuecoPara(
          client,
          tenantId,
          "combustible",
          serieTalonario,
          nVale
        );
        const fueraDeOrden = maxAnterior !== null && !huecoLoEsperaba ? maxAnterior : null;

        // Sobredespacho (0069/0070): solo aplica si el vale fue a un equipo.
        // Devuelve null en el caso normal -- sin capacidad configurada, sin
        // unidad conocida, o sin exceso (ver evaluarSobredespacho).
        const exceso = data.equipo_id
          ? await service.evaluarSobredespacho(
              client,
              tenantId,
              data.equipo_id,
              data.combustible_id ?? null,
              data.cantidad!
            )
          : null;

        // Medidor que no cierra con el anterior (punto 5 del documento,
        // migración 0073). Igual que el sobredespacho: no bloquea el vale,
        // solo lo marca. Se evalúa contra el ÚLTIMO despacho vigente de ese
        // equipo, así que el primero de cada equipo nunca alerta.
        const medidor = data.equipo_id
          ? await service.evaluarMedidorInconsistente(client, tenantId, data.equipo_id, {
              lecturaHorometro: data.lectura_horometro ?? null,
              lecturaOdometro: data.lectura_odometro ?? null,
              despachadoEn: data.despachado_en ?? new Date().toISOString(),
              despachoId,
            })
          : null;

        // Tope diario por actor (0079): lo que le faltaba al sobredespacho,
        // que mira UN vale. Acá el problema es la SUMA de 24 h, así que
        // aplica también a los destinos sin equipo -- planta y reserva no
        // tenían ningún techo hasta ahora.
        // El vale fechado muy atrás (0081): la cola offline produce horas,
        // no semanas. Un vale con tres semanas de atraso no es
        // sincronización, es alguien eligiendo una fecha -- el red team lo
        // usó para sacar un despacho del reporte de controles.
        const retro = await service.evaluarDespachoRetroactivo(
          client,
          tenantId,
          data.combustible_id ?? null,
          despachoId,
          data.despachado_en ?? new Date().toISOString()
        );

        // El número de vale que vuelve con OTRA cantidad (0081). Reutilizar
        // el número es la corrección de un tipeo funcionando; que la
        // cantidad cambie es lo que hay que mirar.
        const recargado = await service.evaluarValeRecargado(
          client,
          tenantId,
          "combustible",
          serieTalonario,
          nVale,
          data.cantidad!
        );

        // Consumo por hora de motor / por km (0088). Es el único control que
        // ve el combustible que sale CON vale y no llega a la máquina.
        const consumo = data.equipo_id
          ? await service.evaluarConsumoExcedido(client, tenantId, data.equipo_id, {
              despachoId,
              lecturaHorometro: data.lectura_horometro ?? null,
              lecturaOdometro: data.lectura_odometro ?? null,
            })
          : null;

        // Totalizador acumulativo contra los litros del vale (0094). null si el
        // tanque no lo usa o si es el primer vale de la cadena.
        const totalizador = await service.evaluarTotalizador(client, tenantId, {
          despachoId,
          combustibleId: data.combustible_id ?? null,
          totalizador: data.totalizador_lectura ?? null,
          cantidad: data.cantidad!,
          despachadoEn: data.despachado_en ?? new Date().toISOString(),
        });

        const tope = await service.evaluarTopeDiario(client, tenantId, {
          despachoId,
          equipoId: data.equipo_id ?? null,
          tipoDestino: data.tipo_destino,
          despachadoEn: data.despachado_en ?? new Date().toISOString(),
        });

        const nuevas = [
          ...(consumo
            ? [
                {
                  tipo: "consumo_excedido" as const,
                  serieTalonario,
                  nVale,
                  despachoId,
                  detalle: { ...consumo, equipoId: data.equipo_id } as Record<string, unknown>,
                },
              ]
            : []),
          ...huecos.map((n) => ({
            tipo: "hueco_detectado" as const,
            serieTalonario,
            nVale: n,
            despachoId,
            detalle: { revelado_por_vale: nVale } as Record<string, unknown>,
          })),
          ...(exceso
            ? [
                {
                  tipo: "sobredespacho" as const,
                  serieTalonario,
                  nVale,
                  despachoId,
                  detalle: { ...exceso, equipoId: data.equipo_id } as Record<string, unknown>,
                },
              ]
            : []),
          ...(tope
            ? [
                {
                  tipo: "tope_diario_excedido" as const,
                  serieTalonario,
                  nVale,
                  despachoId,
                  detalle: { ...tope } as Record<string, unknown>,
                },
              ]
            : []),
          ...(retro
            ? [
                {
                  tipo: "despacho_retroactivo" as const,
                  serieTalonario,
                  nVale,
                  despachoId,
                  detalle: { ...retro } as Record<string, unknown>,
                },
              ]
            : []),
          ...(recargado
            ? [
                {
                  tipo: "vale_recargado" as const,
                  serieTalonario,
                  nVale,
                  despachoId,
                  detalle: { ...recargado } as Record<string, unknown>,
                },
              ]
            : []),
          ...(fueraDeOrden !== null
            ? [
                {
                  tipo: "vale_fuera_de_orden" as const,
                  serieTalonario,
                  nVale,
                  despachoId,
                  detalle: { maxAnteriorDeLaSerie: fueraDeOrden } as Record<string, unknown>,
                },
              ]
            : []),
          ...(medidor
            ? [
                {
                  tipo: "medidor_inconsistente" as const,
                  serieTalonario,
                  nVale,
                  despachoId,
                  detalle: { ...medidor, equipoId: data.equipo_id } as Record<string, unknown>,
                },
              ]
            : []),
          ...(totalizador
            ? [
                {
                  tipo:
                    totalizador.motivo === "retroceso"
                      ? ("totalizador_retroceso" as const)
                      : ("totalizador_salto" as const),
                  serieTalonario,
                  nVale,
                  despachoId,
                  combustibleId: data.combustible_id ?? null,
                  detalle: { ...totalizador } as Record<string, unknown>,
                },
              ]
            : []),
          ...(llegoTarde
            ? [
                {
                  tipo: "despacho_tardio" as const,
                  serieTalonario,
                  nVale,
                  despachoId,
                  detalle: {
                    nota: "El vale llegó después de que el hueco se congelara como anomalía",
                  } as Record<string, unknown>,
                },
              ]
            : []),
        ];

        if (nuevas.length === 0) {
          return {
            huecos,
            exceso,
            medidor,
            fueraDeOrden,
            tope,
            retro,
            recargado,
            consumo,
            totalizador,
            admins: [] as { email: string; nombre: string }[],
          };
        }

        await service.crearAlertas(client, tenantId, nuevas);
        const admins = await service.findAdminsConCombustibleHabilitado(client, tenantId);
        return {
          huecos,
          exceso,
          medidor,
          fueraDeOrden,
          tope,
          retro,
          recargado,
          consumo,
          totalizador,
          admins,
        };
      });

      if (huecos.length > 0) {
        await publicarEventoTenant(tenantId, "combustible.alerta_creada", {
          tipo: "hueco_detectado",
          serieTalonario,
          valesFaltantes: huecos,
        });
        await enviarCorreoAlertaHueco(admins, {
          serieTalonario,
          valesFaltantes: huecos,
          nValeQueLoRevelo: nVale,
        });
      }

      if (exceso) {
        await publicarEventoTenant(tenantId, "combustible.alerta_creada", {
          tipo: "sobredespacho",
          serieTalonario,
          nVale,
        });
        await enviarCorreoAlertaSobredespacho(admins, {
          serieTalonario,
          nVale,
          ...exceso,
        });
      }

      if (fueraDeOrden !== null) {
        await publicarEventoTenant(tenantId, "combustible.alerta_creada", {
          tipo: "vale_fuera_de_orden",
          serieTalonario,
          nVale,
        });
      }

      if (retro) {
        await publicarEventoTenant(tenantId, "combustible.alerta_creada", {
          tipo: "despacho_retroactivo",
          serieTalonario,
          nVale,
        });
        await enviarCorreoValeRetroactivo(admins, { serieTalonario, nVale, ...retro });
      }

      if (recargado) {
        await publicarEventoTenant(tenantId, "combustible.alerta_creada", {
          tipo: "vale_recargado",
          serieTalonario,
          nVale,
        });
        await enviarCorreoValeRecargado(admins, { serieTalonario, nVale, ...recargado });
      }

      if (tope) {
        await publicarEventoTenant(tenantId, "combustible.alerta_creada", {
          tipo: "tope_diario_excedido",
          serieTalonario,
          nVale,
        });
        await enviarCorreoTopeDiario(admins, {
          actor: tope.equipoId ? `El equipo #${tope.equipoId}` : `El destino "${tope.tipoDestino}"`,
          acumuladoL: tope.acumuladoL,
          topeL: tope.topeL,
          vales: tope.valesEnLaVentana,
          base: tope.base,
          serieTalonario,
          nVale,
        });
      }

      if (consumo) {
        await publicarEventoTenant(tenantId, "combustible.alerta_creada", {
          tipo: "consumo_excedido",
          serieTalonario,
          nVale,
        });
        await enviarCorreoConsumoExcedido(admins, { ...consumo, serieTalonario, nVale });
      }

      if (totalizador) {
        await publicarEventoTenant(tenantId, "combustible.alerta_creada", {
          tipo: totalizador.motivo === "retroceso" ? "totalizador_retroceso" : "totalizador_salto",
          serieTalonario,
          nVale,
        });
        await enviarCorreoTotalizador(admins, { serieTalonario, nVale, ...totalizador });
      }

      if (medidor) {
        await publicarEventoTenant(tenantId, "combustible.alerta_creada", {
          tipo: "medidor_inconsistente",
          serieTalonario,
          nVale,
        });
        await enviarCorreoAlertaMedidor(admins, { serieTalonario, nVale, ...medidor });
      }
    } catch (err) {
      logger.warn(
        { err, tenantId, despachoId },
        "No se pudieron procesar las alertas del despacho creado"
      );
    }
  }

  /** El equivalente de procesarAlertasDespachoCreado() para UREA (migración
   *  0092) -- mismo contrato "nunca lanza" (corre después de que la
   *  transacción de crearDespacho ya confirmó). Reusa el motor de talonario
   *  (hueco, fuera de orden, recargado) filtrado por producto='urea', y
   *  suma los 3 controles propios: equipo no habilitado, ratio urea/diésel,
   *  tope diario de urea. NO corre sobredespacho, medidor inconsistente ni
   *  consumo excedido -- son conceptos de tanque/horómetro que la urea no
   *  tiene (ver el comentario del branch en procesarAlertasDespachoCreado). */
  private async procesarAlertasDespachoUrea(
    tenantId: string,
    despachoId: number,
    data: CrearDespachoCombustibleInput
  ) {
    const serieTalonario = data.serie_talonario;
    const nVale = data.n_vale;
    const equipoId = data.equipo_id!; // el CHECK de 0092 lo garantiza para urea
    try {
      const { huecos, fueraDeOrden, recargado, noHabilitado, ratio, tope, admins } =
        await withTenant(tenantId, async (client) => {
          const { llegoTarde } = await service.resolverAlertaHuecoSiExiste(
            client,
            tenantId,
            "urea",
            serieTalonario,
            nVale
          );

          const huecos = await service.detectarHuecosRevelados(
            client,
            tenantId,
            "urea",
            serieTalonario,
            despachoId,
            nVale
          );

          const maxAnterior = await service.detectarValeFueraDeOrden(
            client,
            tenantId,
            "urea",
            serieTalonario,
            despachoId,
            nVale
          );
          const huecoLoEsperaba = await service.existioHuecoPara(
            client,
            tenantId,
            "urea",
            serieTalonario,
            nVale
          );
          const fueraDeOrden = maxAnterior !== null && !huecoLoEsperaba ? maxAnterior : null;

          const recargado = await service.evaluarValeRecargado(
            client,
            tenantId,
            "urea",
            serieTalonario,
            nVale,
            data.cantidad_bultos! * FACTOR_LITROS_UREA[data.presentacion!]
          );

          const noHabilitado = await service.evaluarUreaEquipoNoHabilitado(
            client,
            tenantId,
            equipoId
          );

          const despachadoEn = data.despachado_en ?? new Date().toISOString();
          const ratio = await service.evaluarUreaRatioExcedido(
            client,
            tenantId,
            equipoId,
            despachadoEn
          );

          const tope = await service.evaluarTopeDiarioUrea(client, tenantId, {
            despachoId,
            equipoId,
            despachadoEn,
          });

          const nuevas = [
            ...huecos.map((n) => ({
              tipo: "hueco_detectado" as const,
              serieTalonario,
              nVale: n,
              despachoId,
              producto: "urea" as const,
              detalle: { revelado_por_vale: nVale } as Record<string, unknown>,
            })),
            ...(fueraDeOrden !== null
              ? [
                  {
                    tipo: "vale_fuera_de_orden" as const,
                    serieTalonario,
                    nVale,
                    despachoId,
                    producto: "urea" as const,
                    detalle: { maxAnteriorDeLaSerie: fueraDeOrden } as Record<string, unknown>,
                  },
                ]
              : []),
            ...(recargado
              ? [
                  {
                    tipo: "vale_recargado" as const,
                    serieTalonario,
                    nVale,
                    despachoId,
                    producto: "urea" as const,
                    detalle: { ...recargado } as Record<string, unknown>,
                  },
                ]
              : []),
            ...(noHabilitado
              ? [
                  {
                    tipo: "urea_equipo_no_habilitado" as const,
                    serieTalonario,
                    nVale,
                    despachoId,
                    producto: "urea" as const,
                    detalle: { ...noHabilitado } as Record<string, unknown>,
                  },
                ]
              : []),
            ...(ratio
              ? [
                  {
                    tipo: "urea_ratio_excedido" as const,
                    serieTalonario,
                    nVale,
                    despachoId,
                    producto: "urea" as const,
                    detalle: { ...ratio } as Record<string, unknown>,
                  },
                ]
              : []),
            ...(tope
              ? [
                  {
                    tipo: "tope_diario_excedido" as const,
                    serieTalonario,
                    nVale,
                    despachoId,
                    producto: "urea" as const,
                    detalle: { ...tope } as Record<string, unknown>,
                  },
                ]
              : []),
            ...(llegoTarde
              ? [
                  {
                    tipo: "despacho_tardio" as const,
                    serieTalonario,
                    nVale,
                    despachoId,
                    producto: "urea" as const,
                    detalle: {
                      nota: "El vale llegó después de que el hueco se congelara como anomalía",
                    } as Record<string, unknown>,
                  },
                ]
              : []),
          ];

          if (nuevas.length === 0) {
            return {
              huecos,
              fueraDeOrden,
              recargado,
              noHabilitado,
              ratio,
              tope,
              admins: [] as { email: string; nombre: string }[],
            };
          }

          await service.crearAlertas(client, tenantId, nuevas);
          const admins = await service.findAdminsConCombustibleHabilitado(client, tenantId);
          return { huecos, fueraDeOrden, recargado, noHabilitado, ratio, tope, admins };
        });

      if (huecos.length > 0) {
        await publicarEventoTenant(tenantId, "combustible.alerta_creada", {
          tipo: "hueco_detectado",
          producto: "urea",
          serieTalonario,
          valesFaltantes: huecos,
        });
      }
      if (fueraDeOrden !== null) {
        await publicarEventoTenant(tenantId, "combustible.alerta_creada", {
          tipo: "vale_fuera_de_orden",
          producto: "urea",
          serieTalonario,
          nVale,
        });
      }
      if (recargado) {
        await publicarEventoTenant(tenantId, "combustible.alerta_creada", {
          tipo: "vale_recargado",
          producto: "urea",
          serieTalonario,
          nVale,
        });
      }
      if (noHabilitado) {
        await publicarEventoTenant(tenantId, "combustible.alerta_creada", {
          tipo: "urea_equipo_no_habilitado",
          serieTalonario,
          nVale,
        });
      }
      if (ratio) {
        await publicarEventoTenant(tenantId, "combustible.alerta_creada", {
          tipo: "urea_ratio_excedido",
          serieTalonario,
          nVale,
        });
      }
      if (tope) {
        await publicarEventoTenant(tenantId, "combustible.alerta_creada", {
          tipo: "tope_diario_excedido",
          producto: "urea",
          serieTalonario,
          nVale,
        });
      }
      void admins; // el correo de urea queda para una entrega posterior -- ver PR
    } catch (err) {
      logger.warn(
        { err, tenantId, despachoId },
        "No se pudieron procesar las alertas del despacho de urea creado"
      );
    }
  }

  /** TODO lo que tiene que pasar después de que una varilla queda guardada.
   *
   *  Existe como método único por la 5ª auditoría: había DOS caminos para
   *  cargar una varilla (POST /lecturas y el viejo PUT /:id/nivel) y solo uno
   *  corría los controles. Por el otro se registró una varilla después de
   *  sacar 3.000 L y no saltó nada. El viejo se eliminó; esto garantiza que si
   *  mañana aparece otra entrada (una importación, una integración), tenga UN
   *  lugar que llamar en vez de copiar la mitad de la lista.
   *
   *  Cada control mantiene su contrato "nunca lanza": la lectura ya se guardó
   *  y se respondió, y un fallo en uno no puede impedir que corran los demás. */
  private async procesarLecturaRegistrada(
    tenantId: string,
    l: {
      combustibleId: number;
      lecturaId: number;
      nivel: number;
      leidoEn: string;
      rolQueMidio: string;
      quienMidio: string;
    }
  ) {
    await this.procesarAlertaPrecintos(tenantId, l.combustibleId, l.lecturaId, l.quienMidio);
    await this.procesarAlertaNivelBajo(tenantId, l.combustibleId, l.nivel);
    await this.procesarAlertaDescuadre(tenantId, l.combustibleId, l.lecturaId, l.nivel, l.leidoEn);
    await this.procesarAlertaDescuadreCiclo(
      tenantId,
      l.combustibleId,
      l.lecturaId,
      l.nivel,
      l.leidoEn
    );
    await this.procesarAlertaLecturaRetroactiva(
      tenantId,
      l.combustibleId,
      l.lecturaId,
      l.nivel,
      l.leidoEn
    );
    await this.procesarAlertaDescuadreVentana(tenantId, l.combustibleId, l.lecturaId, l.leidoEn);
    await this.procesarControlesDeVarilla(tenantId, l.combustibleId, l.lecturaId, l.rolQueMidio);
  }

  /** Precinto que no coincide en la varilla (0095). Mismo contrato "nunca
   *  lanza" que el resto: la lectura ya se guardó.
   *
   *  UNA alerta abierta por tanque, como el ciclo: mientras nadie registre el
   *  cambio de precinto, cada varilla va a volver a ver el sello que no
   *  coincide. Cinco varillas no son cinco robos -- es el mismo sello, y
   *  cinco correos iguales son como muere un control. */
  private async procesarAlertaPrecintos(
    tenantId: string,
    combustibleId: number,
    lecturaId: number,
    quienMidio: string
  ) {
    try {
      const resultado = await withTenant(tenantId, async (client) => {
        const fallidas = await service.findVerificacionesFallidas(client, tenantId, lecturaId);
        if (fallidas.length === 0) return null;
        const tanque = await service.getById(client, tenantId, combustibleId);
        const detalle = {
          tanque: tanque?.codigo ?? String(combustibleId),
          quienMidio,
          puntos: fallidas,
        };
        const { nueva } = await service.registrarAlertaDeEstadoAcumulado(client, tenantId, {
          tipo: "precinto_alterado",
          combustibleId,
          lecturaId,
          detalle,
        });
        if (!nueva) return null;
        const admins = await service.findAdminsConCombustibleHabilitado(client, tenantId);
        return { detalle, admins };
      });
      if (!resultado) return;
      await publicarEventoTenant(tenantId, "combustible.alerta_creada", {
        tipo: "precinto_alterado",
        combustibleId,
      });
      await enviarCorreoPrecintoAlterado(resultado.admins, resultado.detalle);
    } catch (err) {
      logger.warn({ err, tenantId, combustibleId }, "No se pudo procesar la alerta de precinto");
    }
  }

  /** Los dos controles sobre QUIÉN y CÓMO se mide (5ª auditoría).
   *
   *  - Una varilla tomada por alguien que NO despacha (no grifero) cierra la
   *    alerta de "varilla sin control": ese es el hecho que la alerta pedía.
   *  - Varillas que cuadran con el teórico AL LITRO varias veces seguidas: una
   *    varilla real no da exacto (se lee en una regla y se convierte con la
   *    tabla de aforo), así que es la huella de alguien que copia el número
   *    que el sistema espera en vez de medir. */
  private async procesarControlesDeVarilla(
    tenantId: string,
    combustibleId: number,
    lecturaId: number,
    rolQueMidio: string
  ) {
    try {
      const { exacta, admins } = await withTenant(tenantId, async (client) => {
        if (rolQueMidio !== "grifero") {
          await service.resolverVarillaSinControlSiExiste(client, tenantId, combustibleId);
        }
        const exacta = await service.evaluarVarillaExacta(
          client,
          tenantId,
          combustibleId,
          lecturaId
        );
        if (!exacta) return { exacta, admins: [] as { email: string; nombre: string }[] };
        const { nueva } = await service.registrarAlertaDeEstadoAcumulado(client, tenantId, {
          tipo: "varilla_exacta",
          combustibleId,
          lecturaId,
          detalle: { ...exacta },
        });
        const admins = nueva
          ? await service.findAdminsConCombustibleHabilitado(client, tenantId)
          : [];
        return { exacta: nueva ? exacta : null, admins };
      });
      if (!exacta) return;
      await publicarEventoTenant(tenantId, "combustible.alerta_creada", {
        tipo: "varilla_exacta",
        combustibleId,
      });
      await enviarCorreoVarillaExacta(admins, exacta);
    } catch (err) {
      logger.warn(
        { err, tenantId, combustibleId },
        "No se pudieron evaluar los controles de varilla"
      );
    }
  }

  /** Nivel bajo de tanque (migración 0073). Mismo contrato best-effort que
   *  los demás: corre después de que la lectura ya se guardó, así que un
   *  fallo acá no puede convertir un 201 real en un 500.
   *
   *  `evaluarNivelBajo` devuelve null en el caso normal -- tanque sin
   *  mínimo configurado, nivel por encima, o ya con una alerta abierta (la
   *  deduplicación). Y si el nivel volvió a subir, resuelve la alerta
   *  anterior por dentro, sin que nadie la cierre a mano. */
  private async procesarAlertaNivelBajo(tenantId: string, combustibleId: number, nivel: number) {
    try {
      const { bajo, admins } = await withTenant(tenantId, async (client) => {
        const bajo = await service.evaluarNivelBajo(client, tenantId, combustibleId, nivel);
        if (!bajo) return { bajo, admins: [] as { email: string; nombre: string }[] };

        await service.crearAlertas(client, tenantId, [
          {
            tipo: "nivel_bajo",
            combustibleId,
            detalle: { ...bajo },
          },
        ]);
        const admins = await service.findAdminsConCombustibleHabilitado(client, tenantId);
        return { bajo, admins };
      });

      if (!bajo) return;

      await publicarEventoTenant(tenantId, "combustible.alerta_creada", {
        tipo: "nivel_bajo",
        combustibleId,
      });
      await enviarCorreoAlertaNivelBajo(admins, bajo);
    } catch (err) {
      logger.warn({ err, tenantId, combustibleId }, "No se pudo procesar la alerta de nivel bajo");
    }
  }

  /** Descuadre de inventario (migración 0074). Mismo contrato "nunca lanza"
   *  que el resto de los procesar*: la lectura ya se guardó y se respondió
   *  201 -- que falle el correo o la alerta no puede tirar abajo un dato que
   *  el operario ya dio por cargado, sobre todo viniendo de la cola offline.
   *
   *  `evaluarDescuadre` devuelve null en el caso normal: tanque sin umbral
   *  configurado (el default), primera lectura del tanque, o descuadre
   *  dentro de la tolerancia. */
  private async procesarAlertaDescuadre(
    tenantId: string,
    combustibleId: number,
    lecturaId: number,
    nivel: number,
    leidoEn: string
  ) {
    try {
      const { descuadre, admins } = await withTenant(tenantId, async (client) => {
        const descuadre = await service.evaluarDescuadre(
          client,
          tenantId,
          combustibleId,
          lecturaId,
          nivel,
          leidoEn
        );
        if (!descuadre) return { descuadre, admins: [] as { email: string; nombre: string }[] };

        await service.crearAlertas(client, tenantId, [
          {
            tipo: "descuadre_inventario",
            combustibleId,
            lecturaId,
            detalle: { ...descuadre },
          },
        ]);
        const admins = await service.findAdminsConCombustibleHabilitado(client, tenantId);
        return { descuadre, admins };
      });

      if (!descuadre) return;

      await publicarEventoTenant(tenantId, "combustible.alerta_creada", {
        tipo: "descuadre_inventario",
        combustibleId,
      });
      await enviarCorreoAlertaDescuadre(admins, descuadre);
    } catch (err) {
      logger.warn({ err, tenantId, combustibleId }, "No se pudo procesar la alerta de descuadre");
    }
  }

  /** Saldo acumulado del ciclo (migración 0076). Corre junto al descuadre
   *  por tramo y con el mismo contrato "nunca lanza": son dos preguntas
   *  distintas sobre la misma lectura -- "¿cerró este tramo?" y "¿cierra el
   *  ciclo desde que se cargó el tanque?" -- y la segunda es la que atrapa
   *  el faltante repartido en pedazos chicos.
   *
   *  También resuelve la alerta de "sin medir" si había una abierta: acaba
   *  de llegar una lectura, así que el problema que esa alerta reportaba
   *  dejó de existir. */
  private async procesarAlertaDescuadreCiclo(
    tenantId: string,
    combustibleId: number,
    lecturaId: number,
    nivel: number,
    leidoEn: string
  ) {
    try {
      const { ciclo, admins } = await withTenant(tenantId, async (client) => {
        await service.resolverAlertaSinMedirSiExiste(client, tenantId, combustibleId);

        const ciclo = await service.evaluarDescuadreCiclo(
          client,
          tenantId,
          combustibleId,
          lecturaId,
          nivel,
          leidoEn
        );
        if (!ciclo) return { ciclo, admins: [] as { email: string; nombre: string }[] };

        // UNA alerta abierta por tanque, no una por varilla (5ª auditoría):
        // mientras el acumulado siga pasado, cada varilla nueva actualiza la
        // misma alerta con los números al día y la vuelve a marcar como no
        // leída, pero no manda otro correo. Cinco varillas eran cinco alertas
        // y cinco correos iguales -- el ruido que hace que nadie las mire.
        const { nueva } = await service.registrarAlertaDeEstadoAcumulado(client, tenantId, {
          tipo: "descuadre_ciclo",
          combustibleId,
          lecturaId,
          detalle: { ...ciclo },
        });
        if (!nueva) return { ciclo: null, admins: [] as { email: string; nombre: string }[] };
        const admins = await service.findAdminsConCombustibleHabilitado(client, tenantId);
        return { ciclo, admins };
      });

      if (!ciclo) return;

      await publicarEventoTenant(tenantId, "combustible.alerta_creada", {
        tipo: "descuadre_ciclo",
        combustibleId,
      });
      await enviarCorreoAlertaDescuadreCiclo(admins, ciclo);
    } catch (err) {
      logger.warn(
        { err, tenantId, combustibleId },
        "No se pudo procesar la alerta de descuadre del ciclo"
      );
    }
  }

  /** Descuadre acumulado de la ventana deslizante (migración 0080). Se
   *  evalúa en cada lectura, igual que los otros dos descuadres, pero mira
   *  N días para atrás sin cortar en ninguna recepción -- es el único
   *  acumulado del módulo que no se reinicia con nada. */
  private async procesarAlertaDescuadreVentana(
    tenantId: string,
    combustibleId: number,
    lecturaId: number,
    leidoEn: string
  ) {
    try {
      const { ventana, admins } = await withTenant(tenantId, async (client) => {
        const ventana = await service.evaluarDescuadreVentana(
          client,
          tenantId,
          combustibleId,
          leidoEn
        );
        if (!ventana) return { ventana, admins: [] as { email: string; nombre: string }[] };

        // Misma deduplicación que el ciclo: una alerta abierta por tanque.
        const { nueva } = await service.registrarAlertaDeEstadoAcumulado(client, tenantId, {
          tipo: "descuadre_ventana",
          combustibleId,
          lecturaId,
          detalle: { ...ventana },
        });
        if (!nueva) return { ventana: null, admins: [] as { email: string; nombre: string }[] };
        const admins = await service.findAdminsConCombustibleHabilitado(client, tenantId);
        return { ventana, admins };
      });

      if (!ventana) return;

      await publicarEventoTenant(tenantId, "combustible.alerta_creada", {
        tipo: "descuadre_ventana",
        combustibleId,
      });
      await enviarCorreoAlertaDescuadreVentana(admins, ventana);
    } catch (err) {
      logger.warn(
        { err, tenantId, combustibleId },
        "No se pudo procesar la alerta de descuadre de la ventana"
      );
    }
  }

  /** Varilla cargada hacia atrás (migración 0078). Mismo contrato "nunca
   *  lanza" que el resto: la lectura ya se guardó y se respondió 201. */
  private async procesarAlertaLecturaRetroactiva(
    tenantId: string,
    combustibleId: number,
    lecturaId: number,
    nivel: number,
    leidoEn: string
  ) {
    try {
      const { retro, tanque, admins } = await withTenant(tenantId, async (client) => {
        const retro = await service.detectarLecturaRetroactiva(
          client,
          tenantId,
          combustibleId,
          lecturaId,
          leidoEn
        );
        if (!retro) {
          return { retro, tanque: null, admins: [] as { email: string; nombre: string }[] };
        }
        const tanque = await service.getById(client, tenantId, combustibleId);
        await service.crearAlertas(client, tenantId, [
          {
            tipo: "lectura_retroactiva",
            combustibleId,
            lecturaId,
            detalle: {
              tanqueNombre: tanque?.tanque_nombre ?? "",
              unidad: tanque?.unidad ?? "",
              nivel,
              leidoEn,
              posteriores: retro.posteriores,
            },
          },
        ]);
        const admins = await service.findAdminsConCombustibleHabilitado(client, tenantId);
        return { retro, tanque, admins };
      });

      if (!retro) return;

      await publicarEventoTenant(tenantId, "combustible.alerta_creada", {
        tipo: "lectura_retroactiva",
        combustibleId,
      });
      await enviarCorreoLecturaRetroactiva(admins, {
        tanqueNombre: tanque?.tanque_nombre ?? "",
        unidad: tanque?.unidad ?? "",
        nivel,
        leidoEn,
        posteriores: retro.posteriores,
      });
    } catch (err) {
      logger.warn(
        { err, tenantId, combustibleId },
        "No se pudo procesar la alerta de lectura retroactiva"
      );
    }
  }

  /** Mismo contrato "nunca lanza" que procesarAlertasDespachoCreado(). */
  private async procesarAlertaAnulacion(
    tenantId: string,
    despachoId: number,
    serieTalonario: string,
    nVale: number,
    motivo: string
  ) {
    try {
      const admins = await withTenant(tenantId, async (client) => {
        await service.crearAlertas(client, tenantId, [
          {
            tipo: "vale_anulado",
            serieTalonario,
            nVale,
            despachoId,
            detalle: { motivo },
          },
        ]);
        return service.findAdminsConCombustibleHabilitado(client, tenantId);
      });

      await publicarEventoTenant(tenantId, "combustible.alerta_creada", {
        tipo: "vale_anulado",
        serieTalonario,
        nVale,
      });
      await enviarCorreoAlertaAnulacion(admins, { serieTalonario, nVale, motivo });
    } catch (err) {
      logger.warn({ err, tenantId, despachoId }, "No se pudo procesar la alerta de vale anulado");
    }
  }

  /** GET /despachos -- listado paginado, con filtro opcional por equipo,
   *  serie de talonario y período. Sin conciliación ni anomalías acá: eso
   *  es Fase D. */
  async listarDespachos(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const paginacion = parsePaginacion(req.query);
      const equipoIdRaw = req.query.equipo_id;
      const equipoId =
        typeof equipoIdRaw === "string" && equipoIdRaw.trim() !== ""
          ? Number(equipoIdRaw)
          : undefined;
      const serieTalonario =
        typeof req.query.serie_talonario === "string" ? req.query.serie_talonario : undefined;
      const origenRaw = req.query.origen;
      const origen =
        origenRaw === "tanque_propio" || origenRaw === "compra_externa" ? origenRaw : undefined;
      // Migración 0092: sin filtro, la pestaña de urea (y la de combustible)
      // verían los vales del otro producto mezclados en el mismo listado.
      const producto =
        req.query.producto === "urea" || req.query.producto === "combustible"
          ? req.query.producto
          : undefined;
      const { desde, hasta } = req.validatedQuery as PeriodoHistorialCombustibleQuery;

      const filas = await withTenant(tenantId, (client) =>
        service.listarDespachos(
          client,
          tenantId,
          { equipoId, serieTalonario, origen, producto, desde, hasta },
          paginacion
        )
      );
      res.json(armarRespuestaPaginada(filas, paginacion));
    } catch {
      res.status(500).json({ error: "Error al listar despachos" });
    }
  }

  /** Días/semana/mes/año, o nada (todo el rango junto). Mismo criterio que
   *  origen en listarDespachos: se valida a mano contra un allowlist fijo
   *  en vez de con Zod, porque es un solo query param suelto que no
   *  justifica un schema aparte -- y el repository lo vuelve a chequear
   *  contra el mismo allowlist antes de tocar el SQL (ver TRUNC_SQL). */
  private leerAgruparPor(req: Request): string | undefined {
    const valor = req.query.agrupar_por;
    return valor === "dia" || valor === "semana" || valor === "mes" || valor === "anio"
      ? valor
      : undefined;
  }

  /** `?producto=` en los tres rankings de consumo -- bug encontrado
   *  2026-09-17: sumaban litros de combustible y de urea juntos porque
   *  nadie filtraba. Default 'combustible' porque es el comportamiento que
   *  ya tenían estos tres endpoints antes de que la urea existiera --
   *  HistoricoCliente.tsx (que no manda el parámetro) sigue viendo
   *  exactamente lo mismo que veía. */
  private leerProductoConsumo(req: Request): "combustible" | "urea" {
    return req.query.producto === "urea" ? "urea" : "combustible";
  }

  /** GET /consumo-por-conductor -- Histórico -> Consumo por conductor, la
   *  pestaña que mira el cliente. Sin paginar (ver el repository), por eso
   *  no arma respuesta paginada como el resto de los listados. */
  async getConsumoPorConductor(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const { desde, hasta } = req.validatedQuery as PeriodoHistorialCombustibleQuery;
      const agruparPor = this.leerAgruparPor(req);
      const producto = this.leerProductoConsumo(req);
      const filas = await withTenant(tenantId, (client) =>
        service.listarConsumoPorConductor(client, tenantId, producto, { desde, hasta }, agruparPor)
      );
      res.json({ data: filas });
    } catch {
      res.status(500).json({ error: "Error al calcular el consumo por conductor" });
    }
  }

  /** GET /consumo-por-vehiculo -- Histórico -> Consumo por vehículo/unidad. */
  async getConsumoPorVehiculo(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const { desde, hasta } = req.validatedQuery as PeriodoHistorialCombustibleQuery;
      const agruparPor = this.leerAgruparPor(req);
      const producto = this.leerProductoConsumo(req);
      const filas = await withTenant(tenantId, (client) =>
        service.listarConsumoPorEquipo(client, tenantId, producto, { desde, hasta }, agruparPor)
      );
      res.json({ data: filas });
    } catch {
      res.status(500).json({ error: "Error al calcular el consumo por vehículo" });
    }
  }

  /** GET /consumo-por-grifo -- Histórico -> Ranking por grifo (interno y
   *  cada externo). Sumar sus filas por tipo_grifo es la conciliación
   *  interno-vs-externo que pidió Kenif, sin tener que sumarla a mano. */
  async getConsumoPorGrifo(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const { desde, hasta } = req.validatedQuery as PeriodoHistorialCombustibleQuery;
      const agruparPor = this.leerAgruparPor(req);
      const producto = this.leerProductoConsumo(req);
      const filas = await withTenant(tenantId, (client) =>
        service.listarConsumoPorGrifo(client, tenantId, producto, { desde, hasta }, agruparPor)
      );
      res.json({ data: filas });
    } catch {
      res.status(500).json({ error: "Error al calcular el consumo por grifo" });
    }
  }

  /** GET /despachos/huecos?serie_talonario=XXX -- punto 1 reescrito: una
   *  consulta bajo demanda, sin paginar ni filtrar por fecha (a propósito,
   *  ver el diseño de Fase B). `validate()` solo parsea el body, así que
   *  el query param se valida acá a mano, mismo patrón que el resto del
   *  repo (ver ordenes_trabajo.controller.ts / documentos.controller.ts). */
  async getHuecosTalonario(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const serieTalonario = req.query.serie_talonario;
      if (typeof serieTalonario !== "string" || serieTalonario.trim() === "") {
        res.status(400).json({ error: "El query param serie_talonario es obligatorio" });
        return;
      }
      // Migración 0092: sin este filtro, un talonario de urea con el mismo
      // NOMBRE que uno de combustible mezclaría sus huecos.
      const producto = req.query.producto === "urea" ? "urea" : "combustible";

      const resultado = await withTenant(tenantId, (client) =>
        service.detectarHuecos(client, tenantId, serieTalonario, producto)
      );
      res.json(resultado);
    } catch {
      res.status(500).json({ error: "Error al calcular huecos de talonario" });
    }
  }

  // ── Alertas (migrations/0068) ─────────────────────────────────────────

  /** GET /alertas -- pantalla y campanita comparten este mismo listado
   *  (la campanita solo pide ?solo_no_leidas=true). Visibilidad de
   *  gerencia, no del operador (ver combustible.routes.ts). */
  async listarAlertas(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const paginacion = parsePaginacion(req.query);
      const soloNoLeidas = req.query.solo_no_leidas === "true";
      // Filtro por producto (migración 0092): sin él, la pestaña de urea
      // vería mezcladas sus propias alertas con las de diésel/gasolina/glp.
      const producto =
        req.query.producto === "urea" || req.query.producto === "combustible"
          ? req.query.producto
          : undefined;

      const filas = await withTenant(tenantId, (client) =>
        service.listarAlertas(client, tenantId, { soloNoLeidas, producto }, paginacion)
      );
      res.json(armarRespuestaPaginada(filas, paginacion));
    } catch {
      res.status(500).json({ error: "Error al listar alertas" });
    }
  }

  /** PATCH /alertas/leidas -- sin `ids` marca TODAS las no leídas del
   *  tenant (el botón "marcar todas como leídas" de la campanita). Estado
   *  compartido entre admins, no por usuario (ver migrations/0068). */
  async marcarAlertasLeidas(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const { ids } = req.validatedBody as MarcarAlertasLeidasCombustibleInput;
      await withTenant(tenantId, (client) => service.marcarAlertasLeidas(client, tenantId, ids));
      res.status(204).send();
    } catch {
      res.status(500).json({ error: "Error al marcar alertas como leídas" });
    }
  }

  /** PATCH /alertas/:alertaId/resolver -- revisión manual, con MOTIVO
   *  obligatorio (0077). Aplica a los siete tipos que necesitan que alguien
   *  los mire; los que se resuelven solos (hueco, nivel bajo, sin medir) no
   *  están en la lista -- ver TIPOS_REVISABLES en el repository.
   *
   *  404 si no existe o es de otro tipo/ya estaba resuelta: el repository no
   *  distingue esos casos porque acá no hace falta, no hay nada que corregir
   *  aparte de reintentar. */
  async resolverAlertaManual(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const alertaId = Number(req.params.alertaId);
      const { motivo } = req.validatedBody as ResolverAlertaCombustibleInput;

      const resuelta = await withTenant(tenantId, (client) =>
        service.resolverAlertaManual(client, tenantId, alertaId, req.usuario!.id, motivo)
      );
      if (!resuelta) {
        res
          .status(404)
          .json({ error: "Alerta no encontrada, ya revisada, o no es de tipo revisable" });
        return;
      }

      // CERRAR UNA ALERTA NO SE AUDITABA. Quedaba el `resuelta_por` en la
      // propia fila, pero nada en la bitácora -- así que "¿quién dio por
      // revisados los faltantes de agosto?" no se podía contestar desde la
      // pantalla que existe para contestar justamente eso.
      //
      // Y cuando el que cierra es el mismo que cargó el movimiento, va con
      // acción propia: es el hallazgo de segregación de funciones, y tiene
      // que poder filtrarse sin leer todos los cierres uno por uno.
      await registrarAuditoria({
        accion: resuelta.autorevision
          ? "combustible.alerta_autorevisada"
          : "combustible.alerta_resuelta",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: {
          alertaId,
          tipo: resuelta.tipo,
          motivo,
          autorevision: resuelta.autorevision,
        },
        contexto: contextoAuditoriaModulo(req),
      });

      res.json(resuelta);
    } catch {
      res.status(500).json({ error: "Error al resolver la alerta" });
    }
  }

  /** GET /bitacora -- el historial de cambios del módulo, para el PROPIO
   *  tenant.
   *
   *  Hasta acá todo quedaba registrado pero solo lo podía ver el dueño del
   *  software desde el panel de plataforma. Un control que únicamente puede
   *  revisar el proveedor no es un control de la empresa: gerencia tiene que
   *  poder responder "¿quién cambió esto?" sin pedirle nada a nadie.
   *
   *  Reusa `listarAuditoriaService` en vez de consultar `platform_audit_log`
   *  desde acá, y no es casualidad: esa tabla NO tiene RLS, y el servicio ya
   *  resuelve bien las dos trampas que trae -- filtrar por tenant a mano, y
   *  resolver los nombres de `usuarios` (que SÍ tiene RLS) agrupando por
   *  tenant dentro de withTenant(). Duplicar esa lógica acá era la forma
   *  segura de equivocarse. El lint del repo directamente prohíbe importar
   *  `pool` en un controller de módulo, por este mismo motivo.
   *
   *  El `tenantId` sale de la sesión, nunca del query: si viniera del
   *  cliente, un admin podría pedir la bitácora de otra empresa.
   *
   *  Solo admin, como el resto de la visibilidad de gerencia. */
  async listarBitacora(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const paginacion = parsePaginacion(req.query);
      const desde = typeof req.query.desde === "string" ? req.query.desde : undefined;
      const hasta = typeof req.query.hasta === "string" ? req.query.hasta : undefined;

      const pagina = await listarAuditoriaService({
        tenantId,
        accionPrefijo: "combustible.",
        // Vive en el módulo de Equipos pero afloja un control de combustible
        // (el techo diario por equipo), así que tiene que verse acá: es la
        // pantalla donde gerencia busca quién tocó qué de la vigilancia.
        accionesExtra: ["equipos.capacidad_tanque_ampliada"],
        desde,
        hasta,
        limit: paginacion.pageSize,
      });

      // Se traduce a la forma que ya usa el resto del módulo (snake_case y
      // un `usuario` legible) en vez de filtrar el shape del panel de
      // plataforma hacia la pantalla del tenant.
      const filas = pagina.entradas.map((e) => ({
        id: e.id,
        accion: e.accion,
        // null = lo hizo el sistema (un worker), no una persona. Decirlo
        // explícitamente evita que se lea como un dato faltante.
        usuario: e.usuarioId ? (e.usuarioEmail ?? "Usuario eliminado") : "Sistema",
        detalle: e.detalle,
        creado_en: e.creadoEn,
      }));

      // Sin `armarRespuestaPaginada`: ese helper espera un `total_count` que
      // la auditoría no calcula (pagina por cursor, no por offset). La forma
      // `{ data }` es la que el panel ya consume.
      res.json({ data: filas, pagination: { pageSize: paginacion.pageSize } });
    } catch {
      res.status(500).json({ error: "Error al obtener la bitácora" });
    }
  }

  // ── Conciliación (migraciones 0071/0072) ──────────────────────────────

  /** GET /config -- hoy solo la ventana de gracia. Un tenant que nunca la
   *  tocó igual recibe el default (72h), no un 404: para quien consulta no
   *  hay diferencia entre "no configurada" y "configurada en el default". */
  async getConfig(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const config = await withTenant(tenantId, (client) => service.getConfig(client, tenantId));
      res.json(config);
    } catch {
      res.status(500).json({ error: "Error al obtener la configuración de combustible" });
    }
  }

  /** PUT /config -- subir la ventana AFLOJA el control (los hallazgos
   *  tardan más en congelarse), así que se audita con el "quién" como
   *  cualquier acción correctiva. */
  async guardarConfig(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const nueva = req.validatedBody as ConfigCombustibleInput;

      // Qué se afloja hay que medirlo ANTES de guardar, contra lo que había.
      // Subir la ventana o los días sin medir, y subir o apagar cualquiera de
      // los dos topes de 0079, debilitan la vigilancia sin tocar un solo vale
      // ni un solo tanque -- que era la forma más cómoda de robar que quedaba.
      // Qué se afloja se decide ANTES de guardar, y si afloja sin motivo no se
      // guarda nada: mismo trato que la ficha del tanque. Hasta la 5ª
      // auditoría la config era la excepción -- apagar un tope o alargar la
      // ventana de gracia se guardaba sin explicar nada.
      const antesDeGuardar = await withTenant(tenantId, (client) =>
        service.getConfig(client, tenantId)
      );
      const aflojaSinMotivo = service.evaluarAflojamientoConfig(antesDeGuardar, nueva);
      if (aflojaSinMotivo.length > 0 && !nueva.motivo_ajuste) {
        const detalle = aflojaSinMotivo.map((c) => `${c.control}: ${c.de} → ${c.a}`).join("; ");
        res.status(400).json({
          error:
            `Este cambio reduce la vigilancia del módulo (${detalle}). ` +
            `Indicá el motivo para dejarlo registrado.`,
          requiere_motivo: true,
          aflojados: aflojaSinMotivo,
        });
        return;
      }

      const { guardada, aflojados } = await withTenant(tenantId, async (client) => {
        const antes = await service.getConfig(client, tenantId);
        const aflojados = service.evaluarAflojamientoConfig(antes, nueva);
        const guardada = await service.guardarConfig(
          client,
          tenantId,
          {
            ventanaGraciaHoras: nueva.ventana_gracia_horas,
            diasSinMedir: nueva.dias_sin_medir,
            diasVentanaDescuadre: nueva.dias_ventana_descuadre,
            diasCargaRetroactiva: nueva.dias_carga_retroactiva,
            diasSinVigilancia: nueva.dias_sin_vigilancia,
            llenadosPorDiaMax: nueva.llenados_por_dia_max,
            topeSinCapacidadL: nueva.tope_diario_sin_capacidad_l,
            grifieroRegistraVarilla: nueva.grifero_registra_varilla,
            recepcionRequiereValidacion: nueva.recepcion_requiere_validacion,
            horasParaValidarRecepcion: nueva.horas_para_validar_recepcion,
            diasSinVarillaDeControl: nueva.dias_sin_varilla_de_control,
            topeDiarioUreaL: nueva.tope_diario_urea_l,
            ratioUreaDieselMaxPct: nueva.ratio_urea_diesel_max_pct,
            diasSinConteoUrea: nueva.dias_sin_conteo_urea,
          },
          req.usuario!.id
        );
        return { guardada, aflojados };
      });

      await registrarAuditoria({
        // Misma distinción que en el tanque (#143): una acción propia para
        // "acá se redujo la vigilancia" hace que buscar quién apagó un
        // control no obligue a leer todos los cambios de config uno por uno.
        accion:
          aflojados.length > 0
            ? "combustible.config_vigilancia_reducida"
            : "combustible.config_actualizar",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle:
          aflojados.length > 0
            ? { ...nueva, aflojados, motivo: nueva.motivo_ajuste }
            : { ventanaGraciaHoras: nueva.ventana_gracia_horas },
        contexto: contextoAuditoriaModulo(req),
      });

      if (aflojados.length > 0) {
        // Nunca bloquea: el cambio ya está guardado y auditado (mismo
        // criterio que el aflojamiento del tanque).
        try {
          const admins = await withTenant(tenantId, (client) =>
            service.findAdminsConCombustibleHabilitado(client, tenantId)
          );
          await enviarCorreoVigilanciaReducida(admins, {
            quien: req.usuario!.nombre ?? req.usuario!.email ?? "Un administrador",
            objeto: "la configuración del módulo de combustible",
            motivo: nueva.motivo_ajuste ?? "",
            cambios: aflojados,
          });
        } catch (err) {
          logger.warn({ err, tenantId }, "No se pudo avisar del aflojamiento de configuración");
        }
      }
      await publicarEventoTenant(tenantId, "combustible.config_actualizada", {
        ventanaGraciaHoras: nueva.ventana_gracia_horas,
      });
      res.json(guardada);
    } catch {
      res.status(500).json({ error: "Error al guardar la configuración de combustible" });
    }
  }

  /** GET /:id/kardex?desde=&hasta= -- el movimiento del tanque en UNA línea
   *  de tiempo, con saldo corriente. Es lo primero que pide un auditor y
   *  hasta ahora el módulo solo tenía tres historiales separados.
   *
   *  Solo admin, igual que la bitácora y las alertas: es visibilidad de
   *  gerencia, no trabajo de cancha.
   *
   *  Sin paginar a propósito. Un kardex paginado no sirve: el saldo corriente
   *  y el descuadre acumulado solo tienen sentido si se ve el período
   *  entero. El período se acota con las fechas, no con páginas -- por eso
   *  el schema exige las dos y limita el rango. */
  async getKardex(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);
      const { desde, hasta } = req.validatedQuery as KardexCombustibleQuery;

      const kardex = await withTenant(tenantId, (client) =>
        service.armarKardex(client, tenantId, id, desde, hasta)
      );
      if (!kardex) {
        res.status(404).json({ error: "Tanque no encontrado" });
        return;
      }
      res.json(kardex);
    } catch {
      res.status(500).json({ error: "Error al armar el kardex del tanque" });
    }
  }

  /** GET /:id/kardex/csv -- el mismo kardex, para llevárselo.
   *
   *  Reusa `armarKardex` entero: el archivo y la pantalla no pueden salir de
   *  dos cálculos distintos, o el día que difieran nadie va a saber cuál
   *  creer. Acá solo se serializa.
   *
   *  El .xlsx con formato queda pendiente (Kenif lo pidió como segunda
   *  opción). Cuando llegue, se le enchufa otro serializador a estos mismos
   *  datos -- por eso el armado vive en el service y no acá. */
  async getKardexCsv(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);
      const { desde, hasta } = req.validatedQuery as KardexCombustibleQuery;

      const kardex = await withTenant(tenantId, (client) =>
        service.armarKardex(client, tenantId, id, desde, hasta)
      );
      if (!kardex) {
        res.status(404).json({ error: "Tanque no encontrado" });
        return;
      }

      const u = kardex.tanque.unidad;
      const csv = armarCsv(
        [
          "Fecha",
          "Movimiento",
          "Documento",
          "Detalle",
          `Entrada (${u})`,
          `Salida (${u})`,
          `Saldo teórico (${u})`,
          `Medido (${u})`,
          `Dif. tramo (${u})`,
          `Dif. acumulada (${u})`,
          "Quién",
          "Anulado / histórico",
          "Motivo de anulación",
        ],
        kardex.filas.map((f) => [
          // Fecha local y no ISO: con el ISO, Excel trata la columna como
          // texto y el auditor no puede ordenar por fecha, que es lo primero
          // que hace.
          new Date(f.ocurrido_en).toLocaleString("es-PE", { timeZone: "America/Lima" }),
          f.tipo === "recepcion"
            ? "Recepción"
            : f.tipo === "despacho"
              ? "Despacho"
              : f.tipo === "precinto"
                ? "Precinto"
                : "Varilla",
          f.documento,
          f.detalle,
          f.entrada || "",
          f.salida || "",
          f.saldo_teorico,
          f.nivel_medido,
          f.dif_tramo,
          f.dif_acumulada,
          f.usuario,
          f.anulada ? "SÍ" : f.historico ? "HISTÓRICO" : "",
          f.motivo_anulacion,
        ])
      );

      // Se audita ANTES de entregar el archivo, no después. Dos motivos: es
      // la convención del módulo entero (auditar y recién ahí responder), y
      // acá además importa el orden -- si el registro se escribiera después
      // del `send`, la respuesta ya salió y una falla del registro dejaría
      // el dato afuera sin rastro de quién se lo llevó.
      //
      // Llevarse el movimiento del tanque ES una acción de auditoría, no una
      // consulta más: si mañana ese archivo aparece circulando, el registro
      // dice de dónde salió.
      await registrarAuditoria({
        accion: "combustible.kardex_exportar",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: {
          combustibleId: id,
          codigo: kardex.tanque.codigo,
          desde,
          hasta,
          filas: kardex.filas.length,
          descuadreFinal: kardex.resumen.descuadre_final,
        },
        contexto: contextoAuditoriaModulo(req),
      });

      const archivo = sanearNombreArchivo(
        `kardex-${kardex.tanque.codigo}-${desde.slice(0, 10)}-a-${hasta.slice(0, 10)}.csv`
      );
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${archivo}"`);
      res.send(csv);
    } catch {
      res.status(500).json({ error: "Error al exportar el kardex" });
    }
  }

  /** GET /:id/kardex/xlsx -- el mismo kardex, en planilla de verdad.
   *
   *  Convive con el CSV, no lo reemplaza: el CSV lo abre cualquier cosa y
   *  sirve para pegar en otro sistema. Lo que agrega el .xlsx es lo que el
   *  CSV no puede dar por definición -- números que son números (un faltante
   *  de -300 se SUMA, no es texto), dos hojas, y totales como fórmulas vivas
   *  que se recalculan si el auditor filtra o borra filas.
   *
   *  Sale del mismo `armarKardex` que la pantalla y que el CSV, por la misma
   *  razón de siempre: tres cálculos distintos para el mismo número es tener
   *  tres versiones de la verdad. */
  async getKardexXlsx(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);
      const { desde, hasta } = req.validatedQuery as KardexCombustibleQuery;

      const kardex = await withTenant(tenantId, (client) =>
        service.armarKardex(client, tenantId, id, desde, hasta)
      );
      if (!kardex) {
        res.status(404).json({ error: "Tanque no encontrado" });
        return;
      }

      const u = kardex.tanque.unidad;
      const encabezados: CeldaXlsx[] = [
        "Fecha",
        "Movimiento",
        "Documento",
        "Detalle",
        `Entrada (${u})`,
        `Salida (${u})`,
        `Saldo teórico (${u})`,
        `Medido (${u})`,
        `Dif. tramo (${u})`,
        `Dif. acumulada (${u})`,
        "Quién",
        "Anulado / histórico",
        "Motivo de anulación",
      ].map((t) => ({ valor: t, negrita: true }));

      // Litros con 2 decimales: sin formato, una planilla muestra los números
      // como vienen ("17650" o "385.925925925926") y quien la abre no sabe
      // qué decimales importan.
      const litros = (v: number | null | undefined): CeldaXlsx =>
        v === null || v === undefined ? null : { valor: v, formato: "decimal" };

      const filas: CeldaXlsx[][] = kardex.filas.map((f) => [
        fechaLima(f.ocurrido_en),
        f.tipo === "recepcion"
          ? "Recepción"
          : f.tipo === "despacho"
            ? "Despacho"
            : f.tipo === "precinto"
              ? "Precinto"
              : "Varilla",
        f.documento,
        f.detalle,
        litros(f.entrada || null),
        litros(f.salida || null),
        litros(f.saldo_teorico),
        litros(f.nivel_medido),
        litros(f.dif_tramo),
        litros(f.dif_acumulada),
        f.usuario,
        f.anulada ? "SÍ" : f.historico ? "HISTÓRICO" : null,
        f.motivo_anulacion,
      ]);

      // Los totales del resumen van como FÓRMULA sobre la hoja de detalle, no
      // como número calculado acá. Así el auditor que filtra o borra filas ve
      // el total moverse con lo que está mirando -- que es exactamente para lo
      // que se lleva la planilla.
      const ultima = filas.length + 1; // +1 por la fila de encabezados
      const rango = (col: string) =>
        filas.length > 0 ? `Kardex!${col}2:${col}${ultima}` : `Kardex!${col}2`;

      const resumen: CeldaXlsx[][] = [
        [
          {
            valor: `Kardex ${kardex.tanque.codigo} -- ${kardex.tanque.tanque_nombre}`,
            negrita: true,
          },
        ],
        [],
        ["Período desde", desde.slice(0, 10)],
        ["Período hasta", hasta.slice(0, 10)],
        [`Capacidad (${u})`, { valor: kardex.tanque.capacidad_total, formato: "entero" }],
        [],
        [{ valor: "TOTALES DEL PERÍODO", negrita: true }],
        // Las filas HISTÓRICAS (anteriores a la primera varilla) también se
        // saltean: se ven, pero no mueven el saldo -- ver `armarKardex`.
        // Las filas anuladas se SALTEAN (columna L = "SÍ"), igual que en
        // `armarKardex`. Siguen en la hoja de detalle porque son evidencia,
        // pero un vale anulado no sacó combustible: sumarlo daba otro total
        // que el de la pantalla. Lo encontró la verificación contra el tenant
        // redteam -- 12.170 L en el archivo contra 11.270 en pantalla, y la
        // diferencia era exactamente el vale de 900 L anulado.
        [
          `Entradas (${u})`,
          {
            formula: `SUMIFS(${rango("E")},${rango("L")},"<>SÍ",${rango("L")},"<>HISTÓRICO")`,
            formato: "decimal",
          },
        ],
        [
          `Salidas (${u})`,
          {
            formula: `SUMIFS(${rango("F")},${rango("L")},"<>SÍ",${rango("L")},"<>HISTÓRICO")`,
            formato: "decimal",
          },
        ],
        [
          "Mediciones (varillas)",
          { formula: `COUNTIFS(${rango("H")},"<>",${rango("L")},"<>SÍ")`, formato: "entero" },
        ],
        [`Saldo al inicio (${u})`, litros(kardex.saldo_inicial)],
        [
          `Descuadre final (${u})`,
          // El acumulado de la ÚLTIMA varilla, que es el número que va al
          // informe. `null` cuando no hubo ninguna medición: decir "0" ahí
          // sería afirmar que cuadra, y lo cierto es que no se midió.
          litros(kardex.resumen.descuadre_final),
        ],
        [],
        [{ valor: "SOLO LOS FALTANTES", negrita: true }],
        [
          `Suma de los tramos en negativo (${u})`,
          { formula: `SUMIF(${rango("I")},"<0")`, formato: "decimal" },
        ],
        ["Tramos con faltante", { formula: `COUNTIF(${rango("I")},"<0")`, formato: "entero" }],
      ];

      const libro = armarXlsx([
        {
          nombre: "Kardex",
          filas: [encabezados, ...filas],
          anchos: [19, 12, 16, 18, 12, 12, 14, 12, 12, 14, 18, 9, 26],
        },
        { nombre: "Resumen", filas: resumen, anchos: [34, 18] },
      ]);

      // Mismo criterio que el CSV: se audita ANTES de entregar el archivo.
      // Llevarse el movimiento del tanque es una acción de auditoría, no una
      // consulta -- si mañana ese archivo aparece circulando, el registro
      // dice de dónde salió.
      await registrarAuditoria({
        accion: "combustible.kardex_exportar",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: {
          combustibleId: id,
          codigo: kardex.tanque.codigo,
          desde,
          hasta,
          filas: kardex.filas.length,
          descuadreFinal: kardex.resumen.descuadre_final,
          formato: "xlsx",
        },
        contexto: contextoAuditoriaModulo(req),
      });

      const archivo = sanearNombreArchivo(
        `kardex-${kardex.tanque.codigo}-${desde.slice(0, 10)}-a-${hasta.slice(0, 10)}.xlsx`
      );
      res.setHeader("Content-Type", CONTENT_TYPE_XLSX);
      res.setHeader("Content-Disposition", `attachment; filename="${archivo}"`);
      res.send(libro);
    } catch {
      res.status(500).json({ error: "Error al exportar el kardex" });
    }
  }

  /** GET /reportes/controles?desde=&hasta= -- ESTADO DE LA VIGILANCIA
   *  DURANTE EL PERÍODO, que no es lo mismo que su estado de hoy.
   *
   *  Sale de la conversación sobre qué hace un auditor. El correo de
   *  aflojamiento avisa en el momento, pero se esquiva eligiendo la hora:
   *  bajar el umbral un viernes a la noche, sacar el sábado, reponerlo el
   *  domingo. El lunes la ficha del tanque se ve impecable y nadie tiene por
   *  qué sospechar.
   *
   *  Lo que el ladrón NO puede hacer es reescribir el registro. Este reporte
   *  lee esa historia y le pone al lado el número que la vuelve un hallazgo:
   *  cuánto combustible salió DESPUÉS de cada aflojamiento, dentro del
   *  período. "Alguien subió el umbral el viernes" es una anécdota; "y en esa
   *  ventana salieron 14.000 L" es una pregunta que alguien tiene que
   *  contestar.
   *
   *  Dos mitades:
   *  - La PELÍCULA: cada evento que redujo la vigilancia en el período, con
   *    quién, qué control, de cuánto a cuánto, el motivo declarado, y los
   *    litros que se movieron después.
   *  - La FOTO: cómo está cada tanque HOY. Un control apagado hoy no aparece
   *    como evento si se apagó antes del período. */
  async getReporteControles(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const { desde, hasta } = req.validatedQuery as KardexCombustibleQuery;

      // Se reusa el servicio de auditoría por el mismo motivo que la
      // bitácora: `platform_audit_log` NO tiene RLS, y ese servicio ya
      // resuelve el filtrado por tenant y los nombres de usuario.
      const pagina = await listarAuditoriaService({
        tenantId,
        accionPrefijo: "combustible.",
        accionesExtra: ["equipos.capacidad_tanque_ampliada"],
        desde,
        hasta,
        limit: 200,
      });

      const ACCIONES_QUE_AFLOJAN = new Set([
        "combustible.tanque_vigilancia_reducida",
        "combustible.config_vigilancia_reducida",
        "combustible.alerta_autorevisada",
        "equipos.capacidad_tanque_ampliada",
      ]);

      const crudos = pagina.entradas.filter((e) => ACCIONES_QUE_AFLOJAN.has(e.accion));

      const { eventos, tanques } = await withTenant(tenantId, async (client) => {
        const eventos = [];
        for (const e of crudos) {
          const d = (e.detalle ?? {}) as Record<string, unknown>;
          const combustibleId = typeof d.combustibleId === "number" ? d.combustibleId : null;
          // Desde el instante del aflojamiento hasta el fin del período: la
          // ventana en la que el control estuvo debilitado, salvo que se haya
          // repuesto antes (eso se ve mirando el evento siguiente).
          const desdeEvento = new Date(e.creadoEn).toISOString();
          const movimiento = await service.findDespachadoEntre(
            client,
            tenantId,
            desdeEvento,
            hasta,
            combustibleId
          );

          // LO QUE DICE LA VARILLA, que es la mitad que faltaba. Un red team
          // subió los tres umbrales a 60 %, sacó 3.000 L sin emitir vale, y
          // este reporte informó "0 L": contaba despachos DECLARADOS, y
          // aflojar el umbral sirve justamente para no declarar.
          //
          // Se calcula ignorando el umbral configurado. El umbral decide si
          // se ALERTA en el momento; nunca si el número existe después.
          const medido = await service.findDescuadreEntre(
            client,
            tenantId,
            desdeEvento,
            hasta,
            combustibleId
          );
          eventos.push({
            cuando: e.creadoEn,
            accion: e.accion,
            quien: e.usuarioId ? (e.usuarioEmail ?? "Usuario eliminado") : "Sistema",
            combustible_id: combustibleId,
            motivo: (d.motivo as string) ?? null,
            aflojados:
              (d.aflojados as unknown[]) ??
              (d.de ? [{ control: "Capacidad de tanque del equipo", de: d.de, a: d.a }] : []),
            detalle: d,
            despachado_despues_l: Number(movimiento.litros.toFixed(2)),
            vales_despues: movimiento.vales,
            // null y no 0 cuando no hubo mediciones: "no se midió" y "cuadra"
            // no son lo mismo, y confundirlos sería repetir el error que este
            // arreglo corrige.
            descuadre_medido_l: medido.tramos === 0 ? null : Number(medido.descuadre.toFixed(2)),
            mediciones_despues: medido.tramos,
          });
        }
        const tanques = await service.findEstadoVigilancia(client, tenantId);
        return { eventos, tanques };
      });

      res.json({
        periodo: { desde, hasta },
        eventos,
        // La foto de hoy: qué controles tiene apagados cada tanque. `activo`
        // incluido -- un tanque desactivado sale del aviso por falta de
        // medición, así que su estado es parte de la respuesta.
        tanques: tanques.map((t: Record<string, unknown>) => {
          const apagados: string[] = [];
          if (t.umbral_descuadre_pct === null) apagados.push("descuadre entre varillas");
          if (t.umbral_descuadre_ciclo_pct === null) apagados.push("acumulado del ciclo");
          if (t.umbral_descuadre_ventana_pct === null) apagados.push("acumulado de la ventana");
          if (t.umbral_diferencia_pct === null) apagados.push("diferencia con la factura");
          return {
            id: t.id,
            codigo: t.codigo,
            tanque_nombre: t.tanque_nombre,
            activo: t.activo,
            controles_apagados: apagados,
            vigilancia:
              apagados.length === 0 ? "completa" : apagados.length === 4 ? "ninguna" : "parcial",
          };
        }),
        resumen: {
          eventos: eventos.length,
          litros_bajo_vigilancia_reducida: Number(
            eventos.reduce((a, e) => a + e.despachado_despues_l, 0).toFixed(2)
          ),
          // El número que un auditor copia al informe: cuánto NO se puede
          // explicar de lo que pasó mientras la vigilancia estuvo baja. Se
          // toma el peor evento y no la suma, porque las ventanas de dos
          // eventos se superponen y sumarlas contaría el mismo faltante dos
          // veces.
          peor_descuadre_medido_l: eventos.reduce<number | null>((peor, e) => {
            if (e.descuadre_medido_l === null) return peor;
            if (peor === null) return e.descuadre_medido_l;
            return Math.abs(e.descuadre_medido_l) > Math.abs(peor) ? e.descuadre_medido_l : peor;
          }, null),
          sin_mediciones: eventos.filter((e) => e.descuadre_medido_l === null).length,
        },
      });
    } catch {
      res.status(500).json({ error: "Error al armar el reporte de controles" });
    }
  }

  /** GET /reportes/segregacion?desde=&hasta= -- QUIÉN HACE Y QUIÉN CONTROLA.
   *
   *  El último de los cuatro reportes que salieron de la charla sobre el rol
   *  del auditor. La pregunta que contesta es la que un auditor hace siempre:
   *  ¿la misma persona que despacha es la que anula, corrige y da por
   *  revisados los faltantes?
   *
   *  NO ACUSA, CUENTA. En una operación chica la respuesta suele ser "sí", y
   *  eso no es un delito -- es un riesgo que hay que conocer para
   *  compensarlo (que alguien más revise el reporte, por ejemplo). Un
   *  reporte que gritara "fraude" cada vez que hay un solo operador se
   *  ignoraría en una semana, que es como mueren los controles.
   *
   *  La distinción que importa está en las dos columnas de "propias": no es
   *  lo mismo anular el vale de otro --que deja dos personas en la
   *  historia-- que anular el propio, donde el que se equivoca y el que
   *  corrige son la misma persona y nadie más se entera. */
  async getReporteSegregacion(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const { desde, hasta } = req.validatedQuery as KardexCombustibleQuery;

      const filas = await withTenant(tenantId, (client) =>
        service.findSegregacion(client, tenantId, desde, hasta)
      );

      const personas = filas.map((f: Record<string, unknown>) => ({
        persona: f.persona,
        usuario_id: f.usuario_id,
        vales_cargados: Number(f.vales_cargados),
        recepciones_cargadas: Number(f.recepciones_cargadas),
        lecturas_cargadas: Number(f.lecturas_cargadas),
        precintos_colocados: Number(f.precintos_colocados),
        anulaciones: Number(f.anulaciones),
        anulaciones_propias: Number(f.anulaciones_propias),
        alertas_revisadas: Number(f.alertas_revisadas),
        autorevisiones: Number(f.autorevisiones),
      }));

      const totalCargas = personas.reduce(
        (a, p) => a + p.vales_cargados + p.recepciones_cargadas + p.lecturas_cargadas,
        0
      );

      res.json({
        periodo: { desde, hasta },
        personas,
        resumen: {
          personas: personas.length,
          // Si UNA sola persona hizo todo, no hay segregación posible: es el
          // dato que ordena la conversación, mucho antes que cualquier
          // sospecha puntual.
          concentracion_pct:
            totalCargas === 0
              ? null
              : Number(
                  (
                    (Math.max(
                      ...personas.map(
                        (p) => p.vales_cargados + p.recepciones_cargadas + p.lecturas_cargadas
                      ),
                      0
                    ) /
                      totalCargas) *
                    100
                  ).toFixed(1)
                ),
          anulaciones_propias: personas.reduce((a, p) => a + p.anulaciones_propias, 0),
          autorevisiones: personas.reduce((a, p) => a + p.autorevisiones, 0),
        },
      });
    } catch {
      res.status(500).json({ error: "Error al armar el reporte de segregación" });
    }
  }

  // ── Precintos numerados (migración 0095) ─────────────────────────────

  /** GET /:id/precintos -- los puntos del tanque con su precinto vigente.
   *  Cualquier rol: el que toma la varilla necesita saber qué puntos mirar. */
  async listarPuntosPrecinto(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const puntos = await withTenant(tenantId, (client) =>
        service.listarPuntosPrecinto(client, tenantId, Number(req.params.id))
      );
      res.json(puntos);
    } catch {
      res.status(500).json({ error: "Error al listar los precintos" });
    }
  }

  /** GET /:id/precintos/historial -- cada colocación y cada varilla que no
   *  coincidió. */
  async historialPrecintos(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const filas = await withTenant(tenantId, (client) =>
        service.historialPrecintos(client, tenantId, Number(req.params.id))
      );
      res.json(filas);
    } catch {
      res.status(500).json({ error: "Error al armar el historial de precintos" });
    }
  }

  /** POST /:id/precintos/puntos -- alta de un punto con su primer precinto.
   *  Es configuración: queda en la bitácora. */
  async crearPuntoPrecinto(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const combustibleId = Number(req.params.id);
      const data = req.validatedBody as CrearPuntoPrecintoInput;
      const creado = await withTenant(tenantId, (client) =>
        service.crearPuntoPrecinto(client, tenantId, req.usuario!.id, combustibleId, data)
      );
      if (!creado) {
        res.status(404).json({ error: "Tanque no encontrado" });
        return;
      }
      await registrarAuditoria({
        accion: "combustible.precinto_punto_crear",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: {
          combustibleId,
          puntoId: creado.puntoId,
          nombre: data.nombre,
          seAbreEnRecepcion: data.se_abre_en_recepcion,
        },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "combustible.tanque_actualizado", { combustibleId });
      res.status(201).json({ id: creado.puntoId });
    } catch (err) {
      if (err instanceof Error && err.message.includes("ya tiene un punto llamado")) {
        res.status(409).json({ error: err.message });
        return;
      }
      if (err instanceof Error && err.message.includes("ya se usó")) {
        res.status(409).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: "Error al crear el punto de precinto" });
    }
  }

  /** POST /precintos/puntos/:puntoId/cambios -- cambio de precinto FUERA de
   *  una recepción. Se permite, pero siempre deja alerta y correo: es la
   *  puerta que usaría el que roba. */
  async cambiarPrecinto(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const puntoId = Number(req.params.puntoId);
      const data = req.validatedBody as CambiarPrecintoInput;
      const quien = req.usuario!.nombre ?? req.usuario!.email ?? "Alguien";

      const resultado = await withTenant(tenantId, async (client) => {
        const cambio = await service.cambiarPrecinto(
          client,
          tenantId,
          req.usuario!.id,
          puntoId,
          data
        );
        if (!cambio) return null;
        const detalle = {
          tanque: cambio.tanque?.codigo ?? String(cambio.punto.combustible_id),
          punto: cambio.punto.nombre,
          numeroAnterior: cambio.numeroAnterior,
          numeroNuevo: cambio.precinto.numero as string,
          quien,
          motivo: data.motivo,
        };
        await service.crearAlertas(client, tenantId, [
          {
            tipo: "precinto_reemplazado",
            combustibleId: cambio.punto.combustible_id,
            detalle: { ...detalle, puntoId, precintoId: Number(cambio.precinto.id) },
          },
        ]);
        const admins = await service.findAdminsConCombustibleHabilitado(client, tenantId);
        return { cambio, detalle, admins };
      });
      if (!resultado) {
        res.status(404).json({ error: "Punto de precinto no encontrado" });
        return;
      }

      await registrarAuditoria({
        accion: "combustible.precinto_cambiar",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: {
          combustibleId: resultado.cambio.punto.combustible_id,
          puntoId,
          numeroAnterior: resultado.cambio.numeroAnterior,
          numeroNuevo: resultado.detalle.numeroNuevo,
          motivo: data.motivo,
        },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "combustible.alerta_creada", {
        tipo: "precinto_reemplazado",
        combustibleId: resultado.cambio.punto.combustible_id,
      });
      try {
        await enviarCorreoPrecintoReemplazado(resultado.admins, resultado.detalle);
      } catch (err) {
        logger.warn({ err, tenantId, puntoId }, "No se pudo avisar del cambio de precinto");
      }
      res.status(201).json(resultado.cambio.precinto);
    } catch (err) {
      if (err instanceof Error && err.message.includes("ya se usó")) {
        res.status(409).json({ error: err.message });
        return;
      }
      if (
        err instanceof Error &&
        (err.message.includes("está dado de baja") || err.message.includes("se colocó después"))
      ) {
        res.status(400).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: "Error al cambiar el precinto" });
    }
  }

  /** PATCH /precintos/puntos/:puntoId/baja -- dejar de vigilar un punto.
   *  Cuenta como aflojar la vigilancia: misma acción de auditoría y mismo
   *  correo que bajar un umbral. */
  async bajaPuntoPrecinto(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const puntoId = Number(req.params.puntoId);
      const { motivo } = req.validatedBody as BajaPuntoPrecintoInput;
      const baja = await withTenant(tenantId, (client) =>
        service.bajaPuntoPrecinto(client, tenantId, puntoId, motivo)
      );
      if (!baja) {
        res.status(404).json({ error: "Punto no encontrado o ya dado de baja" });
        return;
      }
      const aflojados = [
        { control: `Precinto "${baja.nombre}"`, de: "verificado", a: "dado de baja" },
      ];
      await registrarAuditoria({
        accion: "combustible.tanque_vigilancia_reducida",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { combustibleId: baja.combustible_id, puntoId, aflojados, motivo },
        contexto: contextoAuditoriaModulo(req),
      });
      try {
        const { admins, tanque } = await withTenant(tenantId, async (client) => ({
          admins: await service.findAdminsConCombustibleHabilitado(client, tenantId),
          tanque: await service.getById(client, tenantId, baja.combustible_id),
        }));
        await enviarCorreoVigilanciaReducida(admins, {
          quien: req.usuario!.nombre ?? req.usuario!.email ?? "Un administrador",
          objeto: tanque
            ? `${tanque.codigo} — ${tanque.tanque_nombre}`
            : `Tanque ${baja.combustible_id}`,
          motivo,
          cambios: aflojados,
        });
      } catch (err) {
        logger.warn({ err, tenantId, puntoId }, "No se pudo avisar de la baja del precinto");
      }
      await publicarEventoTenant(tenantId, "combustible.tanque_actualizado", {
        combustibleId: baja.combustible_id,
      });
      res.json({ message: "Punto dado de baja" });
    } catch {
      res.status(500).json({ error: "Error al dar de baja el punto" });
    }
  }

  /** GET /reportes/consumo-equipos?desde=&hasta= -- CONSUMO POR EQUIPO.
   *
   *  El control del robo que sale CON vale (se declaran 400 L y se cargan
   *  380): ni la varilla ni el totalizador lo ven, porque del tanque salieron
   *  400 de verdad. Lo único que lo delata es el trabajo que ese combustible
   *  tendría que haber hecho. Compara cada equipo contra sus pares y contra
   *  su propio pasado; el detalle está en service.reporteConsumoEquipos. */
  async getReporteConsumoEquipos(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const { desde, hasta } = req.validatedQuery as KardexCombustibleQuery;
      const reporte = await withTenant(tenantId, (client) =>
        service.reporteConsumoEquipos(client, tenantId, desde, hasta)
      );
      res.json(reporte);
    } catch {
      res.status(500).json({ error: "Error al armar el reporte de consumo" });
    }
  }

  /** GET /anomalias -- los hallazgos ya congelados. Solo lectura: la tabla
   *  es append-only a propósito (ver migrations/0072), no hay endpoint para
   *  editarlas ni borrarlas. */
  async listarAnomalias(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const paginacion = parsePaginacion(req.query);
      const filas = await withTenant(tenantId, (client) =>
        service.listarAnomalias(client, tenantId, paginacion)
      );
      res.json(armarRespuestaPaginada(filas, paginacion));
    } catch {
      res.status(500).json({ error: "Error al listar anomalías" });
    }
  }

  // ── Grifos externos (migrations/0063) ─────────────────────────────────

  async listarGrifos(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const grifos = await withTenant(tenantId, (client) => service.listarGrifos(client, tenantId));
      res.json(grifos);
    } catch {
      res.status(500).json({ error: "Error al listar grifos" });
    }
  }

  async crearGrifo(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const data = req.validatedBody as CrearGrifoCombustibleInput;
      const grifo = await withTenant(tenantId, (client) =>
        service.crearGrifo(client, tenantId, req.usuario!.id, data)
      );
      await registrarAuditoria({
        accion: "combustible.grifo_crear",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: {
          grifoId: grifo.id,
          nombre: data.nombre,
          abasteceRuta: data.abastece_ruta,
          abasteceTanque: data.abastece_tanque,
        },
        contexto: contextoAuditoriaModulo(req),
      });
      res.status(201).json(grifo);
    } catch (err) {
      if (err instanceof Error && err.message.includes("ya existe un grifo")) {
        res.status(409).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: "Error al crear el grifo" });
    }
  }

  async actualizarGrifo(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);
      const data = req.validatedBody as ActualizarGrifoCombustibleInput;
      const grifo = await withTenant(tenantId, (client) =>
        service.actualizarGrifo(client, tenantId, id, data)
      );
      if (!grifo) {
        res.status(404).json({ error: "Grifo no encontrado" });
        return;
      }
      await registrarAuditoria({
        accion: "combustible.grifo_actualizar",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: {
          grifoId: id,
          abasteceRuta: data.abastece_ruta,
          abasteceTanque: data.abastece_tanque,
        },
        contexto: contextoAuditoriaModulo(req),
      });
      res.json(grifo);
    } catch (err) {
      if (err instanceof Error && err.message.includes("ya existe un grifo")) {
        res.status(409).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: "Error al actualizar el grifo" });
    }
  }

  // ── Precios de combustible (migrations/0063) ──────────────────────────

  async listarPrecios(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const precios = await withTenant(tenantId, (client) =>
        service.listarPrecios(client, tenantId)
      );
      res.json(precios);
    } catch {
      res.status(500).json({ error: "Error al listar precios" });
    }
  }

  async crearPrecio(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const data = req.validatedBody as CrearPrecioCombustibleInput;
      const precio = await withTenant(tenantId, (client) =>
        service.crearPrecio(client, tenantId, req.usuario!.id, data)
      );
      await registrarAuditoria({
        accion: "combustible.precio_crear",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: {
          precioId: precio.id,
          tipoCombustible: data.tipo_combustible,
          precioUnitario: data.precio_unitario,
        },
        contexto: contextoAuditoriaModulo(req),
      });
      res.status(201).json(precio);
    } catch (err) {
      if (
        err instanceof Error &&
        (err.message.includes("no existe en este tenant") ||
          err.message.includes("ya existe un grifo"))
      ) {
        res.status(400).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: "Error al crear el precio" });
    }
  }

  /** GET /precios/vigente -- el que el frontend llama para autocompletar
   *  el C.U del despacho ANTES de mandar el POST. Devuelve 200 con
   *  `precio: null` si no hay ninguno cargado todavía -- no es un error,
   *  el operador simplemente tipea el costo a mano esta vez. */
  async getPrecioVigente(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const tipoCombustible = req.query.tipo_combustible;
      const combustibleIdRaw = req.query.combustible_id;
      const grifoIdRaw = req.query.grifo_id;
      const fecha = typeof req.query.fecha === "string" ? req.query.fecha : undefined;

      if (typeof tipoCombustible !== "string" || !fecha) {
        res
          .status(400)
          .json({ error: "Los query params tipo_combustible y fecha son obligatorios" });
        return;
      }
      const combustibleId =
        typeof combustibleIdRaw === "string" && combustibleIdRaw !== ""
          ? Number(combustibleIdRaw)
          : null;
      const grifoId =
        typeof grifoIdRaw === "string" && grifoIdRaw !== "" ? Number(grifoIdRaw) : null;
      if ((combustibleId === null) === (grifoId === null)) {
        res
          .status(400)
          .json({ error: "Mandá exactamente uno de combustible_id o grifo_id, nunca los dos" });
        return;
      }

      const precio = await withTenant(tenantId, (client) =>
        service.obtenerPrecioVigente(
          client,
          tenantId,
          tipoCombustible,
          { combustibleId, grifoId },
          fecha
        )
      );
      res.json({ precio });
    } catch {
      res.status(500).json({ error: "Error al buscar el precio vigente" });
    }
  }

  async anularPrecio(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const precioId = Number(req.params.precioId);
      const { motivo } = req.validatedBody as AnularPrecioCombustibleInput;

      const resultado = await withTenant(tenantId, async (client) => {
        const anulado = await service.anularPrecio(
          client,
          tenantId,
          precioId,
          req.usuario!.id,
          motivo
        );
        if (anulado) return { estado: "anulada" as const, precio: anulado };

        const existente = await service.getPrecioPorId(client, tenantId, precioId);
        return existente ? { estado: "ya_anulada" as const } : { estado: "inexistente" as const };
      });

      if (resultado.estado === "inexistente") {
        res.status(404).json({ error: "Precio no encontrado" });
        return;
      }
      if (resultado.estado === "ya_anulada") {
        res.status(409).json({ error: "Este precio ya estaba anulado" });
        return;
      }

      await registrarAuditoria({
        accion: "combustible.precio_anular",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { precioId, motivo },
        contexto: contextoAuditoriaModulo(req),
      });
      res.json(resultado.precio);
    } catch {
      res.status(500).json({ error: "Error al anular el precio" });
    }
  }

  // ── Recepciones (Fase C, ver migrations/0064) ─────────────────────────

  /** POST /recepciones -- registra cuánto ENTRÓ al tanque propio y a qué
   *  costo. Es lo único que escribe `combustible.costo_promedio` (el
   *  recálculo va adentro del service, en la misma transacción).
   *
   *  NO mueve el nivel del tanque: eso sigue siendo exclusivo de una
   *  lectura de varilla (migración 0059). Ver el encabezado de 0064 sobre
   *  por qué esa independencia es deliberada. */
  async crearRecepcion(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const data = req.validatedBody as CrearRecepcionCombustibleInput;
      const { fila, creado } = await withTenant(tenantId, (client) =>
        service.crearRecepcion(client, tenantId, req.usuario!.id, data)
      );

      // Reintento de un envío ya guardado (doble clic sobre el mismo
      // formulario) -- 200, no 201: no creó nada, y así el costo promedio
      // no se vuelve a tocar ni se duplica la auditoría.
      if (!creado) {
        res.status(200).json(fila ?? { error: "Esta recepción ya se había registrado" });
        return;
      }

      await registrarAuditoria({
        accion: "combustible.recepcion_crear",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: {
          recepcionId: fila!.id,
          combustibleId: data.combustible_id,
          cantidad: data.cantidad,
          costoUnitario: data.costo_unitario,
        },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "combustible.recepcion_creada", {
        recepcionId: fila!.id,
        combustibleId: data.combustible_id,
      });
      // La recepción retroactiva (5ª auditoría) compara contra las lecturas
      // de VARILLA de un tanque -- la urea no tiene tanque ni varilla, así
      // que este control no le aplica (ver el conteo físico de urea, que es
      // su propio equivalente, aparte).
      if (data.producto !== "urea") {
        await this.procesarAlertaRecepcionRetroactiva(
          tenantId,
          data.combustible_id!,
          Number(fila!.id),
          new Date(fila!.recibido_en).toISOString()
        );
      }
      res.status(201).json(fila);
    } catch (err) {
      if (
        err instanceof Error &&
        (err.message.includes("no existe en este tenant") ||
          err.message.includes("exige factura o guía") ||
          err.message.includes("no tiene ninguna lectura vigente") ||
          err.message.includes("supera la capacidad del tanque") ||
          // Grifo del rol equivocado (migrations/0065).
          err.message.includes("no está marcado como") ||
          // Precintos de la recepción (0095).
          err.message.includes("usa precintos") ||
          err.message.includes("no es de este tanque") ||
          err.message.includes("está dado de baja") ||
          err.message.includes("vino dos veces") ||
          err.message.includes("se colocó después"))
      ) {
        // Todos son datos que se contradicen a sí mismos o a la
        // configuración del tanque que el propio request referenció -- 400,
        // corregible en el momento (punto 5 del documento de diseño).
        res.status(400).json({ error: err.message });
        return;
      }
      if (err instanceof Error && err.message.includes("ya se usó")) {
        // 409, como el vale duplicado: no está mal formado, es un precinto
        // que ya se colocó alguna vez.
        res.status(409).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: "Error al registrar la recepción" });
    }
  }

  /** PATCH /recepciones/:recepcionId/validar -- el segundo testigo de la
   *  entrega (5ª auditoría, migración 0088).
   *
   *  Quien valida escribe la cantidad que dice la GUÍA, no confirma la que
   *  cargó el que recibió: la pantalla no se la muestra hasta después de
   *  guardar. Si no coinciden, queda la alerta con los dos números.
   *
   *  404 si no existe, 409 si ya estaba validada o anulada -- mismo criterio
   *  que las anulaciones, para no pisar quién validó primero y con qué. */
  async validarRecepcion(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const recepcionId = Number(req.params.recepcionId);
      const { cantidad_documento } = req.validatedBody as ValidarRecepcionCombustibleInput;

      const resultado = await withTenant(tenantId, async (client) => {
        const validada = await service.validarRecepcion(
          client,
          tenantId,
          recepcionId,
          req.usuario!.id,
          cantidad_documento
        );
        if (validada) return { estado: "validada" as const, ...validada };
        const existente = await service.getRecepcionPorId(client, tenantId, recepcionId);
        return existente ? { estado: "no_aplicable" as const } : { estado: "inexistente" as const };
      });

      if (resultado.estado === "inexistente") {
        res.status(404).json({ error: "Recepción no encontrada" });
        return;
      }
      if (resultado.estado === "no_aplicable") {
        res.status(409).json({ error: "Esta recepción ya estaba validada o fue anulada" });
        return;
      }

      await registrarAuditoria({
        // Acción propia cuando valida el MISMO que registró: no se bloquea
        // --una empresa chica puede tener una sola persona-- pero el auditor
        // tiene que poder encontrarlo sin leer validación por validación.
        accion: resultado.autovalidacion
          ? "combustible.recepcion_autovalidada"
          : "combustible.recepcion_validar",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: {
          recepcionId,
          cantidadDocumento: cantidad_documento,
          cantidadRegistrada: Number(resultado.recepcion.cantidad),
          coincide: resultado.discrepancia === null,
          autovalidacion: resultado.autovalidacion,
        },
        contexto: contextoAuditoriaModulo(req),
      });

      if (resultado.discrepancia) {
        await this.procesarAlertaRecepcionDiscrepante(
          tenantId,
          resultado.recepcion,
          resultado.discrepancia
        );
      }

      await publicarEventoTenant(tenantId, "combustible.recepcion_validada", { recepcionId });
      res.json({ recepcion: resultado.recepcion, discrepancia: resultado.discrepancia });
    } catch {
      res.status(500).json({ error: "Error al validar la recepción" });
    }
  }

  /** Mismo contrato best-effort que el resto de los procesar*. */
  private async procesarAlertaRecepcionDiscrepante(
    tenantId: string,
    recepcion: { id: number; combustible_id: number; cantidad: string },
    discrepancia: {
      cantidadRegistrada: number;
      cantidadDocumento: number;
      diferencia: number;
      sentido: string;
    }
  ) {
    try {
      const { admins, tanque } = await withTenant(tenantId, async (client) => {
        const tanque = await service.getById(client, tenantId, recepcion.combustible_id);
        await service.crearAlertas(client, tenantId, [
          {
            tipo: "recepcion_discrepante",
            recepcionId: recepcion.id,
            combustibleId: recepcion.combustible_id,
            detalle: {
              ...discrepancia,
              tanqueNombre: tanque?.tanque_nombre ?? "",
              unidad: tanque?.unidad ?? "",
            },
          },
        ]);
        return {
          admins: await service.findAdminsConCombustibleHabilitado(client, tenantId),
          tanque,
        };
      });
      await publicarEventoTenant(tenantId, "combustible.alerta_creada", {
        tipo: "recepcion_discrepante",
        recepcionId: recepcion.id,
      });
      await enviarCorreoRecepcionDiscrepante(admins, {
        tanqueNombre: tanque?.tanque_nombre ?? "",
        unidad: tanque?.unidad ?? "",
        cantidadRegistrada: discrepancia.cantidadRegistrada,
        cantidadDocumento: discrepancia.cantidadDocumento,
        diferencia: discrepancia.diferencia,
      });
    } catch (err) {
      logger.warn({ err, tenantId }, "No se pudo procesar la alerta de recepción discrepante");
    }
  }

  private async procesarAlertaRecepcionAnulada(
    tenantId: string,
    recepcion: { id: number; combustible_id: number; cantidad: string },
    motivo: string,
    req: Request
  ) {
    try {
      const { admins, tanque } = await withTenant(tenantId, async (client) => {
        const tanque = await service.getById(client, tenantId, recepcion.combustible_id);
        await service.crearAlertas(client, tenantId, [
          {
            tipo: "recepcion_anulada",
            recepcionId: recepcion.id,
            combustibleId: recepcion.combustible_id,
            detalle: {
              motivo,
              cantidad: Number(recepcion.cantidad),
              tanqueNombre: tanque?.tanque_nombre ?? "",
              unidad: tanque?.unidad ?? "",
            },
          },
        ]);
        // La recepción anulada ya no espera validación: el hecho que esa
        // alerta reportaba dejó de existir.
        await service.resolverRecepcionSinValidarSiExiste(client, tenantId, recepcion.id);
        return {
          admins: await service.findAdminsConCombustibleHabilitado(client, tenantId),
          tanque,
        };
      });
      await publicarEventoTenant(tenantId, "combustible.alerta_creada", {
        tipo: "recepcion_anulada",
        recepcionId: recepcion.id,
      });
      await enviarCorreoRecepcionAnulada(admins, {
        tanqueNombre: tanque?.tanque_nombre ?? "",
        unidad: tanque?.unidad ?? "",
        cantidad: Number(recepcion.cantidad),
        motivo,
        quien: req.usuario!.nombre ?? req.usuario!.email ?? "Un usuario",
      });
    } catch (err) {
      logger.warn({ err, tenantId }, "No se pudo procesar la alerta de recepción anulada");
    }
  }

  private async procesarAlertaRecepcionRetroactiva(
    tenantId: string,
    combustibleId: number,
    recepcionId: number,
    recibidoEn: string
  ) {
    try {
      const { retro, admins, tanque } = await withTenant(tenantId, async (client) => {
        const retro = await service.evaluarRecepcionRetroactiva(
          client,
          tenantId,
          combustibleId,
          recepcionId,
          recibidoEn
        );
        if (!retro) {
          return { retro, admins: [] as { email: string; nombre: string }[], tanque: null };
        }
        const tanque = await service.getById(client, tenantId, combustibleId);
        await service.crearAlertas(client, tenantId, [
          {
            tipo: "recepcion_retroactiva",
            recepcionId,
            combustibleId,
            detalle: { ...retro, tanqueNombre: tanque?.tanque_nombre ?? "" },
          },
        ]);
        return {
          retro,
          admins: await service.findAdminsConCombustibleHabilitado(client, tenantId),
          tanque,
        };
      });
      if (!retro) return;
      await publicarEventoTenant(tenantId, "combustible.alerta_creada", {
        tipo: "recepcion_retroactiva",
        recepcionId,
      });
      await enviarCorreoRecepcionRetroactiva(admins, {
        tanqueNombre: tanque?.tanque_nombre ?? "",
        recibidoEn,
        diasDeAtraso: retro.diasDeAtraso,
        diasTolerados: retro.diasTolerados,
      });
    } catch (err) {
      logger.warn({ err, tenantId }, "No se pudo procesar la alerta de recepción retroactiva");
    }
  }

  /** GET /recepciones -- historial paginado, con filtro opcional por tanque
   *  y por período. Incluye las anuladas (marcadas): son evidencia, no
   *  ruido. */
  async listarRecepciones(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const paginacion = parsePaginacion(req.query);
      const combustibleIdRaw = req.query.combustible_id;
      const combustibleId =
        typeof combustibleIdRaw === "string" && combustibleIdRaw.trim() !== ""
          ? Number(combustibleIdRaw)
          : undefined;

      const producto =
        req.query.producto === "urea" || req.query.producto === "combustible"
          ? req.query.producto
          : undefined;
      const { desde, hasta } = req.validatedQuery as PeriodoHistorialCombustibleQuery;

      const filas = await withTenant(tenantId, (client) =>
        service.listarRecepciones(
          client,
          tenantId,
          { combustibleId, producto, desde, hasta },
          paginacion
        )
      );
      res.json(armarRespuestaPaginada(filas, paginacion));
    } catch {
      res.status(500).json({ error: "Error al listar recepciones" });
    }
  }

  /** PATCH /recepciones/:recepcionId/anular -- mismo mecanismo exacto que
   *  anularLectura/anularPrecio (404 vs 409), con una diferencia: acá el
   *  costo promedio del tanque se recalcula sin la fila anulada, así que la
   *  respuesta devuelve también el tanque con su promedio ya actualizado. */
  async anularRecepcion(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const recepcionId = Number(req.params.recepcionId);
      const { motivo } = req.validatedBody as AnularRecepcionCombustibleInput;

      const resultado = await withTenant(tenantId, async (client) => {
        const anulada = await service.anularRecepcion(
          client,
          tenantId,
          recepcionId,
          req.usuario!.id,
          motivo
        );
        if (anulada) return { estado: "anulada" as const, ...anulada };

        const existente = await service.getRecepcionPorId(client, tenantId, recepcionId);
        return existente ? { estado: "ya_anulada" as const } : { estado: "inexistente" as const };
      });

      if (resultado.estado === "inexistente") {
        res.status(404).json({ error: "Recepción no encontrada" });
        return;
      }
      if (resultado.estado === "ya_anulada") {
        res.status(409).json({ error: "Esta recepción ya estaba anulada" });
        return;
      }

      await registrarAuditoria({
        accion: "combustible.recepcion_anular",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { recepcionId, motivo },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "combustible.recepcion_anulada", {
        recepcionId,
      });
      // ANULAR UNA RECEPCIÓN NO AVISABA A NADIE, al revés que anular un vale.
      // Y es la maniobra más rentable de las dos: si la entrega sí ocurrió,
      // anularla deja ese combustible fuera de los papeles -- el tanque tiene
      // más de lo que el sistema cree y el sobrante sale sin que falte nada.
      await this.procesarAlertaRecepcionAnulada(tenantId, resultado.recepcion, motivo, req);
      res.json({ recepcion: resultado.recepcion, tanque: resultado.tanque });
    } catch {
      res.status(500).json({ error: "Error al anular la recepción" });
    }
  }

  // ── Conteo físico de urea (migración 0092) ────────────────────────────

  /** POST /urea/conteos -- el reemplazo de la varilla para la urea. Cada
   *  conteo dispara el chequeo de descuadre contra el stock teórico (ver
   *  evaluarUreaDescuadreConteo), mismo patrón que registrarLectura con el
   *  tanque de combustible. */
  async crearConteoUrea(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const data = req.validatedBody as CrearConteoUreaInput;

      const { fila, creado } = await withTenant(tenantId, (client) =>
        service.crearConteoUrea(client, tenantId, req.usuario!.id, data)
      );

      if (!creado) {
        res.status(200).json(fila ?? { error: "Este conteo ya se había registrado" });
        return;
      }

      await registrarAuditoria({
        accion: "combustible.urea_conteo_crear",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { conteoId: fila!.id, cantidadLitros: fila!.cantidad_litros },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "combustible.urea_conteo_creado", {
        conteoId: fila!.id,
      });

      // Best-effort, mismo contrato "nunca lanza" que el resto del módulo:
      // el conteo ya se guardó y se respondió, un fallo acá no lo revierte.
      try {
        const { descuadre, admins } = await withTenant(tenantId, async (client) => {
          const descuadre = await service.evaluarUreaDescuadreConteo(
            client,
            tenantId,
            Number(fila!.id),
            Number(fila!.cantidad_litros),
            new Date(fila!.contado_en).toISOString()
          );
          if (!descuadre) {
            return { descuadre: null, admins: [] as { email: string; nombre: string }[] };
          }
          await service.crearAlertas(client, tenantId, [
            {
              tipo: "urea_descuadre_conteo",
              producto: "urea",
              ureaConteoId: Number(fila!.id),
              detalle: { ...descuadre } as Record<string, unknown>,
            },
          ]);
          return {
            descuadre,
            admins: await service.findAdminsConCombustibleHabilitado(client, tenantId),
          };
        });
        if (descuadre) {
          await publicarEventoTenant(tenantId, "combustible.alerta_creada", {
            tipo: "urea_descuadre_conteo",
          });
          void admins; // el correo de esta alerta queda para una entrega posterior
        }
      } catch (err) {
        logger.warn({ err, tenantId }, "No se pudo evaluar el descuadre del conteo de urea");
      }

      res.status(201).json(fila);
    } catch {
      res.status(500).json({ error: "Error al registrar el conteo de urea" });
    }
  }

  async listarConteosUrea(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const paginacion = parsePaginacion(req.query);
      const filas = await withTenant(tenantId, (client) =>
        service.listarConteosUrea(client, tenantId, paginacion)
      );
      res.json(armarRespuestaPaginada(filas, paginacion));
    } catch {
      res.status(500).json({ error: "Error al listar los conteos de urea" });
    }
  }

  /** PATCH /urea/conteos/:id/anular -- mismo mecanismo de siempre: 404 si
   *  no existe, 409 si ya estaba anulado, motivo obligatorio. */
  async anularConteoUrea(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);
      const { motivo } = req.validatedBody as AnularConteoUreaInput;

      const resultado = await withTenant(tenantId, async (client) => {
        const anulado = await service.anularConteoUrea(
          client,
          tenantId,
          id,
          req.usuario!.id,
          motivo
        );
        if (anulado) return { estado: "anulada" as const, conteo: anulado };
        const existente = await service.getConteoUreaPorId(client, tenantId, id);
        return existente ? { estado: "ya_anulada" as const } : { estado: "inexistente" as const };
      });

      if (resultado.estado === "inexistente") {
        res.status(404).json({ error: "Conteo no encontrado" });
        return;
      }
      if (resultado.estado === "ya_anulada") {
        res.status(409).json({ error: "Este conteo ya estaba anulado" });
        return;
      }

      await registrarAuditoria({
        accion: "combustible.urea_conteo_anular",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { conteoId: id, motivo },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "combustible.urea_conteo_anulado", { conteoId: id });
      res.json(resultado.conteo);
    } catch {
      res.status(500).json({ error: "Error al anular el conteo de urea" });
    }
  }

  /** GET /urea/estado -- hace cuánto que nadie cuenta la urea, para el
   *  banner de la pestaña (mismo criterio que el tanque "operando ciego"
   *  de combustible, migración 0082). */
  async getEstadoUrea(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const sinConteo = await withTenant(tenantId, (client) =>
        service.evaluarUreaSinConteo(client, tenantId)
      );
      res.json({ sinConteo: sinConteo ?? null });
    } catch {
      res.status(500).json({ error: "Error al obtener el estado del conteo de urea" });
    }
  }
}
