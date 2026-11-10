// Los tres botones de la ventana del viaje (arriba de «Ubicación»): actualizar la ubicación,
// registrar una llegada y registrar una salida. Sin orden de registro: se elige la parada, se marca
// «Ahora» o «Fue antes» con su fecha y hora, y solo se cuida que las horas no se crucen. Es de
// oficina, con señal: el celular del conductor tiene su propio camino.
import { Check, LogIn, LogOut, MapPin } from "lucide-react";
import { useRef, useState } from "react";

import {
  cuerpoDeMarca,
  errorDeMarca,
  paradaInicial,
  paradasElegibles,
  pideMedidor,
  type EntradaMarca,
  type QueMarca,
} from "./marcasLogica";
import { maxDetalle, MOTIVOS_DESCANSO, pideDetalle } from "./motivosDescanso";
import { aValorLocal } from "./ponerAlDiaLogica";
import { diaHora, type FilaViaje } from "./viajesFormato";
import { apiFetch } from "../../services/apiClient";

const INPUT =
  "w-full bg-[#0D1719] border border-[#334155] rounded-xl px-3 py-2 text-sm text-white [color-scheme:dark]";
const BTN =
  "bg-[#BADC1E] text-[#0D1719] font-bold px-4 py-2 rounded-xl hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed";
const ETIQUETA = "block text-xs uppercase tracking-wide text-[#94a3b8] mb-1";
const MOTIVOS_RAPIDOS = ["Se olvidó de marcar", "Sin señal", "Registro atrasado"];

export type PanelAbierto = "ubicacion" | QueMarca | null;

const chip = (activo: boolean) =>
  `px-3 py-1 rounded-full border text-sm font-semibold ${
    activo
      ? "border-[#BADC1E] text-[#BADC1E] bg-[#BADC1E]/10"
      : "border-[#334155] text-[#cbd5e1] hover:border-[#BADC1E]"
  }`;

const entradaInicial = (viaje: FilaViaje, que: QueMarca): EntradaMarca => ({
  que,
  orden: paradaInicial(viaje.paradas ?? [], que) ?? 1,
  momento: "ahora",
  horaLocal: aValorLocal(Date.now()),
  motivo: "",
  reemplazar: false,
  medidor: "",
  descanso: { activo: false, motivo: "Dormir", detalle: "", desde: "", hasta: "" },
});

export function AccionesViaje({
  viaje,
  panel,
  onPanel,
  onCambio,
  etiquetaMedidor,
}: {
  viaje: FilaViaje;
  panel: PanelAbierto;
  onPanel: (p: PanelAbierto) => void;
  onCambio: () => Promise<void>;
  etiquetaMedidor: string;
}) {
  const p = viaje.paradas ?? [];
  // En una ruta A → B → A la salida de B es la del retorno.
  const retorno = p.length === 3 && p[2].lugar_id === p[0].lugar_id;
  const botones: {
    id: Exclude<PanelAbierto, null>;
    texto: string;
    icono: typeof MapPin;
    color: string;
  }[] = [
    { id: "ubicacion", texto: "Actualizar ubicación", icono: MapPin, color: "text-sky-400" },
    { id: "llegada", texto: "Registrar llegada", icono: LogIn, color: "text-emerald-400" },
    {
      id: "salida",
      texto: retorno ? "Registrar salida de retorno" : "Registrar salida",
      icono: LogOut,
      color: "text-amber-400",
    },
  ];
  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-3">
        {botones.map((b) => (
          <button
            key={b.id}
            type="button"
            aria-pressed={panel === b.id}
            onClick={() => onPanel(panel === b.id ? null : b.id)}
            className={`flex items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-bold text-white ${
              panel === b.id
                ? "border-[#BADC1E] bg-[#BADC1E]/25"
                : "border-[#BADC1E]/50 bg-[#BADC1E]/10 hover:bg-[#BADC1E]/20"
            }`}
          >
            <b.icono className={`w-4 h-4 ${b.color}`} aria-hidden />
            {b.texto}
          </button>
        ))}
      </div>
      {(panel === "llegada" || panel === "salida") && (
        <PanelMarca
          key={panel}
          viaje={viaje}
          que={panel}
          etiquetaMedidor={etiquetaMedidor}
          onCambio={onCambio}
        />
      )}
    </div>
  );
}

function PanelMarca({
  viaje,
  que,
  onCambio,
  etiquetaMedidor,
}: {
  viaje: FilaViaje;
  que: QueMarca;
  onCambio: () => Promise<void>;
  etiquetaMedidor: string;
}) {
  const paradas = viaje.paradas ?? [];
  const [e, setE] = useState<EntradaMarca>(() => entradaInicial(viaje, que));
  const [verMedidor, setVerMedidor] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  // Un identificador por intento: si el envío se repite (doble clic, red lenta) no suma dos marcas.
  const uuid = useRef<string>(crypto.randomUUID());
  const poner = (c: Partial<EntradaMarca>) => setE((x) => ({ ...x, ...c }));
  const ponerDescanso = (c: Partial<EntradaMarca["descanso"]>) =>
    setE((x) => ({ ...x, descanso: { ...x.descanso, ...c } }));

  const elegibles = paradasElegibles(paradas, que);
  const actual = elegibles.find((x) => x.orden === e.orden);
  const existe = !!actual?.marcaEn;
  const esExtremo = e.orden === 0 || e.orden === paradas.length - 1;
  // El odómetro del origen y de la llegada final ya puestos se corrige editando el viaje.
  const puedeMedidor = !(existe && esExtremo);
  const medidorObligatorio = pideMedidor(paradas, e, viaje.medidor_inicio);
  const pideMotivo = e.momento === "antes" || existe;
  const d = e.descanso;

  const registrar = async () => {
    if (guardando) return;
    const problema = errorDeMarca(e, paradas, viaje.medidor_inicio, Date.now(), etiquetaMedidor);
    if (problema) {
      setError(problema);
      setAviso(null);
      return;
    }
    setGuardando(true);
    setError(null);
    setAviso(null);
    try {
      const res = await apiFetch(`/api/erp/viajes/${viaje.id}/marcas`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cuerpoDeMarca(e, uuid.current)),
      });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(r.message || r.error || r.errors?.[0]?.message || "No se pudo guardar.");
        return;
      }
      uuid.current = crypto.randomUUID();
      setE(entradaInicial(viaje, que));
      setVerMedidor(false);
      setAviso(que === "llegada" ? "Llegada registrada." : "Salida registrada.");
      await onCambio();
    } finally {
      setGuardando(false);
    }
  };

  return (
    <div className="rounded-2xl bg-[#192526] border border-[#2a2e37] p-4 space-y-3">
      <div>
        <p className={ETIQUETA}>
          {que === "llegada" ? "¿A qué parada llegó?" : "¿De qué parada salió?"}
        </p>
        <div className="flex flex-wrap gap-2">
          {elegibles.map((x) => (
            <button
              key={x.orden}
              type="button"
              aria-pressed={x.orden === e.orden}
              className={chip(x.orden === e.orden)}
              onClick={() => poner({ orden: x.orden, reemplazar: false, medidor: "" })}
            >
              {x.marcaEn && <Check className="inline w-3.5 h-3.5 mr-1" aria-hidden />}
              {x.texto}
              {x.marcaEn && (
                <span className="ml-1 font-normal opacity-80">{diaHora(x.marcaEn)}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      {existe && (
        <label className="flex items-center gap-2 text-sm text-amber-200">
          <input
            type="checkbox"
            checked={e.reemplazar}
            onChange={(ev) => poner({ reemplazar: ev.target.checked })}
          />
          Esa marca ya está registrada ({diaHora(actual?.marcaEn as string)}): reemplazarla
        </label>
      )}

      <div>
        <p className={ETIQUETA}>¿Cuándo?</p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={chip(e.momento === "ahora")}
            onClick={() => poner({ momento: "ahora" })}
          >
            Ahora
          </button>
          <button
            type="button"
            className={chip(e.momento === "antes")}
            onClick={() => poner({ momento: "antes" })}
          >
            Fue antes
          </button>
        </div>
        {e.momento === "antes" && (
          <input
            aria-label="Fecha y hora"
            type="datetime-local"
            value={e.horaLocal}
            onChange={(ev) => poner({ horaLocal: ev.target.value })}
            className={`${INPUT} mt-2 sm:max-w-xs`}
          />
        )}
      </div>

      {pideMotivo && (
        <div>
          <p className={ETIQUETA}>
            {existe ? "¿Por qué se cambia?" : "¿Por qué se registra ahora?"}
          </p>
          <div className="flex flex-wrap gap-2">
            {MOTIVOS_RAPIDOS.map((m) => (
              <button
                key={m}
                type="button"
                className={chip(e.motivo === m)}
                onClick={() => poner({ motivo: m })}
              >
                {m}
              </button>
            ))}
          </div>
          <input
            aria-label="Motivo"
            maxLength={500}
            placeholder="O escríbelo"
            value={e.motivo}
            onChange={(ev) => poner({ motivo: ev.target.value })}
            className={`${INPUT} mt-2`}
          />
        </div>
      )}

      <label className="flex items-center gap-2 text-sm text-white">
        <input
          type="checkbox"
          checked={d.activo}
          onChange={(ev) => ponerDescanso({ activo: ev.target.checked })}
        />
        {que === "llegada"
          ? "Hubo un descanso en el camino"
          : "Hubo un descanso durante la estadía"}
      </label>
      {d.activo && (
        <div className="rounded-xl border border-[#2a2e37] p-3 space-y-2">
          <div className="flex flex-wrap gap-2">
            {MOTIVOS_DESCANSO.map((m) => (
              <button
                key={m}
                type="button"
                className={chip(d.motivo === m)}
                onClick={() => ponerDescanso({ motivo: m })}
              >
                {m}
              </button>
            ))}
          </div>
          {pideDetalle(d.motivo) && (
            <input
              aria-label="Detalle del descanso"
              maxLength={maxDetalle(d.motivo)}
              placeholder="Qué pasó"
              value={d.detalle}
              onChange={(ev) => ponerDescanso({ detalle: ev.target.value })}
              className={INPUT}
            />
          )}
          <div className="grid gap-2 sm:grid-cols-2">
            <div>
              <label className={ETIQUETA}>
                Desde
                <input
                  type="datetime-local"
                  value={d.desde}
                  onChange={(ev) => ponerDescanso({ desde: ev.target.value })}
                  className={INPUT}
                />
              </label>
            </div>
            <div>
              <label className={ETIQUETA}>
                Hasta (vacío si sigue)
                <input
                  type="datetime-local"
                  value={d.hasta}
                  onChange={(ev) => ponerDescanso({ hasta: ev.target.value })}
                  className={INPUT}
                />
              </label>
            </div>
          </div>
        </div>
      )}

      {puedeMedidor &&
        (verMedidor || medidorObligatorio ? (
          <div className="sm:max-w-xs">
            <label className={ETIQUETA}>
              {etiquetaMedidor} {medidorObligatorio ? "(obligatorio)" : "(opcional)"}
              <input
                inputMode="decimal"
                value={e.medidor}
                onChange={(ev) => poner({ medidor: ev.target.value })}
                className={INPUT}
              />
            </label>
          </div>
        ) : (
          <button
            type="button"
            className="text-sm text-[#BADC1E] underline"
            onClick={() => setVerMedidor(true)}
          >
            Agregar {etiquetaMedidor.toLowerCase()}
          </button>
        ))}

      <button className={BTN} disabled={guardando} onClick={() => void registrar()}>
        Registrar
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
  );
}
