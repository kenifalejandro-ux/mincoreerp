// "Quién manejó" (0152/0153): los turnos de un viaje con relevo, uno tras otro. Cada conductor ve
// aquí solo lo que manejó él; la oficina ve el viaje entero. Es un registro del viaje, no un
// ranking: no se compara a un conductor con otro.
import type { EntregaPendiente, TurnoViaje } from "./paradasViaje";
import { diaHora, duracion, fmt } from "./viajesFormato";

const aNumero = (x: string | number | null) => (x == null ? null : Number(x));

export function QuienManejo({
  turnos,
  entrega,
  medidor,
  ahora,
}: {
  turnos: TurnoViaje[];
  entrega?: EntregaPendiente | null;
  medidor: string;
  /** El reloj de la pantalla: el turno abierto cuenta hasta este momento. */
  ahora: number;
}) {
  // Con un solo conductor no hay nada que repartir: lo dicen los números de arriba.
  if (turnos.length < 2 && !entrega) return null;
  return (
    <div className="rounded-2xl bg-[#192526] border border-[#2a2e37] p-4 space-y-2">
      <p className="text-xs uppercase tracking-widest text-[#94a3b8]">Quién manejó</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[480px]">
          <thead className="text-xs uppercase text-[#94a3b8]">
            <tr className="text-left">
              <th className="py-1 pr-3 font-semibold">Conductor</th>
              <th className="py-1 pr-3 font-semibold">Desde</th>
              <th className="py-1 pr-3 font-semibold">Hasta</th>
              <th className="py-1 pr-3 font-semibold text-right">Al volante</th>
              <th className="py-1 font-semibold text-right">{medidor}</th>
            </tr>
          </thead>
          <tbody>
            {turnos.map((t) => {
              const ini = aNumero(t.medidor_inicio);
              const fin = aNumero(t.medidor_fin);
              const min = (t.fin_en ? Date.parse(t.fin_en) : ahora) - Date.parse(t.inicio_en);
              return (
                <tr key={t.inicio_en} className="border-t border-[#2a2e37] text-white">
                  <td className="py-2 pr-3">
                    {t.conductor_nombre ?? `DNI ${t.conductor_dni}`}
                    {t.lugar && <span className="block text-xs text-[#94a3b8]">{t.lugar}</span>}
                    {t.corregido && (
                      <span className="block text-xs text-amber-300">
                        Cambio corregido por la oficina: {t.corregido_motivo}
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-[#94a3b8]">{diaHora(t.inicio_en)}</td>
                  <td className="py-2 pr-3 text-[#94a3b8]">
                    {t.fin_en ? diaHora(t.fin_en) : "al volante"}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono">{duracion(min / 60_000)}</td>
                  <td className="py-2 text-right font-mono">
                    {ini !== null && fin !== null ? fmt(fin - ini, 1) : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {entrega && (
        <p className="text-xs text-sky-300">
          {entrega.de_nombre ?? "El conductor"} entregó el mando a {entrega.a_nombre ?? "su relevo"}
          : espera que lo acepte.
        </p>
      )}
    </div>
  );
}
