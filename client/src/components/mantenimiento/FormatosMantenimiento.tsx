// client/src/components/mantenimiento/FormatosMantenimiento.tsx
//
// Checklists → Formatos dentro del ecosistema, como la maqueta: la lista con sus versiones y preguntas, y el
// panel de cada formato. Crear, editar y ver versiones usa las ventanas del módulo Checklists, que es dueño de
// los datos. Eliminar sigue en el módulo, en el ERP.
import { ChevronRight, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import EstadoDeFormato from "./EstadoDeFormato";
import {
  fechaDeEdicion,
  tipoDelFormato,
  usoDelFormato,
  type FilaDeFormato,
} from "./formatosMantenimiento";
import { listarFormatos } from "./mantenimientoApi";
import PanelDeFormato from "./PanelDeFormato";
import EditorDeFormato from "../checklists/EditorDeFormato";
import { usePuedeEscribir } from "../comunes/usePuedeEscribir";

export default function FormatosMantenimiento({ onCambio }: { onCambio: () => void }) {
  const puedeEscribir = usePuedeEscribir("checklists");
  const [datos, setDatos] = useState<{ filas: FilaDeFormato[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [abierto, setAbierto] = useState<number | null>(null);
  const [creando, setCreando] = useState(false);

  // Solo vale la última lectura pedida.
  const ultima = useRef(0);
  const cargar = useCallback(() => {
    const esta = ++ultima.current;
    setError(null);
    listarFormatos()
      .then((d) => {
        if (esta === ultima.current) setDatos(d);
      })
      .catch((e: unknown) => {
        if (esta === ultima.current) setError(e instanceof Error ? e.message : "Error");
      });
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargar();
  }, [cargar]);

  const cambiado = () => {
    cargar();
    onCambio();
  };
  const elegido = datos?.filas.find((f) => f.id === abierto);

  return (
    <>
      {puedeEscribir && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => setCreando(true)}
            className="flex items-center gap-2 min-h-[44px] sm:min-h-10 px-4 rounded-lg bg-[#BADC1E] text-[#0A1014] text-sm font-semibold hover:brightness-95"
          >
            <Plus size={16} /> Nuevo formato
          </button>
        </div>
      )}

      <section className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        {error && (
          <div role="alert" className="px-5 py-4 text-center text-sm text-red-700">
            No se pudieron leer los formatos. {error}
            <button
              type="button"
              onClick={cargar}
              className="mx-auto mt-2 block min-h-[44px] sm:min-h-9 px-4 rounded-lg border border-slate-300 bg-white font-semibold text-slate-700 hover:bg-slate-50"
            >
              Reintentar
            </button>
          </div>
        )}
        {(datos || !error) && (
          <div className="relative overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-slate-500 bg-slate-50 border-b border-slate-200">
                  <th className="px-4 py-3">Formato</th>
                  <th className="px-4 py-3">Versión</th>
                  <th className="px-4 py-3">Preguntas</th>
                  <th className="px-4 py-3">Críticas</th>
                  <th className="px-4 py-3">Última edición</th>
                  <th className="px-4 py-3">Estado</th>
                  <th className="px-2 py-3">
                    <span className="sr-only">Abrir</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {(!datos || datos.filas.length === 0) && (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                      {!datos ? "Cargando…" : "Todavía no hay formatos."}
                    </td>
                  </tr>
                )}
                {datos?.filas.map((f) => (
                  <tr
                    key={f.id}
                    onClick={() => setAbierto(f.id)}
                    className="cursor-pointer border-b border-slate-100 hover:bg-slate-50"
                  >
                    <td className="px-4 py-3 max-w-[280px] break-words">
                      <b className="block text-slate-900">{f.nombre}</b>
                      <small className="text-slate-500">
                        {[tipoDelFormato(f), usoDelFormato(f.unidades)].filter(Boolean).join(" · ")}
                      </small>
                    </td>
                    <td className="px-4 py-3 font-bold text-slate-900">v{f.version}</td>
                    <td className="px-4 py-3 text-slate-700">{f.preguntas}</td>
                    <td className="px-4 py-3">
                      <b className={f.criticas > 0 ? "text-red-700" : "text-slate-500"}>
                        {f.criticas}
                      </b>
                    </td>
                    <td className="px-4 py-3 text-slate-700">
                      {fechaDeEdicion(f.editado_en)}
                      {f.editado_por_nombre && (
                        <small className="block text-slate-500">{f.editado_por_nombre}</small>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <EstadoDeFormato activa={f.activa} />
                    </td>
                    <td className="px-2 py-3">
                      <button
                        type="button"
                        aria-label={`Ver el formato ${f.nombre}`}
                        className="grid h-9 w-9 place-items-center rounded-full text-slate-500 hover:bg-slate-100"
                      >
                        <ChevronRight size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="px-4 py-3 text-xs text-slate-500 border-t border-slate-200">
          Los checklists ya enviados conservan la versión con la que se llenaron.
          {datos && datos.total > datos.filas.length
            ? ` Se muestran ${datos.filas.length} de ${datos.total}; los demás están en el módulo Checklists.`
            : ""}
        </p>
      </section>

      {elegido && (
        <PanelDeFormato
          key={elegido.id}
          formato={elegido}
          puedeEscribir={puedeEscribir}
          onCerrar={() => setAbierto(null)}
          onCambio={cambiado}
        />
      )}
      {creando && (
        <EditorDeFormato
          editando={null}
          onGuardado={() => {
            setCreando(false);
            cambiado();
          }}
          onCerrar={() => setCreando(false)}
        />
      )}
    </>
  );
}
