// Recibir la tanqueta de vuelta en el grifo (migración 0143). El grifero ve el
// saldo que calculó el sistema y escribe cuánto volvió de verdad; si es otra
// cifra, explica por qué. Después elige a dónde va el saldo (DestinoDelRetorno):
// se queda en la tanqueta, vuelve al tanque (0145) o pasa a otra tanqueta (0146).
import { X } from "lucide-react";
import { useState } from "react";

import DestinoDelRetorno from "./DestinoDelRetorno";
import {
  SIN_DESTINO,
  cuerpoDelDestino,
  destinoCompleto,
  type DestinoElegido,
  type OtraTanqueta,
} from "./destinoDelRetornoDatos";
import { apiFetch } from "../../services/apiClient";

export interface TanquetaARecibir {
  id: string;
  codigo: string;
  saldo: string;
  equipo_asignado: string | null;
  equipo_asignado_id: number | null;
  grifo_interno_id: number;
}

export default function RecibirTanqueta({
  tanqueta,
  otras,
  onCerrar,
  onListo,
}: {
  tanqueta: TanquetaARecibir;
  /** Las demás tanquetas, para ofrecer a cuál pasa el saldo. */
  otras: OtraTanqueta[];
  onCerrar: () => void;
  onListo: () => void;
}) {
  const calculado = Number(tanqueta.saldo);
  const [volvio, setVolvio] = useState(String(calculado));
  const [motivo, setMotivo] = useState("");
  const [destino, setDestino] = useState<DestinoElegido>(SIN_DESTINO);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const distinto = volvio !== "" && Math.abs(Number(volvio) - calculado) > 0.005;
  const valido =
    volvio !== "" &&
    Number(volvio) >= 0 &&
    (!distinto || motivo.trim().length >= 3) &&
    destinoCompleto(destino);

  const enviar = async () => {
    if (enviando || !valido) return;
    setEnviando(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/erp/combustible/tanquetas/${tanqueta.id}/retorno`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          saldo_calculado: calculado,
          saldo_validado: Number(volvio),
          motivo: distinto ? motivo.trim() : undefined,
          ...cuerpoDelDestino(destino),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.message || body.error || body.errors?.[0]?.message || "No se pudo guardar.");
        return;
      }
      onListo();
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-[#0D1719]/90 backdrop-blur-sm flex justify-center items-center z-50 p-4">
      <div className="bg-white w-full max-w-md rounded-3xl shadow-2xl">
        <div className="p-6 border-b flex justify-between items-center">
          <h3 className="text-xl font-bold">Recibir {tanqueta.codigo}</h3>
          <button
            type="button"
            onClick={onCerrar}
            aria-label="Cerrar"
            className="text-slate-400 hover:text-slate-900"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <form
          className="p-6 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void enviar();
          }}
        >
          <p className="text-sm text-slate-700">
            Volvió de la unidad {tanqueta.equipo_asignado ?? ""}. El sistema calcula que volvieron{" "}
            <strong>{calculado} gal</strong>.
          </p>
          <div className="space-y-1">
            <label htmlFor="retorno-volvio" className="text-xs font-bold text-slate-700 uppercase">
              ¿Cuánto volvió de verdad? (gal)
            </label>
            <input
              id="retorno-volvio"
              type="number"
              required
              min={0}
              step="any"
              className="w-full border border-slate-200 rounded-xl p-3 text-sm"
              value={volvio}
              onChange={(e) => setVolvio(e.target.value)}
            />
            <p className="text-xs text-slate-600">Si es lo mismo, déjalo así.</p>
          </div>
          {distinto && (
            <div className="space-y-1">
              <label
                htmlFor="retorno-motivo"
                className="text-xs font-bold text-slate-700 uppercase"
              >
                ¿Por qué {Number(volvio) < calculado ? "falta" : "sobra"}?
              </label>
              <input
                id="retorno-motivo"
                required
                maxLength={500}
                className="w-full border border-slate-200 rounded-xl p-3 text-sm"
                placeholder="Ej.: se derramó al bajarla"
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
              />
            </div>
          )}
          <DestinoDelRetorno
            tanqueta={tanqueta}
            cantidad={Number(volvio) || 0}
            otras={otras}
            valor={destino}
            onCambio={setDestino}
          />
          <button
            type="submit"
            disabled={enviando || !valido}
            className="w-full bg-[#BADC1E] text-[#0D1719] font-bold py-3 rounded-2xl hover:brightness-110 disabled:opacity-50"
          >
            {enviando ? "Guardando..." : "Registrar retorno"}
          </button>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </form>
      </div>
    </div>
  );
}
