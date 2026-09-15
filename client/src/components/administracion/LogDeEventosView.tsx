// client/src/components/administracion/LogDeEventosView.tsx
//
// "Administración → Log de eventos": todo lo que hace la gente de la empresa,
// filtrable por fecha. Es la pantalla que Kenif señaló del telebanking de su
// banco.
//
// Los eventos salen de la bitácora que el ERP ya escribía en cada mutación
// (ver bitacoraTenant.service.ts) — lo que faltaba era que la empresa pudiera
// leerla, no empezar a registrar cosas nuevas.
import { useCallback, useEffect, useState } from "react";

import {
  accionesDeBitacoraApi,
  listarEventosApi,
  type EventoDeBitacora,
} from "../../services/administracionApi";

/** El nombre técnico de la acción no le dice nada a quien administra su
 *  empresa. Lo que se muestra es el verbo, y el nombre crudo queda al lado en
 *  chico: si alguien pregunta por un evento puntual, ese es el dato que sirve
 *  para buscarlo. */
function enCastellano(accion: string): string {
  const texto = accion.replace(/[._]/g, " ");
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

function fechaLegible(iso: string): string {
  return new Date(iso).toLocaleString("es-PE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function LogDeEventosView() {
  const [eventos, setEventos] = useState<EventoDeBitacora[]>([]);
  const [acciones, setAcciones] = useState<string[]>([]);
  const [siguiente, setSiguiente] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [accion, setAccion] = useState("");
  const [detalleAbierto, setDetalleAbierto] = useState<string | null>(null);

  const buscar = useCallback(
    async (opciones: { antesDe?: string } = {}) => {
      setCargando(true);
      setError(null);
      try {
        const pagina = await listarEventosApi({
          desde: desde || undefined,
          hasta: hasta || undefined,
          accion: accion || undefined,
          antesDe: opciones.antesDe,
        });
        // Con cursor se agrega; sin cursor es una búsqueda nueva y reemplaza.
        setEventos((previos) =>
          opciones.antesDe ? [...previos, ...pagina.eventos] : pagina.eventos
        );
        setSiguiente(pagina.siguiente);
      } catch (err) {
        setError(err instanceof Error ? err.message : "No se pudo cargar el log.");
      } finally {
        setCargando(false);
      }
    },
    [desde, hasta, accion]
  );

  // La primera carga no pasa por `buscar()` a propósito: esa función arranca
  // poniendo `cargando` en true, y hacerlo dentro de un efecto de montaje es
  // una cascada de renders para nada (el estado ya arranca en true). Después
  // de montar, las búsquedas salen del botón.
  useEffect(() => {
    let cancelado = false;
    listarEventosApi({})
      .then((pagina) => {
        if (cancelado) return;
        setEventos(pagina.eventos);
        setSiguiente(pagina.siguiente);
      })
      .catch((err) => {
        if (!cancelado) setError(err instanceof Error ? err.message : "No se pudo cargar el log.");
      })
      .finally(() => {
        if (!cancelado) setCargando(false);
      });
    return () => {
      cancelado = true;
    };
  }, []);

  useEffect(() => {
    let cancelado = false;
    accionesDeBitacoraApi()
      .then((lista) => {
        if (!cancelado) setAcciones(lista);
      })
      // Sin la lista de acciones el filtro queda en "Todas", que igual sirve.
      .catch(() => {});
    return () => {
      cancelado = true;
    };
  }, []);

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-xl font-bold text-slate-800">Log de eventos</h2>
        <p className="text-slate-600 text-sm">
          Todo lo que se hizo en el sistema, quién lo hizo y cuándo.
        </p>
      </div>

      <div className="bg-white border border-slate-200 rounded-3xl p-4 shadow-sm mb-6 flex flex-wrap items-end gap-3">
        <div>
          <label
            htmlFor="log-desde"
            className="block text-xs font-bold text-slate-600 uppercase mb-1"
          >
            Desde
          </label>
          <input
            id="log-desde"
            type="date"
            className="border border-slate-200 rounded-xl px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-900"
            value={desde}
            onChange={(e) => setDesde(e.target.value)}
          />
        </div>
        <div>
          <label
            htmlFor="log-hasta"
            className="block text-xs font-bold text-slate-600 uppercase mb-1"
          >
            Hasta
          </label>
          <input
            id="log-hasta"
            type="date"
            className="border border-slate-200 rounded-xl px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-900"
            value={hasta}
            onChange={(e) => setHasta(e.target.value)}
          />
        </div>
        <div className="min-w-[12rem]">
          <label
            htmlFor="log-accion"
            className="block text-xs font-bold text-slate-600 uppercase mb-1"
          >
            Acción
          </label>
          <select
            id="log-accion"
            className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-900 bg-white"
            value={accion}
            onChange={(e) => setAccion(e.target.value)}
          >
            <option value="">Todas</option>
            {acciones.map((a) => (
              <option key={a} value={a}>
                {enCastellano(a)}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          onClick={() => void buscar()}
          disabled={cargando}
          className="px-6 py-2.5 bg-slate-900 hover:bg-slate-800 text-white text-sm font-bold rounded-xl disabled:opacity-50"
        >
          {cargando ? "Buscando..." : "Buscar"}
        </button>
      </div>

      {error && (
        <p className="mb-4 text-sm font-semibold text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-3">
          {error}
        </p>
      )}

      <div className="bg-white border border-slate-200 rounded-3xl overflow-x-auto shadow-sm">
        <table className="w-full text-left border-collapse">
          <thead className="bg-slate-50">
            <tr>
              <th className="p-4 text-xs font-bold text-slate-500 uppercase tracking-widest">
                cuándo
              </th>
              <th className="p-4 text-xs font-bold text-slate-500 uppercase tracking-widest">
                quién
              </th>
              <th className="p-4 text-xs font-bold text-slate-500 uppercase tracking-widest">
                qué hizo
              </th>
              <th className="p-4 text-xs font-bold text-slate-500 uppercase tracking-widest">
                sobre quién
              </th>
              <th className="p-4 text-xs font-bold text-slate-500 uppercase tracking-widest text-right">
                detalle
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {eventos.map((evento) => (
              <tr key={evento.id} className="hover:bg-slate-50/50 align-top">
                <td className="p-4 text-sm text-slate-600 whitespace-nowrap">
                  {fechaLegible(evento.creadoEn)}
                </td>
                <td className="p-4 text-sm text-slate-800">
                  {evento.actor}
                  {evento.actorTipo === "platform_admin" && (
                    <span className="ml-2 px-2 py-0.5 rounded-full bg-slate-100 text-[11px] font-bold text-slate-600 uppercase">
                      MinCore
                    </span>
                  )}
                </td>
                <td className="p-4 text-sm">
                  <span className="font-semibold text-slate-800">
                    {enCastellano(evento.accion)}
                  </span>
                  <span className="block text-[11px] font-mono text-slate-400">
                    {evento.accion}
                  </span>
                  {evento.resultado !== "success" && (
                    <span className="inline-block mt-1 px-2 py-0.5 rounded-full bg-red-50 text-[11px] font-bold text-red-700 uppercase">
                      Falló
                    </span>
                  )}
                </td>
                <td className="p-4 text-sm text-slate-600">{evento.usuarioNombre ?? "—"}</td>
                <td className="p-4 text-right">
                  {evento.detalle && (
                    <button
                      type="button"
                      onClick={() =>
                        setDetalleAbierto(detalleAbierto === evento.id ? null : evento.id)
                      }
                      className="px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-100 rounded-lg"
                    >
                      {detalleAbierto === evento.id ? "Ocultar" : "Ver"}
                    </button>
                  )}
                </td>
              </tr>
            ))}

            {eventos
              .filter((evento) => evento.id === detalleAbierto && evento.detalle)
              .map((evento) => (
                <tr key={`${evento.id}-detalle`} className="bg-slate-50">
                  <td colSpan={5} className="p-4">
                    <pre className="text-xs text-slate-700 overflow-x-auto whitespace-pre-wrap">
                      {JSON.stringify(evento.detalle, null, 2)}
                    </pre>
                  </td>
                </tr>
              ))}

            {eventos.length === 0 && !cargando && (
              <tr>
                <td colSpan={5} className="p-10 text-center text-sm text-slate-500">
                  No hay eventos en ese rango.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {siguiente && (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            onClick={() => void buscar({ antesDe: siguiente })}
            disabled={cargando}
            className="px-6 py-2.5 border border-slate-200 bg-white hover:bg-slate-50 text-sm font-bold text-slate-700 rounded-xl disabled:opacity-50"
          >
            Ver más
          </button>
        </div>
      )}
    </div>
  );
}
