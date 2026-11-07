// «Quién maneja» cuando el relevo NO tiene cuenta (0180): un solo botón que deja constancia, con la hora,
// de que ahora maneja el relevo o de que el conductor vuelve a manejar. Solo historial, como un descanso
// o un odómetro: no cambia turnos, cola ni mando. Sin señal queda en la cola y se envía solo.
import { useState } from "react";

import { rutaDeViaje } from "./creacionPendiente";
import { apiFetch } from "../../services/apiClient";

type Quien = "titular" | "relevo";
type Marca = { quien: Quien; en: string; origen_hora?: string };

const BTN =
  "w-full flex items-center justify-center gap-2 border border-[#BADC1E] text-[#BADC1E] font-bold py-3 rounded-2xl hover:bg-[#17261c] disabled:opacity-50";

export function QuienManejaSinCuenta({
  viajeId,
  relevoNombre,
  manejo,
  onLocal,
  onAviso,
  onRecargar,
}: {
  viajeId: string;
  relevoNombre: string;
  manejo: Marca[];
  /** Sin señal: cómo queda la lista en este celular mientras la marca espera en la cola. */
  onLocal: (manejo: Marca[]) => void;
  onAviso: (texto: string | null) => void;
  onRecargar: () => Promise<void>;
}) {
  const [guardando, setGuardando] = useState(false);
  const ahora: Quien = manejo[manejo.length - 1]?.quien ?? "titular";
  const siguiente: Quien = ahora === "titular" ? "relevo" : "titular";

  const marcar = async () => {
    if (guardando) return;
    const marcadoEn = new Date().toISOString();
    setGuardando(true);
    onAviso(null);
    try {
      const res = await apiFetch(`/api/erp/viajes/${rutaDeViaje(viajeId)}/maneja-mio`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quien: siguiente,
          marcado_en: marcadoEn,
          cliente_uuid: crypto.randomUUID(),
        }),
      });
      const r = await res.json().catch(() => ({}));
      if (res.status === 202) {
        onLocal([...manejo, { quien: siguiente, en: marcadoEn, origen_hora: "dispositivo" }]);
        onAviso("Sin señal: quedó guardado en el celular y se enviará solo al volver la señal.");
        return;
      }
      if (!res.ok) {
        onAviso(r.error || r.message || r.errors?.[0]?.message || "No se pudo guardar.");
        if (res.status === 409) await onRecargar();
        return;
      }
      onAviso(
        siguiente === "relevo" ? `Anotado: maneja ${relevoNombre}.` : "Anotado: vuelves a manejar."
      );
      await onRecargar();
    } finally {
      setGuardando(false);
    }
  };

  return (
    <div className="rounded-2xl border border-[#334155] bg-[#14201f] p-4 space-y-3">
      <p className="text-sm text-[#94a3b8]">
        Va al volante: <b className="text-white">{ahora === "titular" ? "tú" : relevoNombre}</b>
      </p>
      <button type="button" className={BTN} disabled={guardando} onClick={() => void marcar()}>
        {siguiente === "relevo" ? `Ahora maneja ${relevoNombre}` : "Vuelvo a manejar yo"}
      </button>
    </div>
  );
}
