// client/src/components/mantenimiento/CentroDeMantenimiento.tsx
//
// El Centro de control del ecosistema. Muestra solo lo que ya existe: cuántos equipos tiene la empresa y cómo se
// reparten por área. El estado de las unidades, las órdenes y los preventivos aparecen cuando existan sus datos;
// nada de cifras de ejemplo ni de tarjetas «Pronto» para lo esencial.
import { ChevronRight, Truck, Wrench } from "lucide-react";
import { useEffect, useState } from "react";

import { repartoPorArea } from "./centroDeMantenimiento";
import { resumenMantenimiento, type ResumenMantenimiento } from "./mantenimientoApi";

export default function CentroDeMantenimiento({ onIr }: { onIr: (id: string) => void }) {
  const [resumen, setResumen] = useState<ResumenMantenimiento | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let vigente = true;
    resumenMantenimiento()
      .then((d) => vigente && setResumen(d))
      .catch((e: unknown) => vigente && setError(e instanceof Error ? e.message : "Error"));
    return () => {
      vigente = false;
    };
  }, []);

  const reparto = resumen ? repartoPorArea(resumen) : [];
  const tarjetas = resumen
    ? [
        { etiqueta: "Equipos", valor: resumen.total, nota: "Registrados en la empresa" },
        { etiqueta: "Propios", valor: resumen.propios, nota: "De la empresa" },
        { etiqueta: "Alquilados", valor: resumen.alquilados, nota: "De terceros" },
        { etiqueta: "Sin área", valor: resumen.sin_area, nota: "Falta asignarles un área" },
      ]
    : [];

  return (
    <div className="space-y-5">
      <header>
        <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-slate-500">
          Gestión operativa / Centro de control
        </p>
        <h1 className="text-3xl font-semibold text-slate-900 mt-1">Centro de control</h1>
        <p className="text-sm text-slate-500 mt-1">
          El estado del mantenimiento de la empresa, de un vistazo.
        </p>
      </header>

      {error && (
        <p
          role="alert"
          className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3"
        >
          {error}
        </p>
      )}

      {resumen && resumen.total === 0 && (
        <section className="bg-white border border-slate-200 rounded-xl shadow-sm p-8 text-center">
          <span className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full bg-[#BADC1E]/25 text-[#3f6212]">
            <Truck size={22} />
          </span>
          <h2 className="text-lg font-semibold text-slate-900">Todavía no hay equipos</h2>
          <p className="mt-1 mb-4 text-sm text-slate-500">
            Regístralos uno por uno o impórtalos desde un Excel.
          </p>
          <button
            onClick={() => onIr("equipos")}
            className="h-10 px-5 rounded-lg bg-[#BADC1E] text-[#0A1014] text-sm font-semibold hover:brightness-95"
          >
            Ir a Equipos
          </button>
        </section>
      )}

      {resumen && resumen.total > 0 && (
        <>
          <section
            aria-label="Resumen de equipos"
            className="grid grid-cols-2 lg:grid-cols-4 bg-white border border-slate-200 rounded-xl shadow-sm"
          >
            {tarjetas.map((t) => (
              <div
                key={t.etiqueta}
                className="px-5 py-4 border-slate-200 border-r last:border-r-0 [&:nth-child(2)]:border-r-0 lg:[&:nth-child(2)]:border-r"
              >
                <span className="text-[11px] font-semibold text-slate-500">{t.etiqueta}</span>
                <b className="block text-[26px] font-extrabold text-slate-900">{t.valor}</b>
                <small className="text-[10px] text-slate-500">{t.nota}</small>
              </div>
            ))}
          </section>

          <section className="bg-white border border-slate-200 rounded-xl shadow-sm">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-slate-500">
                  Dónde trabajan
                </p>
                <h2 className="text-lg font-semibold text-slate-900">Equipos por área</h2>
              </div>
              <button
                onClick={() => onIr("equipos")}
                className="flex items-center gap-1 text-sm font-semibold text-[#4d7c0f] hover:underline"
              >
                Ver equipos <ChevronRight size={16} />
              </button>
            </div>
            <ul className="p-5 space-y-3">
              {reparto.map((r) => (
                <li
                  key={r.nombre}
                  className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-3"
                >
                  <span className="truncate text-sm text-slate-700">{r.nombre}</span>
                  <span className="h-2.5 rounded-full bg-slate-100 overflow-hidden">
                    <span
                      className="block h-full rounded-full bg-[#84cc16]"
                      style={{ width: `${r.porcentaje}%` }}
                    />
                  </span>
                  <b className="text-sm text-slate-900">{r.equipos}</b>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}

      {!resumen && !error && (
        <p className="text-sm text-slate-500 flex items-center gap-2">
          <Wrench size={14} /> Cargando…
        </p>
      )}
    </div>
  );
}
