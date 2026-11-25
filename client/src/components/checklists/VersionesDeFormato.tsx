// client/src/components/checklists/VersionesDeFormato.tsx
//
// El historial de un formato: cada versión con qué cambió, quién y cuándo, y sus preguntas. «Volver a esta
// versión» crea una versión nueva igual a aquella: la historia no se borra.
import { X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { leerVersiones, volverAVersion, type Plantilla, type VersionDeFormato } from "./formatos";

export default function VersionesDeFormato({
  plantilla,
  puedeEscribir,
  onCambio,
  onCerrar,
}: {
  plantilla: Plantilla;
  puedeEscribir: boolean;
  onCambio: () => void;
  onCerrar: () => void;
}) {
  const [versiones, setVersiones] = useState<VersionDeFormato[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [volviendo, setVolviendo] = useState(false);

  const cargar = useCallback(
    () =>
      leerVersiones(plantilla.id)
        .then(setVersiones)
        .catch((e: unknown) => setError(e instanceof Error ? e.message : "No se pudo cargar.")),
    [plantilla.id]
  );

  useEffect(() => {
    cargar();
  }, [cargar]);

  const vigente = versiones?.[0]?.version ?? 0;

  const volver = async (version: number) => {
    if (volviendo) return;
    if (!window.confirm(`¿Volver a la versión ${version}? Se guardará como una versión nueva.`))
      return;
    setError(null);
    setVolviendo(true);
    try {
      await volverAVersion(plantilla.id, version, vigente);
      onCambio();
      await cargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo volver a esa versión.");
      await cargar();
    } finally {
      setVolviendo(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center z-50 p-4">
      <div
        role="dialog"
        aria-label="Versiones del formato"
        className="bg-white w-full max-w-lg rounded-3xl shadow-2xl max-h-[90vh] overflow-y-auto"
      >
        <div className="p-6 border-b flex justify-between items-center">
          <div>
            <h3 className="text-xl font-bold">Versiones del formato</h3>
            <p className="text-sm text-slate-500">{plantilla.nombre}</p>
          </div>
          <button
            onClick={onCerrar}
            className="text-slate-400 hover:text-slate-900"
            aria-label="Cerrar"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-6 space-y-3">
          {error && (
            <p
              role="alert"
              className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl p-3"
            >
              {error}
            </p>
          )}
          {versiones === null && !error && <p className="text-sm text-slate-500">Cargando…</p>}
          {versiones?.map((v) => (
            <section
              key={v.version}
              aria-label={`Versión ${v.version}`}
              className="border border-slate-200 rounded-2xl p-4 space-y-2"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <b className="text-sm text-slate-800">
                  Versión {v.version}
                  {v.version === vigente ? " · vigente" : ""}
                </b>
                {puedeEscribir && v.version !== vigente && (
                  <button
                    onClick={() => volver(v.version)}
                    disabled={volviendo}
                    className="text-sm font-semibold text-slate-700 border border-slate-200 rounded-lg px-3 py-1.5 hover:bg-slate-50 disabled:opacity-40"
                  >
                    Volver a esta versión
                  </button>
                )}
              </div>
              <p className="text-sm text-slate-700">{v.cambio ?? "Versión original"}</p>
              <p className="text-xs text-slate-500">
                {new Date(v.creado_en).toLocaleDateString("es-PE")}
                {v.creado_por_nombre ? ` · ${v.creado_por_nombre}` : ""}
              </p>
              <ul className="text-xs text-slate-600 list-disc pl-5">
                {v.items.map((i, n) => (
                  <li key={n}>
                    {i.descripcion}
                    {i.critica && <span className="ml-1 font-bold text-red-700">(crítica)</span>}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
