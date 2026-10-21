// client/src/services/apiClient.ts
//
// El access token dura 30 min (ver JWT_EXPIRES en el backend). fetch() no
// reintenta solo cuando ese token expira — sin este wrapper, cualquier
// pantalla abierta por más de 30 min empezaría a recibir 401 y se vería
// como una sesión "cortada", aunque el refresh token siga vigente.
//
// Toda llamada a /api/erp/* debe pasar por apiFetch en vez de fetch()
// directo.
//
// apiFetch es además el único punto donde se decide qué se encola cuando no
// hay red (ver client/src/offline/): es el embudo por el que ya pasa toda
// llamada al ERP, así que no hace falta que cada vista sepa nada del
// offline. Qué rutas califican lo declara el registry de módulos, no este
// archivo.

import { reportarResultadoDeRed } from "../offline/connectivity";
import { encolar, type CampoFormData } from "../offline/offlineQueue";
import { moduloParaEncolar } from "../offline/rutasOffline";
import { usuarioActivo } from "../offline/sesionOffline";

/** `red`: el refresh no llegó al servidor (sin señal). No es lo mismo que que
 *  el servidor lo rechace: sin señal la sesión puede seguir siendo válida. */
type ResultadoRefresh = "ok" | "rechazado" | "red";

let refrescoEnCurso: Promise<ResultadoRefresh> | null = null;
let onSesionExpirada: (() => void) | null = null;

// Nombre del lock coordinado por el navegador (ver refrescarAccessToken).
const LOCK_REFRESH = "erp-refresh-token";

/** AuthContext se registra acá para enterarse cuando el refresh también
 *  falla (refresh token vencido o revocado) y así limpiar el usuario en
 *  memoria y mandar a /login. */
export function registrarSesionExpirada(callback: () => void) {
  onSesionExpirada = callback;
}

async function pedirRefreshAlServidor(): Promise<ResultadoRefresh> {
  try {
    const res = await fetch("/api/auth/refresh", { method: "POST", credentials: "include" });
    // 5xx: el servidor no respondió bien (deploy, caída): no es un rechazo.
    if (res.status >= 500) return "red";
    return res.ok ? "ok" : "rechazado";
  } catch {
    return "red";
  }
}

async function refrescarAccessToken(): Promise<ResultadoRefresh> {
  // El backend rota el refresh token en cada uso y trata un reuso como
  // robo, revocando la sesión entera (ver auth.service.ts,
  // refrescarTokenService) — así que dos pestañas del mismo navegador
  // cuyo access token vence casi al mismo tiempo NO pueden llamar a
  // /refresh en paralelo: la segunda perdería la carrera contra la
  // rotación de la primera y tumbaría la sesión en todos los
  // dispositivos, como si hubiera sido un ataque real.
  //
  // navigator.locks coordina esto entre TODAS las pestañas del mismo
  // origen en el mismo navegador (no solo dentro de una pestaña como el
  // fallback de abajo). Cuando la segunda pestaña por fin obtiene el
  // lock, el navegador ya tiene la cookie nueva que dejó la primera —
  // así que su propio fetch sale con la cookie al día, sin colisión.
  if (typeof navigator !== "undefined" && "locks" in navigator) {
    return navigator.locks.request(LOCK_REFRESH, () => pedirRefreshAlServidor());
  }

  // Fallback para navegadores sin Web Locks API: al menos serializa
  // dentro de esta misma pestaña (protección parcial, mejor que nada).
  if (!refrescoEnCurso) {
    refrescoEnCurso = pedirRefreshAlServidor().finally(() => {
      refrescoEnCurso = null;
    });
  }
  return refrescoEnCurso;
}

const SIN_REINTENTO = ["/api/auth/login", "/api/auth/refresh", "/api/auth/logout"];

/** El camino de siempre: manda la request y, ante un 401, refresca el
 *  token y reintenta una vez. NO toca la cola offline — si falla por red,
 *  tira.
 *
 *  Lo usa offlineSync.ts al drenar la cola: si esas requests pasaran por
 *  apiFetch, un fallo de red las volvería a encolar (ya están en la cola) y
 *  el drenaje se perseguiría la cola a sí mismo. */
export async function enviarSinCola(input: string, init?: RequestInit): Promise<Response> {
  const respuesta = await fetch(input, { credentials: "include", ...init });

  if (respuesta.status !== 401 || SIN_REINTENTO.some((ruta) => input.startsWith(ruta))) {
    return respuesta;
  }

  const refresco = await refrescarAccessToken();
  if (refresco === "red") {
    // Sin señal el refresh no dice nada de la sesión: no se cierra. Se tira
    // como cualquier fallo de red, para que apiFetch encole lo encolable y
    // las pantallas lo traten como "sin conexión", no como "sesión vencida".
    throw new TypeError("Sin conexión");
  }
  if (refresco === "rechazado") {
    onSesionExpirada?.();
    return respuesta;
  }

  return fetch(input, { credentials: "include", ...init });
}

/** Respuesta sintética para el que llamó cuando la escritura quedó
 *  encolada. 202 Accepted es literalmente el código para "lo recibí, lo voy
 *  a procesar más tarde" — y al ser 2xx, `res.ok` es true, así que una
 *  vista que solo mira `res.ok` cierra su modal y no le muestra un error al
 *  operario por algo que NO se perdió.
 *
 *  Una vista que quiera distinguirlo (para decir "se sincronizará al
 *  volver la señal") mira el status 202 o el flag del body. */
function respuestaEncolada(clienteUuid: string): Response {
  return new Response(JSON.stringify({ pendienteDeSincronizar: true, cliente_uuid: clienteUuid }), {
    status: 202,
    headers: { "Content-Type": "application/json" },
  });
}

/** 502/503/504 que NO puso el backend sino el proxy (servidor caído, deploy):
 *  el backend marca todas sus respuestas con `x-request-id`, así que sin él la
 *  respuesta no vino de la app. Un 503 deliberado del backend (SSO apagado, etc.)
 *  sí lo trae y conserva su mensaje. */
export function esFalloDeInfraestructura(respuesta: Response): boolean {
  const s = respuesta.status;
  return (s === 502 || s === 503 || s === 504) && !respuesta.headers.get("x-request-id");
}

export async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  try {
    const respuesta = await enviarSinCola(input, init);
    // 502/503/504 los pone el proxy cuando el servidor está caído o
    // reiniciándose (un deploy): no es una respuesta del servidor sino su
    // ausencia. Se trata como fallo de red para que lo encolable se guarde en
    // el equipo y la franja avise "Sin conexión". Un 500 sí es del servidor.
    if (esFalloDeInfraestructura(respuesta)) {
      throw new TypeError(`Servidor no disponible (${respuesta.status})`);
    }
    // Llegó respuesta del servidor (aunque sea un 500): hay red.
    reportarResultadoDeRed(true);
    return respuesta;
  } catch (err) {
    // fetch() SOLO tira por fallo de red (DNS, sin ruta, conexión cortada,
    // CORS). Un 4xx/5xx llega como Response y sale por el return de
    // arriba, no por acá. Esa es toda la distinción que hace falta entre
    // "no se pudo mandar" (encolar) y "el servidor lo rechazó" (mostrar el
    // error, no reintentar para siempre).
    reportarResultadoDeRed(false);

    const moduloId = moduloParaEncolar(input, init?.method ?? "GET");
    if (!moduloId) throw err;

    // Sin cliente_uuid en el body no hay forma de que el servidor
    // deduplique el reintento, así que encolarlo arriesgaría duplicar.
    // Mejor que falle acá y se vea, que aceptar algo que puede corromper
    // datos más tarde.
    const clienteUuid = leerClienteUuid(init?.body);
    if (!clienteUuid) throw err;

    await encolar({
      clienteUuid,
      usuarioId: usuarioActivo(),
      moduloId,
      url: input,
      metodo: (init?.method ?? "POST").toUpperCase(),
      // FormData (subir un archivo, ver Caso B en ADR-0002 §8) NO se
      // serializa como JSON -- un File adentro no sobrevive un
      // JSON.stringify. Se guarda como lista de campos explícita en su
      // lugar (ver formDataAEntradas), y offlineSync.ts reconstruye el
      // FormData real al reenviar.
      ...(init?.body instanceof FormData
        ? { formData: formDataAEntradas(init.body) }
        : { body: typeof init?.body === "string" ? init.body : JSON.stringify(init?.body ?? {}) }),
      creadoEn: Date.now(),
      intentos: 0,
    });
    return respuestaEncolada(clienteUuid);
  }
}

/** El uuid viaja dentro del body (JSON o FormData) que armó la vista — no
 *  en un header aparte — para que sea el MISMO valor que el servidor
 *  persiste, sin posibilidad de que se desincronicen. */
function leerClienteUuid(body: BodyInit | null | undefined): string | null {
  if (body instanceof FormData) {
    const valor = body.get("cliente_uuid");
    return typeof valor === "string" ? valor : null;
  }
  if (typeof body !== "string") return null;
  try {
    const parseado: unknown = JSON.parse(body);
    if (parseado && typeof parseado === "object" && "cliente_uuid" in parseado) {
      const valor = (parseado as { cliente_uuid: unknown }).cliente_uuid;
      return typeof valor === "string" ? valor : null;
    }
  } catch {
    // No era JSON ni FormData, ej. texto plano: no es encolable.
  }
  return null;
}

// forEach() en vez de .entries() -- lib.dom.iterable no está en el
// tsconfig del cliente, y no vale la pena sumarla solo por esto.
function formDataAEntradas(formData: FormData): CampoFormData[] {
  const entradas: CampoFormData[] = [];
  formData.forEach((valor, campo) => {
    entradas.push(
      valor instanceof File
        ? { campo, archivo: valor, nombreArchivo: valor.name }
        : { campo, valor }
    );
  });
  return entradas;
}
