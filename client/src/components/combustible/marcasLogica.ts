// La lógica pura de «Registrar llegada» y «Registrar salida» de la oficina: qué paradas se pueden
// marcar, qué está mal antes de mandar y el cuerpo de POST /viajes/:id/marcas. No hay orden de
// registro: solo se cuida que las horas no se crucen con las otras marcas ya puestas. Sin pantalla.
// El servidor valida lo mismo; esto avisa antes de guardar.
import { motivoGuardado } from "./motivosDescanso";
import type { ParadaMia } from "./paradasViaje";
import { deValorLocal } from "./ponerAlDiaLogica";

export type QueMarca = "llegada" | "salida";

/** Lo mismo que tolera el servidor entre el reloj de la PC y el suyo. */
const MARGEN_RELOJ_MS = 5 * 60 * 1000;

export interface DescansoEscrito {
  activo: boolean;
  motivo: string;
  detalle: string;
  desde: string;
  hasta: string;
}

export interface EntradaMarca {
  que: QueMarca;
  orden: number;
  momento: "ahora" | "antes";
  /** "AAAA-MM-DDTHH:mm" local; solo cuenta con «Fue antes». */
  horaLocal: string;
  motivo: string;
  reemplazar: boolean;
  medidor: string;
  descanso: DescansoEscrito;
}

export interface ParadaElegible {
  orden: number;
  texto: string;
  /** La hora de la marca si ya está puesta. */
  marcaEn: string | null;
}

/** Las paradas donde se puede marcar: la llegada no existe en el origen ni la salida en la última. */
export function paradasElegibles(paradas: ParadaMia[], que: QueMarca): ParadaElegible[] {
  const n = paradas.length;
  return paradas
    .filter((p) => (que === "llegada" ? p.orden >= 1 : p.orden <= n - 2))
    .map((p) => ({
      orden: p.orden,
      texto:
        p.orden === 0 ? `${p.lugar} · origen` : p.orden === n - 1 ? `${p.lugar} · final` : p.lugar,
      marcaEn: que === "llegada" ? p.llegada_en : p.salida_en,
    }));
}

/** La primera parada sin marca (o la primera si todas la tienen): lo que se elige de entrada. */
export function paradaInicial(paradas: ParadaMia[], que: QueMarca): number | null {
  const e = paradasElegibles(paradas, que);
  return (e.find((x) => !x.marcaEn) ?? e[0])?.orden ?? null;
}

/** El odómetro de llegada es obligatorio al cerrar un viaje que salió con él. */
export const pideMedidor = (paradas: ParadaMia[], e: EntradaMarca, medidorInicio: unknown) =>
  e.que === "llegada" &&
  e.orden === paradas.length - 1 &&
  !paradas[e.orden]?.llegada_en &&
  medidorInicio != null;

/** Las marcas del viaje en orden cronológico, con la hora (ms) de las que existen. */
function marcasEnOrden(paradas: ParadaMia[]) {
  return paradas.flatMap((p) => [
    { orden: p.orden, que: "llegada" as const, t: p.llegada_en ? Date.parse(p.llegada_en) : null },
    { orden: p.orden, que: "salida" as const, t: p.salida_en ? Date.parse(p.salida_en) : null },
  ]);
}

/** La hora que se va a guardar (ms): ahora, o la que se escribió; null si falta. */
export const horaDeMarca = (e: EntradaMarca, ahora: number): number | null =>
  e.momento === "ahora" ? ahora : deValorLocal(e.horaLocal);

/** Qué está mal antes de mandar, o null si se puede guardar. */
export function errorDeMarca(
  e: EntradaMarca,
  paradas: ParadaMia[],
  medidorInicio: unknown,
  ahora: number,
  etiquetaMedidor: string
): string | null {
  const parada = paradas[e.orden];
  if (!parada || !paradasElegibles(paradas, e.que).some((x) => x.orden === e.orden)) {
    return "Elige la parada.";
  }
  const existe = e.que === "llegada" ? parada.llegada_en : parada.salida_en;
  if (existe && !e.reemplazar) return "Esa marca ya está registrada: marca «Reemplazar».";
  const t = horaDeMarca(e, ahora);
  if (t === null) return "Escribe la fecha y la hora.";
  if (t > ahora + MARGEN_RELOJ_MS) return "La hora no puede ser futura.";

  const marcas = marcasEnOrden(paradas);
  const i = marcas.findIndex((m) => m.orden === e.orden && m.que === e.que);
  const previa = marcas
    .slice(0, i)
    .reverse()
    .find((m) => m.t !== null);
  const siguiente = marcas.slice(i + 1).find((m) => m.t !== null);
  if (previa && t <= (previa.t as number)) {
    return "La hora tiene que ser posterior a la marca anterior del viaje.";
  }
  if (siguiente && t >= (siguiente.t as number)) {
    return "La hora tiene que ser anterior a la marca siguiente del viaje.";
  }
  if ((e.momento === "antes" || existe) && e.motivo.trim().length < 3) {
    return "Elige o escribe el motivo.";
  }
  if (e.medidor.trim() !== "") {
    const m = Number(e.medidor);
    if (!Number.isFinite(m) || m < 0) return `${etiquetaMedidor}: escribe un número válido.`;
  } else if (pideMedidor(paradas, e, medidorInicio)) {
    return `Falta el ${etiquetaMedidor.toLowerCase()} de llegada.`;
  }
  if (e.descanso.activo) {
    const d = e.descanso;
    if (!motivoGuardado(d.motivo, d.detalle)) return "Elige el motivo del descanso.";
    const desde = deValorLocal(d.desde);
    const hasta = deValorLocal(d.hasta);
    if (desde === null) return "Escribe cuándo empezó el descanso.";
    if (d.hasta && hasta === null) return "La hora de fin del descanso no es válida.";
    if (hasta !== null && hasta <= desde)
      return "El fin del descanso tiene que ser después del inicio.";
    if ((hasta ?? desde) > t) return "El descanso tiene que ser anterior a la marca.";
  }
  return null;
}

/** El cuerpo de POST /viajes/:id/marcas. Sin «Fue antes» no se manda hora: pone la del servidor. */
export function cuerpoDeMarca(e: EntradaMarca, clienteUuid: string) {
  const t = e.momento === "antes" ? deValorLocal(e.horaLocal) : null;
  const d = e.descanso;
  const desde = deValorLocal(d.desde);
  const hasta = deValorLocal(d.hasta);
  const motivo = e.motivo.trim();
  return {
    que: e.que,
    orden: e.orden,
    ...(t !== null ? { hora: new Date(t).toISOString() } : {}),
    ...(e.medidor.trim() !== "" ? { medidor: Number(e.medidor) } : {}),
    ...(e.reemplazar ? { reemplazar: true } : {}),
    ...(motivo ? { motivo } : {}),
    cliente_uuid: clienteUuid,
    ...(d.activo && desde !== null
      ? {
          descanso: {
            motivo: motivoGuardado(d.motivo, d.detalle),
            desde: new Date(desde).toISOString(),
            ...(hasta !== null ? { hasta: new Date(hasta).toISOString() } : {}),
          },
        }
      : {}),
  };
}
