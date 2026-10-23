// El recorrido del viaje en el celular del conductor: por dónde pasó, dónde está y qué sigue.
import { CheckCircle2, Circle, MapPin } from "lucide-react";

import { posicion, type ParadaMia } from "./paradasViaje";

const hora = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" }) : "";

export function ParadasViaje({ paradas }: { paradas: ParadaMia[] }) {
  const pos = posicion(paradas);
  return (
    <ol className="space-y-3" aria-label="Paradas del viaje">
      {paradas.map((p, i) => {
        const hecha = i === 0 ? Boolean(p.salida_en) : Boolean(p.llegada_en);
        const aqui = pos.tipo === "en_parada" && pos.en === i;
        const sigue = pos.tipo === "en_marcha" && pos.hacia === i;
        const ultima = i === paradas.length - 1;
        const nota = aqui
          ? "Estás aquí"
          : sigue
            ? ultima
              ? "Próxima parada · llegada final"
              : "Próxima parada"
            : ultima
              ? "Llegada final"
              : i === 0
                ? "Salida"
                : "";
        return (
          <li key={p.orden} className="flex items-start gap-3">
            {hecha ? (
              <CheckCircle2 className="w-5 h-5 text-[#BADC1E] shrink-0" aria-hidden />
            ) : sigue ? (
              <MapPin className="w-5 h-5 text-[#BADC1E] shrink-0" aria-hidden />
            ) : (
              <Circle className="w-5 h-5 text-[#334155] shrink-0" aria-hidden />
            )}
            <div className="flex-1">
              <p className={hecha || sigue ? "font-semibold text-white" : "text-[#94a3b8]"}>
                {p.lugar}
              </p>
              {nota && <p className="text-xs text-[#94a3b8]">{nota}</p>}
            </div>
            <span className="font-mono text-xs text-[#94a3b8]">
              {hora(i === 0 ? p.salida_en : p.llegada_en)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
