// client/src/components/ordenes_trabajo/OrdenesTrabajoView.tsx
import { ChevronLeft, ChevronRight, Trash2, X } from "lucide-react";
import { useState, useEffect, useCallback } from "react";

import { suscribirseASincronizacion } from "../../offline/offlineSync";
import { apiFetch } from "../../services/apiClient";

type Estado = "abierta" | "en_progreso" | "completada" | "cancelada";

interface OrdenTrabajo {
  id: number;
  equipo_id: number;
  placa_codigo: string;
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
  creado_en: string;
}

interface Equipo {
  id: number;
  placa_codigo: string;
}

interface IpercResumen {
  id: number;
  area_frente: string;
  estado: string;
}

interface UsuarioAsignable {
  id: string;
  nombre: string;
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

const FORM_VACIO = {
  equipo_id: "",
  titulo: "",
  descripcion: "",
  tipo: "correctivo" as "correctivo" | "preventivo",
  prioridad: "media" as "baja" | "media" | "alta" | "urgente",
  iperc_id: "",
  fecha_programada: "",
  asignado_a: "",
};

export default function OrdenesTrabajoView() {
  const [ordenes, setOrdenes] = useState<OrdenTrabajo[]>([]);
  const [equipos, setEquipos] = useState<Equipo[]>([]);
  const [ipercs, setIpercs] = useState<IpercResumen[]>([]);
  const [usuariosAsignables, setUsuariosAsignables] = useState<UsuarioAsignable[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [filtroEstado, setFiltroEstado] = useState("");
  const [filtroEquipo, setFiltroEquipo] = useState("");
  const [filtroAsignado, setFiltroAsignado] = useState("");

  const [modalAbierto, setModalAbierto] = useState(false);
  const [guardando, setGuardando] = useState(false);

  // El cliente_uuid se fija al ABRIR el modal, no al apretar el botón --
  // un doble tap manda el mismo envío dos veces y la idempotencia del
  // servidor los une en uno solo. Se regenera en cada apertura: si no, la
  // OT legítima siguiente del turno reusaría la clave de la anterior y el
  // servidor devolvería aquella en silencio. Ver ADR-0002 §9.
  const [clienteUuid, setClienteUuid] = useState("");
  const [formData, setFormData] = useState(FORM_VACIO);

  const cargarOrdenes = useCallback(
    async (paginaAConsultar: number) => {
      const params = new URLSearchParams({ page: String(paginaAConsultar), pageSize: "50" });
      if (filtroEstado) params.set("estado", filtroEstado);
      if (filtroEquipo) params.set("equipo_id", filtroEquipo);
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
    [filtroEstado, filtroEquipo, filtroAsignado]
  );

  const cargarEquipos = useCallback(async () => {
    const res = await apiFetch("/api/erp/equipos?page=1&pageSize=200");
    const body = await res.json();
    setEquipos(Array.isArray(body.data) ? body.data : []);
  }, []);

  // Catálogo para el selector opcional de IPERC -- solo trazabilidad
  // ("esta OT tiene tal evaluación de riesgo asociada"), sin gating real
  // (ver ADR-0002, decisión de v1). Best-effort: si el módulo IPERC no
  // está habilitado para este tenant, el select queda vacío sin romper el
  // resto del formulario.
  const cargarIpercs = useCallback(async () => {
    try {
      const res = await apiFetch("/api/erp/iperc?pageSize=200");
      const body = await res.json();
      setIpercs(Array.isArray(body.data) ? body.data : []);
    } catch {
      setIpercs([]);
    }
  }, []);

  useEffect(() => {
    // Patrón estándar de carga al montar/cambiar filtros o página.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    cargarOrdenes(page);
  }, [page, cargarOrdenes]);

  // Catálogo para el selector de "Asignado a" -- usuarios activos del
  // tenant, sin rol de solo-lectura (ver
  // OrdenesTrabajoRepository.findUsuariosAsignables).
  const cargarUsuariosAsignables = useCallback(async () => {
    try {
      const res = await apiFetch("/api/erp/ordenes_trabajo/usuarios-asignables");
      const body = await res.json();
      setUsuariosAsignables(Array.isArray(body) ? body : []);
    } catch {
      setUsuariosAsignables([]);
    }
  }, []);

  useEffect(() => {
    // Patrón estándar de carga de catálogos al montar (mismo criterio que
    // el efecto de arriba).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargarEquipos();
    cargarIpercs();
    cargarUsuariosAsignables();
  }, [cargarEquipos, cargarIpercs, cargarUsuariosAsignables]);

  // Cuando la cola offline termina de drenar, las OT que se crearon sin
  // señal ya existen del lado del servidor -- recargar es lo que hace que
  // aparezcan en el listado sin que el operario tenga que refrescar a mano.
  useEffect(() => {
    return suscribirseASincronizacion(({ sincronizadas }) => {
      if (sincronizadas > 0) cargarOrdenes(page);
    });
  }, [page, cargarOrdenes]);

  const abrirModal = () => {
    setClienteUuid(crypto.randomUUID());
    setFormData(FORM_VACIO);
    setModalAbierto(true);
  };

  const handleCrear = async (e: React.FormEvent) => {
    e.preventDefault();
    if (guardando) return;
    if (!formData.equipo_id || !formData.titulo.trim()) {
      alert("Completá el equipo y el título antes de guardar.");
      return;
    }

    setGuardando(true);
    try {
      const res = await apiFetch("/api/erp/ordenes_trabajo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Viene del estado (se fijó al abrir el modal), NO de un
          // crypto.randomUUID() acá adentro.
          cliente_uuid: clienteUuid,
          equipo_id: Number(formData.equipo_id),
          titulo: formData.titulo,
          descripcion: formData.descripcion || undefined,
          tipo: formData.tipo,
          prioridad: formData.prioridad,
          iperc_id: formData.iperc_id ? Number(formData.iperc_id) : undefined,
          fecha_programada: formData.fecha_programada || undefined,
          asignado_a: formData.asignado_a || undefined,
        }),
      });

      if (res.ok) {
        setModalAbierto(false);
        setFormData(FORM_VACIO);

        // 202 = no había red y quedó en la cola del dispositivo (ver
        // apiFetch). No se recarga el listado: sin señal el GET también
        // falla, y la OT todavía no existe del lado del servidor.
        if (res.status === 202) {
          alert(
            "Sin conexión: la orden de trabajo quedó guardada en este equipo y se enviará solo cuando vuelva la señal."
          );
          return;
        }

        cargarOrdenes(page);
      } else {
        const body = await res.json().catch(() => ({}));
        const detalle = Array.isArray(body.errors)
          ? body.errors.map((err: { message: string }) => err.message).join(", ")
          : body.message;
        alert(detalle || "Error al crear la orden de trabajo.");
      }
    } finally {
      setGuardando(false);
    }
  };

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
  // asignado_a. equipo_id no viaja: es inmutable, el PUT no lo acepta.
  const handleReasignar = async (ot: OrdenTrabajo, nuevoAsignadoA: string) => {
    const res = await apiFetch(`/api/erp/ordenes_trabajo/${ot.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
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
        <button
          onClick={abrirModal}
          className="px-6 py-2.5 bg-slate-900 hover:bg-slate-800 text-white font-medium rounded-xl transition-all"
        >
          + Nueva Orden de Trabajo
        </button>
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
        <div className="space-y-1 flex-1">
          <label htmlFor="ot-filtro-equipo" className="text-xs font-bold text-slate-500 uppercase">
            Filtrar por equipo
          </label>
          <select
            id="ot-filtro-equipo"
            className="w-full border border-slate-200 rounded-xl p-3 text-sm outline-none bg-white focus:ring-2 focus:ring-slate-900"
            value={filtroEquipo}
            onChange={(e) => {
              setPage(1);
              setFiltroEquipo(e.target.value);
            }}
          >
            <option value="">Todos</option>
            {equipos.map((eq) => (
              <option key={eq.id} value={eq.id}>
                {eq.placa_codigo}
              </option>
            ))}
          </select>
        </div>
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
                  equipo
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
                    {ot.placa_codigo}
                  </td>
                  <td className="px-3 sm:px-4 py-2.5 sm:py-3.5 text-xs sm:text-sm text-slate-600">
                    {ot.titulo}
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
                    {ot.estado === "abierta" && (
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
                    {ot.estado === "en_progreso" && (
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
                    <button
                      onClick={() => handleEliminar(ot.id)}
                      className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all"
                      title="Eliminar"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
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

      {modalAbierto && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center z-50 p-4">
          <div className="bg-white w-full max-w-md rounded-3xl shadow-2xl animate-in zoom-in duration-200 max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b flex justify-between items-center">
              <h3 className="text-xl font-bold">Nueva Orden de Trabajo</h3>
              <button
                onClick={() => setModalAbierto(false)}
                aria-label="Cerrar"
                className="text-slate-400 hover:text-slate-900"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleCrear} className="p-6 space-y-4">
              <div className="space-y-1">
                <label htmlFor="ot-equipo" className="text-xs font-bold text-slate-500 uppercase">
                  Equipo
                </label>
                <select
                  id="ot-equipo"
                  required
                  className="w-full border border-slate-200 rounded-xl p-3 text-sm outline-none bg-white focus:ring-2 focus:ring-slate-900"
                  value={formData.equipo_id}
                  onChange={(e) => setFormData({ ...formData, equipo_id: e.target.value })}
                >
                  <option value="" disabled>
                    Seleccioná un equipo
                  </option>
                  {equipos.map((eq) => (
                    <option key={eq.id} value={eq.id}>
                      {eq.placa_codigo}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <label htmlFor="ot-titulo" className="text-xs font-bold text-slate-500 uppercase">
                  Título
                </label>
                <input
                  id="ot-titulo"
                  type="text"
                  placeholder="Ej: Cambio de aceite"
                  required
                  className="w-full border border-slate-200 rounded-xl p-3 text-sm outline-none focus:ring-2 focus:ring-slate-900"
                  value={formData.titulo}
                  onChange={(e) => setFormData({ ...formData, titulo: e.target.value })}
                />
              </div>

              <div className="space-y-1">
                <label
                  htmlFor="ot-descripcion"
                  className="text-xs font-bold text-slate-500 uppercase"
                >
                  Descripción
                </label>
                <textarea
                  id="ot-descripcion"
                  rows={3}
                  className="w-full border border-slate-200 rounded-xl p-3 text-sm outline-none focus:ring-2 focus:ring-slate-900"
                  value={formData.descripcion}
                  onChange={(e) => setFormData({ ...formData, descripcion: e.target.value })}
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label htmlFor="ot-tipo" className="text-xs font-bold text-slate-500 uppercase">
                    Tipo
                  </label>
                  <select
                    id="ot-tipo"
                    className="w-full border border-slate-200 rounded-xl p-3 text-sm outline-none bg-white focus:ring-2 focus:ring-slate-900"
                    value={formData.tipo}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        tipo: e.target.value as "correctivo" | "preventivo",
                      })
                    }
                  >
                    <option value="correctivo">Correctivo</option>
                    <option value="preventivo">Preventivo</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <label
                    htmlFor="ot-prioridad"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    Prioridad
                  </label>
                  <select
                    id="ot-prioridad"
                    className="w-full border border-slate-200 rounded-xl p-3 text-sm outline-none bg-white focus:ring-2 focus:ring-slate-900"
                    value={formData.prioridad}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        prioridad: e.target.value as "baja" | "media" | "alta" | "urgente",
                      })
                    }
                  >
                    <option value="baja">Baja</option>
                    <option value="media">Media</option>
                    <option value="alta">Alta</option>
                    <option value="urgente">Urgente</option>
                  </select>
                </div>
              </div>

              <div className="space-y-1">
                <label htmlFor="ot-iperc" className="text-xs font-bold text-slate-500 uppercase">
                  IPERC asociado (opcional)
                </label>
                <select
                  id="ot-iperc"
                  className="w-full border border-slate-200 rounded-xl p-3 text-sm outline-none bg-white focus:ring-2 focus:ring-slate-900"
                  value={formData.iperc_id}
                  onChange={(e) => setFormData({ ...formData, iperc_id: e.target.value })}
                >
                  <option value="">Sin vincular</option>
                  {ipercs.map((i) => (
                    <option key={i.id} value={i.id}>
                      #{i.id} — {i.area_frente} ({i.estado})
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <label htmlFor="ot-asignado" className="text-xs font-bold text-slate-500 uppercase">
                  Asignado a (opcional)
                </label>
                <select
                  id="ot-asignado"
                  className="w-full border border-slate-200 rounded-xl p-3 text-sm outline-none bg-white focus:ring-2 focus:ring-slate-900"
                  value={formData.asignado_a}
                  onChange={(e) => setFormData({ ...formData, asignado_a: e.target.value })}
                >
                  <option value="">Sin asignar</option>
                  {usuariosAsignables.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.nombre}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <label
                  htmlFor="ot-fecha-programada"
                  className="text-xs font-bold text-slate-500 uppercase"
                >
                  Fecha programada (opcional)
                </label>
                <input
                  id="ot-fecha-programada"
                  type="date"
                  className="w-full border border-slate-200 rounded-xl p-3 text-sm outline-none focus:ring-2 focus:ring-slate-900"
                  value={formData.fecha_programada}
                  onChange={(e) => setFormData({ ...formData, fecha_programada: e.target.value })}
                />
              </div>

              <button
                type="submit"
                disabled={guardando}
                className="w-full bg-slate-900 text-white font-bold py-4 rounded-2xl hover:bg-slate-800 transition-all mt-4 disabled:opacity-50"
              >
                {guardando ? "Guardando..." : "Registrar Orden de Trabajo"}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
