// client/src/offline/offlineSync.ts
//
// Drena la cola cuando vuelve la conexión.
//
// El servidor es quien garantiza que reintentar no duplique: cada entrada
// lleva su `cliente_uuid` en el body y el endpoint la resuelve con
// idempotentInsert() (ver migración 0044). Por eso acá se puede reintentar
// con confianza — el peor caso de un reintento de más es un 200 con la
// fila que ya existía, no un checklist duplicado.
//
// Mismo espíritu que platformOutbox.worker.ts del backend (drenar
// pendientes con reintento), pero corriendo en el navegador y sin
// coordinación entre pestañas: si dos pestañas drenan a la vez, la
// idempotencia del servidor las hace inofensivas.

import {
  hayConexionReal,
  iniciarMonitoreoDeConexion,
  reportarResultadoDeRed,
} from "./connectivity";
import {
  listarPendientes,
  quitarDeLaCola,
  registrarIntentoFallido,
  suscribirseACola,
  type EntradaCola,
} from "./offlineQueue";
import { enviarSinCola } from "../services/apiClient";

/** Tope de reintentos antes de dar la entrada por perdida. Alto a
 *  propósito: un checklist llenado en campo es trabajo real de una
 *  persona, no un evento descartable. Solo se llega acá si el servidor
 *  responde error de forma consistente, no por falta de señal (eso no
 *  cuenta como intento — ver drenar()). */
const MAX_INTENTOS = 10;

let drenandoAhora = false;

/** Una entrada que se descartó DEFINITIVAMENTE (no se va a reintentar más).
 *  Sin esto, "fallidas" era solo un número: nadie podía decir NI el
 *  operario NI un admin qué se perdió ni de qué módulo era -- el badge de
 *  pendientes bajaba igual que si hubiera sincronizado. Ver EstadoOffline.tsx. */
export interface EntradaDescartada {
  moduloId: string;
  error: string;
}

type OyenteResultado = (resultado: {
  sincronizadas: number;
  fallidas: number;
  descartadas: EntradaDescartada[];
}) => void;
const oyentes = new Set<OyenteResultado>();

/** Para que la vista pueda recargar su listado justo después de que la
 *  cola se vació, sin tener que pollear. */
export function suscribirseASincronizacion(oyente: OyenteResultado): () => void {
  oyentes.add(oyente);
  return () => oyentes.delete(oyente);
}

/** Un 4xx es un rechazo del servidor sobre el CONTENIDO (validación,
 *  permisos, cuota llena): reintentarlo va a fallar igual para siempre, así
 *  que la entrada sale de la cola y se reporta. Un 5xx sí se reintenta: es
 *  un problema del servidor, probablemente pasajero.
 *
 *  El 401 es la excepción dentro de los 4xx: el access token pudo haber
 *  vencido mientras el equipo estaba sin señal. enviarSinCola() ya intenta
 *  refrescarlo antes de devolver; si aun así vuelve 401, la sesión está
 *  realmente caída y no tiene sentido seguir drenando ahora. */
function esErrorPermanente(status: number): boolean {
  return status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429;
}

const TIPOS_POR_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  pdf: "application/pdf",
};

/** Un archivo que vuelve de IndexedDB puede perder su tipo (pasa en algunos
 *  motores de WebKit): el servidor valida el tipo del archivo y lo rechazaría
 *  con un 4xx, que la cola descarta en silencio. Si viene sin tipo, se deduce
 *  de la extensión del nombre. */
function conTipo(archivo: Blob, nombre: string): Blob {
  if (archivo.type) return archivo;
  const tipo = TIPOS_POR_EXTENSION[nombre.split(".").pop()?.toLowerCase() ?? ""];
  return tipo ? new Blob([archivo], { type: tipo }) : archivo;
}

/** Arma el `RequestInit` a reenviar. Un archivo adjunto (`formData`, ver
 *  Caso B en ADR-0002 §8) reconstruye el `FormData` real y NO fija
 *  `Content-Type` a mano -- fetch() arma el boundary del multipart solo, y
 *  ponerlo nosotros sin ese boundary rompería el parseo en el servidor. */
function initDeEntrada(entrada: EntradaCola): RequestInit {
  if (entrada.formData) {
    const formData = new FormData();
    for (const campo of entrada.formData) {
      if ("archivo" in campo) {
        formData.append(
          campo.campo,
          conTipo(campo.archivo, campo.nombreArchivo),
          campo.nombreArchivo
        );
      } else {
        formData.append(campo.campo, campo.valor);
      }
    }
    return { method: entrada.metodo, body: formData };
  }
  return {
    method: entrada.metodo,
    headers: { "Content-Type": "application/json" },
    body: entrada.body,
  };
}

interface ResultadoEnvio {
  resultado: "ok" | "reintentar" | "descartar";
  /** Solo presente cuando resultado === "descartar" -- para que el
   *  operario (o quien revise después) sepa POR QUÉ se perdió, no solo que
   *  se perdió. */
  detalle?: string;
}

async function enviarEntrada(entrada: EntradaCola): Promise<ResultadoEnvio> {
  let respuesta: Response;
  try {
    respuesta = await enviarSinCola(entrada.url, initDeEntrada(entrada));
  } catch {
    // Falló por red otra vez: NO cuenta como intento (si no, unas horas de
    // mala señal agotarían MAX_INTENTOS y se perdería trabajo real).
    reportarResultadoDeRed(false);
    return { resultado: "reintentar" };
  }

  reportarResultadoDeRed(true);

  // 2xx incluye el 200 que devuelve el servidor cuando esta entrada YA se
  // había guardado y esto era el reintento de una respuesta perdida — que
  // es exactamente un éxito desde el punto de vista de la cola.
  if (respuesta.ok) return { resultado: "ok" };

  if (esErrorPermanente(respuesta.status)) {
    return { resultado: "descartar", detalle: `HTTP ${respuesta.status}` };
  }

  await registrarIntentoFallido(entrada, `HTTP ${respuesta.status}`);
  return entrada.intentos + 1 >= MAX_INTENTOS
    ? { resultado: "descartar", detalle: `HTTP ${respuesta.status} (máximo de reintentos)` }
    : { resultado: "reintentar" };
}

export async function drenar(): Promise<{ sincronizadas: number; fallidas: number }> {
  // Sin lock entre pestañas a propósito (ver el comentario del archivo);
  // este flag solo evita que la MISMA pestaña drene dos veces en paralelo,
  // que sí sería trabajo duplicado gratis.
  if (drenandoAhora) return { sincronizadas: 0, fallidas: 0 };
  drenandoAhora = true;

  let sincronizadas = 0;
  let fallidas = 0;
  const descartadas: EntradaDescartada[] = [];
  try {
    for (const entrada of await listarPendientes()) {
      const { resultado, detalle } = await enviarEntrada(entrada);
      if (resultado === "ok") {
        await quitarDeLaCola(entrada.clienteUuid);
        sincronizadas++;
      } else if (resultado === "descartar") {
        await quitarDeLaCola(entrada.clienteUuid);
        fallidas++;
        descartadas.push({ moduloId: entrada.moduloId, error: detalle ?? "Error desconocido" });
      } else {
        // Se cortó la red de nuevo (o el servidor está caído): frenar acá
        // y dejar el resto para la próxima. Seguir intentando las que
        // siguen solo acumularía fallos por el mismo motivo.
        break;
      }
    }
  } finally {
    drenandoAhora = false;
  }

  if (sincronizadas > 0 || fallidas > 0) {
    for (const oyente of oyentes) oyente({ sincronizadas, fallidas, descartadas });
  }
  return { sincronizadas, fallidas };
}

/** Cada cuánto se vuelve a probar cuando hay cola pendiente. No es un
 *  latido permanente: el temporizador solo existe mientras haya algo sin
 *  sincronizar, y el probe es un GET diminuto a /api/health. */
const REINTENTO_MS = 15_000;

let temporizador: ReturnType<typeof setInterval> | null = null;

function detenerReintentos(): void {
  if (temporizador === null) return;
  clearInterval(temporizador);
  temporizador = null;
}

/** El evento "online" del navegador NO alcanza como único disparador, y no
 *  es una precaución teórica: avisa cuando aparece una interfaz de red, que
 *  en una planta con señal intermitente (o detrás de un portal cautivo) no
 *  es lo mismo que tener salida real — puede no dispararse nunca aunque la
 *  conexión vuelva, o dispararse cuando todavía no sirve. Mientras quede
 *  algo en la cola, se reintenta por las suyas confirmando con el probe. */
function ajustarReintentos(pendientes: number): void {
  if (pendientes === 0) {
    detenerReintentos();
    return;
  }
  if (temporizador !== null) return;

  temporizador = setInterval(() => {
    void hayConexionReal().then((online) => {
      reportarResultadoDeRed(online);
      if (online) void drenar();
    });
  }, REINTENTO_MS);
}

/** Se llama una vez, desde main.tsx. */
export function iniciarSincronizacionOffline(): void {
  iniciarMonitoreoDeConexion(() => {
    void drenar();
  });

  // Enciende/apaga el reintento periódico según haya o no cola pendiente.
  suscribirseACola(ajustarReintentos);

  // Al arrancar la app puede haber cola de una sesión anterior (el operario
  // cerró la app sin señal y la vuelve a abrir ya con red). El evento
  // "online" no dispara en ese caso porque nunca hubo transición.
  void hayConexionReal().then((online) => {
    reportarResultadoDeRed(online);
    if (online) void drenar();
  });
}
