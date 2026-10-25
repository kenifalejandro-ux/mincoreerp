// El relevo de un viaje (0152): se elige al programarlo, entre los conductores con usuario, y se
// dice quién sale manejando. Es opcional: sin relevo el viaje es del titular, como siempre.
interface Persona {
  id: string;
  nombre: string;
  dni: string;
}

interface Props {
  conductores: Persona[];
  /** El titular, para no ofrecerlo también como relevo. */
  titularDni: string;
  relevoDni: string;
  sale: "titular" | "relevo";
  onCambiar: (relevoDni: string, sale: "titular" | "relevo") => void;
}

const OPCION = "flex items-center gap-2 text-sm";

export function SelectorRelevo({ conductores, titularDni, relevoDni, sale, onCambiar }: Props) {
  const candidatos = conductores.filter((c) => c.dni !== titularDni.trim());
  return (
    <div className="space-y-2">
      <label htmlFor="viaje-relevo" className="block text-sm font-medium">
        Relevo (opcional)
      </label>
      <select
        id="viaje-relevo"
        value={relevoDni}
        onChange={(e) => onCambiar(e.target.value, e.target.value ? sale : "titular")}
        className="w-full border border-slate-200 rounded-xl p-3 text-sm bg-transparent"
      >
        <option value="">Sin relevo</option>
        {candidatos.map((c) => (
          <option key={c.id} value={c.dni}>
            {c.nombre} · DNI {c.dni}
          </option>
        ))}
      </select>
      {relevoDni && (
        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">Sale manejando</legend>
          <label className={OPCION}>
            <input
              type="radio"
              name="viaje-sale"
              checked={sale === "titular"}
              onChange={() => onCambiar(relevoDni, "titular")}
            />
            El titular
          </label>
          <label className={OPCION}>
            <input
              type="radio"
              name="viaje-sale"
              checked={sale === "relevo"}
              onChange={() => onCambiar(relevoDni, "relevo")}
            />
            El relevo
          </label>
          <p className="text-xs text-slate-500">
            El cambio de mando se marca después; quien no maneja solo puede descansar.
          </p>
        </fieldset>
      )}
    </div>
  );
}
