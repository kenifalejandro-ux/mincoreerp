import { Receipt, Users } from "lucide-react";

import { useAuth } from "../../context/AuthContext";
import { MODULOS_CLIENTE } from "../../modules/registry";

interface SidebarProps {
  activeTab: string;
  setActiveTab: (tab: any) => void;
}

export default function Sidebar({ activeTab, setActiveTab }: SidebarProps) {
  const { usuario } = useAuth();

  const tabs = MODULOS_CLIENTE.filter((modulo) => usuario?.modulosPermitidos.includes(modulo.id));

  return (
    <aside className="w-64 bg-[#FFFFFF] border-r border-slate-200 min-h-[calc(100vh-66px)] flex flex-col shadow-[4px_0_24px_rgba(0,0,0,0.02)]">
      <div className="p-4 border-b border-slate-100">
        <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">
          Módulos Operativos
        </span>
      </div>

      <nav className="flex-1 py-4 flex flex-col gap-1">
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`w-full text-left px-6 py-3.5 flex items-center gap-3 transition-all relative ${
                isActive
                  ? "bg-slate-50 text-[#0A1014] font-semibold"
                  : "text-slate-500 hover:bg-slate-50 hover:text-[#0A1014] font-medium"
              }`}
            >
              {isActive && <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-[#DDF500]" />}

              <span className={`${isActive ? "text-[#0A1014]" : "text-slate-400"}`}>
                {tab.icono}
              </span>
              <span className="tracking-tight">{tab.label}</span>
            </button>
          );
        })}

        <div className="my-2 mx-6 h-px bg-slate-100" />

        {/* Solo para el admin del tenant: dar de alta a alguien es dar acceso
            al sistema. El backend lo exige igual (requireRole("admin")), esto
            es para no mostrar una puerta que va a estar cerrada. */}
        {usuario?.rol === "admin" && (
          <button
            onClick={() => setActiveTab("usuarios")}
            className={`w-full text-left px-6 py-3.5 flex items-center gap-3 transition-all relative ${
              activeTab === "usuarios"
                ? "bg-slate-50 text-[#0A1014] font-semibold"
                : "text-slate-500 hover:bg-slate-50 hover:text-[#0A1014] font-medium"
            }`}
          >
            {activeTab === "usuarios" && (
              <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-[#DDF500]" />
            )}
            <span className={`${activeTab === "usuarios" ? "text-[#0A1014]" : "text-slate-400"}`}>
              <Users size={20} strokeWidth={2} />
            </span>
            <span className="tracking-tight">Usuarios</span>
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
