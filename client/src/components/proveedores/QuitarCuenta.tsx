// client/src/components/proveedores/QuitarCuenta.tsx
//
// Quitar una cuenta bancaria: pide el motivo (obligatorio). La cuenta no se borra: queda desactivada, con su
// motivo y quién la quitó, en la bitácora.
import { X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { quitarCuenta } from "./proveedoresApi";

export default function QuitarCuenta({
  proveedorId,
  cuentaId,
  descripcion,
  onQuitada,
  onCerrar,
}: {
  proveedorId: number;
  cuentaId: number;
  /** «BCP •••• 4567». */
  descripcion: string;
  onQuitada: () => void;
  onCerrar: () => void;
}) {
  const [motivo, setMotivo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
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
    if (motivo.trim().length < 3) return setError("Escribe el motivo (mínimo 3 letras).");
    setError(null);
    setGuardando(true);
    try {
      await quitarCuenta(proveedorId, cuentaId, motivo.trim());
      onQuitada();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo quitar la cuenta.");
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
        aria-labelledby="quitar-cuenta-titulo"
        onSubmit={enviar}
        className="w-full max-w-md rounded-2xl bg-white shadow-xl"
      >
        <header className="flex items-start justify-between p-5 border-b border-slate-200">
          <h2 id="quitar-cuenta-titulo" className="text-xl font-semibold text-slate-900">
            Quitar cuenta
          </h2>
          <button
            type="button"
            onClick={onCerrar}
            aria-label="Cerrar"
            className="text-slate-500 hover:text-slate-900"
          >
            <X size={20} />
          </button>
        </header>
        <div className="p-5 space-y-4">
          <p className="text-sm text-slate-600">
            {descripcion}. La cuenta no se borra: queda desactivada, con su motivo, en la bitácora.
          </p>
          <label
            htmlFor="quitar-cuenta-motivo"
            className="block text-xs font-semibold text-slate-600"
          >
            Motivo
          </label>
          <textarea
            id="quitar-cuenta-motivo"
            ref={campo}
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            maxLength={300}
            rows={3}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-[#84cc16]"
          />
          {error && (
            <p
              role="alert"
              className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3"
            >
              {error}
            </p>
          )}
        </div>
        <footer className="flex justify-end gap-2 p-5 border-t border-slate-200">
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
            {guardando ? "Quitando…" : "Quitar cuenta"}
          </button>
        </footer>
      </form>
    </div>
  );
}
