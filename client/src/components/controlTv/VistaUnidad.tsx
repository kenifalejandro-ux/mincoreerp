// El Control TV de UNA unidad: conductor primero (con la placa al lado), su estado, las horas del
// viaje, el recorrido, cómo se fue el tiempo, lo que consumió en este recorrido, quién maneja y dónde
// está. Solo lectura. Se abre tocando la unidad en la vista en vivo o desde el ícono TV de su fila.
import {
  ArrowLeft,
  Bell,
  ChartColumn,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Clock,
  MapPin,
  Timer,
  Truck,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { CATS, categoriaDe } from "./controlTvLogica";
import { ConsumoAcumulado, ConsumoPorTramo, VsNormal } from "./GraficasUnidad";
import { IconoTipo } from "./iconosUnidad";
import { MapaDigital } from "./MapaDigital";
import { posicionEnMapa, type LugarMapa } from "./mapaLogica";
import {
  AlertasActivas,
  CargasYRendimiento,
  ResumenViajes,
  type ResumenUnidad,
} from "./ResumenUnidadTv";
import { SeccionTv } from "./SeccionTv";
import { useEsPantallaChica } from "./useEsMovil";
import { apiFetch } from "../../services/apiClient";
import { descansoEnVentana, horasDelViaje } from "../combustible/horasViaje";
import { estadoDelViaje, paradasDelViaje } from "../combustible/paradasViaje";
import type { CargaViaje } from "../combustible/PiezasViaje";
import type { TramoDelViaje } from "../combustible/TramosViaje";
import { haceCuanto, ubicacionVigente } from "../combustible/ubicacionesLogica";
import { duracion, unidadLabel, type FilaViaje } from "../combustible/viajesFormato";

interface Detalle {
  viaje: FilaViaje;
  cargas: CargaViaje[];
  ruta: { combustible_gal: number | null; urea_l: number | null };
  tramos?: TramoDelViaje[];
}

const LITROS_POR_GALON = 3.785411784;
type TabUnidad = "mapa" | "viaje" | "conductor" | "consumo" | "alertas";
const CARD = "rounded-[10px] border border-white/10 bg-[#0e191c] p-3";
const iniciales = (n: string | null) =>
  (n ?? "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((x) => x[0])
    .join("")
    .toUpperCase();

function Seccion({
  titulo,
  icono,
  children,
  abierta,
}: {
  titulo: string;
  icono?: ReactNode;
  children: ReactNode;
  abierta?: boolean;
}) {
  return (
    <SeccionTv titulo={titulo} icono={icono} abierta={abierta}>
      {children}
    </SeccionTv>
  );
}

export function VistaUnidad({
  viajes,
  lugares,
  id,
  periodo,
  version,
  ahora,
  onCambiar,
  onVolver,
}: {
  /** Los viajes en curso: de ahí salen Anterior y Siguiente. */
  viajes: FilaViaje[];
  /** Los lugares con su punto en el mapa (para dibujar la ruta de esta unidad). */
  lugares: LugarMapa[];
  id: string;
  /** El período de los resúmenes de la unidad (24 h, 7 días o 30 días). */
  periodo: "24h" | "7d" | "30d";
  /** Sube cada vez que el Control TV se refresca: esta vista se actualiza con él. */
  version: number;
  ahora: number;
  onCambiar: (id: string) => void;
  onVolver: () => void;
}) {
  // Celular y tablet: la unidad se reparte en pestañas con una barra abajo, como la TV central en el celular.
  const chica = useEsPantallaChica();
  const [tab, setTab] = useState<TabUnidad>("mapa");
  const [datos, setDatos] = useState<Detalle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resumen, setResumen] = useState<ResumenUnidad | null>(null);
  const ultimoResumen = useRef({ id: "", periodo: "", t: 0 });
  // Una respuesta lenta no pisa a una más nueva, ni la de una unidad que ya se dejó.
  const pedido = useRef(0);

  useEffect(() => {
    const mio = ++pedido.current;
    void (async () => {
      try {
        const res = await apiFetch(`/api/erp/viajes/${id}`);
        const body = await res.json().catch(() => null);
        if (mio !== pedido.current) return;
        if (res.ok && body?.viaje) {
          setDatos(body);
          setError(null);
        } else setError(body?.error ?? "No se pudo cargar la unidad.");
      } catch {
        if (mio === pedido.current) setError("Sin conexión: se muestra lo último.");
      }
    })();
  }, [id, version]);

  // El resumen de la unidad (conductor, rendimiento, alertas) es más pesado y cambia poco: se pide al
  // abrir la unidad y se refresca como mucho cada 5 minutos, no en cada vuelta del Control TV.
  useEffect(() => {
    const u = ultimoResumen.current;
    const ahoraMs = Date.now();
    if (u.id === id && u.periodo === periodo && ahoraMs - u.t < 5 * 60_000) return;
    if (u.id !== id) setResumen(null);
    ultimoResumen.current = { id, periodo, t: ahoraMs };
    void (async () => {
      try {
        const res = await apiFetch(`/api/erp/viajes/control-tv/unidad/${id}?periodo=${periodo}`);
        const body = await res.json().catch(() => null);
        // Una respuesta lenta de otra unidad u otro período no pisa a la vigente.
        if (ultimoResumen.current.id !== id || ultimoResumen.current.periodo !== periodo) return;
        if (res.ok && body?.dias) setResumen(body);
      } catch {
        // Sin conexión: se queda lo último; el detalle del viaje ya avisa del corte.
      }
    })();
  }, [id, periodo, version]);

  const orden = viajes.slice().sort((a, b) => a.placa_codigo.localeCompare(b.placa_codigo));
  const pos = orden.findIndex((v) => v.id === id);
  const ir = (d: number) =>
    orden.length > 1 && onCambiar(orden[(pos + d + orden.length) % orden.length].id);
  const v = datos && datos.viaje.id === id ? datos.viaje : null;

  const barra = (
    <div className="flex flex-wrap items-center gap-2">
      <button
        onClick={onVolver}
        className="inline-flex items-center gap-2 rounded-xl border border-[#BADC1E]/60 bg-[#BADC1E]/10 px-3.5 py-2 text-sm font-bold text-[#BADC1E] hover:bg-[#BADC1E]/20"
      >
        <ArrowLeft className="w-4 h-4" /> TV central
      </button>
      {orden.length > 1 && (
        <>
          <button
            onClick={() => ir(-1)}
            aria-label="Unidad anterior"
            className="rounded-xl border border-white/15 bg-white/5 p-2 hover:border-[#BADC1E]"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            onClick={() => ir(1)}
            aria-label="Unidad siguiente"
            className="rounded-xl border border-white/15 bg-white/5 p-2 hover:border-[#BADC1E]"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
          <span className="text-xs text-slate-400">
            {pos + 1} de {orden.length} unidades en curso
          </span>
        </>
      )}
    </div>
  );

  if (!v || !datos) {
    return (
      <div className="flex flex-col gap-3">
        {barra}
        <p className="py-16 text-center text-slate-400">{error ?? "Cargando la unidad…"}</p>
      </div>
    );
  }

  const paradas = paradasDelViaje(v);
  const estado = estadoDelViaje(paradas, v.descansos);
  const cat = CATS.find((c) => c.k === categoriaDe(v)) ?? CATS[0];
  const horas = horasDelViaje(paradas, ahora);
  const donde = ubicacionVigente(paradas, v.ultima_ubicacion);
  // La posición del mapa es exacta cuando la última ubicación anotada es un lugar con coordenadas.
  const posicionExacta =
    posicionEnMapa(v, new Map(lugares.map((l) => [String(l.id), l])))?.exacta === true;
  const tramos = datos.tramos ?? [];
  const gal = datos.cargas
    .filter((c) => c.producto === "combustible")
    .reduce((s, c) => s + Number(c.cantidad) * (c.unidad === "L" ? 1 / LITROS_POR_GALON : 1), 0);
  const urea = datos.cargas
    .filter((c) => c.producto === "urea")
    .reduce((s, c) => s + Number(c.cantidad) * (c.unidad === "gal" ? LITROS_POR_GALON : 1), 0);
  const costo = datos.cargas.reduce((s, c) => s + Number(c.costo ?? 0), 0);
  // Lo que suele tardar manejando los tramos que ya salieron; sin referencia en alguno, no se compara.
  const salidos = tramos.filter((t) => t.salida_en);
  const esperadoRuta =
    salidos.length > 0 && salidos.every((t) => t.esperado_min != null)
      ? salidos.reduce((sum, t) => sum + (t.esperado_min ?? 0), 0)
      : null;
  const estadia = horas && horas.enParadas > 0 ? horas.enParadas : null;
  const estadiaNormal = resumen?.estadia_normal?.minutos ?? null;
  const promedio = datos.ruta.combustible_gal;
  const vsPromedio = promedio ? ((gal - promedio) / promedio) * 100 : null;

  // Cómo se fue el tiempo: manejando, quieto en una parada o descansando, en el orden en que pasó.
  const segmentos: { t: "ruta" | "est" | "desc"; min: number; tip: string }[] = [];
  paradas.forEach((p, i) => {
    const sale = p.salida_en ? Date.parse(p.salida_en) : null;
    const sigue = paradas[i + 1];
    if (sale !== null && sigue) {
      const llega = sigue.llegada_en ? Date.parse(sigue.llegada_en) : ahora;
      const total = (llega - sale) / 60_000;
      const desc = Math.min(
        total,
        descansoEnVentana(v.descansos, p.salida_en, sigue.llegada_en, ahora)
      );
      segmentos.push({
        t: "ruta",
        min: Math.max(0, total - desc),
        tip: `${p.lugar} → ${sigue.lugar}`,
      });
      if (desc >= 1) segmentos.push({ t: "desc", min: desc, tip: "Descanso" });
    }
    if (i > 0 && i < paradas.length - 1 && p.llegada_en) {
      const fin = p.salida_en ? Date.parse(p.salida_en) : ahora;
      segmentos.push({
        t: "est",
        min: (fin - Date.parse(p.llegada_en)) / 60_000,
        tip: `Estadía en ${p.lugar}`,
      });
    }
  });
  const COLOR = { ruta: "#38bdf8", est: "#a78bfa", desc: "#fbbf24" };
  const totalSeg = segmentos.reduce((s, x) => s + x.min, 0) || 1;
  const abierto = v.descansos?.find((d) => !d.fin_en && d.detiene !== false);

  const hora = abierto
    ? new Date(abierto.inicio_en).toLocaleTimeString("es-PE", {
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;
  const detenida = categoriaDe(v) === "detenida";
  const ESTADO_TXT: Record<string, string> = {
    ruta: "EN RUTA",
    retorno: "RETORNANDO",
    parada: "EN PARADA",
    descansa: "DESCANSANDO",
    detenida: "DETENIDA",
  };
  const catK = categoriaDe(v);
  const colorEstado = catK === "detenida" ? ROJO : catK === "descansa" ? "#fbbf24" : "#34d399";
  const nAlertas = resumen?.alertas.total;
  const hayCriticas = (resumen?.alertas.criticas ?? 0) > 0;
  const enMarcha = horas?.enRuta ?? null;

  const bloqueMapa = (
    <div className="tv-unidad-mapa flex min-h-[320px] min-w-0 flex-col">
      <MapaDigital
        viajes={[v]}
        lugares={lugares}
        onElegir={() => undefined}
        titulo="Dónde está"
        sinLeyenda
        unidad
        pie={
          <span className="flex flex-wrap items-center gap-x-2">
            <MapPin className="inline h-3.5 w-3.5 text-emerald-400" aria-hidden />
            <b className="text-slate-100">{donde?.texto ?? "Sin ubicación todavía"}</b>
            {donde && (
              <span>
                · {haceCuanto(donde.en, ahora)} ·{" "}
                {posicionExacta ? "en el punto anotado" : "estimada por las marcas"}
              </span>
            )}
          </span>
        }
      />
    </div>
  );
  const bloqueConsumo = (
    <ConsumoAcumulado
      cargas={datos.cargas}
      gal={gal}
      urea={urea}
      costo={costo}
      vsPromedio={vsPromedio}
    />
  );
  const bloqueTiempos = (
    <Seccion
      titulo="Tiempos del viaje"
      icono={<Clock className="h-4 w-4 text-sky-400" aria-hidden />}
    >
      <div
        className="flex h-5 gap-[3px] overflow-hidden rounded-md"
        role="img"
        aria-label="Tiempo manejando, en paradas y descansando"
      >
        {segmentos.map((s, i) => (
          <div
            key={`${s.t}-${i}`}
            title={`${s.tip}: ${duracion(s.min)}`}
            className="grid min-w-[6px] place-items-center overflow-hidden whitespace-nowrap text-[10px] font-bold text-[#04121a]"
            style={{ flex: `${s.min / totalSeg} 1 0`, background: COLOR[s.t] }}
          >
            {s.min / totalSeg > 0.14 ? duracion(s.min) : ""}
          </div>
        ))}
      </div>
      <ul className="grid grid-cols-3 gap-1 text-[11px] text-slate-400">
        {(
          [
            ["ruta", "Manejando", horas?.enRuta ?? 0],
            ["est", "En paradas", horas?.enParadas ?? 0],
            [
              "desc",
              "Descanso",
              segmentos.filter((x) => x.t === "desc").reduce((a, x) => a + x.min, 0),
            ],
          ] as const
        ).map(([k, t, min]) => (
          <li key={k}>
            <span className="flex items-center gap-1.5">
              <i className="h-2 w-2 rounded-full" style={{ background: COLOR[k] }} />
              {t}
            </span>
            <b className="ml-3.5 block text-[13px] text-slate-100">{duracion(min)}</b>
            {k !== "desc" && (
              <small className="ml-3.5 hidden text-[10.5px] min-[1500px]:block">
                <VsNormal
                  min={k === "ruta" ? (horas?.enRuta ?? null) : estadia}
                  normal={k === "ruta" ? esperadoRuta : estadiaNormal}
                />
              </small>
            )}
          </li>
        ))}
      </ul>
    </Seccion>
  );
  const bloqueConductor = (
    <Seccion
      titulo="Conductor y relevo"
      icono={<Users className="h-4 w-4 text-emerald-400" aria-hidden />}
    >
      <div className="grid grid-cols-2 gap-3">
        {[
          { n: v.conductor_nombre, dni: v.conductor_dni, rol: "Titular" },
          ...(v.relevo_nombre ? [{ n: v.relevo_nombre, dni: v.relevo_dni, rol: "Relevo" }] : []),
        ].map((p) => (
          <div key={p.rol} className="flex items-center gap-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#BADC1E] text-xs font-black text-[#0D1719]">
              {iniciales(p.n ?? null)}
            </span>
            <div className="min-w-0 flex-1">
              <b className="block truncate text-sm">{p.n ?? "—"}</b>
              <small className="block truncate text-slate-400">
                {p.rol}
                {p.dni ? ` · DNI ${p.dni}` : ""}
                {v.volante_dni && v.volante_dni === p.dni ? " · al volante" : ""}
              </small>
            </div>
          </div>
        ))}
      </div>
      {!v.relevo_nombre && <p className="text-xs text-slate-400">Sin relevo en este viaje</p>}
      {(v.turnos?.length ?? 0) > 1 && (
        <ul className="border-t border-white/10 pt-1.5 text-xs">
          {v.turnos?.map((t) => (
            <li key={t.inicio_en} className="flex justify-between gap-2 py-0.5">
              <span>{t.conductor_nombre ?? t.conductor_dni}</span>
              <span className="text-slate-400">
                {duracion(
                  ((t.fin_en ? Date.parse(t.fin_en) : ahora) - Date.parse(t.inicio_en)) / 60_000
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Seccion>
  );

  return (
    <div className="tv-unidad flex flex-col gap-2.5">
      {error && <p className="text-xs text-amber-300">{error}</p>}

      <div className="grid grid-cols-[minmax(0,1fr)] gap-2.5 min-[1200px]:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] min-[1700px]:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <header className={`${CARD} flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 !py-2`}>
          <button
            onClick={onVolver}
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-xl border border-[#BADC1E]/60 bg-[#BADC1E]/10 px-3 py-1.5 text-xs font-bold text-[#BADC1E] hover:bg-[#BADC1E]/20"
          >
            <ArrowLeft className="h-4 w-4" /> TV central
          </button>
          {orden.length > 1 && (
            <span className="inline-flex items-center gap-1">
              <button
                onClick={() => ir(-1)}
                aria-label="Unidad anterior"
                className="rounded-lg border border-white/15 bg-white/5 p-1.5 hover:border-[#BADC1E]"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                onClick={() => ir(1)}
                aria-label="Unidad siguiente"
                className="rounded-lg border border-white/15 bg-white/5 p-1.5 hover:border-[#BADC1E]"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
              <span className="hidden text-[11px] text-slate-400 min-[1700px]:inline">
                {pos + 1} de {orden.length}
              </span>
            </span>
          )}
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full border-2 border-[#BADC1E] bg-[#BADC1E]/15 text-[#BADC1E]">
            <Truck className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-lg font-bold leading-tight min-[1700px]:text-xl">
              {v.conductor_nombre ?? "Sin conductor"}
            </h1>
            {v.conductor_dni && (
              <small className="inline-block rounded-md border border-white/20 px-1.5 text-[11px] text-slate-300">
                DNI {v.conductor_dni}
              </small>
            )}
          </div>
          <span className="whitespace-nowrap rounded-lg border border-white/20 bg-white/10 px-2 py-0.5 text-[13px] font-extrabold tracking-wider">
            {unidadLabel(v)}
          </span>
          <span className="hidden items-center gap-1.5 text-sm text-slate-300 min-[1700px]:flex">
            <IconoTipo tipo={v.equipo_tipo} alto={20} />
            {v.equipo_tipo ?? "Otro"}
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-[13px] text-slate-200">
            <MapPin className="h-4 w-4 text-amber-400" aria-hidden />
            <b>{paradas[0].lugar}</b> →
            <MapPin className="h-4 w-4 text-emerald-400" aria-hidden />
            <b>{paradas[paradas.length - 1].lugar}</b>
          </span>
          <span
            className="hidden whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-bold min-[1400px]:inline"
            style={{ background: `${cat.c}26`, color: cat.c }}
          >
            {estado?.texto ?? "En curso"}
            {hora ? ` desde las ${hora}` : ""}
          </span>
        </header>

        <div className="grid grid-cols-2 gap-2 min-[700px]:grid-cols-4">
          <Kpi
            Icono={CircleCheck}
            color={colorEstado}
            titulo="Estado"
            valor={ESTADO_TXT[catK]}
            pie={detenida ? "detenida" : "de la unidad"}
            tono={colorEstado}
            borde
          />
          <Kpi
            Icono={Clock}
            color="#38bdf8"
            titulo="En ruta"
            valor={enMarcha === null ? "—" : duracion(enMarcha)}
            pie="manejando"
            tono="#38bdf8"
          />
          <Kpi
            Icono={Timer}
            color="#a78bfa"
            titulo="Total"
            valor={horas ? duracion(horas.total) : "—"}
            pie="desde la salida"
          />
          <Kpi
            Icono={Bell}
            color={hayCriticas ? ROJO : "#fbbf24"}
            titulo="Alertas abiertas"
            valor={nAlertas === undefined ? "—" : String(nAlertas)}
            pie={hayCriticas ? `${resumen?.alertas.criticas} críticas` : "sin resolver"}
            tono={hayCriticas ? ROJO : "#fbbf24"}
            borde
          />
        </div>
      </div>

      {chica ? (
        <div className="flex min-w-0 flex-col gap-2.5">
          {tab === "mapa" && (
            <div className="flex h-[62vh] min-h-[340px] flex-col [&>div]:min-h-0 [&>div]:flex-1 [&>div>section]:flex-1">
              {bloqueMapa}
            </div>
          )}
          {tab === "viaje" && (
            <>
              {bloqueConsumo}
              {bloqueTiempos}
            </>
          )}
          {tab === "conductor" && (
            <>
              {bloqueConductor}
              <ResumenViajes datos={resumen} />
            </>
          )}
          {tab === "consumo" && (
            <>
              <ConsumoPorTramo tramos={tramos} />
              <CargasYRendimiento datos={resumen} ahora={ahora} />
            </>
          )}
          {tab === "alertas" && <AlertasActivas datos={resumen} ahora={ahora} />}
        </div>
      ) : (
        <div className="tv-unidad-cuerpo grid gap-2.5 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
          {bloqueMapa}

          <div className="grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto_auto] gap-2.5">
            {bloqueConsumo}

            {bloqueTiempos}

            {bloqueConductor}
          </div>

          <div className="tv-unidad-abajo grid gap-2.5 lg:col-span-2 lg:grid-cols-[minmax(0,.85fr)_minmax(0,1.15fr)_minmax(0,1fr)_minmax(0,1fr)]">
            <ResumenViajes datos={resumen} />
            <ConsumoPorTramo tramos={tramos} />
            <CargasYRendimiento datos={resumen} ahora={ahora} />
            <AlertasActivas datos={resumen} ahora={ahora} />
          </div>
        </div>
      )}

      {chica && (
        <nav
          aria-label="Secciones de la unidad"
          className="fixed inset-x-0 bottom-0 z-20 flex border-t border-white/10 bg-[#070d0e]/95 backdrop-blur"
          style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
        >
          {(
            [
              ["mapa", "Mapa", <MapPin key="m" className="h-5 w-5" aria-hidden />],
              ["viaje", "Viaje", <Clock key="v" className="h-5 w-5" aria-hidden />],
              ["conductor", "Conductor", <Users key="c" className="h-5 w-5" aria-hidden />],
              ["consumo", "Consumo", <ChartColumn key="n" className="h-5 w-5" aria-hidden />],
              [
                "alertas",
                "Alertas",
                <span key="a" className="relative">
                  <Bell className="h-5 w-5" aria-hidden />
                  {nAlertas ? (
                    <i
                      className="absolute -right-2 -top-1.5 grid min-w-[15px] place-items-center rounded-full px-1 text-[9px] font-extrabold not-italic leading-[15px] text-white"
                      style={{ background: hayCriticas ? ROJO : "#d97706" }}
                    >
                      {nAlertas > 99 ? "99+" : nAlertas}
                    </i>
                  ) : null}
                </span>,
              ],
            ] as [TabUnidad, string, ReactNode][]
          ).map(([id, texto, icono]) => (
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

const ROJO = "#ef2f2f";

/** Una de las cuatro cifras de arriba: ícono, título, valor y una línea de pie, siempre en una fila. */
function Kpi({
  Icono,
  color,
  titulo,
  valor,
  pie,
  tono,
  borde = false,
}: {
  Icono: LucideIcon;
  color: string;
  titulo: string;
  valor: string;
  pie: string;
  tono?: string;
  borde?: boolean;
}) {
  return (
    <div
      className={`${CARD} flex items-center gap-2 !px-2.5 !py-1.5`}
      style={borde ? { borderColor: `${color}66` } : undefined}
    >
      <Icono
        className="h-[18px] w-[18px] shrink-0 min-[1700px]:h-5 min-[1700px]:w-5"
        style={{ color }}
        aria-hidden
      />
      <div className="min-w-0">
        <small className="block whitespace-nowrap text-[8.5px] uppercase tracking-[.1em] text-slate-400 min-[1700px]:text-[9.5px]">
          {titulo}
        </small>
        <b
          className="block whitespace-nowrap text-[14px] font-extrabold leading-tight tabular-nums min-[1700px]:text-base"
          style={tono ? { color: tono } : undefined}
        >
          {valor}
        </b>
        <span className="block whitespace-nowrap text-[9.5px] text-slate-400 min-[1700px]:text-[10.5px]">
          {pie}
        </span>
      </div>
    </div>
  );
}
