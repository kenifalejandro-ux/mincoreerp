// client/src/components/mantenimiento/QuitarEquipo.tsx
//
// Quitar un equipo: pide el motivo (obligatorio) y queda en la auditoría de la empresa. Nada se borra: el equipo
// deja de aparecer en la lista y su placa queda libre para registrarla de nuevo.
import { useEffect, useRef, useState, type FormEvent } from "react";

import { MOTIVO_MAXIMO, problemaDelMotivo } from "./formularioEquipo";
import { quitarEquipo, type EquipoMantenimiento } from "./mantenimientoApi";

export default function QuitarEquipo({
  equipo,
  onQuitado,
  onCerrar,
}: {
  equipo: EquipoMantenimiento;
  onQuitado: () => void;
  onCerrar: () => void;
}) {
  const [motivo, setMotivo] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const campo = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    campo.current?.focus();
    const alTeclear = (e: KeyboardEvent) => e.key === "Escape" && onCerrar();
    window.addEventListener("keydown", alTeclear);
    return () => window.removeEventListener("keydown", alTeclear);
  }, [onCerrar]);

  const enviar = async (e: FormEvent) => {
    e.preventDefault();
    if (guardando) return;
    const problema = problemaDelMotivo(motivo);
    if (problema) return setError(problema);
    setError(null);
    setGuardando(true);
    try {
      await quitarEquipo(equipo.id, motivo.trim());
      onQuitado();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo quitar el equipo.");
    } finally {
      setGuardando(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] grid place-items-center bg-slate-900/60 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onCerrar()}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="quitar-equipo-titulo"
        onSubmit={enviar}
        className="w-full max-w-[460px] overflow-hidden rounded-[13px] bg-white shadow-xl"
      >
        <header className="border-b border-slate-200 px-[22px] pt-5 pb-4">
          <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-slate-500">
            {equipo.placa_codigo}
          </p>
          <h2 id="quitar-equipo-titulo" className="mt-1 text-[19px] font-semibold text-slate-900">
            Quitar equipo
          </h2>
        </header>
        <div className="p-[22px] space-y-3">
          <p className="text-sm text-slate-600">
            El equipo deja de aparecer en la lista. No se borra nada y su placa queda libre.
          </p>
          <label className="flex flex-col gap-1.5 text-[11px] font-semibold text-slate-500">
            Motivo
            <textarea
              ref={campo}
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              maxLength={MOTIVO_MAXIMO}
              rows={3}
              placeholder="Ej. Se vendió, dado de baja..."
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-[#84cc16]"
            />
          </label>
          {error && (
            <p
              role="alert"
              className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3"
            >
              {error}
            </p>
          )}
        </div>
        <footer className="flex justify-end gap-2 border-t border-slate-200 px-[22px] py-3.5">
          <button
            type="button"
            onClick={onCerrar}
            className="h-10 px-4 rounded-lg border border-slate-300 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Cancelar
          </button>
          <button
            type="submit"
            disabled={guardando}
            className="h-10 px-4 rounded-lg bg-red-600 text-white text-sm font-semibold hover:bg-red-700 disabled:opacity-60"
          >
            {guardando ? "Quitando…" : "Quitar equipo"}
          </button>
        </footer>
      </form>
    </div>
  );
}
