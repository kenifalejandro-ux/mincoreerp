// El mando del volante en "Mi viaje" (0153): quien maneja lo entrega con el medidor del tablero y
// el otro conductor lo acepta. Hasta que acepte sigue al volante quien entregó. Cada marca se guarda
// sin señal si hace falta; el que no tiene señal ve el cambio cuando vuelva.
import { Handshake } from "lucide-react";
import { useState } from "react";

import type { CambiosLocales } from "./MiViajeParadas";
import type { EntregaPendiente, TurnoViaje } from "./paradasViaje";

const BTN_LIMA =
  "w-full flex items-center justify-center gap-2 bg-[#BADC1E] text-[#0D1719] font-extrabold text-lg py-4 rounded-2xl hover:brightness-110 disabled:opacity-50";
const BTN_SECUNDARIO =
  "w-full flex items-center justify-center gap-2 border border-[#334155] text-[#cbd5e1] font-semibold py-3 rounded-2xl hover:text-white";
const INPUT =
  "w-full bg-[#0D1719] border border-[#334155] rounded-xl px-4 py-4 text-2xl font-mono text-white text-center";

interface Props {
  /** Yo voy al volante. */
  alVolante: boolean;
  /** El otro conductor del viaje (a quien le entrego o de quien recibo). */
  otroNombre: string | null;
  miDni: string;
  entrega: EntregaPendiente | null;
  turnos: TurnoViaje[];
  conMedidor: boolean;
  etiquetaMedidor: string;
  unidadMedidor: string;
  /** La última lectura del viaje: la de la entrega no puede ser menor. */
  minimo: number | null;
  guardando: boolean;
  mandar: (
    ruta: string,
    cuerpo: object,
    local: (marcadoEn: string) => CambiosLocales,
    textoOk: string
  ) => Promise<void>;
  onAviso: (texto: string | null) => void;
}

export function MandoViaje({
  alVolante,
  otroNombre,
  miDni,
  entrega,
  turnos,
  conMedidor,
  etiquetaMedidor,
  unidadMedidor,
  minimo,
  guardando,
  mandar,
  onAviso,
}: Props) {
  const [abierto, setAbierto] = useState(false);
  const [medidor, setMedidor] = useState("");
  const [lugar, setLugar] = useState("");

  const paraMi = entrega?.a_dni.trim() === miDni;
  const mia = entrega?.de_dni.trim() === miDni;

  const entregar = () => {
    const lectura = medidor.trim() === "" ? null : Number(medidor);
    if (conMedidor && lectura === null) {
      onAviso(`Escribe el ${etiquetaMedidor} que marca el tablero.`);
      return;
    }
    if (lectura !== null && minimo !== null && lectura < minimo) {
      onAviso(`Es menor que la última lectura del viaje: revisa el ${etiquetaMedidor}.`);
      return;
    }
    void mandar(
      "mando/entregar",
      { medidor: lectura, lugar: lugar.trim() || null },
      (marcadoEn) => ({
        entrega_pendiente: {
          de_dni: miDni,
          de_nombre: null,
          a_dni: "",
          a_nombre: otroNombre,
          entrega_en: marcadoEn,
          medidor: lectura === null ? null : String(lectura),
          lugar: lugar.trim() || null,
        },
      }),
      "Mando entregado: sigues al volante hasta que lo acepte."
    ).then(() => setAbierto(false));
  };

  const aceptar = () =>
    void mandar(
      "mando/aceptar",
      {},
      (marcadoEn) => ({
        volante_dni: miDni,
        entrega_pendiente: null,
        turnos: [
          ...turnos.map((t) =>
            t.fin_en ? t : { ...t, fin_en: marcadoEn, medidor_fin: entrega?.medidor ?? null }
          ),
          {
            conductor_dni: miDni,
            conductor_nombre: null,
            inicio_en: marcadoEn,
            fin_en: null,
            medidor_inicio: entrega?.medidor ?? null,
            medidor_fin: null,
            lugar: entrega?.lugar ?? null,
          },
        ],
      }),
      "Tienes el mando. ¡Buen viaje!"
    );

  const retirar = () =>
    void mandar(
      "mando/retirar",
      {},
      () => ({ entrega_pendiente: null, entrega_retirada: true }),
      "Entrega retirada: sigues al volante."
    );

  if (entrega && paraMi && !alVolante) {
    return (
      <div className="rounded-2xl border border-[#BADC1E]/40 bg-[#BADC1E]/10 p-4 space-y-3">
        <p className="flex items-center gap-2 font-bold text-[#BADC1E]">
          <Handshake className="w-5 h-5" aria-hidden /> {entrega.de_nombre ?? otroNombre} te entrega
          el mando
        </p>
        <p className="text-sm text-[#cbd5e1]">
          {entrega.medidor != null && `${etiquetaMedidor}: ${entrega.medidor} ${unidadMedidor}`}
          {entrega.lugar && ` · ${entrega.lugar}`}
        </p>
        <button className={BTN_LIMA} disabled={guardando} onClick={aceptar}>
          Aceptar el mando
        </button>
      </div>
    );
  }

  if (entrega && mia && alVolante) {
    return (
      <div className="rounded-2xl border border-sky-400/40 bg-sky-500/10 p-4 space-y-3">
        <p className="font-semibold text-sky-200">
          Esperando que {entrega.a_nombre ?? otroNombre} acepte el mando. Sigues al volante.
        </p>
        <button className={BTN_SECUNDARIO} disabled={guardando} onClick={retirar}>
          Retirar la entrega
        </button>
      </div>
    );
  }

  if (!alVolante || entrega) return null;

  if (!abierto) {
    return (
      <button className={BTN_SECUNDARIO} onClick={() => setAbierto(true)}>
        <Handshake className="w-5 h-5" aria-hidden /> Entregar el mando
      </button>
    );
  }

  return (
    <div className="rounded-2xl bg-[#0D1719] border border-[#334155] p-4 space-y-3">
      <p className="text-sm text-[#cbd5e1]">Entregas el volante a {otroNombre ?? "tu relevo"}.</p>
      {conMedidor && (
        <>
          <label className="block text-sm text-[#cbd5e1]" htmlFor="mando-medidor">
            {etiquetaMedidor} que marca el tablero al entregar
          </label>
          <input
            id="mando-medidor"
            type="number"
            inputMode="decimal"
            min={minimo ?? 0}
            step="0.1"
            value={medidor}
            onChange={(e) => setMedidor(e.target.value)}
            className={INPUT}
          />
        </>
      )}
      <input
        aria-label="Dónde se entrega (opcional)"
        placeholder="Dónde se entrega (opcional)"
        maxLength={160}
        value={lugar}
        onChange={(e) => setLugar(e.target.value)}
        className="w-full bg-[#0D1719] border border-[#334155] rounded-xl px-4 py-3 text-white"
      />
      <button className={BTN_LIMA} disabled={guardando} onClick={entregar}>
        Entregar el mando
      </button>
      <button className={BTN_SECUNDARIO} onClick={() => setAbierto(false)}>
        Cancelar
      </button>
    </div>
  );
}
