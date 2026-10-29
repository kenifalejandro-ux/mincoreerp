// Lo que el encargado hace por el conductor desde el detalle de un viaje en curso: marcar o terminar
// su descanso y marcar la llegada o la salida que se olvidó. Va con quién lo hizo y por qué: el
// motivo es obligatorio. Es de oficina (con señal): el celular del conductor tiene su propio camino.
import { Moon } from "lucide-react";
import { useState } from "react";

import { maxDetalle, motivoGuardado, MOTIVOS_DESCANSO, pideDetalle } from "./motivosDescanso";
import {
  descansoAbierto,
  proximaMarca,
  type DescansoMio,
  type ParadaMia,
  type ProximaMarca,
} from "./paradasViaje";
import { hora as horaCorta, type FilaViaje } from "./viajesFormato";
import { apiFetch } from "../../services/apiClient";

const INPUT = "w-full bg-[#0D1719] border border-[#334155] rounded-xl px-3 py-2 text-sm text-white";
const BTN =
  "bg-[#BADC1E] text-[#0D1719] font-bold px-4 py-2 rounded-xl hover:brightness-110 disabled:opacity-50";
const BTN_SEC =
  "border border-[#334155] text-[#cbd5e1] font-semibold px-4 py-2 rounded-xl disabled:opacity-50";

/** "14:20:05" de hoy, como ISO. */
function isoDeHoy(horaLocal: string): string {
  const [h, m, s] = horaLocal.split(":").map(Number);
  const d = new Date();
  d.setHours(h, m, s || 0, 0);
  return d.toISOString();
}

/** Lo que falta marcar, dicho desde la oficina: "Llegada a B" o "Salida de B hacia A". */
const textoOficina = (m: ProximaMarca, paradas: ParadaMia[]) =>
  m.accion === "llegada-mia"
    ? `Llegada a ${paradas[m.orden].lugar}${m.cierra ? " (termina el viaje)" : ""}`
    : `Salida de ${paradas[m.orden].lugar} hacia ${paradas[m.orden + 1].lugar}`;

const horaAhora = () => new Date().toTimeString().slice(0, 8);

function ListaDeDescansos({ descansos }: { descansos: DescansoMio[] }) {
  if (descansos.length === 0) return <p className="text-sm text-[#94a3b8]">Sin descansos.</p>;
  return (
    <ul className="divide-y divide-[#2a2e37]">
      {descansos.map((d) => (
        <li key={d.inicio_en} className="py-2 flex flex-wrap items-baseline gap-x-3 text-sm">
          <span className="font-semibold text-white">{d.motivo || "Descanso"}</span>
          <span className="text-[#94a3b8]">{d.donde}</span>
          <span className="font-mono text-xs text-[#94a3b8]">
            {horaCorta(d.inicio_en)} – {d.fin_en ? horaCorta(d.fin_en) : "ahora"}
          </span>
          <span className="text-xs text-[#94a3b8]">
            {d.conductor_nombre ?? ""} · marcado por{" "}
            {d.inicio_por === "oficina" ? "la oficina" : "el conductor"}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function AccionesEncargado({
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
  const descansos = viaje.descansos ?? [];
  const abierto = descansoAbierto(descansos);
  // El del relevo que no maneja no frena la unidad: la oficina lo termina señalándolo, con motivo.
  const abiertos = descansos.filter((d) => !d.fin_en);
  const paradas = viaje.paradas ?? [];
  const marca = proximaMarca(paradas);
  const [motivo, setMotivo] = useState("");
  const [otro, setOtro] = useState("");
  const [formAbierto, setFormAbierto] = useState(false);
  const [hora, setHora] = useState(horaAhora());
  const [medidor, setMedidor] = useState("");
  const [motivoMarca, setMotivoMarca] = useState("");
  const [motivoFin, setMotivoFin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  const mandar = async (ruta: string, cuerpo: object, despues?: () => void) => {
    if (guardando) return;
    setGuardando(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/erp/combustible/viajes/${viaje.id}/${ruta}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cuerpo),
      });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(r.error || r.message || r.errors?.[0]?.message || "No se pudo guardar.");
        return;
      }
      despues?.();
      await onCambio();
    } finally {
      setGuardando(false);
    }
  };

  const textoMotivo = motivoGuardado(motivo, otro);
  const motivoDescansoValido = textoMotivo.length >= 3;
  const medidorNumero = medidor.trim() === "" ? null : Number(medidor);
  const marcaValida =
    motivoMarca.trim().length >= 3 &&
    hora !== "" &&
    (viaje.tipo_medidor === null || medidorNumero !== null);

  return (
    <div className="rounded-2xl bg-[#192526] border border-[#2a2e37] p-4 space-y-3">
      <p className="text-xs uppercase tracking-widest text-[#94a3b8]">Descansos</p>
      <ListaDeDescansos descansos={descansos} />

      {puedeEditar && viaje.estado === "en_curso" && (
        <div className="space-y-3 border-t border-[#2a2e37] pt-3">
          {abierto ? (
            <div className="space-y-2">
              {abiertos.map((d) =>
                d.detiene === false && d.id !== undefined ? (
                  <div key={d.id} className="space-y-2">
                    <input
                      aria-label={`Motivo para terminar el descanso de ${d.conductor_nombre ?? "la otra persona"}`}
                      placeholder={`Por qué terminas el descanso de ${d.conductor_nombre ?? "la otra persona"}`}
                      maxLength={200}
                      value={motivoFin}
                      onChange={(e) => setMotivoFin(e.target.value)}
                      className={INPUT}
                    />
                    <button
                      className={BTN_SEC}
                      disabled={guardando || motivoFin.trim().length < 3}
                      onClick={() =>
                        void mandar(
                          "descanso/terminar",
                          { descanso_id: d.id, motivo: motivoFin.trim() },
                          () => setMotivoFin("")
                        )
                      }
                    >
                      Terminar descanso de {d.conductor_nombre ?? "la otra persona"} (encargado)
                    </button>
                  </div>
                ) : (
                  <button
                    key={d.id ?? "volante"}
                    className={BTN_SEC}
                    disabled={guardando}
                    onClick={() => void mandar("descanso/terminar", {})}
                  >
                    Terminar descanso (encargado)
                  </button>
                )
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-2">
                {MOTIVOS_DESCANSO.map((m) => (
                  <button
                    key={m}
                    aria-pressed={motivo === m}
                    onClick={() => setMotivo(m)}
                    className={`px-3 py-1 rounded-full border text-sm font-semibold ${
                      motivo === m
                        ? "border-violet-400 bg-violet-500/20 text-violet-200"
                        : "border-[#334155] text-[#cbd5e1]"
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
              {pideDetalle(motivo) && (
                <input
                  aria-label="Motivo del descanso"
                  placeholder="Escribe el motivo"
                  maxLength={maxDetalle(motivo)}
                  value={otro}
                  onChange={(e) => setOtro(e.target.value)}
                  className={INPUT}
                />
              )}
              <button
                className={BTN_SEC}
                disabled={guardando || !motivoDescansoValido}
                onClick={() =>
                  void mandar("descanso", { motivo: textoMotivo }, () => {
                    setMotivo("");
                    setOtro("");
                  })
                }
              >
                <Moon className="inline w-4 h-4 mr-1" aria-hidden />
                Marcar descanso (encargado)
              </button>
              <p className="text-xs text-[#94a3b8]">
                El motivo es obligatorio cuando lo marca el encargado.
              </p>
            </div>
          )}

          {marca && !abierto && !formAbierto && (
            <button
              className={BTN_SEC}
              onClick={() => {
                setHora(horaAhora());
                setFormAbierto(true);
              }}
            >
              Marcar por el conductor: {textoOficina(marca, paradas)}
            </button>
          )}
          {marca && !abierto && formAbierto && (
            <div className="rounded-xl border border-amber-500/40 p-3 space-y-2">
              <p className="text-sm text-amber-200">
                {textoOficina(marca, paradas)}. Queda anotado como marcado por la oficina.
              </p>
              <label className="block text-xs text-[#94a3b8]" htmlFor="enc-hora">
                Hora real
              </label>
              <input
                id="enc-hora"
                type="time"
                step="1"
                value={hora}
                onChange={(e) => setHora(e.target.value)}
                className={INPUT}
              />
              {viaje.tipo_medidor !== null && (
                <>
                  <label className="block text-xs text-[#94a3b8]" htmlFor="enc-medidor">
                    {etiquetaMedidor}
                  </label>
                  <input
                    id="enc-medidor"
                    inputMode="decimal"
                    value={medidor}
                    onChange={(e) => setMedidor(e.target.value)}
                    className={INPUT}
                  />
                </>
              )}
              <label className="block text-xs text-[#94a3b8]" htmlFor="enc-motivo">
                Motivo (obligatorio)
              </label>
              <input
                id="enc-motivo"
                value={motivoMarca}
                maxLength={500}
                placeholder="Ej. el conductor no tenía señal"
                onChange={(e) => setMotivoMarca(e.target.value)}
                className={INPUT}
              />
              <div className="flex gap-2">
                <button
                  className={BTN}
                  disabled={guardando || !marcaValida}
                  onClick={() =>
                    void mandar(
                      marca.accion === "llegada-mia" ? "llegada" : "salida",
                      {
                        medidor: medidorNumero,
                        orden: marca.orden,
                        [marca.accion === "llegada-mia" ? "llegada_en" : "salida_en"]:
                          isoDeHoy(hora),
                        motivo: motivoMarca.trim(),
                      },
                      () => {
                        setFormAbierto(false);
                        setMedidor("");
                        setMotivoMarca("");
                      }
                    )
                  }
                >
                  Marcar
                </button>
                <button className={BTN_SEC} onClick={() => setFormAbierto(false)}>
                  Cancelar
                </button>
              </div>
            </div>
          )}
          {abierto && marca && (
            <p className="text-xs text-[#94a3b8]">Termina el descanso para marcar el recorrido.</p>
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
