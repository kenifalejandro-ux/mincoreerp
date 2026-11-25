// client/src/components/combustible/CampoUnidadPlaca.tsx
//
// La unidad de un vale, como un campo de placa con su lista: se escribe o se elige. Si coincide con
// una unidad dada de alta es esa; si no, el vale queda con la placa escrita y la oficina la vincula
// después. Sin un módulo de unidades (Flota o Mantenimiento) la lista viene vacía y es solo el campo de texto (ver unidadEscrita.ts).
import { resolverUnidad, type UnidadRegistrada } from "./unidadEscrita";

interface Props {
  id: string;
  equipos: readonly UnidadRegistrada[];
  texto: string;
  onTexto: (texto: string) => void;
  /** Para pintar el campo igual que los de su formulario. */
  className?: string;
}

export function CampoUnidadPlaca({ id, equipos, texto, onTexto, className }: Props) {
  const unidad = resolverUnidad(texto, equipos);
  return (
    <>
      <input
        id={id}
        type="text"
        list={`${id}-lista`}
        required
        minLength={3}
        maxLength={30}
        autoComplete="off"
        autoCapitalize="characters"
        placeholder={equipos.length > 0 ? "Escribí o elegí la placa" : "Escribí la placa"}
        className={className ?? "rounded border border-gray-300 px-3 py-2 uppercase"}
        value={texto}
        onChange={(e) => onTexto(e.target.value)}
      />
      <datalist id={`${id}-lista`}>
        {equipos.map((eq) => (
          <option key={eq.id} value={eq.placa_codigo}>
            {eq.tipo ? `${eq.placa_codigo} — ${eq.tipo}` : eq.placa_codigo}
          </option>
        ))}
      </datalist>
      {unidad.tipo === "escrita" && (
        <span className="text-xs text-amber-600">
          Esa placa no está dada de alta: el vale queda con la placa que escribiste y la oficina la
          vincula después.
        </span>
      )}
    </>
  );
}
