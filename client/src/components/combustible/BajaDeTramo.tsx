// «Dar de baja» un tramo de vales que faltan: motivo obligatorio (y detalle si es «Otro»). Es una
// explicación, no un borrado: el kardex sigue mostrando el salto. Necesita conexión, porque el
// servidor comprueba que esos números no tengan vale; sin señal no se guarda nada en silencio.
import { useState } from "react";

import { apiFetch } from "../../services/apiClient";
import { mensajeDeError } from "../../utils/mensajeDeError";
import { MOTIVOS_BAJA, rangoTexto, type TramoFaltante } from "./valesFaltantesLogica";

export default function BajaDeTramo({
  serie,
  tramo,
  onHecha,
}: {
  serie: string;
  tramo: TramoFaltante;
  onHecha: () => void;
}) {
  const [abierto, setAbierto] = useState(false);
  const [motivo, setMotivo] = useState("");
  const [detalle, setDetalle] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirmar = async () => {
    if (!motivo) return setError("Elige un motivo.");
    if (motivo === "otro" && !detalle.trim())
      return setError("Con «Otro» el detalle es obligatorio.");
    setEnviando(true);
    setError(null);
    try {
      const res = await apiFetch("/api/erp/combustible/despachos/talonarios/bajas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serie,
          desde: tramo.desde,
          hasta: tramo.hasta,
          motivo,
          ...(detalle.trim() ? { detalle: detalle.trim() } : {}),
        }),
      });
      if (!res.ok) {
        setError(
          mensajeDeError(await res.json().catch(() => ({})), "No se pudo dar de baja el tramo.")
        );
        return;
      }
      onHecha();
    } catch {
      setError("Sin conexión: la baja necesita señal. Inténtalo de nuevo cuando vuelva.");
    } finally {
      setEnviando(false);
    }
  };

  if (!abierto) {
    return (
      <button
        onClick={() => setAbierto(true)}
        className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
      >
        Dar de baja
      </button>
    );
  }
  return (
    <div className="mt-2 flex flex-wrap items-end gap-2 rounded-lg bg-slate-50 p-3">
      <label className="flex flex-col gap-1 text-xs font-bold uppercase text-slate-600">
        Motivo
        <select
          className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm font-normal normal-case"
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
        >
          <option value="">Elige un motivo</option>
          {MOTIVOS_BAJA.map((m) => (
            <option key={m.valor} value={m.valor}>
              {m.texto}
            </option>
          ))}
        </select>
      </label>
      <label className="flex min-w-[200px] flex-1 flex-col gap-1 text-xs font-bold uppercase text-slate-600">
        Detalle {motivo === "otro" ? "(obligatorio)" : "(opcional)"}
        <input
          type="text"
          maxLength={300}
          className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm font-normal normal-case"
          value={detalle}
          onChange={(e) => setDetalle(e.target.value)}
        />
      </label>
      <button
        onClick={confirmar}
        disabled={enviando}
        className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
      >
        {enviando ? "Guardando..." : `Confirmar baja del ${rangoTexto(tramo)}`}
      </button>
      <button
        onClick={() => setAbierto(false)}
        disabled={enviando}
        className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-white"
      >
        Cancelar
      </button>
      {error && <p className="basis-full text-xs text-red-600">{error}</p>}
    </div>
  );
}
