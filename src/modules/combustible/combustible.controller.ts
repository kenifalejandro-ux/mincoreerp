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
  enviarCorreoAlertaNivelBajo,
  enviarCorreoAlertaDescuadre,
  enviarCorreoAlertaDescuadreCiclo,
  enviarCorreoVigilanciaReducida,
  enviarCorreoTopeDiario,
  enviarCorreoAlertaDescuadreVentana,
  enviarCorreoValeRetroactivo,
  enviarCorreoValeRecargado,
  enviarCorreoLecturaRetroactiva,
} from "./combustibleAlertas.mailer";
import type {
  RegistrarLecturaCombustibleInput,
  ActualizarNivelCombustibleInput,
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
  AnularDespachoCombustibleInput,
  MarcarAlertasLeidasCombustibleInput,
  BajaTanqueCombustibleInput,
  ResolverAlertaCombustibleInput,
  ConfigCombustibleInput,
  KardexCombustibleQuery,
  PeriodoHistorialCombustibleQuery,
} from "../../server/schemas/combustible.schema";
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
  cabecera: { codigo: string; nombre: string; capacidad: number; unidad: string };
  umbralHoyPct: string | number | null;
  /** La unidad EN LA QUE SE HACE LA CUENTA: litros/galones, o "%" cuando el
   *  denominador cambia por fila (el umbral de diferencia). */
  unidadValor: string;
  columnas: ColumnaCalibracion[];
  columnaValor: { encabezado: string; explicacion: string };
  filas: FilaCalibracion[];
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
  const uTanque = o.cabecera.unidad;
  const k = o.columnas.length;
  const umbralHoy = o.umbralHoyPct === null ? null : Number(o.umbralHoyPct);
  const hayUmbral = umbralHoy !== null;

  // Columnas: A = #, B.. = contexto, y después las fijas.
  const cValor = letraColumna(1 + k);
  const cAbs = letraColumna(2 + k);
  const cCuad = letraColumna(3 + k);

  const dec = (celda: { valor?: number | string | null; formula?: string }, negrita = false) =>
    ({ ...celda, formato: "decimal", negrita }) as CeldaXlsx;
  const ent = (celda: { valor?: number | string | null; formula?: string }, negrita = false) =>
    ({ ...celda, formato: "entero", negrita }) as CeldaXlsx;
  const titulo = (texto: string): CeldaXlsx => ({ valor: texto, negrita: true });

  // ── Cabecera ──────────────────────────────────────────────────────────
  const FILA_CAPACIDAD = 5;
  const FILA_UMBRAL_PCT = 6;
  const FILA_UMBRAL_L = 7;

  const filas: CeldaXlsx[][] = [
    [titulo(o.titulo)],
    [o.queEsCadaFila],
    [],
    [titulo("Tanque"), `${o.cabecera.codigo} -- ${o.cabecera.nombre}`],
    [
      titulo(`Capacidad (${uTanque})`),
      ent({ valor: o.cabecera.capacidad }),
      "Cuánto le cabe al tanque.",
    ],
    [
      titulo("Umbral configurado hoy (%)"),
      // Texto y no 0 cuando no hay umbral: 0 es tolerancia cero de verdad
      // (alerta por cualquier litro), y NULL es "no vigila".
      hayUmbral ? dec({ valor: umbralHoy }) : "sin configurar",
      enPorcentaje
        ? "El que tiene cargado hoy la ficha del tanque. Se mide sobre lo facturado en cada entrega."
        : "El que tiene cargado hoy la ficha del tanque, en porcentaje de la capacidad.",
    ],
    [
      titulo(`Umbral configurado hoy (${enPorcentaje ? uTanque : u})`),
      enPorcentaje
        ? "no aplica"
        : hayUmbral
          ? dec({ formula: `B${FILA_UMBRAL_PCT}*B${FILA_CAPACIDAD}/100` })
          : "sin configurar",
      enPorcentaje
        ? "Este umbral no tiene un valor fijo en litros: depende de cuánto se facturó en cada entrega."
        : "El mismo umbral en litros: un tramo que se desajusta más que esto, hoy alerta.",
    ],
    [],
  ];

  // ── Leyenda de columnas ───────────────────────────────────────────────
  const leyenda: { encabezado: string; explicacion: string }[] = [
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
  filas.push([titulo("CÓMO SE LEE CADA COLUMNA")]);
  for (const c of leyenda) filas.push([titulo(c.encabezado), c.explicacion]);
  filas.push([]);

  // ── Encabezados de la tabla ───────────────────────────────────────────
  filas.push([
    titulo("#"),
    ...o.columnas.map((c) => titulo(c.encabezado)),
    titulo(o.columnaValor.encabezado),
    titulo("Valor absoluto"),
    titulo("(absoluto − promedio)²"),
    titulo("¿Alerta con el umbral de hoy?"),
    titulo("¿Alertaría con la sugerencia?"),
    titulo("Observación"),
  ]);

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
    filas.push([], ["Todavía no hay mediciones para calcular nada."]);
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

  const expandir = (formula: string, fila: number) =>
    formula.replace(/\{(\d+)\}/g, (_, i: string) => `${letraColumna(Number(i))}${fila}`);

  o.filas.forEach((f, i) => {
    const fila = PRIMERA + i;
    const celdas: CeldaXlsx[] = [ent({ valor: i + 1 })];

    f.contexto.forEach((c, j) => {
      const formato = o.columnas[j].formato;
      if (c !== null && typeof c === "object") {
        const conFormula = { formula: expandir(c.formula, fila) };
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
        : dec({ formula: expandir(f.valor.formula, fila) }),
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
  filas.push([], [titulo("RESULTADOS"), null, titulo("QUÉ SIGNIFICA")]);
  filas.push(
    [
      titulo("Filas analizadas (n)"),
      ent({ formula: `COUNT(${rAbs})` }),
      "Cuántas filas entran en el cálculo.",
    ],
    [
      titulo("Filas que cuadraron perfecto (diferencia 0)"),
      ent({ formula: `COUNTIF(${rAbs},0)` }),
      "Cuántas no tuvieron ninguna diferencia. Si son la mayoría, lo normal del tanque es cuadrar.",
    ],
    [
      titulo(`Fila más grande (${u})`),
      dec({ formula: `MAX(${rAbs})` }),
      "El desajuste más grande de la lista. Si es muchas veces el promedio, es un caso raro que conviene revisar.",
    ],
    [
      titulo(`Mediana (${u})`),
      dec({ formula: `MEDIAN(${rAbs})` }),
      "El valor del medio si ordenás las filas de menor a mayor. Si es muy distinta del promedio, pocas filas grandes lo están inflando.",
    ],
    [
      titulo(`Promedio por fila (${u})`),
      dec({ formula: `AVERAGE(${rAbs})` }, true),
      "Todo el desajuste repartido en partes iguales entre las filas. Ojo: no es lo que pasa en una fila típica, es un reparto.",
    ],
    [
      titulo("Suma de los cuadrados"),
      dec({ formula: `SUM(${rCuad})` }),
      "Paso intermedio: la suma de la columna '(absoluto − promedio)²'.",
    ],
    [
      titulo("Varianza = suma ÷ (n − 1)"),
      dec({ formula: siHayDos(`${B(FILA_SUMA)}/(${B(FILA_N)}-1)`) }),
      "Paso intermedio, en unidades al cuadrado: no tiene sentido físico por sí sola.",
    ],
    [
      titulo(`Desviación = √varianza (${u})`),
      dec({ formula: siHayDos(`SQRT(${B(FILA_VARIANZA)})`) }, true),
      "Cuánto suele variar el desajuste de una fila a otra. Chica = el tanque se comporta parejo. Mucho mayor que el promedio = hay filas muy distintas del resto.",
    ],
    [
      titulo(`Sugerencia = promedio + 2 × desviación (${u})`),
      dec({ formula: siHayDos(`${B(FILA_PROMEDIO)}+2*${B(FILA_DESVIACION)}`) }, true),
      "Lo normal del tanque más un margen de dos veces lo que suele variar, para que la variación normal no haga sonar la alarma.",
    ]
  );
  if (!enPorcentaje) {
    filas.push([
      titulo("Sugerencia en % de la capacidad"),
      dec({ formula: siHayDos(`${B(FILA_SUGERENCIA)}/${B(FILA_CAPACIDAD)}*100`) }),
      "La sugerencia de arriba, pasada a porcentaje del tanque.",
    ]);
  }
  filas.push([
    titulo("Sugerencia final (%) -- la que muestra la pantalla"),
    dec({ formula: siHayDos(`ROUND(MAX(1,MIN(100,${B(FILA_SUGERENCIA_PCT)})),1)`) }, true),
    "Con piso de 1 % (por debajo alertaría por la dilatación del combustible con el calor) y tope de 100 %, redondeada a un decimal.",
  ]);
  if (!enPorcentaje) {
    filas.push([
      titulo(`Sugerencia final (${u})`),
      dec({ formula: siHayDos(`${B(FILA_FINAL_PCT)}*${B(FILA_CAPACIDAD)}/100`) }, true),
      "La sugerencia final en litros: el umbral que quedaría si aprietan 'Usar este valor'.",
    ]);
  }
  filas.push(
    [
      titulo("Mínimo de filas para que el sistema sugiera"),
      ent({ valor: 10 }),
      "Con menos, cualquier número sería inventado, y la pantalla no muestra ninguno.",
    ],
    [
      titulo("¿El sistema muestra la sugerencia?"),
      { formula: `IF(${B(FILA_N)}>=${B(FILA_MINIMO)},"Sí","No -- faltan mediciones")` },
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
    [titulo("CÓMO LO MUESTRA LA PANTALLA"), null, titulo("QUÉ SIGNIFICA")],
    [
      titulo("La etiqueta, tal cual"),
      {
        // Primero el mínimo: con menos filas la desviación puede estar vacía y
        // ROUND("") da error.
        formula:
          `IF(${B(FILA_N)}<${B(FILA_MINIMO)},` +
          `"Sugerencia automática: faltan mediciones ("&${B(FILA_N)}&"/"&${B(FILA_MINIMO)}&")",` +
          `"Sugerencia: "&ROUND(${B(FILA_FINAL_PCT)},1)&"% ("&${B(FILA_N)}&" mediciones, promedio "` +
          `&ROUND(${B(FILA_PROM_PCT)},2)&"% ± "&ROUND(${B(FILA_DESV_PCT)},2)&"%)")`,
      },
    ],
    [
      titulo(enPorcentaje ? "Promedio (%)" : "Promedio en % de la capacidad"),
      dec({ formula: siHayDos(aPct(FILA_PROMEDIO)) }),
      enPorcentaje
        ? "Es el 'promedio' de la etiqueta. En esta hoja la cuenta ya va en porcentaje."
        : "Es el 'promedio' de la etiqueta: el promedio por fila de arriba, dividido por la capacidad del tanque.",
    ],
    [
      titulo(enPorcentaje ? "Desviación (%)" : "Desviación en % de la capacidad"),
      dec({ formula: siHayDos(aPct(FILA_DESVIACION)) }),
      (enPorcentaje
        ? "Es el número que la etiqueta pone después del '±'. "
        : "Es el número que la etiqueta pone después del '±': la desviación de arriba, dividida por la capacidad. ") +
        "OJO: el ± NO significa 'más o menos'. Es la desviación, la misma de arriba, escrita en porcentaje.",
    ],
    [
      titulo("Sugerencia final (%)"),
      dec({ formula: `IF(${B(FILA_N)}<${B(FILA_MINIMO)},"",${B(FILA_FINAL_PCT)})` }),
      "Es el primer número de la etiqueta, el que aplica el botón 'Usar este valor'. Vacío mientras falten mediciones: la pantalla no muestra ninguno.",
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
      [titulo("COMPARACIÓN: EL UMBRAL DE HOY CONTRA LA SUGERENCIA"), null, titulo("QUÉ SIGNIFICA")],
      [
        titulo(`Umbral de hoy (${u})`),
        dec({ formula: B(FILA_UMBRAL_COMPARABLE) }),
        "El que está configurado ahora.",
      ],
      [
        titulo(`Sugerencia final (${u})`),
        dec({ formula: `IF(${B(FILA_N)}<${B(FILA_MINIMO)},"",${B(FILA_FINAL_UNIDAD)})` }),
        "El que quedaría si se acepta la sugerencia. Vacío mientras haya menos filas que el mínimo: todavía no hay sugerencia que aceptar.",
      ],
      [
        titulo(`Diferencia (${u})`),
        dec({ formula: `IF(${B(FILA_SUG)}="","",${B(FILA_SUG)}-${B(FILA_HOY)})` }),
        "Positiva: la sugerencia es MÁS tolerante que hoy (alerta menos). Negativa: es más estricta.",
      ],
      [
        titulo("Filas de esta lista que alertan con el umbral de hoy"),
        ent({ formula: `COUNTIF(${rAbs},">"&${B(FILA_HOY)})` }),
        "Cuántas superan el umbral configurado ahora.",
      ],
      [
        titulo("Filas que alertarían con la sugerencia"),
        ent({ formula: `IF(${B(FILA_SUG)}="","",COUNTIF(${rAbs},">"&${B(FILA_SUG)}))` }),
        "Cuántas superarían el umbral sugerido.",
      ],
      [
        titulo("Filas que DEJARÍAN de alertar si se acepta la sugerencia"),
        ent(
          {
            formula: `IF(${B(FILA_ALERTARIAN)}="","",${B(FILA_ALERTAN_HOY)}-${B(FILA_ALERTARIAN)})`,
          },
          true
        ),
        "Buscalas en la tabla: SÍ en '¿Alerta con el umbral de hoy?' y vacío en '¿Alertaría con la sugerencia?'. Si alguna fue un faltante real, aceptar la sugerencia lo haría invisible.",
      ]
    );
  }

  // ── Lectura rápida ────────────────────────────────────────────────────
  filas.push(
    [],
    [titulo("LECTURA RÁPIDA"), null, titulo("QUÉ SIGNIFICA")],
    [
      titulo("Desviación ÷ promedio"),
      dec({
        formula: `IF(AND(${B(FILA_N)}>1,${B(FILA_PROMEDIO)}>0),${B(FILA_DESVIACION)}/${B(FILA_PROMEDIO)},"")`,
      }),
      "Cuántas veces la variación supera al desajuste promedio. Hasta 1: filas parejas. Más de 2: hay filas muy distintas del resto que inflan la sugerencia.",
    ],
    [
      titulo("Veredicto"),
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
      { valor: "Descuadre por tramo", negrita: true },
      "Cada fila es un tramo: el espacio entre dos varillas seguidas, con los vales y recepciones del medio. 28 varillas dan 27 tramos.",
    ],
    [
      { valor: "Ciclo", negrita: true },
      "Cada fila es un ciclo: desde una recepción hasta la siguiente. Suma las diferencias de todos sus tramos.",
    ],
    [
      { valor: "Diferencia en recepción", negrita: true },
      "Cada fila es una entrega de combustible: lo facturado contra lo que subió la varilla.",
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
      const result = await withTenant(tenantId, (client) =>
        service.createBulk(client, tenantId, rows)
      );
      // La carga masiva es la puerta de atrás del alta: el formulario obliga
      // a elegir cómo se vigila el tanque, pero una planilla sin esas
      // columnas entra igual y deja los umbrales en NULL. No se bloquea --
      // pedir tres porcentajes por fila en un Excel garantiza que se llenen
      // con cualquier cosa -- pero SÍ se cuenta y se devuelve, para que el
      // cliente lo diga en pantalla y quede en la auditoría.
      const sinVigilancia = rows.filter(
        (f) =>
          f.umbral_descuadre_pct === null &&
          f.umbral_descuadre_ciclo_pct === null &&
          f.umbral_diferencia_pct === null
      ).length;

      // UNA fila de auditoría con el conteo, no una por tanque -- mismo
      // criterio que repuestos.carga_masiva (RepuestosController.bulk).
      await registrarAuditoria({
        accion: "combustible.tanques_carga_masiva",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { cantidad: result.length, sinVigilancia },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "combustible.tanques_carga_masiva", {
        cantidad: result.length,
      });
      res.status(201).json({ insertados: result.length, sinVigilancia, data: result });
    } catch {
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

      // Las tres sugerencias juntas: el formulario las muestra al lado de sus
      // respectivos campos y el usuario decide cuál acepta. Van en un solo
      // request porque las tres salen del mismo historial del tanque, y
      // partirlas en tres endpoints haría tres pasadas sobre lo mismo.
      //
      // La forma de la respuesta cambió: antes era el objeto de la sugerencia
      // de diferencia en la raíz, ahora es `{ diferencia, descuadre, ciclo }`.
      // El único consumidor es el panel, que va en el mismo commit.
      const [diferencia, descuadre, ciclo] = await withTenant(tenantId, (client) =>
        Promise.all([
          service.sugerirUmbralDiferencia(client, tenantId, id),
          service.sugerirUmbralDescuadre(client, tenantId, id),
          service.sugerirUmbralCiclo(client, tenantId, id),
        ])
      );
      res.json({ diferencia, descuadre, ciclo });
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
  async getSugerenciaUmbralXlsx(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);

      const tanque = await withTenant(tenantId, (client) => service.getById(client, tenantId, id));
      if (!tanque) {
        res.status(404).json({ error: "Tanque no encontrado" });
        return;
      }

      // En secuencia y no con Promise.all: las tres usan el MISMO cliente de la
      // transacción, y pg no admite dos consultas a la vez sobre un cliente
      // (hoy lo avisa con un DeprecationWarning, en pg@9 lo va a rechazar).
      // `getSugerenciaUmbral` todavía tiene la versión en paralelo.
      const { diferencia, descuadre, ciclo } = await withTenant(tenantId, async (client) => ({
        diferencia: await service.sugerirUmbralDiferencia(client, tenantId, id),
        descuadre: await service.sugerirUmbralDescuadre(client, tenantId, id),
        ciclo: await service.sugerirUmbralCiclo(client, tenantId, id),
      }));

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

      const libro = armarXlsx([
        hojaDeCalibracion({
          nombre: "Descuadre por tramo",
          titulo: "Umbral de descuadre -- de dónde sale la sugerencia",
          queEsCadaFila:
            "Cada fila es un TRAMO: el espacio entre dos varillas seguidas, con los vales y " +
            "recepciones que pasaron en el medio. Con 28 varillas hay 27 tramos: la primera no " +
            "tiene una anterior contra la cual compararse.",
          cabecera,
          umbralHoyPct: tanque.umbral_descuadre_pct,
          unidadValor: u,
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
          ],
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
        }),
        hojaDeCalibracion({
          nombre: "Ciclo",
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
        }),
        hojaDeCalibracion({
          nombre: "Diferencia en recepción",
          titulo: "Umbral de diferencia -- de dónde sale la sugerencia",
          queEsCadaFila:
            "Cada fila es una ENTREGA de combustible: lo facturado contra lo que realmente subió " +
            "la varilla. Solo entran las entregas con varilla antes Y después, y sin otra entrega " +
            "en el medio.",
          cabecera,
          umbralHoyPct: tanque.umbral_diferencia_pct,
          // El único de los tres que se mide en PORCENTAJE: su base es la
          // cantidad de cada entrega, que cambia en cada fila. Con un
          // denominador distinto por fila, promediar litros daría otra cosa
          // que lo que calcula el sistema.
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

  /** Legacy: mismo contrato de siempre (body `{ nivel_actual }`, responde el
   *  tanque). Ya no sobreescribe `nivel_actual` directo por dentro -- ver
   *  `CombustibleService.actualizarNivelLegacy`. */
  async updateNivel(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);
      const { nivel_actual } = req.validatedBody as ActualizarNivelCombustibleInput;

      const updated = await withTenant(tenantId, (client) =>
        service.actualizarNivelLegacy(client, tenantId, req.usuario!.id, id, nivel_actual)
      );

      if (!updated) {
        return res.status(404).json({ error: "No encontrado" });
      }

      await registrarAuditoria({
        accion: "combustible.actualizar_nivel",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { combustibleId: id },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "combustible.nivel_actualizado", {
        combustibleId: id,
        nivelActual: nivel_actual,
      });
      res.json(updated);
    } catch (err) {
      // El tanque no existe en este tenant -- mismo motivo que el 404 de
      // siempre (`updated` null), solo que acá llega como excepción porque
      // registrarLectura() valida la FK antes de insertar. Se preserva el
      // 404 histórico de este endpoint, NO el 400 del endpoint nuevo (ver
      // registrarLectura más abajo) -- no romper el contrato existente.
      if (err instanceof Error && err.message.includes("no existe en este tenant")) {
        res.status(404).json({ error: "No encontrado" });
        return;
      }
      // Este SÍ es 400 incluso en el endpoint legacy: no es "no encontrado",
      // es un dato imposible para un tanque que sí existe.
      if (err instanceof Error && err.message.includes("supera la capacidad del tanque")) {
        res.status(400).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: "Error al actualizar nivel" });
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
      await this.procesarAlertaNivelBajo(tenantId, data.combustible_id, data.nivel);
      await this.procesarAlertaDescuadre(
        tenantId,
        data.combustible_id,
        Number(fila!.lectura.id),
        data.nivel,
        // pg devuelve TIMESTAMPTZ como Date; el balance necesita el mismo
        // instante exacto que quedó guardado (no `data.leido_en`, que es
        // opcional en el body y puede venir sin definir).
        new Date(fila!.lectura.leido_en).toISOString()
      );
      await this.procesarAlertaDescuadreCiclo(
        tenantId,
        data.combustible_id,
        Number(fila!.lectura.id),
        data.nivel,
        new Date(fila!.lectura.leido_en).toISOString()
      );
      await this.procesarAlertaLecturaRetroactiva(
        tenantId,
        data.combustible_id,
        Number(fila!.lectura.id),
        data.nivel,
        new Date(fila!.lectura.leido_en).toISOString()
      );
      await this.procesarAlertaDescuadreVentana(
        tenantId,
        data.combustible_id,
        new Date(fila!.lectura.leido_en).toISOString()
      );
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
          err.message.includes("supera la capacidad del tanque"))
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
          err.message.includes("no está marcado como"))
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
    const serieTalonario = data.serie_talonario;
    const nVale = data.n_vale;
    try {
      const { huecos, exceso, medidor, fueraDeOrden, tope, retro, recargado, admins } =
        await withTenant(tenantId, async (client) => {
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
            serieTalonario,
            nVale
          );

          const huecos = await service.detectarHuecosRevelados(
            client,
            tenantId,
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
            serieTalonario,
            despachoId,
            nVale
          );
          const huecoLoEsperaba = await service.existioHuecoPara(
            client,
            tenantId,
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
                data.cantidad
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
            serieTalonario,
            nVale,
            data.cantidad
          );

          const tope = await service.evaluarTopeDiario(client, tenantId, {
            despachoId,
            equipoId: data.equipo_id ?? null,
            tipoDestino: data.tipo_destino,
            despachadoEn: data.despachado_en ?? new Date().toISOString(),
          });

          const nuevas = [
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
              admins: [] as { email: string; nombre: string }[],
            };
          }

          await service.crearAlertas(client, tenantId, nuevas);
          const admins = await service.findAdminsConCombustibleHabilitado(client, tenantId);
          return { huecos, exceso, medidor, fueraDeOrden, tope, retro, recargado, admins };
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

        await service.crearAlertas(client, tenantId, [
          { tipo: "descuadre_ciclo", combustibleId, detalle: { ...ciclo } },
        ]);
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

        await service.crearAlertas(client, tenantId, [
          { tipo: "descuadre_ventana", combustibleId, detalle: { ...ventana } },
        ]);
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
      const { desde, hasta } = req.validatedQuery as PeriodoHistorialCombustibleQuery;

      const filas = await withTenant(tenantId, (client) =>
        service.listarDespachos(
          client,
          tenantId,
          { equipoId, serieTalonario, desde, hasta },
          paginacion
        )
      );
      res.json(armarRespuestaPaginada(filas, paginacion));
    } catch {
      res.status(500).json({ error: "Error al listar despachos" });
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

      const resultado = await withTenant(tenantId, (client) =>
        service.detectarHuecos(client, tenantId, serieTalonario)
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

      const filas = await withTenant(tenantId, (client) =>
        service.listarAlertas(client, tenantId, { soloNoLeidas }, paginacion)
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
            ? { ...nueva, aflojados }
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
            motivo: "",
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
          "Anulado",
          "Motivo de anulación",
        ],
        kardex.filas.map((f) => [
          // Fecha local y no ISO: con el ISO, Excel trata la columna como
          // texto y el auditor no puede ordenar por fecha, que es lo primero
          // que hace.
          new Date(f.ocurrido_en).toLocaleString("es-PE", { timeZone: "America/Lima" }),
          f.tipo === "recepcion" ? "Recepción" : f.tipo === "despacho" ? "Despacho" : "Varilla",
          f.documento,
          f.detalle,
          f.entrada || "",
          f.salida || "",
          f.saldo_teorico,
          f.nivel_medido,
          f.dif_tramo,
          f.dif_acumulada,
          f.usuario,
          f.anulada ? "SÍ" : "",
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
        "Anulado",
        "Motivo de anulación",
      ].map((t) => ({ valor: t, negrita: true }));

      // Litros con 2 decimales: sin formato, una planilla muestra los números
      // como vienen ("17650" o "385.925925925926") y quien la abre no sabe
      // qué decimales importan.
      const litros = (v: number | null | undefined): CeldaXlsx =>
        v === null || v === undefined ? null : { valor: v, formato: "decimal" };

      const filas: CeldaXlsx[][] = kardex.filas.map((f) => [
        fechaLima(f.ocurrido_en),
        f.tipo === "recepcion" ? "Recepción" : f.tipo === "despacho" ? "Despacho" : "Varilla",
        f.documento,
        f.detalle,
        litros(f.entrada || null),
        litros(f.salida || null),
        litros(f.saldo_teorico),
        litros(f.nivel_medido),
        litros(f.dif_tramo),
        litros(f.dif_acumulada),
        f.usuario,
        f.anulada ? "SÍ" : null,
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
        // Las filas anuladas se SALTEAN (columna L = "SÍ"), igual que en
        // `armarKardex`. Siguen en la hoja de detalle porque son evidencia,
        // pero un vale anulado no sacó combustible: sumarlo daba otro total
        // que el de la pantalla. Lo encontró la verificación contra el tenant
        // redteam -- 12.170 L en el archivo contra 11.270 en pantalla, y la
        // diferencia era exactamente el vale de 900 L anulado.
        [
          `Entradas (${u})`,
          { formula: `SUMIFS(${rango("E")},${rango("L")},"<>SÍ")`, formato: "decimal" },
        ],
        [
          `Salidas (${u})`,
          { formula: `SUMIFS(${rango("F")},${rango("L")},"<>SÍ")`, formato: "decimal" },
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
      res.status(201).json(fila);
    } catch (err) {
      if (
        err instanceof Error &&
        (err.message.includes("no existe en este tenant") ||
          err.message.includes("exige factura o guía") ||
          err.message.includes("no tiene ninguna lectura vigente") ||
          err.message.includes("supera la capacidad del tanque") ||
          // Grifo del rol equivocado (migrations/0065).
          err.message.includes("no está marcado como"))
      ) {
        // Todos son datos que se contradicen a sí mismos o a la
        // configuración del tanque que el propio request referenció -- 400,
        // corregible en el momento (punto 5 del documento de diseño).
        res.status(400).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: "Error al registrar la recepción" });
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

      const { desde, hasta } = req.validatedQuery as PeriodoHistorialCombustibleQuery;

      const filas = await withTenant(tenantId, (client) =>
        service.listarRecepciones(client, tenantId, { combustibleId, desde, hasta }, paginacion)
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
      res.json({ recepcion: resultado.recepcion, tanque: resultado.tanque });
    } catch {
      res.status(500).json({ error: "Error al anular la recepción" });
    }
  }
}
