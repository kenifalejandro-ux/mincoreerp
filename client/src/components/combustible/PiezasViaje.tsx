// Piezas del tablero de un viaje que usan gerencia (DetalleViaje) y el
// conductor (MiViaje): la ruta como barra de avance y la línea de tiempo.
import { Droplets, Flag, Fuel, MapPin, Play } from "lucide-react";
import type { ReactNode } from "react";

import { IconoUnidad } from "./IconoUnidad";
import {
  diaHora,
  duracion,
  fmt,
  hora,
  iniciales,
  unidadLabel,
  type FilaViaje,
  type Producto,
} from "./viajesFormato";

export interface CargaViaje {
  id: string;
  producto: Producto;
  origen: string;
  despachado_en: string;
  cantidad: string;
  unidad: string;
  serie_talonario: string | null;
  n_vale: number | null;
  tanque_nombre: string | null;
  grifo: string | null;
  lectura_horometro: string | null;
  lectura_odometro: string | null;
}

export function BarraRuta({
  origen,
  destino,
  tipoUnidad,
  inicio,
  fin,
  progreso,
  demora,
  llegadaEstimada,
  esperadoMin,
  ahora,
  nota,
}: {
  origen: string;
  destino: string;
  tipoUnidad: string | null;
  inicio: string | null;
  fin: string | null;
  progreso: number;
  demora: number;
  llegadaEstimada: number | null;
  esperadoMin: number | null;
  ahora: number;
  /** Texto chico bajo la barra (por ej. "según 4 viajes de esta ruta"). */
  nota?: string;
}) {
  return (
    <div className="mt-6">
      <div className="flex justify-between text-sm font-semibold text-white">
        <span>{origen}</span>
        <span className="flex items-center gap-1">
          <MapPin className="w-4 h-4 text-[#BADC1E]" /> {destino}
        </span>
      </div>
      <div className="relative h-2 mt-3 rounded-full bg-[#334155]">
        <div
          className={`absolute inset-y-0 left-0 rounded-full ${demora ? "bg-amber-400" : "bg-[#BADC1E]"}`}
          style={{ width: `${progreso}%` }}
        />
        <div
          className="absolute -top-3 -translate-x-1/2 rounded-lg bg-[#0D1719] border border-[#BADC1E] p-1 text-[#BADC1E]"
          style={{ left: `${Math.max(4, Math.min(96, progreso))}%` }}
        >
          <IconoUnidad tipo={tipoUnidad} className="w-4 h-4" />
        </div>
      </div>
      <div className="flex justify-between mt-3 text-xs text-[#94a3b8]">
        <span>{inicio ? `Salió ${diaHora(inicio)}` : "Aún no sale"}</span>
        <span className="text-right">
          {fin
            ? `Llegó ${diaHora(fin)}`
            : llegadaEstimada
              ? demora
                ? `Demorado ${duracion(demora)} (se esperaba ${hora(llegadaEstimada)})`
                : `Llega aprox. ${hora(llegadaEstimada)} · en ${duracion((llegadaEstimada - ahora) / 60_000)}`
              : esperadoMin
                ? `La ruta suele tomar ${duracion(esperadoMin)}`
                : "—"}
        </span>
      </div>
      {nota && <p className="mt-1 text-[11px] text-[#64748b] text-right">{nota}</p>}
    </div>
  );
}

type Evento =
  | { tipo: "salida"; t: number; c?: undefined }
  | { tipo: "llegada"; t: number; c?: undefined }
  | { tipo: "carga"; t: number; c: CargaViaje };

export function LineaTiempo({
  origen,
  destino,
  inicio,
  fin,
  cargas,
}: {
  origen: string;
  destino: string;
  inicio: number | null;
  fin: number | null;
  cargas: CargaViaje[];
}) {
  const eventos: Evento[] = [
    ...(inicio ? [{ tipo: "salida" as const, t: inicio }] : []),
    ...cargas.map((c) => ({ tipo: "carga" as const, t: Date.parse(c.despachado_en), c })),
    ...(fin ? [{ tipo: "llegada" as const, t: fin }] : []),
  ].sort((a, b) => a.t - b.t);

  return (
    <div className="rounded-2xl bg-[#0D1719] border border-[#2a2e37] p-4">
      <p className="text-[11px] uppercase tracking-widest text-[#94a3b8] mb-3">
        Movimientos del viaje
      </p>
      {eventos.length === 0 ? (
        <p className="text-sm text-[#94a3b8]">Todavía sin movimientos: el viaje no salió.</p>
      ) : (
        <ol className="relative border-l border-[#334155] ml-3 space-y-4">
          {eventos.map((e, i) => {
            const icono =
              e.tipo === "salida" ? (
                <Play className="w-3.5 h-3.5" />
              ) : e.tipo === "llegada" ? (
                <Flag className="w-3.5 h-3.5" />
              ) : e.c.producto === "urea" ? (
                <Droplets className="w-3.5 h-3.5" />
              ) : (
                <Fuel className="w-3.5 h-3.5" />
              );
            const color =
              e.tipo === "carga" && e.c.producto === "urea"
                ? "bg-sky-500 text-white"
                : "bg-[#BADC1E] text-[#0D1719]";
            return (
              <li key={i} className="ml-5">
                <span
                  className={`absolute -left-3 flex items-center justify-center w-6 h-6 rounded-full ${color}`}
                >
                  {icono}
                </span>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm text-white font-semibold">
                    {e.tipo === "salida"
                      ? `Salida de ${origen}`
                      : e.tipo === "llegada"
                        ? `Llegada a ${destino}`
                        : `${fmt(Number(e.c.cantidad), 1)} ${e.c.unidad} de ${
                            e.c.producto === "urea" ? "urea" : "combustible"
                          }`}
                  </p>
                  <span className="text-xs text-[#94a3b8] font-mono">
                    {diaHora(new Date(e.t).toISOString())}
                  </span>
                </div>
                {e.tipo === "carga" && (
                  <p className="text-xs text-[#94a3b8]">
                    {e.c.grifo ??
                      e.c.tanque_nombre ??
                      (e.c.origen === "tanqueta" ? "Tanqueta" : e.c.origen)}
                    {e.c.serie_talonario ? ` · vale ${e.c.serie_talonario}-${e.c.n_vale}` : ""}
                    {e.c.lectura_horometro
                      ? ` · horómetro ${fmt(Number(e.c.lectura_horometro), 1)}`
                      : e.c.lectura_odometro
                        ? ` · odómetro ${fmt(Number(e.c.lectura_odometro), 1)}`
                        : ""}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

/** Lo de arriba de un viaje: avatar con la unidad, nombre en grande y estado.
 *  Los `hijos` van dentro de la misma tarjeta (la barra de ruta). */
export function TarjetaViaje({
  v,
  textoEstado,
  hijos,
}: {
  v: Pick<
    FilaViaje,
    "conductor_nombre" | "equipo_tipo" | "placa_codigo" | "codigo_interno" | "estado"
  >;
  textoEstado: string;
  hijos?: ReactNode;
}) {
  const enCurso = v.estado === "en_curso";
  return (
    <div
      className={`rounded-3xl p-5 border ${
        enCurso
          ? "bg-gradient-to-br from-[#1f2b0c] to-[#0D1719] border-[#BADC1E]/40"
          : "bg-gradient-to-br from-[#16222a] to-[#0D1719] border-[#2a2e37]"
      }`}
    >
      <div className="flex items-start gap-4">
        <div className="relative shrink-0">
          <div className="w-16 h-16 rounded-full bg-[#BADC1E] text-[#0D1719] flex items-center justify-center text-xl font-extrabold tracking-tight">
            {iniciales(v.conductor_nombre)}
          </div>
          <div className="absolute -bottom-2 -right-3 rounded-lg bg-[#0D1719] border border-[#334155] p-1 text-[#BADC1E]">
            <IconoUnidad tipo={v.equipo_tipo} className="w-4 h-4" />
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <span
            className={`mb-2 inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold uppercase ${
              enCurso
                ? "bg-[#BADC1E] text-[#0D1719]"
                : v.estado === "programado"
                  ? "bg-sky-500/20 text-sky-300"
                  : v.estado === "anulado"
                    ? "bg-red-500/20 text-red-300"
                    : "bg-emerald-500/20 text-emerald-300"
            }`}
          >
            {enCurso && <span className="w-2 h-2 rounded-full bg-[#0D1719] animate-pulse" />}
            {textoEstado}
          </span>
          <p className="text-2xl font-extrabold text-white leading-tight break-words">
            {v.conductor_nombre ?? "Sin conductor"}
          </p>
          <p className="text-sm text-[#cbd5e1]">
            {unidadLabel(v)}
            {v.equipo_tipo ? ` · ${v.equipo_tipo.toLowerCase()}` : ""}
          </p>
        </div>
      </div>
      {hijos}
    </div>
  );
}

export function Tile({
  icono,
  titulo,
  valor,
  pie,
  acento = "text-[#BADC1E]",
}: {
  icono: ReactNode;
  titulo: string;
  valor: string;
  pie?: ReactNode;
  acento?: string;
}) {
  return (
    <div className="rounded-2xl bg-[#0D1719] border border-[#2a2e37] p-4 space-y-1">
      <p className="flex items-center gap-2 text-[11px] uppercase tracking-widest text-[#94a3b8]">
        <span className={acento}>{icono}</span> {titulo}
      </p>
      <p className="text-2xl font-extrabold text-white font-mono leading-tight">{valor}</p>
      {pie && <div className="text-xs text-[#94a3b8] space-x-2">{pie}</div>}
    </div>
  );
}
