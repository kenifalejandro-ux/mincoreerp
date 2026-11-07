// «Empezar un viaje» (0179): el conductor crea e inicia su propio viaje desde el celular, en cinco
// pasos (tipo, unidad, ruta, relevo y confirmar con el odómetro de salida). La hora de salida no se
// pide: la pone el servidor. Los chequeos (medidor, traslape, viaje ya asignado) son los del servidor.
import { useRef, useState } from "react";

import type { CreacionPendiente } from "./creacionPendiente";
import {
  PASOS,
  borradorInicial,
  buscarRelevos,
  buscarUnidades,
  conRutaDeUnidad,
  cuerpoCrearMiViaje,
  errorDelPaso,
  lecturaOdometro,
  nombreDeLugar,
  normalizarPlaca,
  paradasFinales,
  unidadAsignada,
  unidadRegistrada,
  type BorradorViaje,
  type CatalogoViaje,
  type Lugar,
  type PasoViaje,
  type TipoViaje,
} from "./empezarViaje";
import { SelectorLugar } from "./SelectorLugar";
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
  onEncolado,
}: {
  catalogo: CatalogoViaje;
  nombreConductor: string;
  onCancelar: () => void;
  /** Se llamó al servidor y el viaje quedó creado (o ya existía): el padre vuelve a leer sus viajes. */
  onCreado: () => void;
  /** Sin señal: el viaje quedó guardado en el celular y la cola lo enviará al volver la conexión. */
  onEncolado: (p: CreacionPendiente) => void;
}) {
  const [b, setB] = useState<BorradorViaje>(() => borradorInicial(catalogo, nombreConductor));
  const [paso, setPaso] = useState<PasoViaje>("tipo");
  const [editaRuta, setEditaRuta] = useState(false);
  // Con unidad asignada se ve solo esa; «No es mi unidad» abre el buscador. Sin asignada, va directo.
  const asignada = unidadAsignada(catalogo);
  const [cambiando, setCambiando] = useState(!asignada);
  const [busquedaRelevo, setBusquedaRelevo] = useState("");
  // Lo que se buscó al pulsar «Validar»: hasta entonces no se muestra nada.
  const [relevoValidado, setRelevoValidado] = useState<string | null>(null);
  const [busqueda, setBusqueda] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  // Un identificador por intento de crear: el reintento de un envío que no se sabe si llegó no duplica.
  const idCliente = useRef(crypto.randomUUID());

  const lugar = (l: Lugar) => nombreDeLugar(l, catalogo) || "—";
  const unidad = unidadRegistrada(catalogo, b.unidad);
  const error = errorDelPaso(paso, b, catalogo);
  // Con la odómetro vacío o la placa a medio escribir no se grita: el botón solo queda apagado.
  const callado =
    (paso === "confirmar" && b.odometro === "") ||
    (paso === "unidad" && (b.unidad === null || (b.unidad === "nueva" && !b.placa)));
  const i = PASOS.indexOf(paso);
  const set = (cambios: Partial<BorradorViaje>) => setB((v) => ({ ...v, ...cambios }));
  const sinRuta = b.unidad === "nueva" || !unidad?.ruta;
  const selector = (valor: Lugar, onChange: (l: Lugar) => void, etiqueta: string) => (
    <SelectorLugar
      etiqueta={etiqueta}
      valor={valor}
      lugares={catalogo.lugares}
      onChange={onChange}
    />
  );

  const elegirUnidad = (id: number | "nueva") => {
    const u = unidadRegistrada(catalogo, id);
    setEditaRuta(false);
    setB((v) => conRutaDeUnidad({ ...v, unidad: id, motivoUnidad: "" }, u));
  };
  /** La unidad no está registrada: sigue con esa placa (la que ya escribió en el buscador). */
  const usarComoNueva = () => {
    setEditaRuta(false);
    setB((v) =>
      conRutaDeUnidad({ ...v, unidad: "nueva", motivoUnidad: "", placa: v.placa || busqueda }, null)
    );
  };
  /** Un conductor con cuenta se elige por su id; uno que solo está en Equipos se anota por su nombre. */
  const elegirRelevo = (r: CatalogoViaje["relevos"][number]) =>
    set(
      r.con_cuenta ? { relevoId: r.id, relevoNombre: "" } : { relevoId: "", relevoNombre: r.nombre }
    );
  const dejarSinUnidad = () => {
    setEditaRuta(false);
    setB((v) => conRutaDeUnidad({ ...v, unidad: null, motivoUnidad: "" }, null));
  };

  const salir = async () => {
    if (guardando || error) return;
    setGuardando(true);
    setAviso(null);
    try {
      const marcadoEn = new Date().toISOString();
      const res = await apiFetch("/api/erp/viajes/crear-mio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          cuerpoCrearMiViaje(b, idCliente.current, marcadoEn, asignada?.id ?? null)
        ),
      });
      if (res.status === 202) {
        // Sin señal: la cola lo tiene guardado y lo envía sola; aquí queda el resumen para mostrarlo.
        onEncolado({
          idCliente: idCliente.current,
          unidad: b.unidad === "nueva" ? `${b.placa} (unidad nueva)` : (unidad?.placa ?? "—"),
          ruta: paradasFinales(b).map(lugar).join(" → "),
          marcadoEn,
          odometro: lecturaOdometro(b.odometro) ?? 0,
          unidadNueva: b.unidad === "nueva",
          paradas: paradasFinales(b).map((l) => ({
            id: typeof l === "number" ? l : null,
            nombre: lugar(l),
          })),
          placa: b.unidad === "nueva" ? b.placa.trim().toUpperCase() : (unidad?.placa ?? ""),
          tipoUnidad: unidad?.tipo ?? "Por completar",
          tipoMedidor: unidad?.tipo_medidor ?? null,
          conductorNombre: nombreConductor,
          conductorDni: "",
          relevoNombre:
            catalogo.relevos.find((r) => r.id === b.relevoId)?.nombre || b.relevoNombre || null,
          relevoSinCuenta: !b.relevoId && Boolean(b.relevoNombre),
        });
        return;
      }
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
    const resultados = buscarUnidades(catalogo, busqueda);
    // Lo escrito parece una placa y no es ninguna de las registradas: se puede seguir con ella.
    const placaBuscada = normalizarPlaca(busqueda);
    const placaBuscadaNueva =
      placaBuscada.length >= 3 &&
      !catalogo.unidades.some((u) => normalizarPlaca(u.placa) === placaBuscada);
    const otra = typeof b.unidad === "number" && b.unidad !== asignada?.id ? unidad : null;
    const detalleUnidad = (u: NonNullable<typeof unidad>) => (
      <>
        <b className="text-white text-lg">{u.placa}</b>{" "}
        <span className="text-[#94a3b8]">· {u.tipo}</span>
        <span className="block text-xs text-[#94a3b8]">
          {u.ruta ? `Ruta: ${u.ruta.origen} → ${u.ruta.destino}` : "Sin ruta asignada"}
        </span>
      </>
    );
    cuerpo = (
      <>
        <h3 className="text-xl font-extrabold text-white">¿Cuál es tu unidad?</h3>
        {asignada && !cambiando && (
          <>
            <div className="rounded-2xl border border-[#BADC1E] bg-[#17261c] p-4">
              <p className="text-xs text-[#BADC1E] mb-1">Asignada a ti</p>
              {detalleUnidad(asignada)}
            </div>
            <button
              type="button"
              className="w-full rounded-2xl border border-[#BADC1E] px-4 py-3 text-left text-[#BADC1E] hover:bg-[#17261c]"
              onClick={() => {
                setCambiando(true);
                dejarSinUnidad();
              }}
            >
              <b className="block">No es mi unidad</b>
              <span className="text-xs text-[#94a3b8]">Buscar otra o registrar la mía</span>
            </button>
          </>
        )}
        {cambiando && (
          <>
            {asignada && (
              <button
                type="button"
                className="text-[#BADC1E] font-semibold py-1 text-left"
                onClick={() => {
                  setCambiando(false);
                  setBusqueda("");
                  elegirUnidad(asignada.id);
                }}
              >
                ← Volver a mi unidad ({asignada.placa})
              </button>
            )}
            {!asignada && (
              <p className="text-sm text-[#94a3b8]">
                No tienes una unidad asignada. Búscala por su placa; si no está registrada, sigues
                con esa placa como unidad nueva.
              </p>
            )}
            {otra ? (
              <div className="rounded-2xl border border-[#BADC1E] bg-[#17261c] p-4">
                {detalleUnidad(otra)}
              </div>
            ) : (
              b.unidad !== "nueva" && (
                <>
                  <label className={ETIQUETA}>
                    Busca por placa
                    <input
                      className={`${CAMPO} mt-1.5 font-mono uppercase tracking-widest`}
                      autoComplete="off"
                      autoCapitalize="characters"
                      placeholder="Ej. ABC"
                      value={busqueda}
                      onChange={(e) => setBusqueda(e.target.value.toUpperCase())}
                    />
                  </label>
                  {resultados.map((u) => (
                    <Opcion key={u.id} activa={false} onClick={() => elegirUnidad(u.id)}>
                      {detalleUnidad(u)}
                    </Opcion>
                  ))}
                  {busqueda.trim().length >= 2 && resultados.length === 0 && (
                    <p className="text-sm text-[#94a3b8]">No hay unidades con esa placa.</p>
                  )}
                  {placaBuscadaNueva && (
                    <Opcion activa={false} onClick={usarComoNueva}>
                      <b className="block text-white">
                        Pulsa aquí para seguir con {busqueda.trim()}
                      </b>
                      <span className="text-xs text-[#94a3b8]">
                        No está registrada: se registra como unidad nueva y sigues con tu viaje
                      </span>
                    </Opcion>
                  )}
                </>
              )
            )}
            {otra && (
              <>
                <label className={ETIQUETA}>
                  Motivo (opcional)
                  <input
                    className={`${CAMPO} mt-1.5 normal-case tracking-normal font-normal`}
                    maxLength={500}
                    autoComplete="off"
                    placeholder="Ej. la mía está en taller"
                    value={b.motivoUnidad}
                    onChange={(e) => set({ motivoUnidad: e.target.value })}
                  />
                </label>
                <button
                  type="button"
                  className="text-[#BADC1E] font-semibold py-1 text-left"
                  onClick={() => {
                    setBusqueda("");
                    dejarSinUnidad();
                  }}
                >
                  Elegir otra
                </button>
              </>
            )}
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
                  Se guarda en Registro de unidades solo con la placa, tu nombre y la ruta que
                  ingreses. La oficina completa el resto después.
                </p>
              </div>
            )}
          </>
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
    const hayRelevo = Boolean(b.relevoId || b.relevoNombre);
    const elegido = catalogo.relevos.find((r) => r.id === b.relevoId);
    const encontrados = relevoValidado ? buscarRelevos(catalogo, relevoValidado) : [];
    cuerpo = (
      <>
        <h3 className="text-xl font-extrabold text-white">¿Vas con relevo?</h3>
        <Opcion
          activa={!hayRelevo}
          onClick={() => {
            setBusquedaRelevo("");
            setRelevoValidado(null);
            set({ relevoId: "", relevoNombre: "" });
          }}
        >
          <b className="text-white">Sin relevo</b>
        </Opcion>
        {hayRelevo ? (
          <div className="rounded-2xl border border-[#BADC1E] bg-[#17261c] p-4">
            <p className="text-xs text-[#BADC1E] mb-1">Relevo</p>
            <b className="text-white text-lg">{elegido?.nombre ?? b.relevoNombre}</b>
            {!elegido && (
              <span className="block text-xs text-[#94a3b8]">
                Sin cuenta: queda anotado en el viaje, no maneja en el sistema.
              </span>
            )}
            <button
              type="button"
              className="mt-2 text-[#BADC1E] font-semibold"
              onClick={() => {
                setBusquedaRelevo("");
                setRelevoValidado(null);
                set({ relevoId: "", relevoNombre: "" });
              }}
            >
              Cambiar
            </button>
          </div>
        ) : (
          <>
            <label className={ETIQUETA} htmlFor="busca-relevo">
              Nombre del relevo
            </label>
            <div className="flex items-center gap-2">
              <input
                id="busca-relevo"
                className={`${CAMPO} normal-case tracking-normal font-normal flex-1 min-w-0`}
                autoComplete="off"
                placeholder="Ej. Nicolas"
                value={busquedaRelevo}
                onChange={(e) => {
                  setBusquedaRelevo(e.target.value);
                  setRelevoValidado(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && busquedaRelevo.trim().length >= 2) {
                    e.preventDefault();
                    setRelevoValidado(busquedaRelevo.trim());
                  }
                }}
              />
              <button
                type="button"
                disabled={busquedaRelevo.trim().length < 2}
                onClick={() => setRelevoValidado(busquedaRelevo.trim())}
                className="shrink-0 h-[50px] rounded-full bg-[#BADC1E] px-5 font-extrabold text-[#0D1719] hover:brightness-110 disabled:opacity-50"
              >
                Validar
              </button>
            </div>
            {relevoValidado !== null && (
              <>
                {encontrados.length > 0 ? (
                  <>
                    <p className="text-sm text-[#94a3b8]">
                      {encontrados.length === 1 ? "Encontré a:" : "Encontré varios, elige uno:"}
                    </p>
                    {encontrados.map((r) => (
                      <Opcion key={r.id} activa={false} onClick={() => elegirRelevo(r)}>
                        <b className="text-white">{r.nombre}</b>
                      </Opcion>
                    ))}
                  </>
                ) : (
                  <p className="text-sm text-[#94a3b8]">No hay nadie con ese nombre.</p>
                )}
                <Opcion
                  activa={false}
                  onClick={() => set({ relevoId: "", relevoNombre: relevoValidado })}
                >
                  <b className="block text-white">
                    {encontrados.length > 0 ? "Ninguno de estos: s" : "S"}igue con {relevoValidado}{" "}
                    para este viaje
                  </b>
                  <span className="text-xs text-[#94a3b8]">
                    Se anota su nombre en el viaje y sigues
                  </span>
                </Opcion>
              </>
            )}
          </>
        )}
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
            [
              "Relevo",
              relevo?.nombre ?? (b.relevoNombre ? `${b.relevoNombre} (sin cuenta)` : "Sin relevo"),
            ],
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
