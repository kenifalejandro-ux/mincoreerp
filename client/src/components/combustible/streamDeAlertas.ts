// client/src/components/combustible/streamDeAlertas.ts
//
// Una sola conexión al stream de eventos para la campanita y la Bandeja.
//
// La campanita (admin) y la Bandeja (admin y operador) escuchan las alertas al
// mismo tiempo. Cada una abría SU EventSource: dos conexiones por pestaña, y
// con HTTP/1.1 el navegador permite 6 por origen, así que tres pestañas
// agotaban el cupo y dejaban sin conexión a todo lo demás. Ahora hay UNA, que
// se abre con el primer suscriptor y se cierra con el último; cada uno recibe
// el aviso y recarga lo suyo.
//
// OJO: solo unifica a esos dos y a la compra en ruta (viajes, vía
// `suscribirseAEventos`). CombustiblePanel, ViajesPanel, DetalleViaje y MiViaje
// siguen abriendo su propio EventSource (pendiente: PR aparte).
//
// Vive en su propio archivo, sin React ni apiClient, para poder probarlo con
// el vitest de la raíz (tests/stream-alertas-compartido.test.ts).

export const EVENTOS_DE_ALERTAS = [
  "combustible.alerta_creada",
  "combustible.alerta_resuelta",
  "combustible.alertas_actualizadas",
] as const;

// Cada suscripción elige qué eventos le interesan; la conexión es una sola.
interface Suscripcion {
  eventos: readonly string[];
  alAvisar: () => void;
}

const suscripciones = new Set<Suscripcion>();
// Los tipos de evento que la conexión actual ya escucha: así cada tipo se
// registra una sola vez, sin importar cuántos suscriptores lo pidan.
const tiposEscuchados = new Set<string>();
let fuenteCompartida: EventSource | null = null;

function avisar(tipo: string) {
  for (const s of suscripciones) if (s.eventos.includes(tipo)) s.alAvisar();
}

/** Igual que `suscribirseAlStreamDeAlertas`, pero con los eventos que elija el
 *  llamador (p. ej. los de viajes) sobre la misma conexión. */
export function suscribirseAEventos(eventos: readonly string[], alAvisar: () => void): () => void {
  const suscripcion: Suscripcion = { eventos, alAvisar };
  suscripciones.add(suscripcion);
  if (fuenteCompartida === null) {
    fuenteCompartida = new EventSource("/api/eventos/stream", { withCredentials: true });
  }
  for (const tipo of eventos) {
    if (tiposEscuchados.has(tipo)) continue;
    tiposEscuchados.add(tipo);
    fuenteCompartida.addEventListener(tipo, () => avisar(tipo));
  }
  return () => {
    suscripciones.delete(suscripcion);
    if (suscripciones.size === 0 && fuenteCompartida !== null) {
      fuenteCompartida.close();
      fuenteCompartida = null;
      tiposEscuchados.clear();
    }
  };
}

/** Devuelve la función que da de baja la suscripción. Llamarla dos veces no
 *  hace daño: la segunda no encuentra nada que borrar. */
export function suscribirseAlStreamDeAlertas(alAvisar: () => void): () => void {
  return suscribirseAEventos(EVENTOS_DE_ALERTAS, alAvisar);
}
