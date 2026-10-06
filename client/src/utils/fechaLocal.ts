/** client/src/utils/fechaLocal.ts
 *
 * Formato que espera un <input type="datetime-local">: sin zona horaria,
 * con la hora LOCAL del dispositivo (no UTC) -- así "ahora" en el input
 * coincide con el reloj real del operario en campo. Compartido entre
 * cualquier formulario que registre un evento con fecha/hora editable
 * (Combustible, Repuestos) -- antes vivía duplicado en CombustiblePanel.tsx.
 */
export function ahoraParaInputLocal(): string {
  return paraInputLocal(new Date());
}

export function paraInputLocal(fecha: Date | string): string {
  const d = new Date(fecha);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}
