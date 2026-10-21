// Al llenar una tanqueta desde el tanque, quien despacha puede decir de una vez
// para qué unidad va (migración 0139). Es opcional: sin unidad, la tanqueta
// queda sin asignar y se asigna después desde la pestaña Tanquetas.
interface UnidadOpcion {
  id: number;
  placa_codigo: string;
  tipo: string;
}

export default function UnidadDeLaTanqueta({
  unidades,
  valor,
  onCambio,
}: {
  unidades: UnidadOpcion[];
  valor: string;
  onCambio: (equipoId: string) => void;
}) {
  return (
    <div className="space-y-1">
      <label
        htmlFor="despacho-tanqueta-equipo"
        className="text-xs font-bold text-slate-700 uppercase"
      >
        Unidad que la lleva (opcional)
      </label>
      <select
        id="despacho-tanqueta-equipo"
        className="w-full border border-slate-200 rounded-xl p-3 text-sm outline-none bg-white focus:ring-2 focus:ring-slate-900"
        value={valor}
        onChange={(e) => onCambio(e.target.value)}
      >
        <option value="">Sin asignar todavía</option>
        {unidades.map((u) => (
          <option key={u.id} value={u.id}>
            {u.placa_codigo} — {u.tipo}
          </option>
        ))}
      </select>
      <p className="text-xs text-slate-600">
        El conductor de esa unidad la verá lista para cargar, sin elegir nada. Una unidad lleva
        hasta 3 tanquetas.
      </p>
    </div>
  );
}
