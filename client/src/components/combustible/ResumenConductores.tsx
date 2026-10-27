// Viajes › Resumen por conductor: de los viajes cerrados del período (los filtros de Salida desde y
// Hasta), lo que cada conductor manejó, qué tan puntual sale y cuánto consume frente a su ruta. Los
// números los calcula el servidor y no cambian con la unidad ni el estado que se filtren.
import { useEffect, useState } from "react";

import { duracion, fmt } from "./viajesFormato";
import { apiFetch } from "../../services/apiClient";

interface Fila {
  dni: string;
  nombre: string;
  viajes: number;
  km: number;
  minutos_al_volante: number;
  salidas_medidas: number;
  salidas_puntuales: number;
  consumo_viajes: number;
  consumo_desvio_pct: number | null;
}

export function ResumenConductores({ desde, hasta }: { desde: string; hasta: string }) {
  const [abierto, setAbierto] = useState(false);
  const [filas, setFilas] = useState<Fila[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!abierto) return;
    let vigente = true;
    void (async () => {
      try {
        const q = new URLSearchParams();
        if (desde) q.set("desde", new Date(`${desde}T00:00:00`).toISOString());
        if (hasta) q.set("hasta", new Date(`${hasta}T23:59:59`).toISOString());
        const res = await apiFetch(`/api/erp/combustible/viajes/resumen-conductores?${q}`);
        const body = await res.json().catch(() => null);
        if (!vigente) return;
        if (!res.ok) {
          setFilas([]);
          setError(body?.error ?? body?.message ?? "No se pudo cargar el resumen.");
          return;
        }
        setError(null);
        setFilas(Array.isArray(body?.data) ? body.data : []);
      } catch {
        // Sin red, o una fecha a medio escribir: se dice y no se deja la tabla anterior.
        if (!vigente) return;
        setFilas([]);
        setError("No se pudo cargar el resumen.");
      }
    })();
    return () => {
      vigente = false;
    };
  }, [abierto, desde, hasta]);

  return (
    <details
      data-testid="resumen-conductores"
      className="bg-[#192526] border border-[#2a2e37] rounded-lg"
      onToggle={(e) => setAbierto(e.currentTarget.open)}
    >
      <summary className="cursor-pointer select-none p-3 text-sm font-semibold text-[#e2e8f0]">
        Resumen por conductor
        <span className="ml-2 text-xs font-normal text-[#94a3b8]">viajes cerrados del período</span>
      </summary>
      <div className="overflow-x-auto px-3 pb-3">
        {error && <p className="text-sm text-red-400">{error}</p>}
        {!error && filas === null && <p className="text-sm text-[#94a3b8]">Cargando...</p>}
        {!error && filas !== null && filas.length === 0 && (
          <p className="text-sm text-[#94a3b8]">No hay viajes cerrados en este período.</p>
        )}
        {filas !== null && filas.length > 0 && (
          <table className="w-full text-sm text-[#e2e8f0]">
            <thead>
              <tr className="text-left text-[11px] uppercase text-[#94a3b8]">
                <th className="py-2 pr-3">Conductor</th>
                <th className="py-2 pr-3 text-right">Viajes</th>
                <th className="py-2 pr-3 text-right">Km</th>
                <th className="py-2 pr-3 text-right">Al volante</th>
                <th className="py-2 pr-3 text-right">Salió a tiempo</th>
                <th className="py-2 text-right">Consumo vs. ruta</th>
              </tr>
            </thead>
            <tbody>
              {filas.map((f) => (
                <tr key={f.dni} className="border-t border-[#2a2e37]">
                  <td className="py-2 pr-3">{f.nombre}</td>
                  <td className="py-2 pr-3 text-right font-mono">{f.viajes}</td>
                  <td className="py-2 pr-3 text-right font-mono">{fmt(f.km, 1)}</td>
                  <td className="py-2 pr-3 text-right font-mono">
                    {f.minutos_al_volante ? duracion(f.minutos_al_volante) : "—"}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono">
                    {f.salidas_medidas
                      ? `${f.salidas_puntuales} de ${f.salidas_medidas} (${fmt((f.salidas_puntuales / f.salidas_medidas) * 100, 0)} %)`
                      : "—"}
                  </td>
                  <td className="py-2 text-right font-mono">
                    {f.consumo_desvio_pct === null ? (
                      <span className="text-slate-400">—</span>
                    ) : (
                      <span
                        title={`Promedio de ${f.consumo_viajes} viaje${f.consumo_viajes === 1 ? "" : "s"} que inició, frente al promedio de su ruta en este período`}
                        className={
                          f.consumo_desvio_pct > 20
                            ? "text-red-400 font-bold"
                            : f.consumo_desvio_pct < 0
                              ? "text-emerald-400"
                              : ""
                        }
                      >
                        {f.consumo_desvio_pct > 0 ? "+" : ""}
                        {fmt(f.consumo_desvio_pct, 0)} %
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="pt-2 text-[11px] text-[#64748b]">
          Los kilómetros y las horas son de lo que manejó, con sus descansos (con relevo, cada uno
          la suya). La puntualidad y el consumo cuentan los viajes que inició; el consumo se compara
          con el promedio de la ruta en este período, y solo sirve con varios conductores.
        </p>
      </div>
    </details>
  );
}
