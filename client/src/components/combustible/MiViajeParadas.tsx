// "Mi viaje" con el viaje en curso: las paradas y UN botón grande que cambia según dónde va
// (Llegué a B, Salir hacia A, Llegué a A · terminar viaje). Cada marca pide el medidor y se
// guarda sin señal si hace falta; el servidor rechaza la que ya no corresponde.
import { Flag, MapPin, Play } from "lucide-react";
import { useState } from "react";

import { ParadasViaje } from "./ParadasViaje";
import { conMarcaLocal, proximaMarca, type ParadaMia } from "./paradasViaje";
import { apiFetch } from "../../services/apiClient";

const BTN_LIMA =
  "w-full flex items-center justify-center gap-2 bg-[#BADC1E] text-[#0D1719] font-extrabold text-lg py-4 rounded-2xl hover:brightness-110 disabled:opacity-50";
const BTN_SECUNDARIO =
  "w-full flex items-center justify-center gap-2 border border-[#334155] text-[#cbd5e1] font-semibold py-3 rounded-2xl hover:text-white";
const INPUT =
  "w-full bg-[#0D1719] border border-[#334155] rounded-xl px-4 py-4 text-2xl font-mono text-white text-center";

export interface CambiosLocales {
  paradas: ParadaMia[];
  estado?: "cerrado";
  fin_en?: string;
  medidor_fin?: string | null;
}

interface Props {
  viajeId: string;
  paradas: ParadaMia[];
  conMedidor: boolean;
  etiquetaMedidor: string;
  unidadMedidor: string;
  /** Sin señal: cómo queda el viaje en este celular mientras la marca espera en la cola. */
  onLocal: (cambios: CambiosLocales) => void;
  onAviso: (texto: string | null) => void;
  onRecargar: () => Promise<void>;
}

export function MiViajeParadas({
  viajeId,
  paradas,
  conMedidor,
  etiquetaMedidor,
  unidadMedidor,
  onLocal,
  onAviso,
  onRecargar,
}: Props) {
  const marca = proximaMarca(paradas);
  const [abierto, setAbierto] = useState(false);
  // Salir de una parada suele ser la misma lectura con la que se llegó.
  const [medidor, setMedidor] = useState(() =>
    marca?.accion === "salida-mia" && marca.minimo !== null ? String(marca.minimo) : ""
  );
  const [guardando, setGuardando] = useState(false);

  const enviar = async () => {
    if (guardando || !marca) return;
    const lectura = medidor.trim() === "" ? null : Number(medidor);
    if (conMedidor && lectura === null) {
      onAviso(`Escribe el ${etiquetaMedidor} que marca el tablero.`);
      return;
    }
    if (lectura !== null && marca.minimo !== null && lectura < marca.minimo) {
      onAviso(`Es menor que la última lectura del viaje: revisa el ${etiquetaMedidor}.`);
      return;
    }
    const marcadoEn = new Date().toISOString();
    setGuardando(true);
    onAviso(null);
    try {
      const res = await apiFetch(`/api/erp/combustible/viajes/${viajeId}/${marca.accion}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          medidor: lectura,
          orden: marca.orden,
          marcado_en: marcadoEn,
          cliente_uuid: crypto.randomUUID(),
        }),
      });
      const r = await res.json().catch(() => ({}));
      if (res.status === 202) {
        onLocal({
          paradas: conMarcaLocal(paradas, marca, marcadoEn, lectura),
          ...(marca.cierra
            ? {
                estado: "cerrado" as const,
                fin_en: marcadoEn,
                medidor_fin: lectura === null ? null : String(lectura),
              }
            : {}),
        });
        onAviso("Sin señal: quedó guardado en el celular y se enviará solo al volver la señal.");
        return;
      }
      if (!res.ok) {
        onAviso(r.error || r.message || r.errors?.[0]?.message || "No se pudo guardar.");
        // Un 409 es que el viaje ya avanzó (otro celular o la oficina): se muestra cómo está.
        if (res.status === 409) await onRecargar();
        return;
      }
      onAviso(
        marca.cierra
          ? "Viaje terminado."
          : marca.accion === "llegada-mia"
            ? "Llegada registrada."
            : "Salida registrada. ¡Buen viaje!"
      );
      await onRecargar();
    } finally {
      setGuardando(false);
    }
  };

  return (
    <div className="space-y-4">
      <ParadasViaje paradas={paradas} />

      {marca && !abierto && (
        <button className={BTN_LIMA} onClick={() => setAbierto(true)}>
          {marca.cierra ? (
            <Flag className="w-6 h-6" />
          ) : marca.accion === "llegada-mia" ? (
            <MapPin className="w-6 h-6" />
          ) : (
            <Play className="w-6 h-6" />
          )}{" "}
          {marca.texto}
        </button>
      )}

      {marca && abierto && (
        <div className="space-y-3">
          {conMedidor && (
            <>
              <label className="block text-sm text-[#cbd5e1]" htmlFor="mi-viaje-parada-medidor">
                {etiquetaMedidor} que marca el tablero
              </label>
              <input
                id="mi-viaje-parada-medidor"
                type="number"
                inputMode="decimal"
                min={marca.minimo ?? 0}
                step="0.1"
                autoFocus
                value={medidor}
                onChange={(e) => setMedidor(e.target.value)}
                className={INPUT}
              />
              {marca.minimo !== null && (
                <p className="text-xs text-[#94a3b8]">
                  Última lectura del viaje: {marca.minimo} {unidadMedidor}
                </p>
              )}
            </>
          )}
          <button className={BTN_LIMA} disabled={guardando} onClick={() => void enviar()}>
            {guardando ? "Guardando..." : marca.texto}
          </button>
          <button className={BTN_SECUNDARIO} onClick={() => setAbierto(false)}>
            Volver
          </button>
        </div>
      )}
    </div>
  );
}
