// Los paneles de abajo del Control TV: tanquetas y cisternas, consumo en barras, el tanque con su
// tendencia, la urea por envase y la franja de últimos eventos. Solo lectura; cada gráfica tiene su
// leyenda y una vista de tabla con los mismos números.
import { Bell, Droplets, Fuel } from "lucide-react";
import { useState, type ReactNode } from "react";

import {
  claseEnvase,
  COLOR_EVENTO,
  etiquetaCorte,
  haceTexto,
  ORIGENES,
  topeRedondo,
  type EnvaseTv,
  type EventoTv,
  type NivelTanque,
  type SerieConsumo,
  type TanquetaTv,
} from "./paneles";
import { fmt } from "../combustible/viajesFormato";

const PANEL = "flex min-h-0 flex-col gap-2 rounded-2xl border border-white/10 bg-white/[0.04] p-3";

function Titulo({ icono, texto, der }: { icono: ReactNode; texto: string; der?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <h2 className="flex items-center gap-2 text-xs font-bold uppercase tracking-[.16em] text-slate-400">
        <span className="text-[#BADC1E]">{icono}</span>
        {texto}
      </h2>
      {der}
    </div>
  );
}

function Leyenda({ items }: { items: { t: string; c: string }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
      {items.map((i) => (
        <li key={i.t} className="flex items-center gap-1.5">
          <i className="h-[3px] w-3.5 rounded" style={{ background: i.c }} />
          {i.t}
        </li>
      ))}
    </ul>
  );
}

function AlternarVista({ tabla, onChange }: { tabla: boolean; onChange: (t: boolean) => void }) {
  return (
    <div className="inline-flex gap-0.5 rounded-lg border border-white/10 p-0.5 text-xs">
      {[
        [false, "Gráfico"],
        [true, "Tabla"],
      ].map(([v, t]) => (
        <button
          key={String(t)}
          aria-pressed={tabla === v}
          onClick={() => onChange(v as boolean)}
          className={`rounded-md px-2 py-0.5 font-semibold ${
            tabla === v ? "bg-white/15 text-white" : "text-slate-400 hover:text-white"
          }`}
        >
          {t as string}
        </button>
      ))}
    </div>
  );
}

// ── Tanquetas y cisternas ─────────────────────────────────────────────────

export function PanelTanquetas({
  tanquetas,
  cisternas,
}: {
  tanquetas: { saldo_total_gal: number; items: TanquetaTv[] };
  cisternas: { con_saldo: number; saldo_gal: number; por_llegar: number; por_llegar_gal: number };
}) {
  const llenas = tanquetas.items.filter((t) => t.saldo > 0);
  const vacias = tanquetas.items.length - llenas.length;
  const capacidad = tanquetas.items.reduce((s, t) => s + t.capacidad, 0);
  return (
    <section className={PANEL}>
      <Titulo
        icono={<Fuel className="w-4 h-4" />}
        texto="Tanquetas"
        der={
          <span className="text-xs text-slate-400">
            {fmt(tanquetas.saldo_total_gal, 0)} / {fmt(capacidad, 0)} gal
          </span>
        }
      />
      <ul className="flex flex-1 flex-col gap-2 overflow-y-auto">
        {llenas.map((t) => {
          const pct =
            t.capacidad > 0 ? Math.min(100, Math.round((t.saldo / t.capacidad) * 100)) : 0;
          return (
            <li
              key={t.id}
              className="grid grid-cols-[minmax(0,1fr)_90px_64px] items-center gap-2 text-sm"
            >
              <div className="min-w-0">
                <b className="block truncate">{t.codigo}</b>
                <small className="block truncate text-xs text-slate-400">
                  {t.equipo_asignado ? `Unidad ${t.equipo_asignado}` : (t.grifo ?? "")}
                </small>
              </div>
              <div
                className="h-1.5 rounded bg-white/10"
                role="img"
                aria-label={`${pct} por ciento`}
              >
                <i
                  className="block h-full rounded"
                  style={{ width: `${pct}%`, background: pct < 100 ? "#fbbf24" : "#9bbd1c" }}
                />
              </div>
              <em className="text-right font-bold not-italic tabular-nums">
                {fmt(t.saldo, 0)} gal
              </em>
            </li>
          );
        })}
        {llenas.length === 0 && (
          <li className="text-sm text-slate-400">Ninguna tanqueta con saldo.</li>
        )}
      </ul>
      {vacias > 0 && (
        <p className="text-xs text-slate-400">
          + {vacias} vacías · libre {fmt(capacidad - tanquetas.saldo_total_gal, 0)} gal
        </p>
      )}
      <div className="grid grid-cols-2 gap-2 border-t border-white/10 pt-2">
        <div>
          <small className="block text-xs text-slate-400">Cisternas con saldo</small>
          <b className="text-base tabular-nums">{fmt(cisternas.saldo_gal, 0)} gal</b>
        </div>
        <div>
          <small className="block text-xs text-slate-400">
            Por llegar ({cisternas.por_llegar})
          </small>
          <b className="text-base tabular-nums">{fmt(cisternas.por_llegar_gal, 0)} gal</b>
        </div>
      </div>
    </section>
  );
}

// ── Consumo en barras ─────────────────────────────────────────────────────

export function PanelConsumo({
  serie,
  porHora,
  total,
}: {
  serie: SerieConsumo[];
  porHora: boolean;
  total: number;
}) {
  const [tabla, setTabla] = useState(false);
  const W = 640;
  const H = 205;
  const pl = 44;
  const pr = 10;
  const pt = 12;
  const pb = 26;
  const tope = topeRedondo(Math.max(...serie.map((s) => s.gal), 0) * 1.05);
  const paso = (W - pl - pr) / Math.max(serie.length, 1);
  const ancho = Math.min(24, paso * 0.72);
  const Y = (v: number) => pt + (H - pt - pb) * (1 - v / tope);
  const cada = Math.max(1, Math.round(serie.length / 6));
  return (
    <section className={PANEL}>
      <Titulo
        icono={<Droplets className="w-4 h-4" />}
        texto={`Consumo ${porHora ? "por hora" : "por día"}`}
        der={
          <span className="flex items-center gap-3">
            <AlternarVista tabla={tabla} onChange={setTabla} />
            <b className="text-xl tabular-nums">
              {fmt(total, 0)}{" "}
              <em className="text-xs font-semibold not-italic text-slate-400">gal</em>
            </b>
          </span>
        }
      />
      <Leyenda items={ORIGENES} />
      {tabla ? (
        <div className="max-h-[230px] overflow-auto">
          <table className="w-full text-xs tabular-nums">
            <thead className="sticky top-0 bg-[#0e1a1c] text-slate-400">
              <tr>
                <th className="py-1 text-left">{porHora ? "Hora" : "Día"}</th>
                {ORIGENES.map((o) => (
                  <th key={o.k} className="py-1 text-right">
                    {o.t}
                  </th>
                ))}
                <th className="py-1 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {serie.map((s) => (
                <tr key={s.t} className="border-t border-white/10">
                  <td className="py-1">{etiquetaCorte(s.t, porHora)}</td>
                  {ORIGENES.map((o) => (
                    <td key={o.k} className="py-1 text-right">
                      {fmt(s[o.k], 1)}
                    </td>
                  ))}
                  <td className="py-1 text-right font-bold">{fmt(s.gal, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full flex-1"
          role="img"
          aria-label="Consumo de combustible"
        >
          {[0, 1, 2, 3, 4].map((k) => {
            const v = (tope * k) / 4;
            return (
              <g key={k}>
                <line x1={pl} x2={W - pr} y1={Y(v)} y2={Y(v)} stroke="#ffffff14" />
                <text x={pl - 6} y={Y(v) + 4} textAnchor="end" fill="#94a3b8" fontSize={11}>
                  {fmt(v, v < 10 && v % 1 ? 1 : 0)}
                </text>
              </g>
            );
          })}
          {serie.map((s, j) => {
            const x = pl + paso * (j + 0.5) - ancho / 2;
            let base = 0;
            return (
              <g key={s.t}>
                <title>{`${etiquetaCorte(s.t, porHora)}: ${fmt(s.gal, 1)} gal`}</title>
                {ORIGENES.map((o) => {
                  const alto = ((H - pt - pb) * s[o.k]) / tope;
                  const y = Y(base + s[o.k]);
                  base += s[o.k];
                  return alto > 0 ? (
                    <rect
                      key={o.k}
                      x={x}
                      y={y}
                      width={ancho}
                      height={Math.max(0, alto - 2)}
                      fill={o.c}
                      rx={2}
                    />
                  ) : null;
                })}
                {j % cada === 0 && (
                  <text
                    x={x + ancho / 2}
                    y={H - 8}
                    textAnchor="middle"
                    fill="#94a3b8"
                    fontSize={11}
                  >
                    {etiquetaCorte(s.t, porHora)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
    </section>
  );
}

// ── El tanque con su tendencia ────────────────────────────────────────────

function DibujoTanque({ pct, minPct }: { pct: number; minPct: number }) {
  const y = 10 + 130 * (1 - pct / 100);
  const ym = 10 + 130 * (1 - minPct / 100);
  return (
    <svg
      viewBox="0 0 110 160"
      className="w-24"
      role="img"
      aria-label={`Tanque al ${pct} por ciento`}
    >
      <defs>
        <linearGradient id="tvTanque" x1="0" x2="1">
          <stop offset="0" stopColor="#5f7f12" />
          <stop offset=".5" stopColor="#BADC1E" />
          <stop offset="1" stopColor="#5f7f12" />
        </linearGradient>
        <clipPath id="tvTanqueClip">
          <rect x={12} y={10} width={86} height={130} rx={16} />
        </clipPath>
      </defs>
      <rect
        x={12}
        y={10}
        width={86}
        height={130}
        rx={16}
        fill="#0b1416"
        stroke="#ffffff30"
        strokeWidth={2}
      />
      <g clipPath="url(#tvTanqueClip)">
        <rect x={12} y={y} width={86} height={140 - y} fill="url(#tvTanque)" />
      </g>
      <line x1={12} x2={98} y1={ym} y2={ym} stroke="#fbbf24" strokeWidth={2} />
      <text x={55} y={y + 26} textAnchor="middle" fill="#0b1416" fontSize={22} fontWeight={800}>
        {pct}%
      </text>
      <text x={55} y={154} textAnchor="middle" fill="#94a3b8" fontSize={10}>
        mín. {minPct}%
      </text>
    </svg>
  );
}

export function PanelTanque({
  niveles,
  periodoMs,
  ahora,
}: {
  niveles: NivelTanque[];
  periodoMs: number;
  ahora: number;
}) {
  const [elegido, setElegido] = useState<number | null>(null);
  const [tabla, setTabla] = useState(false);
  // De entrada, el tanque con más lecturas de varilla (el que de verdad se está midiendo).
  const principal = [...niveles].sort((a, b) => b.puntos.length - a.puntos.length)[0];
  const t = niveles.find((n) => n.id === elegido) ?? principal;
  if (!t) return null;
  const nivel = Number(t.nivel_actual ?? 0);
  const pct =
    t.capacidad > 0 ? Math.max(0, Math.min(100, Math.round((nivel / t.capacidad) * 100))) : 0;
  const minPct =
    t.minimo !== null && t.capacidad > 0 ? Math.round((t.minimo / t.capacidad) * 100) : 0;
  const fin = ahora;
  const ini = fin - periodoMs;
  const W = 520;
  const H = 205;
  const pl = 44;
  const pr = 52;
  const pt = 12;
  const pb = 26;
  const tope = topeRedondo(Math.max(t.capacidad, ...t.puntos.map((p) => p.nivel)) * 1.02);
  const X = (ms: number) => pl + ((ms - ini) / (fin - ini)) * (W - pl - pr);
  const Y = (v: number) => pt + (H - pt - pb) * (1 - v / tope);
  const pts = t.puntos
    .map((p) => `${X(Date.parse(p.t)).toFixed(1)},${Y(p.nivel).toFixed(1)}`)
    .join(" ");
  const ultimo = t.puntos.at(-1);
  return (
    <section className={PANEL}>
      <Titulo
        icono={<Fuel className="w-4 h-4" />}
        texto={t.nombre}
        der={
          <b className="text-xl tabular-nums">
            {fmt(nivel, 0)}{" "}
            <em className="text-xs font-semibold not-italic text-slate-400">
              / {fmt(t.capacidad, 0)} {t.unidad}
            </em>
          </b>
        }
      />
      {niveles.length > 1 && (
        <select
          aria-label="Tanque"
          value={t.id}
          onChange={(e) => setElegido(Number(e.target.value))}
          className="w-full rounded-lg border border-white/15 bg-[#0D1719] px-2 py-1 text-xs text-slate-200 [color-scheme:dark]"
        >
          {niveles.map((n) => (
            <option key={n.id} value={n.id}>
              {n.nombre}
            </option>
          ))}
        </select>
      )}
      <div className="grid min-h-0 flex-1 grid-cols-[96px_minmax(0,1fr)] items-center gap-2">
        <DibujoTanque pct={pct} minPct={minPct} />
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center justify-between gap-2">
            <Leyenda
              items={[
                { t: "Nivel (varilla)", c: "#7fa21a" },
                { t: "Mínimo", c: "#fbbf24" },
              ]}
            />
            <AlternarVista tabla={tabla} onChange={setTabla} />
          </div>
          {tabla ? (
            <div className="max-h-[190px] overflow-auto">
              <table className="w-full text-xs tabular-nums">
                <tbody>
                  {t.puntos.map((p) => (
                    <tr key={p.t} className="border-t border-white/10">
                      <td className="py-1">
                        {new Date(p.t).toLocaleString("es-PE", {
                          dateStyle: "short",
                          timeStyle: "short",
                        })}
                      </td>
                      <td className="py-1 text-right font-bold">{fmt(p.nivel, 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : t.puntos.length < 2 ? (
            <p className="py-8 text-center text-sm text-slate-400">
              Sin lecturas de varilla suficientes en este período para dibujar la tendencia.
            </p>
          ) : (
            <svg
              viewBox={`0 0 ${W} ${H}`}
              className="w-full"
              role="img"
              aria-label={`Nivel de ${t.nombre}`}
            >
              {[0, 1, 2, 3, 4].map((k) => {
                const v = (tope * k) / 4;
                return (
                  <g key={k}>
                    <line x1={pl} x2={W - pr} y1={Y(v)} y2={Y(v)} stroke="#ffffff14" />
                    <text x={pl - 6} y={Y(v) + 4} textAnchor="end" fill="#94a3b8" fontSize={11}>
                      {fmt(v, 0)}
                    </text>
                  </g>
                );
              })}
              {t.minimo !== null && (
                <line
                  x1={pl}
                  x2={W - pr}
                  y1={Y(t.minimo)}
                  y2={Y(t.minimo)}
                  stroke="#fbbf24"
                  strokeWidth={2}
                />
              )}
              <polyline
                points={pts}
                fill="none"
                stroke="#7fa21a"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {ultimo && (
                <>
                  <circle
                    cx={X(Date.parse(ultimo.t))}
                    cy={Y(ultimo.nivel)}
                    r={4}
                    fill="#7fa21a"
                    stroke="#0e1a1c"
                    strokeWidth={2}
                  />
                  <text
                    x={X(Date.parse(ultimo.t)) + 8}
                    y={Y(ultimo.nivel) + 4}
                    fill="#e2e8f0"
                    fontSize={11}
                    fontWeight={700}
                  >
                    {fmt(ultimo.nivel, 0)}
                  </text>
                </>
              )}
            </svg>
          )}
        </div>
      </div>
    </section>
  );
}

// ── Urea por envase ───────────────────────────────────────────────────────

const FORMA_ENVASE: Record<string, string> = {
  caja: '<rect x="6" y="14" width="36" height="26" rx="3"/><path d="M6 22h36M22 14v8"/>',
  bidon: '<path d="M14 12h18l6 6v22a2 2 0 0 1-2 2H14a2 2 0 0 1-2-2V14z"/><path d="M18 12V8h10v4"/>',
  balde: '<path d="M10 16h28l-4 24H14z"/><path d="M12 16c0-8 24-8 24 0"/>',
  otro: '<rect x="10" y="10" width="28" height="30" rx="4"/><path d="M10 20h28"/>',
};
const COLOR_ENVASE = ["#60a5fa", "#9bbd1c", "#a78bfa", "#fbbf24"];

export function PanelUrea({
  urea,
  ahora,
}: {
  ahora: number;
  urea: {
    stock_l: number;
    minimo_l: number | null;
    maximo_l: number | null;
    autonomia_dias: number | null;
    envases: EnvaseTv[];
  };
}) {
  const tope = urea.maximo_l ?? Math.max(urea.stock_l * 1.5, 1);
  const pct = Math.max(0, Math.min(100, (urea.stock_l / tope) * 100));
  const conteos = urea.envases
    .map((e) => e.ultimo_conteo?.contadoEn)
    .filter((x): x is string => !!x);
  const ultimoConteo = conteos.sort().at(-1);
  return (
    <section className={PANEL}>
      <Titulo
        icono={<Droplets className="w-4 h-4" />}
        texto="Urea en almacén"
        der={
          <b className="text-xl tabular-nums">
            {fmt(urea.stock_l, 0)}{" "}
            <em className="text-xs font-semibold not-italic text-slate-400">L</em>
          </b>
        }
      />
      <div
        className="relative h-2.5 rounded-md bg-white/10"
        role="img"
        aria-label={`Urea al ${Math.round(pct)} por ciento del máximo`}
      >
        <i
          className="block h-full rounded-md bg-gradient-to-r from-[#7fa21a] to-[#BADC1E]"
          style={{ width: `${pct}%` }}
        />
        {urea.minimo_l !== null && (
          <u
            className="absolute -bottom-[3px] -top-[3px] w-0.5 bg-amber-400"
            style={{ left: `${Math.min(100, (urea.minimo_l / tope) * 100)}%` }}
          />
        )}
      </div>
      <p className="text-xs text-slate-400">
        {urea.minimo_l !== null ? `Mínimo ${fmt(urea.minimo_l, 0)} L` : "Sin mínimo"}
        {urea.maximo_l !== null ? ` · máximo ${fmt(urea.maximo_l, 0)} L` : ""}
        {urea.autonomia_dias !== null ? ` · autonomía ${fmt(urea.autonomia_dias, 0)} días` : ""}
      </p>
      <div className="grid flex-1 grid-cols-[repeat(auto-fit,minmax(90px,1fr))] items-center gap-2">
        {urea.envases.map((e, i) => (
          <div key={e.nombre} className="flex flex-col items-center gap-0.5 text-center">
            <svg
              viewBox="0 0 48 48"
              className="w-11"
              fill="none"
              stroke={COLOR_ENVASE[i % COLOR_ENVASE.length]}
              strokeWidth={2.2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
              dangerouslySetInnerHTML={{ __html: FORMA_ENVASE[claseEnvase(e.nombre)] }}
            />
            <small className="text-xs text-slate-400">{e.nombre}</small>
            <b className="text-2xl leading-none tabular-nums">{fmt(e.unidades, 0)}</b>
            <i className="text-[11px] not-italic text-slate-400">{fmt(e.litros, 0)} L</i>
            <i className="text-[11px] not-italic text-slate-400">
              entró {fmt(e.entraron_mes, 0)} · salió {fmt(e.salieron_mes, 0)}
            </i>
          </div>
        ))}
        {urea.envases.length === 0 && (
          <p className="text-sm text-slate-400">Sin envases registrados.</p>
        )}
      </div>
      {ultimoConteo && (
        <p className="text-xs text-slate-400">Último conteo: {haceTexto(ultimoConteo, ahora)}</p>
      )}
    </section>
  );
}

// ── Últimos eventos ───────────────────────────────────────────────────────

export function FranjaEventos({ eventos }: { eventos: EventoTv[] }) {
  return (
    <section className="grid items-center gap-3 rounded-2xl border border-[#BADC1E]/25 bg-white/[0.04] px-3.5 py-2 lg:grid-cols-[auto_repeat(5,minmax(0,1fr))]">
      <h2 className="flex items-center gap-2 whitespace-nowrap text-xs font-bold uppercase tracking-[.12em] text-slate-400">
        <Bell className="w-4 h-4 text-[#BADC1E]" /> Últimos eventos
      </h2>
      {eventos.length === 0 && <p className="text-sm text-slate-400">Sin movimientos todavía.</p>}
      {eventos.map((e) => (
        <div
          key={`${e.tipo}-${e.t}-${e.titulo}`}
          className="flex min-w-0 items-center gap-2 border-l border-white/10 pl-2.5"
        >
          <i
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ background: COLOR_EVENTO[e.tipo] }}
            aria-hidden
          />
          <div className="min-w-0">
            <small className="block text-[11px] text-slate-400">
              {new Date(e.t).toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" })}
            </small>
            <b className="block truncate text-[12.5px]">{e.titulo}</b>
            <span className="block truncate text-[11px] text-slate-400">{e.detalle}</span>
          </div>
        </div>
      ))}
    </section>
  );
}
