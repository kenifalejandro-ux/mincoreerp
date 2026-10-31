// client/src/components/combustible/HistorialCargasTanqueta.tsx
//
// El historial de "Carga desde tanqueta" del conductor: los vales que ÉL sacó
// de una tanqueta. Vive en la pantalla Tanques; las compras a un proveedor
// externo tienen su propio historial en Compra en ruta (HistorialComprasRuta).
//
// El servidor ya lo acota al conductor (GET /despachos?origen=tanqueta devuelve
// solo lo que registró él), así que acá no se filtra por persona.
import { useCallback, useEffect, useRef, useState } from "react";

import PendientesDeEnvio from "./PendientesDeEnvio";
import { suscribirseASincronizacion } from "../../offline/offlineSync";
import { apiFetch } from "../../services/apiClient";
import { mensajeDeError } from "../../utils/mensajeDeError";

interface Carga {
  id: number;
  despachado_en: string;
  serie_talonario: string | null;
  n_vale: number | null;
  equipo_id: number | null;
  tanqueta_codigo: string | null;
  tanqueta_lugar: "planta" | "ruta" | null;
  tipo_combustible: string | null;
  cantidad: number | string;
  anulada_en: string | null;
  placa_codigo: string | null;
}

/** Lo máximo que se pide de una vez: más allá, el conductor acota con fechas. */
const TOPE_CARGAS = 200;

const ETIQUETA_COMBUSTIBLE: Record<string, string> = {
  diesel_b5: "Diésel B5",
  gasolina_90: "Gasolina 90",
  glp: "GLP",
};

const CLASE_TH = "p-3 text-xs font-bold uppercase tracking-widest text-slate-400";

export default function HistorialCargasTanqueta() {
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [cargas, setCargas] = useState<Carga[]>([]);
  const [total, setTotal] = useState(0);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Una consulta lenta no debe pisar a la que el conductor pidió después.
  const pedido = useRef(0);
  // El período que muestran los campos: un refresco automático (evento o cola
  // sincronizada) vuelve a pedir ESE período, no todo.
  const periodo = useRef({ desde: "", hasta: "" });

  const cargar = useCallback(async (d: string, h: string) => {
    const mio = ++pedido.current;
    setCargando(true);
    setError(null);
    try {
      const params = new URLSearchParams({ origen: "tanqueta", pageSize: String(TOPE_CARGAS) });
      if (d) params.set("desde", new Date(`${d}T00:00:00`).toISOString());
      if (h) params.set("hasta", new Date(`${h}T23:59:59.999`).toISOString());
      const res = await apiFetch(`/api/erp/combustible/despachos?${params.toString()}`);
      const cuerpo = await res.json().catch(() => null);
      if (mio !== pedido.current) return;
      if (!res.ok) {
        setError(mensajeDeError(cuerpo, "No se pudo cargar el historial de cargas."));
        setCargas([]);
        return;
      }
      setCargas(Array.isArray(cuerpo?.data) ? cuerpo.data : []);
      setTotal(Number(cuerpo?.pagination?.total) || 0);
    } catch {
      if (mio !== pedido.current) return;
      setError("Sin conexión: no se pudo cargar el historial. Vuelve a intentarlo con señal.");
      setCargas([]);
    } finally {
      if (mio === pedido.current) setCargando(false);
    }
  }, []);

  useEffect(() => {
    // Patrón estándar de carga al montar -- ver IpercView.tsx.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void cargar("", "");
    // Una carga nueva refresca la lista sola, en el período que se está viendo.
    const alCambiar = () => void cargar(periodo.current.desde, periodo.current.hasta);
    window.addEventListener("combustible:actualizado", alCambiar);
    // Y la que estaba guardada sin señal, apenas la cola la envía: sin esto el
    // aviso de pendientes desaparece y la fila no aparece hasta Consultar.
    const desuscribir = suscribirseASincronizacion(({ sincronizadas }) => {
      if (sincronizadas > 0) alCambiar();
    });
    return () => {
      window.removeEventListener("combustible:actualizado", alCambiar);
      desuscribir();
    };
  }, [cargar]);

  const consultar = () => {
    periodo.current = { desde, hasta };
    void cargar(desde, hasta);
  };

  return (
    <section className="rounded-2xl border border-slate-200 bg-white">
      <div className="flex flex-wrap items-end gap-3 border-b border-slate-200 p-4">
        <label className="flex flex-col gap-1 text-xs font-bold uppercase text-slate-700">
          Desde
          <input
            id="cargas-tanqueta-desde"
            type="date"
            value={desde}
            onChange={(e) => setDesde(e.target.value)}
            className="rounded-xl border border-slate-200 px-3 py-2 text-sm font-normal normal-case"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-bold uppercase text-slate-700">
          Hasta
          <input
            id="cargas-tanqueta-hasta"
            type="date"
            value={hasta}
            onChange={(e) => setHasta(e.target.value)}
            className="rounded-xl border border-slate-200 px-3 py-2 text-sm font-normal normal-case"
          />
        </label>
        <button
          type="button"
          onClick={consultar}
          disabled={cargando}
          className="rounded-xl border border-[#BADC1E] bg-[#BADC1E] px-4 py-2 text-sm font-semibold text-[#0A1014] hover:brightness-105 disabled:opacity-50"
        >
          Consultar
        </button>
        <span className="ml-auto text-xs text-slate-500">
          {cargas.length} {cargas.length === 1 ? "carga" : "cargas"}
        </span>
      </div>

      <PendientesDeEnvio ambito="tanqueta" />

      {total > cargas.length && (
        <p role="status" className="m-4 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Se muestran las {cargas.length} más recientes de {total}. Usa Desde y Hasta para ver las
          anteriores.
        </p>
      )}

      {error && (
        <p role="alert" className="m-4 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="overflow-x-auto">
        {cargando ? (
          <p className="py-10 text-center text-sm text-slate-500">Cargando historial...</p>
        ) : cargas.length === 0 ? (
          <p className="py-10 text-center text-sm text-slate-500">
            Todavía no hay cargas desde tanqueta registradas.
          </p>
        ) : (
          <table className="w-full min-w-max border-collapse text-left">
            <thead>
              <tr>
                <th className={CLASE_TH}>Vale</th>
                <th className={CLASE_TH}>Fecha</th>
                <th className={CLASE_TH}>Tanqueta</th>
                <th className={CLASE_TH}>Unidad</th>
                <th className={`${CLASE_TH} text-right`}>Cantidad</th>
                <th className={`${CLASE_TH} text-right`}>Estado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {cargas.map((c) => (
                <tr key={c.id} className="align-top hover:bg-slate-50/50">
                  <td className="p-3 font-mono text-sm text-slate-800">
                    {c.serie_talonario && c.n_vale !== null
                      ? `${c.serie_talonario}-${c.n_vale}`
                      : "—"}
                  </td>
                  <td className="whitespace-nowrap p-3 text-sm text-slate-600">
                    {new Date(c.despachado_en).toLocaleString("es-PE", {
                      dateStyle: "short",
                      timeStyle: "short",
                    })}
                  </td>
                  <td className="p-3 text-sm text-slate-700">
                    {c.tanqueta_codigo ?? "—"}
                    {c.tanqueta_lugar && (
                      <span className="block text-xs text-slate-400">
                        {c.tanqueta_lugar === "planta" ? "En planta" : "En ruta"}
                      </span>
                    )}
                  </td>
                  <td className="p-3 text-sm text-slate-700">{c.placa_codigo ?? "—"}</td>
                  <td className="whitespace-nowrap p-3 text-right text-sm tabular-nums text-slate-800">
                    {Number(c.cantidad).toLocaleString("es-PE")} gal
                    {c.tipo_combustible && (
                      <span className="block text-xs text-slate-400">
                        {ETIQUETA_COMBUSTIBLE[c.tipo_combustible] ?? "Combustible"}
                      </span>
                    )}
                  </td>
                  <td className="p-3 text-right text-sm">
                    {c.anulada_en ? (
                      <span className="text-xs text-red-400">Anulado</span>
                    ) : (
                      <span className="text-xs text-slate-500">Registrado</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
