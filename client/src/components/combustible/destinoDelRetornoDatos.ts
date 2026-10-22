// Lo que comparten la ventana de retorno y su selector de destino: qué se eligió
// y cómo se traduce al cuerpo que espera el servidor (0143/0145/0146).

export interface DestinoElegido {
  destino: "" | "reserva" | "pozo" | "tanqueta";
  /** El tanque o la tanqueta elegidos; vacío mientras no se elige. */
  id: string;
}

export const SIN_DESTINO: DestinoElegido = { destino: "", id: "" };

export const destinoCompleto = (d: DestinoElegido) =>
  d.destino === "reserva" || (d.destino !== "" && d.id !== "");

/** Lo que el servidor espera según el destino elegido. */
export const cuerpoDelDestino = (d: DestinoElegido) =>
  d.destino === "pozo"
    ? { destino: "pozo", tanque_id: Number(d.id) }
    : d.destino === "tanqueta"
      ? { destino: "tanqueta", tanqueta_destino_id: Number(d.id) }
      : { destino: "reserva" };

export interface OtraTanqueta {
  id: string;
  codigo: string;
  activa: boolean;
  grifo_interno_id: number;
  libre: string;
}
