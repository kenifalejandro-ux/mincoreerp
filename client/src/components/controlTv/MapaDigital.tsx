// El mapa digital del Control TV: el Perú dibujado (tierra en puntitos, departamentos en dorado) con
// los lugares de los viajes y cada unidad como una luz del color de su estado. No usa internet. Sin GPS,
// la posición es una estimación por las marcas; con pantalla completa y una lista lateral con filtros.
import { LocateFixed, Maximize2, Minimize2 } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { CATS, categoriaDe, type CatTv } from "./controlTvLogica";
import { imagenDeTipo } from "./iconosCanvas";
import {
  acercar,
  aPixel,
  contarPorEstado,
  desplazar,
  encuadre,
  filtrarPorEstado,
  masCercana,
  posicionEnMapa,
  puntosDeEncuadre,
  puntoDeLugar,
  puntosDelViaje,
  separar,
  type Caja,
  type FiltroEstado,
  type LugarMapa,
  type Punto,
} from "./mapaLogica";
import type { LugarSatelite } from "./MapaSatelite";
import { MarcasEnVivo } from "./MarcasEnVivo";
import { anchoDeIcono } from "./tiposUnidad";
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
  unidad = false,
  pie,
}: {
  viajes: FilaViaje[];
  lugares: LugarMapa[];
  onElegir: (id: string) => void;
  /** El título de la tarjeta («Dónde está» en la vista de una unidad). */
  titulo?: string;
  /** Sin la leyenda de estados que filtra (con una sola unidad no hace falta). */
  sinLeyenda?: boolean;
  /** La vista de UNA unidad: encuadra su ruta de cerca y no pone etiqueta (ya se sabe de quién es). */
  unidad?: boolean;
  /** Una línea debajo del mapa (por ejemplo, desde cuándo está ahí la unidad). */
  pie?: ReactNode;
}) {
  const [completa, setCompleta] = useState(false);
  const [filtro, setFiltro] = useState<FiltroEstado>("todas");
  const [elegida, setElegida] = useState<string | null>(null);
  // El encuadre que dejó quien arrastró o acercó el mapa; null = el automático (la ruta o la zona).
  const [vista, setVista] = useState<Caja | null>(null);
  // La unidad bajo el mouse (su etiqueta sale solo entonces) y un aviso de que un ícono terminó de cargar.
  const [bajo, setBajo] = useState<string | null>(null);
  const [iconosListos, setIconosListos] = useState(0);
  // Digital (dibujado, sin internet) o Satélite (necesita internet); se recuerda lo que eligió cada persona.
  type Capa = "marcas" | "digital" | "satelite";
  const [capa, setCapa] = useState<Capa>(() => {
    try {
      const guardada = localStorage.getItem("controlTv.capaMapa");
      return guardada === "satelite" || guardada === "marcas" ? guardada : "digital";
    } catch {
      return "digital";
    }
  });
  const cambiarCapa = (c: Capa) => {
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
        tipo: f.v.equipo_tipo,
        pos: f.pos,
      };
    });
    const vistos = new Set<string>();
    const lugaresConPunto: LugarSatelite[] = [];
    for (const f of filas) {
      const paradas = paradasDelViaje(f.v);
      paradas.forEach((p, i) => {
        const id = String(p.lugar_id);
        const pt = f.puntos[i];
        if (pt && !vistos.has(id)) {
          vistos.add(id);
          const papel = i === 0 ? "origen" : i === paradas.length - 1 ? "destino" : "parada";
          lugaresConPunto.push({ id, nombre: p.lugar, punto: pt, papel });
        }
      });
    }
    return { unidades, lugaresConPunto };
    // `visibles` se recalcula con `filas` y `filtro`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filas, filtro]);
  const sinUbicar = visibles.filter((f) => !f.pos);

  // Se encuadra en lo que hay: los lugares con punto y las unidades.
  const todosLosPuntos = useMemo(() => puntosDeEncuadre(filas), [filas]);
  const marcoAuto = useMemo(
    () => encuadre(todosLosPuntos, tamano.w || 1, tamano.h || 1, 0.18, unidad ? 0.5 : 3),
    [todosLosPuntos, tamano, unidad]
  );
  const marco = vista ?? marcoAuto;
  // Los gestos leen el encuadre y el tamaño de ahora sin volver a armarse.
  const ahora = useRef({ marco, tamano });
  useEffect(() => {
    ahora.current = { marco, tamano };
  });
  // Al cambiar de unidad se vuelve a encuadrar su ruta.
  const idUnidad = unidad ? (viajes[0]?.id ?? null) : null;
  const [idVisto, setIdVisto] = useState(idUnidad);
  if (idVisto !== idUnidad) {
    setIdVisto(idUnidad);
    setVista(null);
  }

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

  // Capa fija: cuadrícula, tierra, departamentos y lugares. Se redibuja solo si cambia algo de eso.
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
    // lugares con su punto: un pin en el origen y en el destino, un punto en las paradas
    const lugaresVistos = new Map<string, { nombre: string; pt: Punto; papel: number }>();
    for (const f of filas) {
      const paradas = paradasDelViaje(f.v);
      paradas.forEach((p, i) => {
        const id = String(p.lugar_id);
        const pt = puntoDeLugar(porId.get(id));
        if (!pt) return;
        // 0 = origen, 1 = destino, 2 = parada: el primero que aparece manda
        const papel = i === 0 ? 0 : i === paradas.length - 1 ? 1 : 2;
        const previo = lugaresVistos.get(id);
        if (!previo || papel < previo.papel) lugaresVistos.set(id, { nombre: p.lugar, pt, papel });
      });
    }
    const PIN = new Path2D("M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z");
    for (const { nombre, pt, papel } of lugaresVistos.values()) {
      const q = pix(pt.lat, pt.lon);
      if (papel === 2) {
        x.fillStyle = "#fbffe0";
        x.beginPath();
        x.arc(q.x, q.y, 2.4, 0, Math.PI * 2);
        x.fill();
      } else {
        // El pin de GPS (la punta está en el lugar): ámbar la salida, verde la llegada.
        const col = papel === 0 ? "#fbbf24" : "#34d399";
        x.save();
        x.translate(q.x - 12 * 0.7, q.y - 22 * 0.7);
        x.scale(0.7, 0.7);
        x.shadowColor = col;
        x.shadowBlur = 8;
        x.fillStyle = "rgba(6,12,13,.9)";
        x.fill(PIN);
        x.shadowBlur = 0;
        x.strokeStyle = col;
        x.lineWidth = 2.2;
        x.stroke(PIN);
        x.fillStyle = col;
        x.beginPath();
        x.arc(12, 10, 3, 0, Math.PI * 2);
        x.fill();
        x.restore();
      }
      x.font = "500 12px Inter, system-ui, sans-serif";
      x.fillStyle = "#f4f1ea";
      x.fillText(nombre, q.x + 9, q.y + (papel === 2 ? 4 : -6));
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
      puestas.current = [];
      lista.forEach((f, i) => {
        const col = COLOR[f.cat];
        const a = px[i].x + sep[i].dx;
        const b = px[i].y + sep[i].dy;
        puestas.current.push({ id: f.v.id, x: a, y: b });
        const pulso = f.cat === "detenida" && !quieto ? (1 + Math.sin(t / 260)) / 2 : 0;
        // El avatar: el ícono de su tipo, del color de su estado, sobre una cápsula oscura (chico, para que
        // 40 unidades no tapen la ruta).
        const alto = 7.5;
        const w = anchoDeIcono(f.v.equipo_tipo, alto);
        const img = imagenDeTipo(f.v.equipo_tipo, col, alto, () => setIconosListos((n) => n + 1));
        x.fillStyle = `${col}33`;
        x.beginPath();
        x.roundRect(
          a - w / 2 - 5.5 - pulso * 3,
          b - 7.5 - pulso * 3,
          w + 11 + pulso * 6,
          15 + pulso * 6,
          7
        );
        x.fill();
        x.fillStyle = "rgba(6,12,13,.92)";
        x.strokeStyle = elegida === f.v.id ? "#fff" : col;
        x.lineWidth = elegida === f.v.id ? 1.8 : 1;
        x.beginPath();
        x.roundRect(a - w / 2 - 3.5, b - 6, w + 7, 12, 4);
        x.fill();
        x.stroke();
        if (img) x.drawImage(img, a - w / 2, b - alto / 2, w, alto);
        else {
          x.fillStyle = col;
          x.beginPath();
          x.arc(a, b, 2.4, 0, Math.PI * 2);
          x.fill();
        }
        // La etiqueta (placa, conductor y ruta) sale solo al pasar el mouse o con la unidad elegida;
        // en la vista de una unidad no sale: ya se sabe de quién es.
        if (!unidad && (elegida === f.v.id || bajo === f.v.id)) {
          const paradas = paradasDelViaje(f.v);
          const txt = `${unidadLabel(f.v)} · ${f.v.conductor_nombre ?? "sin conductor"}`;
          x.font = "700 10.5px Inter, system-ui, sans-serif";
          const r = { x: a + w / 2 + 8, y: b - 24, w: x.measureText(txt).width + 14 };
          x.fillStyle = "rgba(6,12,13,.92)";
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
  }, [visibles, marco, tamano, elegida, bajo, unidad, iconosListos]);

  // Arrastrar con el ratón, rueda para acercar y dos dedos en el celular (con un dedo se sigue
  // bajando la página). Un toque corto o un clic sin mover abre la unidad.
  const arrastre = useRef<{ x: number; y: number; ox: number; oy: number; movio: boolean } | null>(
    null
  );
  const posEnLienzo = (e: { clientX: number; clientY: number }) => {
    const r = vivo.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const alBajar = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const p = posEnLienzo(e);
    arrastre.current = { x: p.x, y: p.y, ox: p.x, oy: p.y, movio: false };
    if (e.pointerType === "mouse") e.currentTarget.setPointerCapture(e.pointerId);
  };
  const alMover = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = posEnLienzo(e);
    const a = arrastre.current;
    if (a && e.pointerType === "mouse") {
      if (Math.hypot(p.x - a.ox, p.y - a.oy) > 4) a.movio = true;
      if (a.movio) {
        const { marco: m, tamano: t } = ahora.current;
        setVista(desplazar(m, p.x - a.x, p.y - a.y, t.w, t.h));
        a.x = p.x;
        a.y = p.y;
      }
      return;
    }
    if (e.pointerType === "mouse") {
      const id = masCercana(puestas.current, p.x, p.y, 16);
      setBajo((antes) => (antes === id ? antes : id));
      e.currentTarget.style.cursor = id ? "pointer" : "grab";
    }
  };
  const alSoltar = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const a = arrastre.current;
    arrastre.current = null;
    if (!a || a.movio) return;
    const p = posEnLienzo(e);
    const id = masCercana(puestas.current, p.x, p.y, 16);
    if (id) onElegir(id);
  };
  useEffect(() => {
    const c = vivo.current;
    if (!c) return;
    // La rueda acerca o aleja dejando quieto lo que está bajo el puntero.
    const alRodar = (e: WheelEvent) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      const { marco: m, tamano: t } = ahora.current;
      setVista(
        acercar(m, Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top, t.w, t.h)
      );
    };
    // Dos dedos: mover y pellizcar a la vez. Con uno, el navegador baja la página.
    let dedos: { cx: number; cy: number; d: number } | null = null;
    const medir = (e: TouchEvent) => {
      const [a, b] = [e.touches[0], e.touches[1]];
      const r = c.getBoundingClientRect();
      return {
        cx: (a.clientX + b.clientX) / 2 - r.left,
        cy: (a.clientY + b.clientY) / 2 - r.top,
        d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
      };
    };
    const alTocarConDedos = (e: TouchEvent) => {
      dedos = e.touches.length === 2 ? medir(e) : null;
    };
    const alMoverDedos = (e: TouchEvent) => {
      if (e.touches.length !== 2 || !dedos) return;
      if (e.cancelable) e.preventDefault();
      const nuevo = medir(e);
      const { marco: m, tamano: t } = ahora.current;
      const movido = desplazar(m, nuevo.cx - dedos.cx, nuevo.cy - dedos.cy, t.w, t.h);
      setVista(acercar(movido, nuevo.d / Math.max(dedos.d, 1), nuevo.cx, nuevo.cy, t.w, t.h));
      dedos = nuevo;
    };
    const alSoltarDedos = () => (dedos = null);
    c.addEventListener("wheel", alRodar, { passive: false });
    c.addEventListener("touchstart", alTocarConDedos, { passive: true });
    c.addEventListener("touchmove", alMoverDedos, { passive: false });
    c.addEventListener("touchend", alSoltarDedos, { passive: true });
    return () => {
      c.removeEventListener("wheel", alRodar);
      c.removeEventListener("touchstart", alTocarConDedos);
      c.removeEventListener("touchmove", alMoverDedos);
      c.removeEventListener("touchend", alSoltarDedos);
    };
  }, [capa]);

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
          {(["marcas", "digital", "satelite"] as const).map((k) => (
            <button
              key={k}
              aria-pressed={capa === k}
              onClick={() => cambiarCapa(k)}
              className={`min-h-7 rounded-md px-2.5 text-xs font-bold ${
                capa === k ? "bg-[#BADC1E] text-[#0D1719]" : "text-slate-400 hover:text-white"
              }`}
            >
              {k === "marcas" ? "Marcas" : k === "digital" ? "Digital" : "Satélite"}
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
            className={`absolute inset-0 h-full w-full ${capa !== "digital" ? "hidden" : ""}`}
          />
          <canvas
            ref={vivo}
            onPointerDown={alBajar}
            onPointerMove={alMover}
            onPointerUp={alSoltar}
            onPointerCancel={() => (arrastre.current = null)}
            onPointerLeave={() => setBajo(null)}
            role="img"
            aria-label="Mapa de las unidades en ruta, posición estimada por las marcas"
            className={`absolute inset-0 h-full w-full cursor-grab touch-pan-y ${capa !== "digital" ? "hidden" : ""}`}
          />
          {capa === "digital" && vista && (
            <button
              onClick={() => setVista(null)}
              className="absolute right-2 top-2 inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-[#060c0d]/80 px-2.5 py-1 text-[11.5px] font-semibold text-slate-200 backdrop-blur-sm hover:border-[#BADC1E]"
            >
              <LocateFixed className="h-3.5 w-3.5" aria-hidden /> Recentrar
            </button>
          )}
          {capa === "marcas" && (
            <MarcasEnVivo
              viajes={visibles.map((f) => f.v)}
              onElegir={onElegir}
              anchoPanel={tamano.w || 900}
            />
          )}
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
                elegida={elegida}
                onElegir={onElegir}
              />
            </Suspense>
          )}
          {capa !== "marcas" && lugares.filter((l) => puntoDeLugar(l)).length === 0 && (
            <p className="absolute inset-x-4 top-3 rounded-lg border border-amber-400/30 bg-amber-400/10 p-2 text-xs text-amber-200">
              Todavía no hay lugares con punto en el mapa. Ponlos en Viajes → Lugares y aparecerán
              aquí.
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
          {capa !== "marcas" && sinUbicar.length > 0 && (
            <p className="pointer-events-none absolute bottom-12 left-3 right-3 rounded-lg bg-black/60 px-2 py-1 text-[11px] text-amber-200">
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
