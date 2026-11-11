import { LogOut, Tv, User as UserIcon } from "lucide-react";

import SelectorEmpresa from "./SelectorEmpresa";
import { useAuth } from "../../context/AuthContext";
import CampanitaAlertas from "../combustible/CampanitaAlertas";
import { marcarNovedadVista, novedadVigente } from "../controlTv/novedad";
import { puedeVerControlTv } from "../flota/flotaAcceso";

interface HeaderProps {
  onIrACombustible?: () => void;
}

export default function Header({ onIrACombustible }: HeaderProps) {
  const { usuario, logout } = useAuth();
  const puedeVerAlertasCombustible =
    usuario?.rol === "admin" && (usuario?.modulosPermitidos.includes("combustible") ?? false);

  return (
    <header className="sticky top-0 z-50 bg-[#0D1719] border-b border-[#DDF500]">
      <div className="w-full px-3 py-2 sm:px-6 sm:py-3">
        <div className="flex items-center justify-between gap-3 sm:gap-6">
          {/* Logo y Brand */}
          <div className="flex items-center gap-2 sm:gap-4 min-w-0">
            {/**logo-mincore */}
            <img
              src="/logos/mincore-logo-512-sin-fondo.png"
              alt="MinCore"
              className="w-10 h-10 sm:w-14 sm:h-14 rounded-xl shrink-0"
            />

            <div className="flex flex-col min-w-0">
              <h1 className="text-base sm:text-lg font-semibold text-white tracking-wide truncate">
                Mincore ERP
              </h1>
              <span className="hidden sm:block text-[10px] font-medium text-slate-400 tracking-widest uppercase">
                Sistema de Gestión
              </span>
            </div>
          </div>

          {/* Date and User */}
          <div className="flex items-center gap-2 sm:gap-4 lg:gap-6 shrink-0">
            {/* El Control TV engloba todo el resumen: va arriba, al lado de la fecha. */}
            {puedeVerControlTv(usuario) && (
              <button
                onClick={() => {
                  marcarNovedadVista();
                  window.open("/control-tv", "_blank");
                }}
                aria-label="Control TV"
                title="Control TV: la flota y el combustible en pantalla completa"
                className="relative p-2 rounded-md border border-[#BADC1E]/50 text-[#BADC1E] hover:bg-[#BADC1E]/10 transition-all"
              >
                <Tv size={18} />
                {novedadVigente() && (
                  <span
                    aria-hidden
                    className="absolute -top-2 -right-3 rounded-full bg-sky-500 px-1.5 text-[9px] font-extrabold uppercase leading-4 tracking-wide text-white shadow"
                  >
                    Nuevo
                  </span>
                )}
              </button>
            )}

            <div className="hidden lg:block text-right">
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

            <div className="hidden lg:block w-px h-6 bg-slate-700"></div>

            {/* Solo aparece para quien trabaja en más de una empresa. */}
            <SelectorEmpresa />

            <CampanitaAlertas
              activo={puedeVerAlertasCombustible}
              onIrACombustible={onIrACombustible}
            />

            <div className="flex items-center gap-3" title={usuario?.nombre}>
              <div className="w-9 h-9 bg-slate-800 border border-slate-700 rounded-md flex items-center justify-center text-[#DDF500] shrink-0">
                <UserIcon size={18} strokeWidth={2.5} />
              </div>
              <div className="hidden md:flex flex-col">
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
              className="sm:ml-2 p-2 text-slate-400 hover:text-[#DDF500] hover:bg-white/5 rounded-md transition-all flex items-center gap-2"
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
