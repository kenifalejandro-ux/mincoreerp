// client/src/components/mantenimiento/CentroDeMantenimiento.tsx
//
// El Centro de mantenimiento, con la disposición de la maqueta aprobada: saludo y botones de acción, las cuatro
// cifras, «Requieren tu atención», «Estado de la flota», la actividad del turno, las órdenes por tipo y el
// estado por área. La actividad se lee aparte (ActividadDelTurno.tsx). Lo que viene de Checklists u Órdenes de trabajo solo se dibuja si la persona tiene el módulo
// (el servidor lo manda en null si no); lo que aún no se construye ocupa su sitio con «Pronto» y no inventa
// cifras. Las piezas están en PanelesDelCentro.tsx.
import { CalendarClock, ClipboardCheck, Clock, Plus, Tractor, Truck, Wrench } from "lucide-react";

import ActividadDelTurno from "./ActividadDelTurno";
import {
  avisosDelCentro,
  fechaLarga,
  notaDeEstados,
  notaDeSinChecklist,
  notaDeUrgentes,
  saludoSegunHora,
  type DestinoDelCentro,
} from "./centroDeMantenimiento";
import type { ResumenMantenimiento } from "./mantenimientoApi";
import {
  EstadoDeLaFlota,
  EstadoPorArea,
  OrdenesPorTipo,
  RequierenAtencion,
  Tarjeta,
  UnidadesPorEstado,
} from "./PanelesDelCentro";
import { usePuedeEscribir } from "../comunes/usePuedeEscribir";

/** Cuántas columnas llevan las cifras de arriba según cuántas se muestran. */
const COLUMNAS: Record<number, string> = {
  2: "xl:grid-cols-2",
  3: "xl:grid-cols-3",
  4: "xl:grid-cols-4",
};

export default function CentroDeMantenimiento({
  resumen,
  error,
  onIr,
  onAbrirArea,
}: {
  resumen: ResumenMantenimiento | null;
  error: string | null;
  onIr: (destino: DestinoDelCentro) => void;
  onAbrirArea: (area: string) => void;
}) {
  const ahora = new Date();
  const puedeAsignar = usePuedeEscribir("ordenes_trabajo");
  const ordenes = resumen?.ordenes ?? null;
  const checklists = resumen?.checklists ?? null;
  const aEquipos = () => onIr({ seccion: "equipos" });
  const aOrdenes = () => onIr({ modulo: "ordenes_trabajo" });

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-slate-500">
            Mantenimiento / Centro de mantenimiento
          </p>
          <h1 className="text-3xl font-semibold text-slate-900 mt-1">
            {saludoSegunHora(ahora.getHours())}
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Situación de tus unidades al {fechaLarga(ahora)}.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {ordenes && (
            <button
              disabled
              title="Llega cuando Órdenes de trabajo esté dentro del ecosistema"
              className="flex items-center gap-2 h-10 px-4 rounded-lg bg-[#BADC1E]/50 text-[#0A1014]/60 text-sm font-semibold cursor-default"
            >
              <Plus size={16} /> Nueva OT
            </button>
          )}
          <button
            disabled
            title="Llega con Mantenimiento preventivo"
            className="flex items-center gap-2 h-10 px-4 rounded-lg border border-slate-300 bg-white text-slate-400 text-sm font-semibold cursor-default"
          >
            <CalendarClock size={16} /> Programar MP
          </button>
        </div>
      </header>

      {error && (
        <p
          role="alert"
          className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3"
        >
          {resumen ? "No se pudo actualizar; ves los datos de la última lectura. " : ""}
          {error}
        </p>
      )}

      {resumen && resumen.total === 0 && (
        <section className="bg-white border border-slate-200 rounded-xl shadow-sm p-8 text-center">
          <span className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full bg-[#BADC1E]/25 text-[#3f6212]">
            <Truck size={22} />
          </span>
          <h2 className="text-lg font-semibold text-slate-900">Todavía no hay equipos</h2>
          <p className="mt-1 mb-4 text-sm text-slate-500">
            Regístralos uno por uno o impórtalos desde un Excel.
          </p>
          <button
            onClick={aEquipos}
            className="h-10 px-5 rounded-lg bg-[#BADC1E] text-[#0A1014] text-sm font-semibold hover:brightness-95"
          >
            Ir a Equipos
          </button>
        </section>
      )}

      {resumen && resumen.total > 0 && (
        <>
          <section
            aria-label="Resumen del mantenimiento"
            className={`grid grid-cols-1 sm:grid-cols-2 gap-4 ${
              COLUMNAS[2 + (ordenes ? 1 : 0) + (checklists ? 1 : 0)]
            }`}
          >
            <Tarjeta
              etiqueta="Unidades operativas"
              valor={`${resumen.estados.operativas} de ${resumen.total}`}
              nota={notaDeEstados(resumen.estados)}
              Icono={Tractor}
              tono="green"
              onClick={aEquipos}
            />
            {ordenes && (
              <Tarjeta
                etiqueta="Órdenes abiertas"
                valor={ordenes.abiertas}
                nota={notaDeUrgentes(ordenes.urgentes)}
                Icono={Wrench}
                tono="amber"
                onClick={aOrdenes}
              />
            )}
            <Tarjeta
              etiqueta="Preventivos vencidos"
              valor="—"
              nota="Llega con Mantenimiento preventivo"
              Icono={Clock}
              tono="red"
            />
            {checklists && (
              <Tarjeta
                etiqueta="Checklists de hoy"
                valor={`${checklists.hechos_hoy} de ${resumen.total}`}
                nota={notaDeSinChecklist(checklists.sin_checklist_hoy.total)}
                Icono={ClipboardCheck}
                tono="blue"
                onClick={() => onIr({ modulo: "checklists" })}
              />
            )}
          </section>

          <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)] gap-4">
            <RequierenAtencion avisos={avisosDelCentro(resumen, puedeAsignar)} onIr={onIr} />
            <EstadoDeLaFlota resumen={resumen} />
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] gap-4">
            <ActividadDelTurno />
            {ordenes ? (
              <OrdenesPorTipo delMes={ordenes.del_mes} onVer={aOrdenes} />
            ) : (
              <UnidadesPorEstado estados={resumen.estados} />
            )}
          </div>

          <EstadoPorArea resumen={resumen} onAbrir={onAbrirArea} />
        </>
      )}

      {!resumen && !error && (
        <p className="text-sm text-slate-500 flex items-center gap-2">
          <Wrench size={14} /> Cargando…
        </p>
      )}
    </div>
  );
}
