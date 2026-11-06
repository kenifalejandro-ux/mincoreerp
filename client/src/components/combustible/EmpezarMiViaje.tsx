// «Empezar un viaje» (0179): el conductor crea e inicia su propio viaje desde el celular, en cinco
// pasos (tipo, unidad, ruta, relevo y confirmar con el odómetro de salida). La hora de salida no se
// pide: la pone el servidor. Los chequeos (medidor, traslape, viaje ya asignado) son los del servidor.
import { useRef, useState } from "react";

import {
  PASOS,
  borradorInicial,
  conRutaDeUnidad,
  cuerpoCrearMiViaje,
  errorDelPaso,
  paradasFinales,
  unidadRegistrada,
  type BorradorViaje,
  type CatalogoViaje,
  type PasoViaje,
  type TipoViaje,
} from "./empezarViaje";
import { apiFetch } from "../../services/apiClient";

const BTN_LIMA =
  "w-full flex items-center justify-center gap-2 bg-[#BADC1E] text-[#0D1719] font-extrabold text-lg py-4 rounded-2xl hover:brightness-110 disabled:opacity-50";
const BTN_SECUNDARIO =
  "w-full flex items-center justify-center gap-2 border border-[#334155] text-[#cbd5e1] font-semibold py-3 rounded-2xl hover:text-white";
const CAMPO =
  "w-full bg-[#0D1719] border border-[#334155] rounded-xl px-4 py-3 text-lg text-white min-h-[50px]";
const ETIQUETA = "block text-xs font-bold uppercase tracking-wide text-[#94a3b8] mb-1.5";

const TIPOS: { id: TipoViaje; titulo: string; texto: string }[] = [
  { id: "ida", titulo: "Solo ida", texto: "Termina al llegar al destino." },
  {
    id: "ida_vuelta",
    titulo: "Ida y vuelta",
    texto: "Termina al volver al punto de salida. Es un solo viaje.",
  },
  {
    id: "varias",
    titulo: "Varias paradas",
    texto: "Por ejemplo A → B → C → A. Termina en la última parada.",
  },
];

function Opcion({
  activa,
  onClick,
  children,
}: {
  activa: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={activa}
      className={`w-full text-left rounded-2xl border p-4 min-h-[64px] ${
        activa ? "border-[#BADC1E] bg-[#17261c]" : "border-[#334155] bg-[#14201f]"
      }`}
    >
      {children}
    </button>
  );
}

export function EmpezarMiViaje({
  catalogo,
  nombreConductor,
  onCancelar,
  onCreado,
}: {
  catalogo: CatalogoViaje;
  nombreConductor: string;
  onCancelar: () => void;
  /** Se llamó al servidor y el viaje quedó creado (o ya existía): el padre vuelve a leer sus viajes. */
  onCreado: () => void;
}) {
  const [b, setB] = useState<BorradorViaje>(() => borradorInicial(catalogo, nombreConductor));
  const [paso, setPaso] = useState<PasoViaje>("tipo");
  const [editaRuta, setEditaRuta] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  // Un identificador por intento de crear: el reintento de un envío que no se sabe si llegó no duplica.
  const idCliente = useRef(crypto.randomUUID());

  const lugar = (id: number | null) => catalogo.lugares.find((l) => l.id === id)?.nombre ?? "—";
  const unidad = unidadRegistrada(catalogo, b.unidad);
  const error = errorDelPaso(paso, b, catalogo);
  // Con la odómetro vacío o la placa a medio escribir no se grita: el botón solo queda apagado.
  const callado =
    (paso === "confirmar" && b.odometro === "") ||
    (paso === "unidad" && b.unidad === "nueva" && !b.placa);
  const i = PASOS.indexOf(paso);
  const set = (cambios: Partial<BorradorViaje>) => setB((v) => ({ ...v, ...cambios }));
  const sinRuta = b.unidad === "nueva" || !unidad?.ruta;
  const lugaresOpciones = (
    <>
      <option value="">Elegir…</option>
      {catalogo.lugares.map((l) => (
        <option key={l.id} value={l.id}>
          {l.nombre}
        </option>
      ))}
    </>
  );
  const selector = (
    valor: number | null,
    onChange: (id: number | null) => void,
    etiqueta: string
  ) => (
    <div>
      <label className={ETIQUETA}>
        {etiqueta}
        <select
          className={`${CAMPO} mt-1.5 normal-case tracking-normal font-normal`}
          value={valor ?? ""}
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        >
          {lugaresOpciones}
        </select>
      </label>
    </div>
  );

  const elegirUnidad = (id: number | "nueva") => {
    const u = unidadRegistrada(catalogo, id);
    setEditaRuta(false);
    setB((v) => conRutaDeUnidad({ ...v, unidad: id }, u));
  };

  const salir = async () => {
    if (guardando || error) return;
    setGuardando(true);
    setAviso(null);
    try {
      const res = await apiFetch("/api/erp/viajes/crear-mio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cuerpoCrearMiViaje(b, idCliente.current)),
      });
      const r = await res.json().catch(() => ({}));
      if (res.status === 409 && r.details?.viaje) {
        // Ya tiene un viaje (la oficina le programó uno): no se creó otro, se le muestra ese.
        onCreado();
        return;
      }
      if (!res.ok) {
        setAviso(r.error || r.message || r.errors?.[0]?.message || "No se pudo crear el viaje.");
        return;
      }
      onCreado();
    } catch {
      setAviso("Sin señal: no se pudo crear el viaje. Inténtalo de nuevo cuando vuelva la señal.");
    } finally {
      setGuardando(false);
    }
  };

  let cuerpo: React.ReactNode;
  if (paso === "tipo") {
    cuerpo = (
      <>
        <h3 className="text-xl font-extrabold text-white">¿Cómo es tu viaje?</h3>
        {TIPOS.map((t) => (
          <Opcion key={t.id} activa={b.tipo === t.id} onClick={() => set({ tipo: t.id })}>
            <b className="block text-white text-base">{t.titulo}</b>
            <span className="text-sm text-[#94a3b8]">{t.texto}</span>
          </Opcion>
        ))}
      </>
    );
  } else if (paso === "unidad") {
    cuerpo = (
      <>
        <h3 className="text-xl font-extrabold text-white">¿Cuál es tu unidad?</h3>
        <p className="text-sm text-[#94a3b8]">
          {catalogo.unidades.some((u) => u.asignada_a_mi)
            ? "Viene marcada la que tienes asignada; puedes cambiarla."
            : "No tienes una unidad asignada. Elige la tuya o regístrala ahora."}
        </p>
        {catalogo.unidades.map((u) => (
          <Opcion key={u.id} activa={b.unidad === u.id} onClick={() => elegirUnidad(u.id)}>
            <b className="text-white">{u.placa}</b>{" "}
            <span className="text-[#94a3b8]">· {u.tipo}</span>
            <span className="block text-xs text-[#94a3b8]">
              {u.ruta ? `Ruta: ${u.ruta.origen} → ${u.ruta.destino}` : "Sin ruta asignada"}
              {u.asignada_a_mi ? " · Asignada a ti" : ""}
            </span>
          </Opcion>
        ))}
        <Opcion activa={b.unidad === "nueva"} onClick={() => elegirUnidad("nueva")}>
          <b className="block text-white">Mi unidad no está registrada</b>
          <span className="text-xs text-[#94a3b8]">Registrarla ahora con su placa</span>
        </Opcion>
        {b.unidad === "nueva" && (
          <div className="rounded-2xl border border-[#BADC1E] bg-[#192526] p-4 space-y-3">
            <label className={ETIQUETA}>
              Placa de la unidad
              <input
                className={`${CAMPO} mt-1.5 font-mono uppercase tracking-widest`}
                maxLength={20}
                autoComplete="off"
                autoCapitalize="characters"
                placeholder="ABC-123"
                value={b.placa}
                onChange={(e) => set({ placa: e.target.value.toUpperCase() })}
              />
            </label>
            <label className={ETIQUETA}>
              Tu nombre
              <input
                className={`${CAMPO} mt-1.5 normal-case tracking-normal font-normal`}
                autoComplete="off"
                value={b.nombre}
                onChange={(e) => set({ nombre: e.target.value })}
              />
            </label>
            <p className="text-xs text-[#94a3b8]">
              Se guarda en Registro de unidades solo con la placa, tu nombre y la ruta que ingreses.
              La oficina completa el resto después.
            </p>
          </div>
        )}
      </>
    );
  } else if (paso === "ruta") {
    const rutaDeEquipos = !sinRuta && !editaRuta && b.tipo !== "varias";
    cuerpo = (
      <>
        <h3 className="text-xl font-extrabold text-white">¿Por dónde vas?</h3>
        {b.tipo === "varias" ? (
          <>
            <p className="text-sm text-[#94a3b8]">Agrega las paradas en orden.</p>
            {b.paradas.map((p, n) => (
              <div key={n} className="flex items-end gap-2">
                <div className="flex-1">
                  {selector(
                    p,
                    (id) => set({ paradas: b.paradas.map((x, k) => (k === n ? id : x)) }),
                    n === 0 ? "Sale de" : `Parada ${n}`
                  )}
                </div>
                {b.paradas.length > 3 && n > 0 && (
                  <button
                    type="button"
                    aria-label={`Quitar parada ${n}`}
                    onClick={() => set({ paradas: b.paradas.filter((_, k) => k !== n) })}
                    className="w-12 h-12 rounded-xl border border-[#334155] text-[#94a3b8] text-xl"
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
            <button
              type="button"
              className="text-[#BADC1E] font-semibold py-2 text-left"
              onClick={() => set({ paradas: [...b.paradas, null] })}
            >
              + Agregar parada
            </button>
          </>
        ) : rutaDeEquipos ? (
          <>
            <div className="rounded-2xl border border-[#334155] bg-[#192526] p-4">
              <p className="text-xs text-[#94a3b8] mb-2">Ruta de tu unidad (de Equipos)</p>
              <p className="text-lg font-bold text-white">
                {lugar(b.sale)} <span className="text-[#BADC1E]">→</span> {lugar(b.llega)}
              </p>
            </div>
            <button
              type="button"
              className="text-[#BADC1E] font-semibold py-2 text-left"
              onClick={() => setEditaRuta(true)}
            >
              Hoy voy por otra ruta
            </button>
          </>
        ) : (
          <>
            <p className="text-sm text-[#94a3b8]">
              {sinRuta
                ? b.unidad === "nueva"
                  ? "Tu unidad es nueva y todavía no tiene ruta: elige de dónde a dónde. Quedará guardada en Registro de unidades."
                  : "Tu unidad no tiene ruta en Equipos: elige de dónde a dónde."
                : "Este cambio vale solo para este viaje; no toca lo que está en Equipos."}
            </p>
            {selector(b.sale, (id) => set({ sale: id }), "Sale de")}
            {selector(b.llega, (id) => set({ llega: id }), b.tipo === "ida" ? "Llega a" : "Va a")}
          </>
        )}
        {b.tipo === "ida_vuelta" && b.sale !== null && (
          <p className="text-xs text-[#94a3b8]">
            Vuelve a <b>{lugar(b.sale)}</b> (el mismo punto de salida).
          </p>
        )}
      </>
    );
  } else if (paso === "relevo") {
    cuerpo = (
      <>
        <h3 className="text-xl font-extrabold text-white">¿Vas con relevo?</h3>
        <p className="text-sm text-[#94a3b8]">El relevo puede tomar el volante en la ruta.</p>
        <Opcion activa={b.relevoId === ""} onClick={() => set({ relevoId: "" })}>
          <b className="text-white">Sin relevo</b>
        </Opcion>
        {catalogo.relevos.map((r) => (
          <Opcion key={r.id} activa={b.relevoId === r.id} onClick={() => set({ relevoId: r.id })}>
            <b className="text-white">{r.nombre}</b>
          </Opcion>
        ))}
      </>
    );
  } else {
    const relevo = catalogo.relevos.find((r) => r.id === b.relevoId);
    cuerpo = (
      <>
        <h3 className="text-xl font-extrabold text-white">Confirma y sal</h3>
        <dl className="rounded-2xl border border-[#334155] bg-[#192526] p-4 space-y-2 text-sm">
          {[
            ["Unidad", b.unidad === "nueva" ? `${b.placa} (unidad nueva)` : (unidad?.placa ?? "—")],
            ["Tipo", TIPOS.find((t) => t.id === b.tipo)?.titulo ?? ""],
            ["Ruta", paradasFinales(b).map(lugar).join(" → ")],
            ["Relevo", relevo?.nombre ?? "Sin relevo"],
            ["Hora de salida", "Ahora (la pone el sistema)"],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3">
              <dt className="text-[#94a3b8]">{k}</dt>
              <dd className="text-right font-semibold text-white">{v}</dd>
            </div>
          ))}
        </dl>
        {b.unidad === "nueva" && (
          <p className="text-xs text-[#94a3b8]">
            Al salir, tu unidad queda registrada con la placa, tu nombre y esta ruta. La oficina
            completa el resto.
          </p>
        )}
        <label className={ETIQUETA}>
          Odómetro de salida (km)
          <input
            className="w-full bg-[#0D1719] border border-[#334155] rounded-xl px-4 py-4 text-2xl font-mono text-white text-center mt-1.5"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0"
            value={b.odometro}
            onChange={(e) => set({ odometro: e.target.value })}
          />
        </label>
      </>
    );
  }

  return (
    <div className="max-w-xl mx-auto space-y-4">
      <div>
        <h2 className="text-2xl font-extrabold text-white">Empezar un viaje</h2>
        <p className="text-sm text-[#94a3b8]">{nombreConductor}</p>
      </div>
      <div className="flex gap-1.5" aria-hidden>
        {PASOS.map((p, n) => (
          <i key={p} className={`flex-1 h-1 rounded ${n <= i ? "bg-[#BADC1E]" : "bg-[#334155]"}`} />
        ))}
      </div>
      <p className="text-xs text-[#94a3b8]">
        Paso {i + 1} de {PASOS.length}
      </p>
      {aviso && (
        <div
          role="alert"
          className="rounded-xl bg-[#192526] border border-[#334155] p-3 text-sm text-[#e2e8f0]"
        >
          {aviso}
        </div>
      )}
      <div className="space-y-3">{cuerpo}</div>
      <div className="space-y-2 pt-2">
        <p className="text-xs text-amber-300 min-h-4">{callado ? "" : error}</p>
        {paso === "confirmar" ? (
          <button
            type="button"
            className={BTN_LIMA}
            disabled={Boolean(error) || guardando}
            onClick={() => void salir()}
          >
            {guardando ? "Saliendo…" : "Salir ahora"}
          </button>
        ) : (
          <button
            type="button"
            className={BTN_LIMA}
            disabled={Boolean(error)}
            onClick={() => setPaso(PASOS[i + 1])}
          >
            Siguiente
          </button>
        )}
        <button
          type="button"
          className={BTN_SECUNDARIO}
          disabled={guardando}
          onClick={() => (i === 0 ? onCancelar() : setPaso(PASOS[i - 1]))}
        >
          {i === 0 ? "Cancelar" : "Atrás"}
        </button>
      </div>
    </div>
  );
}
