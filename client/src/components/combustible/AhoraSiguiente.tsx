// Mi viaje: una línea arriba con lo que le toca al conductor ahora y lo que sigue.
import type { AhoraSiguiente } from "./paradasViaje";

export function LineaAhoraSiguiente({ ahora, luego }: AhoraSiguiente) {
  return (
    <div
      data-testid="ahora-siguiente"
      role="status"
      className="rounded-xl bg-[#BADC1E]/10 border border-[#BADC1E]/30 px-4 py-3 text-sm"
    >
      <span className="font-bold text-[#BADC1E]">Ahora: </span>
      <span className="font-semibold text-white">{ahora}</span>
      {luego && <span className="text-[#94a3b8]"> · luego {luego}</span>}
    </div>
  );
}
