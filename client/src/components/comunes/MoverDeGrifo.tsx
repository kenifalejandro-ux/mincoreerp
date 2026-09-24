// client/src/components/comunes/MoverDeGrifo.tsx
//
// Mover un tanque o un equipo a otro grifo interno (migración 0097), y su
// historial de ubicación. Sirve para los dos porque la regla es la misma:
// solo admin (lo decide el servidor), con motivo obligatorio, y lo que ya
// pasó queda en el grifo donde pasó.
import { X } from "lucide-react";
import { useEffect, useState } from "react";

import type { OpcionDeGrifo } from "./useSedes";
import {
  listarMovimientosDeGrifoApi,
  moverDeGrifoApi,
  type MovimientoDeGrifo,
} from "../../services/sedesApi";

const fecha = (iso: string) =>
  new Date(iso).toLocaleString("es-PE", { dateStyle: "short", timeStyle: "short" });

export default function MoverDeGrifo({
  que,
  id,
  nombre,
  grifoActualId,
  grifos,
  onCerrar,
  onMovido,
}: {
  que: "tanque" | "equipo";
  id: number;
  nombre: string;
  grifoActualId: number | null;
  grifos: OpcionDeGrifo[];
  onCerrar: () => void;
  onMovido: () => void;
}) {
  const [destino, setDestino] = useState("");
  const [motivo, setMotivo] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historial, setHistorial] = useState<MovimientoDeGrifo[] | null>(null);

  useEffect(() => {
    let vigente = true;
    (async () => {
      try {
        const filas = await listarMovimientosDeGrifoApi(que, id);
        if (vigente) setHistorial(filas);
      } catch {
        if (vigente) setHistorial([]);
      }
    })();
    return () => {
      vigente = false;
    };
  }, [que, id]);

  const opciones = grifos.filter((g) => g.id !== grifoActualId);
  const actual = grifos.find((g) => g.id === grifoActualId)?.etiqueta ?? "—";

  const mover = async (e: React.FormEvent) => {
    e.preventDefault();
    if (enviando || destino === "" || motivo.trim() === "") return;
    setEnviando(true);
    setError(null);
    try {
      await moverDeGrifoApi(que, id, Number(destino), motivo.trim());
      onMovido();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo mover");
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-[#0D1719]/90 backdrop-blur-sm flex justify-center items-center z-50 p-4">
      <div className="bg-white w-full max-w-lg rounded-3xl shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="p-6 border-b flex justify-between items-center">
          <h3 className="text-xl font-bold">Mover de grifo — {nombre}</h3>
          <button
            type="button"
            onClick={onCerrar}
            className="text-slate-400 hover:text-slate-900"
            aria-label="Cerrar"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={mover} className="p-6 space-y-4">
          <p className="text-sm text-slate-600">
            Hoy está en <strong>{actual}</strong>. Lo que ya se registró queda en el grifo donde
            ocurrió; lo nuevo va al grifo de destino.
          </p>
          <div className="space-y-1">
            <label htmlFor="mover-grifo-destino" className="text-xs font-bold uppercase">
              Grifo de destino
            </label>
            <select
              id="mover-grifo-destino"
              required
              className="w-full border border-slate-200 rounded-xl p-3 text-sm outline-none bg-white"
              value={destino}
              onChange={(e) => setDestino(e.target.value)}
            >
              <option value="">Elegir grifo</option>
              {opciones.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.etiqueta}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label htmlFor="mover-grifo-motivo" className="text-xs font-bold uppercase">
              Motivo
            </label>
            <input
              id="mover-grifo-motivo"
              required
              maxLength={500}
              className="w-full border border-slate-200 rounded-xl p-3 text-sm outline-none"
              placeholder="Ej.: la cisterna se llevó a la planta norte"
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button
            type="submit"
            disabled={enviando || destino === "" || motivo.trim() === ""}
            className="w-full bg-slate-900 text-white font-bold py-3 rounded-2xl hover:bg-slate-800 disabled:opacity-50"
          >
            {enviando ? "Moviendo..." : "Mover"}
          </button>
        </form>

        <div className="px-6 pb-6">
          <h4 className="text-sm font-bold text-slate-700 uppercase tracking-wide mb-2">
            Historial de ubicación
          </h4>
          {historial === null ? (
            <p className="text-sm text-slate-400">Cargando...</p>
          ) : historial.length === 0 ? (
            <p className="text-sm text-slate-400">Nunca se movió.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {historial.map((m) => (
                <li key={m.id} className="border-b pb-2">
                  <div>
                    {m.grifo_origen ?? "sin grifo"} → <strong>{m.grifo_destino}</strong>
                  </div>
                  <div className="text-xs text-slate-500">
                    {fecha(m.movido_en)} · {m.usuario ?? "—"} · {m.motivo}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
