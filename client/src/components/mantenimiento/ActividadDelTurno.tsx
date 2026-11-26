// client/src/components/mantenimiento/ActividadDelTurno.tsx
//
// «Actividad del turno» del Centro: la línea de tiempo de la maqueta, con los últimos movimientos de
// checklists y órdenes y el efecto de cada uno. Se lee al abrir el Centro; si falla, se dice y se puede
// reintentar, sin mostrar una lista vacía como si no hubiera pasado nada.
import { Check, ClipboardCheck, Link2, Wrench, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { cuandoFue, pasoDelTurno, type PasoDelTurno } from "./actividadDelTurno";
import { TONOS } from "./centroDeMantenimiento";
import { actividadDelTurno, type Movimiento } from "./mantenimientoApi";
import { Panel } from "./PanelesDelCentro";
import { marcarNovedadVista, novedadVigente } from "../controlTv/novedad";

/** La etiqueta «Nuevo» de este panel, 24 horas desde el primer clic en él. */
const NOVEDAD = "mantenimiento-actividad-2026-11";
const esNueva = () => novedadVigente(Date.now(), undefined, NOVEDAD);
const marcarVista = () => marcarNovedadVista(Date.now(), undefined, NOVEDAD);
const ICONOS: Record<PasoDelTurno["icono"], LucideIcon> = {
  checklist: ClipboardCheck,
  orden: Wrench,
  hecho: Check,
};

const Mensaje = ({ texto }: { texto: string }) => (
  <p className="px-5 py-8 text-center text-sm text-slate-500">{texto}</p>
);

export default function ActividadDelTurno() {
  const [movimientos, setMovimientos] = useState<Movimiento[] | null>(null);
  const [fallo, setFallo] = useState(false);
  // Solo vale la última lectura pedida.
  const ultima = useRef(0);

  const cargar = useCallback(() => {
    const esta = ++ultima.current;
    setFallo(false);
    actividadDelTurno()
      .then((m) => {
        if (esta === ultima.current) setMovimientos(m);
      })
      .catch(() => {
        if (esta === ultima.current) setFallo(true);
      });
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargar();
  }, [cargar]);

  return (
    <div className="grid min-w-0" onClick={marcarVista}>
      <Panel
        kicker="Flujo integrado"
        titulo="Actividad del turno"
        extra={
          esNueva() && (
            <span className="px-2 py-0.5 rounded-full bg-[#BADC1E] text-[#0A1014] text-[10px] font-extrabold">
              Nuevo
            </span>
          )
        }
      >
        {fallo ? (
          <div role="alert" className="px-5 py-8 text-center text-sm text-red-700">
            No se pudo leer la actividad.
            <button
              type="button"
              onClick={cargar}
              className="mx-auto mt-2 block min-h-[44px] sm:min-h-9 px-4 rounded-lg border border-slate-300 bg-white font-semibold text-slate-700 hover:bg-slate-50"
            >
              Reintentar
            </button>
          </div>
        ) : movimientos === null ? (
          <Mensaje texto="Cargando…" />
        ) : movimientos.length === 0 ? (
          <Mensaje texto="Sin movimientos en los últimos 7 días." />
        ) : (
          <ol className="px-5 py-4">
            {movimientos.map((m, i) => {
              const p = pasoDelTurno(m);
              const Icono = ICONOS[p.icono];
              return (
                <li key={p.clave} className="relative flex gap-3 pb-4 last:pb-0">
                  {i < movimientos.length - 1 && (
                    <span
                      aria-hidden
                      className="absolute left-4 top-9 bottom-1 w-px bg-slate-200"
                    />
                  )}
                  <span
                    className={`grid h-8 w-8 shrink-0 place-items-center rounded-full ${TONOS[p.tono]}`}
                  >
                    <Icono size={16} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <b className="text-sm text-slate-900">{p.titulo}</b>
                      <time dateTime={m.en} className="text-xs text-slate-500">
                        {cuandoFue(m.en)}
                      </time>
                    </div>
                    <span className="block break-words text-xs text-slate-500">{p.detalle}</span>
                    <span className="mt-1 flex items-start gap-1.5 text-xs font-semibold text-[#4d7c0f]">
                      <Link2 size={12} className="mt-0.5 shrink-0" />
                      <span className="min-w-0">{p.efecto}</span>
                    </span>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </Panel>
    </div>
  );
}
