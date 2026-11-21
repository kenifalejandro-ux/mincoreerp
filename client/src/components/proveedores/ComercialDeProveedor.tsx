// client/src/components/proveedores/ComercialDeProveedor.tsx
//
// La pestaña «Comercial» de la ficha: los precios de UN proveedor, cada uno con su historia (los
// anulados se ven tachados con su motivo). Solo lectura.
import { useState } from "react";

import { formatoFecha, formatoPrecio } from "./preciosProveedores";
import { PrecioVigente, Programado, RigeDesde, Variacion } from "./TablaDePrecios";
import { usePrecios } from "./usePrecios";

export default function ComercialDeProveedor({ proveedorId }: { proveedorId: number }) {
  const { datos, error } = usePrecios();
  const [ahora] = useState(() => Date.now());
  const filas = (datos?.filas ?? []).filter((f) => f.proveedorId === proveedorId);

  if (error)
    return (
      <p
        role="alert"
        className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3"
      >
        {error}
      </p>
    );
  if (datos === null) return <p className="text-sm text-slate-500">Cargando…</p>;
  if (filas.length === 0)
    return (
      <section className="bg-white border border-slate-200 rounded-xl shadow-sm p-6 text-sm text-slate-600">
        <h2 className="text-base font-semibold text-slate-900 mb-1">Sin precios</h2>
        Este proveedor todavía no tiene precios cargados. Se cargan en Combustible → Precios.
      </section>
    );

  return (
    <div className="space-y-4">
      {filas.map((f) => (
        <article key={f.clave} className="bg-white border border-slate-200 rounded-xl shadow-sm">
          <header className="flex flex-wrap items-start justify-between gap-4 p-5">
            <div>
              <h2 className="text-base font-semibold text-slate-900">{f.detalle}</h2>
              <p className="text-xs text-slate-500">
                {f.producto === "combustible" ? "Combustible (ruta)" : "Urea"}
              </p>
            </div>
            <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
              <div>
                <dt className="text-xs text-slate-500">Precio vigente</dt>
                <dd>
                  <PrecioVigente fila={f} />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Vs. anterior</dt>
                <dd>
                  <Variacion fila={f} />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Rige desde</dt>
                <dd>
                  <RigeDesde fila={f} ahora={ahora} />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Programado</dt>
                <dd>
                  <Programado fila={f} />
                </dd>
              </div>
            </dl>
          </header>
          <details className="border-t border-slate-200">
            <summary className="cursor-pointer px-5 py-3 text-sm font-semibold text-slate-700">
              Historial ({f.historial.length})
            </summary>
            {f.historial.length === 0 ? (
              <p className="px-5 pb-4 text-sm text-slate-500">Todavía no se cargó ningún precio.</p>
            ) : (
              <ul className="px-5 pb-4 space-y-1.5 text-sm">
                {f.historial.map((h) => (
                  <li
                    key={h.id}
                    className={`flex flex-wrap items-baseline gap-x-4 ${h.anulado ? "text-slate-400" : "text-slate-700"}`}
                  >
                    <span className={`tabular-nums w-24 ${h.anulado ? "line-through" : ""}`}>
                      {formatoFecha(h.desde)}
                    </span>
                    <b className={`tabular-nums ${h.anulado ? "line-through" : ""}`}>
                      {formatoPrecio(h.precio)}
                    </b>
                    {h.marca && <span>{h.marca}</span>}
                    {h.por && <span className="text-xs">cargado por {h.por}</span>}
                    {h.anulado && (
                      <span className="text-xs">(anulado: {h.motivo ?? "sin motivo"})</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </details>
        </article>
      ))}
    </div>
  );
}
