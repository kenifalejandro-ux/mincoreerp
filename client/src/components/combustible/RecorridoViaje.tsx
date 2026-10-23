// Programar un viaje: el recorrido. Solo ida (A → B), ida y vuelta (A → B → A) o
// varias paradas (A → B → C → A). El viaje termina en la última parada.
import { Plus, X } from "lucide-react";

import {
  errorDelRecorrido,
  paradasDelRecorrido,
  type Recorrido,
  type TipoRecorrido,
} from "./recorrido";

interface LugarOpcion {
  id: string;
  nombre: string;
}

const TIPOS: { valor: TipoRecorrido; titulo: string; ayuda: string }[] = [
  { valor: "solo_ida", titulo: "Solo ida", ayuda: "Termina al llegar al destino." },
  {
    valor: "ida_vuelta",
    titulo: "Ida y vuelta",
    ayuda: "Termina al volver al punto de salida. Es un solo viaje.",
  },
  {
    valor: "varias",
    titulo: "Varias paradas",
    ayuda: "Por ejemplo A → B → C → A. Termina en la última parada.",
  },
];

const INPUT = "w-full border border-slate-200 rounded-xl p-3 text-sm";
const LABEL = "text-xs font-bold text-slate-700 uppercase";

interface Props {
  lugares: LugarOpcion[];
  valor: Recorrido;
  onChange: (r: Recorrido) => void;
}

export function RecorridoViaje({ lugares, valor, onChange }: Props) {
  const nombre = (id: string) => lugares.find((l) => l.id === id)?.nombre ?? "";

  const cambiarTipo = (tipo: TipoRecorrido) => {
    const [a = "", b = ""] = valor.paradas;
    if (tipo !== "varias") return onChange({ tipo, paradas: [a, b] });
    // Un circuito arranca con una parada de más, que vuelve a la salida.
    const otra = lugares.find((l) => l.id !== a && l.id !== b)?.id ?? "";
    onChange({ tipo, paradas: valor.paradas.length >= 4 ? valor.paradas : [a, b, otra, a] });
  };

  const poner = (i: number, id: string) =>
    onChange({ ...valor, paradas: valor.paradas.map((p, k) => (k === i ? id : p)) });

  const quitar = (i: number) =>
    onChange({ ...valor, paradas: valor.paradas.filter((_, k) => k !== i) });

  const agregar = () => {
    const ultima = valor.paradas.length - 1;
    const libre = lugares.find((l) => !valor.paradas.includes(l.id))?.id ?? "";
    const paradas = [...valor.paradas];
    paradas.splice(ultima, 0, libre);
    onChange({ ...valor, paradas });
  };

  const selector = (i: number, etiqueta: string, quitable = false) => (
    <div className="flex items-end gap-2" key={i}>
      <div className="flex-1 space-y-1">
        <label htmlFor={`recorrido-parada-${i}`} className={LABEL}>
          {etiqueta}
        </label>
        <select
          id={`recorrido-parada-${i}`}
          required
          className={INPUT}
          value={valor.paradas[i] ?? ""}
          onChange={(e) => poner(i, e.target.value)}
        >
          <option value="">Elegir...</option>
          {lugares.map((l) => (
            <option key={l.id} value={l.id}>
              {l.nombre}
            </option>
          ))}
        </select>
      </div>
      {quitable && (
        <button
          type="button"
          onClick={() => quitar(i)}
          aria-label={`Quitar la parada ${i}`}
          className="p-3 rounded-xl border border-slate-200"
        >
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  );

  const paradas = paradasDelRecorrido(valor);
  const completo = paradas.every(Boolean) && errorDelRecorrido(valor) === null;
  const termina =
    valor.tipo === "solo_ida"
      ? `Termina al llegar a ${nombre(paradas[paradas.length - 1])}`
      : valor.tipo === "ida_vuelta"
        ? `Termina al volver a ${nombre(paradas[0])}`
        : `Termina en ${nombre(paradas[paradas.length - 1])}`;

  return (
    <div className="space-y-3">
      <div role="radiogroup" aria-label="Tipo de viaje" className="grid gap-2">
        {TIPOS.map((t) => (
          <button
            key={t.valor}
            type="button"
            role="radio"
            aria-checked={valor.tipo === t.valor}
            onClick={() => cambiarTipo(t.valor)}
            className={`text-left rounded-xl border p-3 ${
              valor.tipo === t.valor ? "border-[#BADC1E]" : "border-slate-200"
            }`}
          >
            <span className="block text-sm font-bold">{t.titulo}</span>
            <span className="block text-xs text-slate-500">{t.ayuda}</span>
          </button>
        ))}
      </div>

      {valor.tipo === "varias" ? (
        <>
          {valor.paradas.map((_, i) =>
            selector(
              i,
              i === 0 ? "Sale de" : i === valor.paradas.length - 1 ? "Llega a" : `Parada ${i}`,
              i > 0 && i < valor.paradas.length - 1 && valor.paradas.length > 3
            )
          )}
          <button
            type="button"
            onClick={agregar}
            className="flex items-center gap-1 text-sm font-bold px-3 py-2 rounded-xl border border-slate-200"
          >
            <Plus className="w-4 h-4" /> Agregar parada
          </button>
        </>
      ) : (
        <>
          {selector(0, "Sale de")}
          {selector(1, valor.tipo === "ida_vuelta" ? "Va a" : "Llega a")}
          {valor.tipo === "ida_vuelta" && (
            <p className="text-sm text-slate-500">
              Vuelve a <b>{nombre(valor.paradas[0]) || "el punto de salida"}</b> (el mismo punto de
              salida).
            </p>
          )}
        </>
      )}

      {completo ? (
        <p className="text-sm">
          <b>{paradas.map(nombre).join(" → ")}</b>
          <span className="text-slate-500">
            {" "}
            · {paradas.length - 1} {paradas.length - 1 === 1 ? "tramo" : "tramos"} · {termina}
          </span>
        </p>
      ) : (
        errorDelRecorrido(valor) !== null &&
        paradas.every(Boolean) && <p className="text-sm text-red-600">{errorDelRecorrido(valor)}</p>
      )}
    </div>
  );
}
