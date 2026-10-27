// "Mi viaje" (0124): el conductor confirma su viaje programado, lo inicia y lo
// termina desde el celular. La hora la pone el servidor; sin señal la marca
// queda en la cola del celular y vale la hora en que se tocó el botón.
import {
  AlertTriangle,
  CheckCircle2,
  CloudOff,
  Droplets,
  Fuel,
  Gauge,
  Lock,
  Navigation,
  Play,
  Timer,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { HistorialConductor } from "./HistorialConductor";
import { MiViajeParadas } from "./MiViajeParadas";
import {
  avanceDelMando,
  avanceDelViaje,
  estadoDelTramo,
  minutosDescansados,
  paradasDelViaje,
  type DescansoMio,
  type ParadaMia,
} from "./paradasViaje";
import { BarraRuta, LineaTiempo, TarjetaViaje, Tile, type CargaViaje } from "./PiezasViaje";
import {
  desfaseSalida,
  duracion as duracionMin,
  fechaHora,
  fmt,
  ruta,
  unidadLabel,
  type FilaViaje,
} from "./viajesFormato";
import { useAuth } from "../../context/AuthContext";
import { listarPendientes, suscribirseACola } from "../../offline/offlineQueue";
import { suscribirseASincronizacion } from "../../offline/offlineSync";
import { apiFetch } from "../../services/apiClient";

interface MiFila extends FilaViaje {
  combustible_gal: string;
  urea_l: string;
  previo: { tipo_medidor: "horometro" | "odometro" | null; valor: number | null } | null;
  /** Marcado en este celular y todavía en la cola (sin señal). */
  pendiente?: boolean;
  /** El recorrido completo, con la hora y el medidor de cada llegada y salida (0148). */
  paradas?: ParadaMia[] | null;
  /** Sus descansos: el abierto frena el viaje hasta que lo termine. */
  descansos?: DescansoMio[] | null;
  /** Sus cargas del viaje y lo que suele tardar la ruta (para estimar la llegada). */
  cargas_detalle?: CargaViaje[];
  duracion_ruta_min?: number | null;
  /** Si soy el titular o el relevo del viaje (0152). */
  mi_rol?: "titular" | "relevo";
  /** Retiré la entrega sin señal: hasta que llegue a la cola, vale más que la pendiente del servidor. */
  entrega_retirada?: boolean;
}

type Paso = "ver" | "revisar" | "iniciar";

const BTN_LIMA =
  "w-full flex items-center justify-center gap-2 bg-[#BADC1E] text-[#0D1719] font-extrabold text-lg py-4 rounded-2xl hover:brightness-110 disabled:opacity-50";
const BTN_SECUNDARIO =
  "w-full flex items-center justify-center gap-2 border border-[#334155] text-[#cbd5e1] font-semibold py-3 rounded-2xl hover:text-white";
const INPUT =
  "w-full bg-[#0D1719] border border-[#334155] rounded-xl px-4 py-4 text-2xl font-mono text-white text-center";

const claveCache = (usuarioId: string) => `mi-viaje:${usuarioId}`;

/** Con relevo, quien mira su viaje se ve a sí mismo en grande y al otro en una línea chica. */
function nombreYRol(f: MiFila) {
  // Una fila guardada antes del relevo no trae `mi_rol`: sin saber quién soy, no se adivina.
  if (!f.mi_rol) return { nombre: f.conductor_nombre, lineaRol: null };
  const soyRelevo = f.mi_rol === "relevo";
  const mio = soyRelevo ? f.relevo_nombre : f.conductor_nombre;
  const otro = soyRelevo ? f.conductor_nombre : f.relevo_nombre;
  return {
    nombre: mio ?? (soyRelevo ? "Relevo" : f.conductor_nombre),
    lineaRol: f.relevo_dni && otro ? `${soyRelevo ? "Titular" : "Relevo"}: ${otro}` : null,
  };
}

function leerCache(usuarioId: string): MiFila[] | null {
  try {
    const crudo = localStorage.getItem(claveCache(usuarioId));
    return crudo ? (JSON.parse(crudo) as MiFila[]) : null;
  } catch {
    return null;
  }
}

function guardarCache(usuarioId: string, filas: MiFila[]) {
  try {
    localStorage.setItem(claveCache(usuarioId), JSON.stringify(filas));
  } catch {
    // Sin almacenamiento (modo privado): solo se pierde la vista sin señal.
  }
}

/** Los viajes con una marca (salida, llegada o parada) que todavía espera en la cola de este
 *  celular: mientras tanto, lo guardado aquí va más adelantado que lo que dice el servidor. */
async function viajesConMarcasEnCola(): Promise<Set<string>> {
  const ids = new Set<string>();
  try {
    for (const e of await listarPendientes()) {
      const m =
        /\/viajes\/(\d+)\/(iniciar-mio|cerrar-mio|llegada-mia|salida-mia|descanso-mio|mando)/.exec(
          e.url
        );
      if (m) ids.add(m[1]);
    }
  } catch {
    // Sin acceso a la cola: se toma lo del servidor.
  }
  return ids;
}

function duracionEntre(desde: string, hasta: string) {
  return duracion(desde, Date.parse(hasta));
}

function duracion(desde: string, ahora: number) {
  const min = Math.max(0, Math.floor((ahora - Date.parse(desde)) / 60_000));
  const h = Math.floor(min / 60);
  return h > 0 ? `${h} h ${min % 60} min` : `${min} min`;
}

export default function MiViaje() {
  const { usuario } = useAuth();
  const usuarioId = usuario?.id ?? "anonimo";
  const [filas, setFilas] = useState<MiFila[]>([]);
  const filasRef = useRef<MiFila[]>([]);
  const [sinDni, setSinDni] = useState(false);
  const [sinSenal, setSinSenal] = useState(false);
  const [cargando, setCargando] = useState(true);
  const [pestana, setPestana] = useState<"viaje" | "historial">("viaje");
  const [paso, setPaso] = useState<Paso>("ver");
  const [medidor, setMedidor] = useState("");
  const [rutaMal, setRutaMal] = useState(false);
  const [nota, setNota] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const [ahora, setAhora] = useState(() => Date.now());

  useEffect(() => {
    filasRef.current = filas;
  }, [filas]);

  const cargar = useCallback(async () => {
    try {
      const res = await apiFetch("/api/erp/combustible/viajes/mios");
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? "error");
      const delServidor: MiFila[] = Array.isArray(body?.data) ? body.data : [];
      // Una marca que sigue en la cola no la pisa un refresco con lo que el servidor aún no vio.
      const enCola = await viajesConMarcasEnCola();
      const data = delServidor.map((f) => {
        const local = filasRef.current.find((l) => l.id === f.id);
        const masAdelantado =
          local?.pendiente &&
          enCola.has(f.id) &&
          (avanceDelViaje(paradasDelViaje(local), local.descansos) +
            avanceDelMando(local.turnos, local.entrega_pendiente) >
            avanceDelViaje(paradasDelViaje(f), f.descansos) +
              avanceDelMando(f.turnos, f.entrega_pendiente) ||
            Boolean(local.entrega_retirada && f.entrega_pendiente));
        return masAdelantado ? local : f;
      });
      setFilas(data);
      setSinDni(Boolean(body?.sinDni));
      setSinSenal(false);
      guardarCache(usuarioId, data);
    } catch {
      // Sin señal: lo último que se vio, con lo marcado en este celular.
      const cache = leerCache(usuarioId);
      if (cache) setFilas(cache);
      setSinSenal(true);
    } finally {
      setCargando(false);
    }
  }, [usuarioId]);

  useEffect(() => {
    void cargar();
    const es = new EventSource("/api/eventos/stream", { withCredentials: true });
    const refrescar = () => void cargar();
    es.addEventListener("combustible.viaje_actualizado", refrescar);
    es.addEventListener("combustible.despacho_creado", refrescar);
    window.addEventListener("online", refrescar);
    // Cuando la cola envía una marca, se vuelve a mirar cómo quedó el viaje; si el servidor
    // rechazó alguna, se dice (el aviso global de pendientes solo cuenta cuántas).
    const dejarDeOirCola = suscribirseACola(refrescar);
    const dejarDeOirEnvio = suscribirseASincronizacion(({ descartadas }) => {
      if (descartadas.some((d) => d.moduloId === "combustible")) {
        setAviso(
          "Una marca de tu viaje no se pudo enviar porque el viaje ya había avanzado. Mira cómo quedó y avisa a la oficina."
        );
      }
      refrescar();
    });
    const reloj = window.setInterval(() => setAhora(Date.now()), 30_000);
    return () => {
      dejarDeOirCola();
      dejarDeOirEnvio();
      es.close();
      window.removeEventListener("online", refrescar);
      window.clearInterval(reloj);
    };
  }, [cargar]);

  const enCurso = filas.find((f) => f.estado === "en_curso");
  const programado = filas.find((f) => f.estado === "programado");
  const ultimo = filas.find((f) => f.estado === "cerrado");
  const actual = enCurso ?? programado;
  // Con relevo, solo el que va al volante marca el viaje; el otro ve quién maneja y puede descansar.
  const miDni = (actual?.mi_rol === "relevo" ? actual.relevo_dni : actual?.conductor_dni)?.trim();
  const sinMando = Boolean(
    actual?.relevo_dni && actual.volante_dni && miDni && actual.volante_dni.trim() !== miDni
  );
  const manejaNombre =
    actual?.volante_dni?.trim() === actual?.relevo_dni?.trim()
      ? actual?.relevo_nombre
      : actual?.conductor_nombre;
  // En la tarjeta, con relevo, mi nombre va en grande y quién maneja al lado.
  const rolTarjeta = actual ? nombreYRol(actual) : null;
  const etiquetaMando =
    actual?.relevo_dni && actual.mi_rol && manejaNombre
      ? {
          manejando: !sinMando,
          texto:
            actual.estado === "programado"
              ? sinMando
                ? `Sale manejando: ${manejaNombre}`
                : "(sale manejando)"
              : sinMando
                ? `Manejando: ${manejaNombre}`
                : "(manejando)",
        }
      : null;
  const tipo = actual?.tipo_medidor ?? actual?.previo?.tipo_medidor ?? null;
  const etiquetaMedidor = tipo === "horometro" ? "horómetro" : "odómetro";
  const unidadMedidor = tipo === "horometro" ? "h" : "km";

  // El tiempo en ruta no cuenta lo descansado.
  const minutosEnRuta = actual?.inicio_en
    ? Math.max(
        0,
        (ahora - Date.parse(actual.inicio_en)) / 60_000 -
          minutosDescansados(actual.descansos, ahora)
      )
    : 0;
  const esperadoMin = actual?.duracion_ruta_min ?? null;
  const progresoActual = esperadoMin ? Math.min(100, (minutosEnRuta / esperadoMin) * 100) : 0;
  const demoraActual = esperadoMin && minutosEnRuta > esperadoMin ? minutosEnRuta - esperadoMin : 0;
  const llegadaActual =
    actual?.inicio_en && esperadoMin ? Date.parse(actual.inicio_en) + esperadoMin * 60_000 : null;

  const reiniciarPaso = () => {
    setPaso("ver");
    setMedidor("");
    setRutaMal(false);
    setNota("");
  };

  /** Marca local mientras la cola no la envíe: la tarjeta ya muestra el viaje
   *  en curso (o cerrado) aunque no haya señal. */
  const aplicarLocal = (id: string, cambios: Partial<MiFila>) => {
    const nuevas = filas.map((f) => (f.id === id ? { ...f, ...cambios, pendiente: true } : f));
    setFilas(nuevas);
    guardarCache(usuarioId, nuevas);
  };

  const marcar = async (v: MiFila) => {
    if (guardando) return;
    const lectura = medidor.trim() === "" ? null : Number(medidor);
    if (tipo && lectura === null) {
      setAviso(`Escribe el ${etiquetaMedidor} que marca el tablero.`);
      return;
    }
    const marcadoEn = new Date().toISOString();
    const body = {
      medidor_inicio: lectura,
      ...(rutaMal ? { ruta_por_confirmar: true, nota_ruta: nota.trim() || null } : {}),
    };
    setGuardando(true);
    setAviso(null);
    try {
      const res = await apiFetch(`/api/erp/combustible/viajes/${v.id}/iniciar-mio`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, marcado_en: marcadoEn, cliente_uuid: crypto.randomUUID() }),
      });
      const r = await res.json().catch(() => ({}));
      if (res.status === 202) {
        aplicarLocal(v.id, {
          estado: "en_curso",
          inicio_en: marcadoEn,
          medidor_inicio: String(lectura ?? ""),
          // La salida de la primera parada es la salida del viaje.
          paradas: paradasDelViaje(v).map((x) =>
            x.orden === 0
              ? { ...x, salida_en: marcadoEn, salida_medidor: String(lectura ?? "") }
              : x
          ),
        });
        setAviso("Sin señal: quedó guardado en el celular y se enviará solo al volver la señal.");
        reiniciarPaso();
        return;
      }
      if (!res.ok) {
        setAviso(r.error || r.message || r.errors?.[0]?.message || "No se pudo guardar.");
        return;
      }
      setAviso("Viaje iniciado. ¡Buen viaje!");
      reiniciarPaso();
      await cargar();
    } finally {
      setGuardando(false);
    }
  };

  const encabezado = (
    <div>
      <h2 className="text-2xl font-extrabold text-white">Mi viaje</h2>
      <p className="text-sm text-[#94a3b8]">{usuario?.nombre}</p>
    </div>
  );
  const pestanas = (
    <div role="tablist" className="grid grid-cols-2 gap-1 rounded-xl bg-[#0D1719] p-1">
      {(["viaje", "historial"] as const).map((p) => (
        <button
          key={p}
          role="tab"
          aria-selected={pestana === p}
          onClick={() => setPestana(p)}
          className={`rounded-lg py-2 text-sm font-semibold ${
            pestana === p ? "bg-[#192526] text-white" : "text-[#94a3b8]"
          }`}
        >
          {p === "viaje" ? "Mi viaje" : "Historial"}
        </button>
      ))}
    </div>
  );

  if (pestana === "historial") {
    return (
      <div className="max-w-xl mx-auto space-y-4">
        {encabezado}
        {pestanas}
        <HistorialConductor usuarioId={usuarioId} />
      </div>
    );
  }

  if (cargando) return <p className="text-[#94a3b8]">Cargando tu viaje...</p>;

  return (
    <div className="max-w-xl mx-auto space-y-4">
      {encabezado}
      {pestanas}

      {sinSenal && (
        <div className="flex items-center gap-2 rounded-xl bg-amber-500/10 border border-amber-500/30 p-3 text-sm text-amber-200">
          <CloudOff className="w-5 h-5 shrink-0" /> Sin señal: ves lo último guardado en el celular.
        </div>
      )}
      {aviso && (
        <div className="rounded-xl bg-[#192526] border border-[#334155] p-3 text-sm text-[#e2e8f0]">
          {aviso}
        </div>
      )}
      {sinDni && (
        <p className="rounded-xl bg-red-500/10 border border-red-500/30 p-3 text-sm text-red-200">
          Tu usuario no tiene DNI registrado: pide a la oficina que lo agregue para ver tus viajes.
        </p>
      )}

      {!actual && !sinDni && (
        <div className="rounded-3xl bg-gradient-to-br from-[#16222a] to-[#0D1719] border border-[#2a2e37] p-8 text-center space-y-3">
          <div className="mx-auto w-16 h-16 rounded-full bg-[#192526] border border-[#334155] flex items-center justify-center text-[#BADC1E]">
            <Navigation className="w-8 h-8" aria-hidden />
          </div>
          <p className="text-lg font-extrabold text-white">Sin viaje por ahora</p>
          <p className="text-sm text-[#94a3b8]">
            Cuando la oficina te programe uno aparecerá aquí, con tu ruta y tu unidad.
          </p>
        </div>
      )}

      {actual && (
        <TarjetaViaje
          v={actual}
          textoEstado={
            actual.estado === "en_curso"
              ? (estadoDelTramo(paradasDelViaje(actual))?.texto ?? "En ruta · en vivo")
              : "Programado"
          }
          nombre={rolTarjeta?.nombre}
          desfase={desfaseSalida(actual)}
          etiqueta={etiquetaMando}
          lineaRol={rolTarjeta?.lineaRol}
          hijos={
            paradasDelViaje(actual).length > 2 ? null : (
              <BarraRuta
                origen={actual.origen}
                destino={actual.destino}
                tipoUnidad={actual.equipo_tipo}
                inicio={actual.inicio_en}
                fin={null}
                progreso={progresoActual}
                demora={demoraActual}
                llegadaEstimada={llegadaActual}
                esperadoMin={actual.duracion_ruta_min ?? null}
                ahora={ahora}
              />
            )
          }
        />
      )}

      {actual && actual.estado === "en_curso" && actual.inicio_en && (
        <div className="grid grid-cols-3 gap-3">
          <Tile
            icono={<Timer className="w-4 h-4" />}
            titulo="En ruta"
            valor={duracionMin(minutosEnRuta)}
          />
          <Tile
            icono={<Fuel className="w-4 h-4" />}
            titulo="Combustible"
            valor={`${fmt(Number(actual.combustible_gal ?? 0), 1)} gal`}
          />
          <Tile
            icono={<Droplets className="w-4 h-4" />}
            titulo="Urea"
            valor={`${fmt(Number(actual.urea_l ?? 0), 1)} L`}
            acento="text-sky-400"
          />
        </div>
      )}

      {actual && (
        <div className="rounded-3xl bg-[#192526] border border-[#2a2e37] p-5 space-y-4">
          {actual.pendiente && (
            <p className="flex items-center gap-2 text-xs text-amber-300">
              <CloudOff className="w-4 h-4" /> Pendiente de enviar
            </p>
          )}

          {/* ── Programado: revisar, confirmar e iniciar ── */}
          {sinMando && actual.estado === "programado" && (
            <p className="rounded-xl bg-[#0D1719] p-4 text-sm text-sky-200">
              Sale manejando {manejaNombre}. Tú entras de relevo.
            </p>
          )}
          {!sinMando && actual.estado === "programado" && paso === "ver" && (
            <button className={BTN_LIMA} onClick={() => setPaso("revisar")}>
              Revisar mi viaje
            </button>
          )}

          {actual.estado === "programado" && paso === "revisar" && (
            <div className="space-y-3">
              <dl className="rounded-xl bg-[#0D1719] p-4 text-sm space-y-2">
                {[
                  ["Ruta", ruta(actual)],
                  ["Unidad", unidadLabel(actual)],
                  ["Conductor titular", actual.conductor_nombre ?? "—"],
                  ...(actual.relevo_dni ? [["Conductor relevo", actual.relevo_nombre ?? "—"]] : []),
                  ...(actual.salida_programada_en
                    ? [["Hora de salida", `${fechaHora(actual.salida_programada_en)} (programada)`]]
                    : []),
                ].map(([k, valor]) => (
                  <div key={k} className="flex justify-between gap-3">
                    <dt className="text-[#94a3b8] flex items-center gap-1">
                      <Lock className="w-3 h-3" /> {k}
                    </dt>
                    <dd className="text-white text-right">{valor}</dd>
                  </div>
                ))}
              </dl>
              <button
                className={BTN_LIMA}
                onClick={() => {
                  setRutaMal(false);
                  setPaso("iniciar");
                }}
              >
                <CheckCircle2 className="w-5 h-5" /> Confirmo los datos
              </button>
              <button
                className={BTN_SECUNDARIO}
                onClick={() => {
                  setRutaMal(true);
                  setPaso("iniciar");
                }}
              >
                <AlertTriangle className="w-5 h-5" /> Algo no coincide: avisé a la oficina
              </button>
            </div>
          )}

          {actual.estado === "programado" && paso === "iniciar" && (
            <div className="space-y-3">
              {rutaMal && (
                <input
                  aria-label="Qué no coincide"
                  placeholder="¿Qué no coincide? (ruta, unidad...)"
                  maxLength={500}
                  value={nota}
                  onChange={(e) => setNota(e.target.value)}
                  className="w-full bg-[#0D1719] border border-amber-500/40 rounded-xl px-4 py-3 text-white"
                />
              )}
              <div className="rounded-xl bg-[#0D1719] p-3 text-sm text-[#94a3b8] flex justify-between">
                <span className="flex items-center gap-1">
                  <Lock className="w-3 h-3" /> Hora de salida
                </span>
                <span className="text-white">
                  {actual.salida_programada_en
                    ? `programada ${fechaHora(actual.salida_programada_en)} · se registra al iniciar`
                    : "se registra al iniciar"}
                </span>
              </div>
              {tipo && (
                <>
                  <div className="rounded-xl bg-[#0D1719] p-3 text-sm text-[#94a3b8] flex justify-between">
                    <span className="flex items-center gap-1">
                      <Lock className="w-3 h-3" /> Último {etiquetaMedidor}
                    </span>
                    <span className="font-mono text-white">
                      {actual.previo?.valor != null
                        ? `${fmt(actual.previo.valor, 1)} ${unidadMedidor}`
                        : "sin lectura anterior"}
                    </span>
                  </div>
                  <label className="block text-sm text-[#cbd5e1]" htmlFor="mi-viaje-medidor">
                    {etiquetaMedidor} que marca el tablero
                  </label>
                  <input
                    id="mi-viaje-medidor"
                    type="number"
                    inputMode="decimal"
                    min={actual.previo?.valor ?? 0}
                    step="0.1"
                    autoFocus
                    value={medidor}
                    onChange={(e) => setMedidor(e.target.value)}
                    className={INPUT}
                  />
                  {actual.previo?.valor != null && medidor !== "" && (
                    <p
                      className={`text-xs ${
                        Number(medidor) < actual.previo.valor ? "text-red-400" : "text-[#94a3b8]"
                      }`}
                    >
                      {Number(medidor) < actual.previo.valor
                        ? "Es menor que el último registrado: revisa la lectura."
                        : `Desde la última lectura: ${fmt(Number(medidor) - actual.previo.valor, 1)} ${unidadMedidor}`}
                    </p>
                  )}
                </>
              )}
              <button className={BTN_LIMA} disabled={guardando} onClick={() => void marcar(actual)}>
                <Play className="w-6 h-6" /> {guardando ? "Guardando..." : "Iniciar viaje"}
              </button>
              <button className={BTN_SECUNDARIO} onClick={reiniciarPaso}>
                Volver
              </button>
            </div>
          )}

          {/* ── En curso: llegar y salir de cada parada ── */}
          {actual.estado === "en_curso" && (
            <MiViajeParadas
              key={`${actual.id}-${avanceDelViaje(paradasDelViaje(actual), actual.descansos)}-${avanceDelMando(actual.turnos, actual.entrega_pendiente)}`}
              viajeId={actual.id}
              paradas={paradasDelViaje(actual)}
              descansos={actual.descansos ?? []}
              ahora={ahora}
              conMedidor={Boolean(tipo)}
              etiquetaMedidor={etiquetaMedidor}
              unidadMedidor={unidadMedidor}
              onLocal={(cambios) => aplicarLocal(actual.id, cambios)}
              onAviso={setAviso}
              onRecargar={cargar}
              alVolante={!sinMando}
              manejaNombre={manejaNombre}
              mando={
                actual.relevo_dni && miDni
                  ? {
                      miDni,
                      otroNombre:
                        (actual.mi_rol === "relevo"
                          ? actual.conductor_nombre
                          : actual.relevo_nombre) ?? null,
                      entrega: actual.entrega_pendiente ?? null,
                      turnos: actual.turnos ?? [],
                    }
                  : null
              }
            />
          )}
        </div>
      )}

      {enCurso && enCurso.inicio_en && (
        <LineaTiempo
          origen={enCurso.origen}
          destino={enCurso.destino}
          inicio={Date.parse(enCurso.inicio_en)}
          fin={null}
          cargas={enCurso.cargas_detalle ?? []}
        />
      )}

      {ultimo && (
        <>
          <p className="pt-2 text-xs uppercase tracking-widest text-[#94a3b8]">
            Último viaje · V-{ultimo.numero}
            {ultimo.pendiente && " · pendiente de enviar"}
          </p>
          <TarjetaViaje
            v={ultimo}
            textoEstado="Llegó"
            nombre={nombreYRol(ultimo).nombre}
            desfase={desfaseSalida(ultimo)}
            lineaRol={nombreYRol(ultimo).lineaRol}
            hijos={
              <BarraRuta
                origen={ultimo.origen}
                destino={ultimo.destino}
                tipoUnidad={ultimo.equipo_tipo}
                inicio={ultimo.inicio_en}
                fin={ultimo.fin_en}
                progreso={100}
                demora={0}
                llegadaEstimada={null}
                esperadoMin={null}
                ahora={ahora}
              />
            }
          />
          <div className="grid grid-cols-2 gap-3">
            <Tile
              icono={<Timer className="w-4 h-4" />}
              titulo="Duración"
              valor={
                ultimo.inicio_en && ultimo.fin_en
                  ? duracionEntre(ultimo.inicio_en, ultimo.fin_en)
                  : "—"
              }
            />
            <Tile
              icono={<Gauge className="w-4 h-4" />}
              titulo={ultimo.tipo_medidor === "horometro" ? "Horómetro" : "Odómetro"}
              valor={
                ultimo.recorrido
                  ? `${fmt(Number(ultimo.recorrido), 1)} ${ultimo.tipo_medidor === "horometro" ? "h" : "km"}`
                  : "—"
              }
            />
            <Tile
              icono={<Fuel className="w-4 h-4" />}
              titulo="Combustible"
              valor={`${fmt(Number(ultimo.combustible_gal ?? 0), 1)} gal`}
            />
            <Tile
              icono={<Droplets className="w-4 h-4" />}
              titulo="Urea"
              valor={`${fmt(Number(ultimo.urea_l ?? 0), 1)} L`}
              acento="text-sky-400"
            />
          </div>
        </>
      )}
      {ultimo && ultimo.inicio_en && (
        <LineaTiempo
          origen={ultimo.origen}
          destino={ultimo.destino}
          inicio={Date.parse(ultimo.inicio_en)}
          fin={ultimo.fin_en ? Date.parse(ultimo.fin_en) : null}
          cargas={ultimo.cargas_detalle ?? []}
        />
      )}
    </div>
  );
}
