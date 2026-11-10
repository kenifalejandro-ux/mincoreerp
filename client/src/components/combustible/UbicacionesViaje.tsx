// Dónde estuvo la unidad de un viaje (0182): el historial de puntos y, para la oficina que edita
// viajes, «Registrar ubicación»: un lugar del catálogo o un texto libre (lo que ve en su GPS
// externo), con la hora en que estaba ahí y una nota. Sin GPS real: se anota a mano. Un descanso
// con «¿Dónde?» deja también su punto aquí. El catálogo es opcional: si no carga, se escribe.
import { MapPin } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { Lugar } from "./empezarViaje";
import { aValorLocal } from "./ponerAlDiaLogica";
import { SelectorLugar } from "./SelectorLugar";
import {
  cuerpoDeUbicacion,
  errorDeUbicacion,
  haceCuanto,
  lugaresDelCatalogo,
} from "./ubicacionesLogica";
import { diaHora, type FilaViaje } from "./viajesFormato";
import { apiFetch } from "../../services/apiClient";

const INPUT =
  "w-full bg-[#0D1719] border border-[#334155] rounded-xl px-3 py-2 text-sm text-white [color-scheme:dark]";
const BTN =
  "bg-[#BADC1E] text-[#0D1719] font-bold px-4 py-2 rounded-xl hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed";

export function UbicacionesViaje({
  viaje,
  puedeEditar,
  onCambio,
  ahora,
  formularioAbierto = true,
}: {
  viaje: FilaViaje;
  puedeEditar: boolean;
  onCambio: () => Promise<void>;
  /** La hora de ahora (ms), para el «hace 2 h»: la pantalla la refresca sola. */
  ahora: number;
  /** «Actualizar ubicación» abre el formulario; cerrado, solo se ve el historial. */
  formularioAbierto?: boolean;
}) {
  const historial = viaje.ubicaciones ?? [];
  const ultima = viaje.ultima_ubicacion ?? null;
  const puedeAnotar = puedeEditar && viaje.estado === "en_curso";

  const [lugares, setLugares] = useState<{ id: number; nombre: string }[]>([]);
  const [lugar, setLugar] = useState<Lugar>(null);
  const [claveSelector, setClaveSelector] = useState(0);
  const [hora, setHora] = useState(() => aValorLocal(Date.now()));
  const [nota, setNota] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  // Un identificador por intento: si el envío se repite (doble clic, red lenta) no suma dos puntos.
  const uuid = useRef<string>(crypto.randomUUID());

  useEffect(() => {
    if (!puedeAnotar) return;
    let vigente = true;
    void (async () => {
      try {
        const res = await apiFetch("/api/erp/viajes/lugares");
        const body = await res.json().catch(() => null);
        if (vigente && res.ok && Array.isArray(body?.data)) {
          setLugares(lugaresDelCatalogo(body.data));
        }
      } catch {
        // Sin catálogo se escribe el lugar a mano: no es un error.
      }
    })();
    return () => {
      vigente = false;
    };
  }, [puedeAnotar]);

  const registrar = async () => {
    if (guardando) return;
    const problema = errorDeUbicacion({
      lugar,
      horaLocal: hora,
      inicioViaje: viaje.inicio_en,
      ahora: Date.now(),
    });
    if (problema) {
      setError(problema);
      setAviso(null);
      return;
    }
    setGuardando(true);
    setError(null);
    setAviso(null);
    try {
      const res = await apiFetch(`/api/erp/viajes/${viaje.id}/ubicaciones`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          cuerpoDeUbicacion({
            lugar,
            horaLocal: hora,
            nota,
            clienteUuid: uuid.current,
            inicioViaje: viaje.inicio_en,
          })
        ),
      });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(r.message || r.error || r.errors?.[0]?.message || "No se pudo guardar.");
        return;
      }
      uuid.current = crypto.randomUUID();
      setLugar(null);
      setClaveSelector((k) => k + 1);
      setNota("");
      setHora(aValorLocal(Date.now()));
      setAviso("Ubicación registrada.");
      await onCambio();
    } finally {
      setGuardando(false);
    }
  };

  return (
    <div className="rounded-2xl bg-[#192526] border border-[#2a2e37] p-4 space-y-3">
      <p className="text-xs uppercase tracking-widest text-[#94a3b8]">Ubicación</p>
      {ultima ? (
        <p className="flex items-center gap-2 text-white">
          <MapPin className="w-4 h-4 text-[#BADC1E]" aria-hidden />
          <span className="font-semibold">{ultima.texto}</span>
          <span className="text-sm text-[#94a3b8]">{haceCuanto(ultima.registrado_en, ahora)}</span>
        </p>
      ) : (
        <p className="text-sm text-[#94a3b8]">Todavía no hay ubicaciones anotadas.</p>
      )}

      {historial.length > 0 && (
        <ul aria-label="Historial de ubicaciones" className="divide-y divide-[#2a2e37]">
          {historial.map((u) => (
            <li key={u.id} className="py-2 flex flex-wrap items-baseline gap-x-3 text-sm">
              <span className="font-mono text-xs text-[#94a3b8]">{diaHora(u.registrado_en)}</span>
              <span className="font-semibold text-white">{u.texto}</span>
              {u.origen === "descanso" && (
                <span className="rounded-full bg-violet-500/20 px-2 py-0.5 text-[10px] font-bold uppercase text-violet-200">
                  En un descanso
                </span>
              )}
              {u.nota && <span className="text-[#94a3b8]">{u.nota}</span>}
            </li>
          ))}
        </ul>
      )}

      {puedeAnotar && formularioAbierto && (
        <div className="space-y-3 border-t border-[#2a2e37] pt-3">
          <SelectorLugar
            key={claveSelector}
            etiqueta="Dónde está"
            valor={lugar}
            lugares={lugares}
            onChange={setLugar}
            pieNuevo=""
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label
                htmlFor={`ubi-hora-${viaje.id}`}
                className="block text-xs uppercase tracking-wide text-[#94a3b8] mb-1"
              >
                Cuándo estaba ahí
              </label>
              <input
                id={`ubi-hora-${viaje.id}`}
                type="datetime-local"
                value={hora}
                onChange={(e) => setHora(e.target.value)}
                className={INPUT}
              />
            </div>
            <div>
              <label
                htmlFor={`ubi-nota-${viaje.id}`}
                className="block text-xs uppercase tracking-wide text-[#94a3b8] mb-1"
              >
                Nota (opcional)
              </label>
              <input
                id={`ubi-nota-${viaje.id}`}
                maxLength={300}
                placeholder="Por ejemplo: según el GPS"
                value={nota}
                onChange={(e) => setNota(e.target.value)}
                className={INPUT}
              />
            </div>
          </div>
          <button className={BTN} disabled={guardando} onClick={() => void registrar()}>
            Registrar ubicación
          </button>
          {aviso && (
            <p role="status" className="text-sm text-[#BADC1E]">
              {aviso}
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-red-400">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
