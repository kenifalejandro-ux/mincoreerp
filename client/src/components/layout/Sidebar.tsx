import {
  ChevronDown,
  ChevronsLeft,
  Cylinder,
  Droplets,
  Fuel,
  History,
  Inbox,
  Navigation,
  Route,
  Receipt,
  ScrollText,
  SearchCheck,
  ShieldCheck,
  Tag,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { Fragment, useState } from "react";

import { useAuth } from "../../context/AuthContext";
import { MODULOS_CLIENTE } from "../../modules/registry";
import { puedeVerBandeja } from "../bandeja/bandejaAcceso";
import { useContadorBandeja } from "../bandeja/useContadorBandeja";
import { puedeCompraEnRuta } from "../combustible/compraEnRutaAcceso";
import { puedeVerPrecios } from "../combustible/preciosAcceso";

// Submenú de Combustible. Los íconos son de trazo (lucide), los mismos que
// usan las acciones de la tabla de tanques.
const SUBMENU_COMBUSTIBLE: { tab: string; label: string; Icono: LucideIcon }[] = [
  { tab: "combustible:mi_viaje", label: "Mi viaje", Icono: Navigation },
  { tab: "combustible:compra_ruta", label: "Compra en ruta", Icono: Receipt },
  { tab: "combustible", label: "Tanques", Icono: Fuel },
  { tab: "combustible:tanquetas", label: "Tanquetas", Icono: Cylinder },
  { tab: "combustible:viajes", label: "Viajes", Icono: Route },
  { tab: "combustible:historico", label: "Histórico", Icono: History },
  { tab: "combustible:urea", label: "Urea", Icono: Droplets },
  { tab: "combustible:precios", label: "Precios", Icono: Tag },
  { tab: "combustible:proveedores", label: "Proveedores", Icono: Wrench },
  { tab: "combustible:auditoria", label: "Auditoría", Icono: SearchCheck },
  { tab: "combustible:bitacora", label: "Bitácora", Icono: ScrollText },
];

interface SidebarProps {
  activeTab: string;
  setActiveTab: (tab: any) => void;
  abierto: boolean;
  onToggle: () => void;
}

export default function Sidebar({ activeTab, setActiveTab, abierto, onToggle }: SidebarProps) {
  const { usuario } = useAuth();

  const tabs = MODULOS_CLIENTE.filter((modulo) => usuario?.modulosPermitidos.includes(modulo.id));
  const submenusVisibles = SUBMENU_COMBUSTIBLE.filter(({ tab }) => {
    // No tiene pestaña propia en la matriz de permisos: junta dos que sí (ver
    // compraEnRutaAcceso.ts).
    if (tab === "combustible:compra_ruta") return puedeCompraEnRuta(usuario);
    // Precios une combustible y urea: se decide con los dos permisos (no hay
    // un permiso "combustible:precios"), igual que la pantalla.
    if (tab === "combustible:precios") return puedeVerPrecios(usuario);
    const pestana = tab === "combustible" ? "tanques" : tab.split(":")[1];
    const override = usuario?.permisosPestanas?.[`combustible:${pestana}`];
    if (override !== undefined) return override;
    if (tab === "combustible:mi_viaje") return usuario?.rol === "conductor_ruta";
    // Era un botón de Tanques: se respeta su permiso anterior si existe.
    if (tab === "combustible:proveedores") {
      const antiguo = usuario?.permisosPestanas?.["combustible:tanques:proveedores"];
      return antiguo ?? (usuario?.rol === "admin" || usuario?.rol === "operador");
    }
    // 0119: el conductor también ve Urea, solo para registrar la compra en
    // ruta (el panel le muestra únicamente ese botón).
    if (usuario?.rol === "conductor_ruta")
      return tab === "combustible" || tab === "combustible:urea" || tab === "combustible:mi_viaje";
    // Tanquetas: es donde recibe la tanqueta de vuelta (0143).
    if (usuario?.rol === "grifero") return tab === "combustible" || tab === "combustible:tanquetas";
    if (usuario?.rol === "encargado_urea") return tab === "combustible:urea";
    // Operador y Lectura parten con acceso amplio a Combustible (matriz
    // robusta de perfiles): sin override, ven todos los submenús.
    return true;
  });
  // La Bandeja junta las alertas de todos los módulos: es un ítem propio y no
  // un submenú de Combustible. Quién la ve: bandejaAcceso.ts.
  const verBandeja = puedeVerBandeja(usuario);
  const contador = useContadorBandeja(verBandeja);
  const hayDashboard = tabs.some((m) => m.id === "dashboard");
  const botonBandeja = verBandeja ? (
    <button
      key="bandeja"
      onClick={() => setActiveTab("bandeja")}
      className={`w-full text-left px-6 py-3 flex items-center gap-3 text-sm transition-all relative ${
        activeTab === "bandeja"
          ? "bg-[#BADC1E] text-[#0A1014] font-semibold"
          : "text-slate-500 hover:bg-[#BADC1E] hover:text-[#0A1014] font-medium"
      }`}
    >
      {activeTab === "bandeja" && (
        <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-[#BADC1E]" />
      )}
      <span className={activeTab === "bandeja" ? "text-[#0A1014]" : "text-slate-400"}>
        <Inbox size={18} strokeWidth={2} />
      </span>
      <span className="tracking-tight">Bandeja</span>
      {contador.pendientes > 0 && (
        <span
          className={`ml-auto min-w-[22px] h-5 px-1.5 rounded-full text-[11px] font-bold tabular-nums flex items-center justify-center ${
            contador.criticas > 0 ? "bg-red-600 text-white" : "bg-slate-600 text-white"
          }`}
          title={
            contador.criticas > 0
              ? `${contador.pendientes} sin resolver, ${contador.criticas} crítica(s)`
              : `${contador.pendientes} sin resolver`
          }
          aria-label={
            contador.criticas > 0
              ? `${contador.pendientes} alertas sin resolver, ${contador.criticas} críticas`
              : `${contador.pendientes} alertas sin resolver`
          }
        >
          {contador.pendientes > 99 ? "99+" : contador.pendientes}
        </span>
      )}
    </button>
  ) : null;

  const puedeVerFacturacion = (() => {
    if (usuario?.rol === "admin") return true;
    const override = usuario?.permisosPestanas?.["facturacion:principal"];
    if (override !== undefined) return override;
    // Exclusiva de Admin por defecto (confirmado por Kenif, 2026-10-01); el
    // admin del tenant puede habilitarla por usuario desde Configuración.
    return false;
  })();

  // El submenú de Combustible se abre/cierra con la flechita, no con el
  // click de navegar -- antes se abría solo porque isActive lo forzaba, y
  // Kenif pidió separarlos: click en "Combustible" navega, click en la
  // flecha despliega/pliega, cada uno su gesto.
  const [combustibleDesplegado, setCombustibleDesplegado] = useState(false);

  return (
    <aside
      data-menu-lateral
      className={`absolute inset-y-0 left-0 z-40 w-64 max-w-[85vw] shrink-0 overflow-y-auto pb-6 bg-[#192526] border-l-3 border-[#BADC1E] flex flex-col shadow-[4px_0_24px_rgba(0,0,0,0.02)] transition-transform duration-300 ease-out lg:static lg:transition-[width] ${
        abierto
          ? "translate-x-0 lg:w-64"
          : "-translate-x-full lg:translate-x-0 lg:w-0 lg:overflow-hidden lg:border-l-0"
      }`}
    >
      <div className="p-4 border-b border-slate-100 flex items-center justify-between gap-2">
        <span className="text-xs font-bold text-slate-400 uppercase tracking-wider whitespace-nowrap">
          Módulos Operativos
        </span>
        <button
          onClick={onToggle}
          aria-label="Ocultar menú"
          title="Ocultar menú"
          className="p-1 rounded text-slate-400 hover:text-[#BADC1E] hover:bg-white/5 transition-colors shrink-0"
        >
          <ChevronsLeft size={18} />
        </button>
      </div>

      <nav className="flex-1 py-4 flex flex-col gap-1">
        {!hayDashboard && botonBandeja}
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
          // de sus sub-pestañas.
          const esCombustible = tab.id === "combustible";
          const isActive = esCombustible
            ? activeTab === "combustible" || activeTab.startsWith("combustible:")
            : activeTab === tab.id;
          return (
            <Fragment key={tab.id}>
              <div>
                <button
                  onClick={() => {
                    if (esCombustible) setCombustibleDesplegado(true);
                    setActiveTab(
                      esCombustible && usuario?.rol === "encargado_urea"
                        ? "combustible:urea"
                        : esCombustible
                          ? "combustible"
                          : tab.id
                    );
                  }}
                  className={`group w-full text-left px-6 py-3 flex items-center gap-3 text-sm transition-all relative ${
                    isActive
                      ? "bg-[#BADC1E] text-[#0A1014] hover:bg-[#BADC1E] font-semibold"
                      : "text-slate-500  hover:bg-[#BADC1E] font-medium"
                  }`}
                >
                  {isActive && (
                    <div className="absolute left-0 top-0 bottom-0 w-1.5 z-2 bg-[#BADC1E]" />
                  )}

                  <tab.icono
                    size={18}
                    strokeWidth={2}
                    className={`shrink-0 ${isActive ? "text-[#0A1014]" : "text-slate-400 group-hover:text-[#0A1014]"}`}
                  />
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
                      combustibleDesplegado
                        ? "grid-rows-[1fr] visible"
                        : "grid-rows-[0fr] invisible"
                    }`}
                  >
                    <div className="overflow-hidden">
                      <div className="flex flex-col">
                        {submenusVisibles.map(({ tab: destino, label, Icono }, i) => {
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
              {tab.id === "dashboard" && botonBandeja}
            </Fragment>
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
            className={`w-full text-left px-6 py-3 flex items-center gap-3 text-sm transition-all relative ${
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

        {puedeVerFacturacion && (
          <button
            onClick={() => setActiveTab("facturacion")}
            className={`w-full text-left px-6 py-3 flex items-center gap-3 text-sm transition-all relative ${
              activeTab === "facturacion"
                ? "bg-[#BADC1E] text-[#0A1014] font-semibold"
                : "text-slate-500 hover:bg-[#BADC1E] hover:text-[#0A1014] font-medium"
            }`}
          >
            {activeTab === "facturacion" && (
              <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-[#BADC1E]" />
            )}
            <span
              className={`${activeTab === "facturacion" ? "text-[#0A1014]" : "text-slate-400"}`}
            >
              <Receipt size={20} strokeWidth={2} />
            </span>
            <span className="tracking-tight">Facturación</span>
          </button>
        )}
      </nav>
    </aside>
  );
}
