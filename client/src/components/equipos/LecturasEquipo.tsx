// client/src/components/equipos/LecturasEquipo.tsx
//
// Las lecturas del medidor de la unidad (horómetro u odómetro, migración 0187): la última, el
// formulario para registrar una y el historial con las anuladas. Es de Flota y funciona solo: no
// necesita Combustible ni Viajes.
//
// Va en una ventana flotante (se consulta con la tabla de atrás). Lectura la ve; registrar y anular
// es de admin y operador (`puedeEscribir`).
//
// Registrar pasa por la cola sin señal: el uuid se fija al abrir (y se renueva tras cada registro)
// para que un doble toque o un reintento no dejen dos filas. Anular NO se encola: es una corrección
// que se hace con la lectura a la vista.
import { useCallback, useEffect, useRef, useState } from "react";

import { apiFetch } from "../../services/apiClient";
import VentanaFlotante from "../comunes/VentanaFlotante";

interface Lectura {
  id: number;
  tipo: "horometro" | "odometro";
  valor: number;
  leido_en: string;
  origen: string;
  registrado_por: string | null;
  anulada_en: string | null;
  motivo_anulacion: string | null;
  anulada_por_nombre: string | null;
}

const UNIDAD = { horometro: "h", odometro: "km" } as const;
const ETIQUETA = { horometro: "Horómetro", odometro: "Odómetro" } as const;
const ORIGEN: Record<string, string> = {
  manual: "Manual",
  checklist: "Checklist",
  vale: "Vale",
  viaje: "Viaje",
};

const fecha = (iso: string) =>
  new Date(iso).toLocaleString("es-PE", { dateStyle: "short", timeStyle: "short" });

const numero = (n: number) => n.toLocaleString("es-PE", { maximumFractionDigits: 2 });

async function mensajeDe(res: Response, porDefecto: string): Promise<string> {
  const body = await res.json().catch(() => null);
  if (Array.isArray(body?.errors) && body.errors.length > 0) {
    return body.errors.map((e: { message: string }) => e.message).join(", ");
  }
  return body?.message ?? porDefecto;
}

export default function LecturasEquipo({
  equipoId,
  placa,
  tipoMedidor,
  puedeEscribir,
  onCerrar,
  onCambio,
}: {
  equipoId: number;
  placa: string;
  tipoMedidor: "horometro" | "odometro" | null;
  puedeEscribir: boolean;
  onCerrar: () => void;
  /** Se llama cuando una lectura quedó registrada o anulada en el servidor: la lista de unidades
   *  recarga para mostrar la última lectura al día. */
  onCambio?: () => void;
}) {
  const [lecturas, setLecturas] = useState<Lectura[] | null>(null);
  const [errorCarga, setErrorCarga] = useState(false);
  const [valor, setValor] = useState("");
  const [leidoEn, setLeidoEn] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [mensaje, setMensaje] = useState<{ tipo: "ok" | "error"; texto: string } | null>(null);
  const [anulando, setAnulando] = useState<number | null>(null);
  const [motivo, setMotivo] = useState("");
  // Fijo hasta que el registro sale bien: dos toques seguidos comparten clave y el servidor los une.
  const clienteUuid = useRef(crypto.randomUUID());

  // Sube para volver a pedir el historial (tras registrar o anular).
  const [recarga, setRecarga] = useState(0);
  const cargar = useCallback(async () => setRecarga((n) => n + 1), []);

  useEffect(() => {
    let vigente = true;
    (async () => {
      try {
        const res = await apiFetch(`/api/erp/equipos/${equipoId}/lecturas?limite=50`);
        if (!res.ok) throw new Error();
        const body = (await res.json()) as { data: Lectura[] };
        if (vigente) {
          setLecturas(body.data);
          setErrorCarga(false);
        }
      } catch {
        if (vigente) setErrorCarga(true);
      }
    })();
    return () => {
      vigente = false;
    };
  }, [equipoId, recarga]);

  const ultima = lecturas?.find((l) => l.anulada_en === null) ?? null;
  const tipo = tipoMedidor;

  async function registrar(e: React.FormEvent) {
    e.preventDefault();
    if (enviando) return;
    const n = Number(valor.replace(",", "."));
    if (valor.trim() === "" || !Number.isFinite(n) || n < 0) {
      setMensaje({ tipo: "error", texto: "Escribe un valor válido (0 o más)." });
      return;
    }
    setEnviando(true);
    setMensaje(null);
    try {
      const res = await apiFetch(`/api/erp/equipos/${equipoId}/lecturas`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          valor: n,
          ...(leidoEn ? { leido_en: new Date(leidoEn).toISOString() } : {}),
          cliente_uuid: clienteUuid.current,
        }),
      });
      // 202 = sin señal: quedó en la cola de este equipo y se envía sola al volver la red.
      if (res.status === 202) {
        setMensaje({
          tipo: "ok",
          texto:
            "Sin conexión: la lectura quedó guardada en este equipo y se enviará cuando vuelva la señal.",
        });
      } else if (!res.ok) {
        setMensaje({ tipo: "error", texto: await mensajeDe(res, "No se pudo registrar.") });
        return;
      } else {
        setMensaje({ tipo: "ok", texto: "Lectura registrada." });
        onCambio?.();
        await cargar();
      }
      clienteUuid.current = crypto.randomUUID();
      setValor("");
      setLeidoEn("");
    } catch {
      setMensaje({ tipo: "error", texto: "No se pudo registrar." });
    } finally {
      setEnviando(false);
    }
  }

  async function anular(id: number) {
    if (enviando) return;
    if (motivo.trim().length < 3) {
      setMensaje({ tipo: "error", texto: "Escribe el motivo (mínimo 3 letras)." });
      return;
    }
    setEnviando(true);
    setMensaje(null);
    try {
      const res = await apiFetch(`/api/erp/equipos/${equipoId}/lecturas/${id}/anular`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ motivo: motivo.trim() }),
      });
      if (!res.ok) {
        setMensaje({ tipo: "error", texto: await mensajeDe(res, "No se pudo anular.") });
        return;
      }
      setMensaje({ tipo: "ok", texto: "Lectura anulada." });
      setAnulando(null);
      setMotivo("");
      onCambio?.();
      await cargar();
    } catch {
      setMensaje({ tipo: "error", texto: "No se pudo anular: se necesita conexión." });
    } finally {
      setEnviando(false);
    }
  }

  return (
    <VentanaFlotante
      id={`equipo-lecturas-${equipoId}`}
      titulo={`Lecturas — ${placa}`}
      subtitulo={tipo ? `${ETIQUETA[tipo]} de la unidad` : "Medidor de la unidad"}
      onCerrar={onCerrar}
      anchoInicial={600}
      altoInicial={600}
    >
      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-5 text-sm">
        {tipo === null ? (
          <p className="text-[#fcd34d]">
            Esta unidad no tiene medidor configurado. Elige horómetro u odómetro en su ficha para
            poder registrar lecturas.
          </p>
        ) : (
          <section className="border border-[#334155] rounded-xl p-3 bg-[#0D1719]">
            <div className="text-xs font-bold uppercase tracking-wide text-[#94a3b8]">
              Última lectura
            </div>
            {ultima ? (
              <>
                <div className="text-2xl font-bold text-white font-mono">
                  {numero(ultima.valor)}{" "}
                  <span className="text-base text-[#94a3b8]">{UNIDAD[ultima.tipo]}</span>
                </div>
                <div className="text-xs text-[#94a3b8]">{fecha(ultima.leido_en)}</div>
              </>
            ) : (
              <p className="text-[#94a3b8]">
                {lecturas === null && !errorCarga ? "Cargando..." : "Todavía no hay lecturas."}
              </p>
            )}
          </section>
        )}

        {puedeEscribir && tipo !== null && (
          <form onSubmit={registrar} className="space-y-3">
            <h4 className="text-xs font-bold uppercase tracking-wide text-[#94a3b8]">
              Registrar lectura
            </h4>
            <div className="flex flex-wrap gap-3">
              <label className="flex-1 min-w-[140px] text-xs text-[#94a3b8]">
                {ETIQUETA[tipo]} ({UNIDAD[tipo]})
                <input
                  inputMode="decimal"
                  value={valor}
                  onChange={(e) => setValor(e.target.value)}
                  className="mt-1 w-full bg-[#0D1719] border border-[#334155] rounded-lg px-3 py-2 text-white font-mono"
                />
              </label>
              <label className="flex-1 min-w-[180px] text-xs text-[#94a3b8]">
                Cuándo (opcional: vacío = ahora)
                <input
                  type="datetime-local"
                  value={leidoEn}
                  onChange={(e) => setLeidoEn(e.target.value)}
                  className="mt-1 w-full bg-[#0D1719] border border-[#334155] rounded-lg px-3 py-2 text-white"
                />
              </label>
            </div>
            <button
              type="submit"
              disabled={enviando}
              className="bg-[#BADC1E] text-[#0D1719] font-bold px-4 py-2 rounded-xl hover:brightness-110 disabled:opacity-50"
            >
              {enviando ? "Guardando..." : "Registrar"}
            </button>
          </form>
        )}

        {mensaje && (
          <p className={mensaje.tipo === "ok" ? "text-[#BADC1E]" : "text-[#fca5a5]"} role="status">
            {mensaje.texto}
          </p>
        )}

        <section>
          <h4 className="text-xs font-bold uppercase tracking-wide text-[#94a3b8] mb-2">
            Historial
          </h4>
          {errorCarga ? (
            <p className="text-[#fca5a5]">No se pudo cargar el historial.</p>
          ) : lecturas === null ? (
            <p className="text-[#94a3b8]">Cargando...</p>
          ) : lecturas.length === 0 ? (
            <p className="text-[#94a3b8]">Esta unidad todavía no tiene lecturas.</p>
          ) : (
            <ul className="space-y-2">
              {lecturas.map((l) => (
                <li
                  key={l.id}
                  className={`border border-[#334155] rounded-xl p-3 bg-[#0D1719] ${
                    l.anulada_en ? "opacity-60" : ""
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span
                      className={`font-mono font-semibold text-white ${
                        l.anulada_en ? "line-through" : ""
                      }`}
                    >
                      {numero(l.valor)} {UNIDAD[l.tipo]}
                    </span>
                    {l.anulada_en ? (
                      <span className="text-[10px] font-bold uppercase bg-[#7f1d1d] text-[#fecaca] px-2 py-0.5 rounded-full">
                        Anulada
                      </span>
                    ) : (
                      puedeEscribir && (
                        <button
                          type="button"
                          onClick={() => {
                            setAnulando(anulando === l.id ? null : l.id);
                            setMotivo("");
                            setMensaje(null);
                          }}
                          className="text-xs text-[#94a3b8] hover:text-[#fca5a5] underline"
                        >
                          Anular
                        </button>
                      )
                    )}
                  </div>
                  <div className="text-xs text-[#94a3b8]">
                    {fecha(l.leido_en)} · {ORIGEN[l.origen] ?? l.origen}
                    {l.registrado_por ? ` · ${l.registrado_por}` : ""}
                  </div>
                  {l.anulada_en && (
                    <div className="text-xs text-[#cbd5e1] mt-1">
                      Anulada: {l.motivo_anulacion}
                      {l.anulada_por_nombre ? ` · ${l.anulada_por_nombre}` : ""}
                    </div>
                  )}
                  {anulando === l.id && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <input
                        value={motivo}
                        onChange={(e) => setMotivo(e.target.value)}
                        placeholder="Motivo de la anulación"
                        maxLength={300}
                        className="flex-1 min-w-[160px] bg-[#0D1719] border border-[#334155] rounded-lg px-3 py-1.5 text-white"
                      />
                      <button
                        type="button"
                        disabled={enviando}
                        onClick={() => void anular(l.id)}
                        className="bg-[#BADC1E] text-[#0D1719] font-bold px-3 py-1.5 rounded-lg disabled:opacity-50"
                      >
                        Confirmar
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </VentanaFlotante>
  );
}
