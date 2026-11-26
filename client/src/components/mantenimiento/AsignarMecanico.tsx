// client/src/components/mantenimiento/AsignarMecanico.tsx
//
// La ventana «Asignar mecánico», como la maqueta: una fila por mecánico con lo que ya tiene, primero los de
// menos carga; se marca uno y abajo se activa «Asignar a …».
import { Check, Search, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { asignarMecanico, listarMecanicos } from "./mantenimientoApi";
import {
  cargaDelMecanico,
  mecanicosParaAsignar,
  unidadDeLaOrden,
  type DetalleDeOrdenEnOficina,
  type MecanicoConCarga,
} from "./ordenesMantenimiento";

const boton =
  "min-h-[44px] sm:min-h-10 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50";
const rejilla =
  "sm:grid sm:grid-cols-[1.5rem_minmax(0,1.4fr)_minmax(0,1.4fr)_9rem] sm:items-center";
const mensaje = (e: unknown) => (e instanceof Error ? e.message : "Error");

export default function AsignarMecanico({
  orden,
  onCerrar,
  onAsignado,
  onRechazo,
}: {
  orden: DetalleDeOrdenEnOficina;
  onCerrar: () => void;
  onAsignado: () => void;
  /** No se pudo asignar: la orden pudo cambiar (otra persona la cerró) y se relee. */
  onRechazo: () => void;
}) {
  const [lista, setLista] = useState<MecanicoConCarga[] | null>(null);
  const [texto, setTexto] = useState("");
  const [marcado, setMarcado] = useState<string | null>(orden.asignado_a);
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  const cargar = useCallback(() => {
    setError(null);
    listarMecanicos()
      .then(setLista)
      .catch((e: unknown) => setError(mensaje(e)));
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargar();
  }, [cargar]);

  useEffect(() => {
    const alTeclear = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onCerrar();
    };
    // En captura: se atiende antes que el panel de atrás.
    document.addEventListener("keydown", alTeclear, true);
    return () => document.removeEventListener("keydown", alTeclear, true);
  }, [onCerrar]);

  const guardar = (asignadoA: string | null) => {
    if (guardando) return;
    setGuardando(true);
    setError(null);
    asignarMecanico(orden.id, asignadoA)
      .then(onAsignado)
      .catch((e: unknown) => {
        setError(mensaje(e));
        setGuardando(false);
        // Sin señal no hay nada que releer: se conserva lo que ya se ve.
        if (navigator.onLine) onRechazo();
      });
  };

  const filas = mecanicosParaAsignar(lista ?? [], orden.id, texto);
  const elegido = lista?.find((m) => m.id === marcado && m.id !== orden.asignado_a);

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/50 p-3">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Asignar mecánico"
        className="flex max-h-[90vh] w-full max-w-[960px] flex-col rounded-2xl bg-white shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 p-5">
          <div className="min-w-0">
            <p className="break-words text-[10px] font-bold uppercase tracking-[0.13em] text-slate-500">
              OT #{orden.id} · {unidadDeLaOrden(orden)}
            </p>
            <h2 className="text-xl font-semibold text-slate-900">Asignar mecánico</h2>
            <p className="break-words text-sm text-slate-500">{orden.titulo}</p>
          </div>
          <button
            type="button"
            onClick={onCerrar}
            aria-label="Cerrar"
            className="grid min-h-[44px] min-w-[44px] place-items-center rounded-md text-slate-500 hover:bg-slate-100"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3 px-5 pt-4">
          <label className="relative min-w-0 flex-1">
            <span className="sr-only">Buscar mecánico</span>
            <Search size={16} className="absolute left-3 top-3 text-slate-400" />
            <input
              autoFocus
              value={texto}
              maxLength={80}
              onChange={(e) => setTexto(e.target.value)}
              placeholder="Buscar mecánico..."
              className="h-10 w-full rounded-lg border border-slate-300 pl-9 pr-3 text-sm outline-none focus:border-[#84cc16]"
            />
          </label>
          <span className="text-xs text-slate-500">
            {filas.length} {filas.length === 1 ? "mecánico" : "mecánicos"}
          </span>
        </div>

        {error && (
          <div role="alert" className="mx-5 mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">
            {error}
            {!lista && (
              <button type="button" onClick={cargar} className={`${boton} mt-2 block`}>
                Reintentar
              </button>
            )}
          </div>
        )}

        <div
          aria-hidden
          className={`mt-3 hidden gap-3 border-y border-slate-200 bg-slate-50 px-5 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-500 ${rejilla}`}
        >
          <span />
          <span>Mecánico</span>
          <span>Trabajando en</span>
          <span>Carga</span>
        </div>
        <ul className="min-h-24 flex-1 overflow-y-scroll border-b border-slate-200 max-sm:mt-3 max-sm:border-t">
          {filas.length === 0 && (
            <li className="p-6 text-center text-sm text-slate-500">
              {!lista
                ? error
                  ? ""
                  : "Cargando…"
                : lista.length === 0
                  ? "No hay personas activas con perfil Mecánico."
                  : "Ningún mecánico coincide"}
            </li>
          )}
          {filas.map((m) => {
            const activo = marcado === m.id;
            const n = m.ordenes.length;
            return (
              <li key={m.id}>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={activo}
                  onClick={() => setMarcado(activo ? null : m.id)}
                  className={`block w-full border-b border-slate-100 text-left text-sm ${
                    activo ? "bg-[#BADC1E]/20" : "hover:bg-slate-50"
                  }`}
                >
                  <span
                    className={`min-h-[52px] items-center gap-x-3 gap-y-1 px-5 py-2.5 max-sm:flex max-sm:flex-wrap ${rejilla}`}
                  >
                    <span
                      className={`grid h-5 w-5 shrink-0 place-items-center rounded border ${
                        activo ? "border-[#4d7c0f] bg-[#4d7c0f] text-white" : "border-slate-300"
                      }`}
                    >
                      {activo && <Check size={14} />}
                    </span>
                    <b className="min-w-0 break-words text-slate-900">{m.nombre}</b>
                    {/* En el celular, lo demás baja a un segundo renglón. */}
                    <span className="basis-full sm:hidden" />
                    <span
                      className="min-w-0 break-words text-xs text-slate-600 max-sm:ml-8"
                      title={m.ordenes.map((o) => `OT #${o.id} · ${o.titulo}`).join("\n")}
                    >
                      {n === 0
                        ? "Sin órdenes abiertas"
                        : `OT #${m.ordenes[0].id}${n > 1 ? ` +${n - 1} más` : ""}`}
                    </span>
                    <span
                      className={`justify-self-start whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-bold ${
                        n === 0
                          ? "bg-emerald-100 text-emerald-700"
                          : n === 1
                            ? "bg-blue-50 text-blue-700"
                            : "bg-amber-100 text-amber-700"
                      }`}
                    >
                      {cargaDelMecanico(n)}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        <div className="flex flex-wrap justify-end gap-2 p-4">
          {orden.asignado_a && (
            <button
              type="button"
              disabled={guardando}
              onClick={() => guardar(null)}
              className={`${boton} mr-auto`}
            >
              Quitar mecánico
            </button>
          )}
          <button type="button" onClick={onCerrar} className={boton}>
            Cancelar
          </button>
          <button
            type="button"
            disabled={!elegido || guardando}
            onClick={() => elegido && guardar(elegido.id)}
            className="min-h-[44px] sm:min-h-10 rounded-lg bg-[#BADC1E] px-4 text-sm font-semibold text-[#0A1014] hover:brightness-95 disabled:opacity-50"
          >
            {elegido ? `Asignar a ${elegido.nombre}` : "Marca un mecánico"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
