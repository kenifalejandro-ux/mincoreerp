// El Resumen corporativo del Control TV: un medidor, líneas, barras, una dona y un histograma, en vez
// de tarjetas de colores. Todo es SVG. Solo lectura; los datos ya los trae el Control TV.
import type { ReactNode } from "react";

import { autonomiaDias, categoriaDe } from "./controlTvLogica";
import { ORIGENES, type NivelTanque, type SerieConsumo, type TanquetaTv } from "./paneles";
import {
  colorDesvio,
  ESCALA_AUTONOMIA_DIAS,
  histograma,
  tendenciaMovil,
  topDesvios,
  type DesvioTv,
} from "./resumenCorporativoLogica";
import { estadoDelViaje, paradasDelViaje } from "../combustible/paradasViaje";
import { fmt, unidadLabel, type FilaViaje } from "../combustible/viajesFormato";

type Periodo = "24h" | "7d" | "30d";

export interface DatosResumenCorporativo {
  flota: {
    activos: number;
    programados: number;
    en_ruta: number;
    retornando: number;
    en_parada: number;
    descansando: number;
    detenidas: number;
  };
  combustible?: {
    tanques: { capacidad: number; nivel: number | string | null; costo_promedio: number | null }[];
    total_en_tanques_gal: number;
    tanquetas: { saldo_total_gal: number; items: TanquetaTv[] };
    alertas: { criticas: number; por_revisar: number };
  };
  urea?: { stock_l: number; minimo_l: number | null; maximo_l: number | null } | null;
  consumo?: {
    total: {
      gal: number;
      interno_gal: number;
      tanqueta_gal: number;
      ruta_gal: number;
    };
    serie: SerieConsumo[];
    agrupado_por: "hora" | "dia";
  };
  niveles?: NivelTanque[];
  /** Lo del detalle: el consumo anterior, los desvíos y la duración de los viajes. */
  detalle?: {
    consumo_anterior_gal?: number;
    desvios?: DesvioTv[];
    duraciones_h?: number[];
  } | null;
  periodo: Periodo;
}

const PI = Math.PI;
function Celda({
  titulo,
  children,
  pie,
}: {
  titulo: string;
  children: ReactNode;
  pie?: ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-1 rounded-xl border border-white/10 bg-gradient-to-br from-white/[0.07] to-white/[0.02] p-3">
      <h2 className="text-[11px] font-bold uppercase tracking-[.14em] text-slate-400">{titulo}</h2>
      {children}
      {pie && <p className="text-[11px] text-slate-400">{pie}</p>}
    </section>
  );
}

const Valor = ({ n, u }: { n: string; u?: string }) => (
  <p className="text-xl font-extrabold leading-tight tabular-nums">
    {n}
    {u && <em className="ml-1 text-xs font-semibold not-italic text-slate-400">{u}</em>}
  </p>
);

/** «▲ 12 %» en rojo si subió, en verde si bajó (para consumo). */
function Delta({ pct, de }: { pct: number | null; de: string }) {
  if (pct === null || !Number.isFinite(pct)) return null;
  return (
    <span className={`ml-2 text-xs font-semibold ${pct > 0 ? "text-red-400" : "text-emerald-400"}`}>
      {pct > 0 ? "▲" : "▼"} {fmt(Math.abs(pct), 0)} % {de}
    </span>
  );
}

/** Un anillo de progreso con el número en el centro: el color dice si está bien, justo o en riesgo. */
function Anillo({
  v,
  color,
  valor,
  unidad,
  etiqueta,
}: {
  v: number;
  color: string;
  valor: string;
  unidad: string;
  etiqueta: string;
}) {
  const R = 30;
  const C = 2 * Math.PI * R;
  const lleno = Math.max(0, Math.min(1, v)) * C;
  return (
    <figure className="m-0 flex flex-col items-center gap-0.5">
      <svg
        viewBox="0 0 80 80"
        className="w-full max-w-[84px]"
        role="img"
        aria-label={`${etiqueta}: ${valor} ${unidad}`}
      >
        <circle cx={40} cy={40} r={R} fill="none" stroke="#ffffff14" strokeWidth={8} />
        <circle
          cx={40}
          cy={40}
          r={R}
          fill="none"
          stroke={color}
          strokeWidth={8}
          strokeLinecap="round"
          strokeDasharray={`${lleno.toFixed(1)} ${(C - lleno).toFixed(1)}`}
          transform="rotate(-90 40 40)"
        />
        <text x={40} y={42} textAnchor="middle" fill="#f1f5f9" fontSize={16} fontWeight={800}>
          {valor}
        </text>
        <text x={40} y={54} textAnchor="middle" fill="#94a3b8" fontSize={8}>
          {unidad}
        </text>
      </svg>
      <figcaption className="text-center text-[11px] text-slate-400">{etiqueta}</figcaption>
    </figure>
  );
}

function Barras({
  datos,
  tendencia,
  ejes,
}: {
  datos: number[];
  tendencia: number[];
  ejes: [string, string, string];
}) {
  const W = 220;
  const H = 96;
  const bw = W / datos.length;
  const mx = Math.max(...datos, 1);
  const pts = tendencia
    .map((v, i) => `${(i * bw + bw / 2).toFixed(1)},${(H - (v / mx) * (H - 14)).toFixed(1)}`)
    .join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H + 14}`} className="w-full max-h-[92px]" aria-hidden>
      {[1, 2, 3].map((i) => (
        <line
          key={i}
          x1={0}
          x2={W}
          y1={H - (i * H) / 3.4}
          y2={H - (i * H) / 3.4}
          stroke="#ffffff12"
        />
      ))}
      {datos.map((d, i) => {
        const h = (d / mx) * (H - 14);
        return (
          <rect
            key={i}
            x={i * bw + 1}
            y={H - h}
            width={Math.max(1, bw - 2.4)}
            height={h}
            rx={2}
            fill={i >= datos.length - 3 ? "#BADC1E" : "#6e8f17"}
          />
        );
      })}
      <polyline
        points={pts}
        fill="none"
        stroke="#38bdf8"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <text x={0} y={H + 11} fill="#94a3b8" fontSize={8}>
        {ejes[0]}
      </text>
      <text x={W / 2} y={H + 11} fill="#94a3b8" fontSize={8} textAnchor="middle">
        {ejes[1]}
      </text>
      <text x={W} y={H + 11} fill="#94a3b8" fontSize={8} textAnchor="end">
        {ejes[2]}
      </text>
    </svg>
  );
}

function Dona({
  partes,
  centro,
  pie,
}: {
  partes: { n: number; c: string }[];
  centro: string;
  pie: string;
}) {
  const R = 44;
  const C = 2 * PI * R;
  const total = partes.reduce((s, p) => s + p.n, 0) || 1;
  return (
    <svg
      viewBox="0 0 120 120"
      className="mx-auto w-full max-w-[108px]"
      role="img"
      aria-label={`${centro} ${pie}`}
    >
      {partes.map((p, i) => {
        const l = (p.n / total) * C;
        const off = (partes.slice(0, i).reduce((s, q) => s + q.n, 0) / total) * C;
        return (
          <circle
            key={p.c}
            cx={60}
            cy={60}
            r={R}
            fill="none"
            stroke={p.c}
            strokeWidth={15}
            strokeDasharray={`${Math.max(0, l - 2).toFixed(1)} ${(C - l + 2).toFixed(1)}`}
            strokeDashoffset={(-off).toFixed(1)}
            transform="rotate(-90 60 60)"
          />
        );
      })}
      <text x={60} y={58} textAnchor="middle" fill="#f1f5f9" fontSize={17} fontWeight={800}>
        {centro}
      </text>
      <text x={60} y={73} textAnchor="middle" fill="#94a3b8" fontSize={8}>
        {pie}
      </text>
    </svg>
  );
}

function Histograma({ bins }: { bins: { desde: number; hasta: number; n: number }[] }) {
  const W = 220;
  const H = 96;
  const bw = W / bins.length;
  const mx = Math.max(...bins.map((b) => b.n), 1);
  const mayor = bins.reduce((m, b, i) => (b.n > bins[m].n ? i : m), 0);
  return (
    <svg viewBox={`0 0 ${W} ${H + 14}`} className="w-full max-h-[92px]" aria-hidden>
      {bins.map((b, i) => {
        const h = (b.n / mx) * (H - 16);
        return (
          <g key={b.desde}>
            <rect
              x={i * bw + 1}
              y={H - h}
              width={Math.max(1, bw - 2)}
              height={h}
              rx={2}
              fill="#a78bfa"
              opacity={i === mayor ? 1 : 0.7}
            />
            <text x={i * bw + bw / 2} y={H - h - 3} fill="#cbd5e1" fontSize={8} textAnchor="middle">
              {b.n}
            </text>
            <text x={i * bw + bw / 2} y={H + 11} fill="#94a3b8" fontSize={8} textAnchor="middle">
              {b.desde}-{b.hasta}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function BarrasHorizontales({ items }: { items: { placa: string; pct: number }[] }) {
  const mx = Math.max(...items.map((i) => Math.abs(i.pct)), 1);
  return (
    <svg viewBox={`0 0 220 ${items.length * 17}`} className="w-full max-h-[92px]" aria-hidden>
      {items.map((it, i) => {
        const w = (Math.abs(it.pct) / mx) * 118;
        return (
          <g key={it.placa}>
            <text x={0} y={i * 17 + 11} fill="#cbd5e1" fontSize={9}>
              {it.placa}
            </text>
            <rect x={62} y={i * 17 + 3} width={w} height={9} rx={3} fill={colorDesvio(it.pct)} />
            <text x={62 + w + 4} y={i * 17 + 11} fill="#e5edef" fontSize={9} fontWeight={700}>
              {it.pct > 0 ? "+" : ""}
              {fmt(it.pct, 0)}%
            </text>
          </g>
        );
      })}
    </svg>
  );
}

const Leyenda = ({ items }: { items: { t: string; c: string }[] }) => (
  <ul className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-400">
    {items.map((i) => (
      <li key={i.t} className="flex items-center gap-1.5">
        <i className="h-2 w-2 rounded-[2px]" style={{ background: i.c }} />
        {i.t}
      </li>
    ))}
  </ul>
);

export function ResumenCorporativo({
  d,
  movil,
  intro,
}: {
  d: DatosResumenCorporativo;
  movil: boolean;
  /** Lo que va entre las etiquetas de arriba y los gráficos (flota, detenidas, tanque). */
  intro?: ReactNode;
}) {
  const comb = d.combustible;
  const galPeriodo = d.consumo?.total.gal ?? 0;
  const periodoTxt = { "24h": "24 h", "7d": "7 días", "30d": "30 días" }[d.periodo];
  const porHora = d.consumo?.agrupado_por === "hora";

  const auto = comb ? autonomiaDias(comb.total_en_tanques_gal, galPeriodo, d.periodo) : null;
  const urea = d.urea;
  const ureaMax = urea
    ? (urea.maximo_l ?? Math.max(urea.stock_l, urea.minimo_l ?? 0) * 1.2) || 1
    : 1;

  const serie = d.consumo?.serie ?? [];
  const consumoAnterior = d.detalle?.consumo_anterior_gal ?? 0;
  const deltaConsumo =
    consumoAnterior > 0 ? ((galPeriodo - consumoAnterior) / consumoAnterior) * 100 : null;

  const histo = d.detalle?.duraciones_h ? histograma(d.detalle.duraciones_h) : null;
  const desvios = topDesvios(d.detalle?.desvios ?? []);

  const f = d.flota;

  return (
    <div className="flex flex-col gap-2.5">
      <ul className="flex flex-wrap gap-2 text-sm font-bold">
        <Chip t="Viajes activos" n={f.activos} />
        <Chip t="Programados" n={f.programados} />
        {comb && <Chip t="Alertas críticas" n={comb.alertas.criticas} rojo />}
        {comb && <Chip t="Por revisar" n={comb.alertas.por_revisar} />}
      </ul>
      {intro}
      <div
        className={`grid gap-2.5 ${movil ? "grid-cols-2" : "[grid-template-columns:repeat(auto-fit,minmax(215px,1fr))]"}`}
      >
        {comb && (
          <Celda titulo="Autonomía y urea">
            <div className="grid grid-cols-2 gap-1">
              <Anillo
                v={(auto ?? 0) / ESCALA_AUTONOMIA_DIAS}
                color={
                  auto === null
                    ? "#475569"
                    : auto < 3
                      ? "#f87171"
                      : auto < 6
                        ? "#fbbf24"
                        : "#34d399"
                }
                valor={auto === null ? "—" : fmt(auto, 1)}
                unidad={auto === null ? "" : "días"}
                etiqueta="Combustible"
              />
              {urea ? (
                <Anillo
                  v={urea.stock_l / ureaMax}
                  color={
                    urea.minimo_l != null && urea.stock_l < urea.minimo_l
                      ? "#f87171"
                      : urea.minimo_l != null && urea.stock_l < urea.minimo_l * 2
                        ? "#fbbf24"
                        : "#34d399"
                  }
                  valor={fmt(urea.stock_l, 0)}
                  unidad="L"
                  etiqueta={`Urea · ${fmt((urea.stock_l / ureaMax) * 100, 0)} %`}
                />
              ) : (
                <span />
              )}
            </div>
          </Celda>
        )}
        {d.consumo && d.consumo.total.gal > 0 && (
          <Celda titulo="De dónde llegó el combustible">
            <Dona
              partes={ORIGENES.map((o) => ({ n: d.consumo!.total[o.k], c: o.c }))}
              centro={fmt(d.consumo.total.gal, 0)}
              pie={`gal · ${periodoTxt}`}
            />
            <Leyenda
              items={ORIGENES.map((o) => ({
                t: `${o.t} ${fmt((d.consumo!.total[o.k] / d.consumo!.total.gal) * 100, 0)} %`,
                c: o.c,
              }))}
            />
          </Celda>
        )}
        {serie.length > 0 && (
          <Celda titulo={`Consumo por ${porHora ? "hora" : "día"}`}>
            <p className="text-xl font-extrabold leading-tight tabular-nums">
              {fmt(galPeriodo, 0)}
              <em className="ml-1 text-xs font-semibold not-italic text-slate-400">gal</em>
              <Delta pct={deltaConsumo} de="vs. período anterior" />
            </p>
            <Barras
              datos={serie.map((s) => s.gal)}
              tendencia={tendenciaMovil(serie.map((s) => s.gal))}
              ejes={[
                etq(serie[0].t, porHora),
                etq(serie[Math.floor(serie.length / 2)].t, porHora),
                etq(serie[serie.length - 1].t, porHora),
              ]}
            />
            <Leyenda
              items={[
                { t: "Consumo", c: "#BADC1E" },
                { t: "Tendencia", c: "#38bdf8" },
              ]}
            />
          </Celda>
        )}
        {comb && (
          <Celda titulo="Duración de los viajes" pie="Viajes cerrados · últimos 30 días (horas)">
            {histo ? (
              <>
                <Valor n={fmt(histo.promedio, 1)} u="h en promedio" />
                <Histograma bins={histo.bins} />
              </>
            ) : (
              <p className="py-6 text-center text-xs text-slate-400">
                {d.detalle ? "Todavía no hay viajes cerrados." : "Cargando…"}
              </p>
            )}
          </Celda>
        )}
        {comb && (
          <Celda
            titulo="Unidades que más se desvían"
            pie="% contra el promedio de sus pares o su pasado"
          >
            {desvios.length > 0 ? (
              <BarrasHorizontales items={desvios} />
            ) : (
              <p className="py-6 text-center text-xs text-slate-400">
                {d.detalle ? "Ninguna se aparta de lo normal." : "Cargando…"}
              </p>
            )}
          </Celda>
        )}
      </div>
    </div>
  );
}

function etq(iso: string, porHora: boolean): string {
  const f = new Date(iso);
  return porHora
    ? f.toLocaleTimeString("es-PE", {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        timeZone: "America/Lima",
      })
    : f.toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", timeZone: "America/Lima" });
}

function Chip({ t, n, rojo = false }: { t: string; n: number; rojo?: boolean }) {
  return (
    <li className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[13px]">
      {t} <b className={rojo ? "text-red-400" : "text-[#BADC1E]"}>{n}</b>
    </li>
  );
}

/** Las unidades detenidas (avería, accidente...): lo primero que la gerencia quiere ver. */
export function UnidadesDetenidas({
  viajes,
  onElegir,
}: {
  viajes: FilaViaje[];
  onElegir: (id: string) => void;
}) {
  const detenidas = viajes.filter((v) => categoriaDe(v) === "detenida");
  if (detenidas.length === 0) return null;
  return (
    <section className="flex flex-col gap-1.5 rounded-xl border border-red-400/40 bg-red-400/10 p-3">
      <h2 className="text-[11px] font-bold uppercase tracking-[.14em] text-red-200">
        Unidades detenidas · {detenidas.length}
      </h2>
      <ul className="flex flex-col gap-1">
        {detenidas.map((v) => (
          <li key={v.id}>
            <button
              onClick={() => onElegir(v.id)}
              className="flex min-h-11 w-full items-center justify-between gap-2 rounded-lg bg-white/[0.05] px-3 text-left"
            >
              <span className="min-w-0">
                <b className="block text-sm">{unidadLabel(v)}</b>
                <span className="block truncate text-xs text-red-100">
                  {estadoDelViaje(paradasDelViaje(v), v.descansos)?.texto ?? "Detenida"}
                  {v.conductor_nombre ? ` · ${v.conductor_nombre}` : ""}
                </span>
              </span>
              <span className="text-xs text-slate-300">Ver ›</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
