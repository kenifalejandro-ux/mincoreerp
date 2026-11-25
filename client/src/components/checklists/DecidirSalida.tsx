// client/src/components/checklists/DecidirSalida.tsx
//
// La ventana para decidir si sale una unidad con fallas menores: qué falló, la decisión con su motivo y, si
// sale, si se deja una orden para después. Necesita señal.
import { X } from "lucide-react";
import { useEffect, useState } from "react";

import { apiFetch } from "../../services/apiClient";

const SIN_SENAL = "Sin conexión: autorizar o negar una salida necesita señal.";

interface Detalle {
  usuario_nombre: string;
  items: { id: number; descripcion: string; estado: string; observacion: string | null }[];
}

async function pedir(ruta: string, porDefecto: string, metodo = "GET", cuerpo?: unknown) {
  let res: Response;
  try {
    res = await apiFetch(`/api/erp/checklists/${ruta}`, {
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

export default function DecidirSalida({
  id,
  unidad,
  conOrdenes,
  onDecidida,
  onCerrar,
}: {
  id: number;
  unidad: string;
  /** La persona tiene Órdenes de trabajo: se le puede ofrecer dejar una. */
  conOrdenes: boolean;
  onDecidida: () => void;
  onCerrar: () => void;
}) {
  const [detalle, setDetalle] = useState<Detalle | null>(null);
  const [motivo, setMotivo] = useState("");
  const [crearOrden, setCrearOrden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    let cancelado = false;
    pedir(String(id), "No se pudo abrir el checklist.")
      .then((d: Detalle) => {
        if (!cancelado) setDetalle(d);
      })
      .catch((e: Error) => {
        if (!cancelado) setError(e.message);
      });
    return () => {
      cancelado = true;
    };
  }, [id]);

  const decidir = async (autoriza: boolean) => {
    if (guardando) return;
    if (motivo.trim().length < 3) {
      setError("Escribe el motivo (al menos 3 letras): queda en el historial.");
      return;
    }
    setGuardando(true);
    setError(null);
    try {
      await pedir(`${id}/salida`, "No se pudo guardar la decisión.", "PATCH", {
        autoriza,
        motivo: motivo.trim(),
        crear_orden: autoriza && crearOrden,
      });
      onDecidida();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo guardar la decisión.");
      setGuardando(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center z-50 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Decidir la salida de ${unidad}`}
        className="bg-white w-full max-w-lg rounded-3xl shadow-2xl max-h-[90vh] overflow-y-auto"
      >
        <div className="p-6 border-b flex justify-between items-start gap-3">
          <div className="min-w-0">
            <h3 className="text-xl font-bold">¿Sale la unidad?</h3>
            <p className="text-sm text-slate-500 break-words">
              {unidad}
              {detalle ? ` · lo llenó ${detalle.usuario_nombre}` : ""}
            </p>
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
        <div className="p-6 space-y-4">
          {error && (
            <p role="alert" className="text-sm text-red-700 bg-red-50 rounded-lg p-3">
              {error}
            </p>
          )}
          {!detalle && !error && <p className="text-sm text-slate-500">Cargando...</p>}
          {detalle && (
            <>
              <section aria-label="Lo que falló" className="space-y-2">
                <span className="text-xs font-bold text-slate-500 uppercase">Lo que falló</span>
                <ul className="space-y-2">
                  {detalle.items
                    .filter((i) => i.estado === "malo")
                    .map((i) => (
                      <li key={i.id} className="bg-slate-50 rounded-xl p-3 text-sm text-slate-700">
                        <b>{i.descripcion}</b>
                        {i.observacion && <span className="block">{i.observacion}</span>}
                      </li>
                    ))}
                </ul>
              </section>
              <div className="space-y-1">
                <label
                  htmlFor="salida-motivo"
                  className="text-xs font-bold text-slate-500 uppercase"
                >
                  Motivo
                </label>
                <textarea
                  id="salida-motivo"
                  rows={2}
                  maxLength={300}
                  placeholder="Ej. La luz se cambia al volver; viaja de día"
                  className="w-full border border-slate-200 rounded-xl p-3 text-sm outline-none focus:ring-2 focus:ring-slate-900"
                  value={motivo}
                  onChange={(e) => {
                    setMotivo(e.target.value);
                    // El aviso de «falta el motivo» se va en cuanto se escribe.
                    setError(null);
                  }}
                />
              </div>
              {conOrdenes && (
                <label className="flex items-center gap-3 min-h-[44px] text-sm text-slate-700">
                  <input
                    type="checkbox"
                    className="w-5 h-5"
                    checked={crearOrden}
                    onChange={(e) => setCrearOrden(e.target.checked)}
                  />
                  Si sale, dejar una orden para atenderlo después
                </label>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button
                  type="button"
                  disabled={guardando}
                  onClick={() => decidir(false)}
                  className="min-h-[44px] rounded-2xl border border-red-200 bg-red-50 text-red-700 font-bold py-3 disabled:opacity-50"
                >
                  No autorizar
                </button>
                <button
                  type="button"
                  disabled={guardando}
                  onClick={() => decidir(true)}
                  className="min-h-[44px] rounded-2xl bg-slate-900 text-white font-bold py-3 hover:bg-slate-800 disabled:opacity-50"
                >
                  Autorizar salida
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
