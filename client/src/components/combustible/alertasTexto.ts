// client/src/components/combustible/alertasTexto.ts
//
// Cómo se nombra y se explica cada alerta de combustible en pantalla. Vivía
// dentro de CombustiblePanel.tsx; se movió acá cuando la Bandeja necesitó el
// mismo texto, para que la Bandeja y el panel de Tanques no puedan decir
// cosas distintas de la misma alerta.

export type DestinoExcedente = "cubeta" | "equipo" | "devolucion";

export const DESTINOS_EXCEDENTE: Record<DestinoExcedente, string> = {
  cubeta: "Tanqueta o cubeta",
  equipo: "Directo a unidades",
  devolucion: "Devolver al proveedor",
};

export interface AlertaCombustible {
  /** Lo decide el servidor con el catálogo de canales (canalesAlertas.ts):
   *  crítica = sale por correo al momento. El cliente no tiene lista propia. */
  critica: boolean;
  id: number;
  tipo:
    | "hueco_detectado"
    | "vale_anulado"
    | "sobredespacho"
    | "vale_excede_tanque"
    | "despacho_tardio"
    | "diferencia_recepcion"
    | "nivel_bajo"
    | "medidor_inconsistente"
    | "descuadre_inventario"
    | "descuadre_ciclo"
    | "tanque_sin_medir"
    | "vale_fuera_de_orden"
    | "lectura_retroactiva"
    | "tope_diario_excedido"
    | "descuadre_ventana"
    | "despacho_retroactivo"
    | "vale_recargado"
    | "tanque_sin_vigilancia"
    | "recepcion_anulada"
    | "recepcion_discrepante"
    | "recepcion_sin_validar"
    | "comprobante_sin_foto"
    | "recepcion_retroactiva"
    | "consumo_excedido"
    | "varilla_sin_control"
    | "varilla_exacta"
    | "historial_sin_contrastar"
    | "totalizador_salto"
    | "totalizador_retroceso"
    | "precinto_alterado"
    | "precinto_reemplazado"
    | "equipo_de_otro_grifo"
    | "sobrestock_recepcion"
    | "tanqueta_sobregirada"
    | "urea_equipo_no_habilitado"
    | "urea_ratio_excedido"
    | "urea_descuadre_conteo"
    | "urea_stock_bajo"
    | "urea_stock_excedido"
    | "urea_conteo_recargado"
    | "urea_precio_fuera_de_catalogo"
    | "urea_litros_corregidos"
    | "urea_conteo_alterado";
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

export const ETIQUETA_TIPO_ALERTA: Record<AlertaCombustible["tipo"], string> = {
  hueco_detectado: "Hueco de talonario",
  vale_anulado: "Vale anulado",
  sobredespacho: "Sobredespacho",
  vale_excede_tanque: "Vale mayor que el tanque",
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
  descuadre_ventana: "Descuadre acumulado",
  despacho_retroactivo: "Vale cargado con atraso",
  vale_recargado: "Vale recargado con otra cantidad",
  tanque_sin_vigilancia: "Tanque despachando sin vigilancia",
  recepcion_anulada: "Recepción anulada",
  recepcion_discrepante: "La guía no coincide con la recepción",
  recepcion_sin_validar: "Recepción sin validar",
  comprobante_sin_foto: "Comprobante sin foto",
  recepcion_retroactiva: "Recepción cargada con atraso",
  consumo_excedido: "Consumo por encima del máximo",
  varilla_sin_control: "Solo mide quien despacha",
  varilla_exacta: "Varillas que cuadran al litro",
  historial_sin_contrastar: "Consumo previo a la primera varilla",
  totalizador_salto: "Totalizador no cierra con el vale",
  totalizador_retroceso: "Totalizador retrocedió",
  precinto_alterado: "Precinto que no coincide",
  precinto_reemplazado: "Precinto cambiado fuera de una recepción",
  equipo_de_otro_grifo: "Equipo cargado en otro grifo",
  sobrestock_recepcion: "Excedente de recepción repartido",
  tanqueta_sobregirada: "Tanqueta sobregirada",
  // Urea (0092, 0117, 0118).
  urea_equipo_no_habilitado: "Urea a una unidad que no usa urea",
  urea_ratio_excedido: "Urea/diésel fuera de rango",
  urea_descuadre_conteo: "El conteo de urea no cuadra",
  urea_stock_bajo: "Queda poca urea",
  urea_stock_excedido: "Depósito de urea por encima del máximo",
  urea_conteo_recargado: "Conteo de urea anulado y vuelto a cargar",
  urea_precio_fuera_de_catalogo: "Compra de urea con precio fuera del catálogo",
  urea_litros_corregidos: "Litros de un envase de urea corregidos",
  urea_conteo_alterado: "Un conteo de urea cambió de resultado",
};

/** La columna "Vale" de las tablas de alertas y anomalías. Desde la
 *  migración 0073 no toda alerta tiene vale: las de nivel van contra un
 *  tanque y las de diferencia contra una recepción. */
export function referenciaAlerta(a: {
  serie_talonario: string | null;
  n_vale: number | null;
  recepcion_id?: number | null;
  detalle: Record<string, unknown>;
}): string {
  if (a.serie_talonario !== null && a.n_vale !== null) {
    return `${a.serie_talonario}-${String(a.n_vale).padStart(5, "0")}`;
  }
  // Compra en ruta (0109): no tiene vale, el detalle trae su comprobante.
  if (typeof a.detalle.comprobante === "string") return a.detalle.comprobante;
  if (typeof a.detalle.tanqueNombre === "string") return a.detalle.tanqueNombre;
  if (a.recepcion_id != null) return `Recepción #${a.recepcion_id}`;
  return "—";
}

/** El `detalle` es JSONB libre y cada tipo de alerta guarda cosas
 *  distintas, así que la columna se arma por tipo. Devuelve "—" cuando no
 *  hay nada que agregar (un hueco se explica solo con el número de vale). */
export function describirDetalleAlerta(a: AlertaCombustible): string {
  if (a.tipo === "vale_anulado" && typeof a.detalle.motivo === "string") {
    return `Motivo: ${a.detalle.motivo}`;
  }
  if (a.tipo === "vale_excede_tanque") {
    const { tanque, unidad, cantidad, capacidad, motivo, nivelAntes } = a.detalle as {
      tanque?: string;
      unidad?: string;
      cantidad?: number;
      capacidad?: number;
      motivo?: string;
      nivelAntes?: number;
    };
    return motivo === "excede_capacidad"
      ? `El vale dice ${cantidad ?? "?"} ${unidad ?? ""} y todo el tanque ${tanque ?? ""} es de ${capacidad ?? "?"} ${unidad ?? ""}`
      : `El vale dice ${cantidad ?? "?"} ${unidad ?? ""} y el tanque ${tanque ?? ""} tenía ${nivelAntes ?? "?"} ${unidad ?? ""} ese día`;
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
  if (a.tipo === "equipo_de_otro_grifo") {
    const { equipo, grifoDelVale, grifoDelEquipo } = a.detalle as Record<string, string>;
    // No es un error en sí (un equipo de paso carga donde está), pero el
    // consumo del equipo queda repartido entre dos grifos.
    return `${equipo ?? "El equipo"} es de ${grifoDelEquipo ?? "?"} y cargó en ${grifoDelVale ?? "?"}`;
  }
  if (a.tipo === "tanque_sin_vigilancia") {
    const { litrosEnLaVentana, valesEnLaVentana, unidad, plazoDias } = a.detalle as {
      litrosEnLaVentana?: number;
      valesEnLaVentana?: number;
      unidad?: string;
      plazoDias?: number;
    };
    // El número, no el reproche: "falta configurar" se posterga, "salieron
    // 12.000 L sin que nada los mirara" no.
    return (
      `Despachó ${litrosEnLaVentana ?? "?"} ${unidad ?? ""} en ${valesEnLaVentana ?? "?"} vale(s) ` +
      `con los tres umbrales apagados (plazo: ${plazoDias ?? "?"} días)`
    );
  }
  if (a.tipo === "vale_recargado") {
    const { cantidadAnulada, cantidadNueva, diferencia, anulacionesPrevias } = a.detalle as {
      cantidadAnulada?: number;
      cantidadNueva?: number;
      diferencia?: number;
      anulacionesPrevias?: number;
    };
    return (
      `Se anuló con ${cantidadAnulada ?? "?"} y volvió con ${cantidadNueva ?? "?"} ` +
      `(${(diferencia ?? 0) > 0 ? "+" : ""}${diferencia ?? "?"}), ` +
      `${anulacionesPrevias ?? "?"} anulación(es) en ese número`
    );
  }
  if (a.tipo === "recepcion_discrepante") {
    const { cantidadRegistrada, cantidadDocumento, diferencia, unidad } = a.detalle as {
      cantidadRegistrada?: number;
      cantidadDocumento?: number;
      diferencia?: number;
      unidad?: string;
    };
    return (
      `Se registraron ${cantidadRegistrada ?? "?"} ${unidad ?? ""} y la guía dice ` +
      `${cantidadDocumento ?? "?"} (${(diferencia ?? 0) > 0 ? "+" : ""}${diferencia ?? "?"})`
    );
  }
  // Urea: la frase con el número que importa. Los nombres de campo son los
  // del `detalle` que arma cada evaluador en combustible.service.ts.
  if (a.tipo === "urea_descuadre_conteo") {
    const { contadoL, esperadoL, descuadreL } = a.detalle as {
      contadoL?: number;
      esperadoL?: number;
      descuadreL?: number;
    };
    // 0132: si un movimiento con fecha pasada la recalculó, el número de ese
    // día queda en `original` y se dice también.
    const original = (a.detalle as { original?: { descuadreL?: number } }).original?.descuadreL;
    const conSigno = (v: number | undefined) => `${(v ?? 0) > 0 ? "+" : ""}${v ?? "?"}`;
    return (
      `Contados ${contadoL ?? "?"} L, los papeles explican ${esperadoL ?? "?"} L (${conSigno(descuadreL)} L` +
      (original !== undefined && original !== descuadreL
        ? `; ese día era ${conSigno(original)} L)`
        : ")")
    );
  }
  if (a.tipo === "urea_conteo_recargado") {
    const { descuadreAnuladoL, descuadreNuevoL, motivoAnulacion, anulacionesEnLaVentana } =
      a.detalle as {
        descuadreAnuladoL?: number;
        descuadreNuevoL?: number;
        motivoAnulacion?: string | null;
        anulacionesEnLaVentana?: number;
      };
    return (
      `Diferencia ${descuadreAnuladoL ?? "?"} L -> ${descuadreNuevoL ?? "?"} L tras anular ` +
      `("${motivoAnulacion ?? "sin motivo"}"), ${anulacionesEnLaVentana ?? "?"} anulación(es) en la ventana`
    );
  }
  if (a.tipo === "urea_conteo_alterado") {
    const { contadoEn, antesL, despuesL, causa, conteos } = a.detalle as {
      contadoEn?: string;
      antesL?: number;
      despuesL?: number;
      causa?: { descripcion?: string };
      conteos?: unknown[];
    };
    const otros = (conteos?.length ?? 1) - 1;
    const signo = (v: number | undefined) => (v === undefined ? "?" : v > 0 ? `+${v}` : `${v}`);
    return (
      `Conteo del ${contadoEn?.slice(0, 10) ?? "?"}: ${signo(antesL)} L → ${signo(despuesL)} L` +
      (otros > 0 ? ` (y ${otros} conteo${otros === 1 ? "" : "s"} más)` : "") +
      (causa?.descripcion ? `, por ${causa.descripcion}` : "")
    );
  }
  if (a.tipo === "urea_litros_corregidos") {
    const { envase, litrosRegistrados, litrosDespues, stockAlmacenL, motivo } = a.detalle as {
      envase?: { nombre: string };
      litrosRegistrados?: number[];
      litrosDespues?: number;
      stockAlmacenL?: { antes: number; despues: number };
      motivo?: string;
    };
    return (
      `${envase?.nombre ?? "Envase"}: ${(litrosRegistrados ?? []).join(" y ")} L → ${litrosDespues ?? "?"} L` +
      (stockAlmacenL ? `; stock ${stockAlmacenL.antes} → ${stockAlmacenL.despues} L` : "") +
      (motivo ? `. Motivo: ${motivo}` : "")
    );
  }
  if (a.tipo === "urea_precio_fuera_de_catalogo") {
    const { desvios, toleranciaPct, comprobanteNumero } = a.detalle as {
      desvios?: {
        presentacion: string;
        precioBoleta: number;
        precioCatalogo: number;
        desvioPct: number;
      }[];
      toleranciaPct?: number;
      comprobanteNumero?: string | null;
    };
    return (
      `${comprobanteNumero ?? "Compra"}: ` +
      (desvios ?? [])
        .map(
          (d) =>
            `${d.presentacion} S/ ${d.precioBoleta} vs S/ ${d.precioCatalogo} del catálogo (${d.desvioPct > 0 ? "+" : ""}${d.desvioPct}%)`
        )
        .join("; ") +
      ` -- tolerancia ${toleranciaPct ?? "?"}%`
    );
  }
  if (a.tipo === "urea_stock_bajo") {
    const { stockL, stockMinimoL } = a.detalle as { stockL?: number; stockMinimoL?: number };
    return `Stock ${stockL ?? "?"} L, mínimo ${stockMinimoL ?? "?"} L`;
  }
  if (a.tipo === "urea_stock_excedido") {
    const { stockPrevioL, litrosQueEntraron, stockMaximoL, excesoL } = a.detalle as {
      stockPrevioL?: number;
      litrosQueEntraron?: number;
      stockMaximoL?: number;
      excesoL?: number;
    };
    return `Había ${stockPrevioL ?? "?"} L, entraron ${litrosQueEntraron ?? "?"} L: ${excesoL ?? "?"} L sobre el máximo de ${stockMaximoL ?? "?"} L`;
  }
  if (a.tipo === "urea_ratio_excedido") {
    const { ratioPct, maxPct, litrosUrea, litrosDiesel } = a.detalle as {
      ratioPct?: number;
      maxPct?: number;
      litrosUrea?: number;
      litrosDiesel?: number;
    };
    return `${litrosUrea ?? "?"} L de urea sobre ${litrosDiesel ?? "?"} L de diésel: ${ratioPct ?? "?"}% (máximo ${maxPct ?? "?"}%)`;
  }
  if (a.tipo === "urea_equipo_no_habilitado") {
    const { placaCodigo } = a.detalle as { placaCodigo?: string };
    return `${placaCodigo ?? "La unidad"} está marcada como que no usa urea`;
  }
  if (a.tipo === "tanqueta_sobregirada") {
    const { tanqueta, saldo, cantidad } = a.detalle as {
      tanqueta?: string;
      saldo?: number;
      cantidad?: number;
    };
    return (
      `Se cargaron ${cantidad ?? "?"} gal desde ${tanqueta ?? "una tanqueta"} y su saldo quedó en ` +
      `${saldo ?? "?"} gal: o la carga se estimó de más, o entró combustible a la tanqueta sin registrarse`
    );
  }
  if (a.tipo === "sobrestock_recepcion") {
    const { cantidadRecepcion, excedenteLitros, unidad, reparto } = a.detalle as {
      cantidadRecepcion?: number;
      excedenteLitros?: number;
      unidad?: string;
      reparto?: { destino: DestinoExcedente; cantidad: number }[];
    };
    const partes = (reparto ?? [])
      .map((l) => `${l.cantidad} ${unidad ?? ""} -> ${DESTINOS_EXCEDENTE[l.destino] ?? l.destino}`)
      .join("; ");
    return (
      `De una recepción de ${cantidadRecepcion ?? "?"} ${unidad ?? ""} no cabían ` +
      `${excedenteLitros ?? "?"} ${unidad ?? ""}. Reparto: ${partes || "sin detalle"}`
    );
  }
  if (a.tipo === "comprobante_sin_foto") {
    const { comprobanteTipo, comprobanteNumero, plazoHoras } = a.detalle as {
      comprobanteTipo?: string;
      comprobanteNumero?: string;
      plazoHoras?: number;
    };
    return (
      `La ${comprobanteTipo ?? "boleta/factura"} ${comprobanteNumero ?? ""} sigue sin foto ` +
      `después de ${plazoHoras ?? "?"} horas: subirla desde el vale`
    );
  }
  if (a.tipo === "recepcion_sin_validar") {
    const { plazoHoras, numeroDocumento } = a.detalle as {
      plazoHoras?: number;
      numeroDocumento?: string | null;
    };
    return (
      `Sin validar contra la guía${numeroDocumento ? ` ${numeroDocumento}` : ""} ` +
      `después de ${plazoHoras ?? "?"} horas`
    );
  }
  if (a.tipo === "recepcion_anulada") {
    const { cantidad, unidad, motivo } = a.detalle as {
      cantidad?: number;
      unidad?: string;
      motivo?: string;
    };
    return `Se anuló una entrega de ${cantidad ?? "?"} ${unidad ?? ""}. Motivo: ${motivo ?? "—"}`;
  }
  if (a.tipo === "consumo_excedido") {
    const { consumo, consumoMaximo, unidadMedida, litros, recorrido } = a.detalle as {
      consumo?: number;
      consumoMaximo?: number;
      unidadMedida?: string;
      litros?: number;
      recorrido?: number;
    };
    return (
      `${litros ?? "?"} L para ${recorrido ?? "?"} ${unidadMedida ?? ""} de trabajo = ` +
      `${consumo ?? "?"} L/${unidadMedida ?? ""}, contra un máximo de ${consumoMaximo ?? "?"}`
    );
  }
  if (a.tipo === "varilla_exacta") {
    const { varillasSeguidas, toleranciaLitros } = a.detalle as {
      varillasSeguidas?: number;
      toleranciaLitros?: number;
    };
    return (
      `${varillasSeguidas ?? "?"} mediciones seguidas coincidieron con lo esperado dentro de ` +
      `${toleranciaLitros ?? "?"} L. Una varilla medida casi nunca da exacto`
    );
  }
  if (a.tipo === "totalizador_retroceso") {
    const d = a.detalle as {
      totalizador?: number;
      totalizadorMayorPrevio?: number;
      ancla?: string;
      surtidor?: string;
    };
    return `${d.surtidor ? `${d.surtidor}: m` : "M"}arcó ${d.totalizador ?? "?"}${d.ancla === "varilla" ? " al medir" : ""}, menos que los ${d.totalizadorMayorPrevio ?? "?"} de un ${d.ancla === "varilla" ? "punto" : "vale"} anterior`;
  }
  if (a.tipo === "totalizador_salto") {
    const d = a.detalle as {
      avance?: number;
      declarado?: number;
      diferencia?: number;
      sobra?: boolean;
      unidad?: string;
      ancla?: string;
      surtidor?: string;
    };
    const quien = d.surtidor ? `${d.surtidor}: ` : "";
    // De la varilla: no hay vale ni litros propios, todo el avance es
    // combustible que salió por el surtidor sin vale.
    if (d.ancla === "varilla") {
      return `${quien}al medir, el totalizador avanzó ${d.avance ?? "?"} ${d.unidad ?? ""} desde el punto anterior y ningún vale lo explica: salieron ${d.diferencia ?? "?"} sin vale`;
    }
    return d.sobra
      ? `${quien}el surtidor avanzó ${d.avance ?? "?"} ${d.unidad ?? ""} y el vale dice ${d.declarado ?? "?"}: salieron ${d.diferencia ?? "?"} sin vale`
      : `${quien}el surtidor avanzó ${d.avance ?? "?"} ${d.unidad ?? ""} y el vale dice ${d.declarado ?? "?"}: el vale declara de más`;
  }
  if (a.tipo === "precinto_alterado") {
    const d = a.detalle as {
      puntos?: { nombre: string; numero_visto: string | null; numero_esperado: string }[];
    };
    return (d.puntos ?? [])
      .map((p) =>
        p.numero_visto === null
          ? `${p.nombre}: no había precinto (registrado ${p.numero_esperado})`
          : `${p.nombre}: se vio el ${p.numero_visto}, registrado ${p.numero_esperado}`
      )
      .join(" · ");
  }
  if (a.tipo === "precinto_reemplazado") {
    const d = a.detalle as {
      punto?: string;
      numeroAnterior?: string | null;
      numeroNuevo?: string;
      quien?: string;
      motivo?: string;
    };
    return `${d.punto ?? "?"}: ${d.numeroAnterior ?? "sin precinto"} → ${d.numeroNuevo ?? "?"}, por ${d.quien ?? "?"} ("${d.motivo ?? ""}")`;
  }
  if (a.tipo === "historial_sin_contrastar") {
    const d = a.detalle as {
      vales?: number;
      litrosDespachados?: number;
      recepciones?: number;
      desde?: string;
      hasta?: string;
    };
    const fecha = (iso?: string) => (iso ? new Date(iso).toLocaleDateString("es-PE") : "?");
    return (
      `${d.vales ?? 0} vales (${d.litrosDespachados ?? 0} L) y ${d.recepciones ?? 0} recepciones ` +
      `del ${fecha(d.desde)} al ${fecha(d.hasta)}, anteriores a la primera medición: ` +
      `ninguna varilla los contrasta`
    );
  }
  if (a.tipo === "varilla_sin_control") {
    const { plazoDias, ultimaVarillaDeControl } = a.detalle as {
      plazoDias?: number;
      ultimaVarillaDeControl?: string | null;
    };
    return (
      `${plazoDias ?? "?"} días midiendo solo personal de grifo. ` +
      (ultimaVarillaDeControl
        ? `Última medición independiente: ${new Date(ultimaVarillaDeControl).toLocaleDateString("es-PE")}`
        : "Nunca midió alguien que no despacha")
    );
  }
  if (a.tipo === "despacho_retroactivo") {
    const { diasDeAtraso, diasTolerados } = a.detalle as {
      diasDeAtraso?: number;
      diasTolerados?: number;
    };
    return `Cargado ${diasDeAtraso ?? "?"} días después de su fecha (se toleran ${diasTolerados ?? "?"})`;
  }
  if (a.tipo === "descuadre_ventana") {
    const {
      descuadreLitros,
      sentido,
      unidad,
      diasVentana,
      tramos,
      promedioPorTramo,
      toleradoLitros,
    } = a.detalle as {
      descuadreLitros?: number;
      sentido?: string;
      unidad?: string;
      diasVentana?: number;
      tramos?: number;
      promedioPorTramo?: number;
      // La tolerancia ya calculada (0101). Las alertas de antes de esa
      // migración no la traen -- el histórico tiene que seguir leyéndose.
      toleradoLitros?: number;
    };
    // El promedio por tramo es lo que explica por qué NINGÚN control anterior
    // dijo nada: medición por medición el número era normal.
    return (
      `${sentido === "sobra" ? "Sobran" : "Faltan"} ${Math.abs(descuadreLitros ?? 0)} ` +
      `${unidad ?? ""} en ${diasVentana ?? "?"} días (${tramos ?? "?"} mediciones, ` +
      `~${Math.abs(promedioPorTramo ?? 0)} ${unidad ?? ""} por medición)` +
      (toleradoLitros !== undefined ? ` -- tolerancia ${toleradoLitros} ${unidad ?? ""}` : "")
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
    const { descuadreLitros, sentido, unidad, cicloDesde, toleradoLitros } = a.detalle as {
      descuadreLitros?: number;
      sentido?: string;
      unidad?: string;
      cicloDesde?: string;
      // La tolerancia ya calculada (0101). Las alertas de antes de esa
      // migración no la traen -- el histórico tiene que seguir leyéndose.
      toleradoLitros?: number;
    };
    if (descuadreLitros === undefined) return "—";
    const magnitud = Math.abs(descuadreLitros).toLocaleString("es-PE", {
      maximumFractionDigits: 2,
    });
    const desde = cicloDesde ? new Date(cicloDesde).toLocaleDateString("es-PE") : "?";
    return (
      `${sentido === "falta" ? "Faltan" : "Sobran"} ${magnitud} ${unidad ?? ""} ` +
      `acumulados desde la carga del ${desde}` +
      (toleradoLitros !== undefined ? ` -- tolerancia ${toleradoLitros} ${unidad ?? ""}` : "")
    );
  }
  if (a.tipo === "descuadre_inventario") {
    const {
      descuadreLitros,
      esperado,
      nivelMedido,
      sentido,
      unidad,
      umbralPct,
      toleradoLitros,
      desglose,
    } = a.detalle as {
      descuadreLitros?: number;
      esperado?: number;
      nivelMedido?: number;
      sentido?: string;
      unidad?: string;
      umbralPct?: number;
      // La tolerancia ya calculada (0101). Las alertas anteriores a esa
      // migración no la traen, y por eso el texto cae al porcentaje: el
      // histórico tiene que seguir leyéndose.
      toleradoLitros?: number;
      // Solo si las dos varillas del tramo traen totalizador (0096).
      desglose?: {
        avanceTotalizador: number;
        mangueraSinVale: number;
        fueraDelSurtidor: number;
      };
    };
    if (descuadreLitros === undefined) return "—";
    // El valor absoluto va con la palabra ("faltan"/"sobran") en vez del
    // signo: un "-500" pide que el lector traduzca, y esta columna se lee de
    // reojo entre muchas filas.
    const magnitud = Math.abs(descuadreLitros).toLocaleString("es-PE", {
      maximumFractionDigits: 2,
    });
    const base =
      `${sentido === "falta" ? "Faltan" : "Sobran"} ${magnitud} ${unidad ?? ""}: ` +
      `esperado ${esperado ?? "?"}, medido ${nivelMedido ?? "?"} ` +
      // En litros, que es la unidad en la que la persona piensa. El
      // porcentaje suelto obligaba a multiplicarlo por la capacidad de
      // memoria, y desde 0101 ya ni siquiera se mide contra la capacidad.
      (toleradoLitros !== undefined
        ? `(tolerancia ${toleradoLitros} ${unidad ?? ""})`
        : `(umbral ${umbralPct ?? "?"}%)`);
    // De dónde salió: la parte de la manguera es firme (±2), la de fuera del
    // surtidor arrastra el error de la varilla. Positivo = falta.
    return desglose
      ? `${base}. Por la manguera sin vale: ${desglose.mangueraSinVale}; fuera del surtidor: ${desglose.fueraDelSurtidor}`
      : base;
  }
  if (a.tipo === "diferencia_recepcion") {
    const { diferenciaLitros, diferenciaPct, umbralPct, toleradoLitros, unidad } = a.detalle as {
      diferenciaLitros?: number;
      diferenciaPct?: number;
      umbralPct?: number;
      // La tolerancia ya calculada (0101): piso + % de lo entregado. Las
      // alertas anteriores a esa migración no la traen, y por eso el texto
      // cae al porcentaje -- el histórico tiene que seguir leyéndose.
      toleradoLitros?: number;
      unidad?: string;
    };
    if (diferenciaLitros === undefined) return "—";
    const signo = diferenciaLitros > 0 ? "+" : "";
    return (
      `Facturado vs. medido: ${signo}${diferenciaLitros} ${unidad ?? ""} ` +
      (toleradoLitros !== undefined
        ? `(tolerancia ${toleradoLitros} ${unidad ?? ""})`
        : `(${signo}${diferenciaPct ?? "?"}%, umbral ${umbralPct ?? "?"}%)`)
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
  // Los cinco que no tenían texto: en la tabla bastaba el número de vale,
  // pero en la Bandeja "Qué pasó" es lo primero que se lee.
  const nVale = (n: unknown) => (typeof n === "number" ? String(n).padStart(5, "0") : null);
  if (a.tipo === "hueco_detectado") {
    const revelador = nVale(a.detalle.revelado_por_vale);
    return revelador
      ? `Falta este número de vale: se notó al registrarse el vale ${revelador}.`
      : "Falta este número de vale en la serie.";
  }
  if (a.tipo === "despacho_tardio") {
    return "El vale llegó después de que su hueco se congelara como anomalía: alguien lo cargó días después.";
  }
  if (a.tipo === "vale_fuera_de_orden") {
    const max = nVale(a.detalle.maxAnteriorDeLaSerie);
    return max
      ? `La serie ya llegaba al vale ${max} y este tiene un número menor.`
      : "El vale tiene un número menor que el último registrado de su serie.";
  }
  if (a.tipo === "lectura_retroactiva") {
    const { nivel, unidad, leidoEn, posteriores } = a.detalle as {
      nivel?: number;
      unidad?: string;
      leidoEn?: string;
      posteriores?: number;
    };
    const cuando = leidoEn ? new Date(leidoEn).toLocaleString("es-PE") : "?";
    return (
      `Varilla de ${nivel ?? "?"} ${unidad ?? ""} fechada el ${cuando}, ` +
      `con ${posteriores ?? "?"} lectura(s) posteriores ya cargadas.`
    );
  }
  if (a.tipo === "recepcion_retroactiva") {
    const { diasDeAtraso, diasTolerados } = a.detalle as {
      diasDeAtraso?: number;
      diasTolerados?: number;
    };
    return `Recepción fechada ${diasDeAtraso ?? "?"} días antes de su carga (se toleran ${diasTolerados ?? "?"}).`;
  }
  return "—";
}
