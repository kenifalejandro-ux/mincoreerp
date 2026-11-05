import { useState } from "react";

import CisternaAcostada from "./CisternaAcostada";
import {
  ETIQUETA_COMBUSTIBLE,
  ETIQUETA_DOCUMENTO,
  diasParaLaLlegada,
  hoyEnLima,
} from "./comprasCisternaLogica";
import type { CompraDeCisterna } from "./comprasCisternaTipos";
import { apiFetch } from "../../services/apiClient";
import { mensajeDeError } from "../../utils/mensajeDeError";

// La tarjeta de una cisterna que viene en camino: la compra ya está registrada (con su guía o
// factura) y el cilindro se ve lleno, con lo que dice el documento. Donde una cisterna con saldo
// tiene "Repartir", esta tiene "Registrar recepción": ahí el grifero la recibe y la distribuye (al
// tanque, y lo que sobre a tanquetas, a unidades o se queda en la cisterna).

const formatear = (n: number) => n.toLocaleString("es-PE", { maximumFractionDigits: 2 });

const BOTON =
  "flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-semibold transition-all active:scale-95 border";

export default function TarjetaCompraPorLlegar({
  c,
  puedeRecibir,
  puedeGestionar,
  onRecibir,
  onCambio,
}: {
  c: CompraDeCisterna;
  puedeRecibir: boolean;
  /** Quien registra compras ve también las que la cancha aún no ve, y puede habilitarlas. */
  puedeGestionar: boolean;
  onRecibir: (c: CompraDeCisterna) => void;
  onCambio: () => void;
}) {
  const [habilitando, setHabilitando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cantidad = Number(c.cantidad_facturada);
  const dias = diasParaLaLlegada(c.llegada_estimada, hoyEnLima());
  const porLlegar = c.estado === "por_llegar";

  const habilitar = async () => {
    setHabilitando(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/erp/combustible/compras-cisterna/${c.id}/habilitar`, {
        method: "PATCH",
      });
      if (!res.ok) {
        setError(mensajeDeError(await res.json().catch(() => ({})), "No se pudo habilitar."));
        return;
      }
      onCambio();
    } finally {
      setHabilitando(false);
    }
  };

  return (
    <article
      aria-label={`Cisterna por llegar ${c.numero_documento}`}
      className="bg-[#192526] border border-[#2a2e37] rounded-lg p-4 sm:p-6 shadow-lg flex flex-col gap-4"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-bold text-white">{c.proveedor}</h2>
        <p className="text-[11px] font-mono text-[#94a3b8]">
          {ETIQUETA_DOCUMENTO[c.tipo_documento]} {c.numero_documento} ·{" "}
          {ETIQUETA_COMBUSTIBLE[c.tipo_combustible]}
        </p>
      </header>
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] gap-6">
        <div className="flex flex-col gap-4">
          <div className="flex justify-center">
            <CisternaAcostada
              pct={100}
              plazo="en_plazo"
              descripcion={`Cisterna de ${c.proveedor} por llegar: ${formatear(cantidad)} ${c.unidad} según el documento`}
            />
          </div>
          <div className="bg-[#0D1719] border border-[#334155] rounded px-4 py-3 text-center">
            <div className="text-[10px] text-[#94a3b8] font-bold uppercase mb-1">
              {porLlegar
                ? "Por llegar · según el documento"
                : "Registrada · aún no la ve la cancha"}
            </div>
            <div className="font-mono text-2xl font-bold tracking-tight flex items-baseline justify-center gap-1 text-white">
              <span>{formatear(cantidad)}</span>
              <span className="text-xs text-[#94a3b8]">{c.unidad}</span>
            </div>
            <p className="mt-1 text-xs text-cyan-300">
              Llegada a planta:{" "}
              {new Date(`${c.llegada_estimada}T00:00:00`).toLocaleDateString("es-PE")}
              {dias > 0
                ? ` · en ${dias} ${dias === 1 ? "día" : "días"}`
                : dias === 0
                  ? " · hoy"
                  : ` · hace ${-dias} ${dias === -1 ? "día" : "días"}`}
            </p>
          </div>
          {porLlegar && puedeRecibir && (
            <button
              type="button"
              onClick={() => onRecibir(c)}
              className={`${BOTON} bg-[#a3e635] text-black hover:bg-[#bef264] border-[#65a30d]`}
            >
              Registrar recepción
            </button>
          )}
          {!porLlegar && puedeGestionar && (
            <button
              type="button"
              disabled={habilitando}
              onClick={() => void habilitar()}
              className={`${BOTON} border-[#334155] text-[#e2e8f0] hover:bg-[#2a2e37] disabled:opacity-50`}
            >
              Habilitar a la cancha
            </button>
          )}
          {error && (
            <p role="alert" className="text-xs text-amber-300">
              {error}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-3 text-xs">
          <section aria-label="Origen de la compra">
            <h3 className="text-[10px] text-[#94a3b8] font-bold uppercase mb-2">
              Lo que dice el documento
            </h3>
            <dl className="space-y-1 text-[#e2e8f0]">
              <div className="flex justify-between gap-3">
                <dt className="text-[#94a3b8]">Emisión</dt>
                <dd>{new Date(`${c.fecha_compra}T00:00:00`).toLocaleDateString("es-PE")}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-[#94a3b8]">Costo por {c.unidad}</dt>
                <dd className="font-mono">{formatear(Number(c.costo_unitario))}</dd>
              </div>
              {c.transportista && (
                <div className="flex justify-between gap-3">
                  <dt className="text-[#94a3b8]">Transporte</dt>
                  <dd className="text-right">
                    {c.transportista}
                    {c.transportista_ruc ? ` · RUC ${c.transportista_ruc}` : ""}
                  </dd>
                </div>
              )}
            </dl>
          </section>
          <p className="text-[#94a3b8]">
            Cuando llegue, el grifero la recibe aquí: la descarga va al tanque y lo que sobre se
            reparte a tanquetas, a unidades o se queda en la cisterna.
          </p>
        </div>
      </div>
    </article>
  );
}
