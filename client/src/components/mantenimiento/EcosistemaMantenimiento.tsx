// client/src/components/mantenimiento/EcosistemaMantenimiento.tsx
//
// El ecosistema «Gestión de mantenimiento»: un espacio aparte dentro del ERP, con su propia cabecera y su
// propio menú, igual que «Gestión de proveedores». Va FUERA del Layout del ERP (ver App.tsx): fondo claro y
// paneles blancos; el menú lateral conserva el diseño del ERP (fondo #192526, borde lima, ítems a todo el
// ancho con hover lima).
//
// Es un módulo propio y autónomo: con solo `mantenimiento` la empresa ve sus equipos. El menú sigue la maqueta
// aprobada: lo que todavía no está construido sale en su sitio con «Pronto» (ver menuMantenimiento.ts), y las
// entradas de otros módulos solo se dibujan si la persona los tiene.
import {
  ClipboardCheck,
  Clock,
  FolderClock,
  LayoutGrid,
  Package,
  Settings,
  ShieldCheck,
  Sparkles,
  Tractor,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import BarraSuperiorMantenimiento from "./BarraSuperiorMantenimiento";
import CentroDeMantenimiento from "./CentroDeMantenimiento";
import EquiposMantenimiento from "./EquiposMantenimiento";
import { resumenMantenimiento, type ResumenMantenimiento } from "./mantenimientoApi";
import {
  esSeccion,
  gruposDelMenu,
  insigniaDe,
  modulosIntegrados,
  type IconoDeMenu,
} from "./menuMantenimiento";
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

const ICONOS: Record<IconoDeMenu, LucideIcon> = {
  centro: LayoutGrid,
  equipos: Tractor,
  checklists: ClipboardCheck,
  ordenes: Wrench,
  preventivo: Clock,
  indicadores: Sparkles,
  historial: FolderClock,
  almacen: Package,
  iperc: ShieldCheck,
};

export default function EcosistemaMantenimiento({ onSalir }: { onSalir?: () => void }) {
  const { usuario } = useAuth();
  useBarraLima();
  // La dirección manda al abrir: `/mantenimiento/equipos` abre Equipos.
  const [rutaInicial] = useState(() => leerRuta(window.location.pathname));
  const [seccion, setSeccion] = useState<SeccionDeRuta>(rutaInicial?.seccion ?? "centro");
  const [menuAbierto, setMenuAbierto] = useState(false);
  // El resumen vive aquí porque lo usan el menú (la insignia de Equipos) y el Centro.
  const [resumen, setResumen] = useState<ResumenMantenimiento | null>(null);
  const [errorDelResumen, setErrorDelResumen] = useState<string | null>(null);
  // Lo que se escribió en el buscador de la barra: lleva a Equipos con el texto ya puesto.
  const [busqueda, setBusqueda] = useState<{ texto: string; veces: number }>({
    texto: "",
    veces: 0,
  });

  const cargarResumen = useCallback(() => {
    setErrorDelResumen(null);
    return resumenMantenimiento()
      .then(setResumen)
      .catch((e: unknown) => setErrorDelResumen(e instanceof Error ? e.message : "Error"));
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargarResumen();
  }, [cargarResumen]);

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
    const destino: SeccionDeRuta = esSeccion(id) ? id : "centro";
    setSeccion(destino);
    setMenuAbierto(false);
    publicar({ seccion: destino });
  };

  const buscar = (texto: string) => {
    setBusqueda((b) => ({ texto, veces: b.veces + 1 }));
    irA("equipos");
  };

  const grupos = gruposDelMenu(usuario);
  const integrados = modulosIntegrados(usuario);

  return (
    <div className="min-h-screen bg-[#f4f6f9] text-slate-700 font-sans">
      <BarraSuperiorMantenimiento onAbrirMenu={() => setMenuAbierto(true)} onBuscar={buscar} />

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
              <Settings size={18} />
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
          {grupos.map((g) => (
            <div key={g.etiqueta} className="mb-2">
              <p className="px-6 pt-3 pb-1.5 text-[9px] font-bold uppercase tracking-[0.12em] text-slate-500">
                {g.etiqueta}
              </p>
              {g.entradas.map((e) => {
                const Icono = ICONOS[e.icono];
                const activo = !e.pronto && seccion === e.id;
                const insignia = insigniaDe(e.id, resumen?.por_importar ?? 0);
                return (
                  <button
                    key={e.id}
                    onClick={() => !e.pronto && irA(e.id)}
                    disabled={e.pronto}
                    aria-current={activo ? "page" : undefined}
                    className={`group w-full text-left px-6 py-3 flex items-center gap-3 text-sm transition-all ${
                      activo
                        ? "bg-[#BADC1E] text-[#0A1014] font-semibold"
                        : e.pronto
                          ? "text-slate-500 cursor-default font-medium"
                          : "text-slate-400 hover:bg-[#BADC1E] hover:text-[#0A1014] font-medium"
                    }`}
                  >
                    <Icono
                      size={18}
                      strokeWidth={2}
                      className={`shrink-0 ${
                        activo
                          ? "text-[#0A1014]"
                          : e.pronto
                            ? "text-slate-600"
                            : "text-slate-500 group-hover:text-[#0A1014]"
                      }`}
                    />
                    <span className="tracking-tight flex-1">{e.label}</span>
                    {e.pronto && (
                      <span className="px-2 py-0.5 rounded-full bg-white/10 text-[10px] font-bold text-slate-300">
                        Pronto
                      </span>
                    )}
                    {insignia !== null && (
                      <span
                        aria-label={`${insignia} por completar`}
                        className="min-w-5 h-5 px-1.5 rounded-full bg-[#BADC1E] text-[#0A1014] text-[11px] font-bold grid place-items-center"
                      >
                        {insignia}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="border-t border-white/10 py-3">
          <button
            disabled
            className="w-full text-left px-6 py-3 flex items-center gap-3 text-sm text-slate-500 font-medium cursor-default"
          >
            <Settings size={18} className="text-slate-600 shrink-0" />
            <span className="tracking-tight flex-1">Configuración</span>
            <span className="px-2 py-0.5 rounded-full bg-white/10 text-[10px] font-bold text-slate-300">
              Pronto
            </span>
          </button>
          {integrados > 0 && (
            <div className="mx-4 mt-2 flex items-center gap-3 rounded-xl bg-black/25 border border-white/10 p-3">
              <span className="text-[#BADC1E]">
                <Sparkles size={17} />
              </span>
              <div>
                <b className="block text-xs text-slate-100">Integración activa</b>
                <small className="text-[11px] text-slate-400">
                  {integrados === 1 ? "1 módulo conectado" : `${integrados} módulos conectados`}
                </small>
              </div>
            </div>
          )}
        </div>
      </aside>

      <main className="pt-16 lg:pl-64">
        <div className="p-4 sm:p-6 lg:p-8 max-w-[1500px]">
          {seccion === "centro" && (
            <CentroDeMantenimiento resumen={resumen} error={errorDelResumen} onIr={irA} />
          )}
          {seccion === "equipos" && (
            <EquiposMantenimiento
              key={busqueda.veces}
              busquedaInicial={busqueda.texto}
              porImportar={resumen?.por_importar ?? 0}
              onCambio={cargarResumen}
            />
          )}
        </div>
      </main>
    </div>
  );
}
