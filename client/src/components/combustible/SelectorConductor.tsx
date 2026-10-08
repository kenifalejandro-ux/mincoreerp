import { Check, ChevronDown, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

export interface OpcionConductor {
  equipoId: number;
  nombre: string;
  dni: string;
  unidad: string;
  /** El conductor no tiene usuario: no vería el viaje en "Mi viaje". */
  sinUsuario: boolean;
}

const sinAcentos = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Desplegable con buscador: la encargada escribe parte del nombre, DNI o
 *  placa y elige. Los datos de la unidad y la ruta vienen de Equipos.
 *  Vive dentro del formulario de programar viaje, así que el buscador se
 *  queda con Enter: si no, elegir conductor enviaría el formulario a medias. */
export function SelectorConductor({
  opciones,
  valor,
  onElegir,
}: {
  opciones: OpcionConductor[];
  valor: number | null;
  onElegir: (o: OpcionConductor) => void;
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
    return opciones.filter((o) => sinAcentos(`${o.nombre} ${o.dni} ${o.unidad}`).includes(t));
  }, [opciones, q]);

  const elegida = opciones.find((o) => o.equipoId === valor) ?? null;
  const indice = Math.min(resaltada, Math.max(0, filtradas.length - 1));

  const cerrar = () => {
    setAbierto(false);
    setQ("");
    boton.current?.focus();
  };

  const elegir = (o: OpcionConductor) => {
    onElegir(o);
    setAbierto(false);
    setQ("");
    boton.current?.focus();
  };

  const teclas = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
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
        id="viaje-conductor"
        ref={boton}
        aria-haspopup="listbox"
        aria-expanded={abierto}
        aria-controls="viaje-conductor-lista"
        onClick={() => {
          setResaltada(0);
          setAbierto((a) => !a);
        }}
        className="w-full border border-slate-200 rounded-xl p-3 text-sm flex items-center justify-between gap-2 text-left"
      >
        <span className={elegida ? "" : "text-slate-500"}>
          {elegida ? elegida.nombre : "Elegir conductor..."}
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
              placeholder="Buscar nombre, DNI o placa"
              aria-label="Buscar conductor"
              aria-controls="viaje-conductor-lista"
              aria-activedescendant={
                filtradas[indice] ? `viaje-conductor-op-${filtradas[indice].equipoId}` : undefined
              }
              className="w-full bg-transparent text-sm outline-none"
            />
          </div>
          <ul id="viaje-conductor-lista" role="listbox" className="max-h-60 overflow-y-auto py-1">
            {filtradas.length === 0 && (
              <li className="px-3 py-3 text-sm text-slate-500">
                {opciones.length === 0
                  ? "Ninguna unidad tiene conductor asignado. Asígnalo en Equipos."
                  : "Sin coincidencias."}
              </li>
            )}
            {filtradas.map((o, i) => (
              <li
                key={o.equipoId}
                id={`viaje-conductor-op-${o.equipoId}`}
                role="option"
                aria-selected={o.equipoId === valor}
                onClick={() => elegir(o)}
                onMouseEnter={() => setResaltada(i)}
                className={`px-3 py-2 text-sm cursor-pointer flex items-start justify-between gap-2 ${
                  i === indice ? "bg-white/10" : ""
                }`}
              >
                <span>
                  <span className="font-semibold">{o.nombre}</span>
                  <span className="block text-xs text-slate-400">
                    DNI {o.dni || "—"} · {o.unidad}
                    {o.sinUsuario && " · sin usuario"}
                  </span>
                </span>
                {o.equipoId === valor && <Check className="w-4 h-4 shrink-0" aria-hidden />}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
