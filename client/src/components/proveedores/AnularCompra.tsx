// client/src/components/proveedores/AnularCompra.tsx
//
// Anular una compra: pide el motivo (obligatorio). Nunca se borra: la compra queda anulada, con su motivo,
// como evidencia.
import { useEffect, useRef, useState, type FormEvent } from "react";

import { anularCompra, type CompraDeCisterna } from "./proveedoresApi";

export default function AnularCompra({
  compra,
  onAnulada,
  onCerrar,
}: {
  compra: CompraDeCisterna;
  onAnulada: (compra: CompraDeCisterna) => void;
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
    if (motivo.trim() === "") return setError("Escribe el motivo de la anulación.");
    setError(null);
    setGuardando(true);
    try {
      onAnulada(await anularCompra(compra.id, motivo.trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo anular la compra.");
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
        aria-labelledby="anular-compra-titulo"
        onSubmit={enviar}
        className="w-full max-w-md rounded-2xl bg-white shadow-xl"
      >
        <div className="p-5 space-y-3">
          <h2 id="anular-compra-titulo" className="text-xl font-semibold text-slate-900">
            Anular compra
          </h2>
          <p className="text-sm text-slate-600">
            {compra.numeroDocumento} · {compra.proveedorNombre}. La compra no se borra: queda
            anulada con su motivo.
          </p>
          <label htmlFor="anular-motivo" className="block text-xs font-semibold text-slate-600">
            Motivo
            <textarea
              id="anular-motivo"
              ref={campo}
              rows={3}
              maxLength={500}
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 p-3 text-sm text-slate-800 outline-none focus:border-[#84cc16]"
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
            {guardando ? "Anulando…" : "Anular compra"}
          </button>
        </footer>
      </form>
    </div>
  );
}
