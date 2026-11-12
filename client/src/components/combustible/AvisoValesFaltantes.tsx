// Aviso de vales faltantes en el resumen del kardex: un botón rojo («Vales
// faltantes: 23») o verde («Vales completos») y, al tocarlo, los tramos que
// faltan por serie. Los vales de un talonario se reparten entre tanques y
// tanquetas, por eso cuenta todas las series del período y no solo las del tanque.
import { ChevronDown } from "lucide-react";

import {
  rangoTexto,
  seriesConFaltantes,
  textoVecinos,
  totalFaltantes,
  type SerieTalonario,
} from "./valesFaltantesLogica";

const fechaCorta = (iso: string) =>
  new Date(iso).toLocaleString("es-PE", {
    day: "2-digit",
    month: "2-digit",
    hour: "numeric",
    minute: "2-digit",
  });

export function BotonValesFaltantes({
  series,
  abierto,
  onAlternar,
}: {
  series: SerieTalonario[];
  abierto: boolean;
  onAlternar: () => void;
}) {
  const faltan = totalFaltantes(series);
  if (faltan === 0) {
    return (
      <span className="rounded-full border border-emerald-300 bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-700">
        ✔ Vales completos
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onAlternar}
      aria-expanded={abierto}
      aria-controls="kardex-vales-faltantes"
      className="inline-flex items-center gap-1.5 rounded-full border border-red-300 bg-red-50 px-3 py-1 text-xs font-bold text-red-700 hover:bg-red-100"
    >
      ⚠ Vales faltantes: {faltan}
      <ChevronDown className={`h-3.5 w-3.5 transition-transform ${abierto ? "rotate-180" : ""}`} />
    </button>
  );
}

export function PanelValesFaltantes({ series }: { series: SerieTalonario[] }) {
  const conFaltantes = seriesConFaltantes(series);
  return (
    <div id="kardex-vales-faltantes" className="mx-6 mt-3 shrink-0 space-y-3">
      {conFaltantes.map((s) => (
        <section key={s.serie} className="rounded-lg border border-slate-200 text-sm">
          <h3 className="flex flex-wrap justify-between gap-2 bg-slate-50 px-3 py-2 font-semibold text-slate-700">
            <span>
              Serie {s.serie} · del {String(s.minimo).padStart(5, "0")} al{" "}
              {String(s.maximo).padStart(5, "0")} · usados {s.usados} de {s.usados + s.faltan}
            </span>
            <span className="text-red-600">faltan {s.faltan}</span>
          </h3>
          <ul className="divide-y divide-slate-100">
            {s.tramos.map((t) => (
              <li key={t.desde} className="px-3 py-2">
                <span className="font-mono font-semibold text-slate-800">{rangoTexto(t)}</span>{" "}
                <span className="text-slate-500">
                  ({t.cantidad === 1 ? "1 vale" : `${t.cantidad} vales`})
                </span>
                <p className="text-xs text-slate-500">{textoVecinos(s.serie, t, fechaCorta)}</p>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <p className="text-xs text-slate-500">
        «Registrado por» es quien guardó el vale de al lado. No prueba quién tenía el que falta.
      </p>
    </div>
  );
}
