// src/modules/combustible/canalesAlertas.ts
//
// Por dónde sale cada tipo de alerta. TODAS quedan en la Bandeja y la
// campanita, siempre: eso no se configura acá. Lo que se decide es si además
// interrumpen a alguien por correo AL MOMENTO o si esperan al resumen diario
// de las 7:00 (combustibleResumenAlertas.worker.ts).
//
// ── El criterio (decidido con Kenif, 2026-10-12) ─────────────────────────
//
// - AL MOMENTO: puede ser un robo en curso o alguien de adentro tocando los
//   controles o los registros. El correo, además de avisar, es un registro
//   FUERA del sistema: quien anula un vale puede cerrar la alerta en el ERP,
//   pero no borrar el correo que ya le llegó al gerente.
// - RESUMEN: hay que revisarlo, pero no se pierde nada esperando hasta la
//   mañana -- señales lentas que se acumulan en días, atrasos de papeles,
//   controles apagados (que el resumen recuerda cada día hasta que alguien los
//   arregle) y compras.
// - SOLO_ERP: informativas; no mandan correo ni van en el resumen como
//   novedad.
//
// La otra razón es la fatiga: si cada día llegan treinta correos "urgentes",
// a la semana nadie los abre, y el día que importa tampoco.
//
// El `Record` sobre TipoAlertaCombustible hace que un tipo nuevo SIN canal no
// compile: no se puede agregar una alerta y olvidarse de decidir por dónde
// sale. Cambiar un tipo de canal es cambiar una línea de este archivo.

import type { TipoAlertaCombustible } from "./combustible.repository";

export type CanalAlerta = "al_momento" | "resumen" | "solo_erp";

/** Los avisos de cambios de configuración (vigilancia reducida) no son un
 *  tipo de alerta --no quedan en la Bandeja--, pero pasan por el mismo
 *  filtro: alguien bajando un control es justo la puerta que usaría quien
 *  roba, así que salen al momento. */
export type AvisoPorCorreo = TipoAlertaCombustible | "aviso_configuracion";

export const CATALOGO_ALERTAS: Record<
  TipoAlertaCombustible,
  { canal: CanalAlerta; nombre: string }
> = {
  // ── Al momento: sale combustible por encima de los límites ─────────────
  sobredespacho: { canal: "al_momento", nombre: "Sobredespacho" },
  consumo_excedido: { canal: "al_momento", nombre: "Consumo máximo excedido" },
  tope_diario_excedido: { canal: "al_momento", nombre: "Tope diario excedido" },
  vale_excede_tanque: { canal: "al_momento", nombre: "Vale mayor que el tanque" },
  // ── Al momento: manipulación física ────────────────────────────────────
  totalizador_salto: { canal: "al_momento", nombre: "Salto del totalizador" },
  totalizador_retroceso: { canal: "al_momento", nombre: "Retroceso del totalizador" },
  precinto_alterado: { canal: "al_momento", nombre: "Precinto alterado" },
  precinto_reemplazado: { canal: "al_momento", nombre: "Precinto reemplazado" },
  medidor_inconsistente: { canal: "al_momento", nombre: "Medidor inconsistente" },
  // ── Al momento: manipulación de registros ──────────────────────────────
  vale_anulado: { canal: "al_momento", nombre: "Vale anulado" },
  vale_recargado: { canal: "al_momento", nombre: "Vale recargado con otra cantidad" },
  lectura_retroactiva: { canal: "al_momento", nombre: "Varilla cargada hacia atrás" },
  lectura_anulada: { canal: "al_momento", nombre: "Varilla anulada" },
  recepcion_anulada: { canal: "al_momento", nombre: "Recepción anulada" },
  recepcion_discrepante: { canal: "al_momento", nombre: "Guía distinta a la recepción" },
  varilla_exacta: { canal: "al_momento", nombre: "Varillas que cuadran al litro" },
  // ── Al momento: la medición que no cuadra, y el hueco (pedido de Kenif) ─
  descuadre_inventario: { canal: "al_momento", nombre: "Descuadre de inventario" },
  hueco_detectado: { canal: "al_momento", nombre: "Hueco en talonario" },
  // ── Al momento: urea, los equivalentes de lo anterior ──────────────────
  urea_ratio_excedido: { canal: "al_momento", nombre: "Urea: ratio sobre el diésel excedido" },
  urea_descuadre_conteo: { canal: "al_momento", nombre: "Urea: conteo físico que no cuadra" },
  urea_conteo_recargado: { canal: "al_momento", nombre: "Urea: conteo anulado y recargado" },
  urea_equipo_no_habilitado: { canal: "al_momento", nombre: "Urea: vale a equipo que no la usa" },
  // Reescribe el historial de un envase: inflar sus litros tapa un faltante.
  urea_litros_corregidos: { canal: "al_momento", nombre: "Urea: litros de un envase corregidos" },
  // ── Al momento: operativo urgente (si nadie repone, se para la operación)
  nivel_bajo: { canal: "al_momento", nombre: "Nivel bajo de tanque" },
  urea_stock_bajo: { canal: "al_momento", nombre: "Urea: stock bajo" },

  // ── Resumen: señales lentas, se acumulan en días ───────────────────────
  descuadre_ciclo: { canal: "resumen", nombre: "Descuadre acumulado del ciclo" },
  descuadre_ventana: { canal: "resumen", nombre: "Descuadre acumulado en la ventana" },
  diferencia_recepcion: { canal: "resumen", nombre: "Recepción con diferencia contra la varilla" },
  // ── Resumen: atrasos y papeles ─────────────────────────────────────────
  despacho_tardio: { canal: "resumen", nombre: "Vale que llegó tarde" },
  despacho_retroactivo: { canal: "resumen", nombre: "Carga registrada con atraso" },
  recepcion_retroactiva: { canal: "resumen", nombre: "Recepción cargada con atraso" },
  vale_fuera_de_orden: { canal: "resumen", nombre: "Vale fuera de orden" },
  // ── Resumen: controles apagados (se recuerdan cada día) ────────────────
  tanque_sin_medir: { canal: "resumen", nombre: "Tanque sin medir" },
  tanque_sin_vigilancia: { canal: "resumen", nombre: "Tanque despachando sin vigilancia" },
  varilla_sin_control: { canal: "resumen", nombre: "Tanque sin varilla de control" },
  recepcion_sin_validar: { canal: "resumen", nombre: "Recepción sin validar" },
  comprobante_sin_foto: { canal: "resumen", nombre: "Comprobante sin foto" },
  // ── Resumen: compras y saldos ──────────────────────────────────────────
  urea_stock_excedido: { canal: "resumen", nombre: "Urea: compra sobre el máximo del depósito" },
  urea_precio_fuera_de_catalogo: { canal: "resumen", nombre: "Urea: precio fuera de catálogo" },
  sobrestock_recepcion: { canal: "resumen", nombre: "Excedente de recepción aceptado" },
  tanqueta_sobregirada: { canal: "resumen", nombre: "Tanqueta con saldo negativo" },

  // ── Solo en el ERP ─────────────────────────────────────────────────────
  // Los equipos se prestan entre plantas (0100): avisarlo por correo sería ruido.
  equipo_de_otro_grifo: { canal: "solo_erp", nombre: "Equipo de otro grifo" },
  // "Esto no está contrastado", no un robo (0093).
  historial_sin_contrastar: { canal: "solo_erp", nombre: "Consumo previo a la primera varilla" },
};

/** Lo que la campanita y la Bandeja pintan como CRÍTICO: exactamente lo que
 *  sale por correo al momento. Lo rojo de la pantalla y lo que interrumpe por
 *  correo tienen que coincidir; antes eran dos listas (esta y la del cliente,
 *  gravedadAlertas.ts) y se habían separado en 14 tipos. */
export const TIPOS_CRITICOS: readonly TipoAlertaCombustible[] = (
  Object.keys(CATALOGO_ALERTAS) as TipoAlertaCombustible[]
).filter((t) => CATALOGO_ALERTAS[t].canal === "al_momento");

export function canalDe(tipo: AvisoPorCorreo): CanalAlerta {
  return tipo === "aviso_configuracion" ? "al_momento" : CATALOGO_ALERTAS[tipo].canal;
}

/** Para filas leídas de la base, donde el tipo llega como texto. Un tipo que
 *  el catálogo no conoce (una fila vieja, un tipo retirado) va al resumen: se
 *  sigue viendo, pero no despierta a nadie. */
export function canalDeFila(tipo: string): CanalAlerta {
  return (
    (CATALOGO_ALERTAS as Record<string, { canal: CanalAlerta } | undefined>)[tipo]?.canal ??
    "resumen"
  );
}

export const vaAlMomento = (tipo: AvisoPorCorreo): boolean => canalDe(tipo) === "al_momento";

/** Para el correo del resumen. Un tipo que no esté en el catálogo (una fila
 *  vieja, un tipo retirado) se muestra con su código antes que desaparecer. */
export function nombreDeTipo(tipo: string): string {
  return (CATALOGO_ALERTAS as Record<string, { nombre: string } | undefined>)[tipo]?.nombre ?? tipo;
}
