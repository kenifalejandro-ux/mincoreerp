// client/src/components/mantenimiento/AreasDeMantenimiento.tsx
//
// Las áreas de la empresa (Cantera, Planta de hornos, Taller…): dónde trabajan los equipos. Se agregan y se
// quitan desde aquí; un área con equipos no se quita (hay que cambiarlos de área antes).
import { Plus, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { crearArea, listarAreas, quitarArea, type AreaMantenimiento } from "./mantenimientoApi";

export default function AreasDeMantenimiento({
  puedeEscribir,
  onCambio,
  onCerrar,
}: {
  puedeEscribir: boolean;
  /** Avisa que las áreas cambiaron, para que la lista de equipos las vuelva a leer. */
  onCambio: () => void;
  onCerrar: () => void;
}) {
  const [areas, setAreas] = useState<AreaMantenimiento[] | null>(null);
  const [nombre, setNombre] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const campo = useRef<HTMLInputElement>(null);

  const cargar = () =>
    listarAreas()
      .then(setAreas)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "No se pudo cargar."));

  useEffect(() => {
    cargar();
    campo.current?.focus();
    const alTeclear = (e: KeyboardEvent) => e.key === "Escape" && onCerrar();
    window.addEventListener("keydown", alTeclear);
    return () => window.removeEventListener("keydown", alTeclear);
  }, [onCerrar]);

  const agregar = async (e: FormEvent) => {
    e.preventDefault();
    if (guardando) return;
    if (!nombre.trim()) return setError("Escribe el nombre del área.");
    setError(null);
    setGuardando(true);
    try {
      await crearArea(nombre.trim());
      setNombre("");
      await cargar();
      onCambio();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo agregar el área.");
    } finally {
      setGuardando(false);
    }
  };

  const quitar = async (area: AreaMantenimiento) => {
    if (guardando) return;
    setError(null);
    setGuardando(true);
    try {
      await quitarArea(area.id);
      await cargar();
      onCambio();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo quitar el área.");
    } finally {
      setGuardando(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] grid place-items-center bg-slate-900/60 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onCerrar()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="areas-titulo"
        className="w-full max-w-[500px] max-h-[92vh] overflow-y-auto rounded-[13px] bg-white shadow-xl"
      >
        <header className="flex items-start justify-between border-b border-slate-200 px-[22px] pt-5 pb-4">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-slate-500">
              Dónde trabajan los equipos
            </p>
            <h2 id="areas-titulo" className="mt-1 text-[19px] font-semibold text-slate-900">
              Áreas
            </h2>
          </div>
          <button
            type="button"
            onClick={onCerrar}
            aria-label="Cerrar"
            className="text-slate-500 hover:text-slate-900"
          >
            <X size={20} />
          </button>
        </header>

        <div className="p-[22px] space-y-4">
          {puedeEscribir && (
            <form onSubmit={agregar} className="flex gap-2">
              <label className="flex-1">
                <span className="sr-only">Nombre del área</span>
                <input
                  ref={campo}
                  value={nombre}
                  onChange={(e) => setNombre(e.target.value)}
                  maxLength={80}
                  placeholder="Nueva área (ej. Cantera Sur)"
                  className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-800 outline-none focus:border-[#84cc16]"
                />
              </label>
              <button
                type="submit"
                disabled={guardando}
                className="flex items-center gap-2 h-10 px-4 rounded-lg bg-[#BADC1E] text-[#0A1014] text-sm font-semibold hover:brightness-95 disabled:opacity-60"
              >
                <Plus size={16} /> Agregar
              </button>
            </form>
          )}

          {error && (
            <p
              role="alert"
              className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3"
            >
              {error}
            </p>
          )}

          {areas === null && !error && <p className="text-sm text-slate-500">Cargando…</p>}
          {areas !== null && areas.length === 0 && (
            <p className="text-sm text-slate-500">Todavía no hay áreas. Agrega la primera.</p>
          )}
          {areas !== null && areas.length > 0 && (
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
              {areas.map((a) => (
                <li key={a.id} className="flex items-center gap-3 px-4 py-3">
                  <span className="flex-1 min-w-0">
                    <b className="block truncate text-sm text-slate-900">{a.nombre}</b>
                    <small className="text-xs text-slate-500">
                      {a.equipos === 0
                        ? "Sin equipos"
                        : `${a.equipos} ${a.equipos === 1 ? "equipo" : "equipos"}`}
                    </small>
                  </span>
                  {puedeEscribir && (
                    <button
                      type="button"
                      onClick={() => quitar(a)}
                      disabled={guardando || a.equipos > 0}
                      aria-label={`Quitar el área ${a.nombre}`}
                      title={
                        a.equipos > 0
                          ? "Tiene equipos: cámbialos de área antes de quitarla"
                          : "Quitar el área"
                      }
                      className="p-2 rounded-md text-slate-500 hover:text-red-600 hover:bg-red-50 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-500"
                    >
                      <Trash2 size={16} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-slate-500">
            Un área con equipos no se puede quitar: primero cámbialos de área desde Equipos.
          </p>
        </div>
      </div>
    </div>
  );
}
