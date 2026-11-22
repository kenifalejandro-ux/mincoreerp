// client/src/components/proveedores/PanelesDeFicha.tsx
//
// Las piezas de las pantallas de la ficha, como la maqueta: el panel con su título pequeño («kicker») y la
// cuadrícula de datos (etiqueta chica y valor en negrita; «—» si no hay dato).

import type { ReactNode } from "react";

export function Info({ datos }: { datos: [string, string | null][] }) {
  return (
    <dl className="grid gap-x-8 gap-y-4 px-5 pb-5 pt-1 sm:grid-cols-2">
      {datos.map(([etiqueta, valor]) => (
        <div key={etiqueta}>
          <dt className="text-[11px] text-slate-500 mb-0.5">{etiqueta}</dt>
          <dd className="font-semibold text-slate-900">{valor || "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Panel({
  kicker,
  titulo,
  children,
}: {
  kicker: string;
  titulo: string;
  children: ReactNode;
}) {
  return (
    <section className="bg-white border border-slate-200 rounded-xl shadow-sm">
      <div className="px-5 pt-4 pb-3">
        <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-slate-500">{kicker}</p>
        <h2 className="text-base font-semibold text-slate-900 mt-0.5">{titulo}</h2>
      </div>
      {children}
    </section>
  );
}
