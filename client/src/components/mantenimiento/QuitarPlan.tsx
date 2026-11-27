// client/src/components/mantenimiento/QuitarPlan.tsx
//
// Quitar un plan, con confirmación. Los servicios ya registrados no se borran. Se hace con señal.
import { useEffect, useRef, useState } from "react";

import { quitarPlan } from "./mantenimientoApi";
import type { PlanPreventivo } from "./planesPreventivo";
import { useFocoDentro } from "./useFocoDentro";

export default function QuitarPlan({
  plan,
  onQuitado,
  onRechazado,
  onCerrar,
}: {
  plan: PlanPreventivo;
  onQuitado: () => void;
  onRechazado: () => void;
  onCerrar: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [quitando, setQuitando] = useState(false);
  const enviando = useRef(false);
  const cancelar = useRef<HTMLButtonElement>(null);
  const ventana = useFocoDentro<HTMLDivElement>();

  useEffect(() => {
    cancelar.current?.focus();
    const alTeclear = (e: KeyboardEvent) => e.key === "Escape" && onCerrar();
    window.addEventListener("keydown", alTeclear);
    return () => window.removeEventListener("keydown", alTeclear);
  }, [onCerrar]);

  const quitar = async () => {
    if (enviando.current) return;
    enviando.current = true;
    setQuitando(true);
    setError(null);
    try {
      await quitarPlan(plan.id);
      onQuitado();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo quitar el plan.");
      onRechazado();
    } finally {
      enviando.current = false;
      setQuitando(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] grid place-items-center bg-slate-900/60 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onCerrar()}
    >
      <div
        ref={ventana}
        role="dialog"
        aria-modal="true"
        aria-labelledby="quitar-plan-titulo"
        className="w-full max-w-[460px] overflow-hidden rounded-[13px] bg-white shadow-xl"
      >
        <header className="border-b border-slate-200 px-[22px] pb-4 pt-5">
          <p className="break-words text-[10px] font-bold uppercase tracking-[0.13em] text-slate-500">
            {plan.tipo_equipo}
          </p>
          <h2 id="quitar-plan-titulo" className="mt-1 text-[19px] font-semibold text-slate-900">
            Quitar plan
          </h2>
        </header>
        <div className="space-y-3 p-[22px]">
          <p className="text-sm text-slate-600">
            Los equipos de este tipo dejan de tener un próximo servicio calculado. Los servicios ya
            registrados no se borran.
          </p>
          {error && (
            <p
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"
            >
              {error}
            </p>
          )}
        </div>
        <footer className="flex justify-end gap-2 border-t border-slate-200 px-[22px] py-3.5">
          <button
            ref={cancelar}
            type="button"
            onClick={onCerrar}
            className="min-h-[44px] rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 sm:min-h-10"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={() => void quitar()}
            disabled={quitando}
            className="min-h-[44px] rounded-lg bg-red-600 px-4 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-60 sm:min-h-10"
          >
            {quitando ? "Quitando…" : "Quitar plan"}
          </button>
        </footer>
      </div>
    </div>
  );
}
