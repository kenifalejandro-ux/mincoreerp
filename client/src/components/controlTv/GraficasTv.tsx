// La gráfica de líneas del «Detalle» del Control TV (la misma del prototipo): 2 px, área al 10 %, punto
// final con anillo y su valor, rejilla tenue, y al pasar el mouse una línea con los valores de ese
// corte. Con «Ver como: Tabla» se muestran los mismos números en una tabla.
import { useState } from "react";

import { etiquetaCorte, topeRedondo } from "./paneles";
import { fmt } from "../combustible/viajesFormato";

export interface SerieLinea {
  name: string;
  color: string;
  vals: number[];
}

export function Leyenda({ items }: { items: { name: string; color: string }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
      {items.map((i) => (
        <li key={i.name} className="flex items-center gap-1.5">
          <i className="h-[3px] w-3.5 rounded" style={{ background: i.color }} />
          {i.name}
        </li>
      ))}
    </ul>
  );
}

export function GraficaLineas({
  cortes,
  porHora,
  series,
  unidad,
  tabla,
}: {
  /** Los cortes de tiempo (ISO) en orden. */
  cortes: string[];
  porHora: boolean;
  series: SerieLinea[];
  unidad: string;
  tabla: boolean;
}) {
  const [activo, setActivo] = useState<number | null>(null);
  const etiquetas = cortes.map((c) => etiquetaCorte(c, porHora));
  if (tabla) {
    return (
      <div className="max-h-[260px] overflow-auto">
        <table className="w-full text-xs tabular-nums">
          <thead className="sticky top-0 bg-[#0e1a1c] text-slate-400">
            <tr>
              <th className="py-1 text-left">{porHora ? "Hora" : "Día"}</th>
              {series.map((s) => (
                <th key={s.name} className="py-1 text-right">
                  {s.name} ({unidad})
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {etiquetas.map((e, i) => (
              <tr key={cortes[i]} className="border-t border-white/10">
                <td className="py-1">{e}</td>
                {series.map((s) => (
                  <td key={s.name} className="py-1 text-right">
                    {fmt(s.vals[i] ?? 0, 1)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  const W = 640;
  const H = 230;
  const pl = 46;
  const pr = 58;
  const pt = 14;
  const pb = 30;
  const n = cortes.length;
  const tope = topeRedondo(Math.max(...series.flatMap((s) => s.vals), 0) * 1.05);
  const X = (j: number) => pl + (n <= 1 ? 0 : (j * (W - pl - pr)) / (n - 1));
  const Y = (v: number) => pt + (H - pt - pb) * (1 - v / tope);
  const paso = Math.max(1, Math.round((n - 1) / 5));
  const fin = series.map((s) => ({ y: Y(s.vals[n - 1] ?? 0), v: s.vals[n - 1] ?? 0, c: s.color }));
  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block h-auto w-full"
        role="img"
        aria-label={`Tendencia: ${series.map((s) => s.name).join(" y ")}`}
        onMouseLeave={() => setActivo(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const x = ((e.clientX - r.left) / r.width) * W;
          setActivo(Math.max(0, Math.min(n - 1, Math.round(((x - pl) / (W - pl - pr)) * (n - 1)))));
        }}
      >
        {[0, 1, 2, 3, 4].map((k) => {
          const v = (tope * k) / 4;
          return (
            <g key={k}>
              <line x1={pl} x2={W - pr} y1={Y(v)} y2={Y(v)} stroke="#ffffff14" />
              <text x={pl - 8} y={Y(v) + 4} textAnchor="end" fill="#94a3b8" fontSize={11}>
                {fmt(v, v < 10 && v % 1 ? 1 : 0)}
              </text>
            </g>
          );
        })}
        {etiquetas.map((e, i) =>
          i % paso === 0 ? (
            <text
              key={cortes[i]}
              x={X(i)}
              y={H - 9}
              textAnchor="middle"
              fill="#94a3b8"
              fontSize={11}
            >
              {e}
            </text>
          ) : null
        )}
        {series.map((s) => {
          const pts = s.vals.map((v, j) => `${X(j).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
          return (
            <g key={s.name}>
              <polygon
                points={`${X(0)},${Y(0)} ${pts} ${X(n - 1)},${Y(0)}`}
                fill={s.color}
                fillOpacity={0.1}
              />
              <polyline
                points={pts}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </g>
          );
        })}
        {fin.map((e, j) => (
          <g key={series[j].name}>
            <circle cx={X(n - 1)} cy={e.y} r={4} fill={e.c} stroke="#0e1a1c" strokeWidth={2} />
            {!fin.some((o, m) => m !== j && Math.abs(o.y - e.y) < 14) && (
              <text x={X(n - 1) + 9} y={e.y + 4} fill="#e2e8f0" fontSize={11} fontWeight={700}>
                {fmt(e.v, 0)}
              </text>
            )}
          </g>
        ))}
        {activo !== null && (
          <line
            x1={X(activo)}
            x2={X(activo)}
            y1={pt}
            y2={H - pb}
            stroke="#94a3b8"
            strokeWidth={1}
          />
        )}
      </svg>
      {activo !== null && (
        <div
          className="pointer-events-none absolute top-1 whitespace-nowrap rounded-lg border border-white/15 bg-[#0b1719] px-2.5 py-2 text-xs"
          style={{ left: `${Math.min(70, (X(activo) / W) * 100)}%` }}
        >
          <div className="mb-1 text-slate-400">{etiquetas[activo]}</div>
          {series.map((s) => (
            <div key={s.name} className="flex items-center gap-2">
              <i className="h-[3px] w-3 rounded" style={{ background: s.color }} />
              <b className="text-sm">{fmt(s.vals[activo] ?? 0, 1)}</b>
              <span className="text-slate-400">
                {unidad} · {s.name}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
