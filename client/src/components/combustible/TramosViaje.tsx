// El consumo de cada tramo de un viaje con paradas (A → B, B → A...): cuánto recorrió y cuánto
// cargó entre una llegada y la siguiente. Un viaje de un solo tramo ya lo dicen los números de arriba.
import { diaHora, fmt } from "./viajesFormato";

export interface TramoDelViaje {
  orden: number;
  de: string;
  a: string;
  salida_en: string | null;
  llegada_en: string | null;
  recorrido: number | null;
  combustible_gal: number;
  urea_l: number;
  /** Lo que suele tardar el tramo en marcha, por tipo de unidad; null si hay poco historial. */
  esperado_min?: number | null;
  esperado_viajes?: number;
  esperado_base?: "tipo" | "todas" | null;
}

export function TramosViaje({ tramos, medidor }: { tramos: TramoDelViaje[]; medidor: string }) {
  if (tramos.length < 2) return null;
  return (
    <div className="rounded-2xl bg-[#192526] border border-[#2a2e37] p-4 space-y-2">
      <p className="text-xs uppercase tracking-widest text-[#94a3b8]">Consumo por tramo</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[520px]">
          <thead className="text-xs uppercase text-[#94a3b8]">
            <tr className="text-left">
              <th className="py-1 pr-3 font-semibold">Tramo</th>
              <th className="py-1 pr-3 font-semibold">Salida</th>
              <th className="py-1 pr-3 font-semibold">Llegada</th>
              <th className="py-1 pr-3 font-semibold text-right">{medidor}</th>
              <th className="py-1 pr-3 font-semibold text-right">Combustible</th>
              <th className="py-1 font-semibold text-right">Urea</th>
            </tr>
          </thead>
          <tbody>
            {tramos.map((t) => (
              <tr key={t.orden} className="border-t border-[#2a2e37] text-white">
                <td className="py-2 pr-3">
                  {t.de} → {t.a}
                </td>
                <td className="py-2 pr-3 text-[#94a3b8]">
                  {t.salida_en ? diaHora(t.salida_en) : "—"}
                </td>
                <td className="py-2 pr-3 text-[#94a3b8]">
                  {t.llegada_en ? diaHora(t.llegada_en) : "en ruta"}
                </td>
                <td className="py-2 pr-3 text-right font-mono">
                  {t.recorrido === null ? "—" : fmt(t.recorrido, 1)}
                </td>
                <td className="py-2 pr-3 text-right font-mono">{fmt(t.combustible_gal, 1)} gal</td>
                <td className="py-2 text-right font-mono">{fmt(t.urea_l, 1)} L</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-[#94a3b8]">
        Una carga cuenta para el tramo que termina después de ella.
      </p>
    </div>
  );
}
