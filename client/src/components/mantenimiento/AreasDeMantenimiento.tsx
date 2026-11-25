// client/src/components/mantenimiento/AreasDeMantenimiento.tsx
//
// El panel «Áreas» de Configuración: dónde trabajan los equipos (Cantera, Planta de hornos, Taller…). Cada área
// es una ficha con cuántos equipos tiene; solo se puede quitar la que está vacía. Admin y operador agregan y
// quitan; Lectura mira.
import { Plus, X } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";

import { crearArea, listarAreas, quitarArea, type AreaMantenimiento } from "./mantenimientoApi";

export default function AreasDeMantenimiento({ puedeEscribir }: { puedeEscribir: boolean }) {
  const [areas, setAreas] = useState<AreaMantenimiento[] | null>(null);
  const [nombre, setNombre] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  const cargar = useCallback(
    () =>
      listarAreas()
        .then(setAreas)
        .catch((e: unknown) => setError(e instanceof Error ? e.message : "No se pudo cargar.")),
    []
  );

  useEffect(() => {
    cargar();
  }, [cargar]);

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
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo quitar el área.");
      await cargar();
    } finally {
      setGuardando(false);
    }
  };

  return (
    <section aria-label="Áreas" className="bg-white border border-slate-200 rounded-xl shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2 px-5 py-4 border-b border-slate-200">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-slate-500">
            Dónde trabajan los equipos
          </p>
          <h2 className="text-lg font-semibold text-slate-900">Áreas</h2>
        </div>
        <span className="px-2 py-1 rounded-md bg-slate-100 text-xs font-semibold text-slate-500">
          Se eligen al registrar un equipo
        </span>
      </div>

      <div className="p-5 space-y-4">
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
          <p className="text-sm text-slate-500">
            Todavía no hay áreas.{puedeEscribir ? " Agrega la primera." : ""}
          </p>
        )}
        {areas !== null && areas.length > 0 && (
          <ul className="flex flex-wrap gap-2">
            {areas.map((a) => (
              <li
                key={a.id}
                className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-800"
              >
                {a.nombre}
                <small className="text-xs font-medium text-slate-500">
                  {a.equipos === 1 ? "1 equipo" : `${a.equipos} equipos`}
                </small>
                {puedeEscribir && a.equipos === 0 && (
                  <button
                    type="button"
                    onClick={() => quitar(a)}
                    disabled={guardando}
                    aria-label={`Quitar el área ${a.nombre}`}
                    title="Quitar el área"
                    className="p-0.5 rounded text-slate-400 hover:text-red-600 disabled:opacity-40"
                  >
                    <X size={13} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {puedeEscribir && (
          <form onSubmit={agregar} className="flex flex-wrap gap-2">
            <label className="flex items-center gap-2 h-10 w-full max-w-[320px] rounded-lg border border-slate-300 bg-white px-3 focus-within:border-[#84cc16]">
              <span className="sr-only">Nombre del área</span>
              <Plus size={16} className="text-slate-400 shrink-0" />
              <input
                value={nombre}
                onChange={(e) => setNombre(e.target.value)}
                maxLength={80}
                autoComplete="off"
                placeholder="Nueva área (ej. Cantera Sur)"
                className="min-w-0 flex-1 bg-transparent text-sm text-slate-800 outline-none"
              />
            </label>
            <button
              type="submit"
              disabled={guardando}
              className="h-10 px-5 rounded-lg bg-[#BADC1E] text-[#0A1014] text-sm font-semibold hover:brightness-95 disabled:opacity-60"
            >
              Agregar
            </button>
          </form>
        )}
        <small className="block text-xs text-slate-500">
          Un área con equipos no se puede quitar: primero se cambian de área.
        </small>
      </div>
    </section>
  );
}
