// client/src/components/proveedores/MasAcciones.tsx
//
// El menú de acciones de un proveedor: el botón «Más acciones» de la cabecera de su ficha, o el de tres puntos
// de cada fila del Directorio. Sin acciones, no se dibuja. Se cierra con Escape, al pulsar fuera, al hacer scroll
// o al cambiar el tamaño de la ventana. El menú se dibuja aparte (fuera de la tabla) para que una tabla con
// scroll no lo recorte.
import { MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface AccionDeMenu {
  id: string;
  etiqueta: string;
  alElegir: () => void;
  /** Una acción que borra o quita: sale en rojo. */
  peligrosa?: boolean;
}

export default function MasAcciones({
  acciones,
  etiqueta = "Más acciones",
  soloIcono = false,
}: {
  acciones: AccionDeMenu[];
  /** El texto del botón, o su nombre accesible si es solo el icono. */
  etiqueta?: string;
  /** Solo los tres puntos (filas de una tabla). */
  soloIcono?: boolean;
}) {
  const [posicion, setPosicion] = useState<{ arriba: number; derecha: number } | null>(null);
  const boton = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const abierto = posicion !== null;

  useEffect(() => {
    if (!abierto) return;
    const cerrar = () => setPosicion(null);
    const fuera = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!boton.current?.contains(t) && !menu.current?.contains(t)) cerrar();
    };
    // En captura y con preventDefault: Escape cierra SOLO el menú y no el panel de detalle que esté debajo.
    const escape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      cerrar();
    };
    document.addEventListener("mousedown", fuera);
    document.addEventListener("keydown", escape, true);
    window.addEventListener("resize", cerrar);
    window.addEventListener("scroll", cerrar, true);
    return () => {
      document.removeEventListener("mousedown", fuera);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", cerrar);
      window.removeEventListener("scroll", cerrar, true);
    };
  }, [abierto]);

  if (acciones.length === 0) return null;

  const alternar = () => {
    if (abierto) return setPosicion(null);
    const r = boton.current?.getBoundingClientRect();
    if (!r) return;
    setPosicion({ arriba: r.bottom + 4, derecha: Math.max(8, window.innerWidth - r.right) });
  };

  return (
    <>
      <button
        ref={boton}
        onClick={alternar}
        aria-haspopup="menu"
        aria-expanded={abierto}
        aria-label={soloIcono ? etiqueta : undefined}
        className={
          soloIcono
            ? "rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
            : "flex items-center gap-2 h-10 px-4 rounded-lg border border-slate-300 bg-white text-sm font-semibold text-slate-700 hover:bg-slate-50"
        }
      >
        <MoreHorizontal size={16} /> {!soloIcono && etiqueta}
      </button>
      {posicion &&
        createPortal(
          <div
            ref={menu}
            role="menu"
            aria-label={etiqueta}
            style={{ top: posicion.arriba, right: posicion.derecha }}
            className="fixed z-[60] w-56 rounded-lg border border-slate-200 bg-white py-1 shadow-lg"
          >
            {acciones.map((a) => (
              <button
                key={a.id}
                role="menuitem"
                onClick={() => {
                  setPosicion(null);
                  a.alElegir();
                }}
                className={`block w-full px-4 py-2 text-left text-sm hover:bg-slate-50 ${
                  a.peligrosa ? "text-red-700" : "text-slate-700"
                }`}
              >
                {a.etiqueta}
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  );
}
