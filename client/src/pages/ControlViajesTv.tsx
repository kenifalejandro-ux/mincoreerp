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

import { estadoDelViaje, paradasDelViaje } from "../components/combustible/paradasViaje";
import { fmt, unidadLabel, type FilaViaje } from "../components/combustible/viajesFormato";
import {
  autonomiaDias,
  CATS,
  categoriaDe,
  porcentajeOperativas,
  posicionEnRuta,
  puntosTendencia,
  valorEnTanques,
} from "../components/controlTv/controlTvLogica";
import { IconoTipo } from "../components/controlTv/iconosUnidad";
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
import { VistaUnidad } from "../components/controlTv/VistaUnidad";
import { apiFetch } from "../services/apiClient";

type Periodo = "24h" | "7d" | "30d";

interface Resumen {
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
    tanques: { nivel: number | string | null; costo_promedio: number | null }[];
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
    total: { gal: number; costo: number };
    serie: SerieConsumo[];
    agrupado_por: "hora" | "dia";
  };
  niveles?: NivelTanque[];
  entrada?: { recepciones: number; recibido_gal: number; diferencia_gal: number };
}

const soles = (n: number) => `S/ ${fmt(n, 0)}`;
const PERIODOS: { id: Periodo; t: string }[] = [
  { id: "24h", t: "24 h" },
  { id: "7d", t: "7 días" },
  { id: "30d", t: "30 días" },
];

function Tarjeta({
  icono,
  titulo,
  valor,
  unidad,
  pie,
  tono,
  tendencia,
}: {
  icono: ReactNode;
  titulo: string;
  valor: string;
  unidad?: string;
  pie: string;
  tono: string;
  tendencia?: number[];
}) {
  const estilo: CSSProperties = {
    background: `linear-gradient(135deg, ${tono}55, #0a1315)`,
    borderColor: `${tono}aa`,
  };
  const puntos = tendencia ? puntosTendencia(tendencia, 114, 38) : "";
  return (
    <div className="flex items-center gap-3 rounded-2xl border p-3 overflow-hidden" style={estilo}>
      <span style={{ color: tono }} className="shrink-0">
        {icono}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-slate-300">{titulo}</p>
        <p className="text-3xl font-extrabold leading-tight tabular-nums">
          {valor}
          {unidad && <span className="ml-1 text-sm font-semibold text-slate-300">{unidad}</span>}
        </p>
        <p className="truncate text-[11px] text-slate-300">{pie}</p>
      </div>
      {puntos && (
        <svg viewBox="0 0 114 38" className="w-20 h-8 shrink-0" aria-hidden>
          <polyline
            points={puntos}
            fill="none"
            stroke={tono}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </div>
  );
}

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
      <text x={60} y={58} textAnchor="middle" fill="#f1f5f9" fontSize={22} fontWeight={800}>
        {pct}%
      </text>
      <text x={60} y={74} textAnchor="middle" fill="#94a3b8" fontSize={8} letterSpacing=".08em">
        OPERATIVAS
      </text>
    </svg>
  );
}

/** La vista en vivo: cada unidad como el ícono de su tipo, de «Salida» a «Regreso» según sus marcas.
 *  Sin GPS es una estimación; con GPS será el mapa real. */
function VistaEnVivo({
  viajes,
  onElegir,
}: {
  viajes: FilaViaje[];
  onElegir: (id: string) => void;
}) {
  const filas = 9;
  const orden = [4, 3, 5, 2, 6, 1, 7, 0, 8];
  const ultimo = orden.map(() => -99);
  const puestas = viajes
    .map((v) => ({ v, x: 4 + posicionEnRuta(v) * 92 }))
    .sort((a, b) => a.x - b.x)
    .map(({ v, x }) => {
      // Si no cabe en ninguna fila de su punto, se corre a la derecha hasta que haya lugar: las
      // unidades que están en el mismo punto quedan juntas, sin montarse.
      let px = x;
      let fila = -1;
      for (let intento = 0; intento < 40 && fila < 0; intento++) {
        fila = orden.find((o) => px - ultimo[o] >= 4.6) ?? -1;
        if (fila < 0) px += 1.2;
      }
      if (fila < 0) fila = orden[0];
      ultimo[fila] = px;
      return { v, x: Math.min(px, 97), fila };
    });
  const color = Object.fromEntries(CATS.map((c) => [c.k, c.c]));
  return (
    <section className="flex min-h-[380px] flex-col gap-2 rounded-2xl border border-white/10 bg-white/[0.04] p-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="flex items-center gap-2 text-xs font-bold uppercase tracking-[.16em] text-slate-400">
          <span className="h-2 w-2 rounded-full bg-emerald-400" aria-hidden />
          Vista en vivo
        </h2>
        <span className="text-xs text-slate-400">
          Posición estimada por las marcas · con GPS será el mapa real
        </span>
      </div>
      <div
        className="relative flex-1 min-h-[320px] overflow-hidden rounded-xl border border-[#BADC1E]/20"
        style={{
          background:
            "radial-gradient(ellipse at 50% 50%, #1c3a2a55, transparent 70%), repeating-linear-gradient(0deg, #BADC1E12 0 1px, transparent 1px 34px), repeating-linear-gradient(90deg, #BADC1E12 0 1px, transparent 1px 34px), #081210",
        }}
      >
        {[
          ["Salida", "4%"],
          ["Destino", "50%"],
          ["Regreso", "96%"],
        ].map(([t, l]) => (
          <span
            key={t}
            className="absolute top-1.5 -translate-x-1/2 text-[10px] uppercase tracking-[.14em] text-slate-400"
            style={{ left: l }}
          >
            {t}
          </span>
        ))}
        {puestas.map(({ v, x, fila }) => {
          const cat = categoriaDe(v);
          const estado = estadoDelViaje(paradasDelViaje(v), v.descansos)?.texto ?? "";
          return (
            <button
              key={v.id}
              onClick={() => onElegir(v.id)}
              aria-label={`Ver ${unidadLabel(v)} en su Control TV`}
              title={`${unidadLabel(v)} · ${v.conductor_nombre ?? "sin conductor"} · ${v.equipo_tipo ?? "Otro"} · ${estado}`}
              className={`absolute grid h-[30px] w-10 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-lg border bg-[#0b1719]/80 cursor-pointer hover:bg-white/15 hover:z-10 ${
                cat === "detenida" ? "animate-pulse motion-reduce:animate-none" : ""
              }`}
              style={{
                left: `${x.toFixed(2)}%`,
                top: `${(9 + ((fila + 0.5) / filas) * 88).toFixed(2)}%`,
                color: color[cat],
                borderColor: color[cat],
              }}
            >
              <IconoTipo tipo={v.equipo_tipo} className="w-8 h-6" />
            </button>
          );
        })}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
        {CATS.map((c) => (
          <li key={c.k} className="flex items-center gap-1.5">
            <i className="h-[3px] w-3.5 rounded" style={{ background: c.c }} />
            {c.t}
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function ControlViajesTv() {
  const [periodo, setPeriodo] = useState<Periodo>("24h");
  const [resumen, setResumen] = useState<Resumen | null>(null);
  const [consumo, setConsumo] = useState<Consumo | null>(null);
  const [viajes, setViajes] = useState<FilaViaje[]>([]);
  const [ultimaCarga, setUltimaCarga] = useState<number | null>(null);
  const [sinConexion, setSinConexion] = useState(false);
  const [ahora, setAhora] = useState(() => Date.now());
  const [pantallaCompleta, setPantallaCompleta] = useState(false);
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
    const [r, c, v] = await Promise.all([
      pedir<Resumen>("/api/erp/viajes/control-tv/resumen"),
      pedir<Consumo>(`/api/erp/viajes/control-tv/consumo?periodo=${periodo}`),
      pedir<{ data: FilaViaje[] }>("/api/erp/viajes?estado=en_curso"),
    ]);
    if (mio !== pedido.current) return;
    // Lo que no llegó se queda como estaba: la pantalla nunca se vacía por un fallo de red.
    if (r) setResumen(r);
    if (c) setConsumo(c);
    if (v && Array.isArray(v.data)) setViajes(v.data);
    setSinConexion(!r);
    if (r) {
      setUltimaCarga(Date.now());
      setVersion((n) => n + 1);
    }
  }, [periodo]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
  const auto = comb ? autonomiaDias(comb.total_en_tanques_gal, gal, periodo) : null;
  const periodoTxt = PERIODOS.find((p) => p.id === periodo)?.t ?? "";
  const hace = ultimaCarga ? Math.max(0, Math.round((ahora - ultimaCarga) / 1000)) : null;

  return (
    <div
      className="fixed inset-0 overflow-y-auto p-3 text-slate-100 sm:p-4"
      style={{
        background:
          "radial-gradient(1200px 700px at 78% -10%, #12363a 0%, transparent 60%), radial-gradient(900px 600px at -10% 110%, #10282a 0%, transparent 55%), #070d0e",
      }}
    >
      <div className="mx-auto flex max-w-[1900px] flex-col gap-3">
        <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="text-sm font-black tracking-[.28em] text-[#BADC1E]">MINCORE</span>
          <h1 className="text-xl font-bold">Control de viajes</h1>
          <div className="flex-1" />
          {!unidad && (
            <div className="inline-flex gap-0.5 rounded-xl border border-white/10 bg-white/5 p-0.5">
              {PERIODOS.map((p) => (
                <button
                  key={p.id}
                  aria-pressed={periodo === p.id}
                  onClick={() => setPeriodo(p.id)}
                  className={`rounded-lg px-3.5 py-1.5 text-sm font-bold ${
                    periodo === p.id
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
            id={unidad}
            version={version}
            ahora={ahora}
            onCambiar={elegir}
            onVolver={() => elegir(null)}
          />
        ) : (
          <>
            <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(215px,1fr))]">
              <Tarjeta
                icono={<Truck className="w-7 h-7" />}
                titulo="Viajes activos"
                valor={fmt(f.activos, 0)}
                pie={`${f.programados} programados`}
                tono="#3b82f6"
              />
              {comb && (
                <>
                  <Tarjeta
                    icono={<Fuel className="w-7 h-7" />}
                    titulo="Combustible en la empresa"
                    valor={fmt(comb.total_en_tanques_gal, 0)}
                    unidad="gal"
                    pie={soles(valorEnTanques(comb.tanques))}
                    tono="#7fa21a"
                  />
                  <Tarjeta
                    icono={<Inbox className="w-7 h-7" />}
                    titulo={`Recepcionado · ${periodoTxt}`}
                    valor={fmt(consumo?.entrada?.recibido_gal ?? 0, 0)}
                    unidad="gal"
                    pie={`${consumo?.entrada?.recepciones ?? 0} recepciones · ${fmt(consumo?.entrada?.diferencia_gal ?? 0, 0)} gal vs. factura`}
                    tono="#22d3ee"
                  />
                  <Tarjeta
                    icono={<Droplets className="w-7 h-7" />}
                    titulo={`Consumo · ${periodoTxt}`}
                    valor={fmt(gal, 0)}
                    unidad="gal"
                    pie={soles(consumo?.consumo?.total.costo ?? 0)}
                    tono="#fb923c"
                    tendencia={consumo?.consumo?.serie.map((s) => s.gal)}
                  />
                  <Tarjeta
                    icono={<Clock className="w-7 h-7" />}
                    titulo="Autonomía"
                    valor={auto === null ? "—" : fmt(auto, 1)}
                    unidad={auto === null ? undefined : "días"}
                    pie={`combustible${resumen?.urea?.autonomia_dias != null ? ` · urea ${fmt(resumen.urea.autonomia_dias, 0)} días` : ""}`}
                    tono="#a78bfa"
                  />
                  <Tarjeta
                    icono={<Bell className="w-7 h-7" />}
                    titulo="Alertas críticas"
                    valor={fmt(comb.alertas.criticas, 0)}
                    pie={`${comb.alertas.por_revisar} por revisar`}
                    tono="#f87171"
                  />
                </>
              )}
            </div>

            <div className="grid gap-2.5 lg:grid-cols-[minmax(280px,.8fr)_minmax(0,2fr)_minmax(300px,.95fr)]">
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
                    .map((t) => (
                      <li key={t.tipo} className="flex min-w-0 items-center gap-1.5 text-slate-300">
                        <IconoTipo tipo={t.tipo} className="w-6 h-[18px] shrink-0 text-[#BADC1E]" />
                        <em className="min-w-0 flex-1 truncate not-italic text-slate-400">
                          {t.tipo}
                        </em>
                        <b className="tabular-nums">{t.cantidad}</b>
                      </li>
                    ))}
                </ul>
              </section>
              <VistaEnVivo viajes={viajes} onElegir={elegir} />
              {comb && <PanelTanquetas tanquetas={comb.tanquetas} cisternas={comb.cisternas} />}
            </div>

            {comb && (
              <div className="grid gap-2.5 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1.1fr)_minmax(320px,.9fr)]">
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
                {resumen?.urea && <PanelUrea urea={resumen.urea} ahora={ahora} />}
              </div>
            )}
            <FranjaEventos eventos={resumen?.eventos ?? []} />
          </>
        )}
      </div>
    </div>
  );
}
