// client/src/components/mantenimiento/FormularioPlan.tsx
//
// Crear o editar un plan. Un clic fuera no lo cierra (se perdería lo escrito) y al cerrar con cambios pregunta.
// Doble clic: mientras guarda, el envío se ignora. Se guarda con señal. La lógica está en planesFormulario.ts.
import { Plus, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { actualizarPlan, crearPlan } from "./mantenimientoApi";
import { ChipDeNivel } from "./PiezasDePreventivo";
import {
  cuerpoDelPlan,
  formularioDelPlan,
  MAX_PASOS,
  nivelesDelCiclo,
  problemaDelPlan,
  type FormularioDePlan,
} from "./planesFormulario";
import {
  NOMBRE_DE_NIVEL,
  unidadDe,
  type Medida,
  type Nivel,
  type PlanPreventivo,
} from "./planesPreventivo";
import { useFocoDentro } from "./useFocoDentro";

const campo =
  "min-h-[44px] w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-800 outline-none focus:border-[#84cc16] sm:min-h-10";
const area = `${campo} py-2`;
const etiqueta = "flex flex-col gap-1.5 text-[11px] font-semibold text-slate-500";
const secundario =
  "min-h-[44px] rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 sm:min-h-10";

export default function FormularioPlan({
  plan,
  tipoInicial,
  tiposSinPlan,
  onGuardado,
  onRechazado,
  onCerrar,
}: {
  /** Sin plan = crear uno nuevo. */
  plan?: PlanPreventivo;
  tipoInicial?: string;
  /** Como sugerencias; se puede escribir otro. */
  tiposSinPlan: string[];
  onGuardado: (id: number) => void;
  /** El servidor no aceptó: la lista de atrás se relee (otra persona pudo cambiarla). */
  onRechazado: () => void;
  onCerrar: () => void;
}) {
  // Lo que había al abrir: la versión sobre la que se edita no cambia aunque la lista se relea.
  const [inicial] = useState(() => ({
    form: formularioDelPlan(plan, tipoInicial),
    id: plan?.id,
    version: plan?.version,
  }));
  const [form, setForm] = useState<FormularioDePlan>(inicial.form);
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const enviando = useRef(false);
  const primero = useRef<HTMLInputElement>(null);
  const editando = inicial.id !== undefined;
  const ventana = useFocoDentro<HTMLFormElement>();

  const cerrar = () => {
    if (enviando.current) return;
    const hayCambios = JSON.stringify(form) !== JSON.stringify(inicial.form);
    if (!hayCambios || window.confirm("¿Cerrar sin guardar los cambios?")) onCerrar();
  };
  const alCerrar = useRef(cerrar);
  useEffect(() => {
    alCerrar.current = cerrar;
  });
  useEffect(() => {
    const anterior = document.activeElement as HTMLElement | null;
    primero.current?.focus();
    const alTeclear = (e: KeyboardEvent) => e.key === "Escape" && alCerrar.current();
    window.addEventListener("keydown", alTeclear);
    return () => {
      window.removeEventListener("keydown", alTeclear);
      anterior?.focus?.();
    };
  }, []);

  const cambiar = <K extends keyof FormularioDePlan>(c: K, valor: FormularioDePlan[K]) =>
    setForm((f) => ({ ...f, [c]: valor }));
  const cambiarNivel = (n: Nivel, c: "tareas" | "repuestos", valor: string) =>
    setForm((f) => ({
      ...f,
      niveles: { ...f.niveles, [n]: { ...f.niveles[n], [c]: valor } },
    }));

  const enviar = async (e: FormEvent) => {
    e.preventDefault();
    if (enviando.current) return;
    const problema = problemaDelPlan(form, editando);
    if (problema) return setError(problema);
    setError(null);
    enviando.current = true;
    setGuardando(true);
    try {
      const cuerpo = cuerpoDelPlan(form);
      const guardado =
        inicial.id === undefined
          ? await crearPlan(cuerpo)
          : await actualizarPlan(inicial.id, { ...cuerpo, version: inicial.version! });
      onGuardado(guardado.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar.");
      onRechazado();
    } finally {
      enviando.current = false;
      setGuardando(false);
    }
  };

  const un = unidadDe(form.medida);
  return (
    <div className="fixed inset-0 z-[100] grid place-items-center bg-slate-900/60 p-2 sm:p-4">
      <form
        ref={ventana}
        role="dialog"
        aria-modal="true"
        aria-labelledby="form-plan-titulo"
        onSubmit={enviar}
        noValidate
        className="flex max-h-[94vh] w-full max-w-[640px] flex-col overflow-hidden rounded-[13px] bg-white shadow-xl"
      >
        <header className="flex items-start justify-between border-b border-slate-200 px-4 pb-4 pt-5 sm:px-[22px]">
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-slate-500">
              {editando ? "Editar" : "Nuevo registro"}
            </p>
            <h2 id="form-plan-titulo" className="mt-1 text-[19px] font-semibold text-slate-900">
              {editando ? "Editar plan" : "Nuevo plan"}
            </h2>
          </div>
          <button
            type="button"
            onClick={cerrar}
            aria-label="Cerrar"
            className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
          >
            <X size={20} />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 sm:p-[22px]">
          <div className="grid grid-cols-1 gap-[15px] sm:grid-cols-2">
            <label className={etiqueta}>
              Tipo de equipo
              <input
                ref={primero}
                value={form.tipo}
                onChange={(e) => cambiar("tipo", e.target.value)}
                maxLength={60}
                list="tipos-sin-plan"
                placeholder="Ej. Volquete"
                className={campo}
              />
              <datalist id="tipos-sin-plan">
                {tiposSinPlan.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            </label>
            <label className={etiqueta}>
              Se mide con
              <select
                value={form.medida}
                onChange={(e) => cambiar("medida", e.target.value as Medida)}
                className={campo}
              >
                <option value="horometro">Horómetro (horas)</option>
                <option value="odometro">Odómetro (km)</option>
              </select>
            </label>
            <label className={etiqueta}>
              Un servicio cada ({un})
              <input
                value={form.intervalo}
                onChange={(e) => cambiar("intervalo", e.target.value)}
                inputMode="numeric"
                placeholder={form.medida === "horometro" ? "Ej. 250" : "Ej. 5000"}
                className={campo}
              />
            </label>
            <label className={etiqueta}>
              Avisar «Próximo» cuando falten ({un})
              <input
                value={form.aviso}
                onChange={(e) => cambiar("aviso", e.target.value)}
                inputMode="numeric"
                placeholder={editando ? "0 = sin aviso" : "Vacío = 10 % del intervalo"}
                className={campo}
              />
            </label>
          </div>

          <fieldset className="rounded-lg border border-slate-200 p-3">
            <legend className="px-1 text-[11px] font-semibold text-slate-500">
              Ciclo (en orden; al terminar vuelve a empezar)
            </legend>
            <ol aria-label="Servicios del ciclo" className="flex flex-wrap gap-2">
              {form.ciclo.map((n, i) => (
                <li key={i}>
                  <button
                    type="button"
                    aria-label={`Quitar el paso ${i + 1} (MP${n})`}
                    onClick={() =>
                      cambiar(
                        "ciclo",
                        form.ciclo.filter((_, j) => j !== i)
                      )
                    }
                    className="flex min-h-[44px] items-center gap-1 rounded-lg border border-slate-200 px-2 hover:bg-slate-50 sm:min-h-9"
                  >
                    <ChipDeNivel nivel={n} />
                    <X size={13} className="text-slate-400" />
                  </button>
                </li>
              ))}
              {form.ciclo.length === 0 && (
                <li className="text-sm text-slate-500">Todavía no hay servicios.</li>
              )}
            </ol>
            <div className="mt-3 flex flex-wrap gap-2">
              {([1, 2, 3] as Nivel[]).map((n) => (
                <button
                  key={n}
                  type="button"
                  disabled={form.ciclo.length >= MAX_PASOS}
                  onClick={() => cambiar("ciclo", [...form.ciclo, n])}
                  className={`${secundario} flex items-center gap-1`}
                >
                  <Plus size={14} /> MP{n}
                </button>
              ))}
            </div>
          </fieldset>

          {nivelesDelCiclo(form.ciclo).map((n) => (
            <fieldset key={n} className="rounded-lg border border-slate-200 p-3">
              <legend className="px-1 text-xs font-semibold text-slate-800">
                MP{n} · {NOMBRE_DE_NIVEL[n]}
              </legend>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className={etiqueta}>
                  Tareas del MP{n} (una por renglón)
                  <textarea
                    value={form.niveles[n].tareas}
                    onChange={(e) => cambiarNivel(n, "tareas", e.target.value)}
                    rows={4}
                    placeholder={"Ej. Cambio de aceite\nEngrase general"}
                    className={area}
                  />
                </label>
                <label className={etiqueta}>
                  Repuestos del MP{n} (opcional)
                  <textarea
                    value={form.niveles[n].repuestos}
                    onChange={(e) => cambiarNivel(n, "repuestos", e.target.value)}
                    rows={4}
                    placeholder="Ej. Filtro de aceite × 1"
                    className={area}
                  />
                </label>
              </div>
            </fieldset>
          ))}
          <p className="text-xs text-slate-500">
            Cada nivel suma sus tareas a las del anterior: escribe solo las que agrega.
          </p>
        </div>

        <footer className="space-y-2 border-t border-slate-200 px-4 py-3.5 sm:px-[22px]">
          {error && (
            <p
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"
            >
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={cerrar} className={secundario}>
              Cancelar
            </button>
            <button
              type="submit"
              disabled={guardando}
              className="min-h-[44px] rounded-lg bg-[#a3e635] px-4 text-sm font-semibold text-black hover:bg-[#bef264] disabled:opacity-60 sm:min-h-10"
            >
              {guardando ? "Guardando…" : "Guardar plan"}
            </button>
          </div>
        </footer>
      </form>
    </div>
  );
}
