// La franja de arriba del reporte de Talonarios: una dona con vales usados, regularizados y sin
// explicar, y cuatro tarjetas con lo que más importa. Todo sale de las series del período.
import { AlertTriangle, ClipboardCheck, CircleHelp, Fuel } from "lucide-react";
import type { ReactNode } from "react";

import { arcosDeLaDona, resumirTalonarios, type ClaveArco } from "./resumenTalonarios";
import type { SerieTalonario } from "./valesFaltantesLogica";

const RADIO = 44;
const CIRCUNFERENCIA = 2 * Math.PI * RADIO;

const COLOR: Record<ClaveArco, string> = {
  usados: "#10b981",
  regularizados: "#f59e0b",
  sinExplicar: "#ef4444",
};
const NOMBRE: Record<ClaveArco, string> = {
  usados: "Usados",
  regularizados: "Regularizados",
  sinExplicar: "Sin explicar",
};

const num = (n: number) => n.toLocaleString("es-PE", { maximumFractionDigits: 1 });

function Tarjeta({
  icono,
  tono,
  titulo,
  valor,
  nota,
  colorValor,
  pie,
}: {
  icono: ReactNode;
  tono: string;
  titulo: string;
  valor: string;
  nota: string;
  colorValor?: string;
  pie?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-3">
      <div className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg ${tono}`}>{icono}</div>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          {titulo}
        </div>
        <div
          className={`text-2xl font-bold tabular-nums leading-tight ${colorValor ?? "text-slate-800"}`}
        >
          {valor}
        </div>
        <div className="text-xs text-slate-500">{nota}</div>
        {pie}
      </div>
    </div>
  );
}

export default function FranjaTalonarios({ series }: { series: SerieTalonario[] }) {
  const r = resumirTalonarios(series);
  const arcos = arcosDeLaDona(r, CIRCUNFERENCIA);
  const progreso = r.faltan > 0 ? (100 * r.regularizados) / r.faltan : 0;

  return (
    <section
      aria-label="Resumen del período"
      className="grid grid-cols-1 gap-3 lg:grid-cols-[14.5rem_minmax(0,1fr)]"
    >
      <div className="flex flex-col items-center gap-2 rounded-xl border border-slate-200 bg-white p-3">
        <svg
          viewBox="0 0 120 120"
          width="140"
          height="140"
          role="img"
          aria-label={`${r.conRespaldoPct}% de los vales tienen respaldo: ${r.usados} usados, ${r.regularizados} regularizados y ${r.sinExplicar} sin explicar`}
          className="text-slate-800"
        >
          <circle
            cx="60"
            cy="60"
            r={RADIO}
            fill="none"
            stroke="currentColor"
            strokeOpacity="0.12"
            strokeWidth="14"
          />
          {arcos.map((a) => (
            <circle
              key={a.clave}
              cx="60"
              cy="60"
              r={RADIO}
              fill="none"
              stroke={COLOR[a.clave]}
              strokeWidth="14"
              strokeDasharray={`${a.largo} ${CIRCUNFERENCIA - a.largo}`}
              strokeDashoffset={-a.desfase}
              transform="rotate(-90 60 60)"
            />
          ))}
          <text
            x="60"
            y="58"
            textAnchor="middle"
            fill="currentColor"
            fontSize="20"
            fontWeight="600"
          >
            {r.conRespaldoPct}%
          </text>
          <text
            x="60"
            y="74"
            textAnchor="middle"
            fill="currentColor"
            fillOpacity="0.6"
            fontSize="8.5"
          >
            con respaldo
          </text>
        </svg>
        <ul className="w-full space-y-1 text-xs text-slate-500">
          {(["usados", "regularizados", "sinExplicar"] as const).map((clave) => (
            <li key={clave} className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2">
                <span
                  aria-hidden
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ background: COLOR[clave] }}
                />
                {NOMBRE[clave]}
              </span>
              <span className="font-mono font-semibold text-slate-800">
                {clave === "usados"
                  ? r.usados
                  : clave === "regularizados"
                    ? r.regularizados
                    : r.sinExplicar}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-3">
        <Tarjeta
          icono={<AlertTriangle className="h-5 w-5" />}
          tono="bg-red-50 text-red-600"
          titulo="Vales que faltan"
          valor={String(r.faltan)}
          nota={`de ${r.total} en ${series.length === 1 ? "1 serie" : `${series.length} series`}`}
        />
        <Tarjeta
          icono={<ClipboardCheck className="h-5 w-5" />}
          tono="bg-amber-50 text-amber-700"
          titulo="Regularizados"
          valor={String(r.regularizados)}
          nota="con motivo, quién y cuándo"
          pie={
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
              <div className="h-full bg-amber-500" style={{ width: `${progreso}%` }} />
            </div>
          }
        />
        <Tarjeta
          icono={<CircleHelp className="h-5 w-5" />}
          tono={r.sinExplicar > 0 ? "bg-red-50 text-red-600" : "bg-emerald-50 text-emerald-700"}
          titulo="Sin explicar"
          valor={String(r.sinExplicar)}
          colorValor={r.sinExplicar > 0 ? "text-red-600" : "text-emerald-700"}
          nota={r.sinExplicar > 0 ? "el grifero debe rendir cuentas" : "todo regularizado"}
        />
        <Tarjeta
          icono={<Fuel className="h-5 w-5" />}
          tono="bg-sky-50 text-sky-700"
          titulo="Despachado con vale"
          valor={num(r.litros)}
          nota={`litros · ${num(r.galones)} galones`}
        />
      </div>
    </section>
  );
}
