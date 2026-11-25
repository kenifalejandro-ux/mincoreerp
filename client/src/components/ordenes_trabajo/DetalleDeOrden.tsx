// client/src/components/ordenes_trabajo/DetalleDeOrden.tsx
//
// La ventana «Horas y tareas» de una orden. Las horas se escriben a mano (también de trabajos pasados) y se
// guardan con su botón; cada tarea se guarda al momento. Todo esto necesita señal. El perfil Lectura solo mira.
import { X } from "lucide-react";
import { useEffect, useState } from "react";

import { AgregarTarea, BotonQuitarTarea, CampoDeHora, CasillaNoOpera } from "./CamposDeTrabajo";
import {
  horaParaInput,
  horasCambiadas,
  problemaDeHoras,
  textoDeDuracion,
  type Tarea,
} from "./horasYTareas";
import { apiFetch } from "../../services/apiClient";

interface Detalle {
  id: number;
  titulo: string;
  descripcion: string | null;
  activo_texto: string | null;
  tipo: string;
  prioridad: string;
  iperc_id: number | null;
  fecha_programada: string | null;
  asignado_a: string | null;
  inicio_en: string | null;
  fecha_cierre: string | null;
  unidad_no_opera: boolean;
  duracion_minutos?: number | null;
  tareas: Tarea[];
}

const SIN_SENAL = "Sin conexión: los cambios de una orden ya registrada necesitan señal.";

/** Llama al servidor; si falla dice por qué (su mensaje, o que no hay señal). */
async function pedir(ruta: string, porDefecto: string, metodo = "GET", cuerpo?: unknown) {
  let res: Response;
  try {
    res = await apiFetch(`/api/erp/ordenes_trabajo/${ruta}`, {
      method: metodo,
      headers: { "Content-Type": "application/json" },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    });
  } catch {
    throw new Error(SIN_SENAL);
  }
  const datos = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(datos.errors?.[0]?.message || datos.message || porDefecto);
  return datos;
}

export default function DetalleDeOrden({
  id,
  puedeEscribir,
  onCambio,
  onCerrar,
}: {
  id: number;
  puedeEscribir: boolean;
  onCambio: () => void;
  onCerrar: () => void;
}) {
  const [orden, setOrden] = useState<Detalle | null>(null);
  const [inicio, setInicio] = useState("");
  const [cierre, setCierre] = useState("");
  const [noOpera, setNoOpera] = useState(false);
  const [nueva, setNueva] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [guardado, setGuardado] = useState(false);
  const [guardando, setGuardando] = useState(false);

  const mostrar = (o: Detalle) => {
    setOrden(o);
    setInicio(horaParaInput(o.inicio_en));
    setCierre(horaParaInput(o.fecha_cierre));
    setNoOpera(o.unidad_no_opera);
  };

  useEffect(() => {
    let cancelado = false;
    pedir(String(id), "No se pudo abrir la orden.")
      .then((o: Detalle) => {
        if (!cancelado) mostrar(o);
      })
      .catch((e: Error) => {
        if (!cancelado) setError(e.message);
      });
    return () => {
      cancelado = true;
    };
  }, [id]);

  /** Una acción a la vez; el error se muestra en la ventana. */
  const hacer = async (accion: () => Promise<void>) => {
    if (guardando) return false;
    setGuardando(true);
    setError(null);
    setGuardado(false);
    try {
      await accion();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo guardar.");
      return false;
    } finally {
      setGuardando(false);
    }
  };

  const guardarHoras = (e: React.FormEvent) => {
    e.preventDefault();
    if (!orden) return;
    const problema = problemaDeHoras(inicio, cierre);
    if (problema) {
      setError(problema);
      return;
    }
    void hacer(async () => {
      // Se relee antes de guardar: el PUT lleva toda la orden y no debe pisar lo que otro cambió.
      const actual: Detalle = await pedir(String(id), "No se pudo abrir la orden.");
      await pedir(String(id), "No se pudieron guardar las horas.", "PUT", {
        activo_texto: actual.activo_texto || undefined,
        titulo: actual.titulo,
        descripcion: actual.descripcion || undefined,
        tipo: actual.tipo,
        prioridad: actual.prioridad,
        iperc_id: actual.iperc_id || undefined,
        fecha_programada: actual.fecha_programada || undefined,
        asignado_a: actual.asignado_a || undefined,
        unidad_no_opera: noOpera === orden.unidad_no_opera ? undefined : noOpera,
        ...horasCambiadas(orden, inicio, cierre),
      });
      mostrar(await pedir(String(id), "No se pudo abrir la orden."));
      setGuardado(true);
      onCambio();
    });
  };

  const cambiarTareas = (cambios: object, despues?: () => void) =>
    hacer(async () => {
      const { tareas } = await pedir(
        `${id}/tareas`,
        "No se pudo cambiar la tarea.",
        "PATCH",
        cambios
      );
      setOrden((o) => (o ? { ...o, tareas } : o));
      despues?.();
      onCambio();
    });

  const ponerHecha = (tareaId: number, hecha: boolean) =>
    setOrden((o) =>
      o ? { ...o, tareas: o.tareas.map((t) => (t.id === tareaId ? { ...t, hecha } : t)) } : o
    );

  /** La casilla cambia al tocarla (con señal lenta parecería que no entró) y vuelve atrás si falla. */
  const marcar = (tareaId: number, hecha: boolean) => {
    if (guardando) return;
    ponerHecha(tareaId, hecha);
    void cambiarTareas({ marcar: [{ id: tareaId, hecha }] }).then((ok) => {
      if (!ok) ponerHecha(tareaId, !hecha);
    });
  };

  const agregar = () => {
    const descripcion = nueva.trim();
    if (!descripcion) return;
    void cambiarTareas({ agregar: [{ descripcion }] }, () => setNueva(""));
  };

  const duracion = textoDeDuracion(orden?.duracion_minutos);

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center z-50 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Horas y tareas de la orden #${id}`}
        className="bg-white w-full max-w-lg rounded-3xl shadow-2xl max-h-[90vh] overflow-y-auto"
      >
        <div className="p-6 border-b flex justify-between items-start gap-3">
          <div className="min-w-0">
            <h3 className="text-xl font-bold">Orden #{id}</h3>
            {orden && <p className="text-sm text-slate-500 break-words">{orden.titulo}</p>}
          </div>
          <button
            type="button"
            onClick={onCerrar}
            aria-label="Cerrar"
            className="flex items-center justify-center min-w-[44px] min-h-[44px] text-slate-400 hover:text-slate-900"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-6 space-y-5">
          {error && (
            <p role="alert" className="text-sm text-red-700 bg-red-50 rounded-lg p-3">
              {error}
            </p>
          )}
          {!orden && !error && <p className="text-sm text-slate-500">Cargando...</p>}
          {orden && (
            <>
              <form onSubmit={guardarHoras} className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <CampoDeHora
                    id="ot-detalle-inicio"
                    etiqueta="Hora de inicio"
                    valor={inicio}
                    onCambiar={setInicio}
                    disabled={!puedeEscribir}
                  />
                  {orden.fecha_cierre && (
                    <CampoDeHora
                      id="ot-detalle-cierre"
                      etiqueta="Hora de cierre"
                      valor={cierre}
                      onCambiar={setCierre}
                      disabled={!puedeEscribir}
                    />
                  )}
                </div>
                <p className="text-sm text-slate-600">
                  Duración: <b>{duracion ?? "sin datos"}</b>
                </p>
                <CasillaNoOpera
                  marcada={noOpera}
                  onCambiar={setNoOpera}
                  disabled={!puedeEscribir}
                />
                {puedeEscribir && (
                  <button
                    type="submit"
                    disabled={guardando}
                    className="w-full min-h-[44px] bg-slate-900 text-white font-bold py-3 rounded-2xl hover:bg-slate-800 disabled:opacity-50"
                  >
                    {guardando ? "Guardando..." : "Guardar horas"}
                  </button>
                )}
                {guardado && (
                  <p role="status" className="text-sm font-semibold text-emerald-600">
                    Guardado.
                  </p>
                )}
              </form>

              <section aria-label="Tareas" className="space-y-2 border-t pt-4">
                <span className="text-xs font-bold text-slate-500 uppercase">
                  Tareas ({orden.tareas.filter((t) => t.hecha).length}/{orden.tareas.length})
                </span>
                {orden.tareas.length === 0 && (
                  <p className="text-sm text-slate-500">Esta orden no tiene tareas.</p>
                )}
                <ul className="space-y-2">
                  {orden.tareas.map((t) => (
                    <li key={t.id} className="flex items-center gap-2 bg-slate-50 rounded-xl px-3">
                      <label className="flex flex-1 min-w-0 items-center gap-3 min-h-[44px] text-sm text-slate-700">
                        <input
                          type="checkbox"
                          className="w-5 h-5 shrink-0"
                          checked={t.hecha}
                          disabled={!puedeEscribir || guardando}
                          onChange={(e) => marcar(t.id, e.target.checked)}
                        />
                        <span className={`break-words ${t.hecha ? "line-through opacity-60" : ""}`}>
                          {t.descripcion}
                        </span>
                      </label>
                      {puedeEscribir && (
                        <BotonQuitarTarea
                          nombre={t.descripcion}
                          disabled={guardando}
                          onQuitar={() => {
                            if (window.confirm("¿Quitar esta tarea?")) {
                              void cambiarTareas({ quitar: [t.id] });
                            }
                          }}
                        />
                      )}
                    </li>
                  ))}
                </ul>
                {puedeEscribir && (
                  <AgregarTarea
                    valor={nueva}
                    onCambiar={setNueva}
                    onAgregar={agregar}
                    total={orden.tareas.length}
                    disabled={guardando}
                  />
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
