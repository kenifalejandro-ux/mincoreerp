// client/src/components/proveedores/PanelDeDetalle.tsx
//
// El panel de detalle del ecosistema «Gestión de proveedores»: una hoja grande anclada a la DERECHA que se abre
// encima de la pantalla en la que está la persona (Directorio, Gestión comercial, Compras, Historial) sin
// cambiarla: la tabla de atrás conserva su búsqueda, sus filtros y su posición. Se cierra con ✕, con Escape o
// pulsando fuera. Queda debajo de los formularios (modales) que se abran desde adentro.
import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

export default function PanelDeDetalle({
  etiqueta,
  titulo,
  onCerrar,
  children,
}: {
  /** Nombre accesible del panel («Detalle del proveedor»). */
  etiqueta: string;
  /** El texto pequeño de arriba («Proveedor», «Compra»). */
  titulo: string;
  onCerrar: () => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLElement>(null);
  const cerrar = useRef(onCerrar);
  useEffect(() => {
    cerrar.current = onCerrar;
  }, [onCerrar]);

  // Al abrir: el foco entra al panel y la página de atrás deja de moverse; al cerrar, todo vuelve a su lugar.
  useEffect(() => {
    const anterior = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const html = document.documentElement;
    const overflow = html.style.overflow;
    html.style.overflow = "hidden";
    return () => {
      html.style.overflow = overflow;
      anterior?.focus?.();
    };
  }, []);

  // Escape cierra el panel, salvo que haya un formulario abierto encima: ese se cierra primero.
  useEffect(() => {
    const alTeclear = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      cerrar.current();
    };
    document.addEventListener("keydown", alTeclear);
    return () => document.removeEventListener("keydown", alTeclear);
  }, []);

  return (
    <div className="fixed inset-x-0 bottom-0 top-16 z-[45]">
      {/* La sombra de atrás: pulsarla cierra el panel (el teclado usa Escape o el ✕). */}
      <div aria-hidden onClick={onCerrar} className="absolute inset-0 bg-slate-900/30" />
      <aside
        ref={panel}
        tabIndex={-1}
        aria-label={etiqueta}
        className="absolute inset-y-0 right-0 flex w-full flex-col border-l border-slate-200 bg-[#f4f6f9] shadow-2xl outline-none lg:w-[min(1040px,calc(100vw-16rem-1.5rem))]"
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-2.5 sm:px-6">
          <span className="text-[10px] font-bold uppercase tracking-[0.13em] text-slate-500">
            {titulo}
          </span>
          <button
            onClick={onCerrar}
            aria-label="Cerrar el panel"
            className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
          >
            <X size={18} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">{children}</div>
      </aside>
    </div>
  );
}
