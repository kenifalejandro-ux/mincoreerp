// Una línea del reparto del excedente que va a una tanqueta puede decir para
// qué unidad va, con su vale (migración 0140). Es opcional: sin unidad, la
// línea queda como siempre. Con unidad, la serie y el N° de vale son
// obligatorios: así se asigna una tanqueta de excedente, igual que un despacho
// del tanque a una unidad.
interface UnidadOpcion {
  id: number;
  placa_codigo: string;
}

export interface UnidadYVale {
  tanqueta_equipo_id?: string;
  serie_talonario?: string;
  n_vale?: string;
}

export default function UnidadYValeDeLinea({
  indice,
  unidades,
  valor,
  onCambio,
}: {
  indice: number;
  unidades: UnidadOpcion[];
  valor: UnidadYVale;
  onCambio: (cambio: UnidadYVale) => void;
}) {
  const conUnidad = (valor.tanqueta_equipo_id ?? "") !== "";
  return (
    <div className="grid grid-cols-12 gap-2 items-end">
      <div className="col-span-12 sm:col-span-5 space-y-1">
        <label
          htmlFor={`exc-tqt-unidad-${indice}`}
          className="text-xs font-bold text-slate-700 uppercase"
        >
          Unidad que la lleva (opcional)
        </label>
        <select
          id={`exc-tqt-unidad-${indice}`}
          className="w-full border border-slate-200 rounded-xl p-3 text-sm"
          value={valor.tanqueta_equipo_id ?? ""}
          onChange={(e) =>
            onCambio({
              tanqueta_equipo_id: e.target.value,
              ...(e.target.value === "" ? { serie_talonario: "", n_vale: "" } : {}),
            })
          }
        >
          <option value="">Sin asignar todavía</option>
          {unidades.map((u) => (
            <option key={u.id} value={u.id}>
              {u.placa_codigo}
            </option>
          ))}
        </select>
      </div>
      {conUnidad && (
        <>
          <div className="col-span-6 sm:col-span-4 space-y-1">
            <label
              htmlFor={`exc-serie-${indice}`}
              className="text-xs font-bold text-slate-700 uppercase"
            >
              Serie del talonario
            </label>
            <input
              id={`exc-serie-${indice}`}
              maxLength={20}
              className="w-full border border-slate-200 rounded-xl p-3 text-sm"
              value={valor.serie_talonario ?? ""}
              onChange={(e) => onCambio({ serie_talonario: e.target.value })}
            />
          </div>
          <div className="col-span-6 sm:col-span-3 space-y-1">
            <label
              htmlFor={`exc-vale-${indice}`}
              className="text-xs font-bold text-slate-700 uppercase"
            >
              N° de vale
            </label>
            <input
              id={`exc-vale-${indice}`}
              type="number"
              min={1}
              step={1}
              className="w-full border border-slate-200 rounded-xl p-3 text-sm"
              value={valor.n_vale ?? ""}
              onChange={(e) => onCambio({ n_vale: e.target.value })}
            />
          </div>
        </>
      )}
    </div>
  );
}
