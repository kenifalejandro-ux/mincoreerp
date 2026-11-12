// Control de viajes en modo TV: la pantalla de la gerencia. Solo lectura, a pantalla completa, con la
// flota en vivo, lo que hay de combustible y lo que se consume. Se refresca sola cada minuto y al
// instante cuando algo cambia (tiempo real); si una actualización falla, deja lo último que mostró
// en vez de vaciarse. Combustible y Urea son opcionales: sin ellos esa parte no aparece.
import {
  Bell,
  Clock,
  Droplets,
  Fuel,
  Inbox,
  LayoutDashboard,
  LogOut,
  Maximize,
  Minimize,
  Truck,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { type FilaViaje } from "../components/combustible/viajesFormato";
import { CATS, porcentajeOperativas } from "../components/controlTv/controlTvLogica";
import { DetalleTv, type DetalleDatos } from "../components/controlTv/DetalleTv";
import { IconoTipo } from "../components/controlTv/iconosUnidad";
import { MapaDigital } from "../components/controlTv/MapaDigital";
import type { LugarMapa } from "../components/controlTv/mapaLogica";
import type {
  EnvaseTv,
  EventoTv,
  NivelTanque,
  SerieConsumo,
  TanquetaTv,
} from "../components/controlTv/paneles";
import {
  FranjaEventos,
  PanelConsumo,
  PanelTanque,
  PanelTanquetas,
  PanelUrea,
} from "../components/controlTv/PanelesTv";
import { ResumenCorporativo, UnidadesDetenidas } from "../components/controlTv/ResumenCorporativo";
import { useEsMovil, useEsPantallaChica } from "../components/controlTv/useEsMovil";
import { VistaUnidad } from "../components/controlTv/VistaUnidad";
import { apiFetch } from "../services/apiClient";

type Periodo = "24h" | "7d" | "30d";

interface Resumen {
  empresa?: string;
  /** null = todas las sedes; si no, las sedes de quien mira. */
  sedes?: string[] | null;
  flota: {
    activos: number;
    programados: number;
    en_ruta: number;
    retornando: number;
    en_parada: number;
    descansando: number;
    detenidas: number;
    por_tipo: { tipo: string; cantidad: number }[];
  };
  eventos?: EventoTv[];
  combustible?: {
    tanques: { capacidad: number; nivel: number | string | null; costo_promedio: number | null }[];
    total_en_tanques_gal: number;
    tanquetas: { saldo_total_gal: number; items: TanquetaTv[] };
    cisternas: { con_saldo: number; saldo_gal: number; por_llegar: number; por_llegar_gal: number };
    alertas: { criticas: number; por_revisar: number };
  };
  urea?: {
    stock_l: number;
    minimo_l: number | null;
    maximo_l: number | null;
    autonomia_dias: number | null;
    envases: EnvaseTv[];
  };
}

interface Consumo {
  consumo?: {
    total: {
      gal: number;
      costo: number;
      interno_gal: number;
      tanqueta_gal: number;
      ruta_gal: number;
    };
    serie: SerieConsumo[];
    agrupado_por: "hora" | "dia";
  };
  entrada?: { recepciones: number; recibido_gal: number; diferencia_gal: number; costo: number };
  niveles?: NivelTanque[];
}

type TabMovil = "resumen" | "flota" | "combustible" | "urea" | "eventos";

const PERIODOS: { id: Periodo; t: string }[] = [
  { id: "24h", t: "24 h" },
  { id: "7d", t: "7 días" },
  { id: "30d", t: "30 días" },
];

function Dona({ f }: { f: Resumen["flota"] }) {
  const R = 40;
  const C = 2 * Math.PI * R;
  const pct = porcentajeOperativas(f);
  const cuentas = {
    ruta: f.en_ruta,
    retorno: f.retornando,
    parada: f.en_parada,
    descansa: f.descansando,
    detenida: f.detenidas,
  };
  // Cada arco empieza donde terminó el anterior.
  const arcos = CATS.map((c) => ({
    c,
    len: f.activos > 0 ? (cuentas[c.k] / f.activos) * C : 0,
  })).map((a, i, todos) => ({ ...a, desde: todos.slice(0, i).reduce((s, x) => s + x.len, 0) }));
  return (
    <svg
      viewBox="0 0 120 120"
      className="w-36 h-36"
      role="img"
      aria-label={`${pct} por ciento operativas`}
    >
      {arcos
        .filter((a) => a.len > 0)
        .map((a) => (
          <circle
            key={a.c.k}
            cx={60}
            cy={60}
            r={R}
            fill="none"
            stroke={a.c.c}
            strokeWidth={14}
            strokeDasharray={`${Math.max(0, a.len - 2).toFixed(1)} ${(C - a.len + 2).toFixed(1)}`}
            strokeDashoffset={(-a.desde).toFixed(1)}
            transform="rotate(-90 60 60)"
          />
        ))}
      <text x={60} y={61} textAnchor="middle" fill="#f1f5f9" fontSize={16} fontWeight={800}>
        {pct}%
      </text>
      <text x={60} y={74} textAnchor="middle" fill="#94a3b8" fontSize={7} letterSpacing=".08em">
        OPERATIVAS
      </text>
    </svg>
  );
}

/** En un monitor o una laptop alta, el Resumen cabe en la pantalla sin bajar: el mapa recibe más alto que
 *  los paneles de abajo. En pantallas chicas se baja con scroll, como siempre. */
const ESTILO_AJUSTADO = `
@media (min-width: 1280px) and (min-height: 820px) {
  .tv-cabe { display: grid; flex: 1 1 auto; min-height: 0;
    grid-template-rows: auto minmax(0, 1.7fr) minmax(0, .85fr) auto; }
  .tv-cabe > * { min-height: 0; }
  .tv-fila-mapa > *, .tv-fila-abajo > * { min-height: 0; overflow: hidden; }
  /* La vista de una unidad también cabe: el mapa y la columna de la derecha arriba, tres tarjetas abajo. */
  .tv-unidad { display: grid; flex: 1 1 auto; min-height: 0; grid-template-rows: auto minmax(0, 1fr); }
  .tv-unidad-cuerpo { min-height: 0; grid-template-rows: minmax(0, 1.4fr) minmax(0, 1fr); }
  .tv-unidad-cuerpo > * { min-height: 0; }
  @media (max-width: 1500px) { .tv-unidad-cuerpo { grid-template-rows: minmax(0, 2.3fr) minmax(0, 1fr); } }
  .tv-unidad-cuerpo > .tv-unidad-abajo > * { min-height: 0; overflow: hidden; }
  .tv-unidad-mapa > section { flex: 1 1 auto; min-height: 0; }
}`;

export default function ControlViajesTv() {
  const [periodo, setPeriodo] = useState<Periodo>("24h");
  // El período de los resúmenes de la vista de una unidad (30 días era lo único que mostraba).
  const [periodoUnidad, setPeriodoUnidad] = useState<Periodo>("30d");
  // Barra de desplazamiento propia, de 3 px. Ojo: quien se desplaza es el div interno (styles/responsive.css
  // le pone max-height y overflow-y a todo hijo directo de un .fixed.inset-0, pensado para modales), no la
  // raíz. Su barra nativa va oculta (inline) y esta aparece en lima solo mientras se mueve la página,
  // ~0,8 s, como la del ERP (Layout.tsx), pero más fina.
  const raiz = useRef<HTMLDivElement>(null);
  const pulgar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = raiz.current;
    const barra = pulgar.current;
    if (!el || !barra) return;
    let quitar = 0;
    const alMover = () => {
      const { scrollHeight, clientHeight, scrollTop } = el;
      if (scrollHeight <= clientHeight + 1) return;
      const alto = Math.max(28, (clientHeight * clientHeight) / scrollHeight);
      const arriba =
        el.getBoundingClientRect().top +
        (scrollTop / (scrollHeight - clientHeight)) * (clientHeight - alto);
      barra.style.height = `${alto}px`;
      barra.style.transform = `translateY(${arriba}px)`;
      barra.style.opacity = "1";
      window.clearTimeout(quitar);
      quitar = window.setTimeout(() => (barra.style.opacity = "0"), 800);
    };
    el.addEventListener("scroll", alMover, { passive: true });
    return () => {
      el.removeEventListener("scroll", alMover);
      window.clearTimeout(quitar);
    };
  }, []);
  const [resumen, setResumen] = useState<Resumen | null>(null);
  const [consumo, setConsumo] = useState<Consumo | null>(null);
  const [viajes, setViajes] = useState<FilaViaje[]>([]);
  const [ultimaCarga, setUltimaCarga] = useState<number | null>(null);
  const [sinConexion, setSinConexion] = useState(false);
  const [ahora, setAhora] = useState(() => Date.now());
  const [pantallaCompleta, setPantallaCompleta] = useState(false);
  const [pagina, setPagina] = useState<"resumen" | "detalle">("resumen");
  const movil = useEsMovil();
  const chica = useEsPantallaChica();
  const [tab, setTab] = useState<TabMovil>("resumen");
  const [detalle, setDetalle] = useState<DetalleDatos | null>(null);
  const [lugares, setLugares] = useState<LugarMapa[]>([]);
  // La unidad que se está mirando (null = el TV central); sale también del enlace del ícono de la fila.
  const [unidad, setUnidad] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get("unidad")
  );
  // Sube con cada actualización: la vista de la unidad se refresca junto con el tablero.
  const [version, setVersion] = useState(0);
  const elegir = (id: string | null) => {
    setUnidad(id);
    window.history.replaceState(null, "", id ? `/control-tv?unidad=${id}` : "/control-tv");
  };
  // Una respuesta lenta no pisa a una más nueva.
  const pedido = useRef(0);
  // Los gráficos del Resumen usan el detalle (desvíos, duración de viajes, consumo anterior); es pesado,
  // así que fuera de su pestaña se pide al abrir, al cambiar de período y cada 5 minutos como mucho.
  const ultimoDetalle = useRef({ t: 0, periodo: "" });

  const cargar = useCallback(async () => {
    const mio = ++pedido.current;
    const pedir = async <T,>(url: string): Promise<T | null> => {
      try {
        const res = await apiFetch(url);
        return res.ok ? ((await res.json().catch(() => null)) as T | null) : null;
      } catch {
        return null;
      }
    };
    const refrescarDetalle =
      pagina === "detalle" ||
      ultimoDetalle.current.periodo !== periodo ||
      Date.now() - ultimoDetalle.current.t > 5 * 60_000;
    const [r, c, v, d, l] = await Promise.all([
      pedir<Resumen>("/api/erp/viajes/control-tv/resumen"),
      pedir<Consumo>(`/api/erp/viajes/control-tv/consumo?periodo=${periodo}`),
      pedir<{ data: FilaViaje[] }>("/api/erp/viajes?estado=en_curso"),
      refrescarDetalle
        ? pedir<DetalleDatos>(`/api/erp/viajes/control-tv/detalle?periodo=${periodo}`)
        : Promise.resolve(null),
      // Los lugares con su punto cambian poco: se piden con el detalle. Sin permiso de Viajes la lista
      // no llega y el mapa dice que no hay lugares ubicados, sin romper nada.
      refrescarDetalle
        ? pedir<{ data: LugarMapa[] }>("/api/erp/viajes/lugares")
        : Promise.resolve(null),
    ]);
    if (mio !== pedido.current) return;
    // Lo que no llegó se queda como estaba: la pantalla nunca se vacía por un fallo de red.
    if (r) setResumen(r);
    if (c) setConsumo(c);
    if (v && Array.isArray(v.data)) setViajes(v.data);
    if (l && Array.isArray(l.data)) setLugares(l.data);
    if (d) {
      setDetalle(d);
      ultimoDetalle.current = { t: Date.now(), periodo };
    }
    setSinConexion(!r);
    if (r) {
      setUltimaCarga(Date.now());
      setVersion((n) => n + 1);
    }
  }, [periodo, pagina]);

  useEffect(() => {
    void cargar();
    const es = new EventSource("/api/eventos/stream", { withCredentials: true });
    const refrescar = () => void cargar();
    for (const e of [
      "combustible.viaje_actualizado",
      "combustible.despacho_creado",
      "combustible.despacho_anulado",
    ]) {
      es.addEventListener(e, refrescar);
    }
    const cada = window.setInterval(refrescar, 60_000);
    window.addEventListener("online", refrescar);
    return () => {
      es.close();
      window.clearInterval(cada);
      window.removeEventListener("online", refrescar);
    };
  }, [cargar]);

  useEffect(() => {
    const t = window.setInterval(() => setAhora(Date.now()), 1000);
    const f = () => setPantallaCompleta(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", f);
    return () => {
      window.clearInterval(t);
      document.removeEventListener("fullscreenchange", f);
    };
  }, []);

  const alternarPantalla = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      // Algunos navegadores no la permiten: la pantalla sigue funcionando igual.
    }
  };
  const salir = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    window.location.assign("/");
  };

  const f = resumen?.flota;
  const comb = resumen?.combustible;
  const gal = consumo?.consumo?.total.gal ?? 0;
  const hace = ultimaCarga ? Math.max(0, Math.round((ahora - ultimaCarga) / 1000)) : null;

  const seccionFlota = f && (
    <section className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-white/[0.04] p-3">
      <div className="flex items-baseline justify-between">
        <h2 className="flex items-center gap-2 text-xs font-bold uppercase tracking-[.16em] text-slate-400">
          <Truck className="w-4 h-4 text-[#BADC1E]" /> Flota en operación
        </h2>
        <span className="text-xs text-slate-400">
          {f.activos} {f.activos === 1 ? "viaje" : "viajes"}
        </span>
      </div>
      <div className="flex items-center gap-4">
        <Dona f={f} />
        <ul className="flex flex-1 flex-col gap-1.5 text-sm">
          {CATS.map((c) => {
            const n = {
              ruta: f.en_ruta,
              retorno: f.retornando,
              parada: f.en_parada,
              descansa: f.descansando,
              detenida: f.detenidas,
            }[c.k];
            return (
              <li key={c.k} className="flex items-center gap-2">
                <i className="h-2.5 w-2.5 rounded-[3px]" style={{ background: c.c }} />
                <span className="flex-1 text-slate-400">{c.t}</span>
                <b className="tabular-nums">{n}</b>
              </li>
            );
          })}
        </ul>
      </div>
      <ul className="grid grid-cols-2 gap-x-3 gap-y-1 border-t border-white/10 pt-2 text-xs">
        {f.por_tipo
          .slice()
          .sort((a, b) => b.cantidad - a.cantidad)
          .map((t, i) => (
            <li
              key={t.tipo}
              className={`min-w-0 items-center gap-1.5 text-slate-300 ${i >= 6 ? "hidden min-[1700px]:flex" : "flex"}`}
            >
              <IconoTipo tipo={t.tipo} alto={20} className="shrink-0 text-[#BADC1E]" />
              <em className="min-w-0 flex-1 truncate not-italic text-slate-400">{t.tipo}</em>
              <b className="tabular-nums">{t.cantidad}</b>
            </li>
          ))}
      </ul>
    </section>
  );

  const verTabs = movil && !unidad && pagina === "resumen" && !!f;
  // La vista de una unidad en celular o tablet lleva su propia barra abajo (la dibuja VistaUnidad).
  const conBarraDeUnidad = chica && !!unidad;

  return (
    <div
      className={`fixed inset-0 overflow-y-auto p-3 text-slate-100 sm:p-4 ${verTabs || conBarraDeUnidad ? "pb-[calc(4.5rem+env(safe-area-inset-bottom,0px))]" : ""}`}
      style={{
        background:
          "radial-gradient(1200px 700px at 78% -10%, #12363a 0%, transparent 60%), radial-gradient(900px 600px at -10% 110%, #10282a 0%, transparent 55%), #070d0e",
      }}
    >
      <style>{ESTILO_AJUSTADO}</style>
      <div
        ref={pulgar}
        aria-hidden
        className="pointer-events-none fixed right-[2px] top-0 z-50 w-[3px] rounded-full bg-[#badc1e] opacity-0 transition-opacity duration-300"
      />
      <div
        ref={raiz}
        style={{ scrollbarWidth: "none" }}
        className="mx-auto flex min-h-full max-w-[1900px] flex-col gap-3 [&::-webkit-scrollbar]:hidden"
      >
        {movil && (
          <>
            <header className="flex items-center gap-2">
              <img
                src="/logos/mincore-logo-256-sin-fondo.png"
                alt=""
                className="h-7 w-7 shrink-0"
              />
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-base font-bold leading-tight">
                  {resumen?.empresa || "Control de viajes"}
                </h1>
                <p className="truncate text-[11px] text-slate-400">
                  Control de viajes ·{" "}
                  {resumen?.sedes === undefined || resumen?.sedes === null
                    ? "Todas las sedes"
                    : resumen.sedes.join(", ") || "Sin sede"}
                </p>
              </div>
              <span className="flex items-center gap-1.5 text-[11px] text-slate-400" role="status">
                <span
                  className={`h-2 w-2 rounded-full ${sinConexion ? "bg-amber-400" : "bg-emerald-400"}`}
                  aria-hidden
                />
                {sinConexion ? "Sin conexión" : hace !== null ? `${hace} s` : "En vivo"}
              </span>
              <button
                onClick={salir}
                aria-label="Salir"
                className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-white/15 bg-white/5"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </header>
            {!unidad && (
              <div className="flex items-center gap-2">
                {pagina === "resumen" && (
                  <div className="inline-flex gap-0.5 rounded-xl border border-white/10 bg-white/5 p-0.5">
                    {PERIODOS.map((p) => (
                      <button
                        key={p.id}
                        aria-pressed={periodo === p.id}
                        onClick={() => setPeriodo(p.id)}
                        className={`min-h-9 rounded-lg px-3 text-sm font-bold ${
                          periodo === p.id ? "bg-[#BADC1E] text-[#0D1719]" : "text-slate-400"
                        }`}
                      >
                        {p.t}
                      </button>
                    ))}
                  </div>
                )}
                <div className="flex-1" />
                <button
                  aria-pressed={pagina === "detalle"}
                  onClick={() => setPagina(pagina === "detalle" ? "resumen" : "detalle")}
                  className={`min-h-9 rounded-xl border px-3.5 text-sm font-bold ${
                    pagina === "detalle"
                      ? "border-[#BADC1E] bg-[#BADC1E] text-[#0D1719]"
                      : "border-white/15 bg-white/5 text-slate-200"
                  }`}
                >
                  {pagina === "detalle" ? "Volver al resumen" : "Detalle"}
                </button>
              </div>
            )}
          </>
        )}
        <header className={`flex-wrap items-center gap-x-4 gap-y-2 ${movil ? "hidden" : "flex"}`}>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 border-r border-white/10 pr-3 text-slate-400">
              <img src="/logos/mincore-logo-256-sin-fondo.png" alt="" className="h-7 w-7" />
              <span className="hidden text-xs font-bold tracking-wider min-[1500px]:inline">
                Mincore ERP
              </span>
            </div>
            <div>
              <h1 className="text-xl font-bold leading-tight">
                {resumen?.empresa || "Control de viajes"}
              </h1>
              <p className="text-xs text-slate-400">
                Control de viajes ·{" "}
                {resumen?.sedes === undefined || resumen?.sedes === null
                  ? "Todas las sedes"
                  : resumen.sedes.join(", ") || "Sin sede"}
              </p>
            </div>
          </div>
          <div className="flex-1" />
          {!unidad && (
            <div className="inline-flex gap-0.5 rounded-xl border border-white/10 bg-white/5 p-0.5">
              {(["resumen", "detalle"] as const).map((p) => (
                <button
                  key={p}
                  aria-pressed={pagina === p}
                  onClick={() => setPagina(p)}
                  className={`rounded-lg px-3.5 py-1.5 text-sm font-bold ${
                    pagina === p ? "bg-[#BADC1E] text-[#0D1719]" : "text-slate-400 hover:text-white"
                  }`}
                >
                  {p === "resumen" ? "Resumen" : "Detalle"}
                </button>
              ))}
            </div>
          )}
          {(unidad || pagina === "resumen") && (
            <div className="inline-flex gap-0.5 rounded-xl border border-white/10 bg-white/5 p-0.5">
              {PERIODOS.map((p) => (
                <button
                  key={p.id}
                  aria-pressed={(unidad ? periodoUnidad : periodo) === p.id}
                  onClick={() => (unidad ? setPeriodoUnidad(p.id) : setPeriodo(p.id))}
                  className={`rounded-lg px-3.5 py-1.5 text-sm font-bold ${
                    (unidad ? periodoUnidad : periodo) === p.id
                      ? "bg-[#BADC1E] text-[#0D1719]"
                      : "text-slate-400 hover:text-white"
                  }`}
                >
                  {p.t}
                </button>
              ))}
            </div>
          )}
          <span className="flex items-center gap-2 text-xs text-slate-400" role="status">
            <span
              className={`h-2 w-2 rounded-full ${sinConexion ? "bg-amber-400" : "bg-emerald-400"}`}
              aria-hidden
            />
            {sinConexion
              ? "Sin conexión · mostrando lo último"
              : `En vivo${hace !== null ? ` · hace ${hace} s` : ""}`}
          </span>
          <span className="text-2xl font-extrabold tabular-nums">
            {new Date(ahora).toLocaleTimeString("es-PE")}
          </span>
          <button
            onClick={() => void alternarPantalla()}
            className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-3.5 py-2 text-sm font-semibold hover:border-[#BADC1E]"
          >
            {pantallaCompleta ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
            {pantallaCompleta ? "Salir de pantalla completa" : "Pantalla completa"}
          </button>
          <button
            onClick={salir}
            className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-3.5 py-2 text-sm font-semibold hover:border-[#BADC1E]"
          >
            <LogOut className="w-4 h-4" /> Salir
          </button>
        </header>

        {!f ? (
          <p className="py-20 text-center text-slate-400">Cargando el control de viajes…</p>
        ) : unidad ? (
          <VistaUnidad
            viajes={viajes}
            lugares={lugares}
            id={unidad}
            periodo={periodoUnidad}
            version={version}
            ahora={ahora}
            onCambiar={elegir}
            onVolver={() => elegir(null)}
          />
        ) : movil && pagina === "resumen" ? (
          <>
            {tab === "resumen" && f && (
              <ResumenCorporativo
                movil
                intro={
                  <>
                    {seccionFlota}
                    <UnidadesDetenidas viajes={viajes} onElegir={elegir} />
                    {consumo?.niveles && consumo.niveles.length > 0 && (
                      <PanelTanque
                        niveles={consumo.niveles}
                        ahora={ahora}
                        periodoMs={{ "24h": 24, "7d": 168, "30d": 720 }[periodo] * 3_600_000}
                      />
                    )}
                  </>
                }
                d={{
                  flota: f,
                  combustible: comb,
                  urea: resumen?.urea ?? null,
                  consumo: consumo?.consumo,
                  niveles: consumo?.niveles,
                  detalle,
                  periodo,
                }}
              />
            )}
            {tab === "flota" && (
              <>
                {seccionFlota}
                <MapaDigital viajes={viajes} lugares={lugares} onElegir={elegir} />
              </>
            )}
            {tab === "combustible" && comb && (
              <>
                <PanelTanquetas tanquetas={comb.tanquetas} cisternas={comb.cisternas} />
                {consumo?.consumo && (
                  <PanelConsumo
                    serie={consumo.consumo.serie}
                    porHora={consumo.consumo.agrupado_por === "hora"}
                    total={gal}
                  />
                )}
                {consumo?.niveles && consumo.niveles.length > 0 && (
                  <PanelTanque
                    niveles={consumo.niveles}
                    ahora={ahora}
                    periodoMs={{ "24h": 24, "7d": 168, "30d": 720 }[periodo] * 3_600_000}
                  />
                )}
              </>
            )}
            {tab === "urea" && resumen?.urea && <PanelUrea urea={resumen.urea} ahora={ahora} />}
            {tab === "eventos" && <FranjaEventos eventos={resumen?.eventos ?? []} />}
          </>
        ) : pagina === "detalle" ? (
          comb ? (
            <DetalleTv
              periodo={periodo}
              onPeriodo={setPeriodo}
              detalle={detalle}
              comb={{
                total_gal: comb.total_en_tanques_gal,
                capacidad_gal: comb.tanques.reduce((s, t) => s + t.capacidad, 0),
                consumo: consumo?.consumo
                  ? {
                      ...consumo.consumo.total,
                      serie: consumo.consumo.serie,
                    }
                  : null,
                entrada: consumo?.entrada ?? null,
              }}
            />
          ) : (
            <p className="py-20 text-center text-slate-400">
              El detalle necesita el módulo de Combustible.
            </p>
          )
        ) : (
          <div className="tv-cabe flex flex-col gap-3">
            {f && (
              <ResumenCorporativo
                movil={false}
                d={{
                  flota: f,
                  combustible: comb,
                  urea: resumen?.urea ?? null,
                  consumo: consumo?.consumo,
                  niveles: consumo?.niveles,
                  detalle,
                  periodo,
                }}
              />
            )}

            <div className="tv-fila-mapa grid gap-2.5 lg:grid-cols-[minmax(280px,.8fr)_minmax(0,2fr)_minmax(300px,.95fr)]">
              {seccionFlota}
              <MapaDigital viajes={viajes} lugares={lugares} onElegir={elegir} />
              {comb && <PanelTanquetas tanquetas={comb.tanquetas} cisternas={comb.cisternas} />}
            </div>

            {comb && (
              <div className="tv-fila-abajo grid gap-2.5 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
                {consumo?.niveles && consumo.niveles.length > 0 && (
                  <PanelTanque
                    niveles={consumo.niveles}
                    ahora={ahora}
                    periodoMs={{ "24h": 24, "7d": 168, "30d": 720 }[periodo] * 3_600_000}
                  />
                )}
                {resumen?.urea && <PanelUrea urea={resumen.urea} ahora={ahora} />}
              </div>
            )}
            <FranjaEventos eventos={resumen?.eventos ?? []} />
          </div>
        )}
      </div>
      {verTabs && (
        <nav
          aria-label="Secciones del Control TV"
          className="fixed inset-x-0 bottom-0 z-20 flex border-t border-white/10 bg-[#070d0e]/95 backdrop-blur"
          style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
        >
          {(
            [
              ["resumen", "Resumen", <LayoutDashboard key="r" className="w-5 h-5" />, true],
              ["flota", "Flota", <Truck key="f" className="w-5 h-5" />, true],
              ["combustible", "Combustible", <Fuel key="c" className="w-5 h-5" />, !!comb],
              ["urea", "Urea", <Droplets key="u" className="w-5 h-5" />, !!resumen?.urea],
              ["eventos", "Eventos", <Bell key="e" className="w-5 h-5" />, true],
            ] as [TabMovil, string, ReactNode, boolean][]
          )
            .filter(([, , , visible]) => visible)
            .map(([id, texto, icono]) => (
              <button
                key={id}
                aria-current={tab === id ? "page" : undefined}
                onClick={() => setTab(id)}
                className={`flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-semibold ${
                  tab === id ? "text-[#BADC1E]" : "text-slate-400"
                }`}
              >
                {icono}
                {texto}
              </button>
            ))}
        </nav>
      )}
    </div>
  );
}
