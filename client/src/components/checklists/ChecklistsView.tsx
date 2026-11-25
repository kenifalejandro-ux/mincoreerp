// client/src/components/checklists/ChecklistsView.tsx
import { ChevronLeft, ChevronRight, Plus, Trash2, X } from "lucide-react";
import { useState, useEffect, useCallback } from "react";

import EditorDeFormato from "./EditorDeFormato";
import {
  activarFormato,
  eliminarFormato,
  formatosParaLlenar,
  leerFormato,
  type Plantilla,
  type PlantillaConItems,
} from "./formatos";
import VersionesDeFormato from "./VersionesDeFormato";
import { useAuth } from "../../context/AuthContext";
import { tieneUnidades } from "../../modules/tieneModulo";
import { suscribirseASincronizacion } from "../../offline/offlineSync";
import { apiFetch } from "../../services/apiClient";
import { opcionesDeUnidad } from "../comunes/opcionesDeUnidad";
import { SelectorBuscable } from "../comunes/SelectorBuscable";
import { usePuedeEscribir } from "../comunes/usePuedeEscribir";
import { marcarNovedadVista, novedadVigente } from "../controlTv/novedad";

interface Checklist {
  id: number;
  // La unidad es opcional (de Flota); si no hay, el checklist se identifica por `activo_texto`.
  equipo_id: number | null;
  placa_codigo: string | null;
  activo_texto: string | null;
  plantilla_id: number;
  usuario_nombre: string;
  fecha: string;
  turno: string | null;
  resultado: string;
  observaciones_generales: string | null;
  creado_en: string;
}

interface Equipo {
  id: number;
  placa_codigo: string;
}

type ItemEstado = "bien" | "malo" | "na";

/** La etiqueta «Nuevo» de «Plantillas» (editar y versiones), 24 horas desde el primer clic. */
const NOVEDAD_VERSIONES = "checklists-versiones-2026-11";
const versionesSonNuevas = () => novedadVigente(Date.now(), undefined, NOVEDAD_VERSIONES);
const marcarVersionesVistas = () => marcarNovedadVista(Date.now(), undefined, NOVEDAD_VERSIONES);

export default function ChecklistsView() {
  const puedeEscribir = usePuedeEscribir("checklists");
  // Las unidades las mantiene OTRO módulo (Flota o Mantenimiento): sin ninguno no se piden ni se ofrecen unidades y el
  // checklist se identifica por el texto «Activo o lugar» (ver `opcionales` en registry.ts).
  const conUnidades = tieneUnidades(useAuth().usuario);
  const [subTab, setSubTab] = useState<"checklists" | "plantillas">("checklists");

  const [checklists, setChecklists] = useState<Checklist[]>([]);
  const [plantillas, setPlantillas] = useState<Plantilla[]>([]);
  const [equipos, setEquipos] = useState<Equipo[]>([]);
  const [loading, setLoading] = useState(true);

  // Paginación por cursor (no por número de página, ver
  // src/server/shared/utils/pagination.ts): el historial de cursores
  // vistos es lo que permite "Anterior" sin poder saltar a una página
  // arbitraria — igual que Equipos/Repuestos/Documentos, que tampoco lo
  // permiten.
  const [cursorChecklists, setCursorChecklists] = useState<number | null>(null);
  const [historialCursorChecklists, setHistorialCursorChecklists] = useState<(number | null)[]>([]);
  const [siguienteCursorChecklists, setSiguienteCursorChecklists] = useState<number | null>(null);
  const [hayMasChecklists, setHayMasChecklists] = useState(false);

  // La ventana de formatos abierta: crear (sin `editando`), editar o ver las versiones.
  const [ventanaFormato, setVentanaFormato] = useState<
    | { tipo: "editor"; editando: PlantillaConItems | null }
    | { tipo: "versiones"; plantilla: Plantilla }
    | null
  >(null);
  const [modalChecklistAbierto, setModalChecklistAbierto] = useState(false);

  const [formChecklist, setFormChecklist] = useState({
    equipo_id: "",
    activo_texto: "",
    plantilla_id: "",
    turno: "",
    observaciones_generales: "",
  });
  const [plantillaSeleccionada, setPlantillaSeleccionada] = useState<PlantillaConItems | null>(
    null
  );
  const [estadosItems, setEstadosItems] = useState<
    Record<number, { estado: ItemEstado; observacion: string }>
  >({});
  const [guardando, setGuardando] = useState(false);

  // El cliente_uuid se fija al ABRIR el modal, no al apretar "Registrar".
  // Generarlo en el submit hacía que un doble tap en la tablet mandara DOS
  // uuid distintos, y el servidor no tiene forma de distinguir eso de dos
  // inspecciones legítimas del mismo equipo (que es justo lo que la
  // idempotencia debe permitir) — creaba dos checklists reales. Con el uuid
  // atado a "este formulario que el operario abrió una vez", los dos envíos
  // llevan la misma clave y el servidor deduplica.
  //
  // Se regenera en cada apertura: si no, el segundo checklist legítimo del
  // turno reusaría la clave del primero y el servidor devolvería aquel en
  // silencio — se perdería un registro, que es peor que el duplicado.
  const [clienteUuid, setClienteUuid] = useState("");

  const abrirModalChecklist = () => {
    setClienteUuid(crypto.randomUUID());
    setModalChecklistAbierto(true);
  };

  const cargarChecklists = async (cursor: number | null = null) => {
    const params = new URLSearchParams({ pageSize: "50" });
    if (cursor !== null) params.set("cursor", String(cursor));
    const res = await apiFetch(`/api/erp/checklists?${params}`);
    const body = await res.json();
    setChecklists(Array.isArray(body.data) ? body.data : []);
    setCursorChecklists(cursor);
    setSiguienteCursorChecklists(body.pagination?.nextCursor ?? null);
    setHayMasChecklists(Boolean(body.pagination?.hasMore));
  };

  const handleSiguienteChecklists = () => {
    if (!hayMasChecklists) return;
    setHistorialCursorChecklists((h) => [...h, cursorChecklists]);
    cargarChecklists(siguienteCursorChecklists);
  };

  const handleAnteriorChecklists = () => {
    setHistorialCursorChecklists((h) => {
      const nuevo = [...h];
      const anterior = nuevo.pop() ?? null;
      cargarChecklists(anterior);
      return nuevo;
    });
  };

  const cargarPlantillas = async () => {
    const res = await apiFetch("/api/erp/checklists/plantillas?page=1&pageSize=50");
    const body = await res.json();
    setPlantillas(Array.isArray(body.data) ? body.data : []);
  };

  const cargarEquipos = async () => {
    const res = await apiFetch("/api/erp/checklists/unidades");
    const body = await res.json();
    setEquipos(Array.isArray(body.data) ? body.data : []);
  };

  const cargarTodo = useCallback(async () => {
    setLoading(true);
    // allSettled y no all: sin señal, estos GET fallan por red. Con
    // Promise.all una sola falla cortaba la función antes del
    // setLoading(false) y la pantalla quedaba clavada en "Cargando..."
    // para siempre. Acá cada carga falla por su cuenta y las que el
    // service worker sí tenga cacheadas (equipos, plantillas — ver
    // vite.config.js) igual llenan el formulario para poder trabajar.
    await Promise.allSettled([
      cargarChecklists(),
      cargarPlantillas(),
      conUnidades ? cargarEquipos() : Promise.resolve(),
    ]);
    setLoading(false);
  }, [conUnidades]);

  useEffect(() => {
    // Patrón estándar de carga al montar (setCargando(true) -> fetch ->
    // setCargando(false)), usado en toda la app.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargarTodo();
  }, [cargarTodo]);

  // Cuando la cola offline termina de drenar, los checklists que se
  // llenaron sin señal ya existen del lado del servidor — recargar es lo
  // que hace que aparezcan en el listado sin que el operario tenga que
  // refrescar a mano.
  useEffect(() => {
    return suscribirseASincronizacion(({ sincronizadas }) => {
      if (sincronizadas > 0) {
        setHistorialCursorChecklists([]);
        cargarChecklists();
      }
    });
  }, []);

  // ── Plantillas ────────────────────────────────────────────────────────
  /** Corre una acción sobre un formato; si falla dice por qué (el mensaje del servidor). */
  const conFormato = async (accion: () => Promise<unknown>) => {
    if (guardando) return;
    setGuardando(true);
    try {
      await accion();
    } catch (e) {
      alert(e instanceof Error ? e.message : "No se pudo completar la acción.");
    } finally {
      setGuardando(false);
    }
  };

  const handleEditarPlantilla = (id: number) =>
    conFormato(async () => setVentanaFormato({ tipo: "editor", editando: await leerFormato(id) }));

  const handleActivarPlantilla = (p: Plantilla) =>
    conFormato(async () => {
      await activarFormato(p.id, p.activa === false);
      await cargarPlantillas();
    });

  const handleEliminarPlantilla = (id: number) => {
    if (!window.confirm("¿Eliminar esta plantilla?")) return;
    return conFormato(async () => {
      await eliminarFormato(id);
      await cargarPlantillas();
    });
  };

  // ── Checklists ────────────────────────────────────────────────────────
  const handleSeleccionarPlantilla = async (plantillaId: string) => {
    setFormChecklist({ ...formChecklist, plantilla_id: plantillaId });
    if (!plantillaId) {
      setPlantillaSeleccionada(null);
      return;
    }
    try {
      const res = await apiFetch(`/api/erp/checklists/plantillas/${plantillaId}`);
      const plantilla = await res.json();
      setPlantillaSeleccionada(plantilla);
      const iniciales: Record<number, { estado: ItemEstado; observacion: string }> = {};
      for (const item of plantilla.items) iniciales[item.id] = { estado: "bien", observacion: "" };
      setEstadosItems(iniciales);
    } catch {
      // Sin señal y sin esta plantilla en el caché del service worker: no
      // se pueden mostrar los ítems, así que no hay checklist que llenar.
      // Se avisa en vez de dejar el modal a medias sin explicación.
      setPlantillaSeleccionada(null);
      alert(
        "No se pudo cargar esta plantilla sin conexión. Abrila una vez con señal para poder usarla en campo."
      );
    }
  };

  const handleCrearChecklist = async (e: React.FormEvent) => {
    e.preventDefault();
    if (guardando) return;
    if (!plantillaSeleccionada) return;
    // De qué es el checklist: la unidad o el texto (el servidor también lo exige).
    const activoTexto = formChecklist.activo_texto.trim();
    if (!formChecklist.equipo_id && !activoTexto) {
      alert(
        conUnidades
          ? "Elige la unidad o escribe el activo o lugar."
          : "Escribe el activo o lugar del checklist."
      );
      return;
    }

    const items = plantillaSeleccionada.items.map((it) => ({
      descripcion: it.descripcion,
      estado: estadosItems[it.id]?.estado ?? "bien",
      observacion: estadosItems[it.id]?.observacion || undefined,
    }));

    setGuardando(true);
    try {
      const res = await apiFetch("/api/erp/checklists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Viene del estado (se fijó al abrir el modal), NO de un
          // crypto.randomUUID() acá adentro: eso hacía que cada submit
          // llevara una clave nueva y un doble tap creara dos checklists.
          // Ver el comentario donde se declara clienteUuid.
          cliente_uuid: clienteUuid,
          equipo_id: formChecklist.equipo_id ? Number(formChecklist.equipo_id) : undefined,
          activo_texto: activoTexto || undefined,
          plantilla_id: Number(formChecklist.plantilla_id),
          // La versión que se tuvo delante: sin señal puede no ser ya la vigente.
          plantilla_version: plantillaSeleccionada.version,
          turno: formChecklist.turno || undefined,
          observaciones_generales: formChecklist.observaciones_generales || undefined,
          items,
        }),
      });
      if (res.ok) {
        setModalChecklistAbierto(false);
        setFormChecklist({
          equipo_id: "",
          activo_texto: "",
          plantilla_id: "",
          turno: "",
          observaciones_generales: "",
        });
        setPlantillaSeleccionada(null);

        // 202 = no había red y quedó en la cola del dispositivo (ver
        // apiFetch). No se recarga el listado: sin señal el GET también
        // falla, y el checklist todavía no existe del lado del servidor.
        if (res.status === 202) {
          alert(
            "Sin conexión: el checklist quedó guardado en este equipo y se enviará solo cuando vuelva la señal."
          );
          return;
        }

        setHistorialCursorChecklists([]);
        cargarChecklists();
      } else {
        alert("Error al crear el checklist.");
      }
    } finally {
      // En finally y no al final del try: si apiFetch tira (sin red y con
      // una ruta que no se encola), sin esto el botón quedaba trabado para
      // siempre y el operario tenía que recargar la app.
      setGuardando(false);
    }
  };

  const handleEliminarChecklist = async (id: number) => {
    if (!window.confirm("¿Eliminar este checklist?")) return;
    const res = await apiFetch(`/api/erp/checklists/${id}`, { method: "DELETE" });
    if (res.ok) {
      setHistorialCursorChecklists([]);
      cargarChecklists();
    } else {
      alert("No se pudo eliminar el checklist.");
    }
  };

  if (loading) return <div className="p-20 text-center text-slate-500">Cargando...</div>;

  return (
    <div className="p-2 sm:p-4 lg:p-8 animate-in fade-in duration-500">
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 lg:gap-6 mb-6 lg:mb-8">
        <div>
          <h1 className="text-lg sm:text-xl lg:text-2xl font-bold text-slate-800 tracking-tight">
            Checklists de pre-uso
          </h1>
          <p className="text-xs sm:text-sm text-slate-500">Plantillas e inspecciones de equipos</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setSubTab("checklists")}
            className={`px-4 py-2 rounded-xl font-medium text-sm ${subTab === "checklists" ? "bg-slate-900 text-white" : "bg-white border border-slate-200 text-slate-600"}`}
          >
            Checklists
          </button>
          <button
            onClick={() => {
              marcarVersionesVistas();
              setSubTab("plantillas");
            }}
            className={`px-4 py-2 rounded-xl font-medium text-sm ${subTab === "plantillas" ? "bg-slate-900 text-white" : "bg-white border border-slate-200 text-slate-600"}`}
          >
            Plantillas
            {versionesSonNuevas() && (
              <span className="ml-2 px-1.5 py-0.5 rounded-full bg-[#BADC1E] text-[#0A1014] text-[9px] font-extrabold">
                Nuevo
              </span>
            )}
          </button>
        </div>
      </div>

      {subTab === "checklists" && (
        <>
          <div className="flex justify-end mb-6">
            {puedeEscribir && (
              <button
                onClick={() => {
                  if (formatosParaLlenar(plantillas).length === 0) {
                    alert(
                      plantillas.length === 0
                        ? "Primero crea una plantilla."
                        : "Todas las plantillas están desactivadas: activa una para llenar un checklist."
                    );
                    return;
                  }
                  abrirModalChecklist();
                }}
                className="flex items-center gap-2 px-6 py-2.5 bg-slate-900 hover:bg-slate-800 text-white font-medium rounded-xl transition-all"
              >
                <Plus className="w-4 h-4 shrink-0" />
                Nuevo Checklist
              </button>
            )}
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
                      fecha
                    </th>
                    <th className="px-3 sm:px-4 py-2.5 sm:py-3 text-[10px] sm:text-xs font-bold text-slate-400 uppercase tracking-widest">
                      turno
                    </th>
                    <th className="px-3 sm:px-4 py-2.5 sm:py-3 text-[10px] sm:text-xs font-bold text-slate-400 uppercase tracking-widest">
                      realizado por
                    </th>
                    <th className="px-3 sm:px-4 py-2.5 sm:py-3 text-[10px] sm:text-xs font-bold text-slate-400 uppercase tracking-widest">
                      resultado
                    </th>
                    <th className="px-3 sm:px-4 py-2.5 sm:py-3 text-[10px] sm:text-xs font-bold text-slate-400 uppercase tracking-widest text-right">
                      eliminar
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {checklists.map((c) => (
                    <tr key={c.id} className="hover:bg-slate-50/50 transition-colors">
                      <td className="px-3 sm:px-4 py-2.5 sm:py-3.5 font-mono text-xs sm:text-sm font-semibold text-slate-800">
                        {c.placa_codigo ??
                          c.activo_texto ??
                          (c.equipo_id ? `Unidad ${c.equipo_id}` : "---")}
                        {c.placa_codigo && c.activo_texto && (
                          <span className="block font-sans text-[10px] sm:text-xs font-normal text-slate-500">
                            {c.activo_texto}
                          </span>
                        )}
                      </td>
                      <td className="px-3 sm:px-4 py-2.5 sm:py-3.5 text-xs sm:text-sm text-slate-600">
                        {c.fecha}
                      </td>
                      <td className="px-3 sm:px-4 py-2.5 sm:py-3.5 text-xs sm:text-sm text-slate-500">
                        {c.turno || "---"}
                      </td>
                      <td className="px-3 sm:px-4 py-2.5 sm:py-3.5 text-xs sm:text-sm text-slate-500">
                        {c.usuario_nombre}
                      </td>
                      <td className="px-3 sm:px-4 py-2.5 sm:py-3.5 text-xs sm:text-sm">
                        <span
                          className={`font-bold ${c.resultado === "bien" ? "text-emerald-600" : "text-red-500"}`}
                        >
                          {c.resultado === "bien" ? "Bien" : "Observado"}
                        </span>
                      </td>
                      <td className="px-3 sm:px-4 py-2.5 sm:py-3.5 text-right">
                        {puedeEscribir && (
                          <button
                            onClick={() => handleEliminarChecklist(c.id)}
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
          <div className="flex justify-between items-center mt-4">
            <button
              onClick={handleAnteriorChecklists}
              disabled={historialCursorChecklists.length === 0}
              className="flex items-center gap-1 px-4 py-2 text-sm font-medium text-slate-600 bg-white border border-slate-200 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-50"
            >
              <ChevronLeft className="w-4 h-4" />
              Anterior
            </button>
            <button
              onClick={handleSiguienteChecklists}
              disabled={!hayMasChecklists}
              className="flex items-center gap-1 px-4 py-2 text-sm font-medium text-slate-600 bg-white border border-slate-200 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-50"
            >
              Siguiente
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </>
      )}

      {subTab === "plantillas" && (
        <>
          <div className="flex justify-end mb-6">
            {puedeEscribir && (
              <button
                onClick={() => setVentanaFormato({ tipo: "editor", editando: null })}
                className="px-6 py-2.5 bg-slate-900 hover:bg-slate-800 text-white font-medium rounded-xl transition-all"
              >
                + Nueva Plantilla
              </button>
            )}
          </div>
          <div className="bg-white border border-slate-200 rounded-3xl overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full min-w-max text-left border-collapse">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-3 sm:px-4 py-2.5 sm:py-3 text-[10px] sm:text-xs font-bold text-slate-400 uppercase tracking-widest">
                      nombre
                    </th>
                    <th className="px-3 sm:px-4 py-2.5 sm:py-3 text-[10px] sm:text-xs font-bold text-slate-400 uppercase tracking-widest">
                      tipo de equipo
                    </th>
                    <th className="px-3 sm:px-4 py-2.5 sm:py-3 text-[10px] sm:text-xs font-bold text-slate-400 uppercase tracking-widest text-right">
                      acciones
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {plantillas.map((p) => (
                    <tr key={p.id} className="hover:bg-slate-50/50 transition-colors">
                      <td className="px-3 sm:px-4 py-2.5 sm:py-3.5 text-xs sm:text-sm font-semibold text-slate-800">
                        {p.nombre}
                        <span className="ml-2 text-xs font-medium text-slate-400">
                          v{p.version ?? 1}
                        </span>
                        {p.activa === false && (
                          <span className="ml-2 px-2 py-0.5 rounded-md bg-slate-100 text-slate-500 text-xs">
                            Desactivada
                          </span>
                        )}
                      </td>
                      <td className="px-3 sm:px-4 py-2.5 sm:py-3.5 text-xs sm:text-sm text-slate-500">
                        {p.tipo_equipo || "Uso general"}
                      </td>
                      <td className="px-3 sm:px-4 py-2.5 sm:py-3.5 text-right whitespace-nowrap">
                        <button
                          onClick={() => setVentanaFormato({ tipo: "versiones", plantilla: p })}
                          className="px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-lg"
                        >
                          Versiones
                        </button>
                        {puedeEscribir && (
                          <>
                            <button
                              onClick={() => handleEditarPlantilla(p.id)}
                              className="px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-lg"
                            >
                              Editar
                            </button>
                            <button
                              onClick={() => handleActivarPlantilla(p)}
                              className="px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-lg"
                            >
                              {p.activa === false ? "Activar" : "Desactivar"}
                            </button>
                            <button
                              onClick={() => handleEliminarPlantilla(p.id)}
                              className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all align-middle"
                              title="Eliminar"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {ventanaFormato?.tipo === "editor" && (
        <EditorDeFormato
          editando={ventanaFormato.editando}
          onGuardado={() => {
            setVentanaFormato(null);
            cargarPlantillas();
          }}
          onCerrar={() => setVentanaFormato(null)}
        />
      )}
      {ventanaFormato?.tipo === "versiones" && (
        <VersionesDeFormato
          plantilla={ventanaFormato.plantilla}
          puedeEscribir={puedeEscribir}
          onCambio={cargarPlantillas}
          onCerrar={() => setVentanaFormato(null)}
        />
      )}

      {/* Modal: nuevo checklist */}
      {modalChecklistAbierto && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center z-50 p-4">
          <div className="bg-white w-full max-w-lg rounded-3xl shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b flex justify-between items-center">
              <h3 className="text-xl font-bold">Nuevo Checklist</h3>
              <button
                onClick={() => {
                  setModalChecklistAbierto(false);
                  setPlantillaSeleccionada(null);
                }}
                className="text-slate-400 hover:text-slate-900"
                aria-label="Cerrar"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleCrearChecklist} className="p-6 space-y-4">
              <div className={`grid grid-cols-1 gap-4 ${conUnidades ? "sm:grid-cols-2" : ""}`}>
                {conUnidades && (
                  <div className="space-y-1">
                    {/* htmlFor + id, no un <label> suelto al lado: sin la
                      asociación explícita un lector de pantalla anuncia el
                      select sin nombre. Mismo patrón que LoginPage.tsx. */}
                    <label
                      htmlFor="checklist-equipo"
                      className="text-xs font-bold text-slate-500 uppercase"
                    >
                      Equipo (opcional)
                    </label>
                    <SelectorBuscable
                      id="checklist-equipo"
                      opciones={opcionesDeUnidad(equipos, "Sin unidad")}
                      valor={formChecklist.equipo_id}
                      onElegir={(v) => setFormChecklist((f) => ({ ...f, equipo_id: v }))}
                      placeholder="Sin unidad"
                      etiquetaBuscador="Buscar unidad"
                    />
                  </div>
                )}
                <div className="space-y-1">
                  <label
                    htmlFor="checklist-plantilla"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    Plantilla
                  </label>
                  <select
                    id="checklist-plantilla"
                    required
                    className="w-full border border-slate-200 rounded-xl p-3 text-sm outline-none bg-white focus:ring-2 focus:ring-slate-900"
                    value={formChecklist.plantilla_id}
                    onChange={(e) => handleSeleccionarPlantilla(e.target.value)}
                  >
                    <option value="">Selecciona...</option>
                    {formatosParaLlenar(plantillas).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.nombre}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="space-y-1">
                <label
                  htmlFor="checklist-activo"
                  className="text-xs font-bold text-slate-500 uppercase"
                >
                  {conUnidades ? "Activo o lugar (si no es una unidad)" : "Activo o lugar"}
                </label>
                <input
                  id="checklist-activo"
                  type="text"
                  maxLength={150}
                  placeholder="Ej. Horno 4, Andamio torre 3"
                  required={!formChecklist.equipo_id}
                  className="w-full border border-slate-200 rounded-xl p-3 text-sm outline-none focus:ring-2 focus:ring-slate-900"
                  value={formChecklist.activo_texto}
                  onChange={(e) =>
                    setFormChecklist({ ...formChecklist, activo_texto: e.target.value })
                  }
                />
              </div>
              <div className="space-y-1">
                <label
                  htmlFor="checklist-turno"
                  className="text-xs font-bold text-slate-500 uppercase"
                >
                  Turno (opcional)
                </label>
                <input
                  id="checklist-turno"
                  type="text"
                  className="w-full border border-slate-200 rounded-xl p-3 text-sm outline-none focus:ring-2 focus:ring-slate-900"
                  value={formChecklist.turno}
                  onChange={(e) => setFormChecklist({ ...formChecklist, turno: e.target.value })}
                />
              </div>

              {plantillaSeleccionada && (
                <div className="space-y-3 border-t pt-4">
                  <span className="text-xs font-bold text-slate-500 uppercase">Ítems</span>
                  {plantillaSeleccionada.items.map((item) => (
                    <div
                      key={item.id}
                      className="flex items-center justify-between gap-3 bg-slate-50 rounded-xl p-3"
                    >
                      <span className="text-sm text-slate-700">
                        {item.descripcion}
                        {item.critica && (
                          <span className="ml-2 px-1.5 py-0.5 rounded-md bg-red-50 text-red-700 text-[10px] font-bold uppercase">
                            Crítica
                          </span>
                        )}
                      </span>
                      <select
                        className="border border-slate-200 rounded-lg p-2 text-sm outline-none bg-white"
                        value={estadosItems[item.id]?.estado ?? "bien"}
                        onChange={(e) =>
                          setEstadosItems({
                            ...estadosItems,
                            [item.id]: {
                              ...estadosItems[item.id],
                              estado: e.target.value as ItemEstado,
                            },
                          })
                        }
                      >
                        <option value="bien">Bien</option>
                        <option value="malo">Malo</option>
                        <option value="na">N/A</option>
                      </select>
                    </div>
                  ))}
                </div>
              )}

              <div className="space-y-1">
                <label
                  htmlFor="checklist-observaciones"
                  className="text-xs font-bold text-slate-500 uppercase"
                >
                  Observaciones generales (opcional)
                </label>
                <textarea
                  id="checklist-observaciones"
                  className="w-full border border-slate-200 rounded-xl p-3 text-sm outline-none focus:ring-2 focus:ring-slate-900"
                  value={formChecklist.observaciones_generales}
                  onChange={(e) =>
                    setFormChecklist({ ...formChecklist, observaciones_generales: e.target.value })
                  }
                />
              </div>

              <button
                type="submit"
                disabled={!plantillaSeleccionada || guardando}
                className="w-full bg-slate-900 text-white font-bold py-4 rounded-2xl hover:bg-slate-800 transition-all mt-4 disabled:opacity-40"
              >
                {guardando ? "Registrando..." : "Registrar Checklist"}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
