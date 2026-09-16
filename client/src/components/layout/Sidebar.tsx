import { ChevronDown, Receipt, ShieldCheck } from "lucide-react";
import { useState } from "react";

import { useAuth } from "../../context/AuthContext";
import { MODULOS_CLIENTE } from "../../modules/registry";

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
    <aside className="w-64 sticky top-0 z-50 bg-[#0A1014]  border-l-3 border-[#DDF500] min-h-[calc(100vh-66px)] flex flex-col shadow-[4px_0_24px_rgba(0,0,0,0.02)]">
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
          // HistoricoCliente.tsx) y, desde la migración 0092, Urea
          // (mismas tablas, pestaña propia -- decisión de Kenif
          // 2026-09-10). activeTab codifica la sub-pestaña como
          // "combustible:historico"/"combustible:urea" -- CombustiblePanel
          // la lee vía la prop pestanaInicial (ver App.tsx). isActive
          // compara por prefijo para que el resaltado del ítem padre siga
          // encendido con cualquiera de las tres sub-pestañas.
          const esCombustible = tab.id === "combustible";
          const isActive = esCombustible
            ? activeTab === "combustible" ||
              activeTab === "combustible:historico" ||
              activeTab === "combustible:urea"
            : activeTab === tab.id;
          return (
            <div key={tab.id}>
              <button
                onClick={() => setActiveTab(esCombustible ? "combustible" : tab.id)}
                className={`w-full text-left px-6 py-3.5 flex  items-center gap-3 transition-all relative ${
                  isActive
                    ? "  bg-[#FFFFFF] font-semibold"
                    : "text-slate-500  hover:bg-[#FFFFFF] hover:text-slate-800 font-medium"
                }`}
              >
                {isActive && (
                  <div className="absolute left-0 top-0 bottom-0 w-1.5 z-2 bg-[#DDF500]" />
                )}

                <span className={`${isActive ? "text-[#0A1014]" : "text-slate-400"}`}>
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
                      className={isActive ? "text-[#0A1014]" : "text-slate-400"}
                    />
                  </span>
                )}
              </button>
              {esCombustible && combustibleDesplegado && (
                <div className="flex flex-col">
                  <button
                    onClick={() => setActiveTab("combustible")}
                    className={`w-full text-left pl-14 pr-6 py-2.5 text-sm transition-all ${
                      activeTab === "combustible"
                        ? "  text-[#DDF500] font-semibold"
                        : "text-slate-500  text:bg-[#FFFFFF] hover:text-[#DDF500] font-medium"
                    }`}
                  >
                    Tanques
                  </button>
                  <button
                    onClick={() => setActiveTab("combustible:historico")}
                    className={`w-full text-left pl-14 pr-6 py-2.5 text-sm transition-all ${
                      activeTab === "combustible:historico"
                        ? "  text-[#DDF500] font-semibold"
                        : "text-slate-500  text:bg-[#FFFFFF] hover:text-[#DDF500] font-medium"
                    }`}
                  >
                    Histórico
                  </button>
                  <button
                    onClick={() => setActiveTab("combustible:urea")}
                    className={`w-full text-left pl-14 pr-6 py-2.5 text-sm transition-all ${
                      activeTab === "combustible:urea"
                        ? "  text-[#DDF500] font-semibold"
                        : "text-slate-500  text:bg-[#FFFFFF] hover:text-[#DDF500] font-medium"
                    }`}
                  >
                    Urea
                  </button>
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
                ? "bg-slate-50 text-[#0A1014] font-semibold"
                : "text-slate-500 hover:bg-slate-50 hover:text-[#0A1014] font-medium"
            }`}
          >
            {activeTab === "administracion" && (
              <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-[#DDF500]" />
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
              ? "bg-slate-50 text-[#0A1014] font-semibold"
              : "text-slate-500 hover:bg-slate-50 hover:text-[#0A1014] font-medium"
          }`}
        >
          {activeTab === "facturacion" && (
            <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-[#DDF500]" />
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
