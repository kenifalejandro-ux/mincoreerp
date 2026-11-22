// client/src/components/proveedores/MasAcciones.tsx
//
// El botón «Más acciones» de la cabecera de la ficha: un menú corto con lo que esta persona puede hacer con el
// proveedor. Sin acciones, no se dibuja. Se cierra con Escape o al pulsar fuera.
import { MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export interface AccionDeMenu {
  id: string;
  etiqueta: string;
  alElegir: () => void;
}

export default function MasAcciones({ acciones }: { acciones: AccionDeMenu[] }) {
  const [abierto, setAbierto] = useState(false);
  const caja = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!abierto) return;
    const fuera = (e: MouseEvent) => {
      if (caja.current && !caja.current.contains(e.target as Node)) setAbierto(false);
    };
    const escape = (e: KeyboardEvent) => e.key === "Escape" && setAbierto(false);
    document.addEventListener("mousedown", fuera);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", fuera);
      document.removeEventListener("keydown", escape);
    };
  }, [abierto]);

  if (acciones.length === 0) return null;
  return (
    <div ref={caja} className="relative">
      <button
        onClick={() => setAbierto((a) => !a)}
        aria-haspopup="menu"
        aria-expanded={abierto}
        className="flex items-center gap-2 h-10 px-4 rounded-lg border border-slate-300 bg-white text-sm font-semibold text-slate-700 hover:bg-slate-50"
      >
        <MoreHorizontal size={16} /> Más acciones
      </button>
      {abierto && (
        <div
          role="menu"
          aria-label="Más acciones"
          className="absolute right-0 z-20 mt-1 w-52 rounded-lg border border-slate-200 bg-white py-1 shadow-lg"
        >
          {acciones.map((a) => (
            <button
              key={a.id}
              role="menuitem"
              onClick={() => {
                setAbierto(false);
                a.alElegir();
              }}
              className="block w-full px-4 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
            >
              {a.etiqueta}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
