// Corregir un cambio de mando que nadie marcó (0154): la oficina dice quién pasó a manejar, a qué
// hora y con qué medidor, y por qué. El servidor parte el turno de esa hora en dos y anota que lo
// corrigió la oficina. Es de oficina (con señal): el celular del conductor tiene su propio camino.
import { useState } from "react";

import type { FilaViaje } from "./viajesFormato";
import { apiFetch } from "../../services/apiClient";

const INPUT = "w-full bg-[#0D1719] border border-[#334155] rounded-xl px-3 py-2 text-sm text-white";
const ETIQUETA = "block text-xs text-[#94a3b8]";
const BTN =
  "bg-[#BADC1E] text-[#0D1719] font-bold px-4 py-2 rounded-xl hover:brightness-110 disabled:opacity-50";
const BTN_SEC = "border border-[#334155] text-[#cbd5e1] font-semibold px-4 py-2 rounded-xl";

export function CorregirMando({
  viaje,
  etiquetaMedidor,
  puedeEditar,
  onCambio,
}: {
  viaje: FilaViaje;
  etiquetaMedidor: string;
  puedeEditar: boolean;
  onCambio: () => Promise<void>;
}) {
  const [abierto, setAbierto] = useState(false);
  const [aDni, setADni] = useState("");
  const [cuando, setCuando] = useState("");
  const [medidor, setMedidor] = useState("");
  const [lugar, setLugar] = useState("");
  const [motivo, setMotivo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  if (
    !puedeEditar ||
    !viaje.relevo_dni ||
    !viaje.conductor_dni ||
    (viaje.estado !== "en_curso" && viaje.estado !== "cerrado")
  ) {
    return null;
  }
  const personas = [
    { dni: viaje.conductor_dni, nombre: viaje.conductor_nombre ?? `DNI ${viaje.conductor_dni}` },
    { dni: viaje.relevo_dni, nombre: viaje.relevo_nombre ?? `DNI ${viaje.relevo_dni}` },
  ];
  const medidorNumero = medidor.trim() === "" ? null : Number(medidor);
  const valido =
    aDni !== "" &&
    cuando !== "" &&
    motivo.trim().length >= 3 &&
    (viaje.tipo_medidor === null || (medidorNumero !== null && !Number.isNaN(medidorNumero)));

  const abrir = () => {
    setADni((personas.find((p) => p.dni !== viaje.volante_dni) ?? personas[1]).dni);
    setAbierto(true);
  };

  const corregir = async () => {
    if (guardando || !valido) return;
    setGuardando(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/erp/combustible/viajes/${viaje.id}/mando/corregir`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          a_dni: aDni,
          cambio_en: new Date(cuando).toISOString(),
          medidor: medidorNumero,
          lugar: lugar.trim() || null,
          motivo: motivo.trim(),
        }),
      });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(r.error || r.message || r.errors?.[0]?.message || "No se pudo guardar.");
        return;
      }
      setAbierto(false);
      setCuando("");
      setMedidor("");
      setLugar("");
      setMotivo("");
      await onCambio();
    } finally {
      setGuardando(false);
    }
  };

  return (
    <div className="rounded-2xl bg-[#192526] border border-[#2a2e37] p-4 space-y-3">
      <p className="text-xs uppercase tracking-widest text-[#94a3b8]">Cambio de mando</p>
      {!abierto ? (
        <>
          <p className="text-sm text-[#94a3b8]">
            Si titular y relevo se cambiaron el volante y nadie lo marcó, corrígelo aquí.
          </p>
          <button className={BTN_SEC} onClick={abrir}>
            Corregir cambio de mando
          </button>
        </>
      ) : (
        <div className="space-y-2">
          <label className={ETIQUETA} htmlFor="cm-quien">
            Quién pasó a manejar
          </label>
          <select
            id="cm-quien"
            value={aDni}
            onChange={(e) => setADni(e.target.value)}
            className={INPUT}
          >
            {personas.map((p) => (
              <option key={p.dni} value={p.dni}>
                {p.nombre}
              </option>
            ))}
          </select>
          <label className={ETIQUETA} htmlFor="cm-cuando">
            Fecha y hora real del cambio
          </label>
          <input
            id="cm-cuando"
            type="datetime-local"
            value={cuando}
            onChange={(e) => setCuando(e.target.value)}
            className={INPUT}
          />
          {viaje.tipo_medidor !== null && (
            <>
              <label className={ETIQUETA} htmlFor="cm-medidor">
                {etiquetaMedidor} en el cambio
              </label>
              <input
                id="cm-medidor"
                inputMode="decimal"
                value={medidor}
                onChange={(e) => setMedidor(e.target.value)}
                className={INPUT}
              />
            </>
          )}
          <label className={ETIQUETA} htmlFor="cm-lugar">
            Lugar (opcional)
          </label>
          <input
            id="cm-lugar"
            value={lugar}
            maxLength={160}
            onChange={(e) => setLugar(e.target.value)}
            className={INPUT}
          />
          <label className={ETIQUETA} htmlFor="cm-motivo">
            Motivo de la corrección
          </label>
          <input
            id="cm-motivo"
            value={motivo}
            maxLength={500}
            placeholder="Ej. no lo marcaron, me avisó el conductor"
            onChange={(e) => setMotivo(e.target.value)}
            className={INPUT}
          />
          <p className="text-xs text-[#94a3b8]">
            El tramo se parte a esa hora y queda anotado que lo corrigió la oficina.
          </p>
          <div className="flex gap-2">
            <button className={BTN} disabled={guardando || !valido} onClick={() => void corregir()}>
              Corregir
            </button>
            <button className={BTN_SEC} onClick={() => setAbierto(false)}>
              Cancelar
            </button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
