// client/src/components/mantenimiento/PanelesDelCentro.tsx
//
// Las piezas del Centro de control, con la disposición de la maqueta aprobada. Solo dibujan: las cifras y los
// textos salen de centroDeMantenimiento.ts.
import {
  ArrowRight,
  Check,
  ChevronRight,
  ClipboardCheck,
  Clock,
  MapPin,
  Truck,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import {
  anilloDeOrdenes,
  COLOR_CORRECTIVO,
  COLOR_PREVENTIVO,
  notaDeEstados,
  porcentaje,
  resumenDeArea,
  type AvisoDelCentro,
  type ColorDeBarra,
  type DestinoDelCentro,
  type TonoDeArea,
  TONOS,
  type Tono,
} from "./centroDeMantenimiento";
import type { ResumenMantenimiento } from "./mantenimientoApi";

const PUNTO: Record<TonoDeArea, string> = {
  green: "bg-[#84cc16]",
  amber: "bg-amber-500",
  red: "bg-red-600",
};
const BARRA: Record<ColorDeBarra, string> = {
  operativa: "bg-[#84cc16]",
  en_mantenimiento: "bg-amber-500",
  detenida: "bg-red-600",
  alquilada: "bg-slate-400",
};
const ICONO_DE_AVISO: Record<AvisoDelCentro["icono"], LucideIcon> = {
  orden: Wrench,
  checklist: ClipboardCheck,
  reloj: Clock,
  operaciones: Truck,
  area: MapPin,
};

export function Pronto() {
  return (
    <span className="px-2 py-0.5 rounded-full bg-slate-100 text-[10px] font-bold text-slate-500">
      Pronto
    </span>
  );
}

export function Panel({
  kicker,
  titulo,
  extra,
  children,
}: {
  kicker: string;
  titulo: string;
  extra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="min-w-0 bg-white border border-slate-200 rounded-xl shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-4 border-b border-slate-200">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-slate-500">
            {kicker}
          </p>
          <h2 className="text-lg font-semibold text-slate-900">{titulo}</h2>
        </div>
        {extra}
      </div>
      {children}
    </section>
  );
}

const Periodo = ({ texto }: { texto: string }) => (
  <span className="rounded-md bg-slate-100 px-2 py-1 text-[11px] text-slate-500">{texto}</span>
);

/** Una de las cuatro cifras de arriba. Sin `onClick` es solo informativa. */
export function Tarjeta({
  etiqueta,
  valor,
  nota,
  Icono,
  tono,
  onClick,
}: {
  etiqueta: string;
  valor: string | number;
  nota: string;
  Icono: LucideIcon;
  tono: Tono;
  onClick?: () => void;
}) {
  const clases =
    "flex items-center gap-4 bg-white border border-slate-200 rounded-xl shadow-sm px-5 py-4 text-left";
  const contenido = (
    <>
      <span className={`w-12 h-12 rounded-xl grid place-items-center shrink-0 ${TONOS[tono]}`}>
        <Icono size={22} />
      </span>
      <span className="min-w-0">
        <span className="block text-xs font-semibold text-slate-500">{etiqueta}</span>
        <b className="block text-[28px] leading-tight font-extrabold text-slate-900">{valor}</b>
        <span className="block text-[11px] leading-4 text-slate-500">{nota}</span>
      </span>
    </>
  );
  return onClick ? (
    <button type="button" onClick={onClick} className={`${clases} hover:border-slate-400`}>
      {contenido}
    </button>
  ) : (
    <article className={clases}>{contenido}</article>
  );
}

export function RequierenAtencion({
  avisos,
  onIr,
}: {
  avisos: AvisoDelCentro[];
  onIr: (destino: DestinoDelCentro) => void;
}) {
  return (
    <Panel kicker="Prioridades" titulo="Requieren tu atención">
      {avisos.length === 0 ? (
        <div className="flex items-center gap-4 px-5 py-4">
          <span className={`w-10 h-10 rounded-xl grid place-items-center ${TONOS.green}`}>
            <Check size={18} />
          </span>
          <div>
            <b className="block text-sm text-slate-900">Nada pendiente por ahora</b>
            <span className="text-xs text-slate-500">No hay nada que atender.</span>
          </div>
        </div>
      ) : (
        <ul>
          {avisos.map((a) => {
            const Icono = ICONO_DE_AVISO[a.icono];
            return (
              <li
                key={a.id}
                className="flex flex-wrap sm:flex-nowrap items-center gap-x-4 gap-y-1 px-5 py-4 border-b border-slate-100 last:border-b-0"
              >
                <span
                  className={`w-10 h-10 rounded-xl grid place-items-center shrink-0 ${TONOS[a.tono]}`}
                >
                  <Icono size={18} />
                </span>
                <div className="min-w-0 flex-1">
                  <b className="block text-sm text-slate-900">{a.titulo}</b>
                  <span className="block break-words text-xs text-slate-500">{a.detalle}</span>
                </div>
                <button
                  type="button"
                  onClick={() => onIr(a.destino)}
                  className="flex w-full sm:w-auto items-center justify-end gap-1 min-h-[44px] sm:min-h-0 text-sm font-semibold text-[#4d7c0f] hover:underline shrink-0"
                >
                  {a.accion} <ChevronRight size={14} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

function Medida({ nombre, valor }: { nombre: string; valor: number | null }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between text-xs text-slate-500">
        <span>{nombre}</span>
        {valor === null ? <Pronto /> : <b className="text-slate-900">{valor}%</b>}
      </div>
      <span className="block h-1.5 rounded-full bg-slate-100 overflow-hidden">
        <span
          className="block h-full rounded-full bg-[#84cc16]"
          style={{ width: `${valor ?? 0}%` }}
        />
      </span>
    </div>
  );
}

export function EstadoDeLaFlota({ resumen }: { resumen: ResumenMantenimiento }) {
  const { estados, total, ordenes, checklists } = resumen;
  const operativas = porcentaje(estados.operativas, total);
  return (
    <Panel kicker="Disponibilidad" titulo="Estado de la flota" extra={<Periodo texto="Hoy" />}>
      <div className="flex items-center gap-4 px-5 pt-4">
        <div
          className="relative grid h-24 w-24 shrink-0 place-items-center rounded-full"
          style={{
            background: `conic-gradient(#84cc16 0 ${operativas}%, #e2e8f0 ${operativas}% 100%)`,
          }}
        >
          <div className="grid h-20 w-20 place-content-center rounded-full bg-white text-center">
            <strong className="text-2xl leading-none font-extrabold text-slate-900">
              {operativas}
            </strong>
            <span className="text-[10px] text-slate-500">% operativas</span>
          </div>
        </div>
        <div className="min-w-0">
          <b className="block text-sm text-slate-900">
            {estados.operativas} de {total} {total === 1 ? "unidad" : "unidades"} operando
          </b>
          <p className="mt-1 text-xs text-slate-500">
            {ordenes || checklists
              ? notaDeEstados(estados)
              : "Sin órdenes de trabajo ni checklists, todas figuran operativas."}
          </p>
        </div>
      </div>
      <div className="grid gap-3 px-5 py-4">
        <Medida nombre="Unidades operativas" valor={operativas} />
        {checklists && (
          <Medida nombre="Checklists hechos hoy" valor={porcentaje(checklists.hechos_hoy, total)} />
        )}
        <Medida nombre="Preventivos al día (propias)" valor={null} />
      </div>
    </Panel>
  );
}

export function OrdenesPorTipo({
  delMes,
  onVer,
}: {
  delMes: { correctivo: number; preventivo: number };
  onVer: () => void;
}) {
  const anillo = anilloDeOrdenes(delMes);
  const leyenda = [
    { nombre: "Correctivo", cuantas: delMes.correctivo, color: COLOR_CORRECTIVO },
    { nombre: "Preventivo", cuantas: delMes.preventivo, color: COLOR_PREVENTIVO },
  ];
  return (
    <Panel kicker="Distribución" titulo="Órdenes por tipo">
      <div className="flex items-center gap-6 px-5 py-4">
        <div
          className="grid h-28 w-28 shrink-0 place-items-center rounded-full"
          style={{ background: anillo.fondo }}
        >
          <div className="grid h-20 w-20 place-content-center rounded-full bg-white text-center">
            <b className="text-2xl leading-none font-extrabold text-slate-900">{anillo.total}</b>
            <span className="text-[10px] text-slate-500">Este mes</span>
          </div>
        </div>
        <ul className="flex-1 space-y-2.5">
          {leyenda.map((l) => (
            <li key={l.nombre} className="flex items-center gap-2 text-xs">
              <i className="h-2 w-2 rounded-full" style={{ background: l.color }} />
              <span className="flex-1 text-slate-500">{l.nombre}</span>
              <b className="text-slate-900">{l.cuantas}</b>
            </li>
          ))}
        </ul>
      </div>
      <div className="px-5 pb-4">
        <button
          type="button"
          onClick={onVer}
          className="flex w-full min-h-[44px] sm:min-h-9 items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 text-xs font-bold text-[#4d7c0f] hover:bg-slate-100"
        >
          Ver órdenes de trabajo <ArrowRight size={15} />
        </button>
      </div>
    </Panel>
  );
}

/** Lo que ocupa el sitio de «Órdenes por tipo» sin el módulo Órdenes de trabajo. */
export function UnidadesPorEstado({ estados }: { estados: ResumenMantenimiento["estados"] }) {
  const filas = [
    { nombre: "Operativa", cuantas: estados.operativas, color: BARRA.operativa },
    {
      nombre: "En mantenimiento",
      cuantas: estados.en_mantenimiento,
      color: BARRA.en_mantenimiento,
    },
    { nombre: "Detenida", cuantas: estados.detenidas, color: BARRA.detenida },
  ];
  return (
    <Panel kicker="Unidades" titulo="Por estado">
      <ul className="space-y-3 px-5 py-4">
        {filas.map((f) => (
          <li key={f.nombre} className="flex items-center gap-2 text-sm">
            <i className={`h-2.5 w-2.5 rounded-full ${f.color}`} />
            <span className="flex-1 text-slate-600">{f.nombre}</span>
            <b className="text-slate-900">{f.cuantas}</b>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

export function EstadoPorArea({
  resumen,
  onAbrir,
}: {
  resumen: Pick<ResumenMantenimiento, "estado_por_area" | "meta_disponibilidad">;
  onAbrir: (area: string) => void;
}) {
  return (
    <Panel
      kicker="Salud de la operación"
      titulo="Estado por área"
      extra={<Periodo texto="Toca un área para ver sus equipos" />}
    >
      <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3 p-4">
        {resumen.estado_por_area.map((fila) => {
          const a = resumenDeArea(fila, resumen.meta_disponibilidad);
          return (
            <button
              key={a.clave}
              type="button"
              onClick={() => onAbrir(a.nombre)}
              className="flex min-w-0 flex-col gap-2 rounded-xl border border-slate-200 bg-white p-3.5 text-left hover:border-slate-400"
            >
              <span className="flex items-center gap-2">
                <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${PUNTO[a.tono]}`} />
                <b className="flex-1 truncate text-sm text-slate-900">{a.nombre}</b>
                <strong className="text-xl font-extrabold text-slate-900">
                  {a.disponibilidad} %
                </strong>
              </span>
              <span className="text-xs text-slate-500">
                {a.equipos}
                {a.detenidos && <b className="text-red-600"> · {a.detenidos}</b>}
                {a.enTaller && ` · ${a.enTaller}`}
              </span>
              <span className="flex gap-[3px]">
                {a.barras.map((b, i) => (
                  <i
                    key={i}
                    title={b.titulo}
                    className={`h-2 min-w-0 rounded-sm ${BARRA[b.color]}`}
                    style={{ flexGrow: b.peso, flexBasis: 0 }}
                  />
                ))}
              </span>
            </button>
          );
        })}
      </div>
    </Panel>
  );
}
