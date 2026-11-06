// El grifero devuelve al tanque (pozo) lo que sobra de una tanqueta que no va con ninguna unidad
// (0178): todo el saldo o la parte que quiera. Reusa el mismo criterio de DestinoDelRetorno: solo
// los tanques activos de la sede de la tanqueta y con lectura, con el espacio que les queda.
import { X } from "lucide-react";
import { useEffect, useState } from "react";

import { apiFetch } from "../../services/apiClient";

/** Litros que tiene un galón (la tanqueta mide en galones; un tanque puede medir en litros). */
const LITROS_POR_GALON = 3.785411784;

interface TanqueDelPozo {
  id: number;
  codigo: string;
  tanque_nombre: string;
  unidad: "gal" | "L";
  capacidad_total: string;
  nivel_teorico: string | null;
  activo: boolean;
  grifo_interno_id: number | null;
}

const formatear = (n: number) => n.toLocaleString("es-PE", { maximumFractionDigits: 3 });

export default function DevolverAlTanque({
  tanqueta,
  onCerrar,
  onListo,
}: {
  tanqueta: { id: string; codigo: string; saldo: string; grifo_interno_id: number };
  onCerrar: () => void;
  onListo: () => void;
}) {
  const saldo = Number(tanqueta.saldo);
  const [cantidad, setCantidad] = useState(String(saldo));
  const [tanqueId, setTanqueId] = useState("");
  const [motivo, setMotivo] = useState("");
  const [tanques, setTanques] = useState<TanqueDelPozo[] | null>(null);
  const [errorTanques, setErrorTanques] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let vigente = true;
    (async () => {
      try {
        const res = await apiFetch("/api/erp/combustible");
        const body = await res.json().catch(() => null);
        if (!vigente) return;
        if (res.ok && Array.isArray(body)) setTanques(body);
        else setErrorTanques(true);
      } catch {
        if (vigente) setErrorTanques(true);
      }
    })();
    return () => {
      vigente = false;
    };
  }, []);

  const cant = Number(cantidad);
  const hayCantidad = cantidad !== "" && Number.isFinite(cant) && cant > 0.0005;
  const sobraSaldo = hayCantidad && cant > saldo + 0.0005;
  const tresDecimales = !hayCantidad || Math.abs(cant * 1000 - Math.round(cant * 1000)) < 1e-6;

  // Los tanques de la sede, con el espacio que les queda y cuánto entraría en su unidad.
  const delPozo = (tanques ?? [])
    .filter((t) => t.activo && Number(t.grifo_interno_id) === Number(tanqueta.grifo_interno_id))
    .filter((t) => t.nivel_teorico !== null)
    .map((t) => {
      const libre = Math.max(0, Number(t.capacidad_total) - Number(t.nivel_teorico));
      const entra = t.unidad === "L" ? cant * LITROS_POR_GALON : cant;
      return { t, libre, entra, cabe: !hayCantidad || entra <= libre + 0.0005 };
    });
  const elegido = delPozo.find((x) => String(x.t.id) === tanqueId);

  const motivoSinTanques = errorTanques
    ? "No se pudieron cargar los tanques"
    : tanques === null
      ? "Buscando tanques..."
      : delPozo.length === 0
        ? "No hay un tanque activo con lectura en esta sede"
        : null;

  const valido = hayCantidad && !sobraSaldo && tresDecimales && tanqueId !== "";

  const enviar = async () => {
    if (enviando || !valido) return;
    setEnviando(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/erp/combustible/tanquetas/${tanqueta.id}/devolver-al-pozo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cantidad: cant,
          tanque_id: Number(tanqueId),
          motivo: motivo.trim() || undefined,
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
          <h3 className="text-xl font-bold">Retornar {tanqueta.codigo} al tanque</h3>
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
            La tanqueta tiene <strong>{formatear(saldo)} gal</strong>. Devuelve al tanque todo o la
            parte que quieras.
          </p>
          <div className="space-y-1">
            <label
              htmlFor="devolver-cantidad"
              className="text-xs font-bold text-slate-700 uppercase"
            >
              ¿Cuánto devuelves? (gal)
            </label>
            <input
              id="devolver-cantidad"
              type="number"
              required
              min={0.001}
              step="0.001"
              className="w-full border border-slate-200 rounded-xl p-3 text-sm"
              value={cantidad}
              onChange={(e) => setCantidad(e.target.value)}
            />
            {sobraSaldo && (
              <p className="text-xs text-red-600">La tanqueta solo tiene {formatear(saldo)} gal.</p>
            )}
            {!tresDecimales && (
              <p className="text-xs text-red-600">
                Usa como máximo 3 decimales (por ejemplo 12.345).
              </p>
            )}
          </div>
          <div className="space-y-1">
            <label htmlFor="devolver-tanque" className="text-xs font-bold text-slate-700 uppercase">
              ¿A qué tanque?
            </label>
            <select
              id="devolver-tanque"
              required
              disabled={motivoSinTanques !== null}
              className="w-full border border-slate-200 rounded-xl p-3 text-sm"
              value={tanqueId}
              onChange={(e) => setTanqueId(e.target.value)}
            >
              <option value="">{motivoSinTanques ?? "Elegir tanque"}</option>
              {delPozo.map(({ t, libre, cabe }) => (
                <option key={t.id} value={t.id} disabled={!cabe}>
                  {t.codigo} · {t.tanque_nombre} · espacio para {formatear(libre)} {t.unidad}
                  {cabe ? "" : " · no cabe"}
                </option>
              ))}
            </select>
            {elegido && elegido.t.unidad === "L" && hayCantidad && (
              <p className="text-xs text-slate-600">
                El tanque mide en litros: entran {formatear(elegido.entra)} L.
              </p>
            )}
          </div>
          <div className="space-y-1">
            <label htmlFor="devolver-motivo" className="text-xs font-bold text-slate-700 uppercase">
              Motivo (opcional)
            </label>
            <input
              id="devolver-motivo"
              maxLength={500}
              className="w-full border border-slate-200 rounded-xl p-3 text-sm"
              placeholder="Ej.: sobró del llenado del turno"
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
            />
          </div>
          <button
            type="submit"
            disabled={enviando || !valido}
            className="w-full bg-[#BADC1E] text-[#0D1719] font-bold py-3 rounded-2xl hover:brightness-110 disabled:opacity-50"
          >
            {enviando ? "Guardando..." : "Retornar al tanque"}
          </button>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </form>
      </div>
    </div>
  );
}
