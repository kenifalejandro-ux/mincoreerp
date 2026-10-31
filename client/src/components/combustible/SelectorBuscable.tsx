import { Check, ChevronDown, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

export interface OpcionBuscable {
  valor: string;
  etiqueta: string;
}

const sinAcentos = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Desplegable con buscador para listas largas (unidades, proveedores): quien
 *  registra escribe parte del texto y la lista se acorta. Respeta el orden en
 *  que llegan las opciones, así quien arma la lista decide qué va arriba.
 *  Vive dentro de formularios, así que Enter elige y NO envía el formulario. */
export function SelectorBuscable({
  id,
  opciones,
  valor,
  onElegir,
  placeholder,
  etiquetaBuscador,
}: {
  /** Id del botón: las etiquetas y las pruebas apuntan a él. */
  id: string;
  opciones: OpcionBuscable[];
  valor: string;
  onElegir: (valor: string) => void;
  placeholder: string;
  etiquetaBuscador: string;
}) {
  const [abierto, setAbierto] = useState(false);
  const [q, setQ] = useState("");
  const [resaltada, setResaltada] = useState(0);
  const caja = useRef<HTMLDivElement>(null);
  const boton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!abierto) return;
    const fuera = (e: MouseEvent) => {
      if (caja.current && !caja.current.contains(e.target as Node)) setAbierto(false);
    };
    document.addEventListener("mousedown", fuera);
    return () => document.removeEventListener("mousedown", fuera);
  }, [abierto]);

  const filtradas = useMemo(() => {
    const t = sinAcentos(q.trim());
    if (!t) return opciones;
    return opciones.filter((o) => sinAcentos(o.etiqueta).includes(t));
  }, [opciones, q]);

  const elegida = opciones.find((o) => o.valor === valor) ?? null;
  const indice = Math.min(resaltada, Math.max(0, filtradas.length - 1));

  const cerrar = () => {
    setAbierto(false);
    setQ("");
    boton.current?.focus();
  };

  const elegir = (o: OpcionBuscable) => {
    onElegir(o.valor);
    cerrar();
  };

  const teclas = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      // Solo cierra la lista: la ventana del formulario también escucha Escape.
      e.stopPropagation();
      cerrar();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setResaltada(Math.min(indice + 1, filtradas.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setResaltada(Math.max(indice - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filtradas[indice]) elegir(filtradas[indice]);
    }
  };

  return (
    <div className="relative" ref={caja}>
      <button
        type="button"
        id={id}
        ref={boton}
        aria-haspopup="listbox"
        aria-expanded={abierto}
        aria-controls={`${id}-lista`}
        onClick={() => {
          setResaltada(0);
          setAbierto((a) => !a);
        }}
        className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm flex items-center justify-between gap-2 text-left bg-white"
      >
        <span className={elegida ? "" : "text-slate-500"}>
          {elegida ? elegida.etiqueta : placeholder}
        </span>
        <ChevronDown className="w-4 h-4 shrink-0" aria-hidden />
      </button>

      {abierto && (
        <div className="absolute z-20 mt-1 w-full rounded-xl border border-slate-200 bg-[#0D1719] shadow-xl">
          <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-2">
            <Search className="w-4 h-4 text-slate-400" aria-hidden />
            <input
              autoFocus
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setResaltada(0);
              }}
              onKeyDown={teclas}
              placeholder="Escribe para buscar"
              aria-label={etiquetaBuscador}
              aria-controls={`${id}-lista`}
              aria-activedescendant={filtradas[indice] ? `${id}-op-${indice}` : undefined}
              className="w-full bg-transparent text-sm outline-none"
            />
          </div>
          <ul id={`${id}-lista`} role="listbox" className="max-h-60 overflow-y-auto py-1">
            {filtradas.length === 0 && (
              <li className="px-3 py-3 text-sm text-slate-500">Sin coincidencias.</li>
            )}
            {filtradas.map((o, i) => (
              <li
                key={o.valor}
                id={`${id}-op-${i}`}
                role="option"
                aria-selected={o.valor === valor}
                onClick={() => elegir(o)}
                onMouseEnter={() => setResaltada(i)}
                className={`px-3 py-2 text-sm cursor-pointer flex items-center justify-between gap-2 ${
                  i === indice ? "bg-white/10" : ""
                }`}
              >
                <span>{o.etiqueta}</span>
                {o.valor === valor && <Check className="w-4 h-4 shrink-0" aria-hidden />}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
