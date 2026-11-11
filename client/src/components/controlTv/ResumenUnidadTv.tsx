// Lo que la vista de una unidad suma al detalle del viaje: los viajes de su conductor, cómo rinde la
// unidad, cuánto tardó contra lo normal de su ruta, sus cargas y sus alertas abiertas. Solo lectura; los
// datos vienen de /control-tv/unidad/:id.
import {
  Ban,
  Check,
  CircleAlert,
  Droplet,
  Fuel,
  Gauge,
  Info,
  Pause,
  Route,
  TriangleAlert,
  ChartColumn,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { BarraPartida, Desvio } from "./GraficasUnidad";
import { nombreAlerta, type GravedadAlerta } from "./resumenCorporativoLogica";
import { SeccionTv } from "./SeccionTv";
import { haceCuanto } from "../combustible/ubicacionesLogica";
import { fmt } from "../combustible/viajesFormato";

export interface ResumenUnidad {
  dias: number;
  conductor: {
    dni: string;
    en_ruta: number;
    programados: number;
    terminados: number;
    anulados: number;
    como_titular: number;
    como_relevo: number;
  } | null;
  rendimiento: {
    rendimiento: { valor: number; unidad: string } | null;
    cargado_gal: number;
    vs_pares_pct: number | null;
    vs_pasado_pct: number | null;
    diagnostico: string;
  } | null;
  estadia_normal: { minutos: number; viajes: number } | null;
  ultimas_cargas: {
    producto: "combustible" | "urea";
    en: string;
    cantidad: number;
    unidad: string;
    origen: string;
  }[];
  alertas: {
    total: number;
    criticas?: number;
    ultimas: { tipo: string; creado_en: string; gravedad?: GravedadAlerta }[];
  };
}

const ROJO = "#ef2f2f";
const DIAGNOSTICO: Record<string, string> = {
  subio_y_alto: "Subió y está alto",
  subio: "Subió contra su pasado",
  alto: "Alto contra sus pares",
  bajo: "Por debajo de sus pares",
  sin_referencia: "Sin referencia todavía",
};
const ORIGEN: Record<string, string> = {
  tanqueta: "desde tanqueta",
  compra_externa: "compra en ruta",
};

/** La insignia y el ícono de cada gravedad, como en la campanita: crítica, media o info. */
const GRAVEDAD: Record<
  GravedadAlerta,
  { texto: string; Icono: LucideIcon; color: string; clase: string }
> = {
  critica: {
    texto: "Crítica",
    Icono: CircleAlert,
    color: ROJO,
    clase: "border-[#ef2f2f]/60 bg-[#ef2f2f]/25 text-[#ff5252]",
  },
  media: {
    texto: "Media",
    Icono: TriangleAlert,
    color: "#fbbf24",
    clase: "border-amber-400/50 bg-amber-400/20 text-amber-300",
  },
  info: {
    texto: "Info",
    Icono: Info,
    color: "#38bdf8",
    clase: "border-sky-400/40 bg-sky-400/15 text-sky-300",
  },
};

function Contador({
  n,
  texto,
  Icono,
  color,
}: {
  n: number;
  texto: string;
  Icono: LucideIcon;
  color: string;
}) {
  return (
    <div className="flex flex-col items-center gap-0.5 rounded-lg bg-white/[0.04] px-1 py-2 text-center">
      <Icono className="h-5 w-5" style={{ color }} aria-hidden />
      <b className="text-xl tabular-nums leading-tight" style={{ color }}>
        {n}
      </b>
      <small className="text-[10px] text-slate-400">{texto}</small>
    </div>
  );
}

/** El resumen de los viajes de la unidad (de su conductor como titular) en el período elegido. */
export function ResumenViajes({ datos }: { datos: ResumenUnidad | null }) {
  const c = datos?.conductor;
  const dias = datos?.dias ?? 30;
  return (
    <SeccionTv
      titulo={`Resumen de la unidad · ${dias === 1 ? "24 horas" : `${dias} días`}`}
      icono={<ChartColumn className="h-4 w-4 text-sky-400" aria-hidden />}
    >
      {!datos || !c ? (
        <p className="text-xs text-slate-400">
          {datos ? "Esta unidad no tiene conductor asignado." : "Cargando…"}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-4 gap-1.5">
            <Contador n={c.en_ruta} texto="En ruta" Icono={Route} color="#38bdf8" />
            <Contador n={c.programados} texto="Programados" Icono={Pause} color="#a78bfa" />
            <Contador n={c.terminados} texto="Terminados" Icono={Check} color="#34d399" />
            <Contador n={c.anulados} texto="Anulados" Icono={Ban} color={ROJO} />
          </div>
          <div className="flex flex-1 flex-col justify-center gap-2.5 text-[11.5px] text-slate-400">
            <div className="flex items-center gap-2">
              <span className="w-24 shrink-0">Estado de viajes</span>
              <BarraPartida
                partes={[
                  { n: c.en_ruta, color: "#38bdf8" },
                  { n: c.programados, color: "#a78bfa" },
                  { n: c.terminados, color: "#34d399" },
                  { n: c.anulados, color: ROJO },
                ]}
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="w-24 shrink-0">Titular / relevo</span>
              <BarraPartida
                partes={[
                  { n: c.como_titular, color: "#BADC1E" },
                  { n: c.como_relevo, color: "#8fa3a8" },
                ]}
              />
            </div>
          </div>
        </>
      )}
    </SeccionTv>
  );
}

/** Las alertas abiertas de la unidad, las más graves primero, con su insignia. */
export function AlertasActivas({ datos, ahora }: { datos: ResumenUnidad | null; ahora: number }) {
  const a = datos?.alertas;
  return (
    <SeccionTv
      titulo="Alertas activas"
      icono={<TriangleAlert className="h-4 w-4" style={{ color: ROJO }} aria-hidden />}
      derecha={
        a && a.total > 0
          ? `${a.total} abiertas${a.criticas ? ` · ${a.criticas} críticas` : ""}`
          : undefined
      }
    >
      {!a ? (
        <p className="text-xs text-slate-400">Cargando…</p>
      ) : a.total === 0 ? (
        <p className="text-sm text-emerald-300">Ninguna alerta abierta.</p>
      ) : (
        <>
          <ul className="flex flex-col">
            {a.ultimas.map((x) => {
              const g = GRAVEDAD[x.gravedad ?? "info"];
              return (
                <li
                  key={`${x.tipo}-${x.creado_en}`}
                  className="flex items-center gap-2.5 border-t border-white/10 py-1.5 first:border-t-0"
                >
                  <g.Icono
                    className="h-[17px] w-[17px] shrink-0"
                    style={{ color: g.color }}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate text-xs">{nombreAlerta(x.tipo)}</span>
                  <span className="shrink-0 text-[10.5px] text-slate-400">
                    {haceCuanto(x.creado_en, ahora)}
                  </span>
                  <span
                    className={`shrink-0 rounded-md border px-2 py-0.5 text-[10.5px] font-extrabold ${g.clase}`}
                  >
                    {g.texto}
                  </span>
                </li>
              );
            })}
          </ul>
          {a.total > a.ultimas.length && (
            <p className="text-[10.5px] text-slate-500">
              + {a.total - a.ultimas.length} más
              {a.criticas ? ` · ${a.criticas} críticas` : ""}
            </p>
          )}
        </>
      )}
    </SeccionTv>
  );
}

function Fila({
  Icono,
  color,
  titulo,
  children,
}: {
  Icono: LucideIcon;
  color: string;
  titulo: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 border-t border-white/10 py-1 text-xs first:border-t-0">
      <Icono className="h-[15px] w-[15px] shrink-0" style={{ color }} aria-hidden />
      <span className="shrink-0 whitespace-nowrap text-slate-200">{titulo}</span>
      <span className="min-w-0 flex-1 truncate text-right text-slate-400">{children}</span>
    </div>
  );
}

/** El rendimiento de la unidad (con sus desvíos en barras) y sus últimas cargas. */
export function CargasYRendimiento({
  datos,
  ahora,
}: {
  datos: ResumenUnidad | null;
  ahora: number;
}) {
  const r = datos?.rendimiento;
  const carga = (p: "combustible" | "urea") => datos?.ultimas_cargas.find((c) => c.producto === p);
  const combustible = carga("combustible");
  const urea = carga("urea");
  return (
    <SeccionTv
      titulo="Rendimiento y cargas"
      icono={<Gauge className="h-4 w-4 text-[#BADC1E]" aria-hidden />}
    >
      {!datos ? (
        <p className="text-xs text-slate-400">Cargando…</p>
      ) : (
        <>
          {r?.rendimiento ? (
            <>
              <p className="flex items-baseline gap-2">
                <b className="text-2xl leading-none text-[#BADC1E]">
                  {fmt(r.rendimiento.valor, 1)}
                </b>
                <span className="text-[11.5px] text-slate-400">
                  {r.rendimiento.unidad}
                  {DIAGNOSTICO[r.diagnostico]
                    ? ` · ${DIAGNOSTICO[r.diagnostico].toLowerCase()}`
                    : ""}
                </span>
              </p>
              <div className="flex flex-1 flex-col justify-center gap-2">
                <Desvio texto="vs. pares" pct={r.vs_pares_pct} />
                <Desvio texto="vs. su pasado" pct={r.vs_pasado_pct} />
              </div>
            </>
          ) : (
            <p className="flex-1 text-xs text-slate-400">Sin cargas suficientes todavía.</p>
          )}
          <Fila Icono={Fuel} color="#34d399" titulo="Última carga de combustible">
            {combustible ? (
              <>
                <b className="text-slate-200">
                  {fmt(combustible.cantidad, 1)} {combustible.unidad}
                </b>{" "}
                · {ORIGEN[combustible.origen] ?? "desde el tanque"} ·{" "}
                {haceCuanto(combustible.en, ahora)}
              </>
            ) : (
              "todavía no tiene"
            )}
          </Fila>
          <Fila Icono={Droplet} color="#38bdf8" titulo="Última carga de urea">
            {urea ? (
              <>
                <b className="text-slate-200">
                  {fmt(urea.cantidad, 1)} {urea.unidad}
                </b>{" "}
                · {ORIGEN[urea.origen] ?? "desde el almacén"} · {haceCuanto(urea.en, ahora)}
              </>
            ) : (
              "todavía no tiene"
            )}
          </Fila>
        </>
      )}
    </SeccionTv>
  );
}
