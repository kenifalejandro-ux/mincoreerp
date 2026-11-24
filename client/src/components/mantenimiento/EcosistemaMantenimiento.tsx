// client/src/components/mantenimiento/EcosistemaMantenimiento.tsx
//
// El ecosistema «Gestión de mantenimiento»: un espacio aparte dentro del ERP, con su propia cabecera y su
// propio menú, igual que «Gestión de proveedores». Va FUERA del Layout del ERP (ver App.tsx): fondo claro y
// paneles blancos; el menú lateral conserva el diseño del ERP (fondo #192526, borde lima, ítems a todo el
// ancho con hover lima).
//
// Es un módulo propio y autónomo: con solo `mantenimiento` la empresa ve sus equipos. Las demás secciones
// (checklists, órdenes de trabajo, preventivo, indicadores…) se suman cuando existan; aquí no se dibujan
// entradas «Pronto» para ellas.
import { LayoutGrid, LogOut, Menu, Sparkles, Wrench, X, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import CentroDeMantenimiento from "./CentroDeMantenimiento";
import EquiposMantenimiento from "./EquiposMantenimiento";
import {
  esRutaDeMantenimiento,
  leerRuta,
  rutaDe,
  tituloDeRuta,
  type EstadoDeRuta,
  type SeccionDeRuta,
} from "./rutaMantenimiento";
import { useAuth } from "../../context/AuthContext";
import { useBarraLima } from "../comunes/useBarraLima";

interface ItemDeMenu {
  id: SeccionDeRuta;
  label: string;
  Icono: LucideIcon;
}

const GRUPOS: { etiqueta: string; items: ItemDeMenu[] }[] = [
  {
    etiqueta: "Operación",
    items: [
      { id: "centro", label: "Centro de control", Icono: LayoutGrid },
      { id: "equipos", label: "Equipos", Icono: Wrench },
    ],
  },
];
const TODOS = GRUPOS.flatMap((g) => g.items);

export default function EcosistemaMantenimiento({ onSalir }: { onSalir?: () => void }) {
  const { usuario, logout } = useAuth();
  useBarraLima();
  // La dirección manda al abrir: `/mantenimiento/equipos` abre Equipos.
  const [rutaInicial] = useState(() => leerRuta(window.location.pathname));
  const [seccion, setSeccion] = useState<SeccionDeRuta>(rutaInicial?.seccion ?? "centro");
  const [menuAbierto, setMenuAbierto] = useState(false);

  /** Refleja la pantalla en la dirección y el título del navegador. Con `reemplazar` no suma un paso al
   *  historial. */
  const publicar = useCallback((estado: EstadoDeRuta, reemplazar = false) => {
    const ruta = rutaDe(estado);
    if (window.location.pathname !== ruta) {
      if (reemplazar) window.history.replaceState(null, "", ruta);
      else window.history.pushState(null, "", ruta);
    }
    document.title = tituloDeRuta(estado);
  }, []);

  // Al abrir, la dirección queda bien escrita y al salir se devuelve el título del ERP.
  useEffect(() => {
    const tituloDelErp = document.title;
    publicar(
      { seccion: rutaInicial?.seccion ?? "centro" },
      esRutaDeMantenimiento(window.location.pathname)
    );
    return () => {
      document.title = tituloDelErp;
    };
    // Solo al montar: de ahí en adelante lo mueven las acciones y el botón «atrás».
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // «Atrás» y «adelante» dentro del ecosistema. Si la dirección ya no es del ecosistema, lo atiende App.
  useEffect(() => {
    const alVolver = () => {
      const estado = leerRuta(window.location.pathname);
      if (!estado) return;
      setSeccion(estado.seccion);
      setMenuAbierto(false);
      document.title = tituloDeRuta(estado);
    };
    window.addEventListener("popstate", alVolver);
    return () => window.removeEventListener("popstate", alVolver);
  }, []);

  const irA = (id: string) => {
    const destino = TODOS.find((i) => i.id === id)?.id ?? "centro";
    setSeccion(destino);
    setMenuAbierto(false);
    publicar({ seccion: destino });
  };

  return (
    <div className="min-h-screen bg-[#f4f6f9] text-slate-700 font-sans">
      <header className="fixed inset-x-0 top-0 z-40 h-16 bg-white border-b border-slate-200 flex items-center gap-3 px-4 sm:px-6">
        <button
          onClick={() => setMenuAbierto(true)}
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
        <div className="ml-auto flex items-center gap-3">
          <div className="flex items-center gap-2" title={usuario?.nombre}>
            <span className="w-8 h-8 rounded-full bg-[#BADC1E]/30 text-[#3f6212] grid place-items-center text-xs font-bold">
              {(usuario?.nombre ?? "?").slice(0, 2).toUpperCase()}
            </span>
            <span className="hidden md:block text-sm font-medium text-slate-800">
              {usuario?.nombre}
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

      {menuAbierto && (
        <button
          aria-label="Cerrar el menú"
          onClick={() => setMenuAbierto(false)}
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
        />
      )}

      <aside
        aria-label="Menú de Gestión de mantenimiento"
        className={`fixed top-16 bottom-0 left-0 z-50 w-64 overflow-y-auto bg-[#192526] border-l-[3px] border-[#BADC1E] flex flex-col transition-transform duration-300 lg:translate-x-0 ${
          menuAbierto ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="p-4 border-b border-white/10">
          <div className="flex items-center justify-between">
            {onSalir ? (
              <button
                onClick={onSalir}
                className="flex items-center gap-2 text-xs text-slate-400 hover:text-[#BADC1E]"
              >
                <span aria-hidden>←</span> Volver al ERP
              </button>
            ) : (
              <span />
            )}
            <button
              onClick={() => setMenuAbierto(false)}
              aria-label="Cerrar el menú"
              className="lg:hidden text-slate-400 hover:text-white"
            >
              <X size={18} />
            </button>
          </div>
          <div className="flex items-center gap-3 mt-4 rounded-xl bg-black/25 border border-white/10 p-3">
            <span className="w-9 h-9 rounded-lg bg-[#BADC1E]/15 text-[#BADC1E] grid place-items-center">
              <Wrench size={18} />
            </span>
            <div>
              <small className="block text-[9px] font-bold tracking-[0.14em] text-slate-400">
                ECOSISTEMA
              </small>
              <b className="text-sm text-slate-50">Gestión de mantenimiento</b>
            </div>
          </div>
        </div>

        <nav className="flex-1 py-3 flex flex-col gap-0.5">
          {GRUPOS.map((g) => (
            <div key={g.etiqueta} className="mb-2">
              <p className="px-6 pt-3 pb-1.5 text-[9px] font-bold uppercase tracking-[0.12em] text-slate-500">
                {g.etiqueta}
              </p>
              {g.items.map(({ id, label, Icono }) => {
                const activo = seccion === id;
                return (
                  <button
                    key={id}
                    onClick={() => irA(id)}
                    aria-current={activo ? "page" : undefined}
                    className={`group w-full text-left px-6 py-3 flex items-center gap-3 text-sm transition-all ${
                      activo
                        ? "bg-[#BADC1E] text-[#0A1014] font-semibold"
                        : "text-slate-400 hover:bg-[#BADC1E] hover:text-[#0A1014] font-medium"
                    }`}
                  >
                    <Icono
                      size={18}
                      strokeWidth={2}
                      className={`shrink-0 ${activo ? "text-[#0A1014]" : "text-slate-500 group-hover:text-[#0A1014]"}`}
                    />
                    <span className="tracking-tight flex-1">{label}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
        <p className="px-6 py-4 text-[11px] text-slate-500 border-t border-white/10 flex items-center gap-2">
          <Sparkles size={14} /> Cada empresa usa solo lo que contrató.
        </p>
      </aside>

      <main className="pt-16 lg:pl-64">
        <div className="p-4 sm:p-6 lg:p-8 max-w-[1500px]">
          {seccion === "centro" && <CentroDeMantenimiento onIr={irA} />}
          {seccion === "equipos" && <EquiposMantenimiento />}
        </div>
      </main>
    </div>
  );
}
