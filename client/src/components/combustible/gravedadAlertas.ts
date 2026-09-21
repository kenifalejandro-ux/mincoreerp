// client/src/components/combustible/gravedadAlertas.ts
//
// OJO si vas a importar esto desde CombustiblePanel.tsx: NO SE PUEDE.
// eslint-plugin-import + ESLint 10 crashea cuando un archivo MEZCLA imports
// padre (../../algo) y hermano (./algo) -- y el panel solo tiene padres,
// mientras que la campanita solo tiene hermanos. Ningún lugar del árbol
// sirve para los dos: se probó en utils/ y ahí el que crashea es la
// campanita. Por eso el panel duplica la lista, con este archivo como
// fuente de verdad y un comentario que lo dice. Si se tocan los tipos
// críticos, hay que tocar los dos lados.
//
// Qué tan grave es cada tipo de alerta. Vive acá y no en cada componente
// porque la campanita y el panel TIENEN que coincidir: si el badge dice
// "urgente" y la pantalla lo muestra igual que un aviso de reposición, el
// usuario aprende a ignorar los dos.
//
// El problema que resuelve, en palabras de Kenif: "debería salirme rápido la
// alerta como urgente y no solo como notificación, porque el usuario puede
// pensar que solo es notificación la campana mas no alerta de hueco". Un
// badge rojo con un número al lado del reloj se lee como Gmail, no como una
// alarma -- y las alertas de este módulo son, literalmente, sospecha de robo.

export type GravedadAlerta = "critica" | "operativa";

/** CRÍTICAS: hay combustible o papeles que no cuadran, y detrás puede haber
 *  robo, fuga o adulteración. Ninguna se resuelve sola: alguien tiene que
 *  mirarlas y cerrarlas con motivo.
 *
 *  `tanque_sin_medir` entra acá aunque parezca de proceso: sin lecturas, NI
 *  el descuadre ni la diferencia de recepción se pueden calcular. Un tanque
 *  sin medir no es un olvido, es el sistema de control apagado.
 *
 *  Todo lo que no está en esta lista es operativo: `nivel_bajo` (hay que
 *  reponer) y `despacho_tardio` (un vale apareció después de tiempo, se
 *  revisa y se cierra). */
const CRITICAS = new Set([
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
  "descuadre_ventana",
  "vale_recargado",
  "tanque_sin_vigilancia",
  "tanque_sin_medir",
  // 5ª auditoría: las tres de recepción son sospecha de combustible que entró
  // y no quedó en los papeles; el consumo y la varilla exacta son las dos
  // únicas señales del robo que NO deja rastro en el tanque.
  "recepcion_anulada",
  "recepcion_discrepante",
  "recepcion_retroactiva",
  "consumo_excedido",
  "varilla_exacta",
  "varilla_sin_control",
  // 0094: el totalizador del surtidor. Combustible que sale sin vale o un
  // medidor que vuelve atrás son sospecha directa de robo o manipulación.
  "totalizador_salto",
  "totalizador_retroceso",
  // 0095: un sello que no coincide es una apertura del tanque sin registrar;
  // un cambio fuera de recepción es la puerta que usaría el que roba.
  "precinto_alterado",
  "precinto_reemplazado",
]);

export function gravedadDe(tipo: string): GravedadAlerta {
  return CRITICAS.has(tipo) ? "critica" : "operativa";
}

export function esCritica(tipo: string): boolean {
  return gravedadDe(tipo) === "critica";
}
