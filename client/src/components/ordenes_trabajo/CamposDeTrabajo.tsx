// client/src/components/ordenes_trabajo/CamposDeTrabajo.tsx
//
// Piezas del trabajo de una orden (hora, «la unidad no puede operar», agregar tareas) que comparten el
// formulario de alta y la ventana de detalle.
import { Plus, X } from "lucide-react";

import { TOPE_DE_TAREAS } from "./horasYTareas";
import { horasYTareasEsNuevo } from "./novedadHorasTareas";

export function EtiquetaNuevo() {
  if (!horasYTareasEsNuevo()) return null;
  return (
    <span className="ml-2 px-1.5 py-0.5 rounded-full bg-[#BADC1E] text-[#0A1014] text-[9px] font-extrabold normal-case">
      Nuevo
    </span>
  );
}

export function CampoDeHora(p: {
  id: string;
  etiqueta: string;
  valor: string;
  onCambiar: (valor: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1 min-w-0">
      <label htmlFor={p.id} className="text-xs font-bold text-slate-500 uppercase">
        {p.etiqueta}
      </label>
      <input
        id={p.id}
        type="datetime-local"
        className="w-full min-h-[44px] border border-slate-200 rounded-xl p-3 text-sm outline-none focus:ring-2 focus:ring-slate-900 disabled:opacity-60"
        value={p.valor}
        disabled={p.disabled}
        onChange={(e) => p.onCambiar(e.target.value)}
      />
    </div>
  );
}

export function CasillaNoOpera(p: {
  marcada: boolean;
  onCambiar: (marcada: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-center gap-3 min-h-[44px] text-sm font-semibold text-slate-700">
      <input
        type="checkbox"
        className="w-5 h-5 accent-red-600"
        checked={p.marcada}
        disabled={p.disabled}
        onChange={(e) => p.onCambiar(e.target.checked)}
      />
      La unidad no puede operar
    </label>
  );
}

/** La casilla para escribir una tarea y agregarla. Enter agrega; no envía el formulario de la orden. */
export function AgregarTarea(p: {
  valor: string;
  onCambiar: (valor: string) => void;
  onAgregar: () => void;
  total: number;
  disabled?: boolean;
}) {
  const lleno = p.total >= TOPE_DE_TAREAS;
  return (
    <div className="flex gap-2">
      <input
        aria-label="Nueva tarea"
        type="text"
        maxLength={300}
        placeholder={lleno ? `Hasta ${TOPE_DE_TAREAS} tareas` : "Ej. Cambiar pastillas"}
        className="flex-1 min-w-0 min-h-[44px] border border-slate-200 rounded-xl p-3 text-sm outline-none focus:ring-2 focus:ring-slate-900"
        value={p.valor}
        disabled={lleno}
        onChange={(e) => p.onCambiar(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          p.onAgregar();
        }}
      />
      <button
        type="button"
        onClick={p.onAgregar}
        disabled={p.disabled || lleno || !p.valor.trim()}
        className="flex items-center gap-1 min-h-[44px] px-4 rounded-xl border border-slate-200 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40"
      >
        <Plus className="w-4 h-4" />
        Agregar
      </button>
    </div>
  );
}

export function BotonQuitarTarea(p: { nombre: string; onQuitar: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={p.onQuitar}
      disabled={p.disabled}
      aria-label={`Quitar tarea: ${p.nombre}`}
      className="flex items-center justify-center min-w-[44px] min-h-[44px] rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-40"
    >
      <X className="w-4 h-4" />
    </button>
  );
}
