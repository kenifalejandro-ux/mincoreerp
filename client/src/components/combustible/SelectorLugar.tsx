// El campo de un lugar del recorrido (0179): un campo vacío que al tocarlo muestra debajo los lugares
// en una lista con scroll, filtra mientras se escribe (sin importar mayúsculas) y, si lo escrito no
// está en el catálogo, ofrece usarlo igual: se agrega al catálogo al crear el viaje. Mismo patrón que
// el campo de placa de «Registro de despacho», sin desplegables nativos.
import { useEffect, useRef, useState } from "react";

import type { Lugar } from "./empezarViaje";

const CAMPO =
  "w-full bg-[#0D1719] border border-[#334155] rounded-xl px-4 py-3 text-lg text-white min-h-[50px]";

export function SelectorLugar({
  etiqueta,
  valor,
  lugares,
  onChange,
}: {
  etiqueta: string;
  valor: Lugar;
  lugares: { id: number; nombre: string }[];
  onChange: (l: Lugar) => void;
}) {
  const nombreInicial =
    typeof valor === "string" ? valor : (lugares.find((l) => l.id === valor)?.nombre ?? "");
  const [texto, setTexto] = useState(nombreInicial);
  const [abierto, setAbierto] = useState(false);
  const caja = useRef<HTMLDivElement>(null);

  const q = texto.trim().toLowerCase();
  const filtrados = lugares.filter((l) => !q || l.nombre.toLowerCase().includes(q));
  const hayExacto = lugares.some((l) => l.nombre.trim().toLowerCase() === q);

  // Tocar afuera cierra la lista. Si quedó algo escrito sin elegir, se toma lo escrito: el del
  // catálogo si coincide exactamente, o uno nuevo.
  useEffect(() => {
    if (!abierto) return;
    const alTocar = (e: PointerEvent) => {
      if (caja.current?.contains(e.target as Node)) return;
      setAbierto(false);
      const t = texto.trim();
      if (valor === null && t.length >= 2) {
        const exacto = lugares.find((l) => l.nombre.trim().toLowerCase() === t.toLowerCase());
        onChange(exacto ? exacto.id : t);
      }
    };
    document.addEventListener("pointerdown", alTocar);
    return () => document.removeEventListener("pointerdown", alTocar);
  }, [abierto, texto, valor, lugares, onChange]);

  const elegir = (l: Lugar, nombre: string) => {
    setTexto(nombre);
    setAbierto(false);
    onChange(l);
  };

  return (
    <div ref={caja}>
      <label className="block text-xs font-bold uppercase tracking-wide text-[#94a3b8] mb-1.5">
        {etiqueta}
        <input
          className={`${CAMPO} mt-1.5 normal-case tracking-normal font-normal`}
          autoComplete="off"
          placeholder="Escribe o elige el lugar"
          value={texto}
          onFocus={() => setAbierto(true)}
          onClick={() => setAbierto(true)}
          onChange={(e) => {
            setTexto(e.target.value);
            setAbierto(true);
            // Mientras escribe no hay lugar elegido: se elige de la lista o con «Usar».
            onChange(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setAbierto(false);
          }}
        />
      </label>
      {abierto && (
        <div
          role="listbox"
          aria-label={`Lugares para ${etiqueta}`}
          className="mt-1.5 max-h-52 overflow-y-auto overscroll-contain rounded-xl border border-[#334155] bg-[#14201f]"
        >
          {q.length >= 2 && !hayExacto && (
            <button
              type="button"
              role="option"
              aria-selected={false}
              className="block w-full min-h-[44px] border-b border-[#334155] px-4 py-2 text-left text-sm text-[#BADC1E] hover:bg-[#1f2c2e]"
              onClick={() => elegir(texto.trim(), texto.trim())}
            >
              Usar «{texto.trim()}»{filtrados.length === 0 ? " (se agrega a los lugares)" : ""}
            </button>
          )}
          {filtrados.map((l) => (
            <button
              key={l.id}
              type="button"
              role="option"
              aria-selected={valor === l.id}
              className="block w-full min-h-[44px] px-4 py-2 text-left text-white hover:bg-[#1f2c2e]"
              onClick={() => elegir(l.id, l.nombre)}
            >
              {l.nombre}
            </button>
          ))}
          {filtrados.length === 0 && q.length < 2 && (
            <p className="px-4 py-3 text-sm text-[#94a3b8]">
              No hay lugares todavía: escribe el tuyo.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
