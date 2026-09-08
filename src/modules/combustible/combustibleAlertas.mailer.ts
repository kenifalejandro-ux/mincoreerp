/** src/modules/combustible/combustibleAlertas.mailer.ts
 *
 * Correo de las alertas de combustible (migrations/0068): mismo transporter
 * y mismo contrato "nunca lanza" que enviarCorreoRecuperacion() en
 * auth.service.ts -- un fallo de SMTP no puede tumbar la mutación que lo
 * originó (crear un despacho, anular un vale), solo se loguea.
 */
import { emailConfigured, env } from "../../server/config/env";
import { transporter } from "../../server/config/mailer";
import { logger } from "../../server/config/logger";
import { escapeHtml } from "../../server/shared/utils/html";

interface Destinatario {
  email: string;
  nombre: string;
}

async function enviarCorreoAlerta(params: {
  destinatarios: Destinatario[];
  asunto: string;
  titulo: string;
  lineas: string[];
}) {
  if (!transporter || !emailConfigured || params.destinatarios.length === 0) return;

  const text = [params.titulo, "", ...params.lineas].join("\n");
  const html = `
    <div style="font-family: Arial, sans-serif; color: #111827; line-height: 1.6;">
      <h2 style="margin-bottom: 16px;">${escapeHtml(params.titulo)}</h2>
      ${params.lineas.map((l) => `<p>${escapeHtml(l)}</p>`).join("\n")}
    </div>
  `;

  try {
    await transporter.sendMail({
      from: `"MinCore ERP" <${env.emailUser}>`,
      to: params.destinatarios.map((d) => d.email),
      subject: params.asunto,
      text,
      html,
    });
  } catch (err) {
    logger.error({ err }, "No se pudo enviar el correo de alerta de combustible");
  }
}

/** Un vale más allá reveló que uno o más números anteriores nunca se
 *  registraron (ver detectarHuecosRevelados en combustible.repository.ts).
 *  Todavía no se sabe la causa -- puede resolverse solo en unas horas
 *  (offline que sincroniza) o quedar como hallazgo real al cerrar el
 *  período (Fase D entrega 2). */
export async function enviarCorreoAlertaHueco(
  destinatarios: Destinatario[],
  params: { serieTalonario: string; valesFaltantes: number[]; nValeQueLoRevelo: number }
) {
  const listaVales = params.valesFaltantes.map((n) => String(n).padStart(5, "0")).join(", ");
  await enviarCorreoAlerta({
    destinatarios,
    asunto: `Combustible: hueco en talonario ${params.serieTalonario}`,
    titulo: `Hueco detectado en la serie ${params.serieTalonario}`,
    lineas: [
      `Falta${params.valesFaltantes.length > 1 ? "n" : ""} el vale ${listaVales} -- se detectó` +
        ` al registrarse el vale ${String(params.nValeQueLoRevelo).padStart(5, "0")}.`,
      "Puede resolverse solo (por ejemplo si el vale está pendiente de sincronizar sin señal) " +
        "o seguir sin explicación -- revisar en el ERP.",
    ],
  });
}

/** Se despachó más de lo que el tanque de esa unidad puede contener
 *  (migraciones 0069/0070). El vale NO se bloqueó: la explicación más
 *  probable no es fraude (un bidón extra en el mismo vale, o la capacidad
 *  mal cargada), pero necesita que alguien lo confirme. */
export async function enviarCorreoAlertaSobredespacho(
  destinatarios: Destinatario[],
  params: {
    serieTalonario: string;
    nVale: number;
    cantidad: number;
    unidadDespacho: string;
    capacidad: number;
    unidadCapacidad: string;
    excesoPct: number;
  }
) {
  await enviarCorreoAlerta({
    destinatarios,
    asunto: `Combustible: sobredespacho en vale ${params.serieTalonario}-${String(params.nVale).padStart(5, "0")}`,
    titulo: `Sobredespacho detectado en la serie ${params.serieTalonario}`,
    lineas: [
      `El vale ${String(params.nVale).padStart(5, "0")} despachó ${params.cantidad} ` +
        `${params.unidadDespacho} a una unidad cuyo tanque es de ${params.capacidad} ` +
        `${params.unidadCapacidad} -- un ${params.excesoPct}% por encima de su capacidad.`,
      "El vale se registró igual (no se bloquea el abastecimiento). Puede ser un bidón " +
        "cargado en el mismo vale, la capacidad mal cargada en el sistema, o un error de " +
        "tipeo -- revisar en el ERP.",
    ],
  });
}

/** El horómetro/odómetro no cierra con el del despacho anterior de esa
 *  misma unidad (punto 5 del documento). El vale NO se bloqueó: puede ser
 *  un tipeo, pero también adulteración -- por eso lo mira una persona. */
export async function enviarCorreoAlertaMedidor(
  destinatarios: Destinatario[],
  params: {
    serieTalonario: string;
    nVale: number;
    medidor: "horometro" | "odometro";
    motivo: "retroceso" | "excede_calendario";
    valorAnterior: number;
    valorNuevo: number;
    horasDeclaradas?: number;
    horasCalendario?: number;
  }
) {
  const nombreMedidor = params.medidor === "horometro" ? "horómetro" : "odómetro";
  const vale = String(params.nVale).padStart(5, "0");

  const explicacion =
    params.motivo === "retroceso"
      ? `El ${nombreMedidor} marcó ${params.valorNuevo}, MENOS que los ${params.valorAnterior} ` +
        `del despacho anterior de esa unidad. Un medidor no vuelve atrás.`
      : `El horómetro sumó ${params.horasDeclaradas} horas de motor, pero desde el despacho ` +
        `anterior solo pasaron ${params.horasCalendario} horas de reloj. Una máquina no puede ` +
        `acumular más horas de motor que las que pasaron.`;

  await enviarCorreoAlerta({
    destinatarios,
    asunto: `Combustible: ${nombreMedidor} inconsistente en vale ${params.serieTalonario}-${vale}`,
    titulo: `Medidor inconsistente en la serie ${params.serieTalonario}`,
    lineas: [
      `Vale ${vale}. ${explicacion}`,
      "El vale se registró igual (no se bloquea el abastecimiento). Puede ser un error de " +
        "tipeo o un medidor adulterado -- revisar en el ERP.",
    ],
  });
}

/** El tanque cruzó su nivel mínimo. A diferencia del resto, esta alerta NO
 *  es anti-fraude sino operativa: avisa antes de quedarse sin combustible
 *  en cancha. Por eso tampoco se congela como anomalía. */
export async function enviarCorreoAlertaNivelBajo(
  destinatarios: Destinatario[],
  params: { tanqueNombre: string; nivel: number; nivelMinimo: number; unidad: string }
) {
  await enviarCorreoAlerta({
    destinatarios,
    asunto: `Combustible: nivel bajo en ${params.tanqueNombre}`,
    titulo: `Nivel bajo en ${params.tanqueNombre}`,
    lineas: [
      `La última lectura de varilla marcó ${params.nivel} ${params.unidad}, por debajo del ` +
        `mínimo configurado de ${params.nivelMinimo} ${params.unidad}.`,
      "Conviene programar la reposición antes de que la operación se quede sin combustible.",
    ],
  });
}

/** El balance del tanque no cierra (migración 0074): entre dos lecturas de
 *  varilla, el nivel medido no coincide con lo que los movimientos
 *  registrados explican.
 *
 *  El correo muestra la cuenta completa y no solo el resultado: quien lo
 *  recibe tiene que poder ver de dónde sale el número sin entrar al sistema,
 *  porque la primera reacción útil es acordarse de un movimiento que no se
 *  cargó -- y para eso hay que ver qué SÍ se contó. */
export async function enviarCorreoAlertaDescuadre(
  destinatarios: Destinatario[],
  params: {
    tanqueNombre: string;
    unidad: string;
    nivelAnterior: number;
    nivelMedido: number;
    despachos: number;
    recepciones: number;
    esperado: number;
    descuadreLitros: number;
    sentido: "falta" | "sobra";
    umbralPct: number;
  }
) {
  const u = params.unidad;
  const faltante = params.sentido === "falta";
  const magnitud = Math.abs(params.descuadreLitros);

  await enviarCorreoAlerta({
    destinatarios,
    asunto: `Combustible: ${faltante ? "faltan" : "sobran"} ${magnitud} ${u} en ${params.tanqueNombre}`,
    titulo: `El balance de ${params.tanqueNombre} no cierra`,
    lineas: [
      `Nivel de la lectura anterior: ${params.nivelAnterior} ${u}.`,
      `Recepciones registradas en el período: +${params.recepciones} ${u}.`,
      `Despachos registrados en el período: −${params.despachos} ${u}.`,
      `Debería haber quedado en ${params.esperado} ${u}, pero la varilla marcó ` +
        `${params.nivelMedido} ${u}.`,
      faltante
        ? `Faltan ${magnitud} ${u} que ningún vale ni anulación explica. Puede ser un ` +
          `despacho que no se registró, una fuga, o una sustracción.`
        : `Sobran ${magnitud} ${u}: los vales declaran más salida de la que realmente ` +
          `hubo. Puede ser un error de tipeo en un vale, o combustible cargado en el ` +
          `papel a una unidad que nunca lo recibió.`,
      `El umbral configurado para este tanque es ${params.umbralPct}% de su capacidad.`,
    ],
  });
}

/** El saldo del CICLO no cierra (migración 0076): sumando todo desde que el
 *  tanque se cargó, falta o sobra combustible.
 *
 *  Es el hallazgo más fuerte del módulo, y por eso el correo lo dice
 *  distinto que el de tramo: acá el número no es "lo que pasó entre dos
 *  mediciones" sino "lo que no cuadra desde que este tanque se llenó", que
 *  es lo que un gerente puede llevar a una reunión. */
export async function enviarCorreoAlertaDescuadreCiclo(
  destinatarios: Destinatario[],
  params: {
    tanqueNombre: string;
    unidad: string;
    cicloDesde: string;
    nivelInicio: number;
    nivelMedido: number;
    despachos: number;
    recepciones: number;
    esperado: number;
    descuadreLitros: number;
    sentido: "falta" | "sobra";
    umbralPct: number;
  }
) {
  const u = params.unidad;
  const faltante = params.sentido === "falta";
  const magnitud = Math.abs(params.descuadreLitros);
  const desde = new Date(params.cicloDesde).toLocaleString("es-PE");

  await enviarCorreoAlerta({
    destinatarios,
    asunto:
      `Combustible: ${faltante ? "faltan" : "sobran"} ${magnitud} ${u} ` +
      `acumulados en ${params.tanqueNombre}`,
    titulo: `${params.tanqueNombre}: el ciclo completo no cierra`,
    lineas: [
      `Período analizado: desde ${desde} (última carga del tanque) hasta ahora.`,
      `Nivel al inicio del ciclo: ${params.nivelInicio} ${u}.`,
      `Recepciones del ciclo: +${params.recepciones} ${u}.`,
      `Despachos del ciclo: −${params.despachos} ${u}.`,
      `Debería haber ${params.esperado} ${u}, y la varilla marca ${params.nivelMedido} ${u}.`,
      faltante
        ? `Faltan ${magnitud} ${u} en todo el ciclo. Esto se detecta aunque cada medición ` +
          `individual haya parecido normal: un faltante repartido en porciones chicas solo ` +
          `se ve sumando el período completo.`
        : `Sobran ${magnitud} ${u} en todo el ciclo: los vales del período declaran más ` +
          `salida de la que realmente hubo.`,
      `Umbral del ciclo para este tanque: ${params.umbralPct}% de su capacidad.`,
    ],
  });
}

/** Nadie tomó varilla en este tanque dentro del plazo (migración 0076).
 *
 *  No es una alerta de combustible sino de PROCESO, y es la más importante
 *  de todas en un sentido: sin lecturas, ni el descuadre ni la diferencia de
 *  recepción se pueden calcular. Dejar de medir apaga el control entero, y
 *  no requiere saber nada del sistema para lograrlo. */
export async function enviarCorreoAlertaSinMedir(
  destinatarios: Destinatario[],
  params: {
    tanqueNombre: string;
    diasSinMedir: number | null;
    ultimaLectura: string | null;
    plazoDias: number;
  }
) {
  const cuando =
    params.ultimaLectura === null
      ? "Nunca se registró una lectura de varilla en este tanque."
      : `La última lectura fue el ${new Date(params.ultimaLectura).toLocaleString("es-PE")}` +
        (params.diasSinMedir === null ? "." : `, hace ${params.diasSinMedir} días.`);

  await enviarCorreoAlerta({
    destinatarios,
    asunto: `Combustible: ${params.tanqueNombre} lleva días sin medirse`,
    titulo: `Sin lecturas de varilla en ${params.tanqueNombre}`,
    lineas: [
      cuando,
      `El plazo configurado es de ${params.plazoDias} días.`,
      "Mientras no se mida, el sistema NO puede detectar faltantes ni comparar lo que " +
        "facturó el proveedor contra lo que realmente entró: las dos verificaciones " +
        "dependen de la varilla.",
      "Tomar la lectura cierra esta alerta automáticamente.",
    ],
  });
}

/** Se cargó una varilla con fecha anterior a mediciones que ya existían,
 *  dentro del ciclo en curso (migración 0078).
 *
 *  NO se bloqueó, y el correo lo dice: la explicación más común es la cola
 *  offline -- una medición tomada sin señal que sincroniza más tarde. Pero
 *  también es la forma de mover el punto de partida del ciclo, así que la
 *  mira una persona. */
export async function enviarCorreoLecturaRetroactiva(
  destinatarios: Destinatario[],
  params: {
    tanqueNombre: string;
    unidad: string;
    nivel: number;
    leidoEn: string;
    posteriores: number;
  }
) {
  await enviarCorreoAlerta({
    destinatarios,
    asunto: `Combustible: varilla cargada hacia atrás en ${params.tanqueNombre}`,
    titulo: `Lectura fuera de orden en ${params.tanqueNombre}`,
    lineas: [
      `Se registró una lectura de ${params.nivel} ${params.unidad} fechada el ` +
        `${new Date(params.leidoEn).toLocaleString("es-PE")}, cuando ya había ` +
        `${params.posteriores} medición(es) posterior(es) en este mismo período.`,
      "Lo más probable es que venga de la cola offline: una varilla tomada sin señal " +
        "que recién ahora sincronizó. Eso es normal y no hay nada que corregir.",
      "Se avisa igual porque una lectura insertada al inicio del período cambia el " +
        "punto de partida del balance, y con él lo que el sistema considera esperado.",
    ],
  });
}

/** Alguien AFLOJÓ un control de vigilancia.
 *
 *  Es el aviso más importante del módulo, y el único que no es sobre
 *  combustible sino sobre el sistema que lo vigila. Sin él, apagar la
 *  detección quedaba registrado en un log que nadie abre -- y un robo se
 *  planifica así: apago el control, saco el combustible, lo vuelvo a prender.
 *
 *  Va a TODOS los admins con el módulo habilitado y no tiene configuración
 *  de por medio, a propósito: si quien afloja el control pudiera además
 *  elegir a quién se le avisa, el aviso no serviría de nada.
 *
 *  Ojo con lo que este correo NO resuelve: se puede esquivar haciendo el
 *  cambio un viernes a la noche y revirtiéndolo el domingo. Lo que sí queda
 *  es el registro, y el reporte de período que muestra que el control estuvo
 *  apagado esos días. */
export async function enviarCorreoVigilanciaReducida(
  destinatarios: Destinatario[],
  params: {
    quien: string;
    objeto: string;
    motivo: string;
    cambios: { control: string; de: string; a: string }[];
  }
) {
  await enviarCorreoAlerta({
    destinatarios,
    asunto: `Combustible: se redujo la vigilancia de ${params.objeto}`,
    titulo: `${params.quien} redujo la vigilancia de ${params.objeto}`,
    lineas: [
      ...params.cambios.map((c) => `${c.control}: ${c.de} → ${c.a}.`),
      `Motivo declarado: "${params.motivo}".`,
      "Mientras el control esté así, el sistema detecta menos de lo que detectaba. " +
        "Si el cambio no corresponde, revertilo y revisá el movimiento del tanque en " +
        "ese período.",
    ],
  });
}

/** El acumulado de 24 h de un actor pasó su techo (migración 0079). A
 *  diferencia del sobredespacho, que es sobre UN vale, acá el problema es la
 *  suma: ningún vale por separado llama la atención. */
export async function enviarCorreoTopeDiario(
  destinatarios: Destinatario[],
  params: {
    actor: string;
    acumuladoL: number;
    topeL: number;
    vales: number;
    base: string;
    serieTalonario: string;
    nVale: number;
  }
) {
  await enviarCorreoAlerta({
    destinatarios,
    asunto: `Combustible: ${params.actor} pasó su tope diario`,
    titulo: `${params.actor} recibió ${params.acumuladoL} L en 24 horas`,
    lineas: [
      `Su tope es ${params.topeL} L (${params.base}).`,
      `Se repartió en ${params.vales} vale(s); el que cruzó la línea es el ` +
        `${params.serieTalonario}-${String(params.nVale).padStart(5, "0")}.`,
      "Ningún vale por separado excede nada -- el problema es la suma. " +
        "Revisar contra el trabajo real de ese equipo o destino en el período.",
    ],
  });
}

/** Un vale que sí se había registrado se anuló -- a diferencia del hueco,
 *  esto siempre tiene un motivo escrito por quien lo anuló, pero necesita
 *  revisión: "todo tiene que tener sustento". */
export async function enviarCorreoAlertaAnulacion(
  destinatarios: Destinatario[],
  params: { serieTalonario: string; nVale: number; motivo: string }
) {
  await enviarCorreoAlerta({
    destinatarios,
    asunto: `Combustible: vale anulado en talonario ${params.serieTalonario}`,
    titulo: `Vale anulado en la serie ${params.serieTalonario}`,
    lineas: [
      `El vale ${String(params.nVale).padStart(5, "0")} fue anulado. Motivo: "${params.motivo}".`,
      "Revisar en el ERP y marcarlo como revisado si el motivo es válido.",
    ],
  });
}
