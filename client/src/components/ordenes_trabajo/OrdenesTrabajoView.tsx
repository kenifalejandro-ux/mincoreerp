// client/src/components/ordenes_trabajo/OrdenesTrabajoView.tsx
import { ChevronLeft, ChevronRight, Trash2 } from "lucide-react";
import { useState, useEffect, useCallback } from "react";

import { EtiquetaNuevo } from "./CamposDeTrabajo";
import DetalleDeOrden from "./DetalleDeOrden";
import { textoDeDuracion } from "./horasYTareas";
import { marcarHorasYTareasVistas } from "./novedadHorasTareas";
import NuevaOrden from "./NuevaOrden";
import { useCatalogosDeOrden } from "./useCatalogosDeOrden";
import { useAuth } from "../../context/AuthContext";
import { tieneModulo, tieneUnidades } from "../../modules/tieneModulo";
import { suscribirseASincronizacion } from "../../offline/offlineSync";
import { apiFetch } from "../../services/apiClient";
import { opcionesDeUnidad } from "../comunes/opcionesDeUnidad";
import { SelectorBuscable } from "../comunes/SelectorBuscable";
import { usePuedeEscribir } from "../comunes/usePuedeEscribir";

type Estado = "abierta" | "en_progreso" | "completada" | "cancelada";

interface OrdenTrabajo {
  id: number;
  // La unidad es opcional (de Flota); si no hay, la orden se identifica por `activo_texto`.
  equipo_id: number | null;
  placa_codigo: string | null;
  activo_texto: string | null;
  titulo: string;
  descripcion: string | null;
  tipo: "correctivo" | "preventivo";
  prioridad: "baja" | "media" | "alta" | "urgente";
  estado: Estado;
  iperc_id: number | null;
  creado_por_nombre: string;
  asignado_a: string | null;
  asignado_a_nombre: string | null;
  fecha_programada: string | null;
  fecha_cierre: string | null;
  observaciones_cierre: string | null;
  /** 'checklist' = la generó sola una falla crítica. */
  origen?: "manual" | "checklist";
  checklist_id?: number | null;
  creado_en: string;
  unidad_no_opera?: boolean;
  duracion_minutos?: number | null;
  tareas_total?: number;
  tareas_hechas?: number;
}

const ESTADO_LABEL: Record<Estado, string> = {
  abierta: "Abierta",
  en_progreso: "En progreso",
  completada: "Completada",
  cancelada: "Cancelada",
};

const ESTADO_COLOR: Record<Estado, string> = {
  abierta: "bg-slate-100 text-slate-600",
  en_progreso: "bg-blue-100 text-blue-600",
  completada: "bg-emerald-100 text-emerald-600",
  cancelada: "bg-red-100 text-red-600",
};

export default function OrdenesTrabajoView() {
  const puedeEscribir = usePuedeEscribir("ordenes_trabajo");
  // Las unidades las mantiene OTRO módulo (Flota o Mantenimiento): sin ninguno no se piden ni se ofrecen unidades y la orden
  // se identifica por el texto «Activo o lugar» (ver `opcionales` en registry.ts).
  const conUnidades = tieneUnidades(useAuth().usuario);
  const conIperc = tieneModulo(useAuth().usuario, "iperc");
  const [ordenes, setOrdenes] = useState<OrdenTrabajo[]>([]);
  const catalogos = useCatalogosDeOrden({ conUnidades, conIperc });
  const { equipos, asignables: usuariosAsignables } = catalogos;
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [filtroEstado, setFiltroEstado] = useState("");
  const [filtroEquipo, setFiltroEquipo] = useState("");
  const [filtroAsignado, setFiltroAsignado] = useState("");

  const [modalAbierto, setModalAbierto] = useState(false);

  /** La orden con la ventana «Horas y tareas» abierta. */
  const [detalle, setDetalle] = useState<number | null>(null);

  const cargarOrdenes = useCallback(
    async (paginaAConsultar: number) => {
      const params = new URLSearchParams({ page: String(paginaAConsultar), pageSize: "50" });
      if (filtroEstado) params.set("estado", filtroEstado);
      if (conUnidades && filtroEquipo) params.set("equipo_id", filtroEquipo);
      if (filtroAsignado) params.set("asignado_a", filtroAsignado);
      try {
        const res = await apiFetch(`/api/erp/ordenes_trabajo?${params}`);
        const body = await res.json();
        setOrdenes(Array.isArray(body.data) ? body.data : []);
        setTotalPages(body.pagination?.totalPages ?? 1);
      } catch (err) {
        console.error("Error al obtener órdenes de trabajo:", err);
      } finally {
        setLoading(false);
      }
    },
    [filtroEstado, filtroEquipo, filtroAsignado, conUnidades]
  );

  useEffect(() => {
    // Patrón estándar de carga al montar/cambiar filtros o página.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    cargarOrdenes(page);
  }, [page, cargarOrdenes]);

  // Cuando la cola offline termina de drenar, las OT que se crearon sin
  // señal ya existen del lado del servidor -- recargar es lo que hace que
  // aparezcan en el listado sin que el operario tenga que refrescar a mano.
  useEffect(() => {
    return suscribirseASincronizacion(({ sincronizadas }) => {
      if (sincronizadas > 0) cargarOrdenes(page);
    });
  }, [page, cargarOrdenes]);

  const abrirModal = () => setModalAbierto(true);

  const handleCambiarEstado = async (id: number, estado: Estado) => {
    let observaciones_cierre: string | undefined;
    if (estado === "completada" || estado === "cancelada") {
      const respuesta = window.prompt(
        estado === "completada"
          ? "Observaciones de cierre (opcional):"
          : "Motivo de cancelación (opcional):"
      );
      if (respuesta === null) return; // el operario canceló el prompt
      observaciones_cierre = respuesta || undefined;
    }

    const res = await apiFetch(`/api/erp/ordenes_trabajo/${id}/estado`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estado, observaciones_cierre }),
    });
    if (res.ok) {
      cargarOrdenes(page);
    } else {
      const body = await res.json().catch(() => ({}));
      alert(body.message || "No se pudo cambiar el estado.");
    }
  };

  // Reasignar desde el select inline de la tabla -- el PUT reemplaza la
  // fila entera (mismo criterio que actualizarOrdenTrabajoSchema), así que
  // manda los valores ACTUALES de los campos no-estado junto con el nuevo
  // asignado_a. equipo_id no viaja: es inmutable, el PUT no lo acepta. activo_texto SÍ viaja:
  // una orden sin unidad no puede quedarse sin él (el servidor responde 400).
  const handleReasignar = async (ot: OrdenTrabajo, nuevoAsignadoA: string) => {
    const res = await apiFetch(`/api/erp/ordenes_trabajo/${ot.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        activo_texto: ot.activo_texto || undefined,
        titulo: ot.titulo,
        descripcion: ot.descripcion || undefined,
        tipo: ot.tipo,
        prioridad: ot.prioridad,
        iperc_id: ot.iperc_id || undefined,
        fecha_programada: ot.fecha_programada || undefined,
        asignado_a: nuevoAsignadoA || undefined,
      }),
    });
    if (res.ok) {
      cargarOrdenes(page);
    } else {
      const body = await res.json().catch(() => ({}));
      alert(body.message || "No se pudo reasignar la orden de trabajo.");
    }
  };

  const handleEliminar = async (id: number) => {
    if (!window.confirm("¿Eliminar esta orden de trabajo?")) return;
    const res = await apiFetch(`/api/erp/ordenes_trabajo/${id}`, { method: "DELETE" });
    if (res.ok) {
      cargarOrdenes(page);
    } else {
      alert("No se pudo eliminar (solo admin).");
    }
  };

  if (loading) return <div className="p-20 text-center text-slate-500">Cargando...</div>;

  return (
    <div className="p-2 sm:p-4 lg:p-8 animate-in fade-in duration-500">
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 lg:gap-6 mb-6 lg:mb-10">
        <div>
          <h1 className="text-lg sm:text-xl lg:text-2xl font-bold text-slate-800 tracking-tight">
            Órdenes de Trabajo
          </h1>
          <p className="text-xs sm:text-sm text-slate-500">
            Mantenimiento correctivo y preventivo de equipos
          </p>
        </div>
        {puedeEscribir && (
          <button
            onClick={abrirModal}
            className="px-6 py-2.5 bg-slate-900 hover:bg-slate-800 text-white font-medium rounded-xl transition-all"
          >
            + Nueva Orden de Trabajo
          </button>
        )}
      </div>

      <div className="flex flex-col sm:flex-row gap-4 mb-8">
        <div className="space-y-1 flex-1">
          <label htmlFor="ot-filtro-estado" className="text-xs font-bold text-slate-500 uppercase">
            Filtrar por estado
          </label>
          <select
            id="ot-filtro-estado"
            className="w-full border border-slate-200 rounded-xl p-3 text-sm outline-none bg-white focus:ring-2 focus:ring-slate-900"
            value={filtroEstado}
            onChange={(e) => {
              setPage(1);
              setFiltroEstado(e.target.value);
            }}
          >
            <option value="">Todos</option>
            {(Object.keys(ESTADO_LABEL) as Estado[]).map((e) => (
              <option key={e} value={e}>
                {ESTADO_LABEL[e]}
              </option>
            ))}
          </select>
        </div>
        {conUnidades && (
          <div className="space-y-1 flex-1">
            <label
              htmlFor="ot-filtro-equipo"
              className="text-xs font-bold text-slate-500 uppercase"
            >
              Filtrar por equipo
            </label>
            <SelectorBuscable
              id="ot-filtro-equipo"
              opciones={opcionesDeUnidad(equipos, "Todos")}
              valor={filtroEquipo}
              onElegir={(v) => {
                setPage(1);
                setFiltroEquipo(v);
              }}
              placeholder="Todos"
              etiquetaBuscador="Buscar unidad del filtro"
            />
          </div>
        )}
        <div className="space-y-1 flex-1">
          <label
            htmlFor="ot-filtro-asignado"
            className="text-xs font-bold text-slate-500 uppercase"
          >
            Filtrar por asignado
          </label>
          <select
            id="ot-filtro-asignado"
            className="w-full border border-slate-200 rounded-xl p-3 text-sm outline-none bg-white focus:ring-2 focus:ring-slate-900"
            value={filtroAsignado}
            onChange={(e) => {
              setPage(1);
              setFiltroAsignado(e.target.value);
            }}
          >
            <option value="">Todos</option>
            {usuariosAsignables.map((u) => (
              <option key={u.id} value={u.id}>
                {u.nombre}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-3xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full min-w-max text-left border-collapse">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-3 sm:px-4 py-2.5 sm:py-3 text-[10px] sm:text-xs font-bold text-slate-400 uppercase tracking-widest">
                  equipo / activo
                </th>
                <th className="px-3 sm:px-4 py-2.5 sm:py-3 text-[10px] sm:text-xs font-bold text-slate-400 uppercase tracking-widest">
                  título
                </th>
                <th className="px-3 sm:px-4 py-2.5 sm:py-3 text-[10px] sm:text-xs font-bold text-slate-400 uppercase tracking-widest">
                  tipo
                </th>
                <th className="px-3 sm:px-4 py-2.5 sm:py-3 text-[10px] sm:text-xs font-bold text-slate-400 uppercase tracking-widest">
                  prioridad
                </th>
                <th className="px-3 sm:px-4 py-2.5 sm:py-3 text-[10px] sm:text-xs font-bold text-slate-400 uppercase tracking-widest">
                  estado
                </th>
                <th className="px-3 sm:px-4 py-2.5 sm:py-3 text-[10px] sm:text-xs font-bold text-slate-400 uppercase tracking-widest">
                  asignado a
                </th>
                <th className="px-3 sm:px-4 py-2.5 sm:py-3 text-[10px] sm:text-xs font-bold text-slate-400 uppercase tracking-widest text-right">
                  acciones
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {ordenes.map((ot) => (
                <tr key={ot.id} className="hover:bg-slate-50/50 transition-colors">
                  <td className="px-3 sm:px-4 py-2.5 sm:py-3.5 font-mono text-xs sm:text-sm font-semibold text-slate-800">
                    {ot.placa_codigo ??
                      ot.activo_texto ??
                      (ot.equipo_id ? `Unidad ${ot.equipo_id}` : "---")}
                    {ot.placa_codigo && ot.activo_texto && (
                      <span className="block font-sans text-[10px] sm:text-xs font-normal text-slate-500">
                        {ot.activo_texto}
                      </span>
                    )}
                  </td>
                  <td className="px-3 sm:px-4 py-2.5 sm:py-3.5 text-xs sm:text-sm text-slate-600">
                    {ot.titulo}
                    {ot.origen === "checklist" && (
                      <span className="block w-fit mt-1 px-2 py-0.5 rounded-md bg-red-50 text-red-700 text-[10px] font-bold">
                        Generada por checklist
                        {ot.checklist_id ? ` #${ot.checklist_id}` : ""}
                      </span>
                    )}
                    {ot.unidad_no_opera && (
                      <span className="block w-fit mt-1 px-2 py-0.5 rounded-md bg-red-100 text-red-700 text-[10px] font-bold">
                        No puede operar
                      </span>
                    )}
                    {textoDeDuracion(ot.duracion_minutos) && (
                      <span className="block mt-1 text-[10px] sm:text-xs text-slate-500">
                        Duración: {textoDeDuracion(ot.duracion_minutos)}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        marcarHorasYTareasVistas();
                        setDetalle(ot.id);
                      }}
                      aria-label={`Horas y tareas de la orden #${ot.id}`}
                      className="flex items-center min-h-[44px] sm:min-h-0 sm:mt-1 text-xs font-bold text-blue-600 underline underline-offset-2"
                    >
                      Horas y tareas
                      {ot.tareas_total ? ` (${ot.tareas_hechas}/${ot.tareas_total})` : ""}
                      <EtiquetaNuevo />
                    </button>
                  </td>
                  <td className="px-3 sm:px-4 py-2.5 sm:py-3.5 text-xs sm:text-sm text-slate-500 capitalize">
                    {ot.tipo}
                  </td>
                  <td className="px-3 sm:px-4 py-2.5 sm:py-3.5 text-xs sm:text-sm text-slate-500 capitalize">
                    {ot.prioridad}
                  </td>
                  <td className="px-3 sm:px-4 py-2.5 sm:py-3.5 text-xs sm:text-sm">
                    <span
                      className={`px-2.5 py-1 rounded-full text-xs font-bold ${ESTADO_COLOR[ot.estado]}`}
                    >
                      {ESTADO_LABEL[ot.estado]}
                    </span>
                  </td>
                  <td className="px-3 sm:px-4 py-2.5 sm:py-3.5 text-xs sm:text-sm">
                    <select
                      aria-label={`Reasignar orden de trabajo #${ot.id}`}
                      className="border border-slate-200 rounded-lg p-2 text-sm outline-none bg-white focus:ring-2 focus:ring-slate-900"
                      value={ot.asignado_a ?? ""}
                      onChange={(e) => handleReasignar(ot, e.target.value)}
                      disabled={!puedeEscribir}
                    >
                      <option value="">Sin asignar</option>
                      {usuariosAsignables.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.nombre}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 sm:px-4 py-2.5 sm:py-3.5 text-right space-x-2 whitespace-nowrap">
                    {puedeEscribir && ot.estado === "abierta" && (
                      <>
                        <button
                          onClick={() => handleCambiarEstado(ot.id, "en_progreso")}
                          className="px-3 py-1.5 text-xs font-bold text-blue-600 hover:bg-blue-50 rounded-lg transition-all"
                        >
                          Iniciar
                        </button>
                        <button
                          onClick={() => handleCambiarEstado(ot.id, "cancelada")}
                          className="px-3 py-1.5 text-xs font-bold text-red-600 hover:bg-red-50 rounded-lg transition-all"
                        >
                          Cancelar
                        </button>
                      </>
                    )}
                    {puedeEscribir && ot.estado === "en_progreso" && (
                      <>
                        <button
                          onClick={() => handleCambiarEstado(ot.id, "completada")}
                          className="px-3 py-1.5 text-xs font-bold text-emerald-600 hover:bg-emerald-50 rounded-lg transition-all"
                        >
                          Completar
                        </button>
                        <button
                          onClick={() => handleCambiarEstado(ot.id, "cancelada")}
                          className="px-3 py-1.5 text-xs font-bold text-red-600 hover:bg-red-50 rounded-lg transition-all"
                        >
                          Cancelar
                        </button>
                      </>
                    )}
                    {puedeEscribir && (
                      <button
                        onClick={() => handleEliminar(ot.id)}
                        className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all"
                        title="Eliminar"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex items-center justify-between mt-4 px-1">
        <button
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          disabled={page <= 1}
          className="flex items-center gap-1 px-4 py-2 text-sm font-medium text-slate-600 bg-white border border-slate-200 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-50"
        >
          <ChevronLeft className="w-4 h-4" />
          Anterior
        </button>
        <span className="text-sm text-slate-400">
          Página {page} de {totalPages}
        </span>
        <button
          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          disabled={page >= totalPages}
          className="flex items-center gap-1 px-4 py-2 text-sm font-medium text-slate-600 bg-white border border-slate-200 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-50"
        >
          Siguiente
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      {detalle !== null && (
        <DetalleDeOrden
          id={detalle}
          puedeEscribir={puedeEscribir}
          onCambio={() => cargarOrdenes(page)}
          onCerrar={() => setDetalle(null)}
        />
      )}

      {modalAbierto && (
        <NuevaOrden
          conUnidades={conUnidades}
          catalogos={catalogos}
          onCerrar={() => setModalAbierto(false)}
          onCreada={() => cargarOrdenes(page)}
        />
      )}
    </div>
  );
}
