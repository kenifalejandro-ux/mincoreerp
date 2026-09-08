// client/src/components/combustible/CampanitaAlertas.tsx
//
// Campanita de alertas de combustible (hueco de talonario, vale anulado) --
// visible en el Header para gerencia (rol admin) con el módulo habilitado.
// Solo combustible por ahora (ver la decisión en el plan): si otro módulo
// necesita esto mañana, se replica el patrón, no se generaliza de entrada.

import { Bell } from "lucide-react";
import { useState } from "react";

import { esCritica } from "./gravedadAlertas";
import { useAlertasCombustibleStream } from "./useAlertasCombustibleStream";

const ETIQUETA_TIPO: Record<string, string> = {
  hueco_detectado: "Hueco de talonario",
  vale_anulado: "Vale anulado",
  sobredespacho: "Sobredespacho",
  despacho_tardio: "Despacho tardío",
  diferencia_recepcion: "Diferencia en recepción",
  nivel_bajo: "Nivel bajo de tanque",
  medidor_inconsistente: "Medidor inconsistente",
  descuadre_inventario: "Descuadre de inventario",
  descuadre_ciclo: "Descuadre del ciclo",
  tanque_sin_medir: "Tanque sin medir",
  vale_fuera_de_orden: "Vale fuera de orden",
  lectura_retroactiva: "Lectura fuera de orden",
  tope_diario_excedido: "Tope diario excedido",
};

/** No toda alerta es sobre un vale (migración 0073): las de nivel bajo van
 *  contra un tanque y las de diferencia contra una recepción. Cuando no hay
 *  vale se muestra solo el tipo, en vez de un "null-NaN". */
function formatearAlerta(alerta: {
  tipo: string;
  serie_talonario: string | null;
  n_vale: number | null;
  detalle: Record<string, unknown>;
}) {
  const etiqueta = ETIQUETA_TIPO[alerta.tipo] ?? alerta.tipo;

  if (alerta.serie_talonario !== null && alerta.n_vale !== null) {
    return `${etiqueta}: ${alerta.serie_talonario}-${String(alerta.n_vale).padStart(5, "0")}`;
  }
  if (typeof alerta.detalle.tanqueNombre === "string") {
    return `${etiqueta}: ${alerta.detalle.tanqueNombre}`;
  }
  return etiqueta;
}

interface CampanitaAlertasProps {
  activo: boolean;
  onIrACombustible?: () => void;
}

export default function CampanitaAlertas({ activo, onIrACombustible }: CampanitaAlertasProps) {
  const [abierta, setAbierta] = useState(false);
  const { alertas, noLeidas, marcarTodasLeidas, marcarUnaLeida } =
    useAlertasCombustibleStream(activo);

  /** La notificación es un PUNTERO al hallazgo, no el lugar donde se
   *  trabaja: lleva a la bandeja de alertas y deja al usuario parado sobre
   *  la fila. Ahí es donde se revisa y se cierra con motivo.
   *
   *  Es el patrón de los ERP grandes (el "My Inbox" de SAP Fiori y
   *  equivalentes): la campanita avisa, la bandeja dispone. Hacer la
   *  campanita más rica sería el camino equivocado -- los centros de
   *  notificaciones son célebres por terminar ignorados; lo que funciona es
   *  que lo crítico se convierta en una tarea que alguien tiene que
   *  despachar.
   *
   *  Marca leída SOLO esta: abrirla es verla. */
  const abrirAlerta = (alertaId: number) => {
    setAbierta(false);
    void marcarUnaLeida(alertaId);
    onIrACombustible?.();
    // El panel escucha por `window` -- ver el comentario en CombustiblePanel.
    window.dispatchEvent(new CustomEvent("combustible:abrir-alerta", { detail: { alertaId } }));
  };
  // Un contador solo no distingue "tres avisos de reposición" de "tres
  // sospechas de robo". El color del badge sí.
  const criticasSinLeer = alertas.filter((a) => esCritica(a.tipo)).length;

  if (!activo) return null;

  return (
    <div className="relative">
      <button
        onClick={() => setAbierta((v) => !v)}
        className="relative p-2 text-slate-400 hover:text-[#DDF500] hover:bg-white/5 rounded-md transition-all"
        title="Alertas de combustible"
      >
        <Bell size={18} className={criticasSinLeer > 0 ? "animate-pulse" : undefined} />
        {noLeidas > 0 && (
          <span
            className={
              "absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full text-white text-[10px] font-bold flex items-center justify-center " +
              (criticasSinLeer > 0 ? "bg-red-600 ring-2 ring-red-300" : "bg-slate-500")
            }
          >
            {noLeidas > 99 ? "99+" : noLeidas}
          </span>
        )}
      </button>

      {abierta && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setAbierta(false)} />
          <div className="absolute right-0 mt-2 w-80 bg-white rounded-2xl shadow-2xl border border-slate-200 z-50 overflow-hidden">
            <div className="p-3 border-b border-slate-100 flex items-center justify-between">
              <span className="text-sm font-bold text-slate-800">Alertas de combustible</span>
              {noLeidas > 0 && (
                <button
                  onClick={() => marcarTodasLeidas()}
                  className="text-xs text-slate-500 hover:text-slate-900 hover:underline"
                >
                  Marcar todas leídas
                </button>
              )}
            </div>

            <div className="max-h-80 overflow-y-auto">
              {alertas.length === 0 ? (
                <p className="p-4 text-sm text-slate-400 text-center">Sin alertas pendientes</p>
              ) : (
                [...alertas]
                  .sort((x, y) => Number(esCritica(y.tipo)) - Number(esCritica(x.tipo)))
                  .map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => abrirAlerta(a.id)}
                      title="Ver en la bandeja de alertas"
                      className={
                        "w-full text-left cursor-pointer hover:bg-slate-100/70 transition-colors " +
                        (esCritica(a.tipo)
                          ? "p-3 border-b border-slate-50 last:border-0 border-l-4 border-l-red-500 bg-red-50/40"
                          : "p-3 border-b border-slate-50 last:border-0 border-l-4 border-l-transparent")
                      }
                    >
                      {esCritica(a.tipo) && (
                        <p className="text-[10px] font-bold text-red-600 uppercase tracking-wide">
                          Requiere revisión
                        </p>
                      )}
                      <p className="text-sm font-semibold text-slate-800">{formatearAlerta(a)}</p>
                      {a.tipo === "vale_anulado" && typeof a.detalle.motivo === "string" && (
                        <p className="text-xs text-slate-500 mt-0.5">Motivo: {a.detalle.motivo}</p>
                      )}
                      <p className="text-[10px] text-slate-400 mt-1">
                        {new Date(a.creado_en).toLocaleString("es-PE")}
                      </p>
                    </button>
                  ))
              )}
            </div>

            {onIrACombustible && (
              <button
                onClick={() => {
                  setAbierta(false);
                  onIrACombustible();
                }}
                className="w-full p-3 text-xs font-semibold text-center text-slate-600 hover:bg-slate-50 border-t border-slate-100"
              >
                Ver todas en Combustible
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
