// La pestaña «Detalle» del Control TV (la que usa la gerencia para decidir): cómo se mueve el
// combustible, combustible y urea del período con su tendencia, las últimas recepciones contra su
// factura, las unidades que más se desvían y cuánto cuesta comprar en ruta. Solo lectura.
import { useState, type ReactNode } from "react";

import { GraficaLineas, Leyenda, type SerieLinea } from "./GraficasTv";
import { fmt } from "../combustible/viajesFormato";

export interface DetalleDatos {
  consumo_anterior_gal: number;
  urea?: {
    total: { l: number; almacen_l: number; ruta_l: number; costo: number };
    anterior_l: number;
    serie: { t: string; almacen_l: number; ruta_l: number }[];
    entro: { entradas: number; l: number; costo: number };
  };
  recepciones: {
    id: number;
    recibido_en: string;
    proveedor: string | null;
    factura: string | null;
    recibido_gal: number;
    facturado_gal: number | null;
    diferencia_gal: number | null;
    tolerancia_gal: number;
    costo: number;
  }[];
  desvios: {
    equipo_id: number;
    placa: string;
    tipo: string | null;
    cargado_gal: number;
    rendimiento: { valor: number; unidad: string } | null;
    vs_pares_pct: number | null;
    vs_pasado_pct: number | null;
  }[];
  compra_ruta: {
    gal: number;
    compras: number;
    precio_interno_gal: number | null;
    sobrecosto: number | null;
    por_grifo: { grifo: string; gal: number; compras: number; precio_gal: number }[];
  };
}

export interface DatosCombustibleTv {
  total_gal: number;
  capacidad_gal: number;
  consumo: {
    gal: number;
    costo: number;
    interno_gal: number;
    tanqueta_gal: number;
    ruta_gal: number;
    serie: { t: string; interno_gal: number; tanqueta_gal: number; ruta_gal: number }[];
  } | null;
  entrada: { recepciones: number; recibido_gal: number; costo: number } | null;
}

const PANEL =
  "flex min-w-0 flex-col gap-2.5 rounded-2xl border border-white/10 bg-white/[0.04] p-4";
const soles = (n: number) => `S/ ${fmt(n, 0)}`;
const signo = (n: number) => (n > 0 ? "+" : n < 0 ? "−" : "");
const COLOR = { interno: "#7fa21a", ruta: "#3b8fe0" };

function Kpi({
  t,
  v,
  u,
  pie,
  tot,
}: {
  t: string;
  v: number;
  u: string;
  pie: ReactNode;
  tot?: boolean;
}) {
  return (
    <div>
      <small className="block text-xs text-slate-400">{t}</small>
      <b
        className={`block whitespace-nowrap text-xl leading-tight tabular-nums ${tot ? "text-white" : ""}`}
      >
        {fmt(v, 0)}
        <em className="ml-1 text-xs font-semibold not-italic text-slate-400">{u}</em>
      </b>
      <i className="text-xs not-italic text-slate-400">{pie}</i>
    </div>
  );
}

function Nodo({ t, v, pie, color }: { t: string; v: number; pie?: string; color: string }) {
  return (
    <div className="rounded-xl border bg-white/[0.03] px-3 py-2" style={{ borderColor: color }}>
      <small className="block text-[11px] text-slate-400">{t}</small>
      <b className="text-xl">
        {fmt(v, 0)} <em className="text-xs font-semibold not-italic text-slate-400">gal</em>
      </b>
      {pie && <i className="block text-[11px] not-italic text-slate-400">{pie}</i>}
    </div>
  );
}

function Selector({
  etiqueta,
  opciones,
  valor,
  onChange,
}: {
  etiqueta: string;
  opciones: { id: string; t: string }[];
  valor: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs uppercase tracking-[.14em] text-slate-400">{etiqueta}</span>
      <div className="inline-flex gap-0.5 rounded-xl border border-white/10 bg-white/5 p-0.5">
        {opciones.map((o) => (
          <button
            key={o.id}
            aria-pressed={valor === o.id}
            onClick={() => onChange(o.id)}
            className={`rounded-lg px-3.5 py-1.5 text-sm font-bold ${
              valor === o.id ? "bg-[#BADC1E] text-[#0D1719]" : "text-slate-400 hover:text-white"
            }`}
          >
            {o.t}
          </button>
        ))}
      </div>
    </div>
  );
}

export function DetalleTv({
  periodo,
  onPeriodo,
  comb,
  detalle,
}: {
  periodo: "24h" | "7d" | "30d";
  onPeriodo: (p: "24h" | "7d" | "30d") => void;
  comb: DatosCombustibleTv;
  detalle: DetalleDatos | null;
}) {
  const [tabla, setTabla] = useState(false);
  const porHora = periodo === "24h";
  const periodoTxt = { "24h": "últimas 24 h", "7d": "últimos 7 días", "30d": "últimos 30 días" }[
    periodo
  ];
  const c = comb.consumo;
  const tanquePct =
    comb.capacidad_gal > 0 ? Math.round((comb.total_gal / comb.capacidad_gal) * 100) : 0;
  const vsAnterior =
    c && detalle && detalle.consumo_anterior_gal > 0
      ? ((c.gal - detalle.consumo_anterior_gal) / detalle.consumo_anterior_gal) * 100
      : null;
  const serieComb: SerieLinea[] = c
    ? [
        {
          name: "Interno (grifo y tanquetas)",
          color: COLOR.interno,
          vals: c.serie.map((s) => s.interno_gal + s.tanqueta_gal),
        },
        { name: "Compra en ruta", color: COLOR.ruta, vals: c.serie.map((s) => s.ruta_gal) },
      ]
    : [];
  const u = detalle?.urea;
  const vsUrea = u && u.anterior_l > 0 ? ((u.total.l - u.anterior_l) / u.anterior_l) * 100 : null;
  const ratio = u && c && c.gal > 0 ? (u.total.l / (c.gal * 3.785411784)) * 100 : null;
  const serieUrea: SerieLinea[] = u
    ? [
        { name: "Almacén", color: COLOR.interno, vals: u.serie.map((s) => s.almacen_l) },
        { name: "Compra en ruta", color: COLOR.ruta, vals: u.serie.map((s) => s.ruta_l) },
      ]
    : [];

  return (
    <section className="flex flex-col gap-3" aria-label="Detalle para decidir">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <Selector
          etiqueta="Período"
          valor={periodo}
          onChange={(p) => onPeriodo(p as "24h" | "7d" | "30d")}
          opciones={[
            { id: "24h", t: "24 horas" },
            { id: "7d", t: "7 días" },
            { id: "30d", t: "30 días" },
          ]}
        />
        <Selector
          etiqueta="Ver como"
          valor={tabla ? "tabla" : "grafico"}
          onChange={(v) => setTabla(v === "tabla")}
          opciones={[
            { id: "grafico", t: "Gráfico" },
            { id: "tabla", t: "Tabla" },
          ]}
        />
      </div>

      {c && comb.entrada && (
        <div className={PANEL}>
          <h2 className="text-xs font-bold uppercase tracking-[.16em] text-slate-400">
            Cómo se mueve el combustible
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-[140px] flex-1">
              <Nodo
                t="Recibido de cisternas"
                v={comb.entrada.recibido_gal}
                pie={`${comb.entrada.recepciones} ${comb.entrada.recepciones === 1 ? "recepción" : "recepciones"}`}
                color={COLOR.interno}
              />
            </div>
            <span className="text-xl text-slate-400">→</span>
            <div className="min-w-[140px] flex-1">
              <Nodo
                t="Tanque del grifo"
                v={comb.total_gal}
                pie={`${tanquePct}% · saldo estimado`}
                color="#BADC1E"
              />
            </div>
            <span className="text-xl text-slate-400">→</span>
            <div className="flex min-w-[170px] flex-1 flex-col gap-1.5">
              <Nodo t="Salidas por vale" v={c.interno_gal} color={COLOR.interno} />
              <Nodo t="Tanquetas" v={c.tanqueta_gal} color={COLOR.interno} />
              <Nodo
                t="Compra en ruta"
                v={c.ruta_gal}
                pie="no pasa por el tanque"
                color={COLOR.ruta}
              />
            </div>
            <span className="text-xl text-slate-400">→</span>
            <div className="min-w-[140px] flex-1">
              <Nodo t="Consumo de las unidades" v={c.gal} pie={soles(c.costo)} color="#e2e8f0" />
            </div>
          </div>
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        {c && comb.entrada && (
          <div className={PANEL}>
            <h2 className="text-xs font-bold uppercase tracking-[.16em] text-slate-400">
              Combustible · {periodoTxt}
            </h2>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(125px,1fr))] gap-3">
              <Kpi
                t="Recepcionado"
                v={comb.entrada.recibido_gal}
                u="gal"
                pie={`${comb.entrada.recepciones} ${comb.entrada.recepciones === 1 ? "cisterna" : "cisternas"} · ${soles(comb.entrada.costo)}`}
              />
              <Kpi t="Grifo interno" v={c.interno_gal} u="gal" pie="Salidas por vale" />
              <Kpi t="Tanquetas" v={c.tanqueta_gal} u="gal" pie="Cargas en ruta desde tanqueta" />
              <Kpi
                t="Compra en ruta"
                v={c.ruta_gal}
                u="gal"
                pie={`${c.gal > 0 ? Math.round((c.ruta_gal / c.gal) * 100) : 0}% del consumo`}
              />
              <Kpi
                tot
                t="Consumo total"
                v={c.gal}
                u="gal"
                pie={`${soles(c.costo)}${vsAnterior !== null ? ` · ${vsAnterior >= 0 ? "▲" : "▼"} ${fmt(Math.abs(vsAnterior), 1)}% vs. período anterior` : ""}`}
              />
            </div>
            <Leyenda items={serieComb} />
            <GraficaLineas
              cortes={c.serie.map((s) => s.t)}
              porHora={porHora}
              series={serieComb}
              unidad="gal"
              tabla={tabla}
            />
          </div>
        )}
        {u && (
          <div className={PANEL}>
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-xs font-bold uppercase tracking-[.16em] text-slate-400">
                Urea · {periodoTxt}
              </h2>
              {ratio !== null && (
                <span className="text-xs text-slate-400">Urea / diésel: {fmt(ratio, 1)} %</span>
              )}
            </div>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(125px,1fr))] gap-3">
              <Kpi
                t="Entró al almacén"
                v={u.entro.l}
                u="L"
                pie={`${u.entro.entradas} ${u.entro.entradas === 1 ? "entrada" : "entradas"} · ${soles(u.entro.costo)}`}
              />
              <Kpi t="Almacén" v={u.total.almacen_l} u="L" pie="Salidas por vale" />
              <Kpi
                t="Compra en ruta"
                v={u.total.ruta_l}
                u="L"
                pie={`${u.total.l > 0 ? Math.round((u.total.ruta_l / u.total.l) * 100) : 0}% del consumo`}
              />
              <Kpi
                tot
                t="Consumo total"
                v={u.total.l}
                u="L"
                pie={`${soles(u.total.costo)}${vsUrea !== null ? ` · ${vsUrea >= 0 ? "▲" : "▼"} ${fmt(Math.abs(vsUrea), 1)}% vs. período anterior` : ""}`}
              />
            </div>
            <Leyenda items={serieUrea} />
            <GraficaLineas
              cortes={u.serie.map((s) => s.t)}
              porHora={porHora}
              series={serieUrea}
              unidad="L"
              tabla={tabla}
            />
          </div>
        )}
      </div>

      {detalle && (
        <>
          <div className={PANEL}>
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-xs font-bold uppercase tracking-[.16em] text-slate-400">
                Últimas recepciones de combustible
              </h2>
              <span className="text-xs text-slate-400">
                Tolerancia {fmt(detalle.recepciones[0]?.tolerancia_gal ?? 3, 0)} gal
              </span>
            </div>
            {detalle.recepciones.length === 0 ? (
              <p className="text-sm text-slate-400">Todavía no hay recepciones.</p>
            ) : (
              <div className="overflow-auto">
                <table className="w-full text-[13px] tabular-nums">
                  <thead className="text-[11px] uppercase text-slate-400">
                    <tr>
                      <th className="px-2 py-1.5 text-left">Fecha</th>
                      <th className="px-2 py-1.5 text-left">Proveedor</th>
                      <th className="px-2 py-1.5 text-left">Factura</th>
                      <th className="px-2 py-1.5 text-right">Facturado</th>
                      <th className="px-2 py-1.5 text-right">Recibido</th>
                      <th className="px-2 py-1.5 text-right">Diferencia</th>
                      <th className="px-2 py-1.5 text-right">Costo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detalle.recepciones.map((r) => {
                      const d = r.diferencia_gal;
                      const mal = d !== null && Math.abs(d) > r.tolerancia_gal;
                      return (
                        <tr key={r.id} className="border-t border-white/10">
                          <td className="px-2 py-1.5">
                            {new Date(r.recibido_en).toLocaleString("es-PE", {
                              dateStyle: "short",
                              timeStyle: "short",
                            })}
                          </td>
                          <td className="px-2 py-1.5">{r.proveedor ?? "—"}</td>
                          <td className="px-2 py-1.5">{r.factura ?? "—"}</td>
                          <td className="px-2 py-1.5 text-right">
                            {r.facturado_gal === null ? "—" : fmt(r.facturado_gal, 0)}
                          </td>
                          <td className="px-2 py-1.5 text-right">{fmt(r.recibido_gal, 0)}</td>
                          <td
                            className={`px-2 py-1.5 text-right ${mal ? "font-bold text-red-400" : ""}`}
                          >
                            {d === null
                              ? "—"
                              : `${signo(d)}${fmt(Math.abs(d), 0)}${mal ? " · revisar" : ""}`}
                          </td>
                          <td className="px-2 py-1.5 text-right">{soles(r.costo)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <h2 className="mt-1 text-xs font-bold uppercase tracking-[.2em] text-slate-400">
            Para decidir
          </h2>
          <div className="grid gap-3 lg:grid-cols-2">
            <div className={PANEL}>
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="text-xs font-bold uppercase tracking-[.16em] text-slate-400">
                  Unidades que más se desvían
                </h2>
                <span className="text-xs text-slate-400">
                  Contra las de su misma marca y modelo, y contra su pasado
                </span>
              </div>
              {detalle.desvios.length === 0 ? (
                <p className="text-sm text-slate-400">
                  Ninguna unidad con datos suficientes para comparar.
                </p>
              ) : (
                <div className="overflow-auto">
                  <table className="w-full text-[13px] tabular-nums">
                    <thead className="text-[11px] uppercase text-slate-400">
                      <tr>
                        <th className="px-2 py-1.5 text-left">Unidad</th>
                        <th className="px-2 py-1.5 text-left">Tipo</th>
                        <th className="px-2 py-1.5 text-right">Cargado (gal)</th>
                        <th className="px-2 py-1.5 text-right">Rendimiento</th>
                        <th className="px-2 py-1.5 text-right">vs. pares</th>
                        <th className="px-2 py-1.5 text-right">vs. su pasado</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detalle.desvios.map((d) => (
                        <tr key={d.equipo_id} className="border-t border-white/10">
                          <td className="px-2 py-1.5 font-bold">{d.placa}</td>
                          <td className="px-2 py-1.5">{d.tipo ?? "—"}</td>
                          <td className="px-2 py-1.5 text-right">{fmt(d.cargado_gal, 0)}</td>
                          <td className="px-2 py-1.5 text-right">
                            {d.rendimiento
                              ? `${fmt(d.rendimiento.valor, 1)} ${d.rendimiento.unidad}`
                              : "—"}
                          </td>
                          {[d.vs_pares_pct, d.vs_pasado_pct].map((p, i) => (
                            <td
                              key={i}
                              className={`px-2 py-1.5 text-right ${p !== null && p > 20 ? "font-bold text-red-400" : ""}`}
                            >
                              {p === null ? "—" : `${signo(p)}${fmt(Math.abs(p), 0)} %`}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className={PANEL}>
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="text-xs font-bold uppercase tracking-[.16em] text-slate-400">
                  Compra en ruta: cuánto cuesta
                </h2>
                {detalle.compra_ruta.precio_interno_gal !== null && (
                  <span className="text-xs text-slate-400">
                    Costo interno S/ {fmt(detalle.compra_ruta.precio_interno_gal, 2)}/gal
                  </span>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Kpi
                  t="Comprado en ruta"
                  v={detalle.compra_ruta.gal}
                  u="gal"
                  pie={`${detalle.compra_ruta.compras} ${detalle.compra_ruta.compras === 1 ? "compra" : "compras"} en el período`}
                />
                <div>
                  <small className="block text-xs text-slate-400">
                    Sobrecosto contra el grifo interno
                  </small>
                  <b className="block text-xl text-amber-400 tabular-nums">
                    {detalle.compra_ruta.sobrecosto === null
                      ? "—"
                      : soles(detalle.compra_ruta.sobrecosto)}
                  </b>
                  <i className="text-xs not-italic text-slate-400">
                    Lo pagado de más por no cargar en casa
                  </i>
                </div>
              </div>
              {detalle.compra_ruta.por_grifo.length > 0 && (
                <div className="overflow-auto">
                  <table className="w-full text-[13px] tabular-nums">
                    <thead className="text-[11px] uppercase text-slate-400">
                      <tr>
                        <th className="px-2 py-1.5 text-left">Grifo</th>
                        <th className="px-2 py-1.5 text-right">Galones</th>
                        <th className="px-2 py-1.5 text-right">Compras</th>
                        <th className="px-2 py-1.5 text-right">S/ por gal</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detalle.compra_ruta.por_grifo.map((g) => (
                        <tr key={g.grifo} className="border-t border-white/10">
                          <td className="px-2 py-1.5">{g.grifo}</td>
                          <td className="px-2 py-1.5 text-right">{fmt(g.gal, 0)}</td>
                          <td className="px-2 py-1.5 text-right">{g.compras}</td>
                          <td className="px-2 py-1.5 text-right">{fmt(g.precio_gal, 2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </>
      )}
      {!detalle && <p className="py-6 text-center text-slate-400">Cargando el detalle…</p>}
    </section>
  );
}
