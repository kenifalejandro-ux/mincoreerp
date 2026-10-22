// Asignar la tanqueta a la unidad que la lleva (migración 0139).
// Una unidad lleva hasta 3; el servidor lo hace cumplir y su mensaje se muestra
// tal cual. Al elegir la unidad se pide el vale de esa salida (0141): serie del
// talonario y N° de vale. Para soltarla se registra su retorno (RecibirTanqueta).
import { X } from "lucide-react";
import { useEffect, useState } from "react";

import { apiFetch } from "../../services/apiClient";

interface UnidadOpcion {
  id: number;
  placa_codigo: string;
}

export interface TanquetaAsignable {
  id: string;
  codigo: string;
  saldo: string;
  equipo_asignado_id: number | null;
  asignada_vigente: boolean;
}

const HEADERS = { "Content-Type": "application/json" };

export default function AsignarTanqueta({
  tanqueta,
  onCerrar,
  onListo,
}: {
  tanqueta: TanquetaAsignable;
  onCerrar: () => void;
  onListo: () => void;
}) {
  const [unidades, setUnidades] = useState<UnidadOpcion[]>([]);
  const [equipoId, setEquipoId] = useState(
    tanqueta.asignada_vigente ? String(tanqueta.equipo_asignado_id) : ""
  );
  const [serie, setSerie] = useState("");
  const [vale, setVale] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let vigente = true;
    (async () => {
      const res = await apiFetch("/api/erp/combustible/equipos-destino?pageSize=200");
      const body = await res.json().catch(() => null);
      if (vigente && res.ok) setUnidades(Array.isArray(body?.data) ? body.data : []);
    })();
    return () => {
      vigente = false;
    };
  }, []);

  const valeCompleto = serie.trim() !== "" && Number(vale) > 0;

  const enviar = async (cuerpo: object) => {
    if (enviando) return;
    setEnviando(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/erp/combustible/tanquetas/${tanqueta.id}/asignar`, {
        method: "PUT",
        headers: HEADERS,
        body: JSON.stringify(cuerpo),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.message || body.error || body.errors?.[0]?.message || "No se pudo guardar.");
        return;
      }
      onListo();
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-[#0D1719]/90 backdrop-blur-sm flex justify-center items-center z-50 p-4">
      <div className="bg-white w-full max-w-md rounded-3xl shadow-2xl">
        <div className="p-6 border-b flex justify-between items-center">
          <h3 className="text-xl font-bold">Asignar {tanqueta.codigo}</h3>
          <button
            type="button"
            onClick={onCerrar}
            aria-label="Cerrar"
            className="text-slate-400 hover:text-slate-900"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-6 space-y-4">
          {tanqueta.asignada_vigente && (
            <p className="text-sm text-slate-700">
              Esta tanqueta ya va con una unidad. Para cambiarla, recíbela de vuelta primero y luego
              asígnala de nuevo.
            </p>
          )}
          <form
            hidden={tanqueta.asignada_vigente}
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (equipoId !== "" && valeCompleto) {
                void enviar({
                  equipo_id: Number(equipoId),
                  serie_talonario: serie.trim(),
                  n_vale: Number(vale),
                });
              }
            }}
          >
            <div className="space-y-1">
              <label
                htmlFor="asignar-unidad"
                className="text-xs font-bold text-slate-700 uppercase"
              >
                Unidad que la lleva
              </label>
              <select
                id="asignar-unidad"
                required
                className="w-full border border-slate-200 rounded-xl p-3 text-sm"
                value={equipoId}
                onChange={(e) => setEquipoId(e.target.value)}
              >
                <option value="">Elegir unidad</option>
                {unidades.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.placa_codigo}
                  </option>
                ))}
              </select>
              <p className="text-xs text-slate-600">
                Una unidad puede llevar hasta 3 tanquetas. El conductor carga primero la más
                antigua.
              </p>
            </div>
            {equipoId !== "" && (
              <p className="text-sm text-slate-700">
                El vale lleva <strong>{Number(tanqueta.saldo)} gal</strong>: lo que tiene la
                tanqueta ahora.
              </p>
            )}
            {equipoId !== "" && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label
                    htmlFor="asignar-serie"
                    className="text-xs font-bold text-slate-700 uppercase"
                  >
                    Serie del talonario
                  </label>
                  <input
                    id="asignar-serie"
                    required
                    maxLength={20}
                    className="w-full border border-slate-200 rounded-xl p-3 text-sm"
                    value={serie}
                    onChange={(e) => setSerie(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <label
                    htmlFor="asignar-vale"
                    className="text-xs font-bold text-slate-700 uppercase"
                  >
                    N° de vale
                  </label>
                  <input
                    id="asignar-vale"
                    type="number"
                    required
                    min={1}
                    step={1}
                    className="w-full border border-slate-200 rounded-xl p-3 text-sm"
                    value={vale}
                    onChange={(e) => setVale(e.target.value)}
                  />
                </div>
              </div>
            )}
            <button
              type="submit"
              disabled={enviando || equipoId === "" || !valeCompleto}
              className="w-full bg-[#BADC1E] text-[#0D1719] font-bold py-3 rounded-2xl hover:brightness-110 disabled:opacity-50"
            >
              {enviando ? "Guardando..." : "Asignar"}
            </button>
          </form>

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      </div>
    </div>
  );
}
