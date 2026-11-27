// client/src/components/mantenimiento/CambiarEstadoDeOrden.tsx
//
// La ventana para completar o cancelar una orden desde el panel: pide las observaciones (opcionales). Necesita
// señal: un cambio de estado no queda en la cola del equipo.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { cambiarEstadoDeOrden } from "./mantenimientoApi";

const TEXTOS = {
  completada: {
    titulo: "Completar la orden",
    etiqueta: "Observaciones de cierre (opcional)",
    accion: "Completar orden",
  },
  cancelada: {
    titulo: "Cancelar la orden",
    etiqueta: "Motivo de cancelación (opcional)",
    accion: "Cancelar orden",
  },
};

export default function CambiarEstadoDeOrden({
  id,
  estado,
  onCerrar,
  onCambiado,
  onRechazo,
}: {
  id: number;
  estado: "completada" | "cancelada";
  onCerrar: () => void;
  onCambiado: () => void;
  /** El servidor no aceptó: la orden pudo cambiar y se relee. */
  onRechazo: () => void;
}) {
  const [texto, setTexto] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const t = TEXTOS[estado];

  useEffect(() => {
    const alTeclear = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onCerrar();
    };
    document.addEventListener("keydown", alTeclear, true);
    return () => document.removeEventListener("keydown", alTeclear, true);
  }, [onCerrar]);

  const guardar = (e: React.FormEvent) => {
    e.preventDefault();
    if (guardando) return;
    setGuardando(true);
    setError(null);
    cambiarEstadoDeOrden(id, estado, texto.trim() || undefined)
      .then(onCambiado)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Error");
        setGuardando(false);
        if (navigator.onLine) onRechazo();
      });
  };

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/50 p-3">
      <form
        role="dialog"
        aria-modal="true"
        aria-label={t.titulo}
        onSubmit={guardar}
        className="max-h-[90vh] w-full max-w-md space-y-3 overflow-y-auto rounded-2xl bg-white p-5 shadow-2xl"
      >
        <h2 className="text-xl font-semibold text-slate-900">
          {t.titulo} #{id}
        </h2>
        <label className="block text-xs font-semibold text-slate-600">
          {t.etiqueta}
          <textarea
            autoFocus
            rows={3}
            maxLength={2000}
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 p-3 text-sm font-normal text-slate-900 outline-none focus:border-[#84cc16]"
          />
        </label>
        {error && (
          <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onCerrar}
            className="min-h-[44px] sm:min-h-10 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Volver
          </button>
          <button
            type="submit"
            disabled={guardando}
            className="min-h-[44px] sm:min-h-10 rounded-lg bg-[#BADC1E] px-4 text-sm font-semibold text-[#0A1014] hover:brightness-95 disabled:opacity-50"
          >
            {t.accion}
          </button>
        </div>
      </form>
    </div>,
    document.body
  );
}
