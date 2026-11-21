// client/src/components/proveedores/TablaDePrecios.tsx
//
// Las celdas de un precio de proveedor (vigente, variación, desde cuándo rige, programado). La usan
// «Gestión comercial» y la pestaña «Comercial» de la ficha, para que se vean igual.
import {
  DIAS_PRECIO_VIEJO,
  diasDesde,
  formatoFecha,
  formatoPrecio,
  textoAntiguedad,
  variacionPct,
} from "./preciosProveedores";
import type { FilaPrecio } from "./proveedoresApi";

export function PrecioVigente({ fila }: { fila: FilaPrecio }) {
  if (!fila.vigente) {
    return <span className="text-amber-700 font-semibold">Sin precio</span>;
  }
  return (
    <span>
      <b className="text-slate-900 tabular-nums">{formatoPrecio(fila.vigente.precio)}</b>
      <span className="block text-xs text-slate-500">por {fila.unidad}</span>
    </span>
  );
}

export function Variacion({ fila }: { fila: FilaPrecio }) {
  const v = variacionPct(fila);
  if (v === null) return <span className="text-slate-400">—</span>;
  if (Math.abs(v) < 0.05) return <span className="text-slate-500">Sin cambio</span>;
  const sube = v > 0;
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ${
        sube ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700"
      }`}
    >
      {sube ? "▲" : "▼"} {Math.abs(v).toFixed(1)} %
    </span>
  );
}

export function RigeDesde({ fila, ahora }: { fila: FilaPrecio; ahora: number }) {
  if (!fila.vigente) return <span className="text-slate-400">—</span>;
  const dias = diasDesde(fila.vigente.desde, ahora);
  return (
    <span>
      {formatoFecha(fila.vigente.desde)}
      <span
        className={`block text-xs ${dias > DIAS_PRECIO_VIEJO ? "text-amber-700" : "text-slate-500"}`}
      >
        {textoAntiguedad(dias)}
      </span>
    </span>
  );
}

export function Programado({ fila }: { fila: FilaPrecio }) {
  if (!fila.programado) return <span className="text-slate-400">—</span>;
  return (
    <span>
      <b className="tabular-nums text-slate-800">{formatoPrecio(fila.programado.precio)}</b>
      <span className="block text-xs text-slate-500">
        desde {formatoFecha(fila.programado.desde)}
      </span>
    </span>
  );
}
