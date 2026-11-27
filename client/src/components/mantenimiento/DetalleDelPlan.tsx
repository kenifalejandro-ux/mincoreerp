// client/src/components/mantenimiento/DetalleDelPlan.tsx
//
// Lo que se ve de un plan elegido, como la maqueta: cómo funciona (la regla del ciclo), qué se hace en cada
// servicio (toca un nivel para abrirlo) y quién usa el plan, con lo que le toca a cada equipo.
import { ChevronRight } from "lucide-react";

import { ChipDeEstado, ChipDeNivel } from "./PiezasDePreventivo";
import {
  antetitulo,
  BORDE_DE_NIVEL,
  caja,
  avanceDelIntervalo,
  cantidad,
  marcasDelCiclo,
  nivelesDelPlan,
  nivelQueIncluye,
  NOMBRE_DE_NIVEL,
  numero,
  textoDeFaltan,
  unidadDe,
  vecesEnElCiclo,
  type EquipoConPlan,
  type Nivel,
  type PlanPreventivo,
} from "./planesPreventivo";

const BARRA = {
  vencido: "bg-red-600",
  proximo: "bg-amber-600",
  al_dia: "bg-[#7cb518]",
  sin_datos: "bg-slate-300",
};

function ComoFunciona({ plan }: { plan: PlanPreventivo }) {
  const un = unidadDe(plan.medida);
  const marcas = marcasDelCiclo(plan);
  const ultima = marcas[marcas.length - 1];
  return (
    <section aria-label="Cómo funciona" className={`${caja} p-5`}>
      <p className={antetitulo}>Cómo funciona</p>
      <h2 className="break-words font-semibold text-slate-900">
        {plan.tipo_equipo}: un servicio cada {numero(plan.intervalo)} {un}
      </h2>
      {/* Con ciclos largos la regla se desplaza dentro de su caja: la página no se ensancha. */}
      <div className="mt-4 overflow-x-auto pb-1">
        <ol className="relative flex" style={{ minWidth: `${(marcas.length + 1) * 80}px` }}>
          <li aria-hidden className="absolute left-6 right-10 top-[30px] h-1 rounded bg-lime-300" />
          <li className="relative flex w-12 shrink-0 flex-col items-center">
            <span className="h-6" />
            <span className="h-4 w-4 rounded-full border-[3px] border-[#7cb518] bg-white" />
            <small className="mt-1 text-[11px] text-slate-500">0 {un}</small>
          </li>
          {marcas.map((m, i) => (
            <li key={i} className="relative flex flex-1 flex-col items-end">
              <div className="flex w-20 flex-col items-center">
                <span className="h-6">
                  <ChipDeNivel nivel={m.nivel} />
                </span>
                <span
                  className={`h-4 w-4 rounded-full border-[3px] bg-white ${BORDE_DE_NIVEL[m.nivel]}`}
                />
                <small className="mt-1 whitespace-nowrap text-[11px] text-slate-500">
                  {numero(m.en)} {un}
                </small>
              </div>
            </li>
          ))}
        </ol>
      </div>
      <p className="mt-3 text-sm text-slate-700">
        Cada {numero(plan.intervalo)} {un} le toca un servicio, en este orden:{" "}
        <b>{plan.ciclo.map((n) => `MP${n}`).join(" → ")}</b>. Al terminar el MP{ultima.nivel} (a las{" "}
        {numero(ultima.en)} {un}) el ciclo vuelve a empezar.{" "}
        {plan.aviso_antes > 0
          ? `Se avisa «Próximo» cuando faltan ${numero(plan.aviso_antes)} ${un} o menos.`
          : "Este plan no avisa antes: pasa directo a «Vencido»."}
      </p>
    </section>
  );
}

function Niveles({ plan, onAbrir }: { plan: PlanPreventivo; onAbrir: (n: Nivel) => void }) {
  const filas = nivelesDelPlan(plan).map((nivel) => ({
    nivel,
    incluye: nivelQueIncluye(plan, nivel),
    cuando: vecesEnElCiclo(plan.ciclo, nivel),
    tareas: plan.niveles[`${nivel}`]!.tareas.length,
    repuestos: plan.niveles[`${nivel}`]!.repuestos.length,
  }));
  const repuestos = (n: number) => (n === 0 ? "—" : cantidad(n, "sugerido", "sugeridos"));
  return (
    <section aria-label="Niveles del plan" className={`${caja} overflow-hidden`}>
      <div className="flex flex-wrap items-end justify-between gap-2 p-5 pb-3">
        <div>
          <p className={antetitulo}>Niveles del plan</p>
          <h2 className="font-semibold text-slate-900">Qué se hace en cada servicio</h2>
        </div>
        <span className="rounded-md bg-slate-100 px-2 py-1 text-[11px] text-slate-500">
          Toca un nivel para ver el detalle
        </span>
      </div>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-y border-slate-200 bg-slate-50 text-left text-[10px] uppercase tracking-wider text-slate-500">
              <th className="px-4 py-3">Nivel</th>
              <th className="px-4 py-3">Cuándo toca</th>
              <th className="px-4 py-3">Tareas</th>
              <th className="px-4 py-3">Repuestos</th>
              <th className="w-12" />
            </tr>
          </thead>
          <tbody>
            {filas.map((f) => (
              <tr
                key={f.nivel}
                onClick={() => onAbrir(f.nivel)}
                className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50"
              >
                <td className="px-4 py-3">
                  <span className="flex items-center gap-2">
                    <ChipDeNivel nivel={f.nivel} />
                    <b className="text-slate-900">{NOMBRE_DE_NIVEL[f.nivel]}</b>
                  </span>
                </td>
                <td className="px-4 py-3 text-slate-700">{f.cuando}</td>
                <td className="px-4 py-3">
                  <b className="text-slate-900">{f.tareas}</b>
                  {f.incluye && (
                    <small className="block text-slate-500">+ todo lo del MP{f.incluye}</small>
                  )}
                </td>
                <td className="px-4 py-3 text-slate-700">{repuestos(f.repuestos)}</td>
                <td className="px-2 py-3">
                  <button
                    type="button"
                    aria-label={`Ver el MP${f.nivel}`}
                    className="grid h-9 w-9 place-items-center rounded-full text-slate-500 hover:bg-slate-100"
                  >
                    <ChevronRight size={16} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="space-y-2 p-3 pt-0 md:hidden">
        {filas.map((f) => (
          <li key={f.nivel}>
            <button
              type="button"
              aria-label={`Ver el MP${f.nivel}`}
              onClick={() => onAbrir(f.nivel)}
              className="w-full rounded-lg border border-slate-200 p-3 text-left"
            >
              <span className="flex items-center gap-2 border-b border-slate-100 pb-2">
                <ChipDeNivel nivel={f.nivel} />
                <b className="flex-1 text-sm text-slate-900">{NOMBRE_DE_NIVEL[f.nivel]}</b>
                <ChevronRight size={16} className="text-slate-500" />
              </span>
              {[
                ["Cuándo toca", f.cuando],
                [
                  "Tareas",
                  f.incluye ? `${f.tareas} + todo lo del MP${f.incluye}` : String(f.tareas),
                ],
                ["Repuestos", repuestos(f.repuestos)],
              ].map(([etiqueta, valor]) => (
                <span key={etiqueta} className="mt-2 flex justify-between gap-3 text-xs">
                  <span className="uppercase tracking-wide text-slate-500">{etiqueta}</span>
                  <span className="text-right text-slate-800">{valor}</span>
                </span>
              ))}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function QuienUsa({ plan, equipos }: { plan: PlanPreventivo; equipos: EquipoConPlan[] }) {
  return (
    <section aria-label="Quién usa este plan" className={`${caja} p-5`}>
      <p className={antetitulo}>Quién usa este plan</p>
      <h2 className="font-semibold text-slate-900">
        {cantidad(equipos.length, "equipo", "equipos")}
      </h2>
      {equipos.length === 0 && (
        <p className="mt-2 text-sm text-slate-500">
          Ningún equipo registrado es del tipo «{plan.tipo_equipo}».
        </p>
      )}
      <ul className="mt-3 space-y-2">
        {equipos.map((e) => (
          <li
            key={e.equipo_id}
            className="grid grid-cols-1 items-center gap-2 rounded-lg border border-slate-200 p-3 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1.2fr)_minmax(0,1fr)_auto] sm:gap-4"
          >
            <div className="flex min-w-0 items-center gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-slate-100 text-[10px] font-extrabold text-lime-700">
                {e.placa_codigo.slice(0, 3).toUpperCase()}
              </span>
              <div className="min-w-0">
                <b className="block break-words text-sm text-slate-900">{e.placa_codigo}</b>
                <small className="text-[11px] text-slate-500">
                  {numero(e.lectura)} {unidadDe(e.medidor_del_equipo)}
                  {e.propiedad === "alquilada" ? " · Alquilada" : ""}
                </small>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {e.proximo && <ChipDeNivel nivel={e.proximo.nivel} />}
              <span
                className={e.estado === "vencido" ? "font-bold text-red-700" : "text-slate-700"}
              >
                {textoDeFaltan(e, plan.medida)}
              </span>
            </div>
            <div aria-hidden className="h-1.5 overflow-hidden rounded-full bg-slate-100">
              {e.proximo && (
                <div
                  className={`h-full rounded-full ${BARRA[e.estado]}`}
                  style={{ width: `${avanceDelIntervalo(e.proximo.faltan, plan.intervalo)}%` }}
                />
              )}
            </div>
            <div>
              <ChipDeEstado estado={e.estado} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function DetalleDelPlan({
  plan,
  equipos,
  onAbrirNivel,
}: {
  plan: PlanPreventivo;
  equipos: EquipoConPlan[];
  onAbrirNivel: (n: Nivel) => void;
}) {
  return (
    <div className="min-w-0 space-y-4">
      <ComoFunciona plan={plan} />
      <Niveles plan={plan} onAbrir={onAbrirNivel} />
      <QuienUsa plan={plan} equipos={equipos} />
    </div>
  );
}
