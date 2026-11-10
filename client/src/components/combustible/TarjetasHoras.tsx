// Las horas del viaje separadas: manejando entre paradas y quieto en el destino (la estadía).
// En una ruta A → B → A: Ida / Estadía / Vuelta / Total; en otra: En ruta / En paradas / Total.
import type { HorasDelViaje } from "./horasViaje";
import { duracion } from "./viajesFormato";

function Cifra({ titulo, min, fuerte }: { titulo: string; min: number | null; fuerte?: boolean }) {
  return (
    <div className="rounded-xl bg-[#0D1719] border border-[#2a2e37] p-3">
      <p className="text-[11px] uppercase tracking-widest text-[#94a3b8]">{titulo}</p>
      <p
        className={`font-mono font-bold leading-tight ${fuerte ? "text-xl text-[#BADC1E]" : "text-lg text-white"}`}
      >
        {min === null ? "—" : duracion(min)}
      </p>
    </div>
  );
}

export function TarjetasHoras({ horas }: { horas: HorasDelViaje | null }) {
  if (!horas) return null;
  return (
    <div className="rounded-2xl bg-[#192526] border border-[#2a2e37] p-4 space-y-2">
      <p className="text-xs uppercase tracking-widest text-[#94a3b8]">Horas del viaje</p>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {horas.idaYVuelta ? (
          <>
            <Cifra titulo="Ida" min={horas.ida} />
            <Cifra titulo="Estadía" min={horas.estadia} />
            <Cifra titulo="Vuelta" min={horas.vuelta} />
          </>
        ) : (
          <>
            <Cifra titulo="En ruta" min={horas.enRuta} />
            <Cifra titulo="En paradas" min={horas.enParadas} />
          </>
        )}
        <Cifra titulo="Total" min={horas.total} fuerte />
      </div>
    </div>
  );
}
