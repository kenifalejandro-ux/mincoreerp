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
import { useCallback, useEffect, useRef, useState } from "react";

import BarraSuperiorMantenimiento from "./BarraSuperiorMantenimiento";
import type { DestinoDelCentro } from "./centroDeMantenimiento";
import CentroDeMantenimiento from "./CentroDeMantenimiento";
import type { FiltrosDeRegistros } from "./checklistsMantenimiento";
import ChecklistsMantenimiento from "./ChecklistsMantenimiento";
import ConfiguracionMantenimiento from "./ConfiguracionMantenimiento";
import EquiposMantenimiento from "./EquiposMantenimiento";
import { resumenMantenimiento, type ResumenMantenimiento } from "./mantenimientoApi";
import {
  esSeccion,
  gruposDelMenu,
  insigniaDe,
  modulosIntegrados,
  type IconoDeMenu,
} from "./menuMantenimiento";
import type { FiltrosDeOrdenes } from "./ordenesMantenimiento";
import OrdenesMantenimiento from "./OrdenesMantenimiento";
import { marcarPreventivoVisto, preventivoEsNuevo } from "./planesPreventivo";
import PreventivoMantenimiento from "./PreventivoMantenimiento";
import {
  esRutaDeMantenimiento,
  leerRuta,
  rutaDe,
  tituloDeRuta,
  type EstadoDeRuta,
  type SeccionDeRuta,
} from "./rutaMantenimiento";
import { useAuth } from "../../context/AuthContext";
import { tieneModulo } from "../../modules/tieneModulo";
import { useBarraLima } from "../comunes/useBarraLima";
import { marcarNovedadVista, novedadVigente } from "../controlTv/novedad";

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

/** La etiqueta «Nuevo» de Configuración (24 horas desde el primer clic, ver controlTv/novedad.ts). */
const NOVEDAD_CONFIGURACION = "mantenimiento-configuracion-2026-11";
const configuracionEsNueva = () => novedadVigente(Date.now(), undefined, NOVEDAD_CONFIGURACION);
const marcarConfiguracionVista = () =>
  marcarNovedadVista(Date.now(), undefined, NOVEDAD_CONFIGURACION);

/** La etiqueta «Nuevo» del Centro de control, 24 horas desde el primer clic en el menú o dentro de él. */
const NOVEDAD_CENTRO = "mantenimiento-centro-2026-11";
const centroEsNuevo = () => novedadVigente(Date.now(), undefined, NOVEDAD_CENTRO);
const marcarCentroVisto = () => marcarNovedadVista(Date.now(), undefined, NOVEDAD_CENTRO);

/** La etiqueta «Nuevo» de Checklists, 24 horas desde el primer clic. */
const NOVEDAD_CHECKLISTS = "mantenimiento-checklists-2026-11";
const checklistsEsNuevo = () => novedadVigente(Date.now(), undefined, NOVEDAD_CHECKLISTS);
const marcarChecklistsVisto = () => marcarNovedadVista(Date.now(), undefined, NOVEDAD_CHECKLISTS);

/** La etiqueta «Nuevo» de Órdenes de trabajo, 24 horas desde el primer clic. */
const NOVEDAD_ORDENES = "mantenimiento-ordenes-2026-11";
const ordenesEsNuevo = () => novedadVigente(Date.now(), undefined, NOVEDAD_ORDENES);
const marcarOrdenesVisto = () => marcarNovedadVista(Date.now(), undefined, NOVEDAD_ORDENES);

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
  // Con qué abre Equipos: el texto del buscador de la barra o el área que se tocó en el Centro.
  const [entrada, setEntrada] = useState<{ texto: string; area?: string; veces: number }>({
    texto: "",
    veces: 0,
  });

  // Con qué filtros abre Checklists cuando se llega desde un aviso del Centro.
  const [deRegistros, setDeRegistros] = useState<{
    filtros?: Partial<FiltrosDeRegistros>;
    veces: number;
  }>({ veces: 0 });
  // Con qué abre Órdenes: filtros desde el Centro o la orden que se tocó en un checklist.
  const [deOrdenes, setDeOrdenes] = useState<{
    filtros?: Partial<FiltrosDeOrdenes>;
    orden?: number;
    veces: number;
  }>({ veces: 0 });
  // Escribir la dirección de un módulo que no se tiene no abre su pantalla: se ve el Centro.
  const sinModulo =
    (seccion === "checklists" && !tieneModulo(usuario, "checklists")) ||
    (seccion === "ordenes" && !tieneModulo(usuario, "ordenes_trabajo"));
  const visible: SeccionDeRuta = sinModulo ? "centro" : seccion;

  // Solo vale la última lectura pedida: una respuesta lenta de antes no pisa a la nueva.
  const ultimaLectura = useRef(0);
  const cargarResumen = useCallback(() => {
    const esta = ++ultimaLectura.current;
    setErrorDelResumen(null);
    return resumenMantenimiento()
      .then((r) => {
        if (esta === ultimaLectura.current) setResumen(r);
      })
      .catch((e: unknown) => {
        if (esta !== ultimaLectura.current) return;
        setErrorDelResumen(e instanceof Error ? e.message : "Error");
      });
  }, []);

  // Se lee al abrir y cada vez que se cambia de sección: el Centro y la insignia no se quedan con lo de antes
  // (por ejemplo, equipos que registró otra persona mientras el ecosistema estaba abierto).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargarResumen();
  }, [cargarResumen, seccion]);

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

  const mostrar = (destino: SeccionDeRuta) => {
    setSeccion(destino);
    setMenuAbierto(false);
    publicar({ seccion: destino });
  };

  /** Ir por el menú: Equipos abre sin el área que se haya tocado antes. */
  const irA = (id: string) => {
    setEntrada((e) => ({ ...e, area: undefined }));
    setDeRegistros((d) => ({ veces: d.veces }));
    setDeOrdenes((d) => ({ veces: d.veces }));
    mostrar(esSeccion(id) ? id : "centro");
  };

  const abrirEquipos = (filtro: { texto?: string; area?: string }) => {
    setEntrada((e) => ({ texto: filtro.texto ?? "", area: filtro.area, veces: e.veces + 1 }));
    mostrar("equipos");
  };

  const abrirOrdenes = (con: { filtros?: Partial<FiltrosDeOrdenes>; orden?: number }) => {
    setDeOrdenes((d) => ({ ...con, veces: d.veces + 1 }));
    mostrar("ordenes");
  };

  /** Un botón del Centro: abre una sección de aquí. */
  const irDesdeElCentro = (destino: DestinoDelCentro) => {
    marcarCentroVisto();
    if (destino.seccion === "ordenes") {
      abrirOrdenes({ filtros: destino.filtros });
    } else if (destino.seccion === "checklists") {
      setDeRegistros((d) => ({ filtros: destino.filtros, veces: d.veces + 1 }));
      mostrar("checklists");
    } else irA(destino.seccion);
  };

  const grupos = gruposDelMenu(usuario);
  const integrados = modulosIntegrados(usuario);

  return (
    <div className="min-h-screen bg-[#f4f6f9] text-slate-700 font-sans">
      <BarraSuperiorMantenimiento
        onAbrirMenu={() => setMenuAbierto(true)}
        onBuscar={(texto) => abrirEquipos({ texto })}
      />

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
                const activo = !e.pronto && visible === e.id;
                const insignia = insigniaDe(e.id, resumen?.por_importar ?? 0);
                return (
                  <button
                    key={e.id}
                    onClick={() => {
                      if (e.pronto) return;
                      if (e.id === "centro") marcarCentroVisto();
                      if (e.id === "checklists") marcarChecklistsVisto();
                      if (e.id === "ordenes") marcarOrdenesVisto();
                      if (e.id === "preventivo") marcarPreventivoVisto();
                      irA(e.id);
                    }}
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
                    {((e.id === "centro" && centroEsNuevo()) ||
                      (e.id === "checklists" && checklistsEsNuevo()) ||
                      (e.id === "ordenes" && ordenesEsNuevo()) ||
                      (e.id === "preventivo" && preventivoEsNuevo())) && (
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] font-extrabold ${
                          activo ? "bg-[#0A1014] text-[#BADC1E]" : "bg-[#BADC1E] text-[#0A1014]"
                        }`}
                      >
                        Nuevo
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
            onClick={() => {
              marcarConfiguracionVista();
              irA("configuracion");
            }}
            aria-current={seccion === "configuracion" ? "page" : undefined}
            className={`group w-full text-left px-6 py-3 flex items-center gap-3 text-sm transition-all ${
              seccion === "configuracion"
                ? "bg-[#BADC1E] text-[#0A1014] font-semibold"
                : "text-slate-400 hover:bg-[#BADC1E] hover:text-[#0A1014] font-medium"
            }`}
          >
            <Settings
              size={18}
              className={`shrink-0 ${
                seccion === "configuracion"
                  ? "text-[#0A1014]"
                  : "text-slate-500 group-hover:text-[#0A1014]"
              }`}
            />
            <span className="tracking-tight flex-1">Configuración</span>
            {configuracionEsNueva() && (
              <span className="px-2 py-0.5 rounded-full bg-[#BADC1E] text-[#0A1014] text-[10px] font-extrabold border border-[#0A1014]/20">
                Nuevo
              </span>
            )}
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
          {visible === "centro" && (
            <CentroDeMantenimiento
              resumen={resumen}
              error={errorDelResumen}
              onIr={irDesdeElCentro}
              onAbrirArea={(area) => {
                marcarCentroVisto();
                abrirEquipos({ area });
              }}
            />
          )}
          {visible === "configuracion" && <ConfiguracionMantenimiento />}
          {visible === "checklists" && (
            <ChecklistsMantenimiento
              key={deRegistros.veces}
              filtrosIniciales={deRegistros.filtros}
              resumen={resumen}
              onCambio={cargarResumen}
              onVerOrden={(orden) => abrirOrdenes({ orden })}
            />
          )}
          {visible === "ordenes" && (
            <OrdenesMantenimiento
              key={deOrdenes.veces}
              filtrosIniciales={deOrdenes.filtros}
              ordenInicial={deOrdenes.orden}
              exigeConformidad={!!resumen?.ordenes?.por_conformar}
              onCambio={cargarResumen}
            />
          )}
          {visible === "preventivo" && <PreventivoMantenimiento />}
          {visible === "equipos" && (
            <EquiposMantenimiento
              key={entrada.veces}
              busquedaInicial={entrada.texto}
              areaInicial={entrada.area}
              porImportar={resumen?.por_importar ?? 0}
              onCambio={cargarResumen}
            />
          )}
        </div>
      </main>
    </div>
  );
}
