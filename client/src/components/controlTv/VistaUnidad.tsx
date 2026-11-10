// El Control TV de UNA unidad: conductor primero (con la placa al lado), su estado, las horas del
// viaje, el recorrido, cómo se fue el tiempo, lo que consumió en este recorrido, quién maneja y dónde
// está. Solo lectura. Se abre tocando la unidad en la vista en vivo o desde el ícono TV de su fila.
import { ArrowLeft, ChevronLeft, ChevronRight, MapPin } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { CATS, categoriaDe, posicionEnRuta } from "./controlTvLogica";
import { IconoTipo } from "./iconosUnidad";
import { apiFetch } from "../../services/apiClient";
import { descansoEnVentana, horasDelViaje } from "../combustible/horasViaje";
import { estadoDelViaje, paradasDelViaje } from "../combustible/paradasViaje";
import type { CargaViaje } from "../combustible/PiezasViaje";
import type { TramoDelViaje } from "../combustible/TramosViaje";
import { haceCuanto, ubicacionVigente } from "../combustible/ubicacionesLogica";
import { duracion, fmt, unidadLabel, type FilaViaje } from "../combustible/viajesFormato";

interface Detalle {
  viaje: FilaViaje;
  cargas: CargaViaje[];
  ruta: { combustible_gal: number | null; urea_l: number | null };
  tramos?: TramoDelViaje[];
}

const LITROS_POR_GALON = 3.785411784;
const CARD = "rounded-2xl border border-white/10 bg-white/[0.04] p-4";
const iniciales = (n: string | null) =>
  (n ?? "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((x) => x[0])
    .join("")
    .toUpperCase();

function Cifra({ titulo, min, tono }: { titulo: string; min: number | null; tono: string }) {
  return (
    <div className={`${CARD} ${titulo === "Total" ? "border-[#BADC1E]/50" : ""}`}>
      <small className="block text-xs uppercase tracking-[.14em] text-slate-400">{titulo}</small>
      <b
        className="mt-1 block whitespace-nowrap text-3xl font-extrabold leading-tight"
        style={{ color: tono }}
      >
        {min === null ? "—" : duracion(min)}
      </b>
    </div>
  );
}

function Seccion({ titulo, children }: { titulo: string; children: ReactNode }) {
  return (
    <section className={`${CARD} flex flex-col gap-2`}>
      <h2 className="text-xs font-bold uppercase tracking-[.16em] text-slate-400">{titulo}</h2>
      {children}
    </section>
  );
}

export function VistaUnidad({
  viajes,
  id,
  version,
  ahora,
  onCambiar,
  onVolver,
}: {
  /** Los viajes en curso: de ahí salen Anterior y Siguiente. */
  viajes: FilaViaje[];
  id: string;
  /** Sube cada vez que el Control TV se refresca: esta vista se actualiza con él. */
  version: number;
  ahora: number;
  onCambiar: (id: string) => void;
  onVolver: () => void;
}) {
  const [datos, setDatos] = useState<Detalle | null>(null);
  const [error, setError] = useState<string | null>(null);
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
  const frac = Math.max(0, Math.min(1, posicionEnRuta(v)));
  const donde = ubicacionVigente(paradas, v.ultima_ubicacion);
  const tramos = datos.tramos ?? [];
  const actual = tramos.find((t) => !t.llegada_en);
  const gal = datos.cargas
    .filter((c) => c.producto === "combustible")
    .reduce((s, c) => s + Number(c.cantidad) * (c.unidad === "L" ? 1 / LITROS_POR_GALON : 1), 0);
  const urea = datos.cargas
    .filter((c) => c.producto === "urea")
    .reduce((s, c) => s + Number(c.cantidad) * (c.unidad === "gal" ? LITROS_POR_GALON : 1), 0);
  const costo = datos.cargas.reduce((s, c) => s + Number(c.costo ?? 0), 0);
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

  return (
    <div className="flex flex-col gap-3">
      {barra}
      {error && <p className="text-xs text-amber-300">{error}</p>}

      <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-[#BADC1E] text-lg font-black text-[#0D1719]">
          {iniciales(v.conductor_nombre)}
        </span>
        <h1 className="text-3xl font-bold">{v.conductor_nombre ?? "Sin conductor"}</h1>
        <span className="rounded-lg border border-white/20 bg-white/10 px-3 py-1 text-lg font-extrabold tracking-wider">
          {unidadLabel(v)}
        </span>
        <span className="flex items-center gap-1.5 text-slate-300">
          <IconoTipo tipo={v.equipo_tipo} alto={30} />
          {v.equipo_tipo ?? "Otro"}
        </span>
        <span
          className="rounded-full px-3 py-1 text-sm font-bold"
          style={{ background: `${cat.c}26`, color: cat.c }}
        >
          {estado?.texto ?? "En curso"}
        </span>
        {v.relevo_nombre && (
          <span className="text-sm text-slate-400">Relevo: {v.relevo_nombre}</span>
        )}
      </header>

      {abierto && (
        <p className="rounded-2xl border border-red-400/40 bg-red-400/10 px-4 py-3 text-lg font-bold text-red-100">
          {estado?.texto} desde las{" "}
          {new Date(abierto.inicio_en).toLocaleTimeString("es-PE", {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </p>
      )}

      <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(190px,1fr))]">
        {horas?.idaYVuelta ? (
          <>
            <Cifra titulo="Ida" min={horas.ida} tono="#38bdf8" />
            <Cifra titulo="Estadía" min={horas.estadia} tono="#a78bfa" />
            <Cifra titulo="Vuelta" min={horas.vuelta} tono="#38bdf8" />
          </>
        ) : (
          <>
            <Cifra titulo="En ruta" min={horas?.enRuta ?? null} tono="#38bdf8" />
            <Cifra titulo="En paradas" min={horas?.enParadas ?? null} tono="#a78bfa" />
          </>
        )}
        <Cifra titulo="Total" min={horas?.total ?? null} tono="#f1f5f9" />
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-3">
          <Seccion titulo="Recorrido">
            <div className="relative mx-10 my-2 h-20">
              <div className="absolute inset-x-0 top-6 h-1.5 rounded bg-white/10" />
              <div
                className="absolute left-0 top-6 h-1.5 rounded bg-gradient-to-r from-emerald-400 to-sky-400"
                style={{ width: `${frac * 100}%` }}
              />
              {paradas.map((p, i) => {
                const x = (i / (paradas.length - 1)) * 100;
                const hecho = i === 0 ? !!p.salida_en : !!p.llegada_en;
                return (
                  <div key={p.orden} className="absolute top-0" style={{ left: `${x}%` }}>
                    <i
                      className={`absolute left-0 top-[21px] block h-4 w-4 -translate-x-1/2 rounded-full border-[3px] ${
                        hecho
                          ? "border-emerald-400 bg-emerald-400"
                          : "border-slate-600 bg-[#0b1719]"
                      }`}
                    />
                    <span className="absolute left-0 top-12 w-28 -translate-x-1/2 text-center text-xs leading-tight text-slate-400">
                      <b className="block text-sm text-slate-100">{p.lugar}</b>
                    </span>
                  </div>
                );
              })}
              <span
                className="absolute top-2 grid h-10 -translate-x-1/2 place-items-center rounded-full bg-[#BADC1E] px-3 text-[#0D1719] shadow-[0_0_0_6px_#BADC1E33]"
                style={{ left: `${frac * 100}%` }}
                title={unidadLabel(v)}
              >
                <IconoTipo tipo={v.equipo_tipo} alto={26} />
              </span>
            </div>
          </Seccion>

          <Seccion titulo="Cómo se fue el tiempo">
            <div
              className="flex h-9 gap-[3px] overflow-hidden rounded-xl"
              role="img"
              aria-label="Tiempo manejando, en paradas y descansando"
            >
              {segmentos.map((s, i) => (
                <div
                  key={`${s.t}-${i}`}
                  title={`${s.tip}: ${duracion(s.min)}`}
                  className="grid min-w-[6px] place-items-center overflow-hidden whitespace-nowrap text-xs font-bold text-[#04121a]"
                  style={{ flex: `${s.min / totalSeg} 1 0`, background: COLOR[s.t] }}
                >
                  {s.min / totalSeg > 0.12 ? duracion(s.min) : ""}
                </div>
              ))}
            </div>
            <ul className="flex flex-wrap gap-x-4 text-xs text-slate-400">
              {[
                ["ruta", "Manejando"],
                ["est", "En una parada"],
                ["desc", "Descansando"],
              ].map(([k, t]) => (
                <li key={k} className="flex items-center gap-1.5">
                  <i
                    className="h-[3px] w-3.5 rounded"
                    style={{ background: COLOR[k as keyof typeof COLOR] }}
                  />
                  {t}
                </li>
              ))}
            </ul>
          </Seccion>

          <Seccion titulo="Consumo del recorrido actual">
            <div className="grid grid-cols-3 gap-3">
              <div>
                <small className="block text-xs text-slate-400">Combustible</small>
                <b className="text-2xl tabular-nums">{fmt(gal, 1)}</b>{" "}
                <em className="text-xs not-italic text-slate-400">gal</em>
                {vsPromedio !== null && (
                  <i
                    className={`block text-xs not-italic ${vsPromedio > 20 ? "text-red-400" : "text-slate-400"}`}
                  >
                    {vsPromedio > 0 ? "+" : ""}
                    {fmt(vsPromedio, 0)}% vs. promedio de la ruta
                  </i>
                )}
              </div>
              <div>
                <small className="block text-xs text-slate-400">Urea</small>
                <b className="text-2xl tabular-nums">{fmt(urea, 1)}</b>{" "}
                <em className="text-xs not-italic text-slate-400">L</em>
              </div>
              <div>
                <small className="block text-xs text-slate-400">Costo</small>
                <b className="text-2xl tabular-nums">S/ {fmt(costo, 0)}</b>
              </div>
            </div>
            {tramos.length > 0 && (
              <table className="w-full text-sm tabular-nums">
                <thead className="text-xs uppercase text-slate-400">
                  <tr className="text-left">
                    <th className="py-1 font-semibold">Tramo</th>
                    <th className="py-1 text-right font-semibold">Combustible</th>
                    <th className="py-1 text-right font-semibold">Urea</th>
                  </tr>
                </thead>
                <tbody>
                  {tramos.map((t) => (
                    <tr
                      key={t.orden}
                      className={`border-t border-white/10 ${t === actual ? "bg-[#BADC1E]/10 font-bold" : ""}`}
                    >
                      <td className="py-1.5">
                        {t.de} → {t.a}
                        {t === actual && (
                          <span className="ml-2 text-xs text-[#BADC1E]">en curso</span>
                        )}
                      </td>
                      <td className="py-1.5 text-right">{fmt(t.combustible_gal, 1)} gal</td>
                      <td className="py-1.5 text-right">{fmt(t.urea_l, 1)} L</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Seccion>
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          <Seccion titulo="Conductor y relevo">
            {[
              { n: v.conductor_nombre, dni: v.conductor_dni, rol: "Titular" },
              ...(v.relevo_nombre
                ? [{ n: v.relevo_nombre, dni: v.relevo_dni, rol: "Relevo" }]
                : []),
            ].map((p) => (
              <div key={p.rol} className="flex items-center gap-3">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[#BADC1E] font-black text-[#0D1719]">
                  {iniciales(p.n ?? null)}
                </span>
                <div className="min-w-0 flex-1">
                  <b className="block truncate text-base">{p.n ?? "—"}</b>
                  <small className="text-slate-400">
                    {p.rol}
                    {p.dni ? ` · DNI ${p.dni}` : ""}
                    {v.volante_dni && v.volante_dni === p.dni ? " · al volante" : ""}
                  </small>
                </div>
              </div>
            ))}
            {(v.turnos?.length ?? 0) > 1 && (
              <ul className="border-t border-white/10 pt-2 text-sm">
                {v.turnos?.map((t) => (
                  <li key={t.inicio_en} className="flex justify-between gap-2 py-0.5">
                    <span>{t.conductor_nombre ?? t.conductor_dni}</span>
                    <span className="text-slate-400">
                      {duracion(
                        ((t.fin_en ? Date.parse(t.fin_en) : ahora) - Date.parse(t.inicio_en)) /
                          60_000
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Seccion>

          <Seccion titulo="Dónde está">
            <p className="flex items-center gap-2 text-2xl font-extrabold leading-tight">
              <MapPin className="w-6 h-6 shrink-0 text-[#BADC1E]" aria-hidden />
              {donde?.texto ?? "Sin ubicación todavía"}
            </p>
            {donde && <small className="text-slate-400">{haceCuanto(donde.en, ahora)}</small>}
            {(v.ubicaciones?.length ?? 0) > 0 && (
              <ul className="border-t border-white/10 pt-2 text-sm">
                {v.ubicaciones?.slice(0, 5).map((u) => (
                  <li key={u.id} className="flex justify-between gap-2 py-0.5">
                    <span>{u.texto}</span>
                    <span className="text-slate-400">{haceCuanto(u.registrado_en, ahora)}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-1 grid min-h-[130px] place-items-center rounded-2xl border-2 border-dashed border-white/15 p-4 text-center text-sm text-slate-400">
              <span>
                <b className="block text-base text-slate-100">Mapa</b>
                Con GPS aquí se verá la unidad en el mapa real.
              </span>
            </div>
          </Seccion>
        </div>
      </div>
    </div>
  );
}
