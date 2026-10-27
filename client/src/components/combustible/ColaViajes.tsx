// Mi viaje: los viajes programados del conductor en el orden en que los va a hacer (por hora
// programada; sin hora, al final). Solo el primero se puede iniciar: el servidor rechaza el resto,
// y aquí se ve por qué y cuál espera a cuál.
import { Lock } from "lucide-react";

import { fechaHora, ruta, type FilaViaje } from "./viajesFormato";

export type ItemCola = Pick<
  FilaViaje,
  "id" | "numero" | "salida_programada_en" | "origen" | "destino" | "paradas"
> & { cola_posicion: number };

export function ColaViajes({ cola, hayEnCurso }: { cola: ItemCola[]; hayEnCurso: boolean }) {
  if (cola.length === 0) return null;
  const primero = cola[0];
  return (
    <div
      data-testid="cola-viajes"
      className="rounded-2xl bg-[#192526] border border-[#2a2e37] p-4 space-y-3"
    >
      <p className="text-xs uppercase tracking-widest text-[#94a3b8]">
        Mis viajes en cola · por hora programada
      </p>
      <ol role="list" className="space-y-2">
        {cola.map((f, i) => {
          // El lugar sale del orden de esta lista, no del número del servidor: tras iniciar o
          // cerrar un viaje sin señal ese número queda viejo y la lista se contradiría.
          const esPrimero = i === 0;
          return (
            <li
              key={f.id}
              className={`flex items-center gap-3 rounded-xl border p-3 ${
                esPrimero && !hayEnCurso
                  ? "border-[#BADC1E]/50 bg-[#BADC1E]/5"
                  : "border-[#334155] opacity-80"
              }`}
            >
              <span
                className={`w-7 h-7 shrink-0 rounded-full flex items-center justify-center text-sm font-bold ${
                  esPrimero ? "bg-[#BADC1E] text-[#0D1719]" : "bg-[#334155] text-[#cbd5e1]"
                }`}
              >
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-white break-words">
                  V-{f.numero} · {ruta(f)}
                </p>
                <p className="text-xs text-[#94a3b8]">
                  {f.salida_programada_en
                    ? fechaHora(f.salida_programada_en)
                    : "Sin hora programada"}
                </p>
              </div>
              <span className="shrink-0 inline-flex items-center gap-1 text-xs font-semibold text-[#cbd5e1]">
                {esPrimero ? (
                  hayEnCurso ? (
                    "Siguiente"
                  ) : (
                    <span className="text-[#BADC1E]">Primero</span>
                  )
                ) : (
                  <>
                    <Lock className="w-3 h-3" aria-hidden />
                    Espera al V-{primero.numero}
                  </>
                )}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
