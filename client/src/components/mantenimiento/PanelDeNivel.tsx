// client/src/components/mantenimiento/PanelDeNivel.tsx
//
// El panel de un nivel del plan, como la maqueta: qué se hace, el kit sugerido y los equipos que usan el plan.
// Solo lectura. Los repuestos son texto del plan: no se revisa stock.
import { Check, Settings, Tractor } from "lucide-react";

import { ChipDeNivel } from "./PiezasDePreventivo";
import {
  antetitulo,
  caja,
  cantidad,
  ETIQUETA_DE_ESTADO,
  nivelQueIncluye,
  NOMBRE_DE_NIVEL,
  numero,
  unidadDe,
  vecesEnElCiclo,
  type EquipoConPlan,
  type Nivel,
  type PlanPreventivo,
} from "./planesPreventivo";
import PanelDeDetalle from "../proveedores/PanelDeDetalle";

export default function PanelDeNivel({
  plan,
  nivel,
  equipos,
  onCerrar,
}: {
  plan: PlanPreventivo;
  nivel: Nivel;
  equipos: EquipoConPlan[];
  onCerrar: () => void;
}) {
  const detalle = plan.niveles[`${nivel}`];
  const incluye = nivelQueIncluye(plan, nivel);
  if (!detalle) return null;
  return (
    <PanelDeDetalle etiqueta="Detalle del nivel" titulo="Nivel del plan" onCerrar={onCerrar}>
      <div className="space-y-4">
        <header className="flex items-start gap-4">
          <span className="grid h-14 w-14 shrink-0 place-items-center rounded-xl bg-[#0A1014] text-[#BADC1E]">
            <Settings size={22} />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="min-w-0 break-words text-2xl font-semibold text-slate-900">
                {plan.tipo_equipo} · MP{nivel}
              </h2>
              <ChipDeNivel nivel={nivel} />
            </div>
            <p className="mt-1 text-sm text-slate-600">
              {NOMBRE_DE_NIVEL[nivel]} · cada {numero(plan.intervalo)} {unidadDe(plan.medida)} (
              {vecesEnElCiclo(plan.ciclo, nivel)})
            </p>
            <p className="mt-1 flex items-center gap-1.5 text-xs text-slate-500">
              <Tractor size={14} /> {cantidad(plan.equipos, "equipo", "equipos")}
            </p>
          </div>
        </header>

        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
          <section className={`${caja} p-5`}>
            <p className={antetitulo}>Tareas</p>
            <h3 className="font-semibold text-slate-900">Qué se hace en este servicio</h3>
            {incluye && (
              <p className="mt-3 flex items-start gap-1.5 text-xs text-slate-500">
                <Check size={14} className="mt-px shrink-0 text-emerald-600" />
                <span>
                  Incluye todo lo del MP{incluye}, <b className="text-slate-800">y además:</b>
                </span>
              </p>
            )}
            <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-slate-800">
              {detalle.tareas.map((t, i) => (
                <li key={i} className="break-words">
                  {t}
                </li>
              ))}
            </ul>
          </section>

          <div className="min-w-0 space-y-4">
            <section className={`${caja} p-5`}>
              <p className={antetitulo}>Repuestos</p>
              <h3 className="font-semibold text-slate-900">Kit sugerido del servicio</h3>
              {detalle.repuestos.length === 0 ? (
                <p className="mt-3 text-sm text-slate-500">Este nivel no tiene repuestos.</p>
              ) : (
                <ul className="mt-3 flex flex-wrap gap-2">
                  {detalle.repuestos.map((r, i) => (
                    <li
                      key={i}
                      className="max-w-full break-words rounded-lg bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700"
                    >
                      {r}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className={`${caja} p-5`}>
              <p className={antetitulo}>Uso</p>
              <h3 className="font-semibold text-slate-900">Equipos con este plan</h3>
              {equipos.length === 0 ? (
                <p className="mt-3 text-sm text-slate-500">Todavía no hay equipos de este tipo.</p>
              ) : (
                <ul className="mt-3 divide-y divide-slate-100">
                  {equipos.map((e) => (
                    <li key={e.equipo_id} className="flex items-center gap-3 py-2.5">
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-slate-100 text-lime-700">
                        <Tractor size={15} />
                      </span>
                      <div className="min-w-0">
                        <b className="block break-words text-xs text-slate-900">{e.placa_codigo}</b>
                        <small className="text-[11px] text-slate-500">
                          {e.proximo ? `Próximo: MP${e.proximo.nivel} · ` : ""}
                          {ETIQUETA_DE_ESTADO[e.estado]}
                        </small>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </div>
      </div>
    </PanelDeDetalle>
  );
}
