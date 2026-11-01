// "Mi tanqueta" del conductor: a la izquierda el cilindro de la tanqueta asignada a su unidad
// (como "Nivel de tanque") y a la derecha lo que él sacó de ella ("Mis cargas"). Si la unidad
// lleva más de una, un selector arriba. Solo lectura.
//
// Los datos vienen de GET /tanquetas/mias (solo las de SU unidad). El cilindro baja solo cuando
// alguien carga: se vuelve a pedir ante los eventos del servidor, agrupados en una sola recarga.
//
// Si no se puede actualizar (sin señal, o el servidor responde con error) se queda lo último que
// se supo y se dice, con su fecha. Lo último que se vio se guarda en este celular (como Mi viaje).
//
// El historial de cargas va SIEMPRE en el mismo lugar del árbol: si cambiara de sitio cuando
// aparece o desaparece la tanqueta, React lo montaría de nuevo y perdería el filtro de fechas.
import { useCallback, useEffect, useRef, useState } from "react";

import HistorialCargasTanqueta from "./HistorialCargasTanqueta";
import NivelDeTanqueta, { type ProblemaDeActualizacion, type TanquetaMia } from "./NivelDeTanqueta";
import { useAuth } from "../../context/AuthContext";
import { suscribirseASincronizacion } from "../../offline/offlineSync";
import { apiFetch } from "../../services/apiClient";
import { mensajeDeError } from "../../utils/mensajeDeError";

// Lo que mueve el saldo de una tanqueta: cargas, recepciones con excedente y lo que hace el
// grifero (asignar, recibirla de vuelta, editarla publica `tanque_actualizado`).
const EVENTOS = [
  "combustible.despacho_creado",
  "combustible.despacho_anulado",
  "combustible.recepcion_creada",
  "combustible.recepcion_anulada",
  "combustible.tanque_actualizado",
];

/** Lo último que se vio, para cuando no hay señal. */
interface CacheLocal {
  guardadoEn: string;
  tanquetas: TanquetaMia[];
}

const claveCache = (usuarioId: string) => `mi-tanqueta:${usuarioId}`;

const numero = (v: unknown) => typeof v === "number" && Number.isFinite(v);

/** Una tanqueta con la forma que el cilindro necesita: lo que viene de un caché viejo o roto, o
 *  de un servidor con otra forma, no debe tumbar la pantalla. */
function esTanquetaValida(t: unknown): t is TanquetaMia {
  if (typeof t !== "object" || t === null) return false;
  const x = t as Record<string, unknown>;
  return (
    numero(x.id) &&
    typeof x.codigo === "string" &&
    numero(x.capacidad) &&
    numero(x.saldo) &&
    numero(x.libre) &&
    (typeof x.equipo_asignado === "string" || x.equipo_asignado === null)
  );
}

function leerCache(usuarioId: string): CacheLocal | null {
  try {
    const crudo = localStorage.getItem(claveCache(usuarioId));
    const c = crudo ? (JSON.parse(crudo) as CacheLocal) : null;
    return c && Array.isArray(c.tanquetas) && c.tanquetas.every(esTanquetaValida) ? c : null;
  } catch {
    return null;
  }
}

function guardarCache(usuarioId: string, c: CacheLocal) {
  try {
    localStorage.setItem(claveCache(usuarioId), JSON.stringify(c));
  } catch {
    // Sin espacio o en modo privado: se sigue sin caché.
  }
}

/** Una fecha guardada que no se puede leer no se muestra (mejor sin hora que "Invalid Date"). */
const fechaDelCache = (iso: unknown): Date | null => {
  const t = typeof iso === "string" ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? null : new Date(t);
};

export default function MiTanqueta() {
  const { usuario } = useAuth();
  const usuarioId = usuario?.id ?? "anonimo";
  const [tanquetas, setTanquetas] = useState<TanquetaMia[]>([]);
  const [elegidaId, setElegidaId] = useState<number | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sinUnidad, setSinUnidad] = useState(false);
  const [problema, setProblema] = useState<ProblemaDeActualizacion | null>(null);
  const [actualizadoEn, setActualizadoEn] = useState<Date | null>(null);

  // Una consulta lenta no debe pisar a la que se pidió después (un evento, volver la señal).
  const pedido = useRef(0);
  const elegidaRef = useRef<number | null>(null);

  const mostrar = useCallback((lista: TanquetaMia[]) => {
    setTanquetas(lista);
    // Se queda la que estaba mirando; si ya no es suya (la devolvieron), la primera.
    const sigue = lista.find((t) => t.id === elegidaRef.current);
    const id = sigue ? sigue.id : (lista[0]?.id ?? null);
    elegidaRef.current = id;
    setElegidaId(id);
  }, []);

  const cargar = useCallback(async () => {
    const mio = ++pedido.current;
    try {
      const res = await apiFetch("/api/erp/combustible/tanquetas/mias");
      const cuerpo = await res.json().catch(() => null);
      if (mio !== pedido.current) return;
      if (!res.ok || !Array.isArray(cuerpo) || !cuerpo.every(esTanquetaValida)) {
        // El servidor respondió, pero con un error: lo que hay en pantalla es viejo y se dice.
        setError(mensajeDeError(cuerpo, "No se pudo cargar tu tanqueta."));
        setProblema("servidor");
        return;
      }
      const ahora = new Date();
      mostrar(cuerpo);
      setSinUnidad(res.headers.get("X-Conductor-Sin-Unidad") === "1");
      setError(null);
      setProblema(null);
      setActualizadoEn(ahora);
      guardarCache(usuarioId, { guardadoEn: ahora.toISOString(), tanquetas: cuerpo });
    } catch {
      if (mio !== pedido.current) return;
      // Sin señal: lo último que se vio.
      const guardado = leerCache(usuarioId);
      if (guardado && guardado.tanquetas.length > 0) {
        mostrar(guardado.tanquetas);
        setActualizadoEn(fechaDelCache(guardado.guardadoEn));
        setError(null);
      } else {
        setError("Sin conexión: no se pudo cargar tu tanqueta. Vuelve a intentarlo con señal.");
      }
      setProblema("sin_senal");
    } finally {
      if (mio === pedido.current) setCargando(false);
    }
  }, [usuarioId, mostrar]);

  useEffect(() => {
    // Patrón estándar de carga al montar -- ver IpercView.tsx.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void cargar();
    // Las ráfagas (una carga publica varios eventos) se juntan en una sola recarga.
    let temporizador: number | undefined;
    const refrescar = () => {
      if (temporizador !== undefined) window.clearTimeout(temporizador);
      temporizador = window.setTimeout(() => void cargar(), 100);
    };
    const es = new EventSource("/api/eventos/stream", { withCredentials: true });
    EVENTOS.forEach((tipo) => es.addEventListener(tipo, refrescar));
    // Cada vez que el stream se abre (la primera y cada reconexión) se vuelve a mirar: lo que se
    // cargó mientras estaba cerrado no llega como evento, y `online` no se dispara cuando solo
    // cae el stream.
    es.addEventListener("open", refrescar);
    const alVolver = () => {
      if (document.visibilityState === "visible") refrescar();
    };
    document.addEventListener("visibilitychange", alVolver);
    window.addEventListener("focus", alVolver);
    window.addEventListener("online", refrescar);
    // La carga que acaba de registrar este celular, y la que estaba guardada sin señal.
    window.addEventListener("combustible:actualizado", refrescar);
    const dejarDeOirCola = suscribirseASincronizacion(({ sincronizadas }) => {
      if (sincronizadas > 0) refrescar();
    });
    return () => {
      if (temporizador !== undefined) window.clearTimeout(temporizador);
      es.close();
      document.removeEventListener("visibilitychange", alVolver);
      window.removeEventListener("focus", alVolver);
      window.removeEventListener("online", refrescar);
      window.removeEventListener("combustible:actualizado", refrescar);
      dejarDeOirCola();
    };
  }, [cargar]);

  const elegir = (id: number) => {
    elegidaRef.current = id;
    setElegidaId(id);
  };

  const elegida = tanquetas.find((t) => t.id === elegidaId) ?? tanquetas[0];

  return (
    <section className="mb-6 grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,260px)_minmax(0,1fr)]">
      {elegida ? (
        <NivelDeTanqueta
          tanquetas={tanquetas}
          elegida={elegida}
          onElegir={elegir}
          problema={problema}
          actualizadoEn={actualizadoEn}
        />
      ) : (
        <div className="rounded-lg border border-[#2a2e37] bg-[#192526] p-6 text-sm">
          {cargando ? (
            <p className="text-[#94a3b8]">Cargando tu tanqueta…</p>
          ) : error ? (
            <p className="text-amber-400">{error}</p>
          ) : sinUnidad ? (
            <p className="text-amber-400">
              Tu usuario no tiene ninguna unidad a su cargo en Equipos. Pídele al administrador que
              revise tu DNI en la unidad que manejas.
            </p>
          ) : (
            <p className="text-amber-400">
              No hay una tanqueta asignada a tu unidad. Pídele al grifero o al administrador que te
              la asigne.
            </p>
          )}
        </div>
      )}
      <div className="min-w-0">
        <HistorialCargasTanqueta />
      </div>
    </section>
  );
}
