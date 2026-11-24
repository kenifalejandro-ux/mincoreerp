// client/src/components/mantenimiento/FormularioEquipo.tsx
//
// Registrar o editar un equipo. Doble clic: mientras guarda, el botón queda deshabilitado y el envío se
// ignora; además, al registrar, el `cliente_uuid` se fija al ABRIR el formulario, así que dos envíos que
// entren antes de que el botón se bloquee son el mismo equipo para el servidor. La lógica está en
// formularioEquipo.ts.
import { Check, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { lecturaConUnidad } from "./equiposMantenimiento";
import {
  cuerpoDelEquipo,
  formularioInicial,
  problemasDelEquipo,
  type FormularioDeEquipo,
} from "./formularioEquipo";
import {
  actualizarEquipo,
  crearEquipo,
  type AreaMantenimiento,
  type EquipoMantenimiento,
} from "./mantenimientoApi";

export default function FormularioEquipo({
  equipo,
  areas,
  tipos,
  onGuardado,
  onCerrar,
}: {
  /** Sin equipo = registrar uno nuevo. */
  equipo?: EquipoMantenimiento;
  areas: AreaMantenimiento[];
  /** Los tipos que la empresa ya usa, como sugerencias (se puede escribir otro). */
  tipos: string[];
  onGuardado: () => void;
  onCerrar: () => void;
}) {
  const [form, setForm] = useState<FormularioDeEquipo>(() => formularioInicial(equipo));
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  // Fijo al abrir: ver el comentario del archivo.
  const clienteUuid = useRef(crypto.randomUUID());
  const primero = useRef<HTMLInputElement>(null);

  useEffect(() => {
    primero.current?.focus();
    const alTeclear = (e: KeyboardEvent) => e.key === "Escape" && onCerrar();
    window.addEventListener("keydown", alTeclear);
    return () => window.removeEventListener("keydown", alTeclear);
  }, [onCerrar]);

  const cambiar = <K extends keyof FormularioDeEquipo>(campo: K, valor: FormularioDeEquipo[K]) =>
    setForm((f) => ({ ...f, [campo]: valor }));

  const enviar = async (e: FormEvent) => {
    e.preventDefault();
    if (guardando) return;
    const problemas = problemasDelEquipo(form);
    if (problemas.length) return setError(problemas[0]);
    setError(null);
    setGuardando(true);
    try {
      const cuerpo = cuerpoDelEquipo(form);
      if (equipo) await actualizarEquipo(equipo.id, cuerpo);
      else await crearEquipo(cuerpo, clienteUuid.current);
      onGuardado();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar.");
    } finally {
      setGuardando(false);
    }
  };

  const campo =
    "h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-800 outline-none focus:border-[#84cc16]";
  const etiqueta = "flex flex-col gap-1.5 text-[11px] font-semibold text-slate-500";
  const unidad = form.medidor === "horometro" ? "horas" : "km";
  return (
    <div
      className="fixed inset-0 z-[100] grid place-items-center bg-slate-900/60 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onCerrar()}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="form-equipo-titulo"
        onSubmit={enviar}
        className="w-full max-w-[570px] max-h-[92vh] overflow-y-auto rounded-[13px] bg-white shadow-xl"
      >
        <header className="flex items-start justify-between border-b border-slate-200 px-[22px] pt-5 pb-4">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-slate-500">
              {equipo ? "Editar" : "Nuevo registro"}
            </p>
            <h2 id="form-equipo-titulo" className="mt-1 text-[19px] font-semibold text-slate-900">
              {equipo ? "Editar equipo" : "Registrar equipo"}
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

        <div className="grid gap-[15px] p-[22px] sm:grid-cols-2">
          <label className={etiqueta}>
            Placa o código
            <input
              ref={primero}
              value={form.placa}
              onChange={(e) => cambiar("placa", e.target.value)}
              maxLength={40}
              placeholder="Ej. AKM-739"
              className={campo}
            />
          </label>
          <label className={etiqueta}>
            Tipo de equipo
            <input
              value={form.tipo}
              onChange={(e) => cambiar("tipo", e.target.value)}
              maxLength={60}
              list="tipos-de-equipo"
              placeholder="Ej. Volquete"
              className={campo}
            />
            <datalist id="tipos-de-equipo">
              {tipos.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </label>
          <label className={etiqueta}>
            Marca
            <input
              value={form.marca}
              onChange={(e) => cambiar("marca", e.target.value)}
              maxLength={60}
              className={campo}
            />
          </label>
          <label className={etiqueta}>
            Modelo
            <input
              value={form.modelo}
              onChange={(e) => cambiar("modelo", e.target.value)}
              maxLength={60}
              className={campo}
            />
          </label>
          <label className={etiqueta}>
            Se mide con
            <select
              value={form.medidor}
              onChange={(e) => cambiar("medidor", e.target.value as FormularioDeEquipo["medidor"])}
              className={campo}
            >
              <option value="horometro">Horómetro (horas)</option>
              <option value="odometro">Odómetro (km)</option>
            </select>
          </label>
          {equipo ? (
            // Una lectura no se corrige escribiéndola de nuevo: se registra con sus reglas (no retroceder,
            // corregir es anular). Aquí se muestra la última.
            <div className={etiqueta}>
              Lectura actual ({unidad})
              <p className="flex h-10 items-center rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm font-semibold text-slate-700">
                {lecturaConUnidad({ lectura: equipo.lectura, medidor: form.medidor })}
              </p>
              <span className="font-normal text-slate-400">
                Se registra al llenar un checklist o desde el Registro de unidades.
              </span>
            </div>
          ) : (
            <label className={etiqueta}>
              Lectura inicial ({unidad})
              <input
                value={form.lectura}
                onChange={(e) => cambiar("lectura", e.target.value)}
                inputMode="decimal"
                className={campo}
              />
            </label>
          )}
          <label className={etiqueta}>
            Propiedad
            <select
              value={form.propiedad}
              onChange={(e) =>
                cambiar("propiedad", e.target.value as FormularioDeEquipo["propiedad"])
              }
              className={campo}
            >
              <option value="propia">Propia</option>
              <option value="alquilada">Alquilada</option>
            </select>
          </label>
          <label className={etiqueta}>
            Área
            <select
              value={form.area}
              onChange={(e) => cambiar("area", e.target.value)}
              className={campo}
            >
              <option value="">Sin área</option>
              {areas.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.nombre}
                </option>
              ))}
            </select>
          </label>
          {error && (
            <p
              role="alert"
              className="sm:col-span-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3"
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
            className="flex items-center gap-2 h-10 px-4 rounded-lg bg-[#BADC1E] text-[#0A1014] text-sm font-semibold hover:brightness-95 disabled:opacity-60"
          >
            <Check size={16} /> {guardando ? "Guardando…" : "Guardar"}
          </button>
        </footer>
      </form>
    </div>
  );
}
