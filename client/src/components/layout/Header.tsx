import { LogOut, User as UserIcon } from "lucide-react";

import SelectorEmpresa from "./SelectorEmpresa";
import { useAuth } from "../../context/AuthContext";
import CampanitaAlertas from "../combustible/CampanitaAlertas";

interface HeaderProps {
  onIrACombustible?: () => void;
}

export default function Header({ onIrACombustible }: HeaderProps) {
  const { usuario, logout } = useAuth();
  const puedeVerAlertasCombustible =
    usuario?.rol === "admin" && (usuario?.modulosPermitidos.includes("combustible") ?? false);

  return (
    <header className="sticky top-0 z-50 bg-[#0A1014] border-b-2 border-[#DDF500]">
      <div className="max-w-7xl mx-auto px-6 lg:px-8 py-3">
        <div className="flex items-center justify-between gap-6">
          {/* Logo y Brand */}
          <div className="flex items-center gap-4">
            {/**logo-mincore */}
            <img
              src="/logos/mincore-logo-512-sin-fondo.png"
              alt="MinCore"
              className=" w-14 h-14 rounded-xl"
            />

            <div className="flex flex-col">
              <h1 className="text-lg font-semibold text-white tracking-wide uppercase">
                Mincore ERP
              </h1>
              <span className="text-[10px] font-medium text-slate-400 tracking-widest uppercase">
                Sistema de Gestión
              </span>
            </div>
          </div>

          {/* Date and User */}
          <div className="hidden md:flex items-center gap-6">
            <div className="text-right">
              <p className="text-sm font-medium text-slate-300 font-mono">
                {new Date()
                  .toLocaleDateString("es-PE", {
                    year: "numeric",
                    month: "2-digit",
                    day: "2-digit",
                  })
                  .replace(/\//g, "-")}
              </p>
            </div>

            <div className="w-px h-6 bg-slate-700"></div>

            {/* Solo aparece para quien trabaja en más de una empresa. */}
            <SelectorEmpresa />

            <CampanitaAlertas
              activo={puedeVerAlertasCombustible}
              onIrACombustible={onIrACombustible}
            />

            <div className="flex items-center gap-3">
              <div className="w-9 h-9 bg-slate-800 border border-slate-700 rounded-md flex items-center justify-center text-[#DDF500]">
                <UserIcon size={18} strokeWidth={2.5} />
              </div>
              <div className="flex flex-col">
                <p className="text-sm font-medium text-white">
                  {usuario?.nombre ?? "Operador Mincore"}
                </p>
                <span className="text-[10px] text-[#DDF500] uppercase tracking-wider font-semibold">
                  En línea
                </span>
              </div>
            </div>

            <button
              onClick={() => logout()}
              className="ml-2 p-2 text-slate-400 hover:text-[#DDF500] hover:bg-white/5 rounded-md transition-all flex items-center gap-2"
              title="Cerrar sesión"
            >
              <LogOut size={18} />
              <span className="text-sm font-medium uppercase tracking-wider hidden lg:block">
                Salir
              </span>
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}
