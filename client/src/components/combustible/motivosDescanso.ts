// Los motivos de un descanso o de una detención en ruta. Dormir y Comer son descansos; avería,
// accidente, huaico, bloqueo y tráfico son detenciones que no son culpa del conductor: el viaje
// dice qué pasó ("En avería") en vez de "Descansando". El tiempo de las dos se descuenta de lo que
// tarda el tramo, así que no cuenta como retraso.

export const MOTIVOS_DESCANSO = [
  "Dormir",
  "Comer",
  "Avería",
  "Accidente",
  "Huaico",
  "Bloqueo",
  "Tráfico",
  "Otro",
];

const DETENCIONES = ["Avería", "Accidente", "Huaico", "Bloqueo", "Tráfico"];

/** Estos dos piden escribir qué pasó. */
export const pideDetalle = (motivo: string) => motivo === "Otro" || motivo === "Tráfico";

/** El motivo que se guarda: "Otro" es lo escrito; "Tráfico", lo escrito con su etiqueta. Vacío si
 *  falta el detalle que piden. */
export function motivoGuardado(motivo: string, detalle: string): string {
  const d = detalle.trim();
  if (motivo === "Otro") return d.slice(0, MAX_MOTIVO);
  if (motivo === "Tráfico") {
    const prefijo = "Tráfico · ";
    return d ? `${prefijo}${d.slice(0, MAX_MOTIVO - prefijo.length)}` : "";
  }
  return motivo;
}

/** El servidor guarda el motivo en 80 caracteres como máximo. */
export const MAX_MOTIVO = 80;

/** Cuánto se puede escribir en el detalle de ese motivo (Tráfico gasta 10 en su etiqueta). */
export const maxDetalle = (motivo: string) => (motivo === "Tráfico" ? MAX_MOTIVO - 10 : MAX_MOTIVO);

/** La detención de un motivo guardado ("Avería", "Tráfico · obras en la vía"), o null si es un
 *  descanso común. */
export function detencionDe(motivo: string | null | undefined): string | null {
  // Sin tildes ni mayúsculas, y la etiqueta como palabra: "Averia", "AVERÍA" y "Avería del
  // radiador" cuentan; "Averiguar" no.
  const m = (motivo ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
  return (
    DETENCIONES.find((d) => {
      const e = d
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
      return m === e || (m.startsWith(e) && !/[a-z0-9]/.test(m.charAt(e.length)));
    }) ?? null
  );
}

/** Lo que dice el viaje mientras hay un descanso abierto con ese motivo. */
export function textoDetenido(motivo: string | null | undefined): string {
  const d = detencionDe(motivo);
  if (!d) return "Descansando";
  return d === "Avería" ? "En avería" : `Detenido por ${d.toLowerCase()}`;
}

/** Lo que escribió quien marcó el descanso ("obras en la vía" de "Tráfico · obras en la vía"). */
export function detalleDe(motivo: string | null | undefined): string | null {
  const partes = (motivo ?? "").split(" · ");
  return partes.length > 1 ? partes.slice(1).join(" · ") : null;
}
