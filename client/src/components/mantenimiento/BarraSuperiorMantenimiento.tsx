// client/src/components/mantenimiento/BarraSuperiorMantenimiento.tsx
//
// La barra superior del ecosistema, como en la maqueta: marca, el nombre del espacio, el buscador de unidades
// (Ctrl K), la campana de alertas y la persona con su perfil. El buscador mira hoy los equipos; las órdenes y
// los checklists se suman cuando existan. La campana no inventa alertas: sin avisos lo dice y no lleva punto.
import { Bell, LogOut, Menu, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { FILTROS_VACIOS, filtrarEquipos } from "./equiposMantenimiento";
import { listarEquipos, type EquipoMantenimiento } from "./mantenimientoApi";
import { etiquetaDelPerfil, inicialesDe } from "./perfilMantenimiento";
import { useAuth } from "../../context/AuthContext";

const MAX_SUGERENCIAS = 6;

export default function BarraSuperiorMantenimiento({
  onAbrirMenu,
  onBuscar,
}: {
  onAbrirMenu: () => void;
  /** Lleva a Equipos con este texto ya escrito en el buscador de la lista. */
  onBuscar: (texto: string) => void;
}) {
  const { usuario, logout } = useAuth();
  const [texto, setTexto] = useState("");
  const [enfocado, setEnfocado] = useState(false);
  const [equipos, setEquipos] = useState<EquipoMantenimiento[] | null>(null);
  const [alertasAbiertas, setAlertasAbiertas] = useState(false);
  const entrada = useRef<HTMLInputElement>(null);

  // Ctrl K enfoca el buscador desde cualquier pantalla del ecosistema.
  useEffect(() => {
    const alTeclear = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        entrada.current?.focus();
      }
    };
    window.addEventListener("keydown", alTeclear);
    return () => window.removeEventListener("keydown", alTeclear);
  }, []);

  // La lista se pide la primera vez que se enfoca el buscador, no al abrir el ecosistema.
  useEffect(() => {
    if (!enfocado || equipos !== null) return;
    let vigente = true;
    listarEquipos()
      .then((d) => vigente && setEquipos(d.equipos))
      .catch(() => vigente && setEquipos([]));
    return () => {
      vigente = false;
    };
  }, [enfocado, equipos]);

  const consulta = texto.trim();
  const sugerencias =
    consulta.length >= 2 && equipos
      ? filtrarEquipos(equipos, { ...FILTROS_VACIOS, busqueda: consulta }).slice(0, MAX_SUGERENCIAS)
      : [];

  const ir = (valor: string) => {
    setTexto("");
    setEnfocado(false);
    entrada.current?.blur();
    onBuscar(valor);
  };

  return (
    <header className="fixed inset-x-0 top-0 z-40 h-16 bg-white border-b border-slate-200 flex items-center gap-3 px-4 sm:px-6">
      <button
        onClick={onAbrirMenu}
        aria-label="Abrir el menú"
        className="lg:hidden p-2 -ml-2 rounded-md text-slate-600 hover:bg-slate-100"
      >
        <Menu size={20} />
      </button>
      <div className="flex items-center gap-3 lg:w-56 shrink-0">
        <span className="w-9 h-9 rounded-lg bg-[#0A1014] grid place-items-center">
          <img src="/logos/mincore-logo-512-sin-fondo.png" alt="MinCore" className="w-7 h-7" />
        </span>
        <span className="hidden sm:block font-semibold tracking-wide text-slate-900">
          MINCORE{" "}
          <span className="text-[9px] font-extrabold tracking-[0.16em] text-[#4d7c0f]">ERP</span>
        </span>
      </div>
      <div className="hidden md:flex flex-col leading-tight pl-5 border-l border-slate-200">
        <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
          Gestión empresarial
        </span>
        <b className="text-sm text-slate-900">Gestión de mantenimiento</b>
      </div>

      <div className="relative hidden md:block flex-1 max-w-md mx-auto">
        <label className="flex items-center gap-2 h-10 rounded-lg border border-slate-200 bg-slate-50 px-3 focus-within:border-[#84cc16] focus-within:bg-white">
          <span className="sr-only">Buscar unidad</span>
          <Search size={16} className="text-slate-400 shrink-0" />
          <input
            ref={entrada}
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            onFocus={() => setEnfocado(true)}
            onBlur={() => setTimeout(() => setEnfocado(false), 150)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && consulta) ir(consulta);
              if (e.key === "Escape") entrada.current?.blur();
            }}
            placeholder="Buscar unidad, OT, checklist..."
            className="flex-1 min-w-0 bg-transparent text-sm text-slate-800 outline-none placeholder:text-slate-400"
          />
          <kbd className="hidden lg:block text-[10px] font-semibold text-slate-400 border border-slate-200 rounded px-1.5 py-0.5">
            Ctrl K
          </kbd>
        </label>
        {enfocado && consulta.length >= 2 && (
          <ul
            role="listbox"
            aria-label="Unidades encontradas"
            className="absolute left-0 right-0 top-12 bg-white border border-slate-200 rounded-xl shadow-lg overflow-hidden"
          >
            {sugerencias.length === 0 ? (
              <li className="px-4 py-3 text-sm text-slate-500">
                {equipos === null ? "Buscando…" : "Ninguna unidad coincide"}
              </li>
            ) : (
              sugerencias.map((e) => (
                <li key={e.id} role="option" aria-selected={false}>
                  <button
                    onMouseDown={(ev) => ev.preventDefault()}
                    onClick={() => ir(e.placa_codigo)}
                    className="w-full text-left px-4 py-2.5 hover:bg-slate-50 flex items-center gap-3"
                  >
                    <span className="w-8 h-8 rounded-lg bg-slate-100 text-[#4d7c0f] grid place-items-center text-[11px] font-bold">
                      {e.placa_codigo.slice(0, 3).toUpperCase()}
                    </span>
                    <span>
                      <b className="block text-sm text-slate-900">{e.placa_codigo}</b>
                      <small className="text-slate-500">
                        {[e.tipo, e.marca, e.modelo].filter(Boolean).join(" · ")}
                      </small>
                    </span>
                  </button>
                </li>
              ))
            )}
          </ul>
        )}
      </div>

      <div className="ml-auto md:ml-0 flex items-center gap-3">
        <div className="relative">
          <button
            onClick={() => setAlertasAbiertas((a) => !a)}
            aria-label="Alertas"
            aria-expanded={alertasAbiertas}
            className="p-2 rounded-md text-slate-500 hover:text-slate-900 hover:bg-slate-100"
          >
            <Bell size={18} />
          </button>
          {alertasAbiertas && (
            <div
              role="status"
              className="absolute right-0 top-11 w-64 bg-white border border-slate-200 rounded-xl shadow-lg p-4 text-sm text-slate-600"
            >
              <b className="block text-slate-900">Sin alertas por ahora</b>
              Aquí aparecerán los avisos de órdenes, checklists y preventivos.
            </div>
          )}
        </div>
        <div className="flex items-center gap-2" title={usuario?.nombre}>
          <span className="w-8 h-8 rounded-full bg-[#BADC1E]/30 text-[#3f6212] grid place-items-center text-xs font-bold">
            {inicialesDe(usuario?.nombre)}
          </span>
          <span className="hidden md:block leading-tight">
            <b className="block text-sm font-medium text-slate-800">{usuario?.nombre}</b>
            <small className="text-[11px] text-slate-500">{etiquetaDelPerfil(usuario?.rol)}</small>
          </span>
        </div>
        <button
          onClick={() => logout()}
          title="Cerrar sesión"
          aria-label="Cerrar sesión"
          className="p-2 rounded-md text-slate-500 hover:text-slate-900 hover:bg-slate-100"
        >
          <LogOut size={18} />
        </button>
      </div>
    </header>
  );
}
