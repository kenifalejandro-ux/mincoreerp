// Lo que comparten la ventana de retorno y su selector de destino: qué se eligió
// y cómo se traduce al cuerpo que espera el servidor (0143/0145/0146).

export interface DestinoElegido {
  destino: "" | "reserva" | "pozo" | "tanqueta" | "unidad";
  /** El tanque, la tanqueta o la unidad elegidos; vacío mientras no se elige. */
  id: string;
  /** Solo para "unidad": el vale de esa salida, como al asignar. */
  serie: string;
  vale: string;
}

export const SIN_DESTINO: DestinoElegido = { destino: "", id: "", serie: "", vale: "" };

export const destinoCompleto = (d: DestinoElegido) =>
  d.destino === "reserva" ||
  (d.destino === "unidad" && d.id !== "" && d.serie.trim() !== "" && Number(d.vale) > 0) ||
  ((d.destino === "pozo" || d.destino === "tanqueta") && d.id !== "");

/** Lo que el servidor espera según el destino elegido. */
export const cuerpoDelDestino = (d: DestinoElegido) =>
  d.destino === "pozo"
    ? { destino: "pozo", tanque_id: Number(d.id) }
    : d.destino === "tanqueta"
      ? { destino: "tanqueta", tanqueta_destino_id: Number(d.id) }
      : d.destino === "unidad"
        ? {
            destino: "unidad",
            equipo_id: Number(d.id),
            serie_talonario: d.serie.trim(),
            n_vale: Number(d.vale),
          }
        : { destino: "reserva" };

export interface OtraTanqueta {
  id: string;
  codigo: string;
  activa: boolean;
  grifo_interno_id: number;
  libre: string;
}
