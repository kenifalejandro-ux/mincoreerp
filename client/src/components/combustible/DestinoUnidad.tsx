// La unidad que se lleva el saldo de una tanqueta que vuelve, con el vale de esa
// salida (serie del talonario y número), igual que al asignarla. Las unidades
// salen de la misma lista que usa "Asignar".
import { type DestinoElegido } from "./destinoDelRetornoDatos";
import { type UnidadOpcion } from "./useUnidadesDeDestino";

export default function DestinoUnidad({
  unidades,
  valor,
  onCambio,
}: {
  unidades: UnidadOpcion[];
  valor: DestinoElegido;
  onCambio: (d: DestinoElegido) => void;
}) {
  return (
    <div className="ml-6 space-y-2">
      <div className="space-y-1">
        <label htmlFor="retorno-unidad" className="text-xs font-bold text-slate-700 uppercase">
          ¿A cuál?
        </label>
        <select
          id="retorno-unidad"
          className="w-full border border-slate-200 rounded-xl p-3 text-sm"
          value={valor.id}
          onChange={(e) => onCambio({ ...valor, id: e.target.value })}
        >
          <option value="">Elegir unidad</option>
          {unidades.map((u) => (
            <option key={u.id} value={u.id}>
              {u.placa_codigo}
            </option>
          ))}
        </select>
      </div>
      {valor.id !== "" && (
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <label htmlFor="retorno-serie" className="text-xs font-bold text-slate-700 uppercase">
              Serie del vale
            </label>
            <input
              id="retorno-serie"
              maxLength={20}
              className="w-full border border-slate-200 rounded-xl p-3 text-sm"
              value={valor.serie}
              onChange={(e) => onCambio({ ...valor, serie: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="retorno-vale" className="text-xs font-bold text-slate-700 uppercase">
              N° de vale
            </label>
            <input
              id="retorno-vale"
              type="number"
              min={1}
              className="w-full border border-slate-200 rounded-xl p-3 text-sm"
              value={valor.vale}
              onChange={(e) => onCambio({ ...valor, vale: e.target.value })}
            />
          </div>
        </div>
      )}
    </div>
  );
}
