// client/src/components/ordenes_trabajo/NuevaOrden.tsx
//
// El formulario de alta de una orden de trabajo. Lo usan el módulo Órdenes de trabajo y el ecosistema de
// Mantenimiento. Funciona sin señal: la orden queda en la cola del equipo. Los catálogos llegan ya leídos
// (useCatalogosDeOrden) para que estén aunque la señal se caiga antes de abrirlo.
import { X } from "lucide-react";
import { useState } from "react";

import {
  AgregarTarea,
  BotonQuitarTarea,
  CampoDeHora,
  CasillaNoOpera,
  EtiquetaNuevo,
} from "./CamposDeTrabajo";
import { conPendiente, problemaDeHoras } from "./horasYTareas";
import type { CatalogosDeOrden } from "./useCatalogosDeOrden";
import { apiFetch } from "../../services/apiClient";
import { opcionesDeUnidad } from "../comunes/opcionesDeUnidad";
import { SelectorBuscable } from "../comunes/SelectorBuscable";

const FORM_VACIO = {
  equipo_id: "",
  activo_texto: "",
  titulo: "",
  descripcion: "",
  tipo: "correctivo" as "correctivo" | "preventivo",
  prioridad: "media" as "baja" | "media" | "alta" | "urgente",
  iperc_id: "",
  fecha_programada: "",
  asignado_a: "",
  inicio_en: "",
  unidad_no_opera: false,
  tareas: [] as string[],
  tarea_escrita: "",
};

export default function NuevaOrden({
  conUnidades,
  catalogos,
  onCerrar,
  onCreada,
}: {
  conUnidades: boolean;
  catalogos: CatalogosDeOrden;
  onCerrar: () => void;
  /** La orden se guardó en el servidor (sin señal no se llama: todavía no existe allá). */
  onCreada: () => void;
}) {
  const { equipos, ipercs, asignables } = catalogos;
  const [guardando, setGuardando] = useState(false);
  // El cliente_uuid se fija al ABRIR el formulario, no al apretar el botón --
  // un doble tap manda el mismo envío dos veces y la idempotencia del
  // servidor los une en uno solo. Cada apertura monta de nuevo y genera otra:
  // si no, la OT legítima siguiente del turno reusaría la clave de la anterior
  // y el servidor devolvería aquella en silencio. Ver ADR-0002 §9.
  const [clienteUuid] = useState(() => crypto.randomUUID());
  const [formData, setFormData] = useState(FORM_VACIO);

  const agregarTareaAlAlta = () =>
    setFormData((f) => ({
      ...f,
      tareas: conPendiente(f.tareas, f.tarea_escrita),
      tarea_escrita: "",
    }));

  const handleCrear = async (e: React.FormEvent) => {
    e.preventDefault();
    if (guardando) return;
    // Sobre qué es la orden: la unidad o el texto (el servidor también lo exige).
    const activoTexto = formData.activo_texto.trim();
    if (!formData.titulo.trim()) {
      alert("Completá el título antes de guardar.");
      return;
    }
    if (!formData.equipo_id && !activoTexto) {
      alert(
        conUnidades
          ? "Elegí la unidad o escribí el activo o lugar de la orden."
          : "Escribí el activo o lugar de la orden."
      );
      return;
    }

    const problema = problemaDeHoras(formData.inicio_en, "");
    if (problema) {
      alert(problema);
      return;
    }
    // Lo escrito en la casilla y sin «Agregar» también cuenta.
    const tareas = conPendiente(formData.tareas, formData.tarea_escrita);

    setGuardando(true);
    try {
      const res = await apiFetch("/api/erp/ordenes_trabajo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Viene del estado (se fijó al abrir el modal), NO de un
          // crypto.randomUUID() acá adentro.
          cliente_uuid: clienteUuid,
          equipo_id: formData.equipo_id ? Number(formData.equipo_id) : undefined,
          activo_texto: activoTexto || undefined,
          titulo: formData.titulo,
          descripcion: formData.descripcion || undefined,
          tipo: formData.tipo,
          prioridad: formData.prioridad,
          iperc_id: formData.iperc_id ? Number(formData.iperc_id) : undefined,
          fecha_programada: formData.fecha_programada || undefined,
          asignado_a: formData.asignado_a || undefined,
          inicio_en: formData.inicio_en ? new Date(formData.inicio_en).toISOString() : undefined,
          unidad_no_opera: formData.unidad_no_opera || undefined,
          tareas: tareas.length > 0 ? tareas.map((descripcion) => ({ descripcion })) : undefined,
        }),
      });

      if (res.ok) {
        onCerrar();

        // 202 = no había red y quedó en la cola del dispositivo (ver
        // apiFetch). No se recarga el listado: sin señal el GET también
        // falla, y la OT todavía no existe del lado del servidor.
        if (res.status === 202) {
          alert(
            "Sin conexión: la orden de trabajo quedó guardada en este equipo y se enviará solo cuando vuelva la señal."
          );
          return;
        }

        onCreada();
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

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center z-50 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Nueva Orden de Trabajo"
        className="bg-white w-full max-w-md rounded-3xl shadow-2xl animate-in zoom-in duration-200 max-h-[90vh] overflow-y-auto"
      >
        <div className="p-6 border-b flex justify-between items-center">
          <h3 className="text-xl font-bold">Nueva Orden de Trabajo</h3>
          <button
            type="button"
            onClick={onCerrar}
            aria-label="Cerrar"
            className="text-slate-400 hover:text-slate-900"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <form onSubmit={handleCrear} className="p-6 space-y-4">
          {conUnidades && (
            <div className="space-y-1">
              <label htmlFor="ot-equipo" className="text-xs font-bold text-slate-500 uppercase">
                Equipo (opcional)
              </label>
              <SelectorBuscable
                id="ot-equipo"
                opciones={opcionesDeUnidad(equipos, "Sin unidad")}
                valor={formData.equipo_id}
                onElegir={(v) => setFormData((f) => ({ ...f, equipo_id: v }))}
                placeholder="Sin unidad"
                etiquetaBuscador="Buscar unidad"
              />
            </div>
          )}

          <div className="space-y-1">
            <label htmlFor="ot-activo" className="text-xs font-bold text-slate-500 uppercase">
              {conUnidades ? "Activo o lugar (si no es una unidad)" : "Activo o lugar"}
            </label>
            <input
              id="ot-activo"
              type="text"
              maxLength={150}
              placeholder="Ej. Horno 4, faja transportadora"
              required={!formData.equipo_id}
              className="w-full border border-slate-200 rounded-xl p-3 text-sm outline-none focus:ring-2 focus:ring-slate-900"
              value={formData.activo_texto}
              onChange={(e) => setFormData({ ...formData, activo_texto: e.target.value })}
            />
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
            <label htmlFor="ot-descripcion" className="text-xs font-bold text-slate-500 uppercase">
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
              <label htmlFor="ot-prioridad" className="text-xs font-bold text-slate-500 uppercase">
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
              {asignables.map((u) => (
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

          <div className="space-y-3 border-t pt-4">
            <span className="text-xs font-bold text-slate-500 uppercase">
              El trabajo (opcional)
              <EtiquetaNuevo />
            </span>
            <CampoDeHora
              id="ot-inicio"
              etiqueta="Hora de inicio"
              valor={formData.inicio_en}
              onCambiar={(v) => setFormData((f) => ({ ...f, inicio_en: v }))}
            />
            <CasillaNoOpera
              marcada={formData.unidad_no_opera}
              onCambiar={(v) => setFormData((f) => ({ ...f, unidad_no_opera: v }))}
            />
            {formData.tareas.length > 0 && (
              <ul aria-label="Tareas por registrar" className="space-y-2">
                {formData.tareas.map((t, i) => (
                  <li
                    key={`${i}-${t}`}
                    className="flex items-center gap-2 bg-slate-50 rounded-xl px-3"
                  >
                    <span className="flex-1 min-w-0 break-words text-sm text-slate-700">{t}</span>
                    <BotonQuitarTarea
                      nombre={t}
                      onQuitar={() =>
                        setFormData((f) => ({
                          ...f,
                          tareas: f.tareas.filter((_, j) => j !== i),
                        }))
                      }
                    />
                  </li>
                ))}
              </ul>
            )}
            <AgregarTarea
              valor={formData.tarea_escrita}
              onCambiar={(v) => setFormData((f) => ({ ...f, tarea_escrita: v }))}
              onAgregar={agregarTareaAlAlta}
              total={formData.tareas.length}
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
  );
}
