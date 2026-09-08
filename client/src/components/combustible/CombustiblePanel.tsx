/**client/src/components/combustible/CombustiblePanel */

import { useState, useEffect, useCallback, useMemo } from "react";

import { suscribirseASincronizacion } from "../../offline/offlineSync";
import { apiFetch } from "../../services/apiClient";
import { ahoraParaInputLocal } from "../../utils/fechaLocal";

interface Tanque {
  id: number;
  codigo: string;
  tanque_nombre: string;
  tipo_combustible: "diesel_b5" | "gasolina_90" | "glp";
  unidad: "gal" | "L";
  tipo_punto: "fijo" | "cisterna" | "surtidor";
  ubicacion: string | null;
  capacidad_total: string;
  // null cuando el tanque no tiene ninguna lectura vigente (todas anuladas):
  // el nivel es DESCONOCIDO, no cero. Desde la migración 0059 estos tres
  // campos no son columnas, se derivan de la última lectura vigente.
  nivel_actual: string | null;
  nivel_minimo: string;
  moneda: string;
  activo: boolean;
  porcentaje: string | null;
  fecha_actualizacion: string | null;
  // Fase C (migrations/0064). Lo calcula el motor de recepciones -- acá es
  // SOLO LECTURA: no hay campo de formulario que lo escriba. 0 significa
  // "todavía no hay ninguna recepción registrada", no "sale gratis".
  costo_promedio: string;
  // Margen sobre capacidad_total (en %) antes de bloquear una recepción, y
  // si este tanque exige factura/guía. Los dos se editan en el ABM.
  tolerancia_capacidad_pct: string;
  requiere_documento: boolean;
  // Desde cuántos % de diferencia entre lo facturado y lo medido se considera
  // sospechosa una recepción (migrations/0066). 0 = no alertar todavía.
  umbral_diferencia_pct: string | null;
  umbral_descuadre_pct: string | null;
  umbral_descuadre_ciclo_pct: string | null;
}

/** Una fila del historial de recepciones (GET /recepciones, Fase C). A
 *  diferencia del historial de despachos, el backend ya resuelve los
 *  nombres de tanque/grifo/usuarios con JOIN -- acá no hay que cruzarlos
 *  contra el estado del panel. */
interface RecepcionHistorial {
  id: number;
  combustible_id: number;
  grifo_id: number;
  cantidad: string;
  costo_unitario: string;
  costo_total: string;
  tipo_documento: "factura" | "guia_remision" | null;
  numero_documento: string | null;
  recibido_en: string;
  tanque_nombre: string;
  grifo_nombre: string;
  registrada_por_nombre: string | null;
  anulada_en: string | null;
  motivo_anulacion: string | null;
  anulada_por_nombre: string | null;
  // Lo medido menos lo facturado, ya con los despachos del período sumados de
  // vuelta. null = no se puede comparar (falta una lectura, o hubo otra
  // recepción en la misma ventana). Ver findRecepciones en el repository.
  diferencia_litros: string | null;
  nivel_antes: string | null;
  nivel_despues: string | null;
  umbral_diferencia_pct: string;
  umbral_descuadre_pct: string;
  umbral_descuadre_ciclo_pct: string;
}

const ETIQUETA_TIPO_DOCUMENTO: Record<"factura" | "guia_remision", string> = {
  factura: "Factura",
  guia_remision: "Guía de remisión",
};

const RECEPCION_FORM_INICIAL = {
  combustible_id: "",
  grifo_id: "",
  cantidad: "",
  costo_unitario: "",
  tipo_documento: "factura" as "factura" | "guia_remision",
  numero_documento: "",
};

/** Una fila del histórico de aforos (combustible_lecturas, migración
 *  0045). Llega de GET /combustible/:id/lecturas, ya ordenada de la más
 *  reciente a la más vieja. */
interface Lectura {
  id: number;
  nivel: string;
  leido_en: string;
  origen: string;
  // null = vigente. Una lectura anulada NUNCA se borra (ver migrations/0058):
  // queda visible como evidencia de que hubo un error, pero deja de contar
  // para el nivel del tanque y para la variación.
  anulada_en: string | null;
  motivo_anulacion: string | null;
  anulada_por_nombre: string | null;
  // Quién tomó la medición. null si el usuario fue borrado (ON DELETE SET
  // NULL, ver 0045) o si la lectura la generó el sistema (`origen` =
  // 'inicial' al crear el tanque, o 'backfill' de una migración vieja).
  registrada_por_nombre: string | null;
}

/** Fase B (migrations/0062) -- solo los campos que el formulario de
 *  despacho necesita, no el shape completo de GET /equipos. */
interface Equipo {
  id: number;
  placa_codigo: string;
  tipo: string;
  tipo_medidor: "horometro" | "odometro" | null;
}

type OrigenDespacho = "tanque_propio" | "compra_externa";
type TipoDestinoDespacho = "equipo" | "planta" | "reserva_cubeta";

const ETIQUETA_TIPO_DESTINO: Record<TipoDestinoDespacho, string> = {
  equipo: "Unidad",
  planta: "Planta (sin placa)",
  reserva_cubeta: "Reserva en cubeta",
};

/** Catálogo de grifos externos (migrations/0063) -- reemplaza el texto
 *  libre `grifo_externo` de Fase B: cada grifo franquiciado cobra un
 *  precio distinto, así que hace falta engancharlo a algo más estable
 *  que un string tipeado a mano. */
interface Grifo {
  id: number;
  nombre: string;
  activo: boolean;
  // Los dos roles del catálogo (migrations/0065). El mismo grifo puede servir
  // para los dos: en ruta (Fase B) y como proveedor del tanque propio (Fase C).
  // Los desplegables filtran por acá, pero la regla de verdad la impone el
  // servidor -- ver validarRolGrifo en combustible.service.ts.
  abastece_ruta: boolean;
  abastece_tanque: boolean;
}

/** Historial de precios (migrations/0063) -- se apila, nunca se pisa. Un
 *  precio mal cargado se anula (anulada_en no-null), no se borra. */
interface Precio {
  id: number;
  tipo_combustible: Tanque["tipo_combustible"];
  combustible_id: number | null;
  grifo_id: number | null;
  precio_unitario: string;
  vigente_desde: string;
  tanque_nombre: string | null;
  grifo_nombre: string | null;
  registrado_por_nombre: string | null;
  anulada_en: string | null;
  motivo_anulacion: string | null;
  anulado_por_nombre: string | null;
}

/** Una fila del historial de despachos (GET /despachos). Trae los ids
 *  crudos (combustible_id/grifo_id/equipo_id) -- el nombre se resuelve
 *  del lado del cliente contra `tanques`/`grifos`/`equipos`, que el panel
 *  ya tiene cargados; no hace falta pedirle al backend que haga los JOIN
 *  para esta tabla de solo lectura. */
interface DespachoHistorial {
  id: number;
  origen: OrigenDespacho;
  combustible_id: number | null;
  grifo_id: number | null;
  equipo_id: number | null;
  tipo_combustible: Tanque["tipo_combustible"];
  serie_talonario: string;
  n_vale: number;
  cantidad: string;
  costo_unitario: string;
  costo_total: string;
  observaciones: string | null;
  despachado_en: string;
  // Válvula de escape del punto 3 (migrations/0067). Un vale anulado NUNCA
  // se borra: queda visible como evidencia, deja de contar para la
  // conciliación, y libera su número para que el mismo papel se pueda
  // recargar con el dato corregido.
  anulada_en: string | null;
  motivo_anulacion: string | null;
}

// migrations/0068 -- mismo shape que AlertaCombustible en
// useAlertasCombustibleStream.ts, duplicado a propósito: este archivo no
// importa tipos de un hermano en ningún otro lado, siempre define su
// propia interfaz local (ver DespachoHistorial arriba).
// Fase D, entrega 3 -- mismo shape que devuelve GET /:id/sugerencia-umbral.
// Discriminado por `muestraSuficiente`: con muestra chica el backend ni
// siquiera calcula un número, así que las demás propiedades son opcionales.
interface SugerenciaUmbral {
  muestraSuficiente: boolean;
  tamanioMuestra: number;
  minimoRequerido: number;
  sugerido?: number;
  promedio?: number;
  desviacion?: number;
  muestra?: Array<{ cantidad: number; diferenciaLitros: number; diferenciaPct: number }>;
}

/** Un renglón de la bitácora del módulo. `detalle` es JSONB libre y cambia
 *  según la acción, igual que en las alertas. */
interface EventoBitacora {
  id: string;
  accion: string;
  usuario: string;
  detalle: Record<string, unknown>;
  creado_en: string;
}

/** Las acciones auditadas, en castellano. Las que REDUCEN la vigilancia se
 *  marcan aparte: son las que un auditor busca primero, y perderlas entre
 *  cincuenta "tanque actualizado" es como no tenerlas. */
const ETIQUETA_ACCION: Record<string, string> = {
  "combustible.tanque_crear": "Tanque creado",
  "combustible.tanque_actualizar": "Tanque editado",
  "combustible.tanque_eliminar": "Tanque desactivado",
  "combustible.tanque_vigilancia_reducida": "⚠ Vigilancia reducida",
  "combustible.tanques_carga_masiva": "Importación de tanques",
  "combustible.registrar_lectura": "Lectura de varilla",
  "combustible.actualizar_nivel": "Nivel actualizado",
  "combustible.anular_lectura": "Lectura anulada",
  "combustible.despacho_crear": "Vale registrado",
  "combustible.despacho_anular": "Vale anulado",
  "combustible.recepcion_crear": "Recepción registrada",
  "combustible.recepcion_anular": "Recepción anulada",
  "combustible.precio_crear": "Precio cargado",
  "combustible.precio_anular": "Precio anulado",
  "combustible.grifo_crear": "Proveedor creado",
  "combustible.grifo_actualizar": "Proveedor editado",
  "combustible.config_actualizar": "Configuración del módulo",
};

const ACCIONES_QUE_AFLOJAN = new Set(["combustible.tanque_vigilancia_reducida"]);

/** Las tres sugerencias vienen juntas del mismo endpoint: salen del mismo
 *  historial del tanque, y partirlas en tres requests haría tres pasadas
 *  sobre lo mismo. */
interface SugerenciasUmbral {
  diferencia: SugerenciaUmbral;
  descuadre: SugerenciaUmbral;
  ciclo: SugerenciaUmbral;
}

// Fase D (migrations/0072) -- el hallazgo YA congelado, a diferencia de
// AlertaCombustible que es el aviso vivo. Append-only: no tiene estado de
// resolución porque no se puede resolver, es evidencia.
interface AnomaliaCombustible {
  id: number;
  // Los cinco tipos que se congelan: los FALTANTES. `nivel_bajo` y
  // `despacho_tardio` nunca llegan acá -- ver el CHECK de tipos en 0073/0074.
  tipo:
    | "hueco_detectado"
    | "sobredespacho"
    | "diferencia_recepcion"
    | "medidor_inconsistente"
    | "descuadre_inventario"
    | "descuadre_ciclo";
  serie_talonario: string | null;
  n_vale: number | null;
  recepcion_id: number | null;
  combustible_id: number | null;
  detalle: Record<string, unknown>;
  detectada_en: string;
  congelada_en: string;
  ventana_horas: number;
}

interface AlertaCombustible {
  id: number;
  tipo:
    | "hueco_detectado"
    | "vale_anulado"
    | "sobredespacho"
    | "despacho_tardio"
    | "diferencia_recepcion"
    | "nivel_bajo"
    | "medidor_inconsistente"
    | "descuadre_inventario"
    | "descuadre_ciclo"
    | "tanque_sin_medir"
    | "vale_fuera_de_orden"
    | "lectura_retroactiva"
    | "tope_diario_excedido";
  // Nullable desde 0073: las alertas de recepción y de nivel no son sobre
  // un vale, se anclan al tanque o a la recepción.
  serie_talonario: string | null;
  n_vale: number | null;
  despacho_id: number | null;
  combustible_id: number | null;
  recepcion_id: number | null;
  detalle: Record<string, unknown>;
  creado_en: string;
  leida_en: string | null;
  resuelta_en: string | null;
  resuelta_por: string | null;
}

/** Copia de `gravedadAlertas.ts` (mismo directorio). No se importa porque
 *  este archivo solo tiene imports padre y agregarle uno hermano crashea
 *  eslint-plugin-import -- ver el encabezado de ese archivo, que es la
 *  fuente de verdad. Si cambia la lista de allá, cambiar también acá. */
const TIPOS_CRITICOS = new Set([
  "hueco_detectado",
  "vale_anulado",
  "sobredespacho",
  "diferencia_recepcion",
  "medidor_inconsistente",
  "descuadre_inventario",
  "descuadre_ciclo",
  "vale_fuera_de_orden",
  "lectura_retroactiva",
  "tope_diario_excedido",
  "tanque_sin_medir",
]);
const esCritica = (tipo: string) => TIPOS_CRITICOS.has(tipo);

/** Qué vigilancia tiene realmente un tanque. Deriva de los tres umbrales, no
 *  se guarda en ningún lado: es un ESTADO, no un evento.
 *
 *  Existe porque hoy un tanque ciego se ve idéntico a uno vigilado -- mismo
 *  código, mismo nivel, mismo "Activo" -- y un tenant puede usar el módulo
 *  meses creyendo que está protegido. La etiqueta no se puede cerrar ni
 *  marcar leída: desaparece cuando el tanque se configura, que es lo único
 *  que arregla el problema.
 *
 *  NULL = sin configurar (migración 0075). El 0 SÍ vigila -- es tolerancia
 *  cero -- así que preguntar por `!x` estaría mal: un tanque estrictísimo
 *  aparecería como desprotegido. */
/** Punto de partida RAZONADO, no medido: la varilla de un tanque de 20.000 L
 *  tiene un error honesto del orden de 100-200 L, y el ruido se acumula a lo
 *  largo del ciclo (de ahí que el del ciclo sea más alto que el de tramo).
 *
 *  Se presentan como provisionales en la UI a propósito. Un número inventado
 *  que se muestra como definitivo es peor que ninguno: nadie lo vuelve a
 *  mirar. El asistente de calibración los reemplaza cuando hay historial. */
const VIGILANCIA_RECOMENDADA = {
  umbral_descuadre_pct: "2",
  umbral_descuadre_ciclo_pct: "3",
  umbral_diferencia_pct: "2",
};

const CONTROLES_VIGILANCIA = [
  {
    campo: "umbral_descuadre_pct",
    sinEl: "Sin umbral de descuadre: no se detecta un faltante entre dos varillas.",
  },
  {
    campo: "umbral_descuadre_ciclo_pct",
    sinEl: "Sin umbral del ciclo: no se detecta un faltante repartido en porciones chicas.",
  },
  {
    campo: "umbral_diferencia_pct",
    sinEl:
      "Sin umbral de diferencia: no se detecta que el proveedor facture más de lo que descarga.",
  },
] as const;

/** Sugerencia compacta debajo de un campo de umbral. La versión rica -- con
 *  la muestra fila por fila -- se quedó solo en el umbral de diferencia, que
 *  es el que más se discute con el proveedor. Para los otros dos alcanza con
 *  el número y de cuántas mediciones sale: lo que importa es que el valor
 *  provisional del alta se pueda reemplazar por uno medido.
 *
 *  Nunca aplica sola: el botón lo aprieta una persona. Mismo criterio que la
 *  sugerencia de diferencia y que sugerirRateLimitTenant() en plataforma. */
function SugerenciaCompacta({
  sugerencia,
  cargando,
  onUsar,
}: {
  sugerencia: SugerenciaUmbral | undefined;
  cargando: boolean;
  onUsar: (valor: number) => void;
}) {
  if (cargando) return <p className="text-[11px] text-slate-400">Calculando sugerencia...</p>;
  if (!sugerencia) return null;

  if (!sugerencia.muestraSuficiente) {
    return (
      <p className="text-[11px] text-slate-400">
        Sugerencia automática: faltan mediciones ({sugerencia.tamanioMuestra}/
        {sugerencia.minimoRequerido}). Hasta entonces, el valor de arriba es provisional.
      </p>
    );
  }

  return (
    <p className="text-[11px] text-slate-500">
      Sugerencia: <strong>{sugerencia.sugerido}%</strong> ({sugerencia.tamanioMuestra} mediciones,
      promedio {sugerencia.promedio}% ± {sugerencia.desviacion}%){" "}
      <button
        type="button"
        onClick={() => onUsar(sugerencia.sugerido ?? 0)}
        className="text-slate-700 underline hover:text-slate-900"
      >
        Usar este valor
      </button>
    </p>
  );
}

function vigilanciaDe(t: Tanque): {
  nivel: "sin" | "parcial" | "completa";
  apagados: string[];
} {
  const apagados = CONTROLES_VIGILANCIA.filter((c) => t[c.campo] === null).map((c) => c.sinEl);
  if (apagados.length === CONTROLES_VIGILANCIA.length) return { nivel: "sin", apagados };
  if (apagados.length > 0) return { nivel: "parcial", apagados };
  return { nivel: "completa", apagados };
}

const ETIQUETA_ORIGEN_DESPACHO: Record<OrigenDespacho, string> = {
  tanque_propio: "Tanque propio",
  compra_externa: "Compra externa",
};

const ETIQUETA_TIPO_ALERTA: Record<AlertaCombustible["tipo"], string> = {
  hueco_detectado: "Hueco de talonario",
  vale_anulado: "Vale anulado",
  sobredespacho: "Sobredespacho",
  despacho_tardio: "Despacho tardío",
  diferencia_recepcion: "Diferencia en recepción",
  nivel_bajo: "Nivel bajo de tanque",
  medidor_inconsistente: "Medidor inconsistente",
  descuadre_inventario: "Descuadre de inventario",
  descuadre_ciclo: "Descuadre del ciclo",
  tanque_sin_medir: "Tanque sin medir",
  vale_fuera_de_orden: "Vale fuera de orden",
  lectura_retroactiva: "Lectura fuera de orden",
  tope_diario_excedido: "Tope diario excedido",
};

/** El `detalle` es JSONB libre y cada tipo de alerta guarda cosas
 *  distintas, así que la columna se arma por tipo. Devuelve "—" cuando no
 *  hay nada que agregar (un hueco se explica solo con el número de vale). */
/** La columna "Vale" de las tablas de alertas y anomalías. Desde la
 *  migración 0073 no toda alerta tiene vale: las de nivel van contra un
 *  tanque y las de diferencia contra una recepción. */
function referenciaAlerta(a: {
  serie_talonario: string | null;
  n_vale: number | null;
  recepcion_id?: number | null;
  detalle: Record<string, unknown>;
}): string {
  if (a.serie_talonario !== null && a.n_vale !== null) {
    return `${a.serie_talonario}-${String(a.n_vale).padStart(5, "0")}`;
  }
  if (typeof a.detalle.tanqueNombre === "string") return a.detalle.tanqueNombre;
  if (a.recepcion_id != null) return `Recepción #${a.recepcion_id}`;
  return "—";
}

function describirDetalleAlerta(a: AlertaCombustible): string {
  if (a.tipo === "vale_anulado" && typeof a.detalle.motivo === "string") {
    return `Motivo: ${a.detalle.motivo}`;
  }
  if (a.tipo === "sobredespacho") {
    const { cantidad, unidadDespacho, capacidad, unidadCapacidad, excesoPct } = a.detalle as {
      cantidad?: number;
      unidadDespacho?: string;
      capacidad?: number;
      unidadCapacidad?: string;
      excesoPct?: number;
    };
    if (cantidad === undefined || capacidad === undefined) return "—";
    return (
      `Despachó ${cantidad} ${unidadDespacho ?? ""} a un tanque de ` +
      `${capacidad} ${unidadCapacidad ?? ""} (+${excesoPct ?? "?"}%)`
    );
  }
  if (a.tipo === "tope_diario_excedido") {
    const { acumuladoL, topeL, valesEnLaVentana, base } = a.detalle as {
      acumuladoL?: number;
      topeL?: number;
      valesEnLaVentana?: number;
      base?: string;
    };
    // El dato que hace entendible la alerta es el REPARTO: ningún vale por
    // separado llamaba la atención, el problema es la suma.
    return (
      `${acumuladoL ?? "?"} L en 24 h contra un tope de ${topeL ?? "?"} L ` +
      `(${base ?? "sin base"}), repartidos en ${valesEnLaVentana ?? "?"} vale(s)`
    );
  }
  if (a.tipo === "tanque_sin_medir") {
    const { diasSinMedir, plazoDias } = a.detalle as {
      diasSinMedir?: number | null;
      plazoDias?: number;
    };
    return diasSinMedir == null
      ? `Nunca se midió (plazo: ${plazoDias ?? "?"} días)`
      : `${diasSinMedir} días sin varilla (plazo: ${plazoDias ?? "?"} días)`;
  }
  if (a.tipo === "descuadre_ciclo") {
    const { descuadreLitros, sentido, unidad, cicloDesde } = a.detalle as {
      descuadreLitros?: number;
      sentido?: string;
      unidad?: string;
      cicloDesde?: string;
    };
    if (descuadreLitros === undefined) return "—";
    const magnitud = Math.abs(descuadreLitros).toLocaleString("es-PE", {
      maximumFractionDigits: 2,
    });
    const desde = cicloDesde ? new Date(cicloDesde).toLocaleDateString("es-PE") : "?";
    return (
      `${sentido === "falta" ? "Faltan" : "Sobran"} ${magnitud} ${unidad ?? ""} ` +
      `acumulados desde la carga del ${desde}`
    );
  }
  if (a.tipo === "descuadre_inventario") {
    const { descuadreLitros, esperado, nivelMedido, sentido, unidad, umbralPct } = a.detalle as {
      descuadreLitros?: number;
      esperado?: number;
      nivelMedido?: number;
      sentido?: string;
      unidad?: string;
      umbralPct?: number;
    };
    if (descuadreLitros === undefined) return "—";
    // El valor absoluto va con la palabra ("faltan"/"sobran") en vez del
    // signo: un "-500" pide que el lector traduzca, y esta columna se lee de
    // reojo entre muchas filas.
    const magnitud = Math.abs(descuadreLitros).toLocaleString("es-PE", {
      maximumFractionDigits: 2,
    });
    return (
      `${sentido === "falta" ? "Faltan" : "Sobran"} ${magnitud} ${unidad ?? ""}: ` +
      `esperado ${esperado ?? "?"}, medido ${nivelMedido ?? "?"} (umbral ${umbralPct ?? "?"}%)`
    );
  }
  if (a.tipo === "diferencia_recepcion") {
    const { diferenciaLitros, diferenciaPct, umbralPct, unidad } = a.detalle as {
      diferenciaLitros?: number;
      diferenciaPct?: number;
      umbralPct?: number;
      unidad?: string;
    };
    if (diferenciaLitros === undefined) return "—";
    const signo = diferenciaLitros > 0 ? "+" : "";
    return (
      `Facturado vs. medido: ${signo}${diferenciaLitros} ${unidad ?? ""} ` +
      `(${signo}${diferenciaPct ?? "?"}%, umbral ${umbralPct ?? "?"}%)`
    );
  }
  if (a.tipo === "nivel_bajo") {
    const { nivel, nivelMinimo, unidad } = a.detalle as {
      nivel?: number;
      nivelMinimo?: number;
      unidad?: string;
    };
    if (nivel === undefined) return "—";
    return `Nivel ${nivel} ${unidad ?? ""}, por debajo del mínimo de ${nivelMinimo} ${unidad ?? ""}`;
  }
  if (a.tipo === "medidor_inconsistente") {
    const { medidor, motivo, valorAnterior, valorNuevo, horasDeclaradas, horasCalendario } =
      a.detalle as {
        medidor?: string;
        motivo?: string;
        valorAnterior?: number;
        valorNuevo?: number;
        horasDeclaradas?: number;
        horasCalendario?: number;
      };
    const nombre = medidor === "horometro" ? "Horómetro" : "Odómetro";
    if (motivo === "retroceso") {
      return `${nombre} retrocedió: ${valorAnterior} → ${valorNuevo}`;
    }
    if (motivo === "excede_calendario") {
      return `${nombre}: ${horasDeclaradas} h de motor en ${horasCalendario} h de reloj`;
    }
    return nombre;
  }
  return "—";
}

const DESPACHO_FORM_INICIAL = {
  origen: "tanque_propio" as OrigenDespacho,
  combustible_id: "",
  grifo_id: "",
  tipo_combustible: "diesel_b5" as Tanque["tipo_combustible"],
  tipo_destino: "equipo" as TipoDestinoDespacho,
  equipo_id: "",
  serie_talonario: "",
  n_vale: "",
  cantidad: "",
  lectura_contometro: "",
  lectura_horometro: "",
  lectura_odometro: "",
  horas_abastecidas: "",
  costo_unitario: "",
  observaciones: "",
};

const ETIQUETA_TIPO_COMBUSTIBLE: Record<Tanque["tipo_combustible"], string> = {
  diesel_b5: "Diésel B5",
  gasolina_90: "Gasolina 90",
  glp: "GLP",
};

const ETIQUETA_TIPO_PUNTO: Record<Tanque["tipo_punto"], string> = {
  fijo: "Tanque fijo",
  cisterna: "Cisterna",
  surtidor: "Surtidor",
};

/** Cuánto tiene que moverse una lectura respecto de la anterior para
 *  merecer una confirmación, expresado como fracción de la capacidad del
 *  tanque.
 *
 *  Es relativo a la capacidad y no un número fijo a propósito: 500 L de
 *  diferencia son rutina en un tanque de 20.000 y una anomalía en uno de
 *  1.000.
 *
 *  El valor NO busca atrapar todo error de tipeo -- 18.000 en vez de 19.000
 *  pasa por debajo de cualquier umbral razonable, y para eso está la
 *  anulación con motivo. Busca que el aviso salte poco, para que cuando
 *  salte alguien lo lea: un "¿estás seguro?" en cada registro se clickea en
 *  automático a la semana y deja de servir (mismo criterio que el punto 4
 *  de docs/architecture/control-de-combustible.md sobre el ruido). */
const FRACCION_SALTO_SOSPECHOSO = 0.5;

/** Decide si una lectura merece confirmarse antes de mandarla, comparándola
 *  con el nivel vigente del tanque.
 *
 *  Pura y sin dependencias de React a propósito: el día que Repuestos (u
 *  otro módulo con histórico) necesite el mismo aviso, esto se mueve a un
 *  util compartido sin arrastrar nada. Hoy vive acá porque con un solo caso
 *  real todavía no se sabe cuál es la forma correcta de la abstracción.
 *
 *  Devuelve `null` cuando no hay nada que advertir. */
function motivoParaConfirmarLectura(
  nivelNuevo: number,
  nivelActual: number,
  capacidad: number,
  unidad: string
): string | null {
  const salto = nivelNuevo - nivelActual;
  if (Math.abs(salto) <= capacidad * FRACCION_SALTO_SOSPECHOSO) return null;

  const fmt = (n: number) => `${Math.abs(n).toLocaleString("es-PE")} ${unidad}`;
  const direccion = salto < 0 ? "menos que" : "más que";
  return (
    `Estás por registrar ${fmt(nivelNuevo)}, que es ${fmt(salto)} ${direccion} ` +
    `la última lectura (${fmt(nivelActual)}).\n\n` +
    `¿Es correcto?`
  );
}

/** Espejo de MAX_FILAS_CARGA_MASIVA_TANQUES en
 *  server/schemas/combustible.schema.ts -- mismo motivo que
 *  MAX_FILAS_IMPORTACION en RepuestosTable.tsx: avisa antes de mandar
 *  miles de filas al servidor para que las rechace. */
const MAX_FILAS_IMPORTACION = 5000;

/** Traduce la respuesta de error a algo accionable -- mismo criterio que
 *  RepuestosTable.tsx/DocumentosTable.tsx. */
async function mensajeDeErrorDelServidor(res: Response, filas: number): Promise<string> {
  if (res.status === 413) {
    return `El archivo es demasiado grande para enviarlo de una vez (${filas} filas). Dividilo en varios archivos.`;
  }
  if (res.status === 403) {
    const body = await res.json().catch(() => null);
    if (body?.error === "cuota_excedida") {
      return `Se alcanzó el límite de tanques del plan (${body.uso} de ${body.limite}). Importar ${filas} más lo superaría.`;
    }
    return "No tenés permiso para importar tanques.";
  }
  if (res.status === 400) {
    const body = await res.json().catch(() => null);
    const primero = body?.errors?.[0];
    if (primero) {
      // `field` viaja como "0.tanque_nombre" (índice de fila + columna, ver
      // validate.ts: issue.path.join(".")) -- hay que quedarse también con
      // la columna, no solo el índice: si no, el aviso dice "Fila 2:
      // Required" sin decir QUÉ campo falta.
      const partes = String(primero.field).split(".");
      const indice = Number(partes[0]);
      const campo = partes.slice(1).join(".");
      const ubicacion = Number.isInteger(indice)
        ? `Fila ${indice + 2}${campo ? ` (columna "${campo}")` : ""}: `
        : "";
      return `${ubicacion}${primero.message}`;
    }
    return "El archivo tiene filas con datos inválidos.";
  }
  return "El servidor rechazó la importación. Intentalo de nuevo.";
}

const FORM_INICIAL = {
  codigo: "",
  tanque_nombre: "",
  tipo_combustible: "diesel_b5" as Tanque["tipo_combustible"],
  unidad: "gal" as Tanque["unidad"],
  tipo_punto: "fijo" as Tanque["tipo_punto"],
  ubicacion: "",
  capacidad_total: "",
  nivel_actual: "0",
  nivel_minimo: "0",
  moneda: "PEN",
  activo: true,
  // Fase C (0064). Los defaults reproducen el comportamiento anterior a esa
  // migración: sin margen de tolerancia y con documento exigido.
  tolerancia_capacidad_pct: "0",
  requiere_documento: true,
  // Vacíos, no "0": desde la migración 0075 el 0 significa "estricto,
  // alertar por cualquier diferencia" y el vacío es "sin configurar".
  // Precargar un 0 le pondría a todo tanque nuevo la vigilancia más
  // estricta posible sin que nadie la pidiera.
  umbral_diferencia_pct: "",
  umbral_descuadre_pct: "",
  umbral_descuadre_ciclo_pct: "",
};

/** Campo vacío -> null (sin configurar). Cualquier número, incluido el 0,
 *  viaja tal cual. `Number("")` da 0, que desde 0075 significa lo contrario
 *  de lo que el campo vacío quiere decir -- de ahí que no alcance con
 *  convertir directo. */
function aNumeroONull(valor: string): number | null {
  const limpio = valor.trim();
  return limpio === "" ? null : Number(limpio);
}

function formatearFecha(iso: string): string {
  return new Date(iso).toLocaleString("es-PE", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function CombustiblePanel() {
  const [tanques, setTanques] = useState<Tanque[]>([]);
  const [loading, setLoading] = useState(true);

  // --- Alta / edición de tanque ---
  const [modalTanqueAbierto, setModalTanqueAbierto] = useState(false);
  const [editandoId, setEditandoId] = useState<number | null>(null);
  const [formData, setFormData] = useState(FORM_INICIAL);
  // Bloquea el botón mientras el request está en vuelo Y corta un segundo
  // submit que haya entrado antes del re-render (mismo patrón que
  // handleRegistrarMovimiento en RepuestosTable.tsx) -- esto NO participa
  // de la cola offline (alta de tanque es tarea de oficina, con red), así
  // que no hace falta cliente_uuid, solo esta guarda contra el doble clic.
  const [guardando, setGuardando] = useState(false);

  // --- Asistente de calibración de umbral (Fase D, entrega 3) ---
  // No se pide al crear un tanque (no tiene historial todavía), solo al
  // editar uno existente.
  const [sugerenciasUmbral, setSugerenciasUmbral] = useState<SugerenciasUmbral | null>(null);
  const [cargandoSugerenciaUmbral, setCargandoSugerenciaUmbral] = useState(false);
  const [mostrarMuestraUmbral, setMostrarMuestraUmbral] = useState(false);

  // --- Importación masiva ---
  const [importando, setImportando] = useState(false);
  const [errorImportacion, setErrorImportacion] = useState<string | null>(null);
  // Un solo banner verde para TODA la pantalla (importación y lectura), no
  // uno por flujo: si no, dos avisos de éxito podrían apilarse y compiten
  // por la atención en vez de sumarla.
  const [mensajeExito, setMensajeExito] = useState<string | null>(null);

  // --- Historial de lecturas (solo lectura, GET /:id/lecturas) ---
  const [tanqueHistorial, setTanqueHistorial] = useState<Tanque | null>(null);
  const [lecturas, setLecturas] = useState<Lectura[]>([]);
  const [cargandoLecturas, setCargandoLecturas] = useState(false);
  // Lectura que se está por anular (null = nadie). El motivo va en su propio
  // formulario y no en un window.prompt(): es obligatorio y queda guardado
  // como evidencia, así que merece un campo de verdad.
  const [lecturaAAnular, setLecturaAAnular] = useState<Lectura | null>(null);
  const [motivoAnulacion, setMotivoAnulacion] = useState("");
  const [anulando, setAnulando] = useState(false);

  // --- Registrar lectura (offline-capaz, como antes) ---
  const [tanqueLectura, setTanqueLectura] = useState<Tanque | null>(null);
  const [nivel, setNivel] = useState("");
  const [leidoEn, setLeidoEn] = useState(ahoraParaInputLocal());
  // Si el operario NO tocó la hora, la lectura es "ahora" y hay que
  // mandarla con precisión de segundos. El input datetime-local recorta a
  // minutos, y esos segundos perdidos hacen que una lectura tomada recién
  // quede fechada ANTES del alta del tanque (que sí guarda segundos) -- el
  // nivel entonces no se mueve, porque gana la lectura inicial.
  const [horaEditadaAMano, setHoraEditadaAMano] = useState(false);
  const [enviandoLectura, setEnviandoLectura] = useState(false);
  // El cliente_uuid se fija al ABRIR el modal, no al apretar el botón --
  // ver el mismo comentario donde vivía antes en este archivo.
  const [clienteUuid, setClienteUuid] = useState("");

  // --- Registrar despacho (Fase B, offline-capaz) ---
  const [equipos, setEquipos] = useState<Equipo[]>([]);
  const [modalDespachoAbierto, setModalDespachoAbierto] = useState(false);
  const [despachoForm, setDespachoForm] = useState(DESPACHO_FORM_INICIAL);
  const [despachadoEn, setDespachadoEn] = useState(ahoraParaInputLocal());
  // Mismo motivo que horaEditadaAMano de la lectura: si nadie toca el
  // campo, se manda el momento real del submit (con segundos), no el
  // valor con el que se abrió el modal.
  const [horaDespachoEditadaAMano, setHoraDespachoEditadaAMano] = useState(false);
  const [enviandoDespacho, setEnviandoDespacho] = useState(false);
  const [clienteUuidDespacho, setClienteUuidDespacho] = useState("");
  // El costo se autocompleta al elegir tanque/grifo -- pero si el operador
  // YA lo tocó a mano, no lo pisamos con un nuevo autocompletado (ej. si
  // cambia el tipo de combustible después de corregir el precio).
  const [costoEditadoAMano, setCostoEditadoAMano] = useState(false);

  // --- Grifos externos (migrations/0063) ---
  const [grifos, setGrifos] = useState<Grifo[]>([]);
  const [modalGrifosAbierto, setModalGrifosAbierto] = useState(false);
  const [nombreGrifoNuevo, setNombreGrifoNuevo] = useState("");
  // Los dos roles arrancan marcados (migrations/0065): el caso más común es un
  // proveedor que sirve para todo, y así el alta rápida sigue siendo un campo
  // y un botón como antes.
  const [rolesGrifoNuevo, setRolesGrifoNuevo] = useState({
    abastece_ruta: true,
    abastece_tanque: true,
  });
  const [guardandoGrifo, setGuardandoGrifo] = useState(false);

  // --- Precios de combustible (migrations/0063) ---
  const [precios, setPrecios] = useState<Precio[]>([]);
  const [modalPreciosAbierto, setModalPreciosAbierto] = useState(false);
  const [precioForm, setPrecioForm] = useState({
    tipo_combustible: "diesel_b5" as Tanque["tipo_combustible"],
    aplicaA: "tanque" as "tanque" | "grifo",
    combustible_id: "",
    grifo_id: "",
    precio_unitario: "",
  });
  const [vigenteDesde, setVigenteDesde] = useState(ahoraParaInputLocal());
  const [guardandoPrecio, setGuardandoPrecio] = useState(false);
  const [precioAAnular, setPrecioAAnular] = useState<Precio | null>(null);
  const [motivoAnulacionPrecio, setMotivoAnulacionPrecio] = useState("");
  const [anulandoPrecio, setAnulandoPrecio] = useState(false);

  // --- Historial de despachos (solo lectura, GET /despachos) ---
  const [modalHistorialDespachosAbierto, setModalHistorialDespachosAbierto] = useState(false);
  const [historialDespachos, setHistorialDespachos] = useState<DespachoHistorial[]>([]);
  const [cargandoHistorialDespachos, setCargandoHistorialDespachos] = useState(false);
  const [despachoAAnular, setDespachoAAnular] = useState<DespachoHistorial | null>(null);
  const [motivoAnulacionDespacho, setMotivoAnulacionDespacho] = useState("");
  const [anulandoDespacho, setAnulandoDespacho] = useState(false);

  // --- Alertas (migrations/0068) ---
  const [modalAlertasAbierto, setModalAlertasAbierto] = useState(false);
  const [alertasCombustible, setAlertasCombustible] = useState<AlertaCombustible[]>([]);
  const [cargandoAlertas, setCargandoAlertas] = useState(false);
  const [resolviendoAlertaId, setResolviendoAlertaId] = useState<number | null>(null);

  // --- Conciliación (Fase D, migraciones 0071/0072) ---
  // La ventana y las anomalías viven en el MISMO modal que las alertas: la
  // ventana gobierna cuándo una alerta se vuelve anomalía, así que verlas
  // juntas es lo que hace entendible el mecanismo.
  const [anomalias, setAnomalias] = useState<AnomaliaCombustible[]>([]);
  const [ventanaGraciaHoras, setVentanaGraciaHoras] = useState("72");
  const [guardandoVentana, setGuardandoVentana] = useState(false);
  // Plazo sin varilla (migración 0076). Comparte el mismo formulario y el
  // mismo PUT que la ventana de gracia: las dos son política del tenant.
  const [diasSinMedir, setDiasSinMedir] = useState("3");
  // Los dos topes diarios (0079). Vacío = sin configurar = no alerta, y por
  // eso arrancan en "" y no en un número: no hay default razonable para
  // "cuánto combustible es normal", eso lo sabe la operación, no el sistema.
  const [llenadosPorDia, setLlenadosPorDia] = useState("");
  const [topeSinCapacidad, setTopeSinCapacidad] = useState("");
  /** Hallazgos críticos SIN RESOLVER -- distinto de "sin leer": una alerta
   *  leída sigue abierta hasta que alguien la revisa y la cierra. */
  const [criticasAbiertas, setCriticasAbiertas] = useState(0);
  /** La alerta que se abrió desde la campanita, para llevarla a la vista y
   *  resaltarla. La notificación es un PUNTERO: su trabajo es dejarte
   *  parado sobre el hallazgo, no reemplazar a la bandeja donde se actúa. */
  const [alertaResaltadaId, setAlertaResaltadaId] = useState<number | null>(null);
  const [modalBitacoraAbierto, setModalBitacoraAbierto] = useState(false);
  const [cargandoBitacora, setCargandoBitacora] = useState(false);
  const [bitacora, setBitacora] = useState<EventoBitacora[]>([]);
  /** Cómo se vigila el tanque que se está creando. Arranca en null y hay que
   *  elegir: es la diferencia entre que el tanque quede ciego porque alguien
   *  lo decidió y que quede ciego porque nadie miró el formulario. */
  const [modoVigilancia, setModoVigilancia] = useState<
    "recomendado" | "personalizado" | "sin_vigilar" | null
  >(null);
  const cerrarModalAlertas = () => {
    setModalAlertasAbierto(false);
    setAlertaResaltadaId(null);
  };
  // La confirmación va DENTRO del modal, no en el banner verde de la
  // pantalla principal: ese banner queda tapado por el propio modal, así
  // que guardar parecía no hacer nada (reportado en pantalla por Kenif).
  const [mensajeVentana, setMensajeVentana] = useState<string | null>(null);

  // --- Recepciones (Fase C, migrations/0064) ---
  const [modalRecepcionAbierto, setModalRecepcionAbierto] = useState(false);
  const [recepcionForm, setRecepcionForm] = useState(RECEPCION_FORM_INICIAL);
  const [recibidoEn, setRecibidoEn] = useState(ahoraParaInputLocal());
  // Mismo mecanismo que en lecturas y despachos: si el operador no toca el
  // campo, se manda `new Date()` con segundos -- el input datetime-local
  // recorta a minutos, y esa pérdida de precisión hacía que una recepción
  // recién cargada quedara fechada ANTES de la última lectura.
  const [horaRecepcionEditadaAMano, setHoraRecepcionEditadaAMano] = useState(false);
  const [enviandoRecepcion, setEnviandoRecepcion] = useState(false);
  // Se fija al ABRIR el modal, no al apretar el botón -- ver
  // patron_doble_clic_formularios: el botón bloqueado solo no alcanza.
  const [clienteUuidRecepcion, setClienteUuidRecepcion] = useState("");
  const [modalHistorialRecepcionesAbierto, setModalHistorialRecepcionesAbierto] = useState(false);
  const [historialRecepciones, setHistorialRecepciones] = useState<RecepcionHistorial[]>([]);
  const [cargandoHistorialRecepciones, setCargandoHistorialRecepciones] = useState(false);
  const [recepcionAAnular, setRecepcionAAnular] = useState<RecepcionHistorial | null>(null);
  const [motivoAnulacionRecepcion, setMotivoAnulacionRecepcion] = useState("");
  const [anulandoRecepcion, setAnulandoRecepcion] = useState(false);

  const cargarTanques = useCallback(async () => {
    const res = await apiFetch("/api/erp/combustible");
    const data = await res.json();
    setTanques(Array.isArray(data) ? data : []);
  }, []);

  // pageSize=200 (el máximo, ver pagination.ts) alcanza para el <select> de
  // este formulario -- un buscador de equipos aparte es más de lo que Fase
  // B necesita ("solo lo indispensable para que el grifero pueda cargar
  // vales").
  const cargarEquipos = useCallback(async () => {
    const res = await apiFetch("/api/erp/equipos?pageSize=200");
    const body = await res.json().catch(() => null);
    setEquipos(Array.isArray(body?.data) ? body.data : []);
  }, []);

  const cargarGrifos = useCallback(async () => {
    const res = await apiFetch("/api/erp/combustible/grifos");
    const data = await res.json().catch(() => null);
    setGrifos(Array.isArray(data) ? data : []);
  }, []);

  // Los dos desplegables filtran por rol además de por `activo`
  // (migrations/0065). El filtro es comodidad: la regla la impone el servidor
  // (validarRolGrifo), así que un estado viejo en memoria no puede colar un
  // grifo del rol equivocado.
  const grifosDeRuta = useMemo(() => grifos.filter((g) => g.activo && g.abastece_ruta), [grifos]);
  const grifosDeTanque = useMemo(
    () => grifos.filter((g) => g.activo && g.abastece_tanque),
    [grifos]
  );

  const cargarPrecios = useCallback(async () => {
    const res = await apiFetch("/api/erp/combustible/precios");
    const data = await res.json().catch(() => null);
    setPrecios(Array.isArray(data) ? data : []);
  }, []);

  useEffect(() => {
    // Patrón estándar de carga al montar -- ver IpercView.tsx.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    Promise.all([cargarTanques(), cargarEquipos(), cargarGrifos()]).finally(() =>
      setLoading(false)
    );
  }, [cargarTanques, cargarEquipos, cargarGrifos]);

  /** Lleva la fila resaltada a la vista una vez que la bandeja terminó de
   *  cargar. Sin esto, en una lista larga el usuario aterriza arriba y la
   *  alerta que vino a ver puede estar veinte filas más abajo. */
  useEffect(() => {
    if (alertaResaltadaId === null || cargandoAlertas) return;
    const fila = document.getElementById(`alerta-${alertaResaltadaId}`);
    fila?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [alertaResaltadaId, cargandoAlertas, alertasCombustible]);

  /** Cuenta los hallazgos críticos abiertos para la franja de arriba. Pide
   *  TODAS las alertas y no solo las no leídas: el punto de la franja es que
   *  marcarlas leídas no las hace desaparecer. */
  const cargarCriticasAbiertas = useCallback(async () => {
    try {
      const res = await apiFetch("/api/erp/combustible/alertas?pageSize=200");
      if (!res.ok) return;
      const body = await res.json();
      const abiertas = (Array.isArray(body?.data) ? body.data : []).filter(
        (a: { tipo: string; resuelta_en: string | null }) =>
          a.resuelta_en === null && esCritica(a.tipo)
      );
      setCriticasAbiertas(abiertas.length);
    } catch {
      // Sin red la franja simplemente no aparece; no rompe la pantalla.
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargarCriticasAbiertas();
    // Mismo criterio que la campanita: el stream es el camino rápido, pero
    // el número no puede depender de que un socket haya sobrevivido.
    const repaso = setInterval(cargarCriticasAbiertas, 60_000);
    const alVolver = () => {
      if (document.visibilityState === "visible") cargarCriticasAbiertas();
    };
    document.addEventListener("visibilitychange", alVolver);
    return () => {
      clearInterval(repaso);
      document.removeEventListener("visibilitychange", alVolver);
    };
  }, [cargarCriticasAbiertas]);

  // Cuando la cola offline termina de drenar, una lectura cargada sin señal
  // ya existe del lado del servidor -- recargar pone nivel_actual al día
  // sin que el operario tenga que refrescar.
  useEffect(() => {
    return suscribirseASincronizacion(({ sincronizadas }) => {
      if (sincronizadas > 0) cargarTanques();
    });
  }, [cargarTanques]);

  // --- Alta / edición ---

  const abrirModalBitacora = async () => {
    setModalBitacoraAbierto(true);
    setCargandoBitacora(true);
    try {
      const res = await apiFetch("/api/erp/combustible/bitacora?pageSize=200");
      const body = await res.json().catch(() => null);
      setBitacora(Array.isArray(body?.data) ? body.data : []);
    } finally {
      setCargandoBitacora(false);
    }
  };

  const abrirModalNuevo = () => {
    setEditandoId(null);
    setFormData(FORM_INICIAL);
    setModoVigilancia(null);
    // Un tanque nuevo no tiene historial -- nada que sugerir todavía.
    setSugerenciasUmbral(null);
    setMostrarMuestraUmbral(false);
    setModalTanqueAbierto(true);
  };

  /** Fase D, entrega 3. Se pide al abrir el modal de edición, no al tipear
   *  en el input -- es una consulta contra todo el historial de
   *  recepciones del tanque, no algo para recalcular en cada tecla. */
  /** Valida la FORMA de la respuesta antes de guardarla, y descarta lo que
   *  no la cumpla.
   *
   *  No es paranoia: el endpoint devolvía la sugerencia suelta en la raíz y
   *  ahora devuelve `{ diferencia, descuadre, ciclo }`. Mientras el frontend
   *  ya tenía el código nuevo y el backend todavía el viejo, leer
   *  `.diferencia.muestraSuficiente` de un `undefined` tiraba la pantalla
   *  entera al error boundary -- pantalla amarilla, sin poder ni abrir la
   *  ficha del tanque.
   *
   *  Eso no es solo un problema de desarrollo: pasa en CADA deploy, con
   *  cualquiera que tenga la página abierta cuando el servidor se actualiza,
   *  o con un bundle cacheado. Una pantalla de configuración anti-fraude que
   *  se muere por eso es peor que una que muestra un widget de menos.
   *
   *  Con la forma inesperada se guarda `null`, que el render ya sabe tratar:
   *  simplemente no muestra la sugerencia. */
  const cargarSugerenciaUmbral = async (tanqueId: number) => {
    setCargandoSugerenciaUmbral(true);
    try {
      const res = await apiFetch(`/api/erp/combustible/${tanqueId}/sugerencia-umbral`);
      if (!res.ok) {
        setSugerenciasUmbral(null);
        return;
      }
      const body = await res.json().catch(() => null);
      const esSugerencia = (v: unknown) =>
        typeof v === "object" && v !== null && "muestraSuficiente" in v;
      const formaEsperada =
        body !== null &&
        esSugerencia(body.diferencia) &&
        esSugerencia(body.descuadre) &&
        esSugerencia(body.ciclo);

      setSugerenciasUmbral(formaEsperada ? body : null);
    } finally {
      setCargandoSugerenciaUmbral(false);
    }
  };

  const abrirModalEditar = (t: Tanque) => {
    // Editar no pregunta el modo: el tanque ya tiene una decisión tomada y
    // cambiarla pasa por los campos numéricos (y por el motivo obligatorio de
    // 0077 si afloja). "personalizado" deja los campos a la vista.
    setModoVigilancia("personalizado");
    setEditandoId(t.id);
    setSugerenciasUmbral(null);
    setMostrarMuestraUmbral(false);
    cargarSugerenciaUmbral(t.id);
    setFormData({
      codigo: t.codigo,
      tanque_nombre: t.tanque_nombre,
      tipo_combustible: t.tipo_combustible,
      unidad: t.unidad,
      tipo_punto: t.tipo_punto,
      ubicacion: t.ubicacion ?? "",
      capacidad_total: t.capacidad_total,
      // El formulario de edición no muestra el nivel (se corrige por
      // "Registrar lectura", no por acá), así que este valor solo llena el
      // estado. Un tanque sin lecturas cae a "0" nada más para que el campo
      // controlado no quede sin valor.
      nivel_actual: t.nivel_actual ?? "0",
      nivel_minimo: t.nivel_minimo,
      moneda: t.moneda,
      activo: t.activo,
      tolerancia_capacidad_pct: t.tolerancia_capacidad_pct,
      requiere_documento: t.requiere_documento,
      umbral_diferencia_pct: t.umbral_diferencia_pct ?? "",
      umbral_descuadre_pct: t.umbral_descuadre_pct ?? "",
      umbral_descuadre_ciclo_pct: t.umbral_descuadre_ciclo_pct ?? "",
    });
    setModalTanqueAbierto(true);
  };

  const handleGuardarTanque = async (e: React.FormEvent) => {
    e.preventDefault();
    if (guardando) return;

    // Sin elección no se guarda. Es el punto de toda la pantalla: que un
    // tanque ciego lo sea porque alguien lo decidió, no porque nadie miró.
    if (editandoId === null && modoVigilancia === null) {
      alert("Elegí cómo se va a vigilar este tanque antes de guardarlo.");
      return;
    }
    setGuardando(true);
    try {
      const esEdicion = editandoId !== null;
      const url = esEdicion ? `/api/erp/combustible/${editandoId}` : "/api/erp/combustible";
      const body = esEdicion
        ? {
            codigo: formData.codigo,
            tanque_nombre: formData.tanque_nombre,
            tipo_combustible: formData.tipo_combustible,
            unidad: formData.unidad,
            tipo_punto: formData.tipo_punto,
            ubicacion: formData.ubicacion || undefined,
            capacidad_total: Number(formData.capacidad_total),
            nivel_minimo: Number(formData.nivel_minimo),
            moneda: formData.moneda,
            activo: formData.activo,
            tolerancia_capacidad_pct: Number(formData.tolerancia_capacidad_pct),
            requiere_documento: formData.requiere_documento,
            umbral_diferencia_pct: aNumeroONull(formData.umbral_diferencia_pct),
            umbral_descuadre_pct: aNumeroONull(formData.umbral_descuadre_pct),
            umbral_descuadre_ciclo_pct: aNumeroONull(formData.umbral_descuadre_ciclo_pct),
          }
        : {
            codigo: formData.codigo,
            tanque_nombre: formData.tanque_nombre,
            tipo_combustible: formData.tipo_combustible,
            unidad: formData.unidad,
            tipo_punto: formData.tipo_punto,
            ubicacion: formData.ubicacion || undefined,
            capacidad_total: Number(formData.capacidad_total),
            nivel_actual: Number(formData.nivel_actual),
            nivel_minimo: Number(formData.nivel_minimo),
            moneda: formData.moneda,
            tolerancia_capacidad_pct: Number(formData.tolerancia_capacidad_pct),
            requiere_documento: formData.requiere_documento,
            umbral_diferencia_pct: aNumeroONull(formData.umbral_diferencia_pct),
            umbral_descuadre_pct: aNumeroONull(formData.umbral_descuadre_pct),
            umbral_descuadre_ciclo_pct: aNumeroONull(formData.umbral_descuadre_ciclo_pct),
            // Viaja para la auditoría del alta: distingue "eligió no vigilar"
            // de "configuró umbrales que dan lo mismo".
            modo_vigilancia: modoVigilancia,
          };

      const res = await apiFetch(url, {
        method: esEdicion ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));

        // El backend rechaza sin motivo cualquier cambio que AFLOJE una
        // vigilancia (subir un umbral, apagarlo, dejar de exigir documento).
        // Se pide acá y se reintenta en vez de mandar el motivo siempre:
        // renombrar un tanque no tiene por qué justificarse, y pedirlo en
        // cada guardado convertiría el campo en un trámite que se completa
        // con cualquier cosa.
        if (errBody.requiere_motivo) {
          const motivo = window.prompt(`${errBody.error}\n\nMotivo:`, "");
          if (!motivo || !motivo.trim()) return;

          const reintento = await apiFetch(url, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...body, motivo_ajuste: motivo.trim() }),
          });
          if (!reintento.ok) {
            const errReintento = await reintento.json().catch(() => ({}));
            alert(errReintento.error || "Error al guardar el tanque.");
            return;
          }
          setModalTanqueAbierto(false);
          setEditandoId(null);
          await cargarTanques();
          return;
        }

        alert(errBody.error || "Error al guardar el tanque.");
        return;
      }

      setModalTanqueAbierto(false);
      setEditandoId(null);
      await cargarTanques();
    } finally {
      setGuardando(false);
    }
  };

  /** Dar de baja un tanque APAGA su vigilancia: sale de la alerta de "sin
   *  medir" y deja de balancearse. Por eso pide motivo y avisa a los admins,
   *  igual que aflojar un umbral -- antes pedía menos que subir un
   *  porcentaje, que era exactamente al revés. */
  const handleDesactivar = async (t: Tanque) => {
    const motivo = window.prompt(
      `Desactivar "${t.tanque_nombre}" apaga su vigilancia: deja de balancearse y ` +
        `sale del aviso por falta de medición.\n\n¿Por qué se da de baja?`,
      ""
    );
    if (!motivo || !motivo.trim()) return;

    const res = await apiFetch(`/api/erp/combustible/${t.id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ motivo: motivo.trim() }),
    });
    if (!res.ok) {
      alert("No se pudo desactivar el tanque.");
      return;
    }
    await cargarTanques();
  };

  // --- Importación masiva -- xlsx se carga on-demand (import dinámico)
  // para que su chunk no viaje en el bundle inicial, mismo patrón que
  // RepuestosTable.tsx. ---
  const handleExcelUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Sin esto, elegir el MISMO archivo dos veces seguidas no dispara
    // onChange -- justo lo que querría hacer alguien que corrigió su
    // planilla y la vuelve a subir con el mismo nombre.
    e.target.value = "";
    if (!file) return;

    setErrorImportacion(null);
    setMensajeExito(null);
    setImportando(true);

    const reader = new FileReader();
    reader.onerror = () => {
      setImportando(false);
      setErrorImportacion("No se pudo leer el archivo.");
    };
    reader.onload = async (evt) => {
      try {
        const bstr = evt.target?.result;
        const XLSX = await import("xlsx");
        const wb = XLSX.read(bstr, { type: "binary" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        if (!ws) throw new Error("El archivo no tiene ninguna hoja de cálculo.");
        const data = XLSX.utils.sheet_to_json(ws);

        if (data.length === 0) throw new Error("La primera hoja está vacía.");
        if (data.length > MAX_FILAS_IMPORTACION) {
          throw new Error(
            `El archivo tiene ${data.length} filas y el máximo es ${MAX_FILAS_IMPORTACION}. Dividilo en varios archivos.`
          );
        }

        const res = await apiFetch("/api/erp/combustible/bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });

        if (!res.ok) {
          setErrorImportacion(await mensajeDeErrorDelServidor(res, data.length));
          return;
        }

        const body = await res.json().catch(() => ({}));
        const importados = body.insertados ?? data.length;
        // El alta obliga a elegir cómo se vigila el tanque; la planilla no
        // puede ser la forma de saltearse esa decisión sin enterarse. No se
        // bloquea la importación -- se dice, y la etiqueta roja de la lista
        // hace el resto.
        setMensajeExito(
          body.sinVigilancia > 0
            ? `Se importaron ${importados} tanques. ${body.sinVigilancia} quedaron SIN VIGILANCIA ` +
                `(la planilla no traía umbrales): el sistema no va a detectar faltantes en esos ` +
                `tanques hasta que los configures. Aparecen marcados en rojo en la lista.`
            : `Se importaron ${importados} tanques correctamente.`
        );
        await cargarTanques();
      } catch (err) {
        setErrorImportacion(err instanceof Error ? err.message : "Error al procesar el archivo.");
      } finally {
        setImportando(false);
      }
    };
    reader.readAsBinaryString(file);
  };

  // --- Historial de lecturas ---

  /** Trae el histórico del tanque bajo demanda (al abrir el modal), no en
   *  la carga inicial de la tabla: son datos que crecen con el trabajo de
   *  campo y solo hacen falta cuando alguien los pide -- traerlos para
   *  todos los tanques en cada render sería trabajo tirado. */
  /** Variación de cada lectura contra la ANTERIOR VIGENTE, no contra la fila
   *  de al lado. La diferencia importa: si una lectura anulada contara, un
   *  error de tipeo (500 en vez de 19.000) dejaría para siempre un -18.500
   *  seguido de un +18.500 en el historial -- exactamente el desbalance
   *  fantasma que la anulación viene a limpiar.
   *
   *  Las anuladas no reciben variación propia: ya no representan una
   *  medición del tanque. */
  const variacionPorLectura = useMemo(() => {
    const vigentes = lecturas.filter((l) => l.anulada_en === null);
    const porId = new Map<number, number>();
    // `lecturas` llega de la más reciente a la más vieja, así que la
    // anterior en el tiempo es la siguiente del array.
    vigentes.forEach((l, i) => {
      const anterior = vigentes[i + 1];
      if (anterior) porId.set(l.id, Number(l.nivel) - Number(anterior.nivel));
    });
    return porId;
  }, [lecturas]);

  const cargarLecturas = useCallback(async (tanqueId: number) => {
    setCargandoLecturas(true);
    try {
      const res = await apiFetch(`/api/erp/combustible/${tanqueId}/lecturas?pageSize=100`);
      if (!res.ok) {
        setLecturas([]);
        return;
      }
      const body = await res.json();
      setLecturas(Array.isArray(body.data) ? body.data : []);
    } catch {
      setLecturas([]);
    } finally {
      setCargandoLecturas(false);
    }
  }, []);

  const abrirModalHistorial = async (t: Tanque) => {
    setTanqueHistorial(t);
    setLecturas([]);
    await cargarLecturas(t.id);
  };

  const handleAnularLectura = async (e: React.FormEvent) => {
    e.preventDefault();
    if (anulando || !lecturaAAnular || !tanqueHistorial) return;
    setAnulando(true);
    try {
      const res = await apiFetch(`/api/erp/combustible/lecturas/${lecturaAAnular.id}/anular`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ motivo: motivoAnulacion }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(body.error || "No se pudo anular la lectura.");
        return;
      }

      setLecturaAAnular(null);
      setMotivoAnulacion("");
      // Se recargan las DOS cosas: el historial (para ver la fila tachada) y
      // la tabla de tanques -- anular puede hacer retroceder el nivel, así
      // que la fila de afuera queda desactualizada si no se refresca.
      await cargarLecturas(tanqueHistorial.id);
      await cargarTanques();
    } finally {
      setAnulando(false);
    }
  };

  // --- Registrar lectura ---

  const abrirModalLectura = (t: Tanque) => {
    setTanqueLectura(t);
    setNivel("");
    setLeidoEn(ahoraParaInputLocal());
    setHoraEditadaAMano(false);
    // Limpia el aviso de la operación anterior: si no, quien abre el modal
    // ve todavía el "Lectura registrada" de hace un rato y no sabe si
    // corresponde a lo que está por hacer ahora.
    setMensajeExito(null);
    // Se regenera en cada apertura -- ver el motivo en el comentario
    // original de este archivo (se perdería una lectura legítima si no).
    setClienteUuid(crypto.randomUUID());
  };

  const handleRegistrarLectura = async (e: React.FormEvent) => {
    e.preventDefault();
    if (enviandoLectura || !tanqueLectura) return;

    const nivelNuevo = Number(nivel);
    const capacidad = Number(tanqueLectura.capacidad_total);

    // Bloqueo duro: un tanque no puede contener más de lo que le entra. Se
    // avisa acá además de en el servidor (que igual lo rechaza con 400) solo
    // para no hacer viajar un dato que ya se sabe imposible y poder decirlo
    // con la capacidad concreta a la vista.
    if (nivelNuevo > capacidad) {
      alert(
        `El nivel no puede superar la capacidad del tanque ` +
          `(${capacidad.toLocaleString("es-PE")} ${tanqueLectura.unidad}).`
      );
      return;
    }

    // Confirmación solo si el salto es sospechoso -- ver
    // motivoParaConfirmarLectura.
    const aviso = motivoParaConfirmarLectura(
      nivelNuevo,
      Number(tanqueLectura.nivel_actual),
      capacidad,
      tanqueLectura.unidad
    );
    if (aviso && !window.confirm(aviso)) return;

    setEnviandoLectura(true);
    try {
      const res = await apiFetch("/api/erp/combustible/lecturas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cliente_uuid: clienteUuid,
          combustible_id: tanqueLectura.id,
          nivel: Number(nivel),
          leido_en: horaEditadaAMano ? new Date(leidoEn).toISOString() : new Date().toISOString(),
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(body.error || "Error al registrar la lectura.");
        return;
      }

      const nombreDelTanque = tanqueLectura.tanque_nombre;
      const unidadDelTanque = tanqueLectura.unidad;
      setTanqueLectura(null);

      // 202 = no había red y quedó en la cola del dispositivo (ver
      // apiFetch). No se recarga: sin señal el GET también falla.
      if (res.status === 202) {
        setMensajeExito(
          `Sin conexión: la lectura de ${nivelNuevo.toLocaleString("es-PE")} ${unidadDelTanque} ` +
            `quedó guardada en este equipo y se enviará sola cuando vuelva la señal.`
        );
        return;
      }

      // Confirmación explícita: hasta acá el modal se cerraba en silencio y
      // quien registraba no tenía forma de saber si se había guardado --
      // la duda típica lleva a cargar la lectura dos veces, que es peor.
      //
      // El nivel del mensaje sale de la RESPUESTA DEL SERVIDOR, no del
      // número que se tipeó: si la lectura quedó fechada antes que otra ya
      // registrada, el tanque conserva la más reciente y el nivel resultante
      // NO es el recién cargado. Anunciar el valor tipeado ahí contradiría a
      // la tabla en la misma pantalla.
      const body = await res.json().catch(() => null);
      const nivelResultante = body?.tanque?.nivel_actual;
      setMensajeExito(
        nivelResultante != null && Number(nivelResultante) !== nivelNuevo
          ? `Lectura registrada. ${nombreDelTanque} sigue mostrando ` +
              `${Number(nivelResultante).toLocaleString("es-PE")} ${unidadDelTanque}: ` +
              `hay una lectura posterior a la que acabás de cargar.`
          : `Lectura registrada: ${nombreDelTanque} quedó en ` +
              `${nivelNuevo.toLocaleString("es-PE")} ${unidadDelTanque}.`
      );
      await cargarTanques();
    } finally {
      setEnviandoLectura(false);
    }
  };

  // --- Registrar despacho (Fase B) ---

  const abrirModalDespacho = () => {
    setDespachoForm(DESPACHO_FORM_INICIAL);
    setDespachadoEn(ahoraParaInputLocal());
    setHoraDespachoEditadaAMano(false);
    setCostoEditadoAMano(false);
    setMensajeExito(null);
    setClienteUuidDespacho(crypto.randomUUID());
    setModalDespachoAbierto(true);
  };

  const equipoSeleccionado = equipos.find((eq) => eq.id === Number(despachoForm.equipo_id));

  const costoTotalCalculado =
    despachoForm.cantidad !== "" && despachoForm.costo_unitario !== ""
      ? Number(despachoForm.cantidad) * Number(despachoForm.costo_unitario)
      : null;

  // Autocompletado del C.U (migrations/0063): apenas hay tanque/grifo +
  // tipo de combustible elegidos, pide el precio vigente A LA FECHA DEL
  // DESPACHO (no "ahora") -- importante para un vale offline que se carga
  // en cancha y sincroniza horas después. Nunca pisa un valor que el
  // operador ya haya tocado a mano.
  useEffect(() => {
    if (!modalDespachoAbierto || costoEditadoAMano) return;
    const destinoId =
      despachoForm.origen === "tanque_propio" ? despachoForm.combustible_id : despachoForm.grifo_id;
    if (!destinoId) return;

    const fecha = horaDespachoEditadaAMano
      ? new Date(despachadoEn).toISOString()
      : new Date().toISOString();
    const params = new URLSearchParams({
      tipo_combustible: despachoForm.tipo_combustible,
      fecha,
      ...(despachoForm.origen === "tanque_propio"
        ? { combustible_id: destinoId }
        : { grifo_id: destinoId }),
    });

    let cancelado = false;
    apiFetch(`/api/erp/combustible/precios/vigente?${params.toString()}`)
      .then((res) => res.json())
      .then((body) => {
        if (cancelado || !body?.precio) return;

        setDespachoForm((prev) => ({
          ...prev,
          costo_unitario: String(body.precio.precio_unitario),
        }));
      })
      .catch(() => {
        // Sin precio cargado (o sin red): el campo queda como estaba, el
        // operador lo tipea a mano -- no es un error que merezca alerta.
      });
    return () => {
      cancelado = true;
    };
  }, [
    modalDespachoAbierto,
    costoEditadoAMano,
    despachoForm.origen,
    despachoForm.combustible_id,
    despachoForm.grifo_id,
    despachoForm.tipo_combustible,
    despachadoEn,
    horaDespachoEditadaAMano,
  ]);

  const handleRegistrarDespacho = async (e: React.FormEvent) => {
    e.preventDefault();
    if (enviandoDespacho) return;

    const despachadoEnIso = horaDespachoEditadaAMano
      ? new Date(despachadoEn).toISOString()
      : new Date().toISOString();

    // Solo se manda lo que aplica al origen elegido -- el resto queda fuera
    // del body en vez de ir como "" o 0, que el schema del servidor
    // rechazaría igual (ver crearDespachoCombustibleSchema.superRefine).
    const body =
      despachoForm.origen === "tanque_propio"
        ? {
            cliente_uuid: clienteUuidDespacho,
            origen: "tanque_propio",
            combustible_id: Number(despachoForm.combustible_id),
            tipo_combustible: despachoForm.tipo_combustible,
            tipo_destino: despachoForm.tipo_destino,
            equipo_id:
              despachoForm.tipo_destino === "equipo" ? Number(despachoForm.equipo_id) : undefined,
            serie_talonario: despachoForm.serie_talonario,
            n_vale: Number(despachoForm.n_vale),
            cantidad: Number(despachoForm.cantidad),
            lectura_contometro: Number(despachoForm.lectura_contometro),
            costo_unitario: Number(despachoForm.costo_unitario),
            observaciones: despachoForm.observaciones || undefined,
            despachado_en: despachadoEnIso,
          }
        : {
            cliente_uuid: clienteUuidDespacho,
            origen: "compra_externa",
            grifo_id: Number(despachoForm.grifo_id),
            tipo_combustible: despachoForm.tipo_combustible,
            tipo_destino: "equipo",
            equipo_id: Number(despachoForm.equipo_id),
            serie_talonario: despachoForm.serie_talonario,
            n_vale: Number(despachoForm.n_vale),
            cantidad: Number(despachoForm.cantidad),
            lectura_horometro:
              equipoSeleccionado?.tipo_medidor === "horometro"
                ? Number(despachoForm.lectura_horometro)
                : undefined,
            lectura_odometro:
              equipoSeleccionado?.tipo_medidor === "odometro"
                ? Number(despachoForm.lectura_odometro)
                : undefined,
            horas_abastecidas: Number(despachoForm.horas_abastecidas),
            costo_unitario: Number(despachoForm.costo_unitario),
            observaciones: despachoForm.observaciones || undefined,
            despachado_en: despachadoEnIso,
          };

    setEnviandoDespacho(true);
    try {
      const res = await apiFetch("/api/erp/combustible/despachos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        alert(errBody.error || errBody.errors?.[0]?.message || "Error al registrar el despacho.");
        return;
      }

      setModalDespachoAbierto(false);

      // 202 = sin red, quedó en la cola del dispositivo -- mismo criterio
      // que registrar una lectura.
      if (res.status === 202) {
        setMensajeExito(
          `Sin conexión: el vale ${despachoForm.n_vale} de la serie ${despachoForm.serie_talonario} ` +
            `quedó guardado en este equipo y se enviará solo cuando vuelva la señal.`
        );
        return;
      }

      setMensajeExito(
        `Despacho registrado: vale ${despachoForm.n_vale} de la serie ${despachoForm.serie_talonario}.`
      );
    } finally {
      setEnviandoDespacho(false);
    }
  };

  // --- Grifos externos (migrations/0063) ---

  const abrirModalGrifos = () => {
    setNombreGrifoNuevo("");
    setRolesGrifoNuevo({ abastece_ruta: true, abastece_tanque: true });
    setModalGrifosAbierto(true);
    cargarGrifos();
  };

  const handleCrearGrifo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (guardandoGrifo || !nombreGrifoNuevo.trim()) return;
    // Un grifo sin ningún rol no sirve para nada: no aparecería en ningún
    // desplegable y el servidor lo rechazaría en los dos casos.
    if (!rolesGrifoNuevo.abastece_ruta && !rolesGrifoNuevo.abastece_tanque) {
      alert("Marcá al menos un rol: abastece unidades en ruta, el tanque, o los dos.");
      return;
    }
    setGuardandoGrifo(true);
    try {
      const res = await apiFetch("/api/erp/combustible/grifos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nombre: nombreGrifoNuevo.trim(),
          abastece_ruta: rolesGrifoNuevo.abastece_ruta,
          abastece_tanque: rolesGrifoNuevo.abastece_tanque,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(body.error || "No se pudo crear el grifo.");
        return;
      }
      setNombreGrifoNuevo("");
      setRolesGrifoNuevo({ abastece_ruta: true, abastece_tanque: true });
      await cargarGrifos();
    } finally {
      setGuardandoGrifo(false);
    }
  };

  /** El PUT reemplaza la fila entera (el schema no tiene defaults), así que
   *  hay que mandar TODOS los campos aunque este botón solo cambie `activo` --
   *  omitir los roles daría 400. */
  const handleCambiarActivoGrifo = async (grifo: Grifo) => {
    const res = await apiFetch(`/api/erp/combustible/grifos/${grifo.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nombre: grifo.nombre,
        activo: !grifo.activo,
        abastece_ruta: grifo.abastece_ruta,
        abastece_tanque: grifo.abastece_tanque,
      }),
    });
    if (!res.ok) {
      alert("No se pudo actualizar el grifo.");
      return;
    }
    await cargarGrifos();
  };

  /** Cambia UN rol dejando el otro y `activo` como estaban -- mismo motivo que
   *  arriba: el PUT manda la fila completa. */
  const handleCambiarRolGrifo = async (
    grifo: Grifo,
    rol: "abastece_ruta" | "abastece_tanque",
    valor: boolean
  ) => {
    const res = await apiFetch(`/api/erp/combustible/grifos/${grifo.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nombre: grifo.nombre,
        activo: grifo.activo,
        abastece_ruta: rol === "abastece_ruta" ? valor : grifo.abastece_ruta,
        abastece_tanque: rol === "abastece_tanque" ? valor : grifo.abastece_tanque,
      }),
    });
    if (!res.ok) {
      alert("No se pudo actualizar el grifo.");
      return;
    }
    await cargarGrifos();
  };

  // --- Precios de combustible (migrations/0063) ---

  const abrirModalPrecios = () => {
    setPrecioForm({
      tipo_combustible: "diesel_b5",
      aplicaA: "tanque",
      combustible_id: "",
      grifo_id: "",
      precio_unitario: "",
    });
    setVigenteDesde(ahoraParaInputLocal());
    setModalPreciosAbierto(true);
    cargarPrecios();
  };

  const handleCrearPrecio = async (e: React.FormEvent) => {
    e.preventDefault();
    if (guardandoPrecio) return;
    setGuardandoPrecio(true);
    try {
      const res = await apiFetch("/api/erp/combustible/precios", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tipo_combustible: precioForm.tipo_combustible,
          combustible_id:
            precioForm.aplicaA === "tanque" ? Number(precioForm.combustible_id) : undefined,
          grifo_id: precioForm.aplicaA === "grifo" ? Number(precioForm.grifo_id) : undefined,
          precio_unitario: Number(precioForm.precio_unitario),
          vigente_desde: new Date(vigenteDesde).toISOString(),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(body.error || body.errors?.[0]?.message || "No se pudo cargar el precio.");
        return;
      }
      setPrecioForm({ ...precioForm, precio_unitario: "" });
      await cargarPrecios();
    } finally {
      setGuardandoPrecio(false);
    }
  };

  const handleAnularPrecio = async () => {
    if (anulandoPrecio || !precioAAnular || !motivoAnulacionPrecio.trim()) return;
    setAnulandoPrecio(true);
    try {
      const res = await apiFetch(`/api/erp/combustible/precios/${precioAAnular.id}/anular`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ motivo: motivoAnulacionPrecio }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(body.error || "No se pudo anular el precio.");
        return;
      }
      setPrecioAAnular(null);
      setMotivoAnulacionPrecio("");
      await cargarPrecios();
    } finally {
      setAnulandoPrecio(false);
    }
  };

  // --- Historial de despachos (solo lectura) ---

  const abrirModalHistorialDespachos = async () => {
    setModalHistorialDespachosAbierto(true);
    setCargandoHistorialDespachos(true);
    try {
      // pageSize=100, mismo techo que el historial de lecturas -- ver
      // pending_calidad_e2e_a11y (filtro por fecha queda para después).
      const res = await apiFetch("/api/erp/combustible/despachos?pageSize=100");
      const body = await res.json().catch(() => null);
      setHistorialDespachos(Array.isArray(body?.data) ? body.data : []);
    } finally {
      setCargandoHistorialDespachos(false);
    }
  };

  /** Anula un vale (punto 3 del documento). Recarga el historial: la fila no
   *  desaparece, cambia de estado -- y su número queda libre por si hay que
   *  recargar el mismo papel con el dato corregido. */
  const handleAnularDespacho = async () => {
    if (anulandoDespacho || !despachoAAnular || !motivoAnulacionDespacho.trim()) return;
    setAnulandoDespacho(true);
    try {
      const res = await apiFetch(`/api/erp/combustible/despachos/${despachoAAnular.id}/anular`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ motivo: motivoAnulacionDespacho }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(body.error || "No se pudo anular el despacho.");
        return;
      }
      setDespachoAAnular(null);
      setMotivoAnulacionDespacho("");
      await abrirModalHistorialDespachos();
    } finally {
      setAnulandoDespacho(false);
    }
  };

  /** Hueco de talonario y vale anulado (migrations/0068) -- mismo criterio
   *  de "gerencia lo ve en el momento" que la campanita del Header, esta es
   *  la pantalla completa a la que esa campanita lleva. */
  const abrirModalAlertas = async () => {
    setModalAlertasAbierto(true);
    setMensajeVentana(null);
    setCargandoAlertas(true);
    try {
      // Las tres cosas del mismo modal, en paralelo: los avisos vivos, los
      // hallazgos ya congelados, y la ventana que separa unos de otros.
      const [resAlertas, resAnomalias, resConfig] = await Promise.all([
        apiFetch("/api/erp/combustible/alertas?pageSize=100"),
        apiFetch("/api/erp/combustible/anomalias?pageSize=100"),
        apiFetch("/api/erp/combustible/config"),
      ]);
      const bodyAlertas = await resAlertas.json().catch(() => null);
      const bodyAnomalias = await resAnomalias.json().catch(() => null);
      const bodyConfig = await resConfig.json().catch(() => null);

      setAlertasCombustible(Array.isArray(bodyAlertas?.data) ? bodyAlertas.data : []);
      setAnomalias(Array.isArray(bodyAnomalias?.data) ? bodyAnomalias.data : []);
      if (bodyConfig?.ventana_gracia_horas !== undefined) {
        setVentanaGraciaHoras(String(bodyConfig.ventana_gracia_horas));
      }
      if (bodyConfig?.dias_sin_medir !== undefined) {
        setDiasSinMedir(String(bodyConfig.dias_sin_medir));
      }
      // null llega como "sin configurar" y tiene que verse como campo vacío,
      // no como "null" escrito adentro del input.
      setLlenadosPorDia(
        bodyConfig?.llenados_por_dia_max == null ? "" : String(bodyConfig.llenados_por_dia_max)
      );
      setTopeSinCapacidad(
        bodyConfig?.tope_diario_sin_capacidad_l == null
          ? ""
          : String(bodyConfig.tope_diario_sin_capacidad_l)
      );
    } finally {
      setCargandoAlertas(false);
    }
  };

  /** La campanita avisa por `window` y no por props: el Header y este panel
   *  están separados por el `children` del Layout, y enhebrar el id a través
   *  de esa frontera pediría reestructurar tres componentes para un salto.
   *
   *  (Además evita un import compartido entre estos dos archivos, que es lo
   *  que hace crashear a eslint-plugin-import -- ver gravedadAlertas.ts.) */
  useEffect(() => {
    const alClickearNotificacion = (evento: Event) => {
      const alertaId = (evento as CustomEvent<{ alertaId: number }>).detail?.alertaId;
      if (typeof alertaId !== "number") return;
      setAlertaResaltadaId(alertaId);
      abrirModalAlertas();
    };
    window.addEventListener("combustible:abrir-alerta", alClickearNotificacion);
    return () => window.removeEventListener("combustible:abrir-alerta", alClickearNotificacion);
    // abrirModalAlertas se redefine en cada render y no hace falta re-suscribir.
  }, []);

  /** Subir la ventana AFLOJA el control (los hallazgos tardan más en
   *  congelarse), por eso el backend lo audita con el "quién". */
  const handleGuardarVentana = async () => {
    const horas = Number(ventanaGraciaHoras);
    const dias = Number(diasSinMedir);
    if (guardandoVentana || !Number.isInteger(horas) || horas < 1 || horas > 8760) return;
    if (!Number.isInteger(dias) || dias < 1 || dias > 365) return;
    setGuardandoVentana(true);
    try {
      // Campo vacío = null = sin configurar. Number("") es 0, que acá
      // significaría "nadie puede recibir nada" -- de ahí el trim() antes.
      const aNumeroOVacio = (v: string) => (v.trim() === "" ? null : Number(v));
      const llenados = aNumeroOVacio(llenadosPorDia);
      const topeSC = aNumeroOVacio(topeSinCapacidad);
      if (llenados !== null && (!Number.isFinite(llenados) || llenados < 0.1 || llenados > 50)) {
        setMensajeVentana("Los llenados por día van entre 0,1 y 50 (o vacío para no vigilar).");
        return;
      }
      if (topeSC !== null && (!Number.isFinite(topeSC) || topeSC <= 0)) {
        setMensajeVentana("El tope diario tiene que ser mayor a cero (o vacío para no vigilar).");
        return;
      }

      const res = await apiFetch("/api/erp/combustible/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ventana_gracia_horas: horas,
          dias_sin_medir: dias,
          llenados_por_dia_max: llenados,
          tope_diario_sin_capacidad_l: topeSC,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setMensajeVentana(body.error || "No se pudo guardar la configuración.");
        return;
      }
      setMensajeVentana(`Guardado: ventana ${horas} h, aviso sin medir a los ${dias} días`);
    } finally {
      setGuardandoVentana(false);
    }
  };

  /** Aplica a los siete tipos que alguien tiene que mirar (0077 sumó los
   *  cuatro que habían quedado sin camino de cierre). Los que se resuelven
   *  solos no están: el hueco cuando llega el vale, el nivel bajo cuando se
   *  repone, el "sin medir" cuando se mide.
   *
   *  El MOTIVO es obligatorio desde 0077: cerrar una alerta anti-fraude sin
   *  decir por qué es indistinguible de taparla. Es la misma regla que ya
   *  regía para anular una lectura o un vale. */
  const handleResolverAlerta = async (alertaId: number) => {
    if (resolviendoAlertaId !== null) return;

    const motivo = window.prompt(
      "¿Por qué se da por revisada esta alerta?\n\nQueda registrado con tu nombre.",
      ""
    );
    if (!motivo || !motivo.trim()) return;

    setResolviendoAlertaId(alertaId);
    try {
      const res = await apiFetch(`/api/erp/combustible/alertas/${alertaId}/resolver`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ motivo: motivo.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(body.error || "No se pudo resolver la alerta.");
        return;
      }
      await abrirModalAlertas();
      // La franja de arriba tiene que bajar el conteo en el momento: si
      // sigue mostrando el número viejo, el usuario cree que no se guardó.
      await cargarCriticasAbiertas();
    } finally {
      setResolviendoAlertaId(null);
    }
  };

  // --- Recepciones (Fase C, migrations/0064) ---

  const abrirModalRecepcion = () => {
    setRecepcionForm(RECEPCION_FORM_INICIAL);
    setRecibidoEn(ahoraParaInputLocal());
    setHoraRecepcionEditadaAMano(false);
    setMensajeExito(null);
    setClienteUuidRecepcion(crypto.randomUUID());
    setModalRecepcionAbierto(true);
  };

  const tanqueRecepcion = tanques.find((t) => t.id === Number(recepcionForm.combustible_id));

  const costoTotalRecepcion =
    recepcionForm.cantidad !== "" && recepcionForm.costo_unitario !== ""
      ? Number(recepcionForm.cantidad) * Number(recepcionForm.costo_unitario)
      : null;

  /** Espejo en el cliente del bloqueo por capacidad del service: avisa
   *  ANTES de mandar, con el mismo criterio (nivel medido + cantidad contra
   *  capacidad * (1 + tolerancia)). El servidor lo revalida igual -- esto es
   *  para que el usuario lo vea mientras tipea, no una defensa.
   *
   *  Devuelve null si no hay nada que advertir o si falta algún dato. */
  const avisoCapacidadRecepcion = (() => {
    if (!tanqueRecepcion || recepcionForm.cantidad === "") return null;
    // nivel_actual null = el tanque no tiene lectura vigente. El servidor va
    // a rechazar la recepción por eso mismo, así que conviene decirlo acá.
    if (tanqueRecepcion.nivel_actual === null) {
      return "Este tanque no tiene ninguna lectura de varilla vigente. Registrá primero la lectura: sin ella no se puede validar la capacidad ni calcular el costo promedio.";
    }
    const nivel = Number(tanqueRecepcion.nivel_actual);
    const capacidad = Number(tanqueRecepcion.capacidad_total);
    const techo = capacidad * (1 + Number(tanqueRecepcion.tolerancia_capacidad_pct) / 100);
    if (nivel + Number(recepcionForm.cantidad) > techo) {
      return `No entra: el tanque tiene ${nivel.toLocaleString("es-PE")} ${tanqueRecepcion.unidad} medidos y su tope es ${techo.toLocaleString("es-PE")} ${tanqueRecepcion.unidad}.`;
    }
    return null;
  })();

  const handleRegistrarRecepcion = async (e: React.FormEvent) => {
    e.preventDefault();
    if (enviandoRecepcion) return;

    const recibidoEnIso = horaRecepcionEditadaAMano
      ? new Date(recibidoEn).toISOString()
      : new Date().toISOString();

    // El documento solo viaja si se llenó -- tipo y número van juntos o no
    // van (lo exige el superRefine del schema y el CHECK de 0064). Un tanque
    // con requiere_documento=false puede mandarlos igual si el operador los
    // tiene a mano.
    const conDocumento = recepcionForm.numero_documento.trim() !== "";

    setEnviandoRecepcion(true);
    try {
      const res = await apiFetch("/api/erp/combustible/recepciones", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cliente_uuid: clienteUuidRecepcion,
          combustible_id: Number(recepcionForm.combustible_id),
          grifo_id: Number(recepcionForm.grifo_id),
          cantidad: Number(recepcionForm.cantidad),
          costo_unitario: Number(recepcionForm.costo_unitario),
          tipo_documento: conDocumento ? recepcionForm.tipo_documento : undefined,
          numero_documento: conDocumento ? recepcionForm.numero_documento.trim() : undefined,
          recibido_en: recibidoEnIso,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(body.error || body.errors?.[0]?.message || "Error al registrar la recepción.");
        return;
      }

      setModalRecepcionAbierto(false);
      // Recargar: el costo promedio del tanque acaba de cambiar y se muestra
      // en la tabla.
      await cargarTanques();
      setMensajeExito(
        `Recepción registrada: ${Number(recepcionForm.cantidad).toLocaleString("es-PE")} ` +
          `${tanqueRecepcion?.unidad ?? ""} en ${tanqueRecepcion?.tanque_nombre ?? "el tanque"}. ` +
          `El nivel NO cambia hasta la próxima lectura de varilla.`
      );
    } finally {
      setEnviandoRecepcion(false);
    }
  };

  const cargarHistorialRecepciones = useCallback(async () => {
    setCargandoHistorialRecepciones(true);
    try {
      // pageSize=100, mismo techo que los otros dos historiales.
      const res = await apiFetch("/api/erp/combustible/recepciones?pageSize=100");
      const body = await res.json().catch(() => null);
      setHistorialRecepciones(Array.isArray(body?.data) ? body.data : []);
    } finally {
      setCargandoHistorialRecepciones(false);
    }
  }, []);

  const abrirModalHistorialRecepciones = async () => {
    setModalHistorialRecepcionesAbierto(true);
    await cargarHistorialRecepciones();
  };

  const handleAnularRecepcion = async () => {
    if (anulandoRecepcion || !recepcionAAnular || !motivoAnulacionRecepcion.trim()) return;
    setAnulandoRecepcion(true);
    try {
      const res = await apiFetch(`/api/erp/combustible/recepciones/${recepcionAAnular.id}/anular`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ motivo: motivoAnulacionRecepcion }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(body.error || "No se pudo anular la recepción.");
        return;
      }
      setRecepcionAAnular(null);
      setMotivoAnulacionRecepcion("");
      // El costo promedio del tanque se recalculó sin esta fila -- hay que
      // recargar las dos cosas.
      await Promise.all([cargarHistorialRecepciones(), cargarTanques()]);
    } finally {
      setAnulandoRecepcion(false);
    }
  };

  if (loading) {
    return <div className="p-10">Cargando combustible...</div>;
  }

  return (
    <div className="p-4 lg:p-8 animate-in fade-in duration-500">
      {/* Franja de hallazgos SIN RESOLVER. No se puede cerrar y no se va
          sola: desaparece cuando alguien resuelve las alertas, que es la
          única forma de que el problema deje de existir.

          Va acá arriba y no en la campanita porque una alerta anti-fraude
          leída sigue estando abierta -- "leí" no es "revisé", y esa
          confusión es justo la que hizo desaparecer una alerta de descuadre
          nueve segundos después de nacer. */}
      {criticasAbiertas > 0 && (
        <button
          onClick={abrirModalAlertas}
          className="w-full mb-6 flex items-center gap-3 rounded-xl border-2 border-red-300 bg-red-50 px-5 py-4 text-left hover:bg-red-100 transition-colors"
        >
          <span className="text-2xl leading-none">⚠️</span>
          <span className="flex-1">
            <span className="block text-sm font-bold text-red-800">
              {criticasAbiertas === 1
                ? "Hay 1 hallazgo sin resolver"
                : `Hay ${criticasAbiertas} hallazgos sin resolver`}
            </span>
            <span className="block text-xs text-red-700">
              Combustible o vales que no cuadran. Requieren que alguien los revise y los cierre
              indicando el motivo.
            </span>
          </span>
          <span className="text-xs font-semibold text-red-800 underline">Revisar</span>
        </button>
      )}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6 mb-10">
        <div>
          <h1 className="text-3xl font-bold text-slate-800">Control de Combustible</h1>
          <p className="text-slate-500">Tanques y puntos de abastecimiento</p>
        </div>
        <div className="flex items-center gap-3">
          <label
            className={`px-4 py-2.5 border rounded-xl flex items-center gap-2 transition-all ${
              importando
                ? "bg-emerald-100 text-emerald-400 border-emerald-200 cursor-wait"
                : "bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100 cursor-pointer"
            }`}
          >
            <span>📊 {importando ? "Importando..." : "Importar Excel"}</span>
            <input
              type="file"
              accept=".xlsx, .xls"
              className="hidden"
              disabled={importando}
              onChange={handleExcelUpload}
            />
          </label>
          <button
            onClick={abrirModalHistorialDespachos}
            className="px-4 py-2.5 border border-slate-200 text-slate-600 hover:bg-slate-50 font-medium rounded-xl transition-all"
          >
            📋 Historial de despachos
          </button>
          <button
            onClick={abrirModalHistorialRecepciones}
            className="px-4 py-2.5 border border-slate-200 text-slate-600 hover:bg-slate-50 font-medium rounded-xl transition-all"
          >
            🧾 Historial de recepciones
          </button>
          <button
            onClick={abrirModalAlertas}
            className="px-4 py-2.5 border border-slate-200 text-slate-600 hover:bg-slate-50 font-medium rounded-xl transition-all"
          >
            🔔 Alertas
          </button>
          <button
            onClick={abrirModalBitacora}
            className="px-4 py-2.5 border border-slate-200 text-slate-600 hover:bg-slate-50 font-medium rounded-xl transition-all"
            title="Quién cambió qué en este módulo"
          >
            📓 Bitácora
          </button>
          <button
            onClick={abrirModalGrifos}
            className="px-4 py-2.5 border border-slate-200 text-slate-600 hover:bg-slate-50 font-medium rounded-xl transition-all"
          >
            Grifos / Proveedores
          </button>
          <button
            onClick={abrirModalPrecios}
            className="px-4 py-2.5 border border-slate-200 text-slate-600 hover:bg-slate-50 font-medium rounded-xl transition-all"
          >
            Precios
          </button>
          <button
            onClick={abrirModalRecepcion}
            className="px-6 py-2.5 bg-sky-600 hover:bg-sky-700 text-white font-medium rounded-xl transition-all"
          >
            🚚 Registrar recepción
          </button>
          <button
            onClick={abrirModalDespacho}
            className="px-6 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-medium rounded-xl transition-all"
          >
            ⛽ Registrar despacho
          </button>
          <button
            onClick={abrirModalNuevo}
            className="px-6 py-2.5 bg-slate-900 hover:bg-slate-800 text-white font-medium rounded-xl transition-all"
          >
            + Nuevo Tanque
          </button>
        </div>
      </div>
      {errorImportacion && (
        <div className="mb-6 bg-red-50 border border-red-200 rounded-lg p-4 flex items-start gap-3">
          <p className="text-sm text-red-900 font-light flex-1">{errorImportacion}</p>
          <button
            className="text-red-400 hover:text-red-600 text-sm shrink-0"
            onClick={() => setErrorImportacion(null)}
            aria-label="Cerrar aviso de error"
          >
            ✕
          </button>
        </div>
      )}
      {mensajeExito && (
        <div className="mb-6 bg-green-50 border border-green-200 rounded-lg p-4 flex items-start gap-3">
          <p className="text-sm text-green-900 font-light flex-1">{mensajeExito}</p>
          <button
            className="text-green-500 hover:text-green-700 text-sm shrink-0"
            onClick={() => setMensajeExito(null)}
            aria-label="Cerrar aviso de importación"
          >
            ✕
          </button>
        </div>
      )}
      {/**AGREGAR MAS COLUMNAS  */}{" "}
      {tanques.length === 0 ? (
        <div className="bg-slate-50 border border-slate-200 border-dashed rounded-xl p-10 text-center text-slate-500">
          No hay tanques registrados todavía.
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-3xl overflow-hidden shadow-sm overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead className="bg-slate-50">
              <tr>
                <th className="p-4 text-xs font-bold text-slate-400 uppercase tracking-widest">
                  Código
                </th>
                <th className="p-4 text-xs font-bold text-slate-400 uppercase tracking-widest">
                  Nombre
                </th>
                <th className="p-4 text-xs font-bold text-slate-400 uppercase tracking-widest">
                  Tipo
                </th>
                <th className="p-4 text-xs font-bold text-slate-400 uppercase tracking-widest">
                  Punto
                </th>
                <th className="p-4 text-xs font-bold text-slate-400 uppercase tracking-widest">
                  Humbral minimo
                </th>
                <th className="p-4 text-xs font-bold text-slate-400 uppercase tracking-widest">
                  Nivel
                </th>
                <th className="p-4 text-xs font-bold text-slate-400 uppercase tracking-widest">
                  Costo prom.
                </th>
                <th className="p-4 text-xs font-bold text-slate-400 uppercase tracking-widest">
                  Estado
                </th>
                <th className="p-4 text-xs font-bold text-slate-400 uppercase tracking-widest text-right">
                  Acciones
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {tanques.map((t) => {
                // Sin lecturas vigentes el nivel es desconocido: no se pinta
                // ni de rojo ni de verde, porque las dos afirmarían algo que
                // nadie midió.
                const sinNivel = t.nivel_actual === null;
                // Una sola fuente de verdad para el color: el umbral y el
                // nivel tienen que pintarse SIEMPRE igual -- si viven
                // separados, un cambio futuro en la regla los deja
                // contradiciéndose en la misma fila.
                const bajoUmbral = Number(t.nivel_actual) <= Number(t.nivel_minimo);
                const colorNivel = sinNivel
                  ? "text-slate-400"
                  : bajoUmbral
                    ? "text-red-500"
                    : "text-emerald-600";
                return (
                  <tr key={t.id} className="hover:bg-slate-50/50 transition-colors">
                    <td className="p-4 font-mono text-sm text-slate-500">{t.codigo}</td>
                    <td className="p-4 text-sm font-semibold text-slate-800">
                      {t.tanque_nombre}
                      {t.ubicacion && <p className="text-xs text-slate-400">{t.ubicacion}</p>}
                    </td>
                    <td className="p-4 text-sm text-slate-600">
                      {ETIQUETA_TIPO_COMBUSTIBLE[t.tipo_combustible]}
                    </td>
                    <td className="p-4 text-sm text-slate-600">
                      {ETIQUETA_TIPO_PUNTO[t.tipo_punto]}
                    </td>
                    <td className="p-4 text-sm">
                      <span className={`font-medium ${colorNivel}`}>
                        {Number(t.nivel_minimo).toLocaleString("es-PE")} {t.unidad}
                      </span>
                    </td>
                    <td className="p-4 text-sm">
                      {sinNivel ? (
                        <>
                          <span className="text-slate-400 italic">Sin lecturas</span>
                          <p className="text-xs text-slate-400">
                            Capacidad: {Number(t.capacidad_total).toLocaleString("es-PE")}{" "}
                            {t.unidad}
                          </p>
                        </>
                      ) : (
                        <>
                          <span className={`font-bold ${colorNivel}`}>
                            {Number(t.nivel_actual).toLocaleString("es-PE")}
                          </span>
                          <span className="text-slate-400">
                            {" "}
                            / {Number(t.capacidad_total).toLocaleString("es-PE")} {t.unidad} (
                            {t.porcentaje}%)
                          </span>
                          <p className="text-xs text-slate-400">
                            Última lectura: {formatearFecha(t.fecha_actualizacion!)}
                          </p>
                        </>
                      )}
                    </td>
                    {/* Fase C (0064) -- solo lectura: lo escribe el motor de
                        recepciones. 0 significa "todavía no se registró
                        ninguna compra", no "sale gratis": decirlo con
                        palabras evita que se lea como un precio real. */}
                    <td className="p-4 text-sm">
                      {Number(t.costo_promedio) === 0 ? (
                        <span className="text-slate-400 italic text-xs">Sin recepciones</span>
                      ) : (
                        <span className="font-medium text-slate-700">
                          {t.moneda} {Number(t.costo_promedio).toFixed(4)}
                          <span className="text-slate-400 font-normal"> / {t.unidad}</span>
                        </span>
                      )}
                    </td>
                    <td className="p-4 text-sm">
                      <span
                        className={`px-2 py-1 rounded-full text-xs font-medium ${
                          t.activo
                            ? "bg-emerald-50 text-emerald-700"
                            : "bg-slate-100 text-slate-500"
                        }`}
                      >
                        {t.activo ? "Activo" : "Desactivado"}
                      </span>
                      {(() => {
                        const v = vigilanciaDe(t);
                        if (v.nivel === "completa") return null;
                        return (
                          <span
                            title={v.apagados.join("\n")}
                            className={`mt-1 block w-fit px-2 py-1 rounded-full text-xs font-semibold cursor-help ${
                              v.nivel === "sin"
                                ? "bg-red-50 text-red-700 ring-1 ring-red-200"
                                : "bg-amber-50 text-amber-700 ring-1 ring-amber-200"
                            }`}
                          >
                            {v.nivel === "sin" ? "Sin vigilancia" : "Vigilancia parcial"}
                          </span>
                        );
                      })()}
                    </td>
                    <td className="p-4 text-right space-x-2">
                      <button
                        onClick={() => abrirModalHistorial(t)}
                        className="p-2 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all"
                        title="Ver historial de lecturas"
                      >
                        📋
                      </button>
                      <button
                        onClick={() => abrirModalLectura(t)}
                        className="p-2 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all"
                        title="Registrar lectura"
                      >
                        ⛽
                      </button>
                      <button
                        onClick={() => abrirModalEditar(t)}
                        className="p-2 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all"
                        title="Editar"
                      >
                        ✏️
                      </button>
                      {t.activo && (
                        <button
                          onClick={() => handleDesactivar(t)}
                          className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all"
                          title="Desactivar"
                        >
                          🗑️
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {/* Modal: alta / edición de tanque */}
      {modalTanqueAbierto && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center z-50 p-4">
          <div className="bg-white w-full max-w-lg rounded-3xl shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b flex justify-between items-center">
              <h3 className="text-xl font-bold">{editandoId ? "Editar Tanque" : "Nuevo Tanque"}</h3>
              <button
                onClick={() => setModalTanqueAbierto(false)}
                className="text-slate-400 hover:text-slate-900 text-2xl"
              >
                ×
              </button>
            </div>
            <form onSubmit={handleGuardarTanque} className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label
                    htmlFor="tanque-codigo"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    Código
                  </label>
                  <input
                    id="tanque-codigo"
                    type="text"
                    placeholder="Ej: TQ-01"
                    required
                    maxLength={50}
                    className="w-full border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-slate-900"
                    value={formData.codigo}
                    onChange={(e) => setFormData({ ...formData, codigo: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <label
                    htmlFor="tanque-nombre"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    Nombre
                  </label>
                  <input
                    id="tanque-nombre"
                    type="text"
                    required
                    maxLength={100}
                    className="w-full border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-slate-900"
                    value={formData.tanque_nombre}
                    onChange={(e) => setFormData({ ...formData, tanque_nombre: e.target.value })}
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-1">
                  <label
                    htmlFor="tanque-tipo-combustible"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    Combustible
                  </label>
                  <select
                    id="tanque-tipo-combustible"
                    className="w-full border border-slate-200 rounded-xl p-3 outline-none bg-white focus:ring-2 focus:ring-slate-900"
                    value={formData.tipo_combustible}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        tipo_combustible: e.target.value as Tanque["tipo_combustible"],
                      })
                    }
                  >
                    {Object.entries(ETIQUETA_TIPO_COMBUSTIBLE).map(([valor, etiqueta]) => (
                      <option key={valor} value={valor}>
                        {etiqueta}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <label
                    htmlFor="tanque-unidad"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    Unidad
                  </label>
                  <select
                    id="tanque-unidad"
                    className="w-full border border-slate-200 rounded-xl p-3 outline-none bg-white focus:ring-2 focus:ring-slate-900"
                    value={formData.unidad}
                    onChange={(e) =>
                      setFormData({ ...formData, unidad: e.target.value as Tanque["unidad"] })
                    }
                  >
                    <option value="gal">Galones</option>
                    <option value="L">Litros</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <label
                    htmlFor="tanque-tipo-punto"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    Punto
                  </label>
                  <select
                    id="tanque-tipo-punto"
                    className="w-full border border-slate-200 rounded-xl p-3 outline-none bg-white focus:ring-2 focus:ring-slate-900"
                    value={formData.tipo_punto}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        tipo_punto: e.target.value as Tanque["tipo_punto"],
                      })
                    }
                  >
                    {Object.entries(ETIQUETA_TIPO_PUNTO).map(([valor, etiqueta]) => (
                      <option key={valor} value={valor}>
                        {etiqueta}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="space-y-1">
                <label
                  htmlFor="tanque-ubicacion"
                  className="text-xs font-bold text-slate-500 uppercase"
                >
                  Ubicación (opcional)
                </label>
                <input
                  id="tanque-ubicacion"
                  type="text"
                  maxLength={200}
                  placeholder="Ej: Grifo Cantera"
                  className="w-full border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-slate-900"
                  value={formData.ubicacion}
                  onChange={(e) => setFormData({ ...formData, ubicacion: e.target.value })}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label
                    htmlFor="tanque-capacidad"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    Capacidad total
                  </label>
                  <input
                    id="tanque-capacidad"
                    type="number"
                    min={0.01}
                    step="0.01"
                    required
                    className="w-full border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-slate-900"
                    value={formData.capacidad_total}
                    onChange={(e) => setFormData({ ...formData, capacidad_total: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <label
                    htmlFor="tanque-nivel-minimo"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    Nivel mínimo (alerta)
                  </label>
                  <input
                    id="tanque-nivel-minimo"
                    type="number"
                    min={0}
                    step="0.01"
                    className="w-full border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-slate-900"
                    value={formData.nivel_minimo}
                    onChange={(e) => setFormData({ ...formData, nivel_minimo: e.target.value })}
                  />
                </div>
              </div>

              {/* nivel_actual solo se pide al CREAR -- editar un tanque
                  existente no es el camino para corregir su nivel, eso pasa
                  por "Registrar lectura" (ver el comentario en el schema). */}
              {editandoId === null && (
                <div className="space-y-1">
                  <label
                    htmlFor="tanque-nivel-actual"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    Nivel inicial
                  </label>
                  <input
                    id="tanque-nivel-actual"
                    type="number"
                    min={0}
                    step="0.01"
                    className="w-full border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-slate-900"
                    value={formData.nivel_actual}
                    onChange={(e) => setFormData({ ...formData, nivel_actual: e.target.value })}
                  />
                </div>
              )}
              {/* ¿Cómo vigilamos este tanque? -- Solo al CREAR.

                  El problema que resuelve: los tres umbrales nacían vacíos al
                  fondo del formulario, así que el caso por defecto era un
                  tanque que no vigila nada, y nadie lo había elegido. Acá la
                  omisión deja de ser posible: hay que marcar una opción para
                  poder guardar, y "sin vigilar" queda como una decisión con
                  nombre y fecha en la auditoría. */}
              {editandoId === null && (
                <div className="border-t border-slate-100 pt-4 space-y-3">
                  <p className="text-xs font-bold text-slate-400 uppercase">
                    ¿Cómo vigilamos este tanque?
                  </p>
                  {[
                    {
                      valor: "recomendado" as const,
                      titulo: "Recomendado",
                      detalle: `Alerta desde ${VIGILANCIA_RECOMENDADA.umbral_descuadre_pct}% de faltante entre varillas, ${VIGILANCIA_RECOMENDADA.umbral_descuadre_ciclo_pct}% acumulado en el ciclo y ${VIGILANCIA_RECOMENDADA.umbral_diferencia_pct}% contra la factura del proveedor. Valores provisionales: se afinan con el historial del tanque.`,
                    },
                    {
                      valor: "personalizado" as const,
                      titulo: "Personalizado",
                      detalle: "Elegís vos los tres umbrales.",
                    },
                    {
                      valor: "sin_vigilar" as const,
                      titulo: "Sin vigilar por ahora",
                      detalle:
                        "El sistema NO va a detectar faltantes en este tanque. Queda registrado quién lo eligió.",
                    },
                  ].map((opcion) => (
                    <label
                      key={opcion.valor}
                      className={`flex gap-3 items-start p-3 rounded-xl border cursor-pointer transition-colors ${
                        modoVigilancia === opcion.valor
                          ? "border-slate-900 bg-slate-50"
                          : "border-slate-200 hover:bg-slate-50/60"
                      }`}
                    >
                      <input
                        type="radio"
                        name="modo-vigilancia"
                        className="mt-1"
                        checked={modoVigilancia === opcion.valor}
                        onChange={() => {
                          setModoVigilancia(opcion.valor);
                          if (opcion.valor === "recomendado") {
                            setFormData((f) => ({ ...f, ...VIGILANCIA_RECOMENDADA }));
                          } else if (opcion.valor === "sin_vigilar") {
                            setFormData((f) => ({
                              ...f,
                              umbral_descuadre_pct: "",
                              umbral_descuadre_ciclo_pct: "",
                              umbral_diferencia_pct: "",
                            }));
                          }
                        }}
                      />
                      <span>
                        <span className="block text-sm font-semibold text-slate-800">
                          {opcion.titulo}
                        </span>
                        <span
                          className={`block text-[11px] ${
                            opcion.valor === "sin_vigilar" ? "text-red-600" : "text-slate-400"
                          }`}
                        >
                          {opcion.detalle}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
              {/* Fase C (0064) -- configuración que solo afecta a las
                  recepciones. Va junta y al final para no competir con los
                  campos que se llenan siempre. */}
              <div className="border-t border-slate-100 pt-4 space-y-4">
                <p className="text-xs font-bold text-slate-400 uppercase">
                  Recepciones de combustible
                </p>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <label
                      htmlFor="tanque-moneda"
                      className="text-xs font-bold text-slate-500 uppercase"
                    >
                      Moneda
                    </label>
                    {/* Hasta la Fase C este campo viajaba fijo en "PEN" sin
                        control visible: `moneda` solo tiene sentido
                        acompañando a un costo, y no había ninguno. Ahora que
                        el costo promedio existe de verdad, se muestra. */}
                    <select
                      id="tanque-moneda"
                      className="w-full border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-slate-900"
                      value={formData.moneda}
                      onChange={(e) => setFormData({ ...formData, moneda: e.target.value })}
                    >
                      <option value="PEN">PEN (S/)</option>
                      <option value="USD">USD ($)</option>
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label
                      htmlFor="tanque-tolerancia"
                      className="text-xs font-bold text-slate-500 uppercase"
                    >
                      Tolerancia de capacidad (%)
                    </label>
                    <input
                      id="tanque-tolerancia"
                      type="number"
                      min={0}
                      max={100}
                      step="0.01"
                      className="w-full border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-slate-900"
                      value={formData.tolerancia_capacidad_pct}
                      onChange={(e) =>
                        setFormData({ ...formData, tolerancia_capacidad_pct: e.target.value })
                      }
                    />
                    <p className="text-[11px] text-slate-400">
                      Margen sobre la capacidad antes de rechazar una recepción. 0 = estricto.
                    </p>
                  </div>
                  {/* Los tres umbrales solo se muestran en "Personalizado"
                      (o al editar, donde ya hay una decisión tomada). En
                      "Recomendado" ya quedaron cargados y en "Sin vigilar"
                      quedaron vacíos a propósito: mostrarlos ahí invitaría a
                      tocarlos sin haber cambiado la elección de arriba. */}
                  {(editandoId !== null || modoVigilancia === "personalizado") && (
                    <>
                      <div className="space-y-1 col-span-2">
                        <label
                          htmlFor="tanque-umbral-diferencia"
                          className="text-xs font-bold text-slate-500 uppercase"
                        >
                          Umbral de diferencia (%)
                        </label>
                        <input
                          id="tanque-umbral-diferencia"
                          type="number"
                          min={0}
                          max={100}
                          step="0.01"
                          className="w-full border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-slate-900"
                          value={formData.umbral_diferencia_pct}
                          onChange={(e) =>
                            setFormData({ ...formData, umbral_diferencia_pct: e.target.value })
                          }
                        />
                        <p className="text-[11px] text-slate-400">
                          Desde cuánta diferencia entre lo facturado y lo medido con varilla se
                          marca una recepción como sospechosa.{" "}
                          <strong>Vacío = no alertar todavía</strong>, conviene dejarlo así hasta
                          juntar historial propio del tanque.{" "}
                          <strong>0 = alertar por cualquier diferencia</strong>.
                        </p>

                        {/* Fase D, entrega 3: el asistente nunca guarda solo --
                        sugiere y muestra la muestra completa, el admin
                        decide. Solo aplica editando un tanque existente. */}
                        {editandoId !== null && (
                          <div className="mt-2 border border-slate-200 rounded-xl p-3 bg-slate-50/60 text-sm">
                            {cargandoSugerenciaUmbral ? (
                              <p className="text-slate-400">Calculando sugerencia...</p>
                            ) : !sugerenciasUmbral ? null : !sugerenciasUmbral.diferencia
                                .muestraSuficiente ? (
                              <p className="text-slate-500">
                                Todavía no hay muestra suficiente para sugerir un umbral (
                                {sugerenciasUmbral.diferencia.tamanioMuestra}/
                                {sugerenciasUmbral.diferencia.minimoRequerido} recepciones con
                                lectura antes y después).
                              </p>
                            ) : (
                              <div className="space-y-2">
                                <div className="flex items-center justify-between gap-2">
                                  <p className="text-slate-700">
                                    Sugerencia:{" "}
                                    <strong>{sugerenciasUmbral.diferencia.sugerido}%</strong> (
                                    {sugerenciasUmbral.diferencia.tamanioMuestra} recepciones,
                                    promedio {sugerenciasUmbral.diferencia.promedio}% ±{" "}
                                    {sugerenciasUmbral.diferencia.desviacion}%)
                                  </p>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setFormData({
                                        ...formData,
                                        umbral_diferencia_pct: String(
                                          sugerenciasUmbral.diferencia.sugerido
                                        ),
                                      })
                                    }
                                    className="shrink-0 px-3 py-1.5 bg-slate-900 text-white text-xs font-medium rounded-lg hover:bg-slate-800"
                                  >
                                    Usar este valor
                                  </button>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => setMostrarMuestraUmbral((v) => !v)}
                                  className="text-xs text-slate-500 hover:text-slate-900 hover:underline"
                                >
                                  {mostrarMuestraUmbral ? "Ocultar" : "Ver"} la muestra antes de
                                  aceptarlo
                                </button>
                                {mostrarMuestraUmbral && (
                                  <ul className="text-xs text-slate-500 max-h-32 overflow-y-auto divide-y divide-slate-100">
                                    {sugerenciasUmbral.diferencia.muestra?.map((m, i) => (
                                      <li key={i} className="py-1 flex justify-between gap-2">
                                        <span>{m.cantidad.toLocaleString("es-PE")} recibido</span>
                                        <span
                                          className={
                                            Math.abs(m.diferenciaPct) >
                                            (sugerenciasUmbral.diferencia.sugerido ?? 0)
                                              ? "text-red-500 font-medium"
                                              : ""
                                          }
                                        >
                                          {m.diferenciaLitros > 0 ? "+" : ""}
                                          {m.diferenciaLitros.toLocaleString("es-PE", {
                                            maximumFractionDigits: 1,
                                          })}{" "}
                                          ({m.diferenciaPct > 0 ? "+" : ""}
                                          {m.diferenciaPct.toFixed(1)}%)
                                        </span>
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                      <div className="space-y-1 col-span-2">
                        <label
                          htmlFor="tanque-umbral-descuadre"
                          className="text-xs font-bold text-slate-500 uppercase"
                        >
                          Umbral de descuadre (%)
                        </label>
                        <input
                          id="tanque-umbral-descuadre"
                          type="number"
                          min={0}
                          max={100}
                          step="0.01"
                          className="w-full border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-slate-900"
                          value={formData.umbral_descuadre_pct}
                          onChange={(e) =>
                            setFormData({ ...formData, umbral_descuadre_pct: e.target.value })
                          }
                        />
                        <p className="text-[11px] text-slate-400">
                          Cuánto puede diferir el nivel medido de lo que los vales y recepciones
                          explican, antes de alertar. Se mide sobre la capacidad del tanque: 1% de
                          20,000 L son 200 L. <strong>Vacío = no alertar todavía</strong>, hasta
                          saber cuánto ruido produce la varilla de este tanque.{" "}
                          <strong>0 = alertar por cualquier faltante o sobrante</strong>.
                        </p>
                        {editandoId !== null && (
                          <SugerenciaCompacta
                            sugerencia={sugerenciasUmbral?.descuadre}
                            cargando={cargandoSugerenciaUmbral}
                            onUsar={(v) =>
                              setFormData((f) => ({ ...f, umbral_descuadre_pct: String(v) }))
                            }
                          />
                        )}
                      </div>
                      <div className="space-y-1 col-span-2">
                        <label
                          htmlFor="tanque-umbral-ciclo"
                          className="text-xs font-bold text-slate-500 uppercase"
                        >
                          Umbral acumulado del ciclo (%)
                        </label>
                        <input
                          id="tanque-umbral-ciclo"
                          type="number"
                          min={0}
                          max={100}
                          step="0.01"
                          className="w-full border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-slate-900"
                          value={formData.umbral_descuadre_ciclo_pct}
                          onChange={(e) =>
                            setFormData({ ...formData, umbral_descuadre_ciclo_pct: e.target.value })
                          }
                        />
                        <p className="text-[11px] text-slate-400">
                          Igual que el anterior, pero sumando <strong>todo el ciclo</strong> desde
                          que el tanque se cargó, no solo entre dos varillas. Atrapa el faltante
                          repartido en porciones chicas, que medición por medición parece normal.
                          Ponelo más alto que el de arriba (por ejemplo 1% y 2%): el ruido de la
                          varilla se acumula a lo largo del ciclo.
                        </p>
                        {editandoId !== null && (
                          <SugerenciaCompacta
                            sugerencia={sugerenciasUmbral?.ciclo}
                            cargando={cargandoSugerenciaUmbral}
                            onUsar={(v) =>
                              setFormData((f) => ({ ...f, umbral_descuadre_ciclo_pct: String(v) }))
                            }
                          />
                        )}
                      </div>
                    </>
                  )}
                </div>
                <label className="flex items-start gap-2 text-sm text-slate-600">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={formData.requiere_documento}
                    onChange={(e) =>
                      setFormData({ ...formData, requiere_documento: e.target.checked })
                    }
                  />
                  <span>
                    Exigir factura o guía de remisión al registrar una recepción
                    <span className="block text-[11px] text-slate-400">
                      Desactivalo si el papel del proveedor no siempre está a mano al descargar.
                    </span>
                  </span>
                </label>
              </div>

              {editandoId !== null && (
                <label className="flex items-center gap-2 text-sm text-slate-600">
                  <input
                    type="checkbox"
                    checked={formData.activo}
                    onChange={(e) => setFormData({ ...formData, activo: e.target.checked })}
                  />
                  Tanque activo
                </label>
              )}

              <button
                type="submit"
                disabled={guardando}
                className="w-full bg-slate-900 text-white font-bold py-4 rounded-2xl hover:bg-slate-800 transition-all mt-4 disabled:opacity-50"
              >
                {guardando ? "Guardando..." : editandoId ? "Guardar Cambios" : "Crear Tanque"}
              </button>
            </form>
          </div>
        </div>
      )}
      {/* Modal: historial de lecturas (solo lectura) */}
      {tanqueHistorial && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center z-50 p-4">
          <div className="bg-white w-full max-w-2xl rounded-3xl shadow-2xl max-h-[85vh] flex flex-col">
            <div className="p-6 border-b flex justify-between items-center shrink-0">
              <div>
                <h3 className="text-xl font-bold">Historial — {tanqueHistorial.tanque_nombre}</h3>
                <p className="text-sm text-slate-500">
                  Lecturas registradas, de la más reciente a la más antigua
                </p>
              </div>
              <button
                onClick={() => setTanqueHistorial(null)}
                className="text-slate-400 hover:text-slate-900 text-2xl"
              >
                ×
              </button>
            </div>

            <div className="p-6 overflow-y-auto">
              {cargandoLecturas ? (
                <p className="text-center text-slate-500 py-8">Cargando historial...</p>
              ) : lecturas.length === 0 ? (
                <p className="text-center text-slate-500 py-8">
                  Este tanque todavía no tiene lecturas registradas.
                </p>
              ) : (
                <table className="w-full text-left border-collapse">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-widest">
                        Fecha de la lectura
                      </th>
                      <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-widest text-right">
                        Nivel
                      </th>
                      <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-widest text-right">
                        Variación
                      </th>
                      <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-widest text-right">
                        Acciones
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {lecturas.map((l) => {
                      const anulada = l.anulada_en !== null;
                      const variacion = variacionPorLectura.get(l.id) ?? null;
                      return (
                        <tr key={l.id} className="hover:bg-slate-50/50 transition-colors">
                          <td className="p-3 text-sm text-slate-600">
                            <span className={anulada ? "line-through text-slate-400" : ""}>
                              {formatearFecha(l.leido_en)}
                            </span>
                            {l.origen !== "manual" && (
                              <span className="ml-2 text-xs text-slate-400">({l.origen})</span>
                            )}
                            {/* Quién tomó la medición. Va SIEMPRE visible,
                                incluso en las anuladas: si una lectura
                                resultó estar mal, quién la cargó es parte
                                de lo que hay que poder ver. */}
                            <p className="text-xs text-slate-500 mt-0.5">
                              {l.registrada_por_nombre
                                ? `Registró: ${l.registrada_por_nombre}`
                                : "Registró: —"}
                            </p>
                            {anulada && (
                              <p className="text-xs text-amber-700 mt-0.5">
                                Anulada: {l.motivo_anulacion}
                                {l.anulada_por_nombre && ` — ${l.anulada_por_nombre}`}
                              </p>
                            )}
                          </td>
                          <td
                            className={`p-3 text-sm font-semibold text-right ${
                              anulada ? "line-through text-slate-400" : "text-slate-800"
                            }`}
                          >
                            {Number(l.nivel).toLocaleString("es-PE")} {tanqueHistorial.unidad}
                          </td>
                          <td className="p-3 text-sm text-right">
                            {variacion === null ? (
                              <span className="text-slate-300">—</span>
                            ) : (
                              <span
                                className={
                                  variacion < 0
                                    ? "text-red-500 font-medium"
                                    : variacion > 0
                                      ? "text-emerald-600 font-medium"
                                      : "text-slate-400"
                                }
                              >
                                {variacion > 0 ? "+" : ""}
                                {variacion.toLocaleString("es-PE")} {tanqueHistorial.unidad}
                              </span>
                            )}
                          </td>
                          <td className="p-3 text-sm text-right">
                            {!anulada && (
                              <button
                                onClick={() => {
                                  setLecturaAAnular(l);
                                  setMotivoAnulacion("");
                                }}
                                className="px-2 py-1 text-xs text-slate-400 hover:text-amber-700 hover:bg-amber-50 rounded-lg transition-all"
                                title="Anular esta lectura"
                              >
                                Anular
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
      {/* Modal: anular lectura (motivo obligatorio) -- se monta por encima
          del historial, que queda abierto detrás. */}
      {lecturaAAnular && tanqueHistorial && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center z-[60] p-4">
          <div className="bg-white w-full max-w-md rounded-3xl shadow-2xl">
            <div className="p-6 border-b flex justify-between items-center">
              <h3 className="text-xl font-bold">Anular lectura</h3>
              <button
                onClick={() => setLecturaAAnular(null)}
                className="text-slate-400 hover:text-slate-900 text-2xl"
              >
                ×
              </button>
            </div>
            <form onSubmit={handleAnularLectura} className="p-6 space-y-4">
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-900">
                <p>
                  Vas a anular la lectura de{" "}
                  <span className="font-bold">
                    {Number(lecturaAAnular.nivel).toLocaleString("es-PE")} {tanqueHistorial.unidad}
                  </span>{" "}
                  del {formatearFecha(lecturaAAnular.leido_en)}.
                </p>
                <p className="mt-2 text-xs">
                  La lectura no se borra: queda en el historial marcada como anulada, con este
                  motivo y tu nombre. Si era la última, el nivel del tanque vuelve a la lectura
                  anterior.
                </p>
              </div>

              <div className="space-y-1">
                <label
                  htmlFor="motivo-anulacion"
                  className="text-xs font-bold text-slate-500 uppercase"
                >
                  Motivo (obligatorio)
                </label>
                <textarea
                  id="motivo-anulacion"
                  required
                  rows={3}
                  maxLength={500}
                  placeholder="Ej: error de tipeo, se registró 500 en vez de 19.000"
                  className="w-full border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-slate-900"
                  value={motivoAnulacion}
                  onChange={(e) => setMotivoAnulacion(e.target.value)}
                />
              </div>

              <button
                type="submit"
                disabled={anulando || motivoAnulacion.trim() === ""}
                className="w-full bg-amber-700 text-white font-bold py-4 rounded-2xl hover:bg-amber-800 transition-all mt-4 disabled:opacity-50"
              >
                {anulando ? "Anulando..." : "Anular lectura"}
              </button>
            </form>
          </div>
        </div>
      )}
      {/* Modal: registrar lectura - ícono de tanque*/}
      {tanqueLectura && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center z-50 p-4">
          <div className="bg-white w-full max-w-md rounded-3xl shadow-2xl">
            <div className="p-6 border-b flex justify-between items-center">
              <h3 className="text-xl font-bold">Lectura — {tanqueLectura.tanque_nombre}</h3>
              <button
                onClick={() => setTanqueLectura(null)}
                className="text-slate-400 hover:text-slate-900 text-2xl"
              >
                ×
              </button>
            </div>

            <form onSubmit={handleRegistrarLectura} className="p-6 space-y-4">
              {/* Referencia a la vista mientras se escribe. Sin esto la
                  persona mide con la varilla y tipea a ciegas: no ve contra
                  qué valor viene, así que un dígito de más pasa
                  desapercibido justo en el momento en que era más fácil
                  notarlo. */}
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-sm">
                <div className="flex justify-between">
                  <span className="text-slate-500">Último registro</span>
                  <span className="font-bold text-slate-900">
                    {tanqueLectura.nivel_actual === null
                      ? "sin lecturas"
                      : `${Number(tanqueLectura.nivel_actual).toLocaleString("es-PE")} ${tanqueLectura.unidad}`}
                  </span>
                </div>
                {tanqueLectura.fecha_actualizacion && (
                  <p className="text-xs text-slate-400 text-right">
                    {formatearFecha(tanqueLectura.fecha_actualizacion)}
                  </p>
                )}
                <div className="flex justify-between mt-2 pt-2 border-t border-slate-200">
                  <span className="text-slate-500">Capacidad</span>
                  <span className="text-slate-600">
                    {Number(tanqueLectura.capacidad_total).toLocaleString("es-PE")}{" "}
                    {tanqueLectura.unidad}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Umbral de alerta</span>
                  <span className="text-slate-600">
                    {Number(tanqueLectura.nivel_minimo).toLocaleString("es-PE")}{" "}
                    {tanqueLectura.unidad}
                  </span>
                </div>
              </div>

              <div className="space-y-1">
                <label
                  htmlFor="combustible-nivel"
                  className="text-xs font-bold text-slate-500 uppercase"
                >
                  Nivel medido ahora ({tanqueLectura.unidad})
                </label>
                <input
                  id="combustible-nivel"
                  type="number"
                  min={0}
                  step="0.01"
                  required
                  className="w-full border border-slate-200 rounded-xl p-3 outline-none"
                  value={nivel}
                  onChange={(e) => setNivel(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <label
                  htmlFor="combustible-leido-en"
                  className="text-xs font-bold text-slate-500 uppercase"
                >
                  Fecha y hora de la lectura
                </label>
                <input
                  id="combustible-leido-en"
                  type="datetime-local"
                  required
                  className="w-full border border-slate-200 rounded-xl p-3 outline-none"
                  value={leidoEn}
                  onChange={(e) => {
                    setLeidoEn(e.target.value);
                    setHoraEditadaAMano(true);
                  }}
                />
              </div>
              <button
                type="submit"
                disabled={enviandoLectura}
                className="w-full bg-slate-900 text-white font-bold py-4 rounded-2xl hover:bg-slate-800 transition-all mt-4 disabled:opacity-50"
              >
                {enviandoLectura ? "Registrando..." : "Registrar lectura"}
              </button>
            </form>
          </div>
        </div>
      )}
      {/* Modal: registrar despacho (Fase B) */}
      {modalDespachoAbierto && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center z-50 p-4">
          <div className="bg-white w-full max-w-lg rounded-3xl shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b flex justify-between items-center">
              <h3 className="text-xl font-bold">Registrar despacho</h3>
              <button
                onClick={() => setModalDespachoAbierto(false)}
                className="text-slate-400 hover:text-slate-900 text-2xl"
              >
                ×
              </button>
            </div>

            <form onSubmit={handleRegistrarDespacho} className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label
                    htmlFor="despacho-origen"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    Origen
                  </label>
                  <select
                    id="despacho-origen"
                    className="w-full border border-slate-200 rounded-xl p-3 outline-none bg-white focus:ring-2 focus:ring-slate-900"
                    value={despachoForm.origen}
                    onChange={(e) =>
                      setDespachoForm({
                        ...DESPACHO_FORM_INICIAL,
                        origen: e.target.value as OrigenDespacho,
                      })
                    }
                  >
                    <option value="tanque_propio">Tanque propio</option>
                    <option value="compra_externa">Compra externa (ruta)</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <label
                    htmlFor="despacho-tipo-combustible"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    Combustible
                  </label>
                  <select
                    id="despacho-tipo-combustible"
                    className="w-full border border-slate-200 rounded-xl p-3 outline-none bg-white focus:ring-2 focus:ring-slate-900"
                    value={despachoForm.tipo_combustible}
                    onChange={(e) =>
                      setDespachoForm({
                        ...despachoForm,
                        tipo_combustible: e.target.value as Tanque["tipo_combustible"],
                      })
                    }
                  >
                    {Object.entries(ETIQUETA_TIPO_COMBUSTIBLE).map(([valor, etiqueta]) => (
                      <option key={valor} value={valor}>
                        {etiqueta}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {despachoForm.origen === "tanque_propio" ? (
                <>
                  <div className="space-y-1">
                    <label
                      htmlFor="despacho-tanque"
                      className="text-xs font-bold text-slate-500 uppercase"
                    >
                      Tanque
                    </label>
                    <select
                      id="despacho-tanque"
                      required
                      className="w-full border border-slate-200 rounded-xl p-3 outline-none bg-white focus:ring-2 focus:ring-slate-900"
                      value={despachoForm.combustible_id}
                      onChange={(e) =>
                        setDespachoForm({ ...despachoForm, combustible_id: e.target.value })
                      }
                    >
                      <option value="" disabled>
                        Elegir tanque
                      </option>
                      {tanques
                        .filter((t) => t.activo)
                        .map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.tanque_nombre}
                          </option>
                        ))}
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <label
                        htmlFor="despacho-cantidad"
                        className="text-xs font-bold text-slate-500 uppercase"
                      >
                        Cantidad despachada
                      </label>
                      <input
                        id="despacho-cantidad"
                        type="number"
                        min={0}
                        step="0.01"
                        required
                        className="w-full border border-slate-200 rounded-xl p-3 outline-none"
                        value={despachoForm.cantidad}
                        onChange={(e) =>
                          setDespachoForm({ ...despachoForm, cantidad: e.target.value })
                        }
                      />
                    </div>
                    <div className="space-y-1">
                      <label
                        htmlFor="despacho-contometro"
                        className="text-xs font-bold text-slate-500 uppercase"
                      >
                        Lectura del contómetro
                      </label>
                      <input
                        id="despacho-contometro"
                        type="number"
                        min={0}
                        step="0.01"
                        required
                        className="w-full border border-slate-200 rounded-xl p-3 outline-none"
                        value={despachoForm.lectura_contometro}
                        onChange={(e) =>
                          setDespachoForm({ ...despachoForm, lectura_contometro: e.target.value })
                        }
                      />
                    </div>
                  </div>
                  <p className="text-xs text-slate-400">
                    El contómetro resetea a 0 en cada despacho: tiene que coincidir con la cantidad,
                    o el servidor lo rechaza.
                  </p>
                  <div className="space-y-1">
                    <label
                      htmlFor="despacho-tipo-destino"
                      className="text-xs font-bold text-slate-500 uppercase"
                    >
                      Destino
                    </label>
                    <select
                      id="despacho-tipo-destino"
                      className="w-full border border-slate-200 rounded-xl p-3 outline-none bg-white focus:ring-2 focus:ring-slate-900"
                      value={despachoForm.tipo_destino}
                      onChange={(e) =>
                        setDespachoForm({
                          ...despachoForm,
                          tipo_destino: e.target.value as TipoDestinoDespacho,
                          equipo_id: "",
                        })
                      }
                    >
                      {Object.entries(ETIQUETA_TIPO_DESTINO).map(([valor, etiqueta]) => (
                        <option key={valor} value={valor}>
                          {etiqueta}
                        </option>
                      ))}
                    </select>
                  </div>
                  {despachoForm.tipo_destino === "equipo" && (
                    <div className="space-y-1">
                      <label
                        htmlFor="despacho-equipo"
                        className="text-xs font-bold text-slate-500 uppercase"
                      >
                        Unidad
                      </label>
                      <select
                        id="despacho-equipo"
                        required
                        className="w-full border border-slate-200 rounded-xl p-3 outline-none bg-white focus:ring-2 focus:ring-slate-900"
                        value={despachoForm.equipo_id}
                        onChange={(e) =>
                          setDespachoForm({ ...despachoForm, equipo_id: e.target.value })
                        }
                      >
                        <option value="" disabled>
                          Elegir unidad
                        </option>
                        {equipos.map((eq) => (
                          <option key={eq.id} value={eq.id}>
                            {eq.placa_codigo} — {eq.tipo}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="space-y-1">
                    <label
                      htmlFor="despacho-grifo"
                      className="text-xs font-bold text-slate-500 uppercase"
                    >
                      Grifo
                    </label>
                    <select
                      id="despacho-grifo"
                      required
                      className="w-full border border-slate-200 rounded-xl p-3 outline-none bg-white focus:ring-2 focus:ring-slate-900"
                      value={despachoForm.grifo_id}
                      onChange={(e) =>
                        setDespachoForm({ ...despachoForm, grifo_id: e.target.value })
                      }
                    >
                      <option value="" disabled>
                        Elegir grifo
                      </option>
                      {/* Solo los de ruta (migrations/0065): un proveedor que
                          solo llena el tanque propio no es donde una unidad
                          carga camino a Bambamarca. */}
                      {grifosDeRuta.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.nombre}
                        </option>
                      ))}
                    </select>
                    {grifosDeRuta.length === 0 && (
                      <p className="text-xs text-red-600">
                        No hay grifos de ruta cargados -- agregalos desde "Grifos / Proveedores" en
                        la barra superior, marcando "Abastece unidades en ruta".
                      </p>
                    )}
                  </div>
                  <div className="space-y-1">
                    <label
                      htmlFor="despacho-equipo-externo"
                      className="text-xs font-bold text-slate-500 uppercase"
                    >
                      Unidad
                    </label>
                    <select
                      id="despacho-equipo-externo"
                      required
                      className="w-full border border-slate-200 rounded-xl p-3 outline-none bg-white focus:ring-2 focus:ring-slate-900"
                      value={despachoForm.equipo_id}
                      onChange={(e) =>
                        setDespachoForm({ ...despachoForm, equipo_id: e.target.value })
                      }
                    >
                      <option value="" disabled>
                        Elegir unidad
                      </option>
                      {equipos.map((eq) => (
                        <option key={eq.id} value={eq.id}>
                          {eq.placa_codigo} — {eq.tipo}
                        </option>
                      ))}
                    </select>
                  </div>
                  {despachoForm.equipo_id !== "" && !equipoSeleccionado?.tipo_medidor && (
                    <p className="text-xs text-red-600">
                      Este equipo no tiene tipo de medidor configurado (horómetro/odómetro).
                      Configuralo en Equipos antes de continuar.
                    </p>
                  )}
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <label
                        htmlFor="despacho-cantidad-externa"
                        className="text-xs font-bold text-slate-500 uppercase"
                      >
                        Cantidad despachada
                      </label>
                      <input
                        id="despacho-cantidad-externa"
                        type="number"
                        min={0}
                        step="0.01"
                        required
                        className="w-full border border-slate-200 rounded-xl p-3 outline-none"
                        value={despachoForm.cantidad}
                        onChange={(e) =>
                          setDespachoForm({ ...despachoForm, cantidad: e.target.value })
                        }
                      />
                    </div>
                    {equipoSeleccionado?.tipo_medidor === "odometro" ? (
                      <div className="space-y-1">
                        <label
                          htmlFor="despacho-odometro"
                          className="text-xs font-bold text-slate-500 uppercase"
                        >
                          Lectura odómetro
                        </label>
                        <input
                          id="despacho-odometro"
                          type="number"
                          min={0}
                          step="0.01"
                          required
                          className="w-full border border-slate-200 rounded-xl p-3 outline-none"
                          value={despachoForm.lectura_odometro}
                          onChange={(e) =>
                            setDespachoForm({ ...despachoForm, lectura_odometro: e.target.value })
                          }
                        />
                      </div>
                    ) : (
                      <div className="space-y-1">
                        <label
                          htmlFor="despacho-horometro"
                          className="text-xs font-bold text-slate-500 uppercase"
                        >
                          Lectura horómetro
                        </label>
                        <input
                          id="despacho-horometro"
                          type="number"
                          min={0}
                          step="0.01"
                          required
                          disabled={!equipoSeleccionado?.tipo_medidor}
                          className="w-full border border-slate-200 rounded-xl p-3 outline-none disabled:bg-slate-50"
                          value={despachoForm.lectura_horometro}
                          onChange={(e) =>
                            setDespachoForm({ ...despachoForm, lectura_horometro: e.target.value })
                          }
                        />
                      </div>
                    )}
                  </div>
                  <div className="space-y-1">
                    <label
                      htmlFor="despacho-horas-abastecidas"
                      className="text-xs font-bold text-slate-500 uppercase"
                    >
                      Horas abastecidas (desde la carga anterior)
                    </label>
                    <input
                      id="despacho-horas-abastecidas"
                      type="number"
                      min={0}
                      step="0.01"
                      required
                      className="w-full border border-slate-200 rounded-xl p-3 outline-none"
                      value={despachoForm.horas_abastecidas}
                      onChange={(e) =>
                        setDespachoForm({ ...despachoForm, horas_abastecidas: e.target.value })
                      }
                    />
                  </div>
                </>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label
                    htmlFor="despacho-costo-unitario"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    C.U (costo por galón)
                  </label>
                  <input
                    id="despacho-costo-unitario"
                    type="number"
                    min={0}
                    step="0.0001"
                    required
                    className="w-full border border-slate-200 rounded-xl p-3 outline-none"
                    value={despachoForm.costo_unitario}
                    onChange={(e) => {
                      setCostoEditadoAMano(true);
                      setDespachoForm({ ...despachoForm, costo_unitario: e.target.value });
                    }}
                  />
                </div>
                <div className="space-y-1">
                  <span className="text-xs font-bold text-slate-500 uppercase">C.TOTAL</span>
                  <div className="w-full border border-slate-200 bg-slate-50 rounded-xl p-3 text-slate-600">
                    {costoTotalCalculado === null
                      ? "—"
                      : costoTotalCalculado.toLocaleString("es-PE", {
                          style: "currency",
                          currency: "PEN",
                        })}
                  </div>
                </div>
              </div>
              <p className="text-xs text-slate-400">
                El costo se autocompleta con el precio vigente a la fecha del despacho -- podés
                corregirlo si ese día pagaste distinto. C.TOTAL sale solo, no se guarda aparte.
              </p>

              <div className="space-y-1">
                <label
                  htmlFor="despacho-observaciones"
                  className="text-xs font-bold text-slate-500 uppercase"
                >
                  Observaciones (opcional)
                </label>
                <textarea
                  id="despacho-observaciones"
                  rows={2}
                  maxLength={500}
                  className="w-full border border-slate-200 rounded-xl p-3 outline-none"
                  value={despachoForm.observaciones}
                  onChange={(e) =>
                    setDespachoForm({ ...despachoForm, observaciones: e.target.value })
                  }
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label
                    htmlFor="despacho-serie"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    Serie del talonario
                  </label>
                  <input
                    id="despacho-serie"
                    type="text"
                    required
                    maxLength={20}
                    className="w-full border border-slate-200 rounded-xl p-3 outline-none"
                    value={despachoForm.serie_talonario}
                    onChange={(e) =>
                      setDespachoForm({ ...despachoForm, serie_talonario: e.target.value })
                    }
                  />
                </div>
                <div className="space-y-1">
                  <label
                    htmlFor="despacho-n-vale"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    N° de vale
                  </label>
                  <input
                    id="despacho-n-vale"
                    type="number"
                    min={1}
                    required
                    className="w-full border border-slate-200 rounded-xl p-3 outline-none"
                    value={despachoForm.n_vale}
                    onChange={(e) => setDespachoForm({ ...despachoForm, n_vale: e.target.value })}
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label
                  htmlFor="despacho-fecha"
                  className="text-xs font-bold text-slate-500 uppercase"
                >
                  Fecha y hora del despacho
                </label>
                <input
                  id="despacho-fecha"
                  type="datetime-local"
                  required
                  className="w-full border border-slate-200 rounded-xl p-3 outline-none"
                  value={despachadoEn}
                  onChange={(e) => {
                    setDespachadoEn(e.target.value);
                    setHoraDespachoEditadaAMano(true);
                  }}
                />
              </div>

              <button
                type="submit"
                disabled={enviandoDespacho}
                className="w-full bg-slate-900 text-white font-bold py-4 rounded-2xl hover:bg-slate-800 transition-all mt-4 disabled:opacity-50"
              >
                {enviandoDespacho ? "Registrando..." : "Registrar despacho"}
              </button>
            </form>
          </div>
        </div>
      )}
      {/* Modal: historial de despachos (solo lectura) */}
      {modalHistorialDespachosAbierto && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center z-50 p-4">
          <div className="bg-white w-full max-w-4xl rounded-3xl shadow-2xl max-h-[85vh] flex flex-col">
            <div className="p-6 border-b flex justify-between items-center shrink-0">
              <div>
                <h3 className="text-xl font-bold">Historial de despachos</h3>
                <p className="text-sm text-slate-500">
                  Últimos 100 vales registrados, del más reciente al más antiguo
                </p>
              </div>
              <button
                onClick={() => setModalHistorialDespachosAbierto(false)}
                className="text-slate-400 hover:text-slate-900 text-2xl"
              >
                ×
              </button>
            </div>

            <div className="p-6 overflow-y-auto overflow-x-auto">
              {cargandoHistorialDespachos ? (
                <p className="text-center text-slate-500 py-8">Cargando historial...</p>
              ) : historialDespachos.length === 0 ? (
                <p className="text-center text-slate-500 py-8">
                  Todavía no hay despachos registrados.
                </p>
              ) : (
                <table className="w-full text-left border-collapse">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-widest">
                        Vale
                      </th>
                      <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-widest">
                        Fecha
                      </th>
                      <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-widest">
                        Origen
                      </th>
                      <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-widest">
                        Tanque / Grifo
                      </th>
                      <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-widest">
                        Unidad
                      </th>
                      <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-widest text-right">
                        Cantidad
                      </th>
                      <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-widest text-right">
                        C.U
                      </th>
                      <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-widest text-right">
                        C.TOTAL
                      </th>
                      <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-widest text-right">
                        Acciones
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {historialDespachos.map((d) => {
                      const tanque = tanques.find((t) => t.id === d.combustible_id);
                      const grifo = grifos.find((g) => g.id === d.grifo_id);
                      const equipo = equipos.find((eq) => eq.id === d.equipo_id);
                      const anulado = d.anulada_en !== null;
                      return (
                        <tr
                          key={d.id}
                          className={`transition-colors align-top ${
                            anulado ? "bg-slate-50/60 text-slate-400" : "hover:bg-slate-50/50"
                          }`}
                        >
                          <td className="p-3 text-sm font-mono">
                            <span className={anulado ? "line-through" : "text-slate-800"}>
                              {d.serie_talonario}-{d.n_vale}
                            </span>
                          </td>
                          <td className="p-3 text-sm text-slate-600 whitespace-nowrap">
                            {formatearFecha(d.despachado_en)}
                          </td>
                          <td className="p-3 text-sm text-slate-600">
                            {ETIQUETA_ORIGEN_DESPACHO[d.origen]}
                          </td>
                          <td className="p-3 text-sm text-slate-600">
                            {tanque?.tanque_nombre ?? grifo?.nombre ?? "—"}
                          </td>
                          <td className="p-3 text-sm text-slate-600">
                            {equipo ? `${equipo.placa_codigo} — ${equipo.tipo}` : "—"}
                            {d.observaciones && (
                              <p className="text-xs text-slate-400 mt-0.5">{d.observaciones}</p>
                            )}
                          </td>
                          <td className="p-3 text-sm text-right text-slate-800 font-semibold whitespace-nowrap">
                            {Number(d.cantidad).toLocaleString("es-PE")}{" "}
                            {ETIQUETA_TIPO_COMBUSTIBLE[d.tipo_combustible]}
                          </td>
                          <td className="p-3 text-sm text-right text-slate-600 whitespace-nowrap">
                            S/ {Number(d.costo_unitario).toLocaleString("es-PE")}
                          </td>
                          <td className="p-3 text-sm text-right text-slate-800 font-semibold whitespace-nowrap">
                            S/ {Number(d.costo_total).toLocaleString("es-PE")}
                          </td>
                          <td className="p-3 text-sm text-right whitespace-nowrap">
                            {anulado ? (
                              // La anulada NO se esconde: es la evidencia de
                              // que el vale se rindió, y lo que evita que el
                              // hueco de talonario dispare (punto 3).
                              <span
                                className="text-xs text-red-400"
                                title={d.motivo_anulacion ?? undefined}
                              >
                                Anulado
                              </span>
                            ) : (
                              <button
                                onClick={() => {
                                  setDespachoAAnular(d);
                                  setMotivoAnulacionDespacho("");
                                }}
                                className="text-xs text-red-500 hover:text-red-700 hover:underline"
                              >
                                Anular
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
      {/* Modal: Grifos externos (migrations/0063) */}
      {modalGrifosAbierto && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center z-50 p-4">
          <div className="bg-white w-full max-w-md rounded-3xl shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b flex justify-between items-center">
              <div>
                <h3 className="text-xl font-bold">Grifos / Proveedores</h3>
                <p className="text-sm text-slate-500">
                  Los que abastecen unidades en ruta y los que llenan los tanques propios
                </p>
              </div>
              <button
                onClick={() => setModalGrifosAbierto(false)}
                className="text-slate-400 hover:text-slate-900 text-2xl"
              >
                ×
              </button>
            </div>
            <form onSubmit={handleCrearGrifo} className="p-6 space-y-3 border-b">
              <label
                htmlFor="grifo-nombre-nuevo"
                className="text-xs font-bold text-slate-500 uppercase"
              >
                Nuevo grifo o proveedor
              </label>
              <div className="flex gap-2">
                <input
                  id="grifo-nombre-nuevo"
                  type="text"
                  placeholder="Ej. PRIMAX Bambamarca"
                  maxLength={150}
                  className="flex-1 border border-slate-200 rounded-xl p-3 outline-none"
                  value={nombreGrifoNuevo}
                  onChange={(e) => setNombreGrifoNuevo(e.target.value)}
                />
                <button
                  type="submit"
                  disabled={guardandoGrifo || !nombreGrifoNuevo.trim()}
                  className="px-5 bg-slate-900 text-white font-bold rounded-xl hover:bg-slate-800 transition-all disabled:opacity-50"
                >
                  +
                </button>
              </div>
              {/* Los dos roles (migrations/0065) -- marcados por defecto porque
                  el caso más común es un proveedor que sirve para todo. */}
              <div className="space-y-2 pt-1">
                <label className="flex items-center gap-2 text-sm text-slate-600">
                  <input
                    type="checkbox"
                    checked={rolesGrifoNuevo.abastece_ruta}
                    onChange={(e) =>
                      setRolesGrifoNuevo({ ...rolesGrifoNuevo, abastece_ruta: e.target.checked })
                    }
                  />
                  Abastece unidades en ruta
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-600">
                  <input
                    type="checkbox"
                    checked={rolesGrifoNuevo.abastece_tanque}
                    onChange={(e) =>
                      setRolesGrifoNuevo({ ...rolesGrifoNuevo, abastece_tanque: e.target.checked })
                    }
                  />
                  Abastece el tanque (cisterna)
                </label>
                <p className="text-[11px] text-slate-400">
                  Marcá los dos si el mismo proveedor te vende en ruta y a granel.
                </p>
              </div>
            </form>
            <div className="p-6 space-y-2">
              {grifos.length === 0 ? (
                <p className="text-sm text-slate-400 text-center">
                  Todavía no hay grifos cargados.
                </p>
              ) : (
                grifos.map((g) => (
                  <div key={g.id} className="p-3 rounded-xl border border-slate-100 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className={g.activo ? "text-slate-800" : "text-slate-400 line-through"}>
                        {g.nombre}
                      </span>
                      <button
                        onClick={() => handleCambiarActivoGrifo(g)}
                        className={`text-xs font-bold px-3 py-1 rounded-full ${
                          g.activo
                            ? "bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                            : "bg-slate-100 text-slate-500 hover:bg-slate-200"
                        }`}
                      >
                        {g.activo ? "Activo" : "Desactivado"}
                      </button>
                    </div>
                    {/* Editar los roles de una ficha existente, sin pantalla
                        aparte: el catálogo es chico y cambiar un rol es un
                        clic, igual que activar/desactivar. */}
                    <div className="flex flex-wrap gap-4">
                      <label className="flex items-center gap-1.5 text-xs text-slate-500">
                        <input
                          type="checkbox"
                          checked={g.abastece_ruta}
                          onChange={(e) =>
                            handleCambiarRolGrifo(g, "abastece_ruta", e.target.checked)
                          }
                        />
                        En ruta
                      </label>
                      <label className="flex items-center gap-1.5 text-xs text-slate-500">
                        <input
                          type="checkbox"
                          checked={g.abastece_tanque}
                          onChange={(e) =>
                            handleCambiarRolGrifo(g, "abastece_tanque", e.target.checked)
                          }
                        />
                        Tanque (cisterna)
                      </label>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
      {/* Modal: Precios de combustible (migrations/0063) */}
      {modalPreciosAbierto && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center z-50 p-4">
          <div className="bg-white w-full max-w-2xl rounded-3xl shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b flex justify-between items-center">
              <h3 className="text-xl font-bold">Precio de combustible</h3>
              <button
                onClick={() => setModalPreciosAbierto(false)}
                className="text-slate-400 hover:text-slate-900 text-2xl"
              >
                ×
              </button>
            </div>
            <form onSubmit={handleCrearPrecio} className="p-6 space-y-4 border-b">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label
                    htmlFor="precio-tipo-combustible"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    Combustible
                  </label>
                  <select
                    id="precio-tipo-combustible"
                    className="w-full border border-slate-200 rounded-xl p-3 outline-none bg-white focus:ring-2 focus:ring-slate-900"
                    value={precioForm.tipo_combustible}
                    onChange={(e) =>
                      setPrecioForm({
                        ...precioForm,
                        tipo_combustible: e.target.value as Tanque["tipo_combustible"],
                      })
                    }
                  >
                    {Object.entries(ETIQUETA_TIPO_COMBUSTIBLE).map(([valor, etiqueta]) => (
                      <option key={valor} value={valor}>
                        {etiqueta}
                      </option>
                    ))}
                  </select>
                </div>
                {/* col-span-2: la etiqueta larga ("Precio de venta interna
                    (tanque → flotas)") se corta a la mitad de la flecha en
                    media columna, y truncada dice otra cosa. */}
                <div className="space-y-1 col-span-2">
                  <label
                    htmlFor="precio-aplica-a"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    Tipo de precio
                  </label>
                  {/* Las dos opciones son precios DISTINTOS y hay que decirlo:
                      el del tanque es lo que se le cobra a las flotas (venta
                      interna), el del grifo es lo que cobra un tercero en la
                      ruta (compra). Cuando decían solo "Tanque propio" /
                      "Grifo externo" era fácil leer el primero como "lo que me
                      cuesta el combustible del tanque", que es otra cosa: ese
                      es el costo promedio, y lo calcula el motor de
                      recepciones (Fase C), no se carga acá. */}
                  <select
                    id="precio-aplica-a"
                    className="w-full border border-slate-200 rounded-xl p-3 outline-none bg-white focus:ring-2 focus:ring-slate-900"
                    value={precioForm.aplicaA}
                    onChange={(e) =>
                      setPrecioForm({
                        ...precioForm,
                        aplicaA: e.target.value as "tanque" | "grifo",
                        combustible_id: "",
                        grifo_id: "",
                      })
                    }
                  >
                    <option value="tanque">Precio de venta interna (tanque → flotas)</option>
                    <option value="grifo">Precio de compra en grifo de ruta</option>
                  </select>
                </div>
              </div>

              <p className="text-[11px] text-slate-400 -mt-1">
                Acá no va el costo de las cisternas que llenan el tanque: ese se carga en cada
                recepción, desde su factura.
              </p>

              {precioForm.aplicaA === "tanque" ? (
                <div className="space-y-1">
                  <label
                    htmlFor="precio-tanque"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    Tanque
                  </label>
                  <select
                    id="precio-tanque"
                    required
                    className="w-full border border-slate-200 rounded-xl p-3 outline-none bg-white focus:ring-2 focus:ring-slate-900"
                    value={precioForm.combustible_id}
                    onChange={(e) =>
                      setPrecioForm({ ...precioForm, combustible_id: e.target.value })
                    }
                  >
                    <option value="" disabled>
                      Elegir tanque
                    </option>
                    {tanques.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.tanque_nombre}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <div className="space-y-1">
                  <label
                    htmlFor="precio-grifo"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    Grifo
                  </label>
                  <select
                    id="precio-grifo"
                    required
                    className="w-full border border-slate-200 rounded-xl p-3 outline-none bg-white focus:ring-2 focus:ring-slate-900"
                    value={precioForm.grifo_id}
                    onChange={(e) => setPrecioForm({ ...precioForm, grifo_id: e.target.value })}
                  >
                    <option value="" disabled>
                      Elegir grifo
                    </option>
                    {grifos.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.nombre}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label
                    htmlFor="precio-valor"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    Precio por galón
                  </label>
                  <input
                    id="precio-valor"
                    type="number"
                    min={0}
                    step="0.0001"
                    required
                    className="w-full border border-slate-200 rounded-xl p-3 outline-none"
                    value={precioForm.precio_unitario}
                    onChange={(e) =>
                      setPrecioForm({ ...precioForm, precio_unitario: e.target.value })
                    }
                  />
                </div>
                <div className="space-y-1">
                  <label
                    htmlFor="precio-vigente-desde"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    Vigente desde
                  </label>
                  <input
                    id="precio-vigente-desde"
                    type="datetime-local"
                    required
                    className="w-full border border-slate-200 rounded-xl p-3 outline-none"
                    value={vigenteDesde}
                    onChange={(e) => setVigenteDesde(e.target.value)}
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={guardandoPrecio}
                className="w-full bg-slate-900 text-white font-bold py-3 rounded-2xl hover:bg-slate-800 transition-all disabled:opacity-50"
              >
                {guardandoPrecio ? "Guardando..." : "Cargar precio"}
              </button>
            </form>

            <div className="p-6 space-y-2">
              <h4 className="text-xs font-bold text-slate-500 uppercase mb-2">Historial</h4>
              {precios.length === 0 ? (
                <p className="text-sm text-slate-400 text-center">
                  Todavía no hay precios cargados.
                </p>
              ) : (
                precios.map((p) => (
                  <div
                    key={p.id}
                    className={`p-3 rounded-xl border text-sm ${
                      p.anulada_en ? "border-red-100 bg-red-50 text-slate-400" : "border-slate-100"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span
                        className={p.anulada_en ? "line-through" : "font-medium text-slate-800"}
                      >
                        {ETIQUETA_TIPO_COMBUSTIBLE[p.tipo_combustible]} —{" "}
                        {p.tanque_nombre ?? p.grifo_nombre} — S/{" "}
                        {Number(p.precio_unitario).toLocaleString("es-PE")}
                        {/* Sin esto, dos filas del historial se ven idénticas
                            y no hay forma de saber si el número es de venta o
                            de compra -- misma ambigüedad que el selector. */}
                        <span className="ml-2 text-[11px] font-normal text-slate-400">
                          {p.combustible_id !== null ? "venta interna" : "compra en ruta"}
                        </span>
                      </span>
                      {!p.anulada_en && (
                        <button
                          onClick={() => setPrecioAAnular(p)}
                          className="text-xs font-bold text-red-600 hover:text-red-800"
                        >
                          Anular
                        </button>
                      )}
                    </div>
                    <p className="text-xs text-slate-400 mt-1">
                      Vigente desde {formatearFecha(p.vigente_desde)}
                      {p.registrado_por_nombre ? ` · cargado por ${p.registrado_por_nombre}` : ""}
                    </p>
                    {p.anulada_en && (
                      <p className="text-xs text-red-500 mt-1">
                        Anulado{p.anulado_por_nombre ? ` por ${p.anulado_por_nombre}` : ""}: "
                        {p.motivo_anulacion}"
                      </p>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
      {/* Modal: anular precio (motivo obligatorio) -- se monta por encima
          del historial, que queda abierto detrás. */}
      {precioAAnular && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center z-[60] p-4">
          <div className="bg-white w-full max-w-md rounded-3xl shadow-2xl">
            <div className="p-6 border-b flex justify-between items-center">
              <h3 className="text-xl font-bold">Anular precio</h3>
              <button
                onClick={() => setPrecioAAnular(null)}
                className="text-slate-400 hover:text-slate-900 text-2xl"
              >
                ×
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-900">
                <p>
                  Vas a anular el precio de{" "}
                  <span className="font-bold">
                    S/ {Number(precioAAnular.precio_unitario).toLocaleString("es-PE")}
                  </span>
                  . No se borra: queda en el historial marcado como anulado, y el precio "vigente"
                  cae al anterior válido.
                </p>
              </div>
              <div className="space-y-1">
                <label
                  htmlFor="motivo-anulacion-precio"
                  className="text-xs font-bold text-slate-500 uppercase"
                >
                  Motivo (obligatorio)
                </label>
                <textarea
                  id="motivo-anulacion-precio"
                  required
                  rows={3}
                  maxLength={500}
                  placeholder="Ej: se tipeó 999 en vez de 17.9"
                  className="w-full border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-slate-900"
                  value={motivoAnulacionPrecio}
                  onChange={(e) => setMotivoAnulacionPrecio(e.target.value)}
                />
              </div>
              <button
                onClick={handleAnularPrecio}
                disabled={anulandoPrecio || motivoAnulacionPrecio.trim() === ""}
                className="w-full bg-amber-700 text-white font-bold py-4 rounded-2xl hover:bg-amber-800 transition-all disabled:opacity-50"
              >
                {anulandoPrecio ? "Anulando..." : "Anular precio"}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Modal: alertas (migrations/0068) -- pantalla completa a la que
          lleva la campanita del Header. Hueco de talonario se resuelve
          solo; vale anulado necesita revisión manual de gerencia. */}
      {/* Bitácora: quién cambió qué en el módulo.

          Antes esto solo lo veía el dueño del software desde el panel de
          plataforma. Un control que únicamente revisa el proveedor no es un
          control de la empresa: gerencia tiene que poder responder "¿quién
          cambió esto?" sin pedirle nada a nadie. */}
      {modalBitacoraAbierto && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center z-50 p-4">
          <div className="bg-white w-full max-w-4xl rounded-3xl shadow-2xl max-h-[90vh] flex flex-col">
            <div className="p-6 border-b flex justify-between items-start shrink-0">
              <div>
                <h3 className="text-xl font-bold">Bitácora del módulo</h3>
                <p className="text-sm text-slate-500">
                  Quién cambió qué, y cuándo. Los cambios que reducen la vigilancia van marcados.
                </p>
              </div>
              <button
                onClick={() => setModalBitacoraAbierto(false)}
                className="text-slate-400 hover:text-slate-600 text-2xl leading-none"
                aria-label="Cerrar"
              >
                ×
              </button>
            </div>

            <div className="overflow-auto p-6">
              {cargandoBitacora ? (
                <p className="text-slate-400 text-center py-8">Cargando...</p>
              ) : bitacora.length === 0 ? (
                <p className="text-slate-400 text-center py-8">Todavía no hay movimientos.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs font-bold text-slate-500 uppercase border-b">
                      <th className="p-3">Cuándo</th>
                      <th className="p-3">Quién</th>
                      <th className="p-3">Qué hizo</th>
                      <th className="p-3">Detalle</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bitacora.map((e) => {
                      const afloja = ACCIONES_QUE_AFLOJAN.has(e.accion);
                      const cambios = (e.detalle.aflojados ?? []) as Array<{
                        control: string;
                        de: string;
                        a: string;
                      }>;
                      return (
                        <tr
                          key={e.id}
                          className={
                            afloja
                              ? "align-top border-b border-slate-50 bg-red-50/60"
                              : "align-top border-b border-slate-50"
                          }
                        >
                          <td className="p-3 whitespace-nowrap text-slate-600">
                            {new Date(e.creado_en).toLocaleString("es-PE")}
                          </td>
                          <td className="p-3 text-slate-800">{e.usuario}</td>
                          <td
                            className={
                              afloja ? "p-3 font-semibold text-red-700" : "p-3 text-slate-800"
                            }
                          >
                            {ETIQUETA_ACCION[e.accion] ?? e.accion}
                          </td>
                          <td className="p-3 text-slate-600">
                            {cambios.length > 0 ? (
                              <>
                                {cambios.map((c, i) => (
                                  <span key={i} className="block">
                                    {c.control}: {c.de} → <strong>{c.a}</strong>
                                  </span>
                                ))}
                                {typeof e.detalle.motivo === "string" && (
                                  <span className="block mt-1 italic">
                                    Motivo: {e.detalle.motivo}
                                  </span>
                                )}
                              </>
                            ) : typeof e.detalle.codigo === "string" ? (
                              <span>{e.detalle.codigo}</span>
                            ) : (
                              <span className="text-slate-300">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
      {modalAlertasAbierto && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center z-50 p-4">
          <div className="bg-white w-full max-w-4xl rounded-3xl shadow-2xl max-h-[85vh] flex flex-col">
            <div className="p-6 border-b flex justify-between items-center shrink-0">
              <div>
                <h3 className="text-xl font-bold">Alertas de combustible</h3>
                <p className="text-sm text-slate-500">
                  Huecos de talonario, vales anulados, sobredespachos y despachos tardíos, del más
                  reciente al más antiguo
                </p>
              </div>
              <button
                onClick={cerrarModalAlertas}
                className="text-slate-400 hover:text-slate-900 text-2xl"
              >
                ×
              </button>
            </div>

            {/* La ventana de gracia (migrations/0071). Va acá arriba y no en
                una pantalla de configuración aparte: es el número que
                decide cuándo una alerta de abajo se vuelve una anomalía, y
                verlos juntos es lo que hace entendible el mecanismo. */}
            <div className="px-6 py-4 bg-slate-50 border-b flex flex-wrap items-center gap-3 shrink-0">
              <label
                htmlFor="ventana-gracia"
                className="text-xs font-bold text-slate-500 uppercase"
              >
                Ventana de gracia
              </label>
              <input
                id="ventana-gracia"
                type="number"
                min={1}
                max={8760}
                className="w-24 border border-slate-200 rounded-lg p-2 outline-none focus:ring-2 focus:ring-slate-900"
                value={ventanaGraciaHoras}
                onChange={(e) => {
                  setVentanaGraciaHoras(e.target.value);
                  // Editar invalida la confirmación anterior: si no, un
                  // "Guardado: 72 horas" viejo seguiría al lado de un valor
                  // nuevo todavía sin guardar.
                  setMensajeVentana(null);
                }}
              />
              <span className="text-sm text-slate-500">horas</span>
              <label
                htmlFor="dias-sin-medir"
                className="text-xs font-bold text-slate-500 uppercase ml-2"
              >
                Avisar si no se mide en
              </label>
              <input
                id="dias-sin-medir"
                type="number"
                min={1}
                max={365}
                className="w-20 border border-slate-200 rounded-lg p-2 outline-none focus:ring-2 focus:ring-slate-900"
                value={diasSinMedir}
                onChange={(e) => {
                  setDiasSinMedir(e.target.value);
                  setMensajeVentana(null);
                }}
              />
              <span className="text-sm text-slate-500">días</span>

              {/* Los dos topes diarios (0079). Se cargan acá, junto al resto
                  de la vigilancia, porque son la misma decisión: cuánto
                  tolera la empresa antes de querer enterarse. Vacío = sin
                  configurar = no alerta, igual que los umbrales del tanque. */}
              <label
                htmlFor="llenados-por-dia"
                className="text-xs font-bold text-slate-500 uppercase ml-2"
              >
                Llenados por día
              </label>
              <input
                id="llenados-por-dia"
                type="number"
                min={0.1}
                max={50}
                step={0.5}
                placeholder="—"
                className="w-20 border border-slate-200 rounded-lg p-2 outline-none focus:ring-2 focus:ring-slate-900"
                value={llenadosPorDia}
                onChange={(e) => {
                  setLlenadosPorDia(e.target.value);
                  setMensajeVentana(null);
                }}
              />
              <label
                htmlFor="tope-sin-capacidad"
                className="text-xs font-bold text-slate-500 uppercase ml-2"
              >
                Tope diario sin capacidad
              </label>
              <input
                id="tope-sin-capacidad"
                type="number"
                min={1}
                placeholder="—"
                className="w-28 border border-slate-200 rounded-lg p-2 outline-none focus:ring-2 focus:ring-slate-900"
                value={topeSinCapacidad}
                onChange={(e) => {
                  setTopeSinCapacidad(e.target.value);
                  setMensajeVentana(null);
                }}
              />
              <span className="text-sm text-slate-500">L</span>

              <button
                onClick={handleGuardarVentana}
                disabled={guardandoVentana}
                className="px-3 py-2 bg-slate-900 text-white text-xs font-medium rounded-lg hover:bg-slate-800 disabled:opacity-50"
              >
                {guardandoVentana ? "Guardando..." : "Guardar"}
              </button>
              {mensajeVentana && (
                <span
                  className={`text-xs font-semibold ${
                    mensajeVentana.startsWith("Guardado") ? "text-emerald-600" : "text-red-600"
                  }`}
                >
                  {mensajeVentana}
                </span>
              )}
              <p className="text-[11px] text-slate-400 flex-1 min-w-[240px]">
                <strong>Ventana de gracia:</strong> tiempo que un hueco tiene para explicarse solo
                (un vale que sincroniza sin señal, uno que se anula) antes de congelarse como
                anomalía permanente. Pasado ese plazo se congela <strong>solo</strong>, sin que
                nadie tenga que revisarlo.
                <br />
                <strong>Llenados por día:</strong> cuántas veces puede llenarse el tanque de un
                equipo en 24 h. El techo sale de multiplicarlo por la capacidad cargada en la ficha
                del equipo, así que solo vigila a los equipos que la tengan.{" "}
                <strong>Tope diario sin capacidad:</strong> litros en 24 h para lo demás — planta,
                reserva en cubeta y los equipos sin capacidad cargada. Los dos vacíos = sin vigilar.
              </p>
            </div>

            <div className="p-6 overflow-y-auto overflow-x-auto">
              {/* Anomalías: los hallazgos ya congelados. Van ARRIBA de las
                  alertas porque son las que de verdad importan -- una fila
                  acá es un faltante que nadie explicó en su plazo. */}
              {anomalias.length > 0 && (
                <div className="mb-8">
                  <h4 className="text-sm font-bold text-red-700 uppercase tracking-wide mb-1">
                    Anomalías congeladas ({anomalias.length})
                  </h4>
                  <p className="text-xs text-slate-500 mb-3">
                    Pasaron su ventana de gracia sin explicación. No se pueden editar ni borrar: son
                    evidencia.
                  </p>
                  <table className="w-full text-left border-collapse">
                    <thead className="bg-red-50">
                      <tr>
                        <th className="p-3 text-xs font-bold text-red-400 uppercase tracking-widest">
                          Tipo
                        </th>
                        <th className="p-3 text-xs font-bold text-red-400 uppercase tracking-widest">
                          Vale
                        </th>
                        <th className="p-3 text-xs font-bold text-red-400 uppercase tracking-widest">
                          Detectada
                        </th>
                        <th className="p-3 text-xs font-bold text-red-400 uppercase tracking-widest">
                          Congelada
                        </th>
                        <th className="p-3 text-xs font-bold text-red-400 uppercase tracking-widest text-right">
                          Sin explicar
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-red-100">
                      {anomalias.map((a) => (
                        <tr key={a.id} className="align-top">
                          <td className="p-3 text-sm text-slate-800">
                            {ETIQUETA_TIPO_ALERTA[a.tipo]}
                          </td>
                          <td className="p-3 text-sm text-slate-800 font-mono">
                            {referenciaAlerta(a)}
                          </td>
                          <td className="p-3 text-sm text-slate-600 whitespace-nowrap">
                            {new Date(a.detectada_en).toLocaleString("es-PE")}
                          </td>
                          <td className="p-3 text-sm text-slate-600 whitespace-nowrap">
                            {new Date(a.congelada_en).toLocaleString("es-PE")}
                          </td>
                          <td className="p-3 text-sm text-right text-red-600 font-semibold whitespace-nowrap">
                            {a.ventana_horas} h
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {anomalias.length > 0 && (
                <h4 className="text-sm font-bold text-slate-500 uppercase tracking-wide mb-3">
                  Alertas activas
                </h4>
              )}

              {cargandoAlertas ? (
                <p className="text-center text-slate-500 py-8">Cargando alertas...</p>
              ) : alertasCombustible.length === 0 ? (
                <p className="text-center text-slate-500 py-8">No hay alertas registradas.</p>
              ) : (
                <table className="w-full text-left border-collapse">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-widest">
                        Tipo
                      </th>
                      <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-widest">
                        Vale
                      </th>
                      <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-widest">
                        Detalle
                      </th>
                      <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-widest">
                        Detectada
                      </th>
                      <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-widest">
                        Estado
                      </th>
                      <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-widest text-right">
                        Acciones
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {alertasCombustible.map((a) => (
                      <tr
                        key={a.id}
                        id={`alerta-${a.id}`}
                        className={
                          a.id === alertaResaltadaId
                            ? "align-top bg-amber-50 ring-2 ring-inset ring-amber-400 transition-colors"
                            : "align-top hover:bg-slate-50/50 transition-colors"
                        }
                      >
                        <td className="p-3 text-sm text-slate-800">
                          {ETIQUETA_TIPO_ALERTA[a.tipo]}
                        </td>
                        <td className="p-3 text-sm text-slate-800 font-mono">
                          {referenciaAlerta(a)}
                        </td>
                        <td className="p-3 text-sm text-slate-600">{describirDetalleAlerta(a)}</td>
                        <td className="p-3 text-sm text-slate-600 whitespace-nowrap">
                          {new Date(a.creado_en).toLocaleString("es-PE")}
                        </td>
                        <td className="p-3 text-sm">
                          {a.resuelta_en ? (
                            <span className="text-emerald-600 font-medium">
                              {a.resuelta_por ? "Revisada" : "Resuelta sola"}
                            </span>
                          ) : (
                            <span className="text-amber-600 font-medium">Pendiente</span>
                          )}
                        </td>
                        <td className="p-3 text-sm text-right whitespace-nowrap">
                          {a.tipo !== "hueco_detectado" && !a.resuelta_en && (
                            <button
                              onClick={() => handleResolverAlerta(a.id)}
                              disabled={resolviendoAlertaId === a.id}
                              className="text-xs text-slate-500 hover:text-slate-900 hover:underline disabled:opacity-50"
                            >
                              {resolviendoAlertaId === a.id ? "Marcando..." : "Marcar revisado"}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
      {/* Modal: anular despacho -- la válvula de escape del punto 3. El motivo
          es obligatorio: es lo único que distingue "se mojó con diésel" de
          "estoy borrando un vale que no me conviene". */}
      {despachoAAnular && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center z-[60] p-4">
          <div className="bg-white w-full max-w-lg rounded-3xl shadow-2xl">
            <div className="p-6 border-b">
              <h3 className="text-xl font-bold">Anular vale</h3>
              <p className="text-sm text-slate-500">
                El vale no se borra: queda rendido y visible. El número vuelve a quedar libre por si
                hay que cargar el mismo papel con el dato corregido.
              </p>
            </div>
            <div className="p-6 space-y-4">
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 text-sm">
                <p className="font-mono font-semibold">
                  {despachoAAnular.serie_talonario}-{despachoAAnular.n_vale}
                </p>
                <p className="text-xs text-slate-500">
                  {Number(despachoAAnular.cantidad).toLocaleString("es-PE")}{" "}
                  {ETIQUETA_TIPO_COMBUSTIBLE[despachoAAnular.tipo_combustible]} ·{" "}
                  {formatearFecha(despachoAAnular.despachado_en)}
                </p>
              </div>
              <div className="space-y-1">
                <label
                  htmlFor="motivo-anulacion-despacho"
                  className="text-xs font-bold text-slate-500 uppercase"
                >
                  Motivo de la anulación *
                </label>
                <textarea
                  id="motivo-anulacion-despacho"
                  rows={3}
                  maxLength={500}
                  className="w-full border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-slate-900"
                  placeholder="Ej: se mojó con diésel, colilla guardada en el block"
                  value={motivoAnulacionDespacho}
                  onChange={(e) => setMotivoAnulacionDespacho(e.target.value)}
                />
              </div>
              <div className="flex gap-3">
                <button
                  onClick={() => setDespachoAAnular(null)}
                  className="flex-1 border border-slate-200 text-slate-600 font-medium py-3 rounded-2xl hover:bg-slate-50"
                >
                  Cancelar
                </button>
                <button
                  onClick={handleAnularDespacho}
                  disabled={anulandoDespacho || !motivoAnulacionDespacho.trim()}
                  className="flex-1 bg-red-600 text-white font-bold py-3 rounded-2xl hover:bg-red-700 disabled:opacity-50"
                >
                  {anulandoDespacho ? "Anulando..." : "Anular vale"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {/* Modal: registrar recepción (Fase C, migrations/0064) */}
      {modalRecepcionAbierto && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center z-50 p-4">
          <div className="bg-white w-full max-w-2xl rounded-3xl shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b flex justify-between items-center">
              <div>
                <h3 className="text-xl font-bold">Registrar recepción</h3>
                <p className="text-sm text-slate-500">
                  Entrada de combustible al tanque propio (cisterna / proveedor)
                </p>
              </div>
              <button
                onClick={() => setModalRecepcionAbierto(false)}
                className="text-slate-400 hover:text-slate-900 text-2xl"
              >
                ×
              </button>
            </div>

            <form onSubmit={handleRegistrarRecepcion} className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label
                    htmlFor="recepcion-tanque"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    Tanque *
                  </label>
                  <select
                    id="recepcion-tanque"
                    required
                    className="w-full border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-slate-900"
                    value={recepcionForm.combustible_id}
                    onChange={(e) =>
                      setRecepcionForm({ ...recepcionForm, combustible_id: e.target.value })
                    }
                  >
                    <option value="">Elegí un tanque...</option>
                    {tanques
                      .filter((t) => t.activo)
                      .map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.codigo} — {t.tanque_nombre}
                        </option>
                      ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <label
                    htmlFor="recepcion-grifo"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    Proveedor / grifo *
                  </label>
                  <select
                    id="recepcion-grifo"
                    required
                    className="w-full border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-slate-900"
                    value={recepcionForm.grifo_id}
                    onChange={(e) =>
                      setRecepcionForm({ ...recepcionForm, grifo_id: e.target.value })
                    }
                  >
                    <option value="">Elegí un proveedor...</option>
                    {/* Solo los que abastecen el tanque (migrations/0065): un
                        grifo de ruta no es quien manda la cisterna. */}
                    {grifosDeTanque.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.nombre}
                      </option>
                    ))}
                  </select>
                  {/* El catálogo es obligatorio a propósito: el alta va
                      primero, para que el gasto por proveedor se pueda
                      agrupar de verdad (ver migrations/0063). */}
                  <p className="text-[11px] text-slate-400">
                    ¿No está en la lista? Cargalo primero en{" "}
                    <button
                      type="button"
                      onClick={() => {
                        setModalRecepcionAbierto(false);
                        abrirModalGrifos();
                      }}
                      className="underline hover:text-slate-600"
                    >
                      Grifos / Proveedores
                    </button>
                    , marcando "Abastece el tanque (cisterna)".
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label
                    htmlFor="recepcion-cantidad"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    Cantidad recibida * {tanqueRecepcion ? `(${tanqueRecepcion.unidad})` : ""}
                  </label>
                  <input
                    id="recepcion-cantidad"
                    type="number"
                    required
                    min={0}
                    step="0.01"
                    className="w-full border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-slate-900"
                    value={recepcionForm.cantidad}
                    onChange={(e) =>
                      setRecepcionForm({ ...recepcionForm, cantidad: e.target.value })
                    }
                  />
                </div>
                <div className="space-y-1">
                  <label
                    htmlFor="recepcion-costo"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    Costo unitario *
                  </label>
                  <input
                    id="recepcion-costo"
                    type="number"
                    required
                    min={0}
                    step="0.0001"
                    className="w-full border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-slate-900"
                    value={recepcionForm.costo_unitario}
                    onChange={(e) =>
                      setRecepcionForm({ ...recepcionForm, costo_unitario: e.target.value })
                    }
                  />
                </div>
              </div>

              {costoTotalRecepcion !== null && (
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 text-sm">
                  <span className="text-slate-500">Costo total: </span>
                  <span className="font-bold text-slate-800">
                    {tanqueRecepcion?.moneda ?? "PEN"}{" "}
                    {costoTotalRecepcion.toLocaleString("es-PE", {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </span>
                </div>
              )}

              {/* Referencia del tanque elegido: nivel medido, capacidad y
                  costo promedio actual. Sin esto el operador tipea a ciegas
                  -- mismo criterio que el modal de lectura. */}
              {tanqueRecepcion && (
                <div className="bg-sky-50 border border-sky-200 rounded-xl p-3 text-xs text-sky-900 space-y-1">
                  <p>
                    <strong>Nivel medido:</strong>{" "}
                    {tanqueRecepcion.nivel_actual === null
                      ? "sin lecturas vigentes"
                      : `${Number(tanqueRecepcion.nivel_actual).toLocaleString("es-PE")} ${tanqueRecepcion.unidad}`}{" "}
                    · <strong>Capacidad:</strong>{" "}
                    {Number(tanqueRecepcion.capacidad_total).toLocaleString("es-PE")}{" "}
                    {tanqueRecepcion.unidad}
                    {Number(tanqueRecepcion.tolerancia_capacidad_pct) > 0 &&
                      ` (+${Number(tanqueRecepcion.tolerancia_capacidad_pct)}% tolerancia)`}
                  </p>
                  <p>
                    <strong>Costo promedio actual:</strong>{" "}
                    {Number(tanqueRecepcion.costo_promedio) === 0
                      ? "sin recepciones previas — esta compra lo define"
                      : `${tanqueRecepcion.moneda} ${Number(tanqueRecepcion.costo_promedio).toFixed(4)}`}
                  </p>
                  <p className="text-sky-700">
                    Registrar la recepción <strong>no cambia el nivel</strong> del tanque: eso lo
                    hace la próxima lectura de varilla.
                  </p>
                </div>
              )}

              {avisoCapacidadRecepcion && (
                <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-xs text-red-800">
                  {avisoCapacidadRecepcion}
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label
                    htmlFor="recepcion-tipo-doc"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    Documento {tanqueRecepcion?.requiere_documento !== false ? "*" : "(opcional)"}
                  </label>
                  <select
                    id="recepcion-tipo-doc"
                    className="w-full border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-slate-900"
                    value={recepcionForm.tipo_documento}
                    onChange={(e) =>
                      setRecepcionForm({
                        ...recepcionForm,
                        tipo_documento: e.target.value as "factura" | "guia_remision",
                      })
                    }
                  >
                    <option value="factura">Factura</option>
                    <option value="guia_remision">Guía de remisión</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <label
                    htmlFor="recepcion-num-doc"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    N° de documento{" "}
                    {tanqueRecepcion?.requiere_documento !== false ? "*" : "(opcional)"}
                  </label>
                  <input
                    id="recepcion-num-doc"
                    type="text"
                    // Obligatorio solo si el tanque elegido lo exige -- el
                    // servidor aplica la misma regla leyendo
                    // combustible.requiere_documento.
                    required={tanqueRecepcion?.requiere_documento !== false}
                    maxLength={100}
                    placeholder="F001-00012345"
                    className="w-full border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-slate-900"
                    value={recepcionForm.numero_documento}
                    onChange={(e) =>
                      setRecepcionForm({ ...recepcionForm, numero_documento: e.target.value })
                    }
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label
                  htmlFor="recepcion-fecha"
                  className="text-xs font-bold text-slate-500 uppercase"
                >
                  Fecha y hora de recepción
                </label>
                <input
                  id="recepcion-fecha"
                  type="datetime-local"
                  className="w-full border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-slate-900"
                  value={recibidoEn}
                  onChange={(e) => {
                    setRecibidoEn(e.target.value);
                    setHoraRecepcionEditadaAMano(true);
                  }}
                />
                <p className="text-[11px] text-slate-400">
                  Cuándo entró el combustible, no cuándo se carga al sistema. Define contra qué
                  lectura se calcula el costo promedio.
                </p>
              </div>

              <button
                type="submit"
                disabled={enviandoRecepcion || avisoCapacidadRecepcion !== null}
                className="w-full bg-sky-600 text-white font-bold py-4 rounded-2xl hover:bg-sky-700 transition-all mt-2 disabled:opacity-50"
              >
                {enviandoRecepcion ? "Registrando..." : "Registrar recepción"}
              </button>
            </form>
          </div>
        </div>
      )}
      {/* Modal: historial de recepciones (con anulación) */}
      {modalHistorialRecepcionesAbierto && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center z-50 p-4">
          <div className="bg-white w-full max-w-5xl rounded-3xl shadow-2xl max-h-[85vh] flex flex-col">
            <div className="p-6 border-b flex justify-between items-center shrink-0">
              <div>
                <h3 className="text-xl font-bold">Historial de recepciones</h3>
                <p className="text-sm text-slate-500">
                  Últimas 100 entradas de combustible, de la más reciente a la más antigua
                </p>
              </div>
              <button
                onClick={() => setModalHistorialRecepcionesAbierto(false)}
                className="text-slate-400 hover:text-slate-900 text-2xl"
              >
                ×
              </button>
            </div>

            <div className="p-6 overflow-y-auto overflow-x-auto">
              {cargandoHistorialRecepciones ? (
                <p className="text-center text-slate-500 py-8">Cargando historial...</p>
              ) : historialRecepciones.length === 0 ? (
                <p className="text-center text-slate-500 py-8">
                  Todavía no hay recepciones registradas.
                </p>
              ) : (
                <table className="w-full text-left border-collapse">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-widest">
                        Fecha
                      </th>
                      <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-widest">
                        Tanque
                      </th>
                      <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-widest">
                        Proveedor
                      </th>
                      <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-widest">
                        Documento
                      </th>
                      <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-widest text-right">
                        Cantidad
                      </th>
                      <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-widest text-right">
                        C.U
                      </th>
                      <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-widest text-right">
                        C.TOTAL
                      </th>
                      <th
                        className="p-3 text-xs font-bold text-slate-400 uppercase tracking-widest text-right"
                        title="Lo medido con varilla menos lo facturado, ya descontados los despachos del período"
                      >
                        Diferencia
                      </th>
                      <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-widest text-right">
                        Acciones
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {historialRecepciones.map((r) => {
                      const anulada = r.anulada_en !== null;
                      return (
                        <tr
                          key={r.id}
                          className={anulada ? "bg-slate-50/60 text-slate-400" : undefined}
                        >
                          <td className="p-3 text-sm">
                            {formatearFecha(r.recibido_en)}
                            {r.registrada_por_nombre && (
                              <p className="text-xs text-slate-400">{r.registrada_por_nombre}</p>
                            )}
                          </td>
                          <td className="p-3 text-sm">{r.tanque_nombre}</td>
                          <td className="p-3 text-sm">{r.grifo_nombre}</td>
                          <td className="p-3 text-sm">
                            {r.tipo_documento ? (
                              <>
                                <span className="text-xs text-slate-500">
                                  {ETIQUETA_TIPO_DOCUMENTO[r.tipo_documento]}
                                </span>
                                <p className="font-mono text-xs">{r.numero_documento}</p>
                              </>
                            ) : (
                              <span className="text-xs text-slate-400 italic">Sin documento</span>
                            )}
                          </td>
                          <td className="p-3 text-sm text-right">
                            {Number(r.cantidad).toLocaleString("es-PE")}
                          </td>
                          <td className="p-3 text-sm text-right">
                            {Number(r.costo_unitario).toFixed(4)}
                          </td>
                          <td className="p-3 text-sm text-right font-medium">
                            {Number(r.costo_total).toLocaleString("es-PE", {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })}
                          </td>
                          {/* La diferencia entre lo facturado y lo medido. Es
                              el dato que delata una entrega corta -- y el que
                              va a alimentar la calibración del umbral en Fase
                              D, por eso se muestra desde ya aunque todavía no
                              haya motor de conciliación. */}
                          <td className="p-3 text-sm text-right">
                            {r.diferencia_litros === null ? (
                              <span
                                className="text-slate-300"
                                title="Falta la lectura de varilla antes o después de la descarga, o hubo otra recepción en el mismo período: sin eso no se puede atribuir la diferencia a esta entrega."
                              >
                                —
                              </span>
                            ) : (
                              (() => {
                                const litros = Number(r.diferencia_litros);
                                const pct = (litros / Number(r.cantidad)) * 100;
                                // null = sin configurar (0075): el dato se
                                // muestra sin juzgar, que es lo correcto hasta
                                // tener historial con qué calibrar. Con umbral
                                // 0 sí pinta, porque ahora significa
                                // "cualquier diferencia cuenta" -- de ahí que
                                // se pregunte por null y no por `> 0`.
                                const umbral =
                                  r.umbral_diferencia_pct === null
                                    ? null
                                    : Number(r.umbral_diferencia_pct);
                                const excede = umbral !== null && Math.abs(pct) > umbral;
                                return (
                                  <span
                                    className={
                                      excede
                                        ? "font-bold text-red-600"
                                        : litros < 0
                                          ? "text-amber-600"
                                          : "text-slate-500"
                                    }
                                    title={`Medido: ${Number(r.nivel_antes).toLocaleString("es-PE")} → ${Number(r.nivel_despues).toLocaleString("es-PE")}`}
                                  >
                                    {litros > 0 ? "+" : ""}
                                    {litros.toLocaleString("es-PE", {
                                      maximumFractionDigits: 2,
                                    })}
                                    <span className="block text-[11px] font-normal">
                                      {pct > 0 ? "+" : ""}
                                      {pct.toFixed(1)}%
                                    </span>
                                  </span>
                                );
                              })()
                            )}
                          </td>
                          <td className="p-3 text-sm text-right">
                            {anulada ? (
                              // La anulada NO se esconde: es evidencia de que
                              // hubo un error, igual que una lectura o un
                              // precio anulado (0058 / 0063).
                              <span
                                className="text-xs text-red-400"
                                title={r.motivo_anulacion ?? undefined}
                              >
                                Anulada
                                {r.anulada_por_nombre ? ` por ${r.anulada_por_nombre}` : ""}
                              </span>
                            ) : (
                              <button
                                onClick={() => {
                                  setRecepcionAAnular(r);
                                  setMotivoAnulacionRecepcion("");
                                }}
                                className="text-xs text-red-500 hover:text-red-700 hover:underline"
                              >
                                Anular
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
      {/* Modal: anular recepción -- motivo OBLIGATORIO, mismo criterio que
          lecturas y precios: es lo único que distingue un error de tipeo de
          alguien borrando un número que no le conviene. */}
      {recepcionAAnular && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center z-[60] p-4">
          <div className="bg-white w-full max-w-lg rounded-3xl shadow-2xl">
            <div className="p-6 border-b">
              <h3 className="text-xl font-bold">Anular recepción</h3>
              <p className="text-sm text-slate-500">
                La fila no se borra: queda marcada como anulada y el costo promedio del tanque se
                recalcula sin ella.
              </p>
            </div>
            <div className="p-6 space-y-4">
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 text-sm">
                <p>
                  <strong>{recepcionAAnular.tanque_nombre}</strong> ·{" "}
                  {Number(recepcionAAnular.cantidad).toLocaleString("es-PE")} a{" "}
                  {Number(recepcionAAnular.costo_unitario).toFixed(4)}
                </p>
                <p className="text-xs text-slate-500">
                  {recepcionAAnular.grifo_nombre} · {formatearFecha(recepcionAAnular.recibido_en)}
                </p>
              </div>
              <div className="space-y-1">
                <label
                  htmlFor="motivo-anulacion-recepcion"
                  className="text-xs font-bold text-slate-500 uppercase"
                >
                  Motivo de la anulación *
                </label>
                <textarea
                  id="motivo-anulacion-recepcion"
                  rows={3}
                  maxLength={500}
                  className="w-full border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-slate-900"
                  placeholder="Ej: se cargó la factura de otra cisterna"
                  value={motivoAnulacionRecepcion}
                  onChange={(e) => setMotivoAnulacionRecepcion(e.target.value)}
                />
              </div>
              <div className="flex gap-3">
                <button
                  onClick={() => setRecepcionAAnular(null)}
                  className="flex-1 border border-slate-200 text-slate-600 font-medium py-3 rounded-2xl hover:bg-slate-50"
                >
                  Cancelar
                </button>
                <button
                  onClick={handleAnularRecepcion}
                  disabled={anulandoRecepcion || !motivoAnulacionRecepcion.trim()}
                  className="flex-1 bg-red-600 text-white font-bold py-3 rounded-2xl hover:bg-red-700 disabled:opacity-50"
                >
                  {anulandoRecepcion ? "Anulando..." : "Anular recepción"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
