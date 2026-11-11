// Lo que la vista de una unidad suma al detalle del viaje: los viajes de su conductor, cómo rinde la
// unidad, cuánto tardó contra lo normal de su ruta, su última carga y sus alertas abiertas. Solo
// lectura; los datos vienen de /control-tv/unidad/:id.
import type { ReactNode } from "react";

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
  alertas: { total: number; ultimas: { tipo: string; creado_en: string }[] };
}

function Caja({
  titulo,
  children,
  abierta,
}: {
  titulo: string;
  children: ReactNode;
  abierta?: boolean;
}) {
  return (
    <SeccionTv titulo={titulo} abierta={abierta}>
      {children}
    </SeccionTv>
  );
}

const DIAGNOSTICO: Record<string, string> = {
  subio_y_alto: "Subió y está alto",
  subio: "Subió contra su pasado",
  alto: "Alto contra sus pares",
  bajo: "Por debajo de sus pares",
  sin_referencia: "Sin referencia todavía",
};

const ALERTA: Record<string, string> = {
  viaje_demorado: "Viaje demorado",
  viaje_detenido: "Unidad detenida",
  vale_excede_tanque: "Vale mayor que el tanque",
  vale_anulado: "Vale anulado",
  hueco_detectado: "Hueco en la serie de vales",
};

const ORIGEN: Record<string, string> = {
  tanqueta: "desde tanqueta",
  compra_externa: "compra en ruta",
};

/** «+12 %» en rojo si pasa de 20 %, gris si no. */
function Delta({ pct, de }: { pct: number | null; de: string }) {
  if (pct === null) return null;
  return (
    <span className={`text-xs ${pct > 20 ? "text-red-400" : "text-slate-400"}`}>
      {pct > 0 ? "+" : ""}
      {fmt(pct, 0)}% {de}
    </span>
  );
}

function Contador({ n, texto }: { n: number; texto: string }) {
  return (
    <div className="rounded-lg bg-white/[0.04] px-2 py-1.5 text-center">
      <b className="block text-lg tabular-nums leading-tight">{n}</b>
      <small className="text-[10px] uppercase tracking-wider text-slate-400">{texto}</small>
    </div>
  );
}

/** Los viajes del conductor de la unidad: ahora y en los últimos 30 días. */
export function ViajesDelConductor({ datos }: { datos: ResumenUnidad | null }) {
  const c = datos?.conductor;
  if (!datos || !c) return null;
  return (
    <Caja titulo="Viajes del conductor">
      <div className="grid grid-cols-4 gap-1.5">
        <Contador n={c.en_ruta} texto="En ruta" />
        <Contador n={c.programados} texto="Programados" />
        <Contador n={c.terminados} texto="Terminados" />
        <Contador n={c.anulados} texto="Anulados" />
      </div>
      <p className="text-xs text-slate-400">
        Últimos {datos.dias} días · como titular <b className="text-slate-200">{c.como_titular}</b>{" "}
        · como relevo <b className="text-slate-200">{c.como_relevo}</b>
      </p>
    </Caja>
  );
}

/** Rendimiento, tiempos contra lo normal, última carga y alertas abiertas de la unidad. */
export function ResumenDeLaUnidad({
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
  if (!datos) return null;
  const r = datos.rendimiento;
  const estadiaNormal = datos.estadia_normal?.minutos ?? null;
  const pctRuta =
    enRutaMin !== null && enRutaEsperadoMin
      ? ((enRutaMin - enRutaEsperadoMin) / enRutaEsperadoMin) * 100
      : null;
  const pctEstadia =
    estadiaMin !== null && estadiaMin > 0 && estadiaNormal
      ? ((estadiaMin - estadiaNormal) / estadiaNormal) * 100
      : null;
  return (
    <Caja titulo={`Resumen de la unidad · ${datos.dias} días`} abierta={false}>
      <div className="flex flex-col gap-2 text-sm">
        <div>
          <small className="block text-[11px] text-slate-400">Rendimiento</small>
          {r?.rendimiento ? (
            <>
              <b className="text-xl tabular-nums">{fmt(r.rendimiento.valor, 1)}</b>{" "}
              <em className="text-xs not-italic text-slate-400">{r.rendimiento.unidad}</em>
              <span className="ml-2 inline-flex flex-wrap gap-x-3">
                <Delta pct={r.vs_pares_pct} de="vs. pares" />
                <Delta pct={r.vs_pasado_pct} de="vs. su pasado" />
              </span>
              {DIAGNOSTICO[r.diagnostico] && (
                <small className="block text-xs text-slate-400">{DIAGNOSTICO[r.diagnostico]}</small>
              )}
            </>
          ) : (
            <span className="text-xs text-slate-400">Sin cargas suficientes para medirlo.</span>
          )}
        </div>

        <div className="border-t border-white/10 pt-2">
          <small className="block text-[11px] text-slate-400">Tiempos contra lo normal</small>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <span>
              Ruta <b className="tabular-nums">{enRutaMin === null ? "—" : duracion(enRutaMin)}</b>
              <span className="block text-slate-400">
                {enRutaEsperadoMin ? `normal ${duracion(enRutaEsperadoMin)}` : "sin referencia"}
                {pctRuta !== null && (
                  <i className={`ml-1 not-italic ${pctRuta > 20 ? "text-red-400" : ""}`}>
                    ({pctRuta > 0 ? "+" : ""}
                    {fmt(pctRuta, 0)}%)
                  </i>
                )}
              </span>
            </span>
            <span>
              Estadía{" "}
              <b className="tabular-nums">
                {estadiaMin === null || estadiaMin <= 0 ? "—" : duracion(estadiaMin)}
              </b>
              <span className="block text-slate-400">
                {estadiaNormal ? `normal ${duracion(estadiaNormal)}` : "sin referencia"}
                {pctEstadia !== null && (
                  <i className={`ml-1 not-italic ${pctEstadia > 20 ? "text-red-400" : ""}`}>
                    ({pctEstadia > 0 ? "+" : ""}
                    {fmt(pctEstadia, 0)}%)
                  </i>
                )}
              </span>
            </span>
          </div>
        </div>

        <div className="border-t border-white/10 pt-2">
          <small className="block text-[11px] text-slate-400">Última carga</small>
          {datos.ultimas_cargas.length === 0 ? (
            <span className="text-xs text-slate-400">Todavía no tiene cargas.</span>
          ) : (
            <ul className="flex flex-col gap-0.5 text-xs">
              {datos.ultimas_cargas.map((c) => (
                <li key={c.producto} className="flex justify-between gap-2">
                  <span>
                    {c.producto === "urea" ? "Urea" : "Combustible"}{" "}
                    <b className="tabular-nums">
                      {fmt(c.cantidad, 1)} {c.unidad}
                    </b>
                    <span className="text-slate-400">
                      {" "}
                      · {ORIGEN[c.origen] ?? "desde el tanque"}
                    </span>
                  </span>
                  <span className="text-slate-400">{haceCuanto(c.en, ahora)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="border-t border-white/10 pt-2">
          <small className="block text-[11px] text-slate-400">Alertas abiertas</small>
          {datos.alertas.total === 0 ? (
            <span className="text-xs text-emerald-300">Ninguna</span>
          ) : (
            <>
              <b className="text-red-300">{datos.alertas.total}</b>
              <ul className="text-xs text-slate-300">
                {datos.alertas.ultimas.map((a) => (
                  <li key={`${a.tipo}-${a.creado_en}`} className="flex justify-between gap-2">
                    <span>{ALERTA[a.tipo] ?? a.tipo.replace(/_/g, " ")}</span>
                    <span className="text-slate-400">{haceCuanto(a.creado_en, ahora)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </Caja>
  );
}
