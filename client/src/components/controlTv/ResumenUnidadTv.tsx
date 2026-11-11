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

import {
  compararConNormal,
  nombreAlerta,
  type ComparacionConNormal,
  type GravedadAlerta,
} from "./resumenCorporativoLogica";
import { SeccionTv } from "./SeccionTv";
import { haceCuanto } from "../combustible/ubicacionesLogica";
import { duracion, fmt } from "../combustible/viajesFormato";

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

/** «+12 %» en rojo si pasa de 20 %, gris si no. */
function Delta({ pct, de }: { pct: number | null; de: string }) {
  if (pct === null) return null;
  return (
    <span className={`text-xs ${pct > 20 ? "text-[#ff3b3b]" : "text-slate-400"}`}>
      {pct > 0 ? "+" : ""}
      {fmt(pct, 0)}% {de}
    </span>
  );
}

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

/** El resumen de los viajes de la unidad (de su conductor como titular) en los últimos 30 días. */
export function ResumenViajes({ datos }: { datos: ResumenUnidad | null }) {
  const c = datos?.conductor;
  return (
    <SeccionTv
      titulo={`Resumen de la unidad · ${datos?.dias ?? 30} días`}
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
          <p className="text-center text-xs text-slate-400">
            Como titular <b className="text-slate-200">{c.como_titular}</b> · como relevo{" "}
            <b className="text-slate-200">{c.como_relevo}</b>
          </p>
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
    <div className="flex items-center gap-2 border-t border-white/10 py-1.5 text-xs first:border-t-0">
      <Icono className="h-[15px] w-[15px] shrink-0" style={{ color }} aria-hidden />
      <span className="min-w-0 flex-1 text-slate-200">{titulo}</span>
      <span className="text-right text-slate-400">{children}</span>
    </div>
  );
}

/** Un tiempo de la unidad contra lo que suele tardar: con su porcentaje, o «sin referencia». */
function ContraNormal({
  min,
  normal,
  cmp,
}: {
  min: number | null;
  normal: number | null;
  cmp: ComparacionConNormal;
}) {
  if (min === null) return <>—</>;
  return (
    <>
      <b className="text-slate-200">{duracion(min)}</b>
      {cmp.sinReferencia ? (
        " · sin referencia"
      ) : (
        <>
          {" "}
          · normal {duracion(normal ?? 0)}
          {cmp.muyPorEncima && <i className="ml-1 not-italic text-[#ff3b3b]">(muy por encima)</i>}
          {cmp.pct !== null && (
            <i className={`ml-1 not-italic ${cmp.pct > 20 ? "text-[#ff3b3b]" : ""}`}>
              ({cmp.pct > 0 ? "+" : ""}
              {fmt(cmp.pct, 0)}%)
            </i>
          )}
        </>
      )}
    </>
  );
}

/** Las últimas cargas, el rendimiento y los tiempos de la unidad contra lo normal de su ruta. */
export function CargasYRendimiento({
  datos,
  ahora,
  enRutaMin,
  enRutaEsperadoMin,
  estadiaMin,
}: {
  datos: ResumenUnidad | null;
  ahora: number;
  /** Lo que lleva manejando el viaje, y lo que suele tardar esos tramos (null si no hay referencia). */
  enRutaMin: number | null;
  enRutaEsperadoMin: number | null;
  /** Lo que lleva quieta la unidad en paradas de este viaje. */
  estadiaMin: number | null;
}) {
  const r = datos?.rendimiento;
  const estadiaNormal = datos?.estadia_normal?.minutos ?? null;
  const estadia = estadiaMin !== null && estadiaMin > 0 ? estadiaMin : null;
  const carga = (p: "combustible" | "urea") => datos?.ultimas_cargas.find((c) => c.producto === p);
  const combustible = carga("combustible");
  const urea = carga("urea");
  return (
    <SeccionTv
      titulo="Cargas y rendimiento"
      icono={<Gauge className="h-4 w-4 text-[#BADC1E]" aria-hidden />}
    >
      {!datos ? (
        <p className="text-xs text-slate-400">Cargando…</p>
      ) : (
        <>
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
          <Fila Icono={Gauge} color="#BADC1E" titulo="Rendimiento">
            {r?.rendimiento ? (
              <>
                <b className="text-slate-200">
                  {fmt(r.rendimiento.valor, 1)} {r.rendimiento.unidad}
                </b>{" "}
                <Delta pct={r.vs_pares_pct} de="vs. pares" />{" "}
                <Delta pct={r.vs_pasado_pct} de="vs. su pasado" />
                {DIAGNOSTICO[r.diagnostico] ? ` · ${DIAGNOSTICO[r.diagnostico]}` : ""}
              </>
            ) : (
              "sin cargas suficientes"
            )}
          </Fila>
          <Fila Icono={Route} color="#38bdf8" titulo="Ruta contra lo normal">
            <ContraNormal
              min={enRutaMin}
              normal={enRutaEsperadoMin}
              cmp={compararConNormal(enRutaMin, enRutaEsperadoMin)}
            />
          </Fila>
          <Fila Icono={Pause} color="#a78bfa" titulo="Estadía contra lo normal">
            <ContraNormal
              min={estadia}
              normal={estadiaNormal}
              cmp={compararConNormal(estadia, estadiaNormal)}
            />
          </Fila>
        </>
      )}
    </SeccionTv>
  );
}
