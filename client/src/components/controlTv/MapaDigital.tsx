// El mapa digital del Control TV: el Perú dibujado (tierra en puntitos, departamentos en dorado) con
// las rutas de los viajes y cada unidad como una luz del color de su estado. No usa internet. Sin GPS,
// la posición es una estimación por las marcas; con pantalla completa y una lista lateral con filtros.
import { Maximize2, Minimize2 } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { CATS, categoriaDe, type CatTv } from "./controlTvLogica";
import {
  aPixel,
  arcosDelViaje,
  contarPorEstado,
  encuadre,
  filtrarPorEstado,
  posicionEnMapa,
  puntoDeLugar,
  puntosDelViaje,
  separar,
  type FiltroEstado,
  type LugarMapa,
  type Punto,
} from "./mapaLogica";
import { paradasDelViaje } from "../combustible/paradasViaje";
import { PERU_DEPARTAMENTOS } from "../combustible/peruDepartamentos";
import { unidadLabel, type FilaViaje } from "../combustible/viajesFormato";

// El satélite (Leaflet y su hoja de estilos) se baja solo cuando alguien lo pide.
const MapaSatelite = lazy(() => import("./MapaSatelite"));

const COLOR = Object.fromEntries(CATS.map((c) => [c.k, c.c])) as Record<CatTv, string>;
const DORADO = "233,200,147";
const LIMA = "186,220,30";

const anillos = (c: number[][][] | number[][][][], t: "Polygon" | "MultiPolygon") =>
  t === "Polygon" ? (c as number[][][]) : (c as number[][][][]).flat();

export function MapaDigital({
  viajes,
  lugares,
  onElegir,
  titulo = "Vista en vivo",
  sinLeyenda = false,
  pie,
}: {
  viajes: FilaViaje[];
  lugares: LugarMapa[];
  onElegir: (id: string) => void;
  /** El título de la tarjeta («Dónde está» en la vista de una unidad). */
  titulo?: string;
  /** Sin la leyenda de estados que filtra (con una sola unidad no hace falta). */
  sinLeyenda?: boolean;
  /** Una línea debajo del mapa (por ejemplo, desde cuándo está ahí la unidad). */
  pie?: ReactNode;
}) {
  const [completa, setCompleta] = useState(false);
  const [filtro, setFiltro] = useState<FiltroEstado>("todas");
  const [elegida, setElegida] = useState<string | null>(null);
  // Digital (dibujado, sin internet) o Satélite (necesita internet); se recuerda lo que eligió cada persona.
  const [capa, setCapa] = useState<"digital" | "satelite">(() => {
    try {
      return localStorage.getItem("controlTv.capaMapa") === "satelite" ? "satelite" : "digital";
    } catch {
      return "digital";
    }
  });
  const cambiarCapa = (c: "digital" | "satelite") => {
    setCapa(c);
    try {
      localStorage.setItem("controlTv.capaMapa", c);
    } catch {
      // Sin almacenamiento: vale solo mientras esté abierta la pantalla.
    }
  };
  const [tamano, setTamano] = useState({ w: 0, h: 0 });
  const caja = useRef<HTMLDivElement>(null);
  const base = useRef<HTMLCanvasElement>(null);
  const vivo = useRef<HTMLCanvasElement>(null);
  const puestas = useRef<{ id: string; x: number; y: number }[]>([]);

  const porId = useMemo(() => new Map(lugares.map((l) => [String(l.id), l])), [lugares]);
  const filas = useMemo(
    () =>
      viajes.map((v) => ({
        v,
        cat: categoriaDe(v),
        pos: posicionEnMapa(v, porId),
        puntos: puntosDelViaje(v, porId),
      })),
    [viajes, porId]
  );
  const visibles = filtrarPorEstado(filas, filtro);
  const datosSatelite = useMemo(() => {
    const unidades = visibles.map((f) => {
      const p = paradasDelViaje(f.v);
      return {
        id: f.v.id,
        placa: unidadLabel(f.v),
        conductor: f.v.conductor_nombre ?? "sin conductor",
        ruta: `${p[0].lugar} → ${p[p.length - 1].lugar}`,
        color: COLOR[f.cat],
        pos: f.pos,
      };
    });
    const vistos = new Set<string>();
    const lugaresConPunto: { id: string; nombre: string; punto: Punto }[] = [];
    const rutas: Punto[][] = [];
    for (const f of filas) {
      paradasDelViaje(f.v).forEach((p, i) => {
        const id = String(p.lugar_id);
        const pt = f.puntos[i];
        if (pt && !vistos.has(id)) {
          vistos.add(id);
          lugaresConPunto.push({ id, nombre: p.lugar, punto: pt });
        }
      });
      for (const arco of arcosDelViaje(f.puntos)) if (arco) rutas.push(arco);
    }
    return { unidades, lugaresConPunto, rutas };
    // `visibles` se recalcula con `filas` y `filtro`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filas, filtro]);
  const sinUbicar = visibles.filter((f) => !f.pos);

  // Se encuadra en lo que hay: los lugares con punto y las unidades.
  const todosLosPuntos = useMemo(() => {
    const out: Punto[] = [];
    for (const f of filas) f.puntos.forEach((p) => p && out.push(p));
    return out;
  }, [filas]);
  const marco = useMemo(
    () => encuadre(todosLosPuntos, tamano.w || 1, tamano.h || 1),
    [todosLosPuntos, tamano]
  );

  // El tamaño del lienzo sigue al del contenedor (pantalla completa, giro del teléfono).
  useEffect(() => {
    const el = caja.current;
    if (!el) return;
    const medir = () => setTamano({ w: el.clientWidth, h: el.clientHeight });
    medir();
    const o = new ResizeObserver(medir);
    o.observe(el);
    return () => o.disconnect();
  }, [completa]);

  useEffect(() => {
    if (!completa) return;
    const alTeclear = (e: KeyboardEvent) => e.key === "Escape" && setCompleta(false);
    window.addEventListener("keydown", alTeclear);
    return () => window.removeEventListener("keydown", alTeclear);
  }, [completa]);

  // Capa fija: cuadrícula, tierra, departamentos, rutas y lugares. Se redibuja solo si cambia algo de eso.
  useEffect(() => {
    const c = base.current;
    const { w: W, h: H } = tamano;
    if (!c || !W || !H) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = W * dpr;
    c.height = H * dpr;
    const x = c.getContext("2d");
    if (!x) return;
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, W, H);
    const pix = (lat: number, lon: number) => aPixel({ lat, lon }, marco, W, H);
    const trazar = (ctx: CanvasRenderingContext2D) =>
      PERU_DEPARTAMENTOS.forEach((d) => {
        ctx.beginPath();
        anillos(d.c, d.t).forEach((r) =>
          r.forEach((p, i) => {
            const q = pix(p[1], p[0]);
            if (i) ctx.lineTo(q.x, q.y);
            else ctx.moveTo(q.x, q.y);
          })
        );
      });
    // tierra en puntitos, con una máscara de los polígonos
    const m = document.createElement("canvas");
    m.width = Math.round(W);
    m.height = Math.round(H);
    const mx = m.getContext("2d");
    if (mx) {
      mx.fillStyle = "#fff";
      PERU_DEPARTAMENTOS.forEach((d) => {
        mx.beginPath();
        anillos(d.c, d.t).forEach((r) =>
          r.forEach((p, i) => {
            const q = pix(p[1], p[0]);
            if (i) mx.lineTo(q.x, q.y);
            else mx.moveTo(q.x, q.y);
          })
        );
        mx.fill();
      });
      const datos = mx.getImageData(0, 0, m.width, m.height).data;
      const sep = Math.max(9, Math.round(Math.min(W, H) / 38));
      x.fillStyle = "rgba(244,241,234,.40)";
      for (let y = sep / 2; y < H; y += sep) {
        for (let px = sep / 2; px < W; px += sep) {
          if (datos[(Math.floor(y) * m.width + Math.floor(px)) * 4 + 3] < 128) continue;
          x.beginPath();
          x.arc(px, y, 1, 0, Math.PI * 2);
          x.fill();
        }
      }
    }
    x.strokeStyle = `rgba(${DORADO},.30)`;
    x.lineWidth = 0.7;
    trazar(x);
    PERU_DEPARTAMENTOS.forEach((d) => {
      x.beginPath();
      anillos(d.c, d.t).forEach((r) =>
        r.forEach((p, i) => {
          const q = pix(p[1], p[0]);
          if (i) x.lineTo(q.x, q.y);
          else x.moveTo(q.x, q.y);
        })
      );
      x.stroke();
    });
    // rutas de los viajes
    x.lineCap = "round";
    for (const f of filas) {
      for (const arco of arcosDelViaje(f.puntos)) {
        if (!arco) continue;
        x.beginPath();
        arco.forEach((p, i) => {
          const q = pix(p.lat, p.lon);
          if (i) x.lineTo(q.x, q.y);
          else x.moveTo(q.x, q.y);
        });
        x.strokeStyle = `rgba(${LIMA},.10)`;
        x.lineWidth = 6;
        x.stroke();
        x.strokeStyle = "rgba(212,242,90,.55)";
        x.lineWidth = 1.1;
        x.stroke();
      }
    }
    // lugares con su punto: nombre en blanco y su papel en la ruta
    const usados = new Set<string>();
    x.font = "500 12px Inter, system-ui, sans-serif";
    for (const f of filas) {
      const paradas = paradasDelViaje(f.v);
      paradas.forEach((p, i) => {
        const id = String(p.lugar_id);
        if (usados.has(id)) return;
        const pt = puntoDeLugar(porId.get(id));
        if (!pt) return;
        usados.add(id);
        const q = pix(pt.lat, pt.lon);
        x.shadowColor = `rgba(${LIMA},.8)`;
        x.shadowBlur = 10;
        x.fillStyle = "#fbffe0";
        x.beginPath();
        x.arc(q.x, q.y, 3.2, 0, Math.PI * 2);
        x.fill();
        x.shadowBlur = 0;
        x.font = "600 8px Inter, system-ui, sans-serif";
        x.fillStyle = `rgba(${LIMA},.85)`;
        const papel = i === 0 ? "ORIGEN" : i === paradas.length - 1 ? "DESTINO" : "PARADA";
        x.fillText(papel.split("").join(" "), q.x + 9, q.y - 3);
        x.font = "500 12px Inter, system-ui, sans-serif";
        x.fillStyle = "#f4f1ea";
        x.fillText(p.lugar, q.x + 9, q.y + 11);
      });
    }
  }, [tamano, marco, filas, porId]);

  // Capa viva: las unidades. Las que van en camino dejan una estela; sin movimiento reducido se anima.
  useEffect(() => {
    const c = vivo.current;
    const { w: W, h: H } = tamano;
    if (!c || !W || !H) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = W * dpr;
    c.height = H * dpr;
    const x = c.getContext("2d");
    if (!x) return;
    const quieto = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    const dibujar = (t: number) => {
      x.setTransform(dpr, 0, 0, dpr, 0, 0);
      x.clearRect(0, 0, W, H);
      const lista = visibles.filter((f) => f.pos);
      const px = lista.map((f) => aPixel(f.pos!.punto, marco, W, H));
      const sep = separar(px);
      const ocupadas: { x: number; y: number; w: number; h: number }[] = [];
      puestas.current = [];
      lista.forEach((f, i) => {
        const col = COLOR[f.cat];
        const a = px[i].x + sep[i].dx;
        const b = px[i].y + sep[i].dy;
        puestas.current.push({ id: f.v.id, x: a, y: b });
        const pulso = f.cat === "detenida" && !quieto ? (1 + Math.sin(t / 260)) / 2 : 0;
        x.fillStyle = `${col}33`;
        x.beginPath();
        x.arc(a, b, 9 + pulso * 8, 0, Math.PI * 2);
        x.fill();
        x.fillStyle = col;
        x.strokeStyle = "#fff";
        x.lineWidth = 1.3;
        x.beginPath();
        x.arc(a, b, 4.4, 0, Math.PI * 2);
        x.fill();
        x.stroke();
        const esElegida = elegida === f.v.id;
        if (esElegida) {
          x.strokeStyle = "#fff";
          x.beginPath();
          x.arc(a, b, 14, 0, Math.PI * 2);
          x.stroke();
        }
        // etiqueta: placa y conductor, y la ruta; las que se pisan se ocultan (la elegida siempre sale)
        const paradas = paradasDelViaje(f.v);
        const txt = `${unidadLabel(f.v)} · ${f.v.conductor_nombre ?? "sin conductor"}`;
        x.font = "700 10.5px Inter, system-ui, sans-serif";
        const ancho = x.measureText(txt).width + 14;
        const r = { x: a + 10, y: b - 24, w: ancho, h: 28 };
        const choca = ocupadas.some(
          (o) => !(r.x > o.x + o.w || r.x + r.w < o.x || r.y > o.y + o.h || r.y + r.h < o.y)
        );
        if (esElegida || !choca) {
          ocupadas.push(r);
          x.fillStyle = "rgba(6,12,13,.88)";
          x.strokeStyle = col;
          x.lineWidth = 1;
          x.beginPath();
          x.roundRect(r.x, r.y, r.w, 28, 6);
          x.fill();
          x.stroke();
          x.fillStyle = "#fff";
          x.fillText(txt, r.x + 7, r.y + 12);
          x.font = "600 9px Inter, system-ui, sans-serif";
          x.fillStyle = `rgba(${LIMA},.9)`;
          x.fillText(
            `${paradas[0].lugar} → ${paradas[paradas.length - 1].lugar}`,
            r.x + 7,
            r.y + 23
          );
        }
      });
      if (!quieto && visibles.some((f) => f.cat === "detenida" && f.pos)) {
        raf = requestAnimationFrame(dibujar);
      }
    };
    // El primer cuadro sale ya; los siguientes (solo si hay una detenida que pulsa) los pide el navegador.
    raf = requestAnimationFrame(dibujar);
    return () => cancelAnimationFrame(raf);
  }, [visibles, marco, tamano, elegida]);

  const alTocar = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const cx = e.clientX - r.left;
    const cy = e.clientY - r.top;
    let mejor: { id: string; d: number } | null = null;
    for (const p of puestas.current) {
      const d = Math.hypot(p.x - cx, p.y - cy);
      if (d <= 14 && (!mejor || d < mejor.d)) mejor = { id: p.id, d };
    }
    if (mejor) onElegir(mejor.id);
  };

  // Cuántas unidades hay en cada estado (la leyenda de abajo es el filtro y dice cuántas son).
  const conteo = (k: FiltroEstado) => contarPorEstado(filas, k);

  return (
    <section
      className={
        completa
          ? "fixed inset-0 z-50 flex flex-col gap-2 p-3"
          : "flex min-h-[300px] flex-col gap-2 rounded-2xl border border-white/10 bg-white/[0.04] p-3"
      }
      // El fondo va en línea: la clase z-50 de la app trae su propio fondo blanco y lo pisaba.
      style={completa ? { background: "#070d0e" } : undefined}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex items-center gap-2 text-xs font-bold uppercase tracking-[.16em] text-slate-400">
          <span className="h-2 w-2 rounded-full bg-emerald-400" aria-hidden />
          {titulo}
        </h2>
        <div className="ml-auto inline-flex gap-0.5 rounded-lg border border-white/10 bg-white/5 p-0.5">
          {(["digital", "satelite"] as const).map((k) => (
            <button
              key={k}
              aria-pressed={capa === k}
              onClick={() => cambiarCapa(k)}
              className={`min-h-7 rounded-md px-2.5 text-xs font-bold ${
                capa === k ? "bg-[#BADC1E] text-[#0D1719]" : "text-slate-400 hover:text-white"
              }`}
            >
              {k === "digital" ? "Digital" : "Satélite"}
            </button>
          ))}
        </div>
        <button
          onClick={() => setCompleta((v) => !v)}
          aria-label={
            completa ? "Salir de pantalla completa del mapa" : "Mapa en pantalla completa"
          }
          className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-2.5 py-1 text-xs font-semibold hover:border-[#BADC1E]"
        >
          {completa ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          {completa ? "Salir" : "Pantalla completa"}
        </button>
      </div>
      <div className={`grid min-h-0 flex-1 gap-0 ${completa ? "lg:grid-cols-[260px_1fr]" : ""}`}>
        {completa && (
          <ul className="hidden min-h-0 overflow-y-auto border-r border-[rgba(233,200,147,.14)] lg:block [scrollbar-color:rgba(233,200,147,.25)_transparent] [scrollbar-width:thin]">
            {visibles.map((f) => (
              <li key={f.v.id} className="border-b border-white/5">
                <button
                  onClick={() => setElegida(elegida === f.v.id ? null : f.v.id)}
                  onDoubleClick={() => onElegir(f.v.id)}
                  className={`flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-white/5 ${
                    elegida === f.v.id ? "bg-[#BADC1E]/10 shadow-[inset_2px_0_0_#BADC1E]" : ""
                  }`}
                >
                  <i
                    className="h-[7px] w-[7px] shrink-0 rounded-full"
                    style={{ background: COLOR[f.cat], boxShadow: `0 0 8px ${COLOR[f.cat]}` }}
                  />
                  <span className="min-w-0">
                    <b className="block text-[12.5px]">{unidadLabel(f.v)}</b>
                    <small className="block truncate text-[10.5px] text-slate-400">
                      {f.v.conductor_nombre ?? "sin conductor"} ·{" "}
                      {CATS.find((c) => c.k === f.cat)?.t}
                      {!f.pos && <span className="text-amber-400/80"> · sin ubicar</span>}
                    </small>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div
          ref={caja}
          className="relative min-h-[240px] overflow-hidden rounded-xl border border-[#BADC1E]/20"
          style={{
            // El fondo verde oscuro con la cuadrícula de lima que tenía la vista de «Marcas».
            background:
              "radial-gradient(ellipse at 50% 50%, #1c3a2a55, transparent 70%), repeating-linear-gradient(0deg, #BADC1E12 0 1px, transparent 1px 34px), repeating-linear-gradient(90deg, #BADC1E12 0 1px, transparent 1px 34px), #081210",
          }}
        >
          <canvas
            ref={base}
            aria-hidden
            className={`absolute inset-0 h-full w-full ${capa === "satelite" ? "hidden" : ""}`}
          />
          <canvas
            ref={vivo}
            onClick={alTocar}
            role="img"
            aria-label="Mapa de las unidades en ruta, posición estimada por las marcas"
            className={`absolute inset-0 h-full w-full cursor-pointer ${capa === "satelite" ? "hidden" : ""}`}
          />
          {capa === "satelite" && (
            <Suspense
              fallback={
                <p className="absolute inset-0 grid place-items-center text-sm text-slate-400">
                  Cargando el satélite…
                </p>
              }
            >
              <MapaSatelite
                unidades={datosSatelite.unidades}
                lugares={datosSatelite.lugaresConPunto}
                rutas={datosSatelite.rutas}
                elegida={elegida}
                onElegir={onElegir}
              />
            </Suspense>
          )}
          {lugares.filter((l) => puntoDeLugar(l)).length === 0 && (
            <p className="absolute inset-x-4 top-3 rounded-lg border border-amber-400/30 bg-amber-400/10 p-2 text-xs text-amber-200">
              Todavía no hay lugares con punto en el mapa. Ponlos en Viajes → Lugares y las rutas
              aparecerán aquí.
            </p>
          )}
          <ul className="sr-only">
            {filas.map((f) => (
              <li key={f.v.id}>
                <button onClick={() => onElegir(f.v.id)}>
                  {`Ver ${unidadLabel(f.v)} en su Control TV`}
                </button>
              </li>
            ))}
          </ul>
          {!sinLeyenda && (
            <ul className="absolute bottom-2 left-3 flex max-w-[calc(100%-1.5rem)] flex-wrap items-center justify-start gap-x-1 gap-y-0.5 rounded-xl border border-white/10 bg-[#060c0d]/75 px-1.5 py-1 backdrop-blur-sm">
              {(["todas", ...CATS.map((c) => c.k)] as const).map((k) => (
                <li key={k}>
                  <button
                    aria-pressed={filtro === k}
                    onClick={() => setFiltro(k)}
                    className={`flex min-h-7 items-center gap-1.5 rounded-lg px-2.5 text-[11.5px] font-semibold ${
                      filtro === k
                        ? "bg-[#BADC1E]/15 text-white shadow-[inset_0_0_0_1px_rgba(186,220,30,.55)]"
                        : "text-slate-300 hover:bg-white/10"
                    }`}
                  >
                    <i
                      className="h-[3px] w-3.5 rounded"
                      style={{ background: k === "todas" ? "#BADC1E" : COLOR[k] }}
                    />
                    {k === "todas" ? "Todas" : (CATS.find((c) => c.k === k)?.t ?? k)}
                    <b className="tabular-nums text-white">{conteo(k)}</b>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {sinUbicar.length > 0 && (
            <p className="absolute bottom-12 left-3 right-3 rounded-lg bg-black/60 px-2 py-1 text-[11px] text-amber-200">
              {sinUbicar.length} {sinUbicar.length === 1 ? "unidad" : "unidades"} sin ubicar en el
              mapa (su lugar no tiene punto):{" "}
              {sinUbicar
                .slice(0, 4)
                .map((f) => unidadLabel(f.v))
                .join(", ")}
              {sinUbicar.length > 4 ? "…" : ""}
            </p>
          )}
        </div>
      </div>
      {pie && <div className="text-xs text-slate-400">{pie}</div>}
    </section>
  );
}
