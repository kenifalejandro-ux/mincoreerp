import { useCallback, useEffect, useRef, useState } from "react";

import {
  diasParaLaLlegada,
  ETIQUETA_COMBUSTIBLE,
  ETIQUETA_DOCUMENTO,
  ETIQUETA_ESTADO,
  filtrarCompras,
  hoyEnLima,
  proveedoresDeCompras,
  type FiltroDeEstado,
} from "./comprasCisternaLogica";
import type { CompraDeCisterna, EstadoDeCompra } from "./comprasCisternaTipos";
import { apiFetch } from "../../services/apiClient";
import { mensajeDeError } from "../../utils/mensajeDeError";

// La vista "Compras" de Cisternas: lo que la encargada compró y todavía viene en camino (o ya se
// descargó), con "Registrar compra", habilitarla a la cancha antes del día, anularla y la tolerancia
// que se acepta entre lo que dice el documento y lo que se descarga. Lo ve quien gestiona compras.

const formatear = (n: number) => n.toLocaleString("es-PE", { maximumFractionDigits: 3 });

const CHIP: Record<EstadoDeCompra, string> = {
  registrada: "border-[#334155] text-[#94a3b8]",
  por_llegar: "border-cyan-400/60 text-cyan-300",
  recibida: "border-[#65a30d]/70 text-[#bef264]",
  anulada: "border-red-500/50 text-red-400",
};

// Lo que cambia una compra o su estado (recibirla o anular su recepción): se vuelve a pedir.
const EVENTOS = [
  "combustible.compra_cisterna_actualizada",
  "combustible.recepcion_creada",
  "combustible.recepcion_anulada",
];

const BOTON =
  "px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all active:scale-95 disabled:opacity-50";
const CAMPO_FILTRO =
  "bg-[#0D1719] border border-[#334155] rounded px-3 py-2 text-sm font-semibold text-white";

export default function ComprasCisterna({
  puedeFijarTolerancia,
}: {
  puedeFijarTolerancia: boolean;
}) {
  const [compras, setCompras] = useState<CompraDeCisterna[] | null>(null);
  const [tolerancia, setTolerancia] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [mensaje, setMensaje] = useState<string | null>(null);
  const [estado, setEstado] = useState<FiltroDeEstado>("pendientes");
  const [proveedor, setProveedor] = useState("");
  const [anulando, setAnulando] = useState<CompraDeCisterna | null>(null);
  const [motivo, setMotivo] = useState("");
  const [trabajando, setTrabajando] = useState<string | null>(null);
  // Una respuesta vieja no pisa a la nueva.
  const ultimaCarga = useRef(0);

  const cargar = useCallback(async () => {
    const n = ++ultimaCarga.current;
    try {
      const [rc, rt] = await Promise.all([
        apiFetch("/api/erp/combustible/compras-cisterna"),
        apiFetch("/api/erp/combustible/compras-cisterna/tolerancia"),
      ]);
      if (n !== ultimaCarga.current) return;
      const [bc, bt] = await Promise.all([
        rc.json().catch(() => null),
        rt.json().catch(() => null),
      ]);
      if (rc.ok && Array.isArray(bc)) setCompras(bc as CompraDeCisterna[]);
      if (rt.ok && bt) setTolerancia(String(bt.tolerancia_galones));
      setError(rc.ok && rt.ok ? null : "No se pudieron cargar las compras.");
    } catch {
      if (n === ultimaCarga.current) setError("Sin señal: no se pudo actualizar.");
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void cargar();
  }, [cargar]);

  // Tiempo real: si alguien más registra, habilita o descarga, la lista se vuelve a pedir.
  useEffect(() => {
    let temporizador: number | undefined;
    const refrescar = () => {
      if (temporizador !== undefined) window.clearTimeout(temporizador);
      temporizador = window.setTimeout(() => void cargar(), 100);
    };
    const es = new EventSource("/api/eventos/stream", { withCredentials: true });
    EVENTOS.forEach((tipo) => es.addEventListener(tipo, refrescar));
    es.addEventListener("open", refrescar);
    window.addEventListener("online", refrescar);
    return () => {
      if (temporizador !== undefined) window.clearTimeout(temporizador);
      es.close();
      window.removeEventListener("online", refrescar);
    };
  }, [cargar]);

  const habilitar = async (c: CompraDeCisterna) => {
    setTrabajando(c.id);
    setError(null);
    try {
      const res = await apiFetch(`/api/erp/combustible/compras-cisterna/${c.id}/habilitar`, {
        method: "PATCH",
      });
      if (!res.ok) {
        setError(mensajeDeError(await res.json().catch(() => ({})), "No se pudo habilitar."));
        return;
      }
      setMensaje(`La compra ${c.numero_documento} ya la ve la cancha.`);
      await cargar();
    } finally {
      setTrabajando(null);
    }
  };

  const anular = async () => {
    if (!anulando || motivo.trim() === "") return;
    setTrabajando(anulando.id);
    setError(null);
    try {
      const res = await apiFetch(`/api/erp/combustible/compras-cisterna/${anulando.id}/anular`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ motivo: motivo.trim() }),
      });
      if (!res.ok) {
        setError(mensajeDeError(await res.json().catch(() => ({})), "No se pudo anular."));
        return;
      }
      setMensaje(`Compra ${anulando.numero_documento} anulada.`);
      setAnulando(null);
      setMotivo("");
      await cargar();
    } finally {
      setTrabajando(null);
    }
  };

  const guardarTolerancia = async () => {
    const galones = Number(tolerancia);
    if (!Number.isFinite(galones) || galones < 0) return;
    const res = await apiFetch("/api/erp/combustible/compras-cisterna/tolerancia", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tolerancia_galones: galones }),
    });
    if (!res.ok) {
      setError(mensajeDeError(await res.json().catch(() => ({})), "No se pudo guardar."));
      return;
    }
    setError(null);
    setMensaje(`Tolerancia fijada en ${formatear(galones)} gal.`);
  };

  const hoy = hoyEnLima();
  const visibles = compras ? filtrarCompras(compras, estado, proveedor) : [];
  const proveedores = proveedoresDeCompras(compras ?? []);
  const proveedorVigente = proveedores.some((p) => p.valor === proveedor) ? proveedor : "";

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <label
            htmlFor="compras-filtro-estado"
            className="block text-[10px] text-[#94a3b8] font-bold uppercase"
          >
            Estado
          </label>
          <select
            id="compras-filtro-estado"
            className={CAMPO_FILTRO}
            value={estado}
            onChange={(e) => setEstado(e.target.value as FiltroDeEstado)}
          >
            <option value="pendientes">Por recibir</option>
            <option value="recibidas">Recibidas</option>
            <option value="anuladas">Anuladas</option>
            <option value="todas">Todas</option>
          </select>
        </div>
        <div className="space-y-1">
          <label
            htmlFor="compras-filtro-proveedor"
            className="block text-[10px] text-[#94a3b8] font-bold uppercase"
          >
            Proveedor
          </label>
          <select
            id="compras-filtro-proveedor"
            className={CAMPO_FILTRO}
            value={proveedorVigente}
            onChange={(e) => setProveedor(e.target.value)}
          >
            <option value="">Todos</option>
            {proveedores.map((p) => (
              <option key={p.valor} value={p.valor}>
                {p.nombre}
              </option>
            ))}
          </select>
        </div>
        <div className="ml-auto space-y-1">
          <label
            htmlFor="compras-tolerancia"
            className="block text-[10px] text-[#94a3b8] font-bold uppercase"
          >
            Tolerancia de diferencia (gal)
          </label>
          <div className="flex gap-2">
            <input
              id="compras-tolerancia"
              type="number"
              min={0}
              step="0.5"
              disabled={!puedeFijarTolerancia}
              className={`${CAMPO_FILTRO} w-24`}
              value={tolerancia}
              onChange={(e) => setTolerancia(e.target.value)}
            />
            {puedeFijarTolerancia && (
              <button
                type="button"
                onClick={() => void guardarTolerancia()}
                className={`${BOTON} border-[#334155] text-[#e2e8f0] hover:bg-[#2a2e37]`}
              >
                Guardar
              </button>
            )}
          </div>
        </div>
      </div>
      {mensaje && (
        <p role="status" className="mb-4 text-sm font-medium text-cyan-300">
          {mensaje}
        </p>
      )}
      {error && (
        <p role="alert" className="mb-4 text-sm font-medium text-amber-300">
          {error}
        </p>
      )}
      {compras === null ? (
        !error && <p className="text-sm text-[#94a3b8]">Cargando compras...</p>
      ) : visibles.length === 0 ? (
        <div className="bg-[#192526] border border-dashed border-[#334155] rounded-xl p-10 text-center text-[#94a3b8]">
          {compras.length === 0
            ? "Todavía no registraste ninguna compra de cisterna."
            : "Ninguna compra coincide con el filtro."}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3">
          {visibles.map((c) => {
            const dias = diasParaLaLlegada(c.llegada_estimada, hoy);
            return (
              <article
                key={c.id}
                aria-label={`Compra ${c.numero_documento}`}
                className="bg-[#192526] border border-[#2a2e37] rounded-lg p-4 flex flex-col gap-3"
              >
                <header className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="text-base font-bold text-white">{c.proveedor}</h3>
                  <span
                    className={`text-[11px] font-bold uppercase border rounded-full px-2 py-0.5 ${CHIP[c.estado]}`}
                  >
                    {ETIQUETA_ESTADO[c.estado]}
                  </span>
                </header>
                <dl className="grid grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-2 text-xs">
                  <div>
                    <dt className="text-[10px] text-[#94a3b8] font-bold uppercase">Documento</dt>
                    <dd className="text-[#e2e8f0]">
                      {ETIQUETA_DOCUMENTO[c.tipo_documento]} {c.numero_documento}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[10px] text-[#94a3b8] font-bold uppercase">Cantidad</dt>
                    <dd className="font-mono text-[#e2e8f0]">
                      {formatear(Number(c.cantidad_facturada))} {c.unidad} ·{" "}
                      {ETIQUETA_COMBUSTIBLE[c.tipo_combustible]}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[10px] text-[#94a3b8] font-bold uppercase">Emisión</dt>
                    <dd className="text-[#e2e8f0]">
                      {new Date(`${c.fecha_compra}T00:00:00`).toLocaleDateString("es-PE")}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[10px] text-[#94a3b8] font-bold uppercase">
                      Llegada a planta
                    </dt>
                    <dd className="text-[#e2e8f0]">
                      {new Date(`${c.llegada_estimada}T00:00:00`).toLocaleDateString("es-PE")}
                      {c.estado === "registrada" || c.estado === "por_llegar" ? (
                        <span className="text-[#94a3b8]">
                          {dias > 0
                            ? ` · en ${dias} ${dias === 1 ? "día" : "días"}`
                            : dias === 0
                              ? " · hoy"
                              : ` · hace ${-dias} ${dias === -1 ? "día" : "días"}`}
                        </span>
                      ) : null}
                    </dd>
                  </div>
                  {c.transportista && (
                    <div className="col-span-2">
                      <dt className="text-[10px] text-[#94a3b8] font-bold uppercase">
                        Empresa de transporte
                      </dt>
                      <dd className="text-[#e2e8f0]">
                        {c.transportista}
                        {c.transportista_ruc ? ` · RUC ${c.transportista_ruc}` : ""}
                      </dd>
                    </div>
                  )}
                </dl>
                {c.estado === "anulada" && c.motivo_anulacion && (
                  <p className="text-xs text-red-400">Motivo: {c.motivo_anulacion}</p>
                )}
                {c.estado === "recibida" && c.recepcion_id && (
                  <p className="text-xs text-[#bef264]">
                    Se descargó en la recepción #{c.recepcion_id}.
                  </p>
                )}
                {(c.estado === "registrada" || c.estado === "por_llegar") && (
                  <div className="flex flex-wrap gap-2">
                    {c.estado === "registrada" && (
                      <button
                        type="button"
                        disabled={trabajando === c.id}
                        onClick={() => void habilitar(c)}
                        className={`${BOTON} bg-[#a3e635] text-black border-[#65a30d] hover:bg-[#bef264]`}
                      >
                        Habilitar a la cancha
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={trabajando === c.id}
                      onClick={() => {
                        setAnulando(c);
                        setMotivo("");
                      }}
                      className={`${BOTON} border-red-500/50 text-red-400 hover:bg-red-500/10`}
                    >
                      Anular
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
      {anulando && (
        <div className="fixed inset-0 bg-[#0D1719]/90 backdrop-blur-sm flex justify-center items-center z-[60] p-4">
          <div className="bg-white w-full max-w-md rounded-3xl shadow-2xl p-6 space-y-3">
            <h3 className="text-lg font-bold">Anular la compra {anulando.numero_documento}</h3>
            <p className="text-sm text-slate-600">
              Queda anulada con su motivo; no se borra. La cancha ya no la verá.
            </p>
            <label htmlFor="compra-motivo" className="text-xs font-bold text-slate-700 uppercase">
              Motivo
            </label>
            <textarea
              id="compra-motivo"
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
                disabled={motivo.trim() === "" || trabajando === anulando.id}
                onClick={() => void anular()}
                className="px-4 py-2 rounded-lg text-sm font-semibold bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
              >
                Anular compra
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
