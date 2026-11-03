// client/src/components/comunes/SubmenuDesplegable.tsx
//
// El despliegue animado de los submenús del menú lateral (Combustible y
// Gestión operacional de flota): la altura pasa de 0fr a 1fr (así no hace falta
// medir nada) y cada subitem entra con un pequeño desfase, deslizándose desde
// la izquierda. `invisible` con la misma transición saca los ítems ocultos del
// foco de teclado recién cuando terminó de cerrarse.
import type { LucideIcon } from "lucide-react";

export interface ItemDeSubmenu {
  tab: string;
  label: string;
  Icono: LucideIcon;
}

interface SubmenuDesplegableProps {
  items: ItemDeSubmenu[];
  desplegado: boolean;
  activeTab: string;
  setActiveTab: (tab: string) => void;
  /** Cambia el texto de un ítem para ciertos perfiles (ej. "Tanques" -> "Tanquetas"). */
  etiquetaDe?: (item: ItemDeSubmenu) => string;
}

export function SubmenuDesplegable({
  items,
  desplegado,
  activeTab,
  setActiveTab,
  etiquetaDe,
}: SubmenuDesplegableProps) {
  return (
    <div
      aria-hidden={!desplegado}
      className={`grid transition-[grid-template-rows,visibility] duration-300 ease-out motion-reduce:transition-none ${
        desplegado ? "grid-rows-[1fr] visible" : "grid-rows-[0fr] invisible"
      }`}
    >
      <div className="overflow-hidden">
        <div className="flex flex-col">
          {items.map((item, i) => {
            const { tab: destino, label, Icono } = item;
            const activo = activeTab === destino;
            return (
              <div
                key={destino}
                style={{ transitionDelay: desplegado ? `${80 + i * 50}ms` : "0ms" }}
                className={`transition-[opacity,transform] duration-300 ease-out motion-reduce:transition-none ${
                  desplegado ? "opacity-100 translate-x-0" : "opacity-0 -translate-x-3"
                }`}
              >
                <button
                  onClick={() => setActiveTab(destino)}
                  tabIndex={desplegado ? 0 : -1}
                  className={`group w-full text-left pl-12 pr-6 py-2.5 text-sm flex items-center gap-3 transition-all ${
                    activo
                      ? "text-[#BADC1E] font-semibold"
                      : "text-slate-500 hover:text-[#BADC1E] font-medium"
                  }`}
                >
                  <Icono className="w-4 h-4 shrink-0" />
                  {etiquetaDe ? etiquetaDe(item) : label}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
