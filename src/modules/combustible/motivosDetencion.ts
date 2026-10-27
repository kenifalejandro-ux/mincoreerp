// Qué descansos de un viaje son DETENCIONES (avería, accidente, huaico, bloqueo, tráfico) y no un
// descanso común (dormir, comer). El mismo criterio que usa la pantalla (motivosDescanso.ts en el
// cliente): sin tildes ni mayúsculas, y la etiqueta como palabra ("Averia", "AVERÍA" y "Avería
// del radiador" cuentan; "Averiguar" no).

const DETENCIONES = ["Avería", "Accidente", "Huaico", "Bloqueo", "Tráfico"];

const normalizar = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/** La detención de un motivo guardado ("Avería", "Tráfico · obras en la vía"), o null si es un
 *  descanso común. */
export function detencionDe(motivo: string | null | undefined): string | null {
  const m = normalizar(motivo ?? "");
  return (
    DETENCIONES.find((d) => {
      const e = normalizar(d);
      return m === e || (m.startsWith(e) && !/[a-z0-9]/.test(m.charAt(e.length)));
    }) ?? null
  );
}
