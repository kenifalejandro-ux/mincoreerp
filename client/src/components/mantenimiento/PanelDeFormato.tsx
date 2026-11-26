// client/src/components/mantenimiento/PanelDeFormato.tsx
//
// El panel de un formato, como la maqueta: sus preguntas, el historial de versiones y las unidades que lo usan.
import { Pencil } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import EstadoDeFormato from "./EstadoDeFormato";
import {
  fechaDeEdicion,
  tipoDelFormato,
  unidadesDelFormato,
  type FilaDeFormato,
} from "./formatosMantenimiento";
import { listarEquipos, type EquipoMantenimiento } from "./mantenimientoApi";
import EditorDeFormato from "../checklists/EditorDeFormato";
import {
  activarFormato,
  leerFormato,
  leerVersiones,
  type PlantillaConItems,
  type VersionDeFormato,
} from "../checklists/formatos";
import VersionesDeFormato from "../checklists/VersionesDeFormato";
import PanelDeDetalle from "../proveedores/PanelDeDetalle";

const caja = "rounded-xl border border-slate-200 bg-white shadow-sm";
const boton =
  "min-h-[44px] sm:min-h-10 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50";
const mensaje = (e: unknown) => (e instanceof Error ? e.message : "Error");

export default function PanelDeFormato({
  formato,
  puedeEscribir,
  onCerrar,
  onCambio,
}: {
  formato: FilaDeFormato;
  puedeEscribir: boolean;
  onCerrar: () => void;
  /** Se editó, se activó o se volvió a una versión: la lista se relee. */
  onCambio: () => void;
}) {
  const [detalle, setDetalle] = useState<{
    plantilla: PlantillaConItems;
    versiones: VersionDeFormato[];
    equipos: EquipoMantenimiento[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ventana, setVentana] = useState<"editar" | "versiones" | null>(null);
  const [cambiando, setCambiando] = useState(false);

  const ultima = useRef(0);
  const cargar = useCallback(() => {
    const esta = ++ultima.current;
    setError(null);
    Promise.all([leerFormato(formato.id), leerVersiones(formato.id), listarEquipos()])
      .then(([plantilla, versiones, lista]) => {
        if (esta === ultima.current) {
          setDetalle({ plantilla, versiones, equipos: lista.equipos });
        }
      })
      .catch((e: unknown) => {
        if (esta === ultima.current) setError(mensaje(e));
      });
  }, [formato.id]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargar();
  }, [cargar]);

  const cambiado = () => {
    cargar();
    onCambio();
  };
  const activar = () => {
    if (cambiando) return;
    setCambiando(true);
    setError(null);
    activarFormato(formato.id, !formato.activa)
      .then(onCambio)
      .catch((e: unknown) => setError(mensaje(e)))
      .finally(() => setCambiando(false));
  };
  const usan = detalle ? unidadesDelFormato(formato, detalle.equipos) : [];

  return (
    <PanelDeDetalle
      etiqueta="Detalle del formato"
      titulo="Formato de checklist"
      onCerrar={onCerrar}
    >
      <div className="space-y-4">
        <header className={`${caja} p-5`}>
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="min-w-0 break-words text-2xl font-semibold text-slate-900">
              {formato.nombre}
            </h2>
            <EstadoDeFormato activa={formato.activa} />
          </div>
          <p className="mt-1 break-words text-sm text-slate-600">
            {tipoDelFormato(formato)} · {formato.preguntas}{" "}
            {formato.preguntas === 1 ? "pregunta" : "preguntas"} · {formato.criticas}{" "}
            {formato.criticas === 1 ? "crítica" : "críticas"} · Última edición{" "}
            {fechaDeEdicion(formato.editado_en)}
            {formato.editado_por_nombre ? ` · ${formato.editado_por_nombre}` : ""}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {puedeEscribir && (
              <>
                <button
                  type="button"
                  disabled={!detalle}
                  onClick={() => setVentana("editar")}
                  className={`${boton} flex items-center gap-1.5`}
                >
                  <Pencil size={15} /> Editar formato
                </button>
                <button type="button" disabled={cambiando} onClick={activar} className={boton}>
                  {formato.activa ? "Desactivar" : "Activar"}
                </button>
              </>
            )}
            <button type="button" onClick={() => setVentana("versiones")} className={boton}>
              Versiones
            </button>
          </div>
        </header>

        {error && (
          <div role="alert" className="rounded-xl bg-red-50 p-4 text-sm text-red-700">
            {error}
            <button type="button" onClick={cargar} className={`${boton} mt-2 block`}>
              Volver a leer
            </button>
          </div>
        )}
        {!detalle ? (
          !error && <p className="py-8 text-center text-sm text-slate-500">Cargando…</p>
        ) : (
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <section aria-label="Preguntas" className={caja}>
              <h3 className="border-b border-slate-200 px-5 py-3 font-semibold text-slate-900">
                Lo que ve quien lo llena
              </h3>
              <ol>
                {detalle.plantilla.items.map((i, n) => (
                  <li
                    key={i.id}
                    className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-100 px-5 py-3 last:border-b-0"
                  >
                    <b className="min-w-0 flex-1 break-words text-sm text-slate-900">
                      {n + 1}. {i.descripcion}
                    </b>
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${
                        i.critica ? "bg-red-100 text-red-700" : "bg-slate-100 text-slate-600"
                      }`}
                    >
                      {i.critica ? "Crítica: si falla, No apta" : "Normal"}
                    </span>
                  </li>
                ))}
              </ol>
            </section>

            <aside className="space-y-4">
              <section aria-label="Historial de versiones" className={`${caja} p-5`}>
                <h3 className="mb-3 font-semibold text-slate-900">Historial</h3>
                {detalle.versiones.length === 0 ? (
                  <p className="text-sm text-slate-500">v{formato.version} · vigente</p>
                ) : (
                  <ul className="space-y-3">
                    {detalle.versiones.map((v) => (
                      <li key={v.version} className="text-sm">
                        <b className="text-slate-900">
                          v{v.version}
                          {v.version === formato.version ? " · vigente" : ""}
                        </b>
                        <span className="block break-words text-xs text-slate-500">
                          {[fechaDeEdicion(v.creado_en), v.creado_por_nombre, v.cambio]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              {formato.unidades !== null && (
                <section aria-label="Unidades que lo usan" className={`${caja} p-5`}>
                  <h3 className="mb-3 font-semibold text-slate-900">Unidades que lo usan</h3>
                  {usan.length === 0 ? (
                    <p className="text-sm text-slate-500">Ninguna unidad.</p>
                  ) : (
                    <ul className="max-h-72 space-y-2 overflow-y-auto">
                      {usan.map((u) => (
                        <li key={u.id} className="text-sm">
                          <b className="block break-words text-slate-900">{u.placa_codigo}</b>
                          <span className="text-xs text-slate-500">
                            {u.tipo}
                            {u.propiedad === "alquilada" ? " · alquilada" : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              )}
            </aside>
          </div>
        )}
      </div>

      {ventana === "editar" && detalle && (
        <EditorDeFormato
          editando={detalle.plantilla}
          onGuardado={() => {
            setVentana(null);
            cambiado();
          }}
          onCerrar={() => {
            setVentana(null);
            // Pudo rechazarse porque alguien más lo cambió: se relee.
            cambiado();
          }}
        />
      )}
      {ventana === "versiones" && (
        <VersionesDeFormato
          plantilla={formato}
          puedeEscribir={puedeEscribir}
          onCambio={cambiado}
          onCerrar={() => setVentana(null)}
        />
      )}
    </PanelDeDetalle>
  );
}
