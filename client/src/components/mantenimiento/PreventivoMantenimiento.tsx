// client/src/components/mantenimiento/PreventivoMantenimiento.tsx
//
// «Mantenimiento preventivo» dentro del ecosistema, pestaña Planes (como la maqueta): a la izquierda los planes,
// uno por tipo de equipo; a la derecha cómo funciona el elegido, sus niveles y quién lo usa. Resumen y
// Calendario salen con «Pronto». Es propio de Mantenimiento: no necesita ningún otro módulo. Se lee con señal.
import { useCallback, useEffect, useRef, useState } from "react";

import DetalleDelPlan from "./DetalleDelPlan";
import { listarPlanes, resumenPreventivo } from "./mantenimientoApi";
import PanelDeNivel from "./PanelDeNivel";
import {
  antetitulo,
  caja,
  cantidad,
  numero,
  preventivoEsNuevo,
  unidadDe,
  type EquipoConPlan,
  type ListaDePlanes,
  type Nivel,
} from "./planesPreventivo";

/** En el celular las tres pestañas caben en una línea. */
const PESTANA =
  "flex min-h-[44px] items-center gap-1 whitespace-nowrap px-1 text-xs font-semibold sm:gap-2 sm:px-3 sm:text-sm";

export default function PreventivoMantenimiento() {
  const [datos, setDatos] = useState<(ListaDePlanes & { equipos: EquipoConPlan[] }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elegido, setElegido] = useState<number | null>(null);
  const [nivel, setNivel] = useState<Nivel | null>(null);

  // Solo vale la última lectura pedida.
  const ultima = useRef(0);
  const cargar = useCallback(() => {
    const esta = ++ultima.current;
    setError(null);
    Promise.all([listarPlanes(), resumenPreventivo()])
      .then(([lista, resumen]) => {
        if (esta === ultima.current) setDatos({ ...lista, equipos: resumen.equipos });
      })
      .catch((e: unknown) => {
        if (esta === ultima.current) setError(e instanceof Error ? e.message : "Error");
      });
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargar();
  }, [cargar]);

  const plan = datos?.planes.find((p) => p.id === elegido) ?? datos?.planes[0];
  const suyos = datos?.equipos.filter((e) => e.plan_id === plan?.id) ?? [];

  return (
    <div className="space-y-4">
      <header>
        <p className={antetitulo}>Preventivo / Planes</p>
        <h1 className="text-2xl font-semibold text-slate-900">Planes MP1 · MP2 · MP3</h1>
        <p className="text-sm text-slate-600">
          Elige un tipo de equipo para ver cada cuánto le toca servicio. Toca un nivel para ver sus
          tareas y repuestos.
        </p>
      </header>

      <div
        role="tablist"
        aria-label="Preventivo"
        className="flex overflow-x-auto border-b border-slate-200 sm:gap-1"
      >
        {["Resumen", "Calendario"].map((p) => (
          <button
            key={p}
            type="button"
            role="tab"
            aria-selected={false}
            disabled
            className={`${PESTANA} text-slate-400`}
          >
            {p}
            <span className="rounded-full bg-slate-200 px-1.5 py-0.5 text-[10px] font-bold text-slate-600 sm:px-2">
              Pronto
            </span>
          </button>
        ))}
        <button
          type="button"
          role="tab"
          aria-selected
          className={`${PESTANA} -mb-px border-b-2 border-[#BADC1E] text-slate-900`}
        >
          Planes
          {datos && (
            <span className="rounded-full bg-slate-100 px-2 text-[11px] text-slate-600 max-sm:hidden">
              {datos.planes.length}
            </span>
          )}
          {preventivoEsNuevo() && (
            <span className="rounded-full bg-[#BADC1E] px-1.5 py-0.5 text-[10px] font-extrabold text-[#0A1014] sm:px-2">
              Nuevo
            </span>
          )}
        </button>
      </div>

      {error && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-xl bg-red-50 p-4 text-sm text-red-700"
        >
          <span>No se pudieron cargar los planes. {error}</span>
          <button
            type="button"
            onClick={cargar}
            className="min-h-[44px] rounded-lg border border-red-300 bg-white px-4 font-semibold sm:min-h-9"
          >
            Reintentar
          </button>
        </div>
      )}
      {!datos && !error && <p className="text-sm text-slate-500">Cargando…</p>}

      {datos && !plan && (
        <section className={`${caja} p-8 text-center`}>
          <h2 className="font-semibold text-slate-900">Todavía no hay planes</h2>
          <p className="mt-1 text-sm text-slate-600">
            {datos.tiposSinPlan.length === 0
              ? "Primero registra tus equipos: cada plan es para un tipo de equipo."
              : "Crear planes desde esta pantalla llega en la próxima entrega."}
          </p>
        </section>
      )}

      {datos && plan && (
        <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[260px_minmax(0,1fr)]">
          {/* Dos columnas recién desde `xl`: con el menú al lado, en 1024 px la tabla se cortaba. */}
          <nav
            aria-label="Planes por tipo de equipo"
            className="flex min-w-0 gap-2 overflow-x-auto pb-1 xl:flex-col xl:overflow-visible"
          >
            {datos.planes.map((p) => {
              const activo = p.id === plan.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  aria-current={activo ? "true" : undefined}
                  onClick={() => setElegido(p.id)}
                  className={`flex max-w-[260px] shrink-0 items-center gap-3 rounded-xl border p-3 text-left ${
                    activo
                      ? "border-lime-700 bg-lime-100"
                      : "border-slate-200 bg-white hover:bg-slate-50"
                  }`}
                >
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-slate-100 text-[11px] font-extrabold text-lime-700">
                    {p.tipo_equipo.slice(0, 3)}
                  </span>
                  <span className="min-w-0">
                    <b className="block break-words text-sm text-slate-900">{p.tipo_equipo}</b>
                    <small className="text-[11px] text-slate-500">
                      {cantidad(p.equipos, "equipo", "equipos")} · cada {numero(p.intervalo)}{" "}
                      {unidadDe(p.medida)}
                    </small>
                  </span>
                </button>
              );
            })}
          </nav>
          <DetalleDelPlan key={plan.id} plan={plan} equipos={suyos} onAbrirNivel={setNivel} />
        </div>
      )}

      {datos && datos.tiposSinPlan.length > 0 && (
        <section aria-label="Tipos sin plan" className={`${caja} p-4`}>
          <p className={antetitulo}>Tipos de equipo sin plan</p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {datos.tiposSinPlan.map((t) => (
              <li
                key={t.tipo}
                className="max-w-full break-words rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-800"
              >
                {t.tipo} · {cantidad(t.equipos, "equipo", "equipos")}
              </li>
            ))}
          </ul>
        </section>
      )}

      {plan && nivel && (
        <PanelDeNivel plan={plan} nivel={nivel} equipos={suyos} onCerrar={() => setNivel(null)} />
      )}
    </div>
  );
}
