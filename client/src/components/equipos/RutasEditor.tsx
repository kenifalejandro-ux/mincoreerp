// client/src/components/equipos/RutasEditor.tsx
//
// Las rutas habituales de una unidad (origen → destino), tomadas de los lugares
// del catálogo de Viajes. Una unidad puede tener varias o ninguna: unas
// empresas fijan la ruta por unidad y otras no, así que "sin rutas" es válido.
import { Plus, Trash2 } from "lucide-react";

export interface LugarOpcion {
  id: number;
  nombre: string;
}

/** Estado del formulario: strings porque vienen de un <select>. "" = sin elegir. */
export interface RutaForm {
  origen_id: string;
  destino_id: string;
}

const CAMPO =
  "w-full bg-[#0D1719] border border-[#334155] rounded-xl p-3 text-sm text-white outline-none focus:ring-2 focus:ring-[#BADC1E]";

export default function RutasEditor({
  lugares,
  value,
  onChange,
}: {
  lugares: LugarOpcion[];
  value: RutaForm[];
  onChange: (rutas: RutaForm[]) => void;
}) {
  const cambiar = (i: number, parcial: Partial<RutaForm>) =>
    onChange(value.map((r, j) => (j === i ? { ...r, ...parcial } : r)));

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold text-[#94a3b8] uppercase">Rutas habituales</span>
        <button
          type="button"
          disabled={lugares.length < 2}
          onClick={() => onChange([...value, { origen_id: "", destino_id: "" }])}
          className="flex items-center gap-1 text-xs font-bold text-[#BADC1E] disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Plus className="w-3.5 h-3.5" /> Agregar ruta
        </button>
      </div>

      {lugares.length < 2 ? (
        <p className="text-[11px] text-[#94a3b8]">
          Hacen falta al menos dos lugares cargados. Se crean en Combustible › Viajes › Lugares.
        </p>
      ) : value.length === 0 ? (
        <p className="text-[11px] text-[#94a3b8]">
          Sin rutas fijas: la unidad puede salir a cualquiera. Agregá una si siempre hace el mismo
          recorrido.
        </p>
      ) : (
        value.map((r, i) => (
          <div key={i} className="flex items-center gap-2">
            <select
              aria-label={`Origen de la ruta ${i + 1}`}
              className={CAMPO}
              value={r.origen_id}
              onChange={(e) => cambiar(i, { origen_id: e.target.value })}
            >
              <option value="">Origen</option>
              {lugares.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.nombre}
                </option>
              ))}
            </select>
            <span className="text-[#94a3b8]">→</span>
            <select
              aria-label={`Destino de la ruta ${i + 1}`}
              className={CAMPO}
              value={r.destino_id}
              onChange={(e) => cambiar(i, { destino_id: e.target.value })}
            >
              <option value="">Destino</option>
              {lugares
                .filter((l) => String(l.id) !== r.origen_id)
                .map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.nombre}
                  </option>
                ))}
            </select>
            <button
              type="button"
              aria-label={`Quitar la ruta ${i + 1}`}
              onClick={() => onChange(value.filter((_, j) => j !== i))}
              className="p-2 text-[#94a3b8] hover:text-white"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        ))
      )}
    </div>
  );
}
