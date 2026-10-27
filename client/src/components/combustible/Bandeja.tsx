// client/src/components/combustible/Bandeja.tsx
//
// La Bandeja de alertas de combustible: el lugar donde se LEEN y se RESUELVEN.
// La campanita avisa; acá se despacha. Se pensó como un correo (lista a la
// izquierda, detalle a la derecha) porque el correo corporativo del cliente es
// compartido y las alertas se perdían entre todo lo demás: lo que importa es
// que queden en un lugar donde alguien las cierre con un motivo.
//
// Todo lo que muestra ya viene acotado por el alcance de quien mira (el
// servidor filtra en GET /alertas y /alertas/resumen).

import { ArrowLeft, CheckCircle2, Eye, Search, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAuth } from "../../context/AuthContext";
import { apiFetch } from "../../services/apiClient";
import { mensajeDeError } from "../../utils/mensajeDeError";
import { usePuedeEscribir } from "../comunes/usePuedeEscribir";
import { useSedes } from "../comunes/useSedes";

import {
  ETIQUETA_TIPO_ALERTA,
  describirDetalleAlerta,
  referenciaAlerta,
  type AlertaCombustible,
} from "./alertasTexto";
import { DetalleViajeVentana } from "./DetalleViaje";
import { CLAVE_ALERTA_PENDIENTE, useAlertasCombustibleStream } from "./useAlertasCombustibleStream";

type Estado = "sin_leer" | "pendientes" | "resueltas" | "congeladas" | "todas";

interface AlertaBandeja extends AlertaCombustible {
  grifo_interno_id: number | null;
  grifo_nombre: string | null;
  sede_nombre: string | null;
  revisable: boolean;
  congelada_en: string | null;
}

interface Resumen {
  sinLeer: number;
  pendientes: number;
  porRevisar: number;
  resueltas: number;
  congeladas: number;
  criticasPendientes: number;
  total: number;
}

const TAMANO_PAGINA = 50;

const PESTANAS: { estado: Estado; etiqueta: string; contador: keyof Resumen }[] = [
  { estado: "pendientes", etiqueta: "Pendientes", contador: "pendientes" },
  { estado: "sin_leer", etiqueta: "Sin leer", contador: "sinLeer" },
  { estado: "resueltas", etiqueta: "Resueltas", contador: "resueltas" },
  // El historial de lo que nadie explicó a tiempo (antes, abajo del modal de
  // Tanques). Las que siguen pendientes se cierran desde acá como cualquier otra.
  { estado: "congeladas", etiqueta: "Congeladas", contador: "congeladas" },
  { estado: "todas", etiqueta: "Todas", contador: "total" },
];

const fechaHora = (iso: string) => new Date(iso).toLocaleString("es-PE");

/** Sin efectos secundarios: se usa al crear el estado, y React puede llamarlo
 *  dos veces. El borrado va aparte, en un efecto (borrarAlertaPendiente). */
function leerAlertaPendiente(): number | null {
  try {
    const valor = sessionStorage.getItem(CLAVE_ALERTA_PENDIENTE);
    const id = Number(valor);
    return valor !== null && Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

function borrarAlertaPendiente() {
  try {
    sessionStorage.removeItem(CLAVE_ALERTA_PENDIENTE);
  } catch {
    // Sin sessionStorage no hay nada que borrar.
  }
}

export default function BandejaAlertas() {
  const puedeEscribir = usePuedeEscribir("combustible");
  const { grifosActivos } = useSedes();
  // El stream es la misma fuente de tiempo real que la campanita: cuando
  // nace o se resuelve una alerta, cambia `noLeidas` y la Bandeja se recarga.
  const { noLeidas } = useAlertasCombustibleStream(true);

  // Llegar desde la campanita: la alerta clickeada queda abierta. Se busca en
  // "Todas" porque abrirla ya la marcó leída y puede estar resuelta.
  const [alertaInicial] = useState(leerAlertaPendiente);
  const [estado, setEstado] = useState<Estado>(alertaInicial !== null ? "todas" : "pendientes");
  const [tipo, setTipo] = useState("");
  const [grifo, setGrifo] = useState("");
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [busqueda, setBusqueda] = useState("");
  const [busquedaAplicada, setBusquedaAplicada] = useState("");
  const [pagina, setPagina] = useState(1);

  const [alertas, setAlertas] = useState<AlertaBandeja[]>([]);
  const [total, setTotal] = useState(0);
  const [resumen, setResumen] = useState<Resumen | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [seleccionadaId, setSeleccionadaId] = useState<number | null>(alertaInicial);
  // El viaje de una alerta de viaje (0156), abierto en su ventana. Quien no ve la pestaña Viajes no
  // recibe el botón (el servidor le daría 403).
  const { usuario } = useAuth();
  const puedeVerViajes = usuario?.permisosPestanas?.["combustible:viajes"] !== false;
  const [viajeAbierto, setViajeAbierto] = useState<string | null>(null);
  // La alerta a la que se llegó desde la campanita, pedida por su id: la lista
  // trae 50 por página y la clickeada puede ser más antigua que eso.
  const [alertaDirecta, setAlertaDirecta] = useState<AlertaBandeja | null>(null);

  const [motivo, setMotivo] = useState("");
  const [resolviendo, setResolviendo] = useState(false);
  const [errorResolver, setErrorResolver] = useState<string | null>(null);
  const [avisoResolver, setAvisoResolver] = useState<string | null>(null);

  // La búsqueda espera a que se deje de escribir: una consulta por tecla
  // sobre el detalle de todas las alertas no tiene sentido.
  useEffect(() => {
    const t = setTimeout(() => {
      setBusquedaAplicada(busqueda.trim());
      setPagina(1);
    }, 300);
    return () => clearTimeout(t);
  }, [busqueda]);

  const filtrosQuery = useMemo(() => {
    const p = new URLSearchParams();
    if (tipo) p.set("tipo", tipo);
    if (grifo) p.set("grifo_interno_id", grifo);
    if (desde) p.set("desde", desde);
    if (hasta) p.set("hasta", hasta);
    if (busquedaAplicada) p.set("q", busquedaAplicada);
    return p;
  }, [tipo, grifo, desde, hasta, busquedaAplicada]);

  // Número de la última petición: una respuesta lenta de un filtro anterior no
  // puede pisar la de lo que el usuario tiene seleccionado ahora (pasa al
  // cambiar de pestaña o de filtro rápido, o cuando llega un aviso en vivo).
  const peticionActual = useRef(0);

  const cargar = useCallback(async () => {
    const mia = ++peticionActual.current;
    const vigente = () => mia === peticionActual.current;
    setCargando(true);
    setError(null);
    try {
      const lista = new URLSearchParams(filtrosQuery);
      lista.set("estado", estado);
      lista.set("page", String(pagina));
      lista.set("pageSize", String(TAMANO_PAGINA));
      const [resLista, resResumen] = await Promise.all([
        apiFetch(`/api/erp/combustible/alertas?${lista.toString()}`),
        apiFetch(`/api/erp/combustible/alertas/resumen?${filtrosQuery.toString()}`),
      ]);
      if (!vigente()) return;
      if (!resLista.ok || !resResumen.ok) {
        const cuerpo = await (resLista.ok ? resResumen : resLista).json().catch(() => ({}));
        if (vigente()) setError(mensajeDeError(cuerpo, "No se pudo cargar la bandeja."));
        return;
      }
      const cuerpoLista = await resLista.json();
      const cuerpoResumen = await resResumen.json();
      if (!vigente()) return;
      // El id es BIGINT y llega como texto; la campanita lo pasa como número.
      // Sin normalizar, "123" === 123 nunca coincide y la alerta que se
      // clickeó en la campanita no queda seleccionada.
      setAlertas((cuerpoLista.data as AlertaBandeja[]).map((a) => ({ ...a, id: Number(a.id) })));
      setTotal(cuerpoLista.pagination.total);
      setResumen(cuerpoResumen);
    } catch {
      if (vigente()) setError("No se pudo cargar la bandeja. Revisa tu conexión.");
    } finally {
      if (vigente()) setCargando(false);
    }
  }, [filtrosQuery, estado, pagina]);

  useEffect(() => {
    // Carga de datos al cambiar los filtros o al llegar una alerta por el
    // stream: es el caso para el que existe el efecto.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void cargar();
  }, [cargar, noLeidas]);

  const traerAlerta = useCallback(async (id: number) => {
    try {
      const res = await apiFetch(`/api/erp/combustible/alertas?id=${id}&estado=todas&pageSize=1`);
      if (!res.ok) return;
      const cuerpo = await res.json();
      const fila = (cuerpo.data as AlertaBandeja[])[0];
      // Fuera de su alcance el servidor no la devuelve: queda sin detalle.
      setAlertaDirecta(fila ? { ...fila, id: Number(fila.id) } : null);
    } catch {
      setAlertaDirecta(null);
    }
  }, []);

  // Si la Bandeja ya estaba abierta cuando se clickeó la campanita, el aviso
  // llega por `window`. El id guardado se borra para no reabrirla después.
  useEffect(() => {
    borrarAlertaPendiente();
    // Pedir la alerta de la campanita al montar: es carga de datos, el caso
    // para el que existe el efecto (el setState ocurre después del await).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (alertaInicial !== null) void traerAlerta(alertaInicial);
    const alAviso = (evento: Event) => {
      // El id viene como texto (el servidor devuelve el BIGINT así) o como
      // número según quién lo mande: se normaliza, no se descarta.
      const id = Number((evento as CustomEvent<{ alertaId: number | string }>).detail?.alertaId);
      if (!Number.isInteger(id) || id <= 0) return;
      borrarAlertaPendiente();
      setEstado("todas");
      setPagina(1);
      setSeleccionadaId(id);
      setMotivo("");
      setErrorResolver(null);
      setAvisoResolver(null);
      void traerAlerta(id);
    };
    window.addEventListener("combustible:abrir-alerta", alAviso);
    return () => window.removeEventListener("combustible:abrir-alerta", alAviso);
    // alertaInicial no cambia nunca (nace con el estado) y traerAlerta es estable.
  }, [alertaInicial, traerAlerta]);

  const seleccionada =
    alertas.find((a) => a.id === seleccionadaId) ??
    (alertaDirecta !== null && alertaDirecta.id === seleccionadaId ? alertaDirecta : null);

  const abrirAlerta = async (a: AlertaBandeja) => {
    setSeleccionadaId(a.id);
    setMotivo("");
    setErrorResolver(null);
    setAvisoResolver(null);
    // Abrirla es leerla, como en un correo. Quien solo consulta el módulo no
    // marca: el servidor se lo rechaza, y su lectura no cuenta como revisión.
    if (a.leida_en === null && puedeEscribir) {
      const res = await apiFetch("/api/erp/combustible/alertas/leidas", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [a.id] }),
      });
      if (res.ok) {
        const ahora = new Date().toISOString();
        setAlertas((prev) => prev.map((x) => (x.id === a.id ? { ...x, leida_en: ahora } : x)));
        setResumen((r) => (r ? { ...r, sinLeer: Math.max(0, r.sinLeer - 1) } : r));
      }
    }
  };

  const resolver = async () => {
    if (!seleccionada || resolviendo) return;
    const texto = motivo.trim();
    if (!texto) {
      setErrorResolver("Escribe el motivo: cerrar una alerta sin decir por qué es taparla.");
      return;
    }
    setResolviendo(true);
    setErrorResolver(null);
    try {
      const res = await apiFetch(`/api/erp/combustible/alertas/${seleccionada.id}/resolver`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ motivo: texto }),
      });
      const cuerpo = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErrorResolver(mensajeDeError(cuerpo, "No se pudo resolver la alerta."));
        return;
      }
      setMotivo("");
      setAvisoResolver(
        cuerpo.autorevision
          ? "Quedó revisada. Como participaste en el hecho, la bitácora la marca como autorrevisión."
          : "Quedó revisada, con tu nombre y el motivo en la bitácora."
      );
      // El contador de la Bandeja en el menú y la campanita se enteran por acá.
      window.dispatchEvent(new Event("combustible:actualizado"));
      await cargar();
      // La copia pedida por id no se recarga con la lista: se refresca aparte.
      if (alertaDirecta?.id === seleccionada.id) await traerAlerta(seleccionada.id);
    } finally {
      setResolviendo(false);
    }
  };

  const cambiarFiltro = (aplicar: () => void) => {
    aplicar();
    setPagina(1);
    setSeleccionadaId(null);
  };

  const totalPaginas = Math.max(1, Math.ceil(total / TAMANO_PAGINA));
  const tiposOrdenados = useMemo(
    () =>
      (Object.entries(ETIQUETA_TIPO_ALERTA) as [string, string][]).sort((x, y) =>
        x[1].localeCompare(y[1], "es")
      ),
    []
  );

  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="Estado" className="flex flex-wrap gap-2">
        {PESTANAS.map((p) => (
          <button
            key={p.estado}
            role="tab"
            aria-selected={estado === p.estado}
            onClick={() => cambiarFiltro(() => setEstado(p.estado))}
            className={`px-3 py-2 rounded-lg text-sm font-semibold border transition-colors ${
              estado === p.estado
                ? "bg-[#BADC1E] text-black border-[#BADC1E] hover:bg-[#c8e64a]"
                : "bg-[#192526] text-[#94a3b8] border-[#2a2e37] hover:bg-[#2a2e37]"
            }`}
          >
            {p.etiqueta}
            {resumen && <span className="ml-2 tabular-nums">{resumen[p.contador]}</span>}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        <label className="relative flex-1 min-w-[220px]">
          <span className="sr-only">Buscar</span>
          <Search
            className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
            aria-hidden="true"
          />
          <input
            type="search"
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            placeholder="Buscar por vale, tanque o detalle"
            className="w-full border border-slate-200 rounded-lg pl-9 pr-3 py-2 text-sm"
          />
        </label>
        <label className="w-full sm:w-56">
          <span className="sr-only">Tipo de alerta</span>
          <select
            value={tipo}
            onChange={(e) => cambiarFiltro(() => setTipo(e.target.value))}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
          >
            <option value="">Todos los tipos</option>
            {tiposOrdenados.map(([valor, etiqueta]) => (
              <option key={valor} value={valor}>
                {etiqueta}
              </option>
            ))}
          </select>
        </label>
        {grifosActivos.length > 1 ? (
          <label className="w-full sm:w-56">
            <span className="sr-only">Grifo</span>
            <select
              value={grifo}
              onChange={(e) => cambiarFiltro(() => setGrifo(e.target.value))}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
            >
              <option value="">Todos los grifos</option>
              {grifosActivos.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.etiqueta}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <div className="flex gap-2 w-full sm:w-auto">
          <label className="flex-1 sm:flex-none">
            <span className="sr-only">Desde</span>
            <input
              type="date"
              value={desde}
              onChange={(e) => cambiarFiltro(() => setDesde(e.target.value))}
              className="w-full sm:w-40 border border-slate-200 rounded-lg px-2 py-2 text-sm"
              title="Desde"
            />
          </label>
          <label className="flex-1 sm:flex-none">
            <span className="sr-only">Hasta</span>
            <input
              type="date"
              value={hasta}
              onChange={(e) => cambiarFiltro(() => setHasta(e.target.value))}
              className="w-full sm:w-40 border border-slate-200 rounded-lg px-2 py-2 text-sm"
              title="Hasta"
            />
          </label>
        </div>
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {/* Fuera del detalle: al resolverla, la alerta sale de "Pendientes" y el
          detalle se vacía, pero la confirmación tiene que verse igual. */}
      {avisoResolver && (
        <p role="status" className="text-sm text-emerald-600">
          {avisoResolver}
        </p>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        {/* Lista. En pantallas chicas se oculta mientras hay una abierta. */}
        <section
          aria-label="Alertas"
          className={`lg:col-span-2 bg-white border border-slate-200 rounded-2xl overflow-hidden ${
            seleccionada ? "hidden lg:block" : ""
          }`}
        >
          {cargando && alertas.length === 0 ? (
            <p className="p-6 text-center text-sm text-slate-500">Cargando alertas...</p>
          ) : alertas.length === 0 ? (
            <p className="p-6 text-center text-sm text-slate-500">
              No hay alertas con estos filtros.
            </p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {alertas.map((a) => {
                const critica = a.critica;
                const activa = a.id === seleccionadaId;
                return (
                  <li key={a.id}>
                    <button
                      onClick={() => void abrirAlerta(a)}
                      aria-current={activa ? "true" : undefined}
                      className={`w-full text-left px-4 py-3 transition-colors ${
                        activa ? "bg-slate-100" : "hover:bg-slate-50"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        {a.leida_en === null && (
                          <span
                            className="w-2 h-2 rounded-full bg-[#BADC1E] shrink-0"
                            aria-label="Sin leer"
                          />
                        )}
                        <span
                          className={`text-sm truncate ${
                            a.leida_en === null ? "font-bold text-slate-900" : "text-slate-700"
                          }`}
                        >
                          {ETIQUETA_TIPO_ALERTA[a.tipo] ?? a.tipo}
                        </span>
                        <span className="ml-auto text-xs text-slate-400 whitespace-nowrap">
                          {fechaHora(a.creado_en)}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
                        {critica && !a.resuelta_en && (
                          <span className="font-bold uppercase text-red-600">Revisar</span>
                        )}
                        {a.resuelta_en && <span className="text-emerald-600">Resuelta</span>}
                        {a.congelada_en && <span className="text-amber-600">Congelada</span>}
                        <span className="font-mono truncate">{referenciaAlerta(a)}</span>
                        {a.grifo_nombre && <span className="truncate">· {a.grifo_nombre}</span>}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {totalPaginas > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-slate-100 text-sm">
              <button
                onClick={() => setPagina((p) => Math.max(1, p - 1))}
                disabled={pagina === 1}
                className="text-slate-600 disabled:opacity-40"
              >
                Anterior
              </button>
              <span className="text-slate-500">
                Página {pagina} de {totalPaginas}
              </span>
              <button
                onClick={() => setPagina((p) => Math.min(totalPaginas, p + 1))}
                disabled={pagina === totalPaginas}
                className="text-slate-600 disabled:opacity-40"
              >
                Siguiente
              </button>
            </div>
          )}
        </section>

        {/* Detalle */}
        <section
          aria-label="Detalle de la alerta"
          className={`lg:col-span-3 bg-white border border-slate-200 rounded-2xl p-5 lg:sticky lg:top-24 lg:self-start lg:max-h-[calc(100vh-7rem)] lg:overflow-y-auto ${
            seleccionada ? "" : "hidden lg:block"
          }`}
        >
          {!seleccionada ? (
            <p className="text-sm text-slate-500 text-center py-10">
              Elige una alerta de la lista para ver el detalle.
            </p>
          ) : (
            <div className="space-y-4">
              <button
                onClick={() => setSeleccionadaId(null)}
                className="lg:hidden flex items-center gap-1 text-sm text-slate-600"
              >
                <ArrowLeft className="w-4 h-4" aria-hidden="true" /> Volver a la lista
              </button>
              <div>
                <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                  {seleccionada.critica && (
                    <TriangleAlert className="w-5 h-5 text-red-600" aria-hidden="true" />
                  )}
                  {ETIQUETA_TIPO_ALERTA[seleccionada.tipo] ?? seleccionada.tipo}
                </h2>
                <p className="text-sm text-slate-500">
                  {fechaHora(seleccionada.creado_en)}
                  {seleccionada.grifo_nombre &&
                    ` · ${
                      seleccionada.sede_nombre &&
                      seleccionada.sede_nombre !== seleccionada.grifo_nombre
                        ? `${seleccionada.sede_nombre} · `
                        : ""
                    }${seleccionada.grifo_nombre}`}
                </p>
              </div>
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                <div>
                  <dt className="text-xs font-bold uppercase text-slate-400">Referencia</dt>
                  <dd className="font-mono text-slate-800">{referenciaAlerta(seleccionada)}</dd>
                </div>
                <div>
                  <dt className="text-xs font-bold uppercase text-slate-400">Estado</dt>
                  <dd className="text-slate-800">
                    {seleccionada.resuelta_en
                      ? `${seleccionada.resuelta_por ? "Revisada" : "Resuelta sola"} el ${fechaHora(seleccionada.resuelta_en)}`
                      : seleccionada.congelada_en
                        ? "Pendiente, congelada como anomalía"
                        : "Pendiente"}
                  </dd>
                </div>
              </dl>
              <div>
                <h3 className="text-xs font-bold uppercase text-slate-400 mb-1">Qué pasó</h3>
                <p className="text-sm text-slate-700 whitespace-pre-line">
                  {describirDetalleAlerta(seleccionada)}
                </p>
              </div>
              {seleccionada.viaje_id != null && puedeVerViajes && (
                <button
                  onClick={() => setViajeAbierto(String(seleccionada.viaje_id))}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold border border-slate-300 text-slate-800 hover:bg-slate-50"
                >
                  <Eye className="w-4 h-4" aria-hidden="true" /> Ver el viaje
                </button>
              )}
              {seleccionada.congelada_en && (
                <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-xl p-3">
                  Congelada el {fechaHora(seleccionada.congelada_en)}: pasó su plazo sin explicación
                  y quedó como anomalía. Esa copia es evidencia permanente: no se borra aunque la
                  alerta se revise después.
                </p>
              )}

              {!seleccionada.resuelta_en && seleccionada.revisable && puedeEscribir && (
                <div className="space-y-2 border-t border-slate-100 pt-4">
                  <label
                    htmlFor="bandeja-motivo"
                    className="block text-xs font-bold uppercase text-slate-700"
                  >
                    Motivo de la revisión *
                  </label>
                  <textarea
                    id="bandeja-motivo"
                    rows={3}
                    maxLength={500}
                    value={motivo}
                    onChange={(e) => setMotivo(e.target.value)}
                    placeholder="Ej: se verificó con el papel, el vale estaba bien cargado"
                    className="w-full border border-slate-200 rounded-xl p-3 text-sm"
                  />
                  {errorResolver && (
                    <p role="alert" className="text-sm text-red-600">
                      {errorResolver}
                    </p>
                  )}
                  <button
                    onClick={() => void resolver()}
                    disabled={resolviendo}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold bg-[#BADC1E] text-black hover:bg-[#c8e64a] disabled:opacity-50"
                  >
                    <CheckCircle2 className="w-4 h-4" aria-hidden="true" />
                    {resolviendo ? "Guardando..." : "Dar por revisada"}
                  </button>
                </div>
              )}
              {!seleccionada.resuelta_en && !seleccionada.revisable && (
                <p className="text-sm text-slate-500 border-t border-slate-100 pt-4">
                  Esta alerta se cierra sola cuando se corrige el hecho (por ejemplo, cuando llega
                  el vale que faltaba o se mide el tanque).
                </p>
              )}
            </div>
          )}
        </section>
      </div>
      {/* Solo mientras sigue elegida la alerta de ese viaje: al pasar a otra, se cierra. */}
      {viajeAbierto && String(seleccionada?.viaje_id) === viajeAbierto && (
        <DetalleViajeVentana viajeId={viajeAbierto} onCerrar={() => setViajeAbierto(null)} />
      )}
    </div>
  );
}
