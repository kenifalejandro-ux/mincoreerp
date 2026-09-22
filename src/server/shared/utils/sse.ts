/** src/server/shared/utils/sse.ts
 *
 * Handler genérico de conexión SSE, compartido entre el stream de tenant
 * (routes/events.ts) y el de plataforma (routes/platform.ts): mismo
 * protocolo, distinta fuente de replay y distinto canal de Redis.
 */
import type { Request, Response } from "express";
import { logger } from "../../config/logger";
import { registrarConexionSSE, quitarConexionSSE } from "./sseRegistry";
import type { EventoTiempoReal } from "../../services/realtimeEvents.service";

// Railway (y cualquier proxy/balanceador de por medio) puede cortar una
// conexión que no ve tráfico -- este comentario (":" arranca un comentario
// SSE, el cliente lo ignora) mantiene el socket vivo sin ser un evento real.
const HEARTBEAT_MS = 20_000;

export interface OpcionesStreamSSE {
  canal: string;
  reponer: (desdeId: number) => Promise<EventoTiempoReal[]>;
  suscribir: (canal: string, onMensaje: (mensajeCrudo: string) => void) => Promise<() => void>;
  /** Ajusta cada evento antes de mandarlo a ESTA conexión (el alcance de
   *  Combustible, 0100, vacía el contenido para quien ve solo algunas
   *  plantas). Sin él, el evento sale tal cual. */
  adaptar?: (evento: EventoTiempoReal) => EventoTiempoReal;
}

function parsearUltimoEventId(req: Request): number | undefined {
  const header = req.headers["last-event-id"];
  const valor = Array.isArray(header) ? header[0] : header;
  const numero = Number(valor);
  return Number.isFinite(numero) && numero > 0 ? numero : undefined;
}

function enviarEventoSSE(res: Response, evento: EventoTiempoReal): void {
  res.write(`id: ${evento.id}\n`);
  res.write(`event: ${evento.tipo}\n`);
  res.write(`data: ${JSON.stringify(evento.payload)}\n\n`);
}

export async function manejarConexionSSE(
  req: Request,
  res: Response,
  opciones: OpcionesStreamSSE
): Promise<void> {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  // nginx (y los proxies que lo usan de base, Railway incluido) bufferea la
  // respuesta por defecto: junta la salida y la manda de a bloques, que para
  // un stream significa que los eventos llegan tarde o no llegan. Esta
  // cabecera es la forma estándar de pedirle que no lo haga; los proxies que
  // no la entienden la ignoran sin costo.
  //
  // No se detectó en desarrollo porque ahí no hay nginx de por medio, y los
  // tests hablan con el servidor directo -- de ahí que el stream pareciera
  // sano durante semanas mientras la campanita no actualizaba nada.
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const desdeId = parsearUltimoEventId(req);
  if (desdeId !== undefined) {
    try {
      const pendientes = await opciones.reponer(desdeId);
      pendientes.forEach((evento) => enviarEventoSSE(res, opciones.adaptar?.(evento) ?? evento));
    } catch (err) {
      // No cortar la conexión por esto -- el cliente sigue recibiendo lo
      // que llegue en vivo de acá en más, aunque se haya perdido el tramo
      // de reposición.
      logger.warn({ err, canal: opciones.canal }, "No se pudo reponer eventos en reconexión SSE");
    }
  }

  const desuscribir = await opciones.suscribir(opciones.canal, (mensajeCrudo) => {
    try {
      const evento = JSON.parse(mensajeCrudo) as EventoTiempoReal;
      enviarEventoSSE(res, opciones.adaptar?.(evento) ?? evento);
    } catch (err) {
      logger.warn(
        { err, canal: opciones.canal },
        "Mensaje de Redis con formato inesperado, descartado"
      );
    }
  });

  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, HEARTBEAT_MS);

  registrarConexionSSE(res);

  req.on("close", () => {
    clearInterval(heartbeat);
    desuscribir();
    quitarConexionSSE(res);
  });
}
