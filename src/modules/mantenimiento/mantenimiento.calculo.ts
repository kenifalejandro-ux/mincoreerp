/** src/modules/mantenimiento/mantenimiento.calculo.ts
 *
 * El cálculo del preventivo (M9), sin base de datos: qué nivel toca, a qué lectura y cuánto falta. */

export type EstadoPreventivo = "vencido" | "proximo" | "al_dia" | "sin_datos";

export interface ServicioPrevio {
  nivel: number;
  paso: number;
  lectura: number;
}

export interface ReglaDelPlan {
  intervalo: number;
  aviso_antes: number;
  ciclo: number[];
}

/** La posición del ciclo que toca después del último servicio. Si el plan cambió y la posición guardada ya no
 *  es de ese nivel, se toma la primera del nivel; si el nivel salió del ciclo, se empieza de nuevo. */
export function pasoSiguiente(ciclo: number[], ultimo: { nivel: number; paso: number } | null) {
  if (!ultimo) return 0;
  const hecho = ciclo[ultimo.paso] === ultimo.nivel ? ultimo.paso : ciclo.indexOf(ultimo.nivel);
  return (hecho + 1) % ciclo.length;
}

/** La posición que le corresponde a un nivel que se acaba de hacer: la primera de ese nivel desde la que
 *  tocaba, dando la vuelta. null si el plan no usa ese nivel. */
export function pasoDelNivel(ciclo: number[], desde: number, nivel: number) {
  for (let i = 0; i < ciclo.length; i++) {
    const paso = (desde + i) % ciclo.length;
    if (ciclo[paso] === nivel) return paso;
  }
  return null;
}

const dosDecimales = (n: number) => Math.round(n * 100) / 100;

/** El próximo servicio. Sin un servicio previo no hay desde dónde contar. */
export function calcularProximo(
  plan: ReglaDelPlan,
  ultimo: ServicioPrevio | null,
  lecturaActual: number
) {
  if (!ultimo) return null;
  const paso = pasoSiguiente(plan.ciclo, ultimo);
  const enLectura = dosDecimales(ultimo.lectura + plan.intervalo);
  // El medidor no retrocede: lo que marcaba al hacer el servicio también es una lectura.
  const faltan = dosDecimales(enLectura - Math.max(lecturaActual, ultimo.lectura));
  const estado: EstadoPreventivo =
    faltan <= 0 ? "vencido" : faltan <= plan.aviso_antes ? "proximo" : "al_dia";
  return { paso, nivel: plan.ciclo[paso], en_lectura: enLectura, faltan, estado };
}

/** Equipos no vencidos entre los que tienen plan y datos, en porcentaje; null si no hay ninguno. */
export function cumplimiento(estados: EstadoPreventivo[]) {
  const conDatos = estados.filter((e) => e !== "sin_datos");
  if (conDatos.length === 0) return null;
  const aTiempo = conDatos.filter((e) => e !== "vencido").length;
  // Hacia abajo: con un vencido nunca se muestra 100 %.
  return Math.floor((aTiempo * 100) / conDatos.length);
}
