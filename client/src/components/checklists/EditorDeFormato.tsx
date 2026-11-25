// client/src/components/checklists/EditorDeFormato.tsx
//
// La ventana para crear o editar un formato: nombre, tipo de equipo y las preguntas, cada una con su marca de
// «crítica». Al editar pide «qué cambió»: cada guardado es una versión nueva. Si alguien lo cambió mientras
// tanto, el servidor lo rechaza y aquí se muestra por qué, sin perder lo escrito.
import { X } from "lucide-react";
import { useState } from "react";

import {
  FORMULARIO_VACIO,
  formularioDe,
  guardarFormato,
  problemaDelFormato,
  type PlantillaConItems,
} from "./formatos";

const campo =
  "w-full border border-slate-200 rounded-xl p-3 text-sm outline-none focus:ring-2 focus:ring-slate-900";
const rotulo = "text-xs font-bold text-slate-500 uppercase";

export default function EditorDeFormato({
  editando,
  onGuardado,
  onCerrar,
}: {
  /** El formato que se edita, o null para crear uno. */
  editando: PlantillaConItems | null;
  onGuardado: () => void;
  onCerrar: () => void;
}) {
  const [form, setForm] = useState(() => (editando ? formularioDe(editando) : FORMULARIO_VACIO));
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const cambiarItem = (i: number, parcial: Partial<(typeof form.items)[number]>) =>
    setForm((f) => ({
      ...f,
      items: f.items.map((it, n) => (n === i ? { ...it, ...parcial } : it)),
    }));

  const guardar = async (e: React.FormEvent) => {
    e.preventDefault();
    // Los formatos no pasan por la cola sin señal: bloquear el botón es la defensa contra el doble clic.
    if (guardando) return;
    const problema = problemaDelFormato(form, !!editando);
    if (problema) return setError(problema);
    setError(null);
    setGuardando(true);
    try {
      await guardarFormato(form, editando);
      onGuardado();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar el formato.");
    } finally {
      setGuardando(false);
    }
  };

  const titulo = editando ? `Editar formato (versión ${editando.version ?? 1})` : "Nueva Plantilla";

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center z-50 p-4">
      <div
        role="dialog"
        aria-label={titulo}
        className="bg-white w-full max-w-lg rounded-3xl shadow-2xl max-h-[90vh] overflow-y-auto"
      >
        <div className="p-6 border-b flex justify-between items-center">
          <h3 className="text-xl font-bold">{titulo}</h3>
          <button
            onClick={onCerrar}
            className="text-slate-400 hover:text-slate-900"
            aria-label="Cerrar"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <form onSubmit={guardar} noValidate className="p-6 space-y-4">
          <div className="space-y-1">
            <label htmlFor="plantilla-nombre" className={rotulo}>
              Nombre
            </label>
            <input
              id="plantilla-nombre"
              maxLength={150}
              className={campo}
              value={form.nombre}
              onChange={(e) => setForm({ ...form, nombre: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="plantilla-tipo-equipo" className={rotulo}>
              Tipo de equipo (opcional)
            </label>
            <input
              id="plantilla-tipo-equipo"
              maxLength={100}
              placeholder="Ej: Camioneta"
              className={campo}
              value={form.tipo_equipo}
              onChange={(e) => setForm({ ...form, tipo_equipo: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <span className={rotulo}>Ítems a revisar</span>
            <p className="text-xs text-slate-500">
              Marca como crítica la pregunta que, si falla, impide que la unidad salga.
            </p>
            {form.items.map((item, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <input
                  placeholder={`Ítem ${i + 1}`}
                  maxLength={300}
                  className="flex-1 min-w-40 border border-slate-200 rounded-xl p-3 text-sm outline-none focus:ring-2 focus:ring-slate-900"
                  value={item.descripcion}
                  onChange={(e) => cambiarItem(i, { descripcion: e.target.value })}
                />
                <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-600">
                  <input
                    type="checkbox"
                    aria-label={`Ítem ${i + 1} es crítico`}
                    checked={item.critica}
                    onChange={(e) => cambiarItem(i, { critica: e.target.checked })}
                    className="h-4 w-4 accent-red-600"
                  />
                  Crítica
                </label>
                {form.items.length > 1 && (
                  <button
                    type="button"
                    onClick={() =>
                      setForm({ ...form, items: form.items.filter((_, n) => n !== i) })
                    }
                    className="px-2 text-slate-400 hover:text-red-600"
                    aria-label="Quitar ítem"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))}
            <button
              type="button"
              onClick={() =>
                setForm({ ...form, items: [...form.items, { descripcion: "", critica: false }] })
              }
              className="text-sm text-slate-600 hover:text-slate-900 font-medium"
            >
              + Agregar ítem
            </button>
          </div>
          {editando && (
            <div className="space-y-1">
              <label htmlFor="plantilla-cambio" className={rotulo}>
                Qué cambió
              </label>
              <input
                id="plantilla-cambio"
                maxLength={300}
                placeholder="Ej. Se agrega la revisión de la bocina"
                className={campo}
                value={form.cambio}
                onChange={(e) => setForm({ ...form, cambio: e.target.value })}
              />
              <p className="text-xs text-slate-500">
                Se guarda como versión nueva. Los checklists ya llenados no cambian.
              </p>
            </div>
          )}
          {error && (
            <p
              role="alert"
              className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl p-3"
            >
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={guardando}
            className="w-full bg-slate-900 text-white font-bold py-4 rounded-2xl hover:bg-slate-800 transition-all mt-4 disabled:opacity-40"
          >
            {guardando ? "Guardando..." : editando ? "Guardar versión" : "Crear Plantilla"}
          </button>
        </form>
      </div>
    </div>
  );
}
