// client/src/components/proveedores/CambiarEstadoDeProveedor.tsx
//
// Desactivar o reactivar un proveedor. Desactivar pide el motivo (obligatorio) y queda en el Historial;
// reactivar lo admite pero no lo exige. Nada se borra: el proveedor deja de ofrecerse para compras y precios
// nuevos, y todo lo anterior se conserva.
import { useEffect, useRef, useState, type FormEvent } from "react";

import { problemaDelMotivo } from "./accionesDeProveedor";
import { cambiarEstadoDeProveedor, type Proveedor, type ProveedorBasico } from "./proveedoresApi";

export default function CambiarEstadoDeProveedor({
  proveedor,
  onCambiado,
  onCerrar,
}: {
  proveedor: ProveedorBasico;
  onCambiado: (p: Proveedor) => void;
  onCerrar: () => void;
}) {
  // Si está activo, la acción es desactivarlo.
  const desactivando = proveedor.activo;
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
    const problema = problemaDelMotivo(motivo, desactivando);
    if (problema) return setError(problema);
    setError(null);
    setGuardando(true);
    try {
      onCambiado(await cambiarEstadoDeProveedor(proveedor.id, !desactivando, motivo.trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar el cambio.");
    } finally {
      setGuardando(false);
    }
  };

  const titulo = desactivando ? "Desactivar proveedor" : "Reactivar proveedor";
  return (
    <div
      className="fixed inset-0 z-[100] grid place-items-center bg-slate-900/60 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onCerrar()}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="estado-proveedor-titulo"
        onSubmit={enviar}
        className="w-full max-w-md rounded-2xl bg-white shadow-xl"
      >
        <div className="p-5 space-y-3">
          <h2 id="estado-proveedor-titulo" className="text-xl font-semibold text-slate-900">
            {titulo}
          </h2>
          <p className="text-sm text-slate-600">
            <b>{proveedor.nombre}</b>{" "}
            {desactivando
              ? "dejará de ofrecerse al registrar compras y precios nuevos. Todo lo anterior se conserva y se puede reactivar cuando quieras."
              : "volverá a ofrecerse al registrar compras y precios nuevos."}
          </p>
          <label
            htmlFor="estado-proveedor-motivo"
            className="block text-xs font-semibold text-slate-600"
          >
            {desactivando ? "Motivo" : "Motivo (opcional)"}
            <textarea
              id="estado-proveedor-motivo"
              ref={campo}
              rows={3}
              maxLength={300}
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
            className={`h-10 px-4 rounded-lg text-sm font-semibold disabled:opacity-60 ${
              desactivando
                ? "bg-red-600 text-white hover:bg-red-700"
                : "bg-[#BADC1E] text-[#0A1014] hover:brightness-95"
            }`}
          >
            {guardando ? "Guardando…" : titulo}
          </button>
        </footer>
      </form>
    </div>
  );
}
