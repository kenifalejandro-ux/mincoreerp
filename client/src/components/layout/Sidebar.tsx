import {
  ChevronDown,
  Droplets,
  Fuel,
  History,
  Receipt,
  ScrollText,
  SearchCheck,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";

import { useAuth } from "../../context/AuthContext";
import { MODULOS_CLIENTE } from "../../modules/registry";

// Submenú de Combustible. Los íconos son de trazo (lucide), los mismos que
// usan las acciones de la tabla de tanques.
const SUBMENU_COMBUSTIBLE: { tab: string; label: string; Icono: LucideIcon }[] = [
  { tab: "combustible", label: "Tanques", Icono: Fuel },
  { tab: "combustible:historico", label: "Histórico", Icono: History },
  { tab: "combustible:urea", label: "Urea", Icono: Droplets },
  { tab: "combustible:auditoria", label: "Auditoría", Icono: SearchCheck },
  { tab: "combustible:bitacora", label: "Bitácora", Icono: ScrollText },
];

interface SidebarProps {
  activeTab: string;
  setActiveTab: (tab: any) => void;
}

export default function Sidebar({ activeTab, setActiveTab }: SidebarProps) {
  const { usuario } = useAuth();

  const tabs = MODULOS_CLIENTE.filter((modulo) => usuario?.modulosPermitidos.includes(modulo.id));

  // El submenú de Combustible se abre/cierra con la flechita, no con el
  // click de navegar -- antes se abría solo porque isActive lo forzaba, y
  // Kenif pidió separarlos: click en "Combustible" navega, click en la
  // flecha despliega/pliega, cada uno su gesto.
  const [combustibleDesplegado, setCombustibleDesplegado] = useState(false);

  return (
    <aside className="w-64 shrink-0 overflow-y-auto pb-6 bg-[#192526]  border-l-3 border-[#BADC1E] flex flex-col shadow-[4px_0_24px_rgba(0,0,0,0.02)]">
      <div className="p-4 border-b border-slate-100">
        <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">
          Módulos Operativos
        </span>
      </div>

      <nav className="flex-1 py-4 flex flex-col gap-1">
        {tabs.map((tab) => {
          // Combustible es, por ahora, el único módulo con submenú: adentro
          // viven el Histórico que pidió el cliente (consumo, recepciones,
          // compras externas, por conductor, por vehículo -- ver
          // HistoricoCliente.tsx), Urea (migración 0092, mismas tablas,
          // pestaña propia -- decisión de Kenif 2026-09-10), y Auditoría /
          // Bitácora, que ANTES eran botones dentro de "Tanques" que abrían
          // un panel flotante o un modal -- pasaron a sub-pestañas propias
          // para que "Tanques" deje de cargar con acciones que no son de
          // ABM (2026-09-16). activeTab codifica la sub-pestaña como
          // "combustible:<nombre>" -- CombustiblePanel la lee vía la prop
          // pestanaInicial (ver App.tsx). isActive compara por prefijo para
          // que el resaltado del ítem padre siga encendido con cualquiera
          // de las cinco sub-pestañas.
          const esCombustible = tab.id === "combustible";
          const isActive = esCombustible
            ? activeTab === "combustible" ||
              activeTab === "combustible:historico" ||
              activeTab === "combustible:urea" ||
              activeTab === "combustible:auditoria" ||
              activeTab === "combustible:bitacora"
            : activeTab === tab.id;
          return (
            <div key={tab.id}>
              <button
                onClick={() => setActiveTab(esCombustible ? "combustible" : tab.id)}
                className={`group w-full text-left px-6 py-3.5 flex  items-center gap-3 transition-all relative ${
                  isActive
                    ? "bg-[#BADC1E] text-[#0A1014] hover:bg-[#BADC1E] font-semibold"
                    : "text-slate-500  hover:bg-[#BADC1E] font-medium"
                }`}
              >
                {isActive && (
                  <div className="absolute left-0 top-0 bottom-0 w-1.5 z-2 bg-[#BADC1E]" />
                )}

                <span
                  className={`${isActive ? "text-[#0A1014]" : "text-slate-400 group-hover:text-[#0A1014]"}`}
                >
                  {tab.icono}
                </span>
                <span className="tracking-tight flex-1">{tab.label}</span>
                {esCombustible && (
                  <span
                    role="button"
                    aria-label={combustibleDesplegado ? "Cerrar submenú" : "Abrir submenú"}
                    onClick={(e) => {
                      e.stopPropagation();
                      setCombustibleDesplegado((v) => !v);
                    }}
                    className={`p-1 rounded transition-transform ${combustibleDesplegado ? "rotate-180" : ""}`}
                  >
                    <ChevronDown
                      size={16}
                      className={
                        isActive ? "text-[#0A1014]" : "text-slate-400 group-hover:text-[#0A1014]"
                      }
                    />
                  </span>
                )}
              </button>
              {esCombustible && (
                /* Despliegue animado: la altura pasa de 0fr a 1fr (así no hace
                   falta medir nada) y cada subitem entra con un pequeño
                   desfase, deslizándose desde la izquierda. `invisible` con
                   la misma transición saca los ítems ocultos del foco de
                   teclado recién cuando terminó de cerrarse. */
                <div
                  aria-hidden={!combustibleDesplegado}
                  className={`grid transition-[grid-template-rows,visibility] duration-300 ease-out motion-reduce:transition-none ${
                    combustibleDesplegado ? "grid-rows-[1fr] visible" : "grid-rows-[0fr] invisible"
                  }`}
                >
                  <div className="overflow-hidden">
                    <div className="flex flex-col">
                      {SUBMENU_COMBUSTIBLE.map(({ tab: destino, label, Icono }, i) => {
                        const activo = activeTab === destino;
                        return (
                          <div
                            key={destino}
                            style={{
                              transitionDelay: combustibleDesplegado ? `${80 + i * 50}ms` : "0ms",
                            }}
                            className={`transition-[opacity,transform] duration-300 ease-out motion-reduce:transition-none ${
                              combustibleDesplegado
                                ? "opacity-100 translate-x-0"
                                : "opacity-0 -translate-x-3"
                            }`}
                          >
                            <button
                              onClick={() => setActiveTab(destino)}
                              tabIndex={combustibleDesplegado ? 0 : -1}
                              className={`group w-full text-left pl-12 pr-6 py-2.5 text-sm flex items-center gap-3 transition-all ${
                                activo
                                  ? "text-[#BADC1E] font-semibold"
                                  : "text-slate-500 hover:text-[#BADC1E] font-medium"
                              }`}
                            >
                              <Icono className="w-4 h-4 shrink-0" />
                              {label}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        <div className="my-2 mx-6 h-px bg-slate-100" />

        {/* Solo para el admin del tenant: acá se decide quién entra al
            sistema y con qué. El backend lo exige igual
            (requireRole("admin")), esto es para no mostrar una puerta que va
            a estar cerrada. */}
        {usuario?.rol === "admin" && (
          <button
            onClick={() => setActiveTab("administracion")}
            className={`w-full text-left px-6 py-3.5 flex items-center gap-3 transition-all relative ${
              activeTab === "administracion"
                ? "bg-[#BADC1E] text-[#0A1014] font-semibold"
                : "text-slate-500 hover:bg-[#BADC1E] hover:text-[#0A1014] font-medium"
            }`}
          >
            {activeTab === "administracion" && (
              <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-[#BADC1E]" />
            )}
            <span
              className={`${activeTab === "administracion" ? "text-[#0A1014]" : "text-slate-400"}`}
            >
              <ShieldCheck size={20} strokeWidth={2} />
            </span>
            <span className="tracking-tight">Administración</span>
          </button>
        )}

        <button
          onClick={() => setActiveTab("facturacion")}
          className={`w-full text-left px-6 py-3.5 flex items-center gap-3 transition-all relative ${
            activeTab === "facturacion"
              ? "bg-[#BADC1E] text-[#0A1014] font-semibold"
              : "text-slate-500 hover:bg-[#BADC1E] hover:text-[#0A1014] font-medium"
          }`}
        >
          {activeTab === "facturacion" && (
            <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-[#BADC1E]" />
          )}
          <span className={`${activeTab === "facturacion" ? "text-[#0A1014]" : "text-slate-400"}`}>
            <Receipt size={20} strokeWidth={2} />
          </span>
          <span className="tracking-tight">Facturación</span>
        </button>
      </nav>
    </aside>
  );
}
