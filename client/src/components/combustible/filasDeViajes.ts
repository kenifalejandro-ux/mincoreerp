import {
  desfaseSalida,
  fechaHora,
  ruta,
  semaforoViaje,
  unidadLabel,
  type FilaViaje,
} from "./viajesFormato";

const NOMBRE_SEMAFORO = { verde: "Verde", ambar: "Ámbar", rojo: "Rojo" } as const;

/** Un texto escrito por una persona (nombre, lugar, motivo) que empieza con = + - @ se abriría como
 *  fórmula en algunas hojas de cálculo: se le antepone un apóstrofo para que se lea como texto. */
const aTexto = (t: string) => (/^[=+\-@\t\r]/.test(t) ? `'${t}` : t);

/** Las filas del Excel de la lista de viajes: lo mismo que se ve en pantalla (ya filtrado), con el
 *  desfase de salida y el semáforo escritos. `estadoDe` es el texto que muestra la lista. */
export function filasDeViajes(viajes: FilaViaje[], estadoDe: (v: FilaViaje) => string) {
  return viajes.map((v) => {
    const semaforo = semaforoViaje(v);
    return {
      Viaje: `V-${v.numero}`,
      Ruta: aTexto(ruta(v)),
      Unidad: aTexto(unidadLabel(v)),
      Conductor: aTexto(v.conductor_nombre ?? ""),
      Relevo: aTexto(v.relevo_nombre ?? ""),
      "Salida programada": fechaHora(v.salida_programada_en ?? null),
      Salida: fechaHora(v.inicio_en),
      "Desfase de salida": desfaseSalida(v)?.texto ?? "",
      Llegada: fechaHora(v.fin_en),
      Estado: estadoDe(v),
      Semáforo: semaforo ? NOMBRE_SEMAFORO[semaforo.nivel] : "",
      "Motivos del semáforo": aTexto(semaforo?.motivos.join(" · ") ?? ""),
      Cargas: Number(v.cargas ?? 0),
      "Combustible (gal)": Number(Number(v.cantidad ?? 0).toFixed(2)),
    };
  });
}
