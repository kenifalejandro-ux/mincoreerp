// "Mi tanqueta" del conductor: a la izquierda el cilindro de la tanqueta asignada a su unidad
// (como "Nivel de tanque") y a la derecha dos pestañas: los movimientos de la tanqueta (el kardex,
// que cuadra con el cilindro) y "Mis cargas" (lo que él sacó). Si la unidad lleva más de una, un
// selector arriba. Solo lectura.
//
// Los datos vienen de GET /tanquetas/mias y /tanquetas/:id/kardex (solo las de SU unidad). El
// cilindro y el kardex bajan solos cuando alguien carga: se vuelve a pedir ante los eventos del
// servidor, agrupados en una sola recarga.
//
// Si no se puede actualizar (sin señal, o el servidor responde con error) se queda lo último que
// se supo y se dice, con su fecha. Lo último que se vio se guarda en este celular (como Mi viaje).
//
// El historial de cargas va SIEMPRE en el mismo lugar del árbol (y solo se oculta al cambiar de
// pestaña): si cambiara de sitio, React lo montaría de nuevo y perdería el filtro de fechas.
import { useCallback, useEffect, useRef, useState } from "react";

import HistorialCargasTanqueta from "./HistorialCargasTanqueta";
import KardexTanqueta from "./KardexTanqueta";
import { leerKardex, type KardexDeTanqueta } from "./kardexTanquetaDatos";
import NivelDeTanqueta, { type ProblemaDeActualizacion, type TanquetaMia } from "./NivelDeTanqueta";
import PendientesDeEnvio from "./PendientesDeEnvio";
import PestanasDeTanqueta from "./PestanasDeTanqueta";
import { idPanel, idPestana, type VistaDeTanqueta } from "./pestanasDeTanquetaIds";
import { useAuth } from "../../context/AuthContext";
import { listarPendientes, suscribirseACola } from "../../offline/offlineQueue";
import { suscribirseASincronizacion } from "../../offline/offlineSync";
import { galonesPendientesPorTanqueta } from "../../offline/pendientesCola";
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
  /** Los movimientos de cada tanqueta (por id), recortados a los más recientes. */
  kardex: Record<string, KardexDeTanqueta>;
}

/** Los movimientos con la tanqueta a la que pertenecen: nunca se pintan bajo otro cilindro. */
interface KardexDe {
  id: number;
  datos: KardexDeTanqueta;
}

/** Lo máximo que se guarda de cada kardex en el celular. */
const FILAS_EN_CACHE = 100;

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
    const c = crudo ? JSON.parse(crudo) : null;
    if (!c || !Array.isArray(c.tanquetas) || !c.tanquetas.every(esTanquetaValida)) return null;
    // Unos movimientos guardados con otra forma se descartan; las tanquetas se conservan.
    const kardex: Record<string, KardexDeTanqueta> = {};
    for (const [id, k] of Object.entries(c.kardex ?? {})) {
      const leido = leerKardex(k);
      if (leido) kardex[id] = leido;
    }
    return { guardadoEn: c.guardadoEn, tanquetas: c.tanquetas, kardex };
  } catch {
    return null;
  }
}

/** Una fecha guardada que no se puede leer no se muestra (mejor sin hora que "Invalid Date"). */
const fechaDelCache = (iso: unknown): Date | null => {
  const t = typeof iso === "string" ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? null : new Date(t);
};

const iguales = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

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
  const [kardex, setKardex] = useState<KardexDe | null>(null);
  const [cargandoKardex, setCargandoKardex] = useState(false);
  const [errorKardex, setErrorKardex] = useState<string | null>(null);
  const [vista, setVista] = useState<VistaDeTanqueta>("movimientos");
  // Galones cargados sin señal y aún en la cola, por tanqueta.
  const [enCola, setEnCola] = useState<Record<number, number>>({});
  // Galones que ya se enviaron (salieron de la cola sin que se rechazaran) y que el último saldo
  // que se pudo leer todavía no incluye: se descuentan hasta la siguiente lectura buena.
  const [confirmadas, setConfirmadas] = useState<Record<number, number>>({});

  // Una consulta lenta no debe pisar a la que se pidió después (un evento, volver la señal, otra
  // tanqueta elegida).
  const pedido = useRef(0);
  const pedidoKardex = useRef(0);
  const elegidaRef = useRef<number | null>(null);
  const cache = useRef<CacheLocal>({ guardadoEn: "", tanquetas: [], kardex: {} });
  // Lo último escrito en el celular: si no cambió, no se vuelve a escribir (cada refresco serializa
  // hasta 300 filas).
  const ultimoTexto = useRef("");
  // La cola de la última lectura, lo que salió de ella sin saber aún si se envió o se rechazó, y
  // cuándo avisó la sincronización que envió algo sin rechazos.
  const colaPrevia = useRef<Record<number, number>>({});
  const salidas = useRef<{ id: number; g: number; t: number }[]>([]);
  const envioLimpioEn = useRef(0);

  const guardar = useCallback(() => {
    try {
      const texto = JSON.stringify(cache.current);
      if (texto === ultimoTexto.current) return;
      localStorage.setItem(claveCache(usuarioId), texto);
      ultimoTexto.current = texto;
    } catch {
      // Sin espacio o en modo privado: se sigue sin caché.
    }
  }, [usuarioId]);

  const cargarKardex = useCallback(
    async (id: number) => {
      const mio = ++pedidoKardex.current;
      setCargandoKardex(true);
      try {
        const res = await apiFetch(`/api/erp/combustible/tanquetas/${id}/kardex`);
        const cuerpo = await res.json().catch(() => null);
        if (mio !== pedidoKardex.current) return;
        if (res.status === 404) {
          // Ya no es de su unidad (la devolvieron al grifero): la lista la quitará en el próximo refresco.
          setKardex(null);
          setErrorKardex("Esta tanqueta ya no está asignada a tu unidad.");
          return;
        }
        const datos = res.ok ? leerKardex(cuerpo) : null;
        if (!datos) {
          // Se queda lo que había (si había) y se dice.
          setErrorKardex(mensajeDeError(cuerpo, "No se pudieron cargar los movimientos."));
          return;
        }
        // Si nada cambió se conserva el mismo objeto: así la tabla no se repinta entera.
        setKardex((previo) =>
          previo?.id === id && iguales(previo.datos, datos) ? previo : { id, datos }
        );
        setErrorKardex(null);
        cache.current.kardex[String(id)] = {
          ...datos,
          filas: datos.filas.slice(0, FILAS_EN_CACHE),
          truncado: datos.truncado || datos.filas.length > FILAS_EN_CACHE,
        };
        guardar();
      } catch {
        if (mio !== pedidoKardex.current) return;
        // Sin señal: lo último que se vio de esta tanqueta, y se dice que es lo guardado.
        const guardado = cache.current.kardex[String(id)];
        if (guardado) {
          setKardex({ id, datos: guardado });
          setErrorKardex("Sin conexión: se muestran los movimientos guardados en este celular.");
        } else {
          setErrorKardex("Sin conexión: no se pudieron cargar los movimientos.");
        }
      } finally {
        if (mio === pedidoKardex.current) setCargandoKardex(false);
      }
    },
    [guardar]
  );

  const mostrar = useCallback((lista: TanquetaMia[]) => {
    setTanquetas(lista);
    // Se queda la que estaba mirando; si ya no es suya (la devolvieron), la primera.
    const sigue = lista.find((t) => t.id === elegidaRef.current);
    const id = sigue ? sigue.id : (lista[0]?.id ?? null);
    // Un aviso de los movimientos de otra tanqueta no se queda bajo la nueva.
    if (id !== elegidaRef.current) setErrorKardex(null);
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
      setConfirmadas({});
      setActualizadoEn(ahora);
      // Del caché se van los movimientos de tanquetas que ya no son suyas.
      const siguen = new Set(cuerpo.map((t) => String(t.id)));
      const kardexVigente = Object.fromEntries(
        Object.entries(cache.current.kardex).filter(([id]) => siguen.has(id))
      );
      cache.current = { guardadoEn: ahora.toISOString(), tanquetas: cuerpo, kardex: kardexVigente };
      guardar();
      // Los movimientos de la que está mirando, junto con el cilindro: que cuadren.
      if (elegidaRef.current !== null) void cargarKardex(elegidaRef.current);
      else setKardex(null);
    } catch {
      if (mio !== pedido.current) return;
      // Sin señal: lo último que se vio.
      const guardado = leerCache(usuarioId);
      if (guardado && guardado.tanquetas.length > 0) {
        cache.current = guardado;
        mostrar(guardado.tanquetas);
        setActualizadoEn(fechaDelCache(guardado.guardadoEn));
        const id = elegidaRef.current;
        const suyo = id === null ? undefined : guardado.kardex[String(id)];
        setKardex(id !== null && suyo ? { id, datos: suyo } : null);
        setErrorKardex(suyo ? null : "Sin conexión: no se pudieron cargar los movimientos.");
        setError(null);
      } else {
        setError("Sin conexión: no se pudo cargar tu tanqueta. Vuelve a intentarlo con señal.");
      }
      setProblema("sin_senal");
    } finally {
      if (mio === pedido.current) setCargando(false);
    }
  }, [usuarioId, mostrar, cargarKardex, guardar]);

  useEffect(() => {
    // Patrón estándar de carga al montar -- ver IpercView.tsx.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void cargar();
    // Las ráfagas (una carga publica varios eventos) se juntan en una sola recarga.
    let temporizador: number | undefined;
    let activo = true;
    const refrescar = () => {
      // Una llamada que llega tarde (la cola avisa de forma diferida) no debe programar nada
      // cuando la pantalla ya se fue.
      if (!activo) return;
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
    const confirmar = (id: number, g: number) =>
      setConfirmadas((c) => ({ ...c, [id]: Math.round(((c[id] ?? 0) + g) * 100) / 100 }));
    const dejarDeOirCola = suscribirseASincronizacion(({ sincronizadas, descartadas }) => {
      if (sincronizadas <= 0) return;
      refrescar();
      // Si la sincronización rechazó algo no se sabe qué salió bien: no se da nada por enviado
      // (el próximo saldo bueno corrige la pantalla).
      if (descartadas.length === 0) {
        envioLimpioEn.current = Date.now();
        for (const s of salidas.current) if (Date.now() - s.t < 3000) confirmar(s.id, s.g);
      }
      salidas.current = [];
    });
    // Lo que entra o sale de la cola cambia lo pendiente (y al entrar sin señal, el refresco falla
    // y deja el aviso "sin señal" que activa el descuento).
    let vivo = true;
    const leerCola = () => {
      listarPendientes()
        .then((entradas) => {
          if (!vivo) return;
          const nueva = galonesPendientesPorTanqueta(entradas);
          // Lo que salió de la cola: si la sincronización acaba de avisar que envió sin rechazos,
          // se da por enviado; si no, queda anotado unos segundos por si el aviso llega después.
          for (const [id, antes] of Object.entries(colaPrevia.current)) {
            const salio = Math.round((antes - (nueva[Number(id)] ?? 0)) * 100) / 100;
            if (salio <= 0) continue;
            if (Date.now() - envioLimpioEn.current < 3000) confirmar(Number(id), salio);
            else salidas.current.push({ id: Number(id), g: salio, t: Date.now() });
          }
          colaPrevia.current = nueva;
          setEnCola(nueva);
        })
        .catch(() => {});
    };
    leerCola();
    // La primera llamada la hace la propia suscripción al registrarse (para dar el estado
    // inicial): no es un cambio, y refrescar ahí duplicaba la petición al montar.
    let primera = true;
    const dejarDeOirLaCola = suscribirseACola(() => {
      leerCola();
      if (primera) primera = false;
      else refrescar();
    });
    return () => {
      vivo = false;
      dejarDeOirLaCola();
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
    setErrorKardex(null);
    // Se pide la nueva; mientras llega no se ven los movimientos de la anterior (cada kardex
    // sabe a qué tanqueta pertenece).
    void cargarKardex(id);
  };

  const elegida = tanquetas.find((t) => t.id === elegidaId) ?? tanquetas[0];
  const delaElegida = elegida && kardex?.id === elegida.id ? kardex.datos : null;
  // Lo cargado sin señal ya salió de la tanqueta: se descuenta mientras siga en la cola (con o
  // sin señal: el servidor aún no lo tiene) y, una vez enviado, hasta que una lectura buena lo
  // incluya. Un descuento que llegara a coincidir con el servidor sería una doble resta, que es
  // mejor que mostrar de más: dura lo que tarde la cola en confirmar.
  const descuentoDe = (id: number) => (enCola[id] ?? 0) + (confirmadas[id] ?? 0);
  const ajustadas = tanquetas.map((t) => {
    const d = descuentoDe(t.id);
    return d > 0 ? { ...t, saldo: Math.round((t.saldo - d) * 100) / 100, libre: t.libre + d } : t;
  });
  const elegidaAjustada = elegida && ajustadas.find((t) => t.id === elegida.id);
  const pendiente = elegida ? (enCola[elegida.id] ?? 0) : 0;

  return (
    <section className="mb-6 grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,260px)_minmax(0,1fr)]">
      {elegida ? (
        <NivelDeTanqueta
          tanquetas={ajustadas}
          elegida={elegidaAjustada ?? elegida}
          onElegir={elegir}
          problema={problema}
          actualizadoEn={actualizadoEn}
          enCola={pendiente}
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
        {elegida && <PestanasDeTanqueta vista={vista} onCambiar={setVista} />}
        {/* Lo registrado sin señal debe verse aunque esté en "Movimientos": el historial (donde
            vive este aviso) queda oculto en esa pestaña. */}
        {elegida && vista === "movimientos" && <PendientesDeEnvio ambito="tanqueta" />}
        {elegida && vista === "movimientos" && (
          <div
            role="tabpanel"
            id={idPanel("movimientos")}
            aria-labelledby={idPestana("movimientos")}
          >
            <KardexTanqueta
              key={elegida.id}
              kardex={delaElegida}
              codigo={elegida.codigo}
              saldoCilindro={elegida.saldo}
              conPendientes={descuentoDe(elegida.id) > 0}
              cargando={cargandoKardex}
              error={errorKardex}
            />
          </div>
        )}
        {/* Siempre montado y en el mismo lugar: solo se oculta (conserva su filtro de fechas). */}
        <div
          role={elegida ? "tabpanel" : undefined}
          id={elegida ? idPanel("cargas") : undefined}
          aria-labelledby={elegida ? idPestana("cargas") : undefined}
          hidden={Boolean(elegida) && vista === "movimientos"}
        >
          <HistorialCargasTanqueta />
        </div>
      </div>
    </section>
  );
}
