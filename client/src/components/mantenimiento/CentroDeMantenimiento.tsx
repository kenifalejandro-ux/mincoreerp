// client/src/components/mantenimiento/CentroDeMantenimiento.tsx
//
// El Centro de mantenimiento, con la disposición de la maqueta aprobada: saludo y botones de acción, cuatro
// tarjetas con su ícono, «Requieren tu atención», «Estado de la flota», la actividad del turno, las órdenes por
// tipo y los equipos por área. Lo que ya tiene datos (los equipos, su reparto, las unidades por completar)
// muestra datos reales; lo que depende de módulos que llegan después ocupa su sitio con «Pronto» y no inventa
// cifras.
import {
  Check,
  ChevronRight,
  ClipboardCheck,
  Clock,
  MapPin,
  Plus,
  Tractor,
  Truck,
  Wrench,
  CalendarClock,
  type LucideIcon,
} from "lucide-react";

import {
  avisosDelCentro,
  fechaLarga,
  repartoPorArea,
  saludoSegunHora,
} from "./centroDeMantenimiento";
import type { ResumenMantenimiento } from "./mantenimientoApi";

type Tono = "green" | "amber" | "red" | "blue";
const TONOS: Record<Tono, string> = {
  green: "bg-emerald-50 text-emerald-600",
  amber: "bg-amber-50 text-amber-600",
  red: "bg-red-50 text-red-600",
  blue: "bg-blue-50 text-blue-600",
};

function Pronto() {
  return (
    <span className="px-2 py-0.5 rounded-full bg-slate-100 text-[10px] font-bold text-slate-500">
      Pronto
    </span>
  );
}

function Tarjeta({
  etiqueta,
  valor,
  nota,
  Icono,
  tono,
}: {
  etiqueta: string;
  valor: string | number;
  nota: string;
  Icono: LucideIcon;
  tono: Tono;
}) {
  return (
    <article className="flex items-center gap-4 bg-white border border-slate-200 rounded-xl shadow-sm px-5 py-4">
      <span className={`w-12 h-12 rounded-xl grid place-items-center shrink-0 ${TONOS[tono]}`}>
        <Icono size={22} />
      </span>
      <div className="min-w-0">
        <span className="text-xs font-semibold text-slate-500">{etiqueta}</span>
        <b className="block text-[28px] leading-tight font-extrabold text-slate-900">{valor}</b>
        <small className="text-[11px] text-slate-500">{nota}</small>
      </div>
    </article>
  );
}

function PanelProximo({
  kicker,
  titulo,
  texto,
  Icono,
}: {
  kicker: string;
  titulo: string;
  texto: string;
  Icono: LucideIcon;
}) {
  return (
    <section className="bg-white border border-slate-200 rounded-xl shadow-sm">
      <div className="flex items-start justify-between px-5 py-4 border-b border-slate-200">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-slate-500">
            {kicker}
          </p>
          <h2 className="text-lg font-semibold text-slate-900">{titulo}</h2>
        </div>
        <Pronto />
      </div>
      <div className="px-5 py-8 text-center">
        <span className="mx-auto mb-2 grid h-10 w-10 place-items-center rounded-full bg-slate-100 text-slate-400">
          <Icono size={18} />
        </span>
        <p className="text-sm text-slate-500 max-w-xs mx-auto">{texto}</p>
      </div>
    </section>
  );
}

export default function CentroDeMantenimiento({
  resumen,
  error,
  onIr,
}: {
  resumen: ResumenMantenimiento | null;
  error: string | null;
  onIr: (id: string) => void;
}) {
  const ahora = new Date();
  const reparto = resumen ? repartoPorArea(resumen) : [];
  const avisos = resumen ? avisosDelCentro(resumen) : [];

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
          <button
            disabled
            title="Llega con Órdenes de trabajo"
            className="flex items-center gap-2 h-10 px-4 rounded-lg bg-[#BADC1E]/50 text-[#0A1014]/60 text-sm font-semibold cursor-default"
          >
            <Plus size={16} /> Nueva OT
          </button>
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
            onClick={() => onIr("equipos")}
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
            className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4"
          >
            <Tarjeta
              etiqueta="Equipos registrados"
              valor={resumen.total}
              nota={`${resumen.propios} propios · ${resumen.alquilados} alquilados`}
              Icono={Tractor}
              tono="green"
            />
            <Tarjeta
              etiqueta="Órdenes abiertas"
              valor="—"
              nota="Llega con Órdenes de trabajo"
              Icono={Wrench}
              tono="amber"
            />
            <Tarjeta
              etiqueta="Preventivos vencidos"
              valor="—"
              nota="Llega con Mantenimiento preventivo"
              Icono={Clock}
              tono="red"
            />
            <Tarjeta
              etiqueta="Checklists de hoy"
              valor="—"
              nota="Llega con Checklists"
              Icono={ClipboardCheck}
              tono="blue"
            />
          </section>

          <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] gap-5">
            <section className="bg-white border border-slate-200 rounded-xl shadow-sm">
              <div className="px-5 py-4 border-b border-slate-200">
                <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-slate-500">
                  Prioridades
                </p>
                <h2 className="text-lg font-semibold text-slate-900">Requieren tu atención</h2>
              </div>
              {avisos.length === 0 ? (
                <div className="flex items-center gap-4 px-5 py-4">
                  <span className={`w-10 h-10 rounded-xl grid place-items-center ${TONOS.green}`}>
                    <Check size={18} />
                  </span>
                  <div>
                    <b className="block text-sm text-slate-900">Nada pendiente por ahora</b>
                    <span className="text-xs text-slate-500">
                      Los equipos tienen su área y no hay unidades de Operaciones por completar.
                    </span>
                  </div>
                </div>
              ) : (
                <ul>
                  {avisos.map((a) => (
                    <li
                      key={a.id}
                      className="flex items-center gap-4 px-5 py-4 border-b border-slate-100 last:border-b-0"
                    >
                      <span
                        className={`w-10 h-10 rounded-xl grid place-items-center shrink-0 ${
                          a.tono === "blue" ? TONOS.blue : TONOS.amber
                        }`}
                      >
                        {a.icono === "operaciones" ? <Truck size={18} /> : <MapPin size={18} />}
                      </span>
                      <div className="min-w-0 flex-1">
                        <b className="block text-sm text-slate-900">{a.titulo}</b>
                        <span className="text-xs text-slate-500">{a.detalle}</span>
                      </div>
                      <button
                        onClick={() => onIr(a.destino)}
                        className="flex items-center gap-1 text-sm font-semibold text-[#4d7c0f] hover:underline shrink-0"
                      >
                        {a.accion} <ChevronRight size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <PanelProximo
              kicker="Disponibilidad"
              titulo="Estado de la flota"
              texto="Cuántas unidades están operando, detenidas o en el taller. Llega con las órdenes y los checklists."
              Icono={Truck}
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <PanelProximo
              kicker="Flujo integrado"
              titulo="Actividad del turno"
              texto="Lo que pasó hoy: checklists, órdenes y preventivos en una sola línea de tiempo."
              Icono={ClipboardCheck}
            />
            <PanelProximo
              kicker="Distribución"
              titulo="Órdenes por tipo"
              texto="Correctivas, preventivas y de inspección, de un vistazo."
              Icono={Wrench}
            />
          </div>

          <section className="bg-white border border-slate-200 rounded-xl shadow-sm">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-slate-500">
                  Dónde trabajan
                </p>
                <h2 className="text-lg font-semibold text-slate-900">Equipos por área</h2>
              </div>
              <button
                onClick={() => onIr("equipos")}
                className="flex items-center gap-1 text-sm font-semibold text-[#4d7c0f] hover:underline"
              >
                Ver equipos <ChevronRight size={16} />
              </button>
            </div>
            <ul className="p-5 space-y-3">
              {reparto.map((r) => (
                <li
                  key={r.nombre}
                  className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-3"
                >
                  <span className="truncate text-sm text-slate-700">{r.nombre}</span>
                  <span className="h-2.5 rounded-full bg-slate-100 overflow-hidden">
                    <span
                      className="block h-full rounded-full bg-[#84cc16]"
                      style={{ width: `${r.porcentaje}%` }}
                    />
                  </span>
                  <b className="text-sm text-slate-900">{r.equipos}</b>
                </li>
              ))}
            </ul>
          </section>
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
