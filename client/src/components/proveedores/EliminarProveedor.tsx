// client/src/components/proveedores/EliminarProveedor.tsx
//
// Eliminar un proveedor (solo el admin). Solo se puede si no tiene historia: precios (también anulados),
// compras, recepciones o despachos. Antes de confirmar se pregunta al servidor si se puede y, si no, se dice por
// qué y se ofrece desactivarlo. Al eliminarlo se van con él su ficha y sus contactos; no se puede deshacer.
import { useEffect, useState } from "react";

import {
  eliminableDeProveedor,
  eliminarProveedor,
  type EliminableDeProveedor,
  type ProveedorBasico,
} from "./proveedoresApi";

export default function EliminarProveedor({
  proveedor,
  onEliminado,
  onDesactivarEnSuLugar,
  onCerrar,
}: {
  proveedor: ProveedorBasico;
  onEliminado: () => void;
  /** Pasa al diálogo de desactivar (solo si el proveedor sigue activo). */
  onDesactivarEnSuLugar?: () => void;
  onCerrar: () => void;
}) {
  const [estado, setEstado] = useState<EliminableDeProveedor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [eliminando, setEliminando] = useState(false);

  useEffect(() => {
    let vigente = true;
    eliminableDeProveedor(proveedor.id)
      .then((r) => vigente && setEstado(r))
      .catch((e: Error) => vigente && setError(e.message));
    const alTeclear = (e: KeyboardEvent) => e.key === "Escape" && onCerrar();
    window.addEventListener("keydown", alTeclear);
    return () => {
      vigente = false;
      window.removeEventListener("keydown", alTeclear);
    };
  }, [proveedor.id, onCerrar]);

  const eliminar = async () => {
    if (eliminando) return;
    setEliminando(true);
    setError(null);
    try {
      await eliminarProveedor(proveedor.id);
      onEliminado();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo eliminar el proveedor.");
      // Pudo cambiar (algo lo ató justo ahora): se vuelve a preguntar.
      eliminableDeProveedor(proveedor.id)
        .then(setEstado)
        .catch(() => undefined);
    } finally {
      setEliminando(false);
    }
  };

  const puede = estado?.eliminable === true;
  return (
    <div
      className="fixed inset-0 z-[100] grid place-items-center bg-slate-900/60 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onCerrar()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="eliminar-proveedor-titulo"
        className="w-full max-w-md rounded-2xl bg-white shadow-xl"
      >
        <div className="p-5 space-y-3">
          <h2 id="eliminar-proveedor-titulo" className="text-xl font-semibold text-slate-900">
            Eliminar proveedor
          </h2>
          {!estado && !error && <p className="text-sm text-slate-500">Revisando su historia…</p>}
          {puede && (
            <p className="text-sm text-slate-600">
              Se eliminará <b>{proveedor.nombre}</b> junto con su ficha y sus contactos. No tiene
              compras, precios ni recepciones. <b>Esto no se puede deshacer.</b>
            </p>
          )}
          {estado && !puede && (
            <p
              role="status"
              className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3"
            >
              {estado.motivo}
            </p>
          )}
          {error && (
            <p
              role="alert"
              className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3"
            >
              {error}
            </p>
          )}
        </div>
        <footer className="flex flex-wrap justify-end gap-2 p-5 border-t border-slate-200">
          <button
            type="button"
            onClick={onCerrar}
            className="h-10 px-4 rounded-lg border border-slate-300 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            {puede ? "Cancelar" : "Cerrar"}
          </button>
          {estado && !puede && proveedor.activo && onDesactivarEnSuLugar && (
            <button
              type="button"
              onClick={onDesactivarEnSuLugar}
              className="h-10 px-4 rounded-lg bg-[#BADC1E] text-[#0A1014] text-sm font-semibold hover:brightness-95"
            >
              Desactivar en su lugar
            </button>
          )}
          {puede && (
            <button
              type="button"
              onClick={eliminar}
              disabled={eliminando}
              className="h-10 px-4 rounded-lg bg-red-600 text-white text-sm font-semibold hover:bg-red-700 disabled:opacity-60"
            >
              {eliminando ? "Eliminando…" : "Eliminar proveedor"}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
