import { useCallback, useEffect, useState } from "react";

import {
  diferenciaDeLaRecepcion,
  estadoDeRecepcion,
  ETIQUETA_ESTADO_RECEPCION,
  filtrarRecepciones,
  finDelDiaLima,
  inicioDelDiaLima,
  totalEntregadoDeLaRecepcion,
  type EstadoDeRecepcion,
  type FiltroDeEstadoRecepcion,
  type RecepcionDeLista,
} from "./recepcionesCisternaLogica";
import { apiFetch } from "../../services/apiClient";
import { mensajeDeError } from "../../utils/mensajeDeError";

// La vista "Recepciones" de Cisternas: las descargas de combustible, también las anuladas, con lo que
// dijo el documento contra lo que se descargó. Validar y anular siguen en "Validar recepciones".

const CHIP: Record<EstadoDeRecepcion, string> = {
  anulada: "border-red-500/50 text-red-400",
  validada: "border-[#65a30d]/70 text-[#bef264]",
  por_validar: "border-amber-400/60 text-amber-300",
  registrada: "border-[#334155] text-[#94a3b8]",
};

const CAMPO =
  "bg-[#0D1719] border border-[#334155] rounded px-3 py-2 text-sm font-semibold text-white";

const DOCUMENTO: Record<string, string> = { factura: "Factura", guia_remision: "Guía" };

const aFechaLocal = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(d);

export default function RecepcionesCisterna({ onCambio = () => {} }: { onCambio?: () => void }) {
  const [desde, setDesde] = useState(() => aFechaLocal(new Date(Date.now() - 30 * 86_400_000)));
  const [hasta, setHasta] = useState(() => aFechaLocal(new Date()));
  const [estado, setEstado] = useState<FiltroDeEstadoRecepcion>("todas");
  const [recepciones, setRecepciones] = useState<RecepcionDeLista[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [anulando, setAnulando] = useState<RecepcionDeLista | null>(null);
  const [motivo, setMotivo] = useState("");
  const [enviando, setEnviando] = useState(false);

  const cargar = useCallback(async () => {
    try {
      const params = new URLSearchParams({ producto: "combustible", pageSize: "200" });
      if (desde) params.set("desde", inicioDelDiaLima(desde));
      if (hasta) params.set("hasta", finDelDiaLima(hasta));
      const res = await apiFetch(`/api/erp/combustible/recepciones?${params}`);
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError("No se pudieron cargar las recepciones.");
        return;
      }
      setError(null);
      setRecepciones(Array.isArray(body?.data) ? body.data : []);
    } catch {
      setError("Sin señal: no se pudo actualizar.");
    }
  }, [desde, hasta]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void cargar();
  }, [cargar]);

  // Anular pide el motivo (es lo que distingue un error de tipeo de borrar un número que no
  // conviene). El servidor devuelve su propio aviso si la recepción ya tiene salidas de cisterna.
  const anular = async () => {
    if (!anulando || motivo.trim() === "" || enviando) return;
    setEnviando(true);
    try {
      const res = await apiFetch(`/api/erp/combustible/recepciones/${anulando.id}/anular`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ motivo: motivo.trim() }),
      });
      if (!res.ok) {
        setError(
          mensajeDeError(await res.json().catch(() => ({})), "No se pudo anular la recepción.")
        );
        setAnulando(null);
        return;
      }
      setAnulando(null);
      setMotivo("");
      // El costo promedio del tanque se recalculó sin esta fila.
      await cargar();
      onCambio();
    } finally {
      setEnviando(false);
    }
  };

  const visibles = recepciones ? filtrarRecepciones(recepciones, estado) : [];

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <label
            htmlFor="recepciones-desde"
            className="block text-[10px] text-[#94a3b8] font-bold uppercase"
          >
            Desde
          </label>
          <input
            id="recepciones-desde"
            type="date"
            className={CAMPO}
            value={desde}
            onChange={(e) => setDesde(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <label
            htmlFor="recepciones-hasta"
            className="block text-[10px] text-[#94a3b8] font-bold uppercase"
          >
            Hasta
          </label>
          <input
            id="recepciones-hasta"
            type="date"
            className={CAMPO}
            value={hasta}
            onChange={(e) => setHasta(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <label
            htmlFor="recepciones-estado"
            className="block text-[10px] text-[#94a3b8] font-bold uppercase"
          >
            Estado
          </label>
          <select
            id="recepciones-estado"
            className={CAMPO}
            value={estado}
            onChange={(e) => setEstado(e.target.value as FiltroDeEstadoRecepcion)}
          >
            <option value="todas">Todas</option>
            <option value="registrada">Registradas</option>
            <option value="por_validar">Por validar</option>
            <option value="validada">Validadas</option>
            <option value="anulada">Anuladas</option>
          </select>
        </div>
      </div>
      {error && (
        <p role="alert" className="mb-4 text-sm font-medium text-amber-300">
          {error}
        </p>
      )}
      {recepciones === null ? (
        !error && <p className="text-sm text-[#94a3b8]">Cargando recepciones...</p>
      ) : visibles.length === 0 ? (
        <div className="bg-[#192526] border border-dashed border-[#334155] rounded-xl p-10 text-center text-[#94a3b8]">
          No hay recepciones en este período con ese estado.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3">
          {visibles.map((r) => {
            const st = estadoDeRecepcion(r);
            const dif = diferenciaDeLaRecepcion(r);
            const unidad = r.tanque_unidad ?? "gal";
            return (
              <article
                key={r.id}
                aria-label={`Recepción ${r.id}`}
                className="bg-[#192526] border border-[#2a2e37] rounded-lg p-4 flex flex-col gap-2"
              >
                <header className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="text-base font-bold text-white">{r.grifo_nombre}</h3>
                  <span
                    className={`text-[11px] font-bold uppercase border rounded-full px-2 py-0.5 ${CHIP[st]}`}
                  >
                    {ETIQUETA_ESTADO_RECEPCION[st]}
                  </span>
                </header>
                <dl className="grid grid-cols-2 lg:grid-cols-5 gap-x-4 gap-y-2 text-xs">
                  <div>
                    <dt className="text-[10px] text-[#94a3b8] font-bold uppercase">Recepción</dt>
                    <dd className="text-[#e2e8f0]">
                      #{r.id} · {new Date(r.recibido_en).toLocaleString("es-PE")}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[10px] text-[#94a3b8] font-bold uppercase">Documento</dt>
                    <dd className="text-[#e2e8f0]">
                      {r.numero_documento
                        ? `${DOCUMENTO[r.tipo_documento ?? ""] ?? "Doc."} ${r.numero_documento}`
                        : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[10px] text-[#94a3b8] font-bold uppercase">Tanque</dt>
                    <dd className="text-[#e2e8f0]">{r.tanque_nombre ?? "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-[10px] text-[#94a3b8] font-bold uppercase">Descargado</dt>
                    <dd className="font-mono text-[#e2e8f0]">
                      {totalEntregadoDeLaRecepcion(r).toLocaleString("es-PE", {
                        maximumFractionDigits: 3,
                      })}{" "}
                      {unidad}
                    </dd>
                    {Number(r.cantidad_derivada) > 0 && (
                      <dd className="text-[10px] text-[#94a3b8]">
                        {Number(r.cantidad).toLocaleString("es-PE", { maximumFractionDigits: 3 })}{" "}
                        al tanque ·{" "}
                        {Number(r.cantidad_derivada).toLocaleString("es-PE", {
                          maximumFractionDigits: 3,
                        })}{" "}
                        de sobrante
                      </dd>
                    )}
                  </div>
                  <div>
                    <dt className="text-[10px] text-[#94a3b8] font-bold uppercase">
                      Contra el documento
                    </dt>
                    <dd
                      className={
                        dif?.fuera ? "font-semibold text-red-400" : "font-mono text-[#e2e8f0]"
                      }
                    >
                      {dif ? dif.texto : "sin compra"}
                    </dd>
                  </div>
                </dl>
                {st !== "anulada" && (
                  <div>
                    <button
                      type="button"
                      onClick={() => {
                        setAnulando(r);
                        setMotivo("");
                      }}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-red-500/50 text-red-400 hover:bg-red-500/10 active:scale-95"
                    >
                      Anular
                    </button>
                  </div>
                )}
                {st === "anulada" && (
                  <p className="text-xs text-red-400">
                    Anulada{r.anulada_por_nombre ? ` por ${r.anulada_por_nombre}` : ""}
                    {r.motivo_anulacion ? `: ${r.motivo_anulacion}` : ""}
                  </p>
                )}
              </article>
            );
          })}
        </div>
      )}
      {anulando && (
        <div className="fixed inset-0 bg-[#0D1719]/90 backdrop-blur-sm flex justify-center items-center z-[60] p-4">
          <div className="bg-white w-full max-w-md rounded-3xl shadow-2xl p-6 space-y-3">
            <h3 className="text-lg font-bold">Anular la recepción #{anulando.id}</h3>
            <p className="text-sm text-slate-600">
              Queda anulada con su motivo; no se borra. El costo promedio del tanque se recalcula
              sin ella.
            </p>
            <label
              htmlFor="recepcion-anular-motivo"
              className="text-xs font-bold text-slate-700 uppercase"
            >
              Motivo
            </label>
            <textarea
              id="recepcion-anular-motivo"
              rows={3}
              maxLength={500}
              className="w-full border border-slate-200 rounded-xl p-3 text-sm"
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setAnulando(null)}
                className="px-4 py-2 rounded-lg text-sm font-semibold border border-slate-200 text-slate-700 hover:bg-slate-50"
              >
                Volver
              </button>
              <button
                type="button"
                disabled={motivo.trim() === "" || enviando}
                onClick={() => void anular()}
                className="px-4 py-2 rounded-lg text-sm font-semibold bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
              >
                Anular recepción
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
