// "Mi viaje" › Historial: los viajes cerrados del conductor, con lo suyo (recorrido, horas, lo
// descansado y lo que recorrió). Solo ve los suyos. Sin señal muestra la última página que vio.
import { CloudOff } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { diaHora, duracion, fmt } from "./viajesFormato";
import { apiFetch } from "../../services/apiClient";

interface FilaHistorial {
  id: string;
  numero: number;
  paradas: string[] | null;
  inicio_en: string;
  fin_en: string;
  recorrido: string | null;
  tipo_medidor: "horometro" | "odometro" | null;
  descanso_min: string | number;
  /** Los minutos que manejó él (si compartió el volante, solo los suyos). */
  parte_min?: string | number | null;
}

interface Pagina {
  data: FilaHistorial[];
  siguiente: string | null;
}

const claveCache = (usuarioId: string) => `mi-historial:${usuarioId}`;

function leerCache(usuarioId: string): Pagina | null {
  try {
    const crudo = localStorage.getItem(claveCache(usuarioId));
    return crudo ? (JSON.parse(crudo) as Pagina) : null;
  } catch {
    return null;
  }
}

export function HistorialConductor({ usuarioId }: { usuarioId: string }) {
  const [filas, setFilas] = useState<FilaHistorial[]>([]);
  const [siguiente, setSiguiente] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);
  const [sinSenal, setSinSenal] = useState(false);

  const cargar = useCallback(
    async (antes?: string) => {
      setCargando(true);
      try {
        const q = new URLSearchParams({ limite: "20" });
        if (antes) q.set("antes", antes);
        const res = await apiFetch(`/api/erp/combustible/viajes/mios/historial?${q}`);
        const body = (await res.json().catch(() => null)) as Pagina | null;
        if (!res.ok || !body) throw new Error("error");
        setSinSenal(false);
        setSiguiente(body.siguiente);
        setFilas((previas) => (antes ? [...previas, ...body.data] : body.data));
        if (!antes) {
          try {
            localStorage.setItem(claveCache(usuarioId), JSON.stringify(body));
          } catch {
            // Sin almacenamiento: solo se pierde la vista sin señal.
          }
        }
      } catch {
        // Sin señal: la primera página que se vio la última vez.
        const cache = leerCache(usuarioId);
        if (cache && !antes) {
          setFilas(cache.data);
          setSiguiente(cache.siguiente);
        }
        setSinSenal(true);
      } finally {
        setCargando(false);
      }
    },
    [usuarioId]
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void cargar();
  }, [cargar]);

  return (
    <div className="space-y-3">
      {sinSenal && (
        <div className="flex items-center gap-2 rounded-xl bg-amber-500/10 border border-amber-500/30 p-3 text-sm text-amber-200">
          <CloudOff className="w-5 h-5 shrink-0" /> Sin señal: ves lo último guardado en el celular.
        </div>
      )}
      {!cargando && filas.length === 0 && (
        <div className="rounded-2xl bg-[#192526] border border-[#2a2e37] p-6 text-center">
          <p className="font-bold text-white">Todavía no tienes viajes cerrados.</p>
          <p className="text-sm text-[#94a3b8]">Cuando termines uno, aparece aquí.</p>
        </div>
      )}
      {filas.map((f) => {
        const total =
          f.parte_min != null
            ? Number(f.parte_min)
            : (Date.parse(f.fin_en) - Date.parse(f.inicio_en)) / 60_000;
        const descanso = Number(f.descanso_min);
        return (
          <article key={f.id} className="rounded-2xl bg-[#192526] border border-[#2a2e37] p-4">
            <div className="flex justify-between gap-3">
              <p className="font-bold text-white">{(f.paradas ?? []).join(" → ")}</p>
              <span className="font-mono text-xs text-[#94a3b8]">V-{f.numero}</span>
            </div>
            <p className="text-sm text-[#94a3b8]">
              {diaHora(f.inicio_en)} a {diaHora(f.fin_en)}
            </p>
            <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm text-[#94a3b8]">
              <div>
                En marcha <b className="font-mono text-white">{duracion(total - descanso)}</b>
              </div>
              {descanso > 0 && (
                <div>
                  Descansos <b className="font-mono text-white">{duracion(descanso)}</b>
                </div>
              )}
              {f.recorrido !== null && (
                <div>
                  <b className="font-mono text-white">{fmt(Number(f.recorrido), 1)}</b>{" "}
                  {f.tipo_medidor === "horometro" ? "h" : "km"}
                </div>
              )}
            </dl>
          </article>
        );
      })}
      {siguiente && (
        <button
          disabled={cargando}
          onClick={() => void cargar(siguiente)}
          className="w-full border border-[#334155] text-[#cbd5e1] font-semibold py-3 rounded-2xl hover:text-white disabled:opacity-50"
        >
          {cargando ? "Cargando..." : "Ver más"}
        </button>
      )}
    </div>
  );
}
