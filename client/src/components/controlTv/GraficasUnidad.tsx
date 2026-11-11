// Los gráficos de la vista de una unidad: lo consumido en el viaje por origen (barras y línea del
// acumulado), el consumo por tramo y las barras de desvío. Barras de HTML con la escala en el eje: a
// cualquier tamaño de pantalla los números se leen igual. Solo lectura.
import type { ReactNode } from "react";

import {
  acumuladoPorOrigen,
  alturaPct,
  barraDivergente,
  escalaY,
  ORIGENES,
  textoDesvio,
  type CargaGrafica,
} from "./graficasUnidadLogica";
import { compararConNormal } from "./resumenCorporativoLogica";
import { SeccionTv } from "./SeccionTv";
import type { TramoDelViaje } from "../combustible/TramosViaje";
import { duracion, fmt } from "../combustible/viajesFormato";

const REJILLA =
  "repeating-linear-gradient(0deg, transparent 0 calc(25% - 1px), rgba(255,255,255,.07) calc(25% - 1px) 25%)";

/** El recuadro de un gráfico de barras: eje con números a la izquierda y rejilla. */
function Plano({ tope, children }: { tope: number; children: ReactNode }) {
  return (
    <div
      className="relative ml-8 mt-4 min-h-[56px] flex-1 border-b border-l border-white/20"
      style={{ backgroundImage: REJILLA }}
    >
      {escalaY(tope).marcas.map((m) => (
        <span
          key={m}
          className="absolute -left-8 w-7 translate-y-1/2 text-right text-[10px] text-slate-500"
          style={{ bottom: `${alturaPct(m, tope)}%` }}
        >
          {fmt(m, m % 1 ? 1 : 0)}
        </span>
      ))}
      {children}
    </div>
  );
}

function Leyenda({ items }: { items: { t: string; c: string }[] }) {
  return (
    <ul className="hidden flex-wrap gap-x-3.5 gap-y-0.5 text-[10.5px] text-slate-400 min-[1500px]:flex">
      {items.map((i) => (
        <li key={i.t} className="flex items-center gap-1.5">
          <i className="h-2 w-2 rounded-[2px]" style={{ background: i.c }} />
          {i.t}
        </li>
      ))}
    </ul>
  );
}

function Cifra({ valor, texto, color }: { valor: string; texto: string; color?: string }) {
  return (
    <div className="border-l border-white/10 px-1 py-1 text-center first:border-l-0">
      <b
        className="block text-[15px] leading-tight tabular-nums min-[1700px]:text-[17px]"
        style={{ color }}
      >
        {valor}
      </b>
      <small className="block whitespace-nowrap text-[10.5px] text-slate-400">{texto}</small>
    </div>
  );
}

/** Lo consumido en el viaje: cifras arriba y, abajo, los galones por origen con la línea de lo acumulado. */
export function ConsumoAcumulado({
  cargas,
  gal,
  urea,
  costo,
  vsPromedio,
}: {
  cargas: CargaGrafica[];
  gal: number;
  urea: number;
  costo: number;
  vsPromedio: number | null;
}) {
  const barras = acumuladoPorOrigen(cargas);
  const { tope } = escalaY(barras.at(-1)?.acumulado ?? 0);
  const n = barras.length;
  const xDe = (i: number) => ((i + 0.5) / n) * 100;
  const alto = vsPromedio !== null && vsPromedio > 20;
  return (
    <SeccionTv titulo="Consumo acumulado del viaje" derecha="galones por origen">
      <div className="grid grid-cols-4 rounded-lg border border-white/10">
        <Cifra valor={`${fmt(gal, 0)} gal`} texto="combustible" color="#34d399" />
        <Cifra valor={`${fmt(urea, 0)} L`} texto="de urea" color="#38bdf8" />
        <Cifra valor={`S/ ${fmt(costo, 0)}`} texto="costo acumulado" color="#fbbf24" />
        <Cifra
          valor={vsPromedio === null ? "—" : `${textoDesvio(vsPromedio)}`}
          texto="vs. promedio"
          color={alto ? "#ef2f2f" : undefined}
        />
      </div>
      {n === 0 ? (
        <p className="py-2 text-xs text-slate-400">
          Este viaje todavía no tiene cargas de combustible.
        </p>
      ) : (
        <>
          <Plano tope={tope}>
            <div className="absolute inset-0 flex">
              {barras.map((b) => {
                const o = ORIGENES.find((x) => x.k === b.k)!;
                return (
                  <div key={b.k} className="relative flex-1">
                    <div
                      className="absolute bottom-0 left-1/2 w-[34%] max-w-[46px] -translate-x-1/2 rounded-t-[3px]"
                      style={{ height: `${alturaPct(b.gal, tope)}%`, background: o.c }}
                    >
                      <i className="absolute -top-4 left-1/2 -translate-x-1/2 text-[11px] font-bold not-italic">
                        {fmt(b.gal, 0)}
                      </i>
                    </div>
                  </div>
                );
              })}
            </div>
            <svg
              className="absolute inset-0 h-full w-full overflow-visible"
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              aria-hidden
            >
              <polyline
                vectorEffect="non-scaling-stroke"
                fill="none"
                stroke="#34d399"
                strokeWidth={2}
                points={barras
                  .map((b, i) => `${xDe(i)},${100 - alturaPct(b.acumulado, tope)}`)
                  .join(" ")}
              />
            </svg>
            {barras.map((b, i) => (
              <span
                key={b.k}
                className="absolute h-[7px] w-[7px] -translate-x-1/2 translate-y-1/2 rounded-full bg-[#34d399] ring-2 ring-[#0e191c]"
                style={{ left: `${xDe(i)}%`, bottom: `${alturaPct(b.acumulado, tope)}%` }}
              />
            ))}
            {n > 1 && (
              <b
                className="absolute -translate-x-1/2 text-[11px] text-[#34d399]"
                style={{
                  left: `${xDe(n - 1)}%`,
                  bottom: `calc(${alturaPct(barras[n - 1].acumulado, tope)}% + 8px)`,
                }}
              >
                {fmt(barras[n - 1].acumulado, 0)} gal
              </b>
            )}
          </Plano>
          <div className="ml-8 flex text-[10.5px] text-slate-400">
            {barras.map((b) => (
              <span key={b.k} className="flex-1 truncate text-center">
                {ORIGENES.find((x) => x.k === b.k)?.t}
              </span>
            ))}
          </div>
        </>
      )}
    </SeccionTv>
  );
}

/** Galones y litros de urea de cada tramo del viaje; el tramo en curso va más tenue. */
export function ConsumoPorTramo({ tramos }: { tramos: TramoDelViaje[] }) {
  const { tope } = escalaY(Math.max(0, ...tramos.flatMap((t) => [t.combustible_gal, t.urea_l])));
  return (
    <SeccionTv titulo="Consumo por tramo" derecha="galones y litros de urea">
      {tramos.length === 0 ||
      tope === 0 ||
      !tramos.some((t) => t.combustible_gal > 0 || t.urea_l > 0) ? (
        <p className="text-xs text-slate-400">
          {tramos.length === 0
            ? "Todavía no hay tramos en este viaje."
            : "Todavía no hay consumo en los tramos de este viaje."}
        </p>
      ) : (
        <>
          <Plano tope={tope}>
            <div className="absolute inset-0 flex">
              {tramos.map((t) => (
                <div
                  key={t.orden}
                  className={`relative flex flex-1 items-end justify-center gap-1 ${t.llegada_en ? "" : "opacity-60"}`}
                >
                  {[
                    [t.combustible_gal, "#34d399"],
                    [t.urea_l, "#38bdf8"],
                  ].map(([v, c]) => (
                    <div
                      key={c as string}
                      className="relative w-[32%] max-w-[44px] rounded-t-[3px]"
                      style={{
                        height: `${alturaPct(v as number, tope)}%`,
                        background: c as string,
                      }}
                    >
                      <i className="absolute -top-4 left-1/2 -translate-x-1/2 whitespace-nowrap text-[11px] font-bold not-italic">
                        {fmt(v as number, 1)}
                      </i>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </Plano>
          <div className="ml-8 flex text-[10.5px] text-slate-400">
            {tramos.map((t) => (
              <span key={t.orden} className="flex-1 truncate text-center">
                {t.de} → {t.a}
                {!t.llegada_en && <b className="ml-1 text-[#BADC1E]">· en curso</b>}
              </span>
            ))}
          </div>
          <Leyenda
            items={[
              { t: "Combustible (gal)", c: "#34d399" },
              { t: "Urea (L)", c: "#38bdf8" },
            ]}
          />
        </>
      )}
    </SeccionTv>
  );
}

/** Una barra que sale del centro: roja a la derecha si pasa de lo normal, verde a la izquierda si baja. */
export function Desvio({ texto, pct }: { texto: string; pct: number | null }) {
  const b = pct === null ? null : barraDivergente(pct);
  const rojo = pct !== null && pct > 20;
  return (
    <div className="flex items-center gap-2 text-[11.5px] text-slate-400">
      <span className="w-24 shrink-0">{texto}</span>
      <div className="relative h-4 flex-1 rounded-[3px] bg-white/[0.04]">
        <i className="absolute -bottom-[3px] -top-[3px] left-1/2 w-px bg-white/40" />
        {b && (
          <i
            className="absolute inset-y-0 rounded-[3px]"
            style={{
              [b.derecha ? "left" : "right"]: "50%",
              width: `${b.ancho * 50}%`,
              background: b.derecha ? (rojo ? "#ef2f2f" : "#fbbf24") : "#34d399",
            }}
          />
        )}
      </div>
      <b
        className="w-14 shrink-0 text-right text-xs"
        style={{
          color: pct === null ? undefined : pct > 20 ? "#ff5252" : pct < 0 ? "#34d399" : "#fbbf24",
        }}
      >
        {pct === null ? "—" : textoDesvio(pct)}
      </b>
    </div>
  );
}

/** Una barra partida en partes de colores, cada una con su cantidad. Sin partes, una pista vacía. */
export function BarraPartida({ partes }: { partes: { n: number; color: string }[] }) {
  const con = partes.filter((p) => p.n > 0);
  return (
    <div className="flex h-4 flex-1 gap-0.5 overflow-hidden rounded-[5px] bg-white/[0.04]">
      {con.map((p) => (
        <div
          key={p.color}
          className="grid min-w-[8px] place-items-center text-[10px] font-bold text-[#04121a]"
          style={{ flex: `${p.n} 1 0`, background: p.color }}
        >
          {p.n}
        </div>
      ))}
    </div>
  );
}

/** Lo que lleva una unidad contra lo que suele tardar: «normal 40 h · +15 %» o «sin referencia». */
export function VsNormal({ min, normal }: { min: number | null; normal: number | null }) {
  const c = compararConNormal(min, normal);
  if (min === null || c.sinReferencia) return <span>sin referencia</span>;
  return (
    <span
      className={c.muyPorEncima || (c.pct !== null && c.pct > 20) ? "text-[#ff5252]" : undefined}
    >
      normal {duracion(normal ?? 0)}
      {c.muyPorEncima ? " · muy por encima" : c.pct !== null && ` · ${textoDesvio(c.pct)}`}
    </span>
  );
}
