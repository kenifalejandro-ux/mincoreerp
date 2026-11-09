// Lo que el encargado hace por el conductor desde el detalle de un viaje en curso: marcar o terminar
// su descanso de ahora. Va con quién lo hizo y por qué: el motivo es obligatorio. Lo que ya pasó
// (llegadas, salidas y descansos pasados) se registra en «Poner al día». Es de oficina (con señal):
// el celular del conductor tiene su propio camino.
import { Moon } from "lucide-react";
import { useState } from "react";

import { maxDetalle, motivoGuardado, MOTIVOS_DESCANSO, pideDetalle } from "./motivosDescanso";
import { descansoAbierto, type DescansoMio } from "./paradasViaje";
import { diaHora, type FilaViaje } from "./viajesFormato";
import { apiFetch } from "../../services/apiClient";

const INPUT = "w-full bg-[#0D1719] border border-[#334155] rounded-xl px-3 py-2 text-sm text-white";
const BTN_SEC =
  "border border-[#334155] text-[#cbd5e1] font-semibold px-4 py-2 rounded-xl disabled:opacity-50";

function ListaDeDescansos({ descansos }: { descansos: DescansoMio[] }) {
  if (descansos.length === 0) return <p className="text-sm text-[#94a3b8]">Sin descansos.</p>;
  return (
    <ul className="divide-y divide-[#2a2e37]">
      {descansos.map((d) => (
        <li key={d.inicio_en} className="py-2 flex flex-wrap items-baseline gap-x-3 text-sm">
          <span className="font-semibold text-white">{d.motivo || "Descanso"}</span>
          <span className="text-[#94a3b8]">{d.donde}</span>
          <span className="font-mono text-xs text-[#94a3b8]">
            {diaHora(d.inicio_en)} – {d.fin_en ? diaHora(d.fin_en) : "ahora"}
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
  puedeEditar,
  onCambio,
}: {
  viaje: FilaViaje;
  puedeEditar: boolean;
  onCambio: () => Promise<void>;
}) {
  const descansos = viaje.descansos ?? [];
  const abierto = descansoAbierto(descansos);
  // El del relevo que no maneja no frena la unidad: la oficina lo termina señalándolo, con motivo.
  const abiertos = descansos.filter((d) => !d.fin_en);
  const [motivo, setMotivo] = useState("");
  const [otro, setOtro] = useState("");
  const [donde, setDonde] = useState("");
  const [motivoFin, setMotivoFin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  const mandar = async (ruta: string, cuerpo: object, despues?: () => void) => {
    if (guardando) return;
    setGuardando(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/erp/viajes/${viaje.id}/${ruta}`, {
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
              <input
                aria-label="¿Dónde? (opcional)"
                placeholder="¿Dónde? (opcional)"
                maxLength={160}
                value={donde}
                onChange={(e) => setDonde(e.target.value)}
                className={INPUT}
              />
              <button
                className={BTN_SEC}
                disabled={guardando || !motivoDescansoValido}
                onClick={() =>
                  void mandar(
                    "descanso",
                    { motivo: textoMotivo, ...(donde.trim() ? { donde: donde.trim() } : {}) },
                    () => {
                      setMotivo("");
                      setOtro("");
                      setDonde("");
                    }
                  )
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
