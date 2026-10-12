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
// OJO: solo unifica a esos dos. CombustiblePanel, ViajesPanel, DetalleViaje y
// MiViaje siguen abriendo su propio EventSource (pendiente: PR aparte).
//
// Vive en su propio archivo, sin React ni apiClient, para poder probarlo con
// el vitest de la raíz (tests/stream-alertas-compartido.test.ts).

export const EVENTOS_DE_ALERTAS = [
  "combustible.alerta_creada",
  "combustible.alerta_resuelta",
  "combustible.alertas_actualizadas",
] as const;

const suscriptoresDelStream = new Set<() => void>();
let fuenteCompartida: EventSource | null = null;

function avisarASuscriptores() {
  for (const alAvisar of suscriptoresDelStream) alAvisar();
}

/** Devuelve la función que da de baja la suscripción. Llamarla dos veces no
 *  hace daño: la segunda no encuentra nada que borrar. */
export function suscribirseAlStreamDeAlertas(alAvisar: () => void): () => void {
  suscriptoresDelStream.add(alAvisar);
  if (fuenteCompartida === null) {
    const es = new EventSource("/api/eventos/stream", { withCredentials: true });
    for (const evento of EVENTOS_DE_ALERTAS) es.addEventListener(evento, avisarASuscriptores);
    fuenteCompartida = es;
  }
  return () => {
    suscriptoresDelStream.delete(alAvisar);
    if (suscriptoresDelStream.size === 0 && fuenteCompartida !== null) {
      fuenteCompartida.close();
      fuenteCompartida = null;
    }
  };
}
