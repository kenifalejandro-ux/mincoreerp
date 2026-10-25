// "Mi viaje" con el viaje en curso: las paradas, UN botón grande que cambia según dónde va
// (Llegué a B, Salir hacia A, Llegué a A · terminar viaje) y el descanso. Cada marca pide el medidor
// (el descanso no) y se guarda sin señal si hace falta; el servidor rechaza la que ya no corresponde.
// Con un descanso abierto el viaje no avanza: primero se termina.
import { Flag, MapPin, Moon, Play } from "lucide-react";
import { useState } from "react";

import { MandoViaje } from "./MandoViaje";
import { ParadasViaje } from "./ParadasViaje";
import {
  conDescansoLocal,
  conMarcaLocal,
  descansoAbierto,
  proximaMarca,
  type DescansoMio,
  type EntregaPendiente,
  type ParadaMia,
  type TurnoViaje,
} from "./paradasViaje";
import { duracion } from "./viajesFormato";
import { apiFetch } from "../../services/apiClient";

const BTN_LIMA =
  "w-full flex items-center justify-center gap-2 bg-[#BADC1E] text-[#0D1719] font-extrabold text-lg py-4 rounded-2xl hover:brightness-110 disabled:opacity-50";
const BTN_SECUNDARIO =
  "w-full flex items-center justify-center gap-2 border border-[#334155] text-[#cbd5e1] font-semibold py-3 rounded-2xl hover:text-white";
const INPUT =
  "w-full bg-[#0D1719] border border-[#334155] rounded-xl px-4 py-4 text-2xl font-mono text-white text-center";
const MOTIVOS = ["Dormir", "Comer", "Avería", "Otro"];

export interface CambiosLocales {
  paradas?: ParadaMia[];
  descansos?: DescansoMio[];
  estado?: "cerrado";
  fin_en?: string;
  medidor_fin?: string | null;
  /** El mando (0153): quién maneja, la entrega que espera y los turnos. */
  volante_dni?: string | null;
  entrega_pendiente?: EntregaPendiente | null;
  entrega_retirada?: boolean;
  turnos?: TurnoViaje[];
}

interface Props {
  viajeId: string;
  paradas: ParadaMia[];
  descansos: DescansoMio[];
  conMedidor: boolean;
  etiquetaMedidor: string;
  unidadMedidor: string;
  /** El reloj de la pantalla, para el cronómetro del descanso. */
  ahora: number;
  /** Sin señal: cómo queda el viaje en este celular mientras la marca espera en la cola. */
  onLocal: (cambios: CambiosLocales) => void;
  onAviso: (texto: string | null) => void;
  onRecargar: () => Promise<void>;
  /** Con relevo: quien no va al volante no marca llegadas ni salidas, solo descansa (0152). */
  alVolante?: boolean;
  manejaNombre?: string | null;
  /** Con relevo (0153): para entregar y aceptar el mando. */
  mando?: {
    miDni: string;
    otroNombre: string | null;
    entrega: EntregaPendiente | null;
    turnos: TurnoViaje[];
  } | null;
}

export function MiViajeParadas({
  viajeId,
  paradas,
  descansos,
  conMedidor,
  etiquetaMedidor,
  unidadMedidor,
  ahora,
  onLocal,
  onAviso,
  onRecargar,
  alVolante = true,
  manejaNombre = null,
  mando = null,
}: Props) {
  const siguiente = proximaMarca(paradas);
  const marca = alVolante ? siguiente : null;
  const enDescanso = descansoAbierto(descansos);
  const [abierto, setAbierto] = useState(false);
  // Salir de una parada suele ser la misma lectura con la que se llegó.
  const [medidor, setMedidor] = useState(() =>
    marca?.accion === "salida-mia" && marca.minimo !== null ? String(marca.minimo) : ""
  );
  const [eligiendoMotivo, setEligiendoMotivo] = useState(false);
  const [motivo, setMotivo] = useState("");
  const [otro, setOtro] = useState("");
  const [guardando, setGuardando] = useState(false);

  /** Manda una marca y la deja en el celular si no hay señal (202). `local` es cómo queda el
   *  viaje; el servidor rechaza con 409 la que ya no corresponde y entonces se muestra cómo está. */
  const mandar = async (
    ruta: string,
    cuerpo: object,
    local: (marcadoEn: string) => CambiosLocales,
    textoOk: string
  ) => {
    if (guardando) return;
    const marcadoEn = new Date().toISOString();
    setGuardando(true);
    onAviso(null);
    try {
      const res = await apiFetch(`/api/erp/combustible/viajes/${viajeId}/${ruta}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...cuerpo,
          marcado_en: marcadoEn,
          cliente_uuid: crypto.randomUUID(),
        }),
      });
      const r = await res.json().catch(() => ({}));
      if (res.status === 202) {
        onLocal(local(marcadoEn));
        onAviso("Sin señal: quedó guardado en el celular y se enviará solo al volver la señal.");
        return;
      }
      if (!res.ok) {
        onAviso(r.error || r.message || r.errors?.[0]?.message || "No se pudo guardar.");
        if (res.status === 409) await onRecargar();
        return;
      }
      onAviso(textoOk);
      await onRecargar();
    } finally {
      setGuardando(false);
    }
  };

  const enviar = () => {
    if (!marca) return;
    const lectura = medidor.trim() === "" ? null : Number(medidor);
    if (conMedidor && lectura === null) {
      onAviso(`Escribe el ${etiquetaMedidor} que marca el tablero.`);
      return;
    }
    if (lectura !== null && marca.minimo !== null && lectura < marca.minimo) {
      onAviso(`Es menor que la última lectura del viaje: revisa el ${etiquetaMedidor}.`);
      return;
    }
    void mandar(
      marca.accion,
      { medidor: lectura, orden: marca.orden },
      (marcadoEn) => ({
        paradas: conMarcaLocal(paradas, marca, marcadoEn, lectura),
        ...(marca.cierra
          ? {
              estado: "cerrado" as const,
              fin_en: marcadoEn,
              medidor_fin: lectura === null ? null : String(lectura),
            }
          : {}),
      }),
      marca.cierra
        ? "Viaje terminado."
        : marca.accion === "llegada-mia"
          ? "Llegada registrada."
          : "Salida registrada. ¡Buen viaje!"
    );
  };

  const textoDelMotivo = motivo === "Otro" ? otro.trim() || "Otro" : motivo;
  const empezarDescanso = () =>
    void mandar(
      "descanso-mio",
      { motivo: textoDelMotivo || null },
      (marcadoEn) => ({
        descansos: conDescansoLocal(descansos, "empezar", marcadoEn, textoDelMotivo || null),
      }),
      "Descanso empezado."
    );
  const terminarDescanso = () =>
    void mandar(
      "descanso-mio/terminar",
      {},
      (marcadoEn) => ({ descansos: conDescansoLocal(descansos, "terminar", marcadoEn, null) }),
      "Descanso terminado. ¡Buen viaje!"
    );

  return (
    <div className="space-y-4">
      <ParadasViaje paradas={paradas} />

      {mando && !enDescanso && (
        <MandoViaje
          alVolante={alVolante}
          otroNombre={mando.otroNombre}
          miDni={mando.miDni}
          entrega={mando.entrega}
          turnos={mando.turnos}
          conMedidor={conMedidor}
          etiquetaMedidor={etiquetaMedidor}
          unidadMedidor={unidadMedidor}
          minimo={siguiente?.minimo ?? null}
          guardando={guardando}
          mandar={mandar}
          onAviso={onAviso}
        />
      )}

      {!alVolante && !mando?.entrega && (
        <p className="rounded-2xl border border-sky-400/40 bg-sky-500/10 p-4 font-semibold text-sky-200">
          Va manejando {manejaNombre ?? "tu compañero"}. Tú puedes descansar.
        </p>
      )}

      {enDescanso && (
        <div className="rounded-2xl border border-violet-400/40 bg-violet-500/10 p-4 space-y-3">
          <p className="flex items-center gap-2 font-bold text-violet-200">
            <Moon className="w-5 h-5" aria-hidden /> Descansando
            {enDescanso.motivo ? ` · ${enDescanso.motivo}` : ""}
          </p>
          <p className="font-mono text-2xl text-white">
            {duracion((ahora - Date.parse(enDescanso.inicio_en)) / 60_000)}
          </p>
          <button className={BTN_LIMA} disabled={guardando} onClick={terminarDescanso}>
            Terminar descanso
          </button>
          <p className="text-xs text-violet-200">Termina el descanso para continuar el viaje.</p>
        </div>
      )}

      {!enDescanso && marca && !abierto && (
        <button className={BTN_LIMA} onClick={() => setAbierto(true)}>
          {marca.cierra ? (
            <Flag className="w-6 h-6" />
          ) : marca.accion === "llegada-mia" ? (
            <MapPin className="w-6 h-6" />
          ) : (
            <Play className="w-6 h-6" />
          )}{" "}
          {marca.texto}
        </button>
      )}

      {!enDescanso && marca && abierto && (
        <div className="space-y-3">
          {conMedidor && (
            <>
              <label className="block text-sm text-[#cbd5e1]" htmlFor="mi-viaje-parada-medidor">
                {etiquetaMedidor} que marca el tablero
              </label>
              <input
                id="mi-viaje-parada-medidor"
                type="number"
                inputMode="decimal"
                min={marca.minimo ?? 0}
                step="0.1"
                autoFocus
                value={medidor}
                onChange={(e) => setMedidor(e.target.value)}
                className={INPUT}
              />
              {marca.minimo !== null && (
                <p className="text-xs text-[#94a3b8]">
                  Última lectura del viaje: {marca.minimo} {unidadMedidor}
                </p>
              )}
            </>
          )}
          <button className={BTN_LIMA} disabled={guardando} onClick={enviar}>
            {guardando ? "Guardando..." : marca.texto}
          </button>
          <button className={BTN_SECUNDARIO} onClick={() => setAbierto(false)}>
            Volver
          </button>
        </div>
      )}

      {!enDescanso && siguiente && !eligiendoMotivo && (
        <button className={BTN_SECUNDARIO} onClick={() => setEligiendoMotivo(true)}>
          <Moon className="w-5 h-5" aria-hidden /> Descansar
        </button>
      )}

      {!enDescanso && siguiente && eligiendoMotivo && (
        <div className="rounded-2xl bg-[#0D1719] border border-[#334155] p-4 space-y-3">
          <p className="text-sm text-[#cbd5e1]">¿Por qué descansas? (opcional)</p>
          <div className="flex flex-wrap gap-2">
            {MOTIVOS.map((m) => (
              <button
                key={m}
                aria-pressed={motivo === m}
                onClick={() => setMotivo(motivo === m ? "" : m)}
                className={`px-4 py-2 rounded-full border text-sm font-semibold ${
                  motivo === m
                    ? "border-violet-400 bg-violet-500/20 text-violet-200"
                    : "border-[#334155] text-[#cbd5e1]"
                }`}
              >
                {m}
              </button>
            ))}
          </div>
          {motivo === "Otro" && (
            <input
              aria-label="Escribe el motivo"
              placeholder="Escribe el motivo"
              maxLength={80}
              value={otro}
              onChange={(e) => setOtro(e.target.value)}
              className="w-full bg-[#0D1719] border border-[#334155] rounded-xl px-4 py-3 text-white"
            />
          )}
          <button className={BTN_LIMA} disabled={guardando} onClick={empezarDescanso}>
            Empezar descanso
          </button>
          <button className={BTN_SECUNDARIO} onClick={() => setEligiendoMotivo(false)}>
            Cancelar
          </button>
        </div>
      )}
    </div>
  );
}
