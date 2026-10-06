// client/src/components/UreaAlmacen.tsx
//
// El almacén de urea a primera vista: la estantería de cajas (o el tablero) y
// las tarjetas de estado de al lado. Reemplaza a la barra horizontal de
// antes, que decía "porcentaje de algo" cuando la urea no es un nivel
// continuo sino cajas apiladas.
//
// Solo dibuja: todo sale de GET /urea/estado, no hay estado de negocio acá.
//
// Los colores de las cajas van en hex a propósito: el tema oscuro remapea la
// paleta de Tailwind, y el lima de la marca no debe cambiar de tono con el tema.

import { useEffect, useState } from "react";

export interface EstadoStockUrea {
  /** Puede ser NEGATIVO: los vales declaran más urea de la que las entradas
   *  explican. Se muestra con signo, no se tapa en 0 (ver el service). */
  stockL: number;
  stockMinimoL: number | null;
  stockMaximoL: number | null;
  referencia: { nombre: string; litros: number; bultos: number } | null;
  ultimoConteo: { contadoL: number; contadoEn: string; diferenciaL: number } | null;
  /** null = sin salidas en 30 días: no hay ritmo del que extrapolar. */
  consumoDiarioL: number | null;
  autonomiaDias: number | null;
  /** Compras en ruta del mes. No pasan por el almacén. */
  enRutaMes: { litros: number; compras: number; total: number };
}

interface EnvaseResumen {
  nombre: string;
  litros: string;
  activa: boolean;
}

type Nivel = "ok" | "bajo" | "alto" | "neg";

const fmt = (n: number, d = 1) => n.toLocaleString("es-PE", { maximumFractionDigits: d });
const fmtSoles = (n: number) =>
  `S/ ${n.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDiaMes = (iso: string) =>
  new Date(iso).toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit" });

const ETIQUETA_NIVEL: Record<Nivel, string> = {
  ok: "Normal",
  bajo: "Bajo el mínimo",
  alto: "Sobre el máximo",
  neg: "Negativo: faltan entradas",
};

const CLASE_NIVEL: Record<Nivel, string> = {
  ok: "text-emerald-700 bg-emerald-50",
  bajo: "text-red-700 bg-red-50",
  neg: "text-red-700 bg-red-50",
  alto: "text-amber-800 bg-amber-50",
};

function nivelDe(s: EstadoStockUrea): Nivel {
  if (s.stockL < 0) return "neg";
  if (s.stockMinimoL !== null && s.stockL < s.stockMinimoL) return "bajo";
  if (s.stockMaximoL !== null && s.stockL > s.stockMaximoL) return "alto";
  return "ok";
}

/** Más lugares que esto y la grilla deja de ser legible (y pesa en el DOM):
 *  se cae al tablero, que escala a cualquier tamaño. */
const MAX_LUGARES = 600;

/** "caja" -> "cajas", "balde" -> "baldes", "bidón" -> "bidones". */
function plural(nombre: string): string {
  const n = nombre.toLowerCase();
  if (/ón$/.test(n)) return n.replace(/ón$/, "ones");
  return /[aeiouáéíóú]$/.test(n) ? `${n}s` : `${n}es`;
}

interface EnvaseElegido {
  nombre: string;
  litros: number;
}

function useColumnas(): number {
  const calc = () => (typeof window !== "undefined" && window.innerWidth < 640 ? 10 : 20);
  const [cols, setCols] = useState(calc);
  useEffect(() => {
    const onResize = () => setCols(calc());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return cols;
}

// ── Estantería ──────────────────────────────────────────────────────────

function Estanteria({
  stock,
  nivel,
  envase,
}: {
  stock: EstadoStockUrea;
  nivel: Nivel;
  envase: EnvaseElegido;
}) {
  const cols = useColumnas();
  const litrosCaja = envase.litros;
  const unidades = plural(envase.nombre);
  const cajas = Math.max(stock.stockL, 0) / litrosCaja;
  const enteras = Math.floor(cajas);
  const frac = cajas - enteras;
  const maxCajas = stock.stockMaximoL !== null ? stock.stockMaximoL / litrosCaja : null;
  const minCajas = stock.stockMinimoL !== null ? stock.stockMinimoL / litrosCaja : null;

  const lugares = lugaresDe(stock, litrosCaja, cols);
  const filas = lugares / cols;
  const filaMinimo = minCajas !== null ? Math.round(minCajas / cols) : 0;
  const filaMaximo = maxCajas !== null ? Math.round(maxCajas / cols) : 0;
  const hayExcedente = maxCajas !== null && cajas > maxCajas;

  const colorCaja = (i: number) =>
    nivel === "bajo"
      ? "from-[#ff8f82] to-[#d65a4c] border-[#8a352c]"
      : maxCajas !== null && i >= maxCajas
        ? "from-[#f6c65c] to-[#c78f1f] border-[#7a5710]"
        : "from-[#4f8fdc] to-[#3a72b8] border-[#2f5f9c]";

  const filasJsx: React.ReactNode[] = [];
  for (let r = filas - 1; r >= 0; r--) {
    filasJsx.push(
      <div
        key={`f${r}`}
        className="grid gap-[3px]"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: cols }, (_, c) => {
          const i = r * cols + c;
          if (i < enteras) {
            return (
              <div
                key={i}
                className={`relative aspect-[1.3] overflow-hidden rounded-[3px] border bg-gradient-to-br ${colorCaja(i)}`}
              >
                <div className="absolute inset-y-0 left-[42%] w-[16%] bg-white/20" />
              </div>
            );
          }
          if (i === enteras && frac >= 0.1) {
            return (
              <div
                key={i}
                className="relative aspect-[1.3] overflow-hidden rounded-[3px] border border-slate-200 bg-slate-100"
                title="Envase abierto o con sobrante"
              >
                <div
                  className={`absolute inset-x-0 bottom-0 bg-gradient-to-br ${colorCaja(i)}`}
                  style={{ height: `${frac * 100}%` }}
                />
              </div>
            );
          }
          return (
            <div
              key={i}
              className="aspect-[1.3] rounded-[3px] border border-slate-200 bg-slate-100"
            />
          );
        })}
      </div>
    );
    // Las dos marcas, cada una del color de lo que avisa: el mínimo en rojo
    // (hay que comprar) y el máximo en ámbar, el mismo de los lugares que lo
    // pasan. Compartir el ámbar hacía que el mismo color significara dos cosas.
    if (maxCajas !== null && r === filaMaximo && filaMaximo > 0 && filaMaximo < filas) {
      filasJsx.push(
        <div key="max" className="relative z-10 flex h-0 items-center">
          <div className="flex-1 border-t-2 border-dashed border-amber-500" />
          <span className="absolute -top-2.5 right-0 rounded-full border border-amber-500 bg-white px-2 text-[11px] font-semibold text-amber-700">
            Máximo · {fmt(stock.stockMaximoL!, 0)} L · {fmt(maxCajas, 0)} {unidades}
          </span>
        </div>
      );
    }
    if (minCajas !== null && r === filaMinimo && filaMinimo > 0 && filaMinimo < filas) {
      filasJsx.push(
        <div key="min" className="relative z-10 flex h-0 items-center">
          <div className="flex-1 border-t-2 border-dashed border-red-500" />
          <span className="absolute -top-2.5 right-0 rounded-full border border-red-500 bg-white px-2 text-[11px] font-semibold text-red-700">
            Mínimo · {fmt(stock.stockMinimoL!, 0)} L · {fmt(minCajas, 0)} {unidades}
          </span>
        </div>
      );
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-between px-0.5 text-[11px] text-slate-500">
        <span>
          {maxCajas !== null
            ? `Máximo · ${fmt(stock.stockMaximoL!, 0)} L · ${fmt(maxCajas, 0)} ${unidades}`
            : "Máximo sin configurar"}
        </span>
        <span>{lugares} lugares</span>
      </div>
      <div
        className="flex flex-col gap-[3px] rounded-xl border border-slate-200 bg-slate-50 px-3 pt-3"
        role="img"
        aria-label={`Estantería con ${fmt(cajas, 1)} ${unidades} de urea`}
      >
        {filasJsx}
        <div className="-mx-3 mt-1.5 h-2.5 rounded-b-xl border-t border-slate-200 bg-slate-200" />
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
        <span className="flex items-center gap-1.5">
          <i className="inline-block h-2 w-2.5 rounded-sm bg-[#4f8fdc]" />
          {envase.nombre} de {fmt(litrosCaja, 0)} L
        </span>
        <span className="flex items-center gap-1.5">
          <i className="inline-block h-2 w-2.5 rounded-sm border border-slate-300 bg-slate-100" />
          Lugar libre
        </span>
        {hayExcedente && (
          <span className="flex items-center gap-1.5">
            <i className="inline-block h-2 w-2.5 rounded-sm bg-[#f6c65c]" />
            Pasa del máximo
          </span>
        )}
        {minCajas !== null && (
          <span className="flex items-center gap-1.5">
            <i className="inline-block w-3.5 border-t-2 border-dashed border-red-500" />
            Mínimo de aviso
          </span>
        )}
        <span>Un lugar parcial es un envase abierto o con sobrante.</span>
      </div>
    </div>
  );
}

/** Cuántos lugares dibuja la estantería: los que hacen falta para el máximo
 *  configurado Y para lo que haya (si hay más que el máximo, se ven pasados
 *  en ámbar en vez de esconderse). Sin máximo, el stock con un poco de aire. */
function lugaresDe(stock: EstadoStockUrea, litrosCaja: number, cols: number): number {
  const cajas = Math.max(stock.stockL, 0) / litrosCaja;
  const maxCajas = stock.stockMaximoL !== null ? stock.stockMaximoL / litrosCaja : cajas * 1.15;
  return Math.max(Math.ceil(Math.max(maxCajas, cajas, 1) / cols), 1) * cols;
}

// ── Tablero ─────────────────────────────────────────────────────────────

function Tablero({ stock, envases }: { stock: EstadoStockUrea; envases: EnvaseResumen[] }) {
  const { stockL, stockMinimoL, stockMaximoL } = stock;
  const escala = Math.max(stockMaximoL ?? 0, stockL, stockMinimoL ?? 0, 1) * 1.2;
  const cx = 150;
  const cy = 150;
  const R = 118;
  const ang = (v: number) => 180 - (Math.min(Math.max(v, 0), escala) / escala) * 180;
  const pt = (a: number, r: number): [number, number] => [
    cx + r * Math.cos((a * Math.PI) / 180),
    cy - r * Math.sin((a * Math.PI) / 180),
  ];
  const arco = (v0: number, v1: number, color: string) => {
    if (v1 <= v0) return null;
    const [x0, y0] = pt(ang(v0), R);
    const [x1, y1] = pt(ang(v1), R);
    return (
      <path
        d={`M${x0.toFixed(1)} ${y0.toFixed(1)} A${R} ${R} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`}
        stroke={color}
        strokeWidth={18}
        fill="none"
      />
    );
  };
  const [nx, ny] = pt(ang(stockL), R - 26);
  const minimo = stockMinimoL ?? 0;
  const maximo = stockMaximoL ?? escala;

  return (
    <div className="flex flex-col items-center gap-2.5 pt-2">
      <svg
        viewBox="-30 0 360 198"
        className="h-auto w-full max-w-[460px]"
        role="img"
        aria-label={`Medidor de stock: ${fmt(stockL, 0)} litros`}
      >
        {stockMinimoL === null && stockMaximoL === null
          ? arco(0, escala, "#94a3b8")
          : [
              arco(0, minimo, "#ff7a6b"),
              arco(minimo, maximo, "#3fd0a4"),
              arco(maximo, escala, "#f0b544"),
            ].map((a, i) => a && <g key={i}>{a}</g>)}
        <line
          x1={cx}
          y1={cy}
          x2={nx.toFixed(1)}
          y2={ny.toFixed(1)}
          stroke="currentColor"
          strokeWidth={3}
          strokeLinecap="round"
          className="text-slate-800"
        />
        <circle cx={cx} cy={cy} r={7} fill="currentColor" className="text-slate-800" />
        {stockMinimoL !== null && (
          <text
            x={pt(ang(stockMinimoL), R + 22)[0].toFixed(1)}
            y={pt(ang(stockMinimoL), R + 22)[1].toFixed(1)}
            fill="currentColor"
            fontSize={9}
            textAnchor={ang(stockMinimoL) > 90 ? "end" : "start"}
            className="text-slate-500"
          >
            Mín {fmt(stockMinimoL, 0)}
          </text>
        )}
        {stockMaximoL !== null && (
          <text
            x={pt(ang(stockMaximoL), R + 22)[0].toFixed(1)}
            y={pt(ang(stockMaximoL), R + 22)[1].toFixed(1)}
            fill="currentColor"
            fontSize={9}
            textAnchor={ang(stockMaximoL) > 90 ? "end" : "start"}
            className="text-slate-500"
          >
            Máx {fmt(stockMaximoL, 0)}
          </text>
        )}
        <text
          x={cx}
          y={188}
          fill="currentColor"
          fontSize={26}
          fontWeight={700}
          textAnchor="middle"
          className="text-slate-800"
        >
          {fmt(stockL, 0)} L
        </text>
      </svg>
      {envases.length > 0 && (
        <>
          <div className="flex flex-wrap justify-center gap-2">
            {envases.map((e) => (
              <div
                key={e.nombre}
                className="rounded-[10px] border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-500"
              >
                <strong className="mr-1 text-sm font-semibold text-slate-800">
                  {fmt(stockL / Number(e.litros), 1)}
                </strong>
                {plural(e.nombre)} de {fmt(Number(e.litros), 0)} L
              </div>
            ))}
          </div>
          <p className="text-xs text-slate-500">
            Son equivalencias del total en litros, no el conteo de cada envase.
          </p>
        </>
      )}
      <div className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-slate-500">
        <span className="flex items-center gap-1.5">
          <i className="inline-block h-2 w-2.5 rounded-sm bg-[#ff7a6b]" />
          Bajo el mínimo
        </span>
        <span className="flex items-center gap-1.5">
          <i className="inline-block h-2 w-2.5 rounded-sm bg-[#3fd0a4]" />
          Rango normal
        </span>
        <span className="flex items-center gap-1.5">
          <i className="inline-block h-2 w-2.5 rounded-sm bg-[#f0b544]" />
          Sobre el máximo
        </span>
      </div>
    </div>
  );
}

// ── La tarjeta del almacén ──────────────────────────────────────────────

export function AlmacenUrea({
  stock,
  envases,
}: {
  stock: EstadoStockUrea;
  envases: EnvaseResumen[];
}) {
  const cols = useColumnas();
  const nivel = nivelDe(stock);
  const { referencia } = stock;

  // La estantería necesita la unidad de referencia (la caja) para dibujar
  // "cajas", y un máximo razonable para no pintar miles de lugares. Sin eso,
  // el tablero en litros, que nunca está mal.
  const envase: EnvaseElegido | null =
    referencia && referencia.litros > 0
      ? { nombre: referencia.nombre, litros: referencia.litros }
      : null;
  const puedeEstanteria =
    envase !== null && stock.stockL >= 0 && lugaresDe(stock, envase.litros, cols) <= MAX_LUGARES;
  const [modo, setModo] = useState<"estanteria" | "tablero">("estanteria");
  const verEstanteria = puedeEstanteria && modo === "estanteria";

  return (
    <section
      className="flex min-w-0 flex-col gap-3.5 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm"
      aria-label="Almacén de urea"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.09em] text-slate-500">
            Almacén central · Green 32 (AdBlue)
          </div>
          <div className="flex flex-wrap items-baseline gap-x-3">
            <span
              className={`text-3xl font-bold tracking-tight sm:text-4xl ${
                nivel === "bajo" || nivel === "neg" ? "text-red-600" : "text-slate-800"
              }`}
            >
              {fmt(stock.stockL, 1)} L
            </span>
            {referencia && (
              <span className="text-sm text-slate-500">
                ≈ {fmt(referencia.bultos, 1)} {plural(referencia.nombre)} de{" "}
                {fmt(referencia.litros, 0)} L
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${CLASE_NIVEL[nivel]}`}
          >
            {ETIQUETA_NIVEL[nivel]}
          </span>
          {puedeEstanteria && (
            <div
              className="inline-flex gap-0.5 rounded-[10px] border border-slate-200 bg-slate-50 p-0.5"
              role="group"
              aria-label="Forma de ver el almacén"
            >
              {(["estanteria", "tablero"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={modo === m}
                  onClick={() => setModo(m)}
                  className={`rounded-lg px-3 py-1 text-xs font-medium ${
                    modo === m ? "bg-[#a3e635] text-black" : "text-slate-500 hover:text-white"
                  }`}
                >
                  {m === "estanteria" ? "Estantería" : "Tablero"}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* El stock negativo no se puede dibujar (no hay "menos que vacío") y
          forzarlo a 0 sería mentir justo en el caso que más importa. Se dice
          con palabras. */}
      {nivel === "neg" ? (
        <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          El stock de urea da <strong>negativo</strong>: los vales declaran más urea de la que las
          entradas registradas explican. O falta cargar una compra, o hay vales por más litros de
          los que realmente salieron.
        </div>
      ) : verEstanteria ? (
        <Estanteria stock={stock} nivel={nivel} envase={envase!} />
      ) : (
        <Tablero stock={stock} envases={envases} />
      )}

      {stock.stockMinimoL === null && stock.stockMaximoL === null && (
        <div className="text-xs text-slate-400">
          Sin umbrales configurados no se avisa nada: definilos en Configuración.
        </div>
      )}
      {nivel === "bajo" && (
        <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          Queda poca urea: faltan {fmt(stock.stockMinimoL! - stock.stockL, 1)} L para volver al
          mínimo. Conviene programar la compra.
        </div>
      )}
      {nivel === "alto" && (
        <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          Hay {fmt(stock.stockL - stock.stockMaximoL!, 1)} L más que el máximo definido para el
          depósito.
        </div>
      )}
    </section>
  );
}

// ── Las tarjetas de al lado ─────────────────────────────────────────────

function Dato({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-slate-200 pb-3 last:border-b-0 last:pb-0">
      <span className="text-[11px] font-semibold uppercase tracking-[0.09em] text-slate-500">
        {titulo}
      </span>
      {children}
    </div>
  );
}

export function ResumenUrea({ stock }: { stock: EstadoStockUrea }) {
  const { autonomiaDias, consumoDiarioL, ultimoConteo, enRutaMes, referencia } = stock;
  const enCajas = (l: number) =>
    referencia && referencia.litros > 0
      ? ` (${fmt(l / referencia.litros, 0)} ${plural(referencia.nombre)})`
      : "";
  const colorAutonomia =
    autonomiaDias === null
      ? "bg-slate-300"
      : autonomiaDias < 10
        ? "bg-red-500"
        : autonomiaDias < 20
          ? "bg-amber-500"
          : "bg-emerald-500";

  return (
    <aside className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <Dato titulo="Autonomía">
          {autonomiaDias === null ? (
            <>
              <span className="text-lg font-semibold text-slate-400">Sin dato</span>
              <span className="text-xs text-slate-500">
                {stock.stockL > 0
                  ? "No salió urea del almacén en los últimos 30 días: no hay ritmo para estimar."
                  : "No queda stock para estimar."}
              </span>
            </>
          ) : (
            <>
              <span className="text-[22px] font-bold tracking-tight text-slate-800">
                {fmt(autonomiaDias, 0)}
                <small className="ml-1 text-[13px] font-medium text-slate-500">días</small>
              </span>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100">
                <div
                  className={`h-full rounded-full ${colorAutonomia}`}
                  style={{ width: `${Math.min(100, (autonomiaDias / 40) * 100)}%` }}
                />
              </div>
              <span className="text-xs text-slate-500">
                Al ritmo de los últimos 30 días:{" "}
                <b className="font-semibold text-slate-800">
                  {fmt(consumoDiarioL ?? 0, 0)} L por día
                </b>{" "}
                salen del almacén.
              </span>
            </>
          )}
        </Dato>

        <Dato titulo="Último conteo físico">
          {ultimoConteo ? (
            <>
              <span className="text-[22px] font-bold tracking-tight text-slate-800">
                {fmt(ultimoConteo.contadoL, 1)} L
                <small className="ml-1 text-[13px] font-medium text-slate-500">
                  {fmtDiaMes(ultimoConteo.contadoEn)}
                </small>
              </span>
              <span className="text-xs text-slate-500">
                {ultimoConteo.diferenciaL === 0 ? (
                  "Cuadró con los papeles."
                ) : (
                  <>
                    Diferencia contra los papeles:{" "}
                    <b className="font-semibold text-red-600">
                      {ultimoConteo.diferenciaL > 0 ? "+" : ""}
                      {fmt(ultimoConteo.diferenciaL, 1)} L
                    </b>
                    . El conteo no ajusta el stock.
                  </>
                )}
              </span>
            </>
          ) : (
            <span className="text-sm text-slate-400">Todavía no hay ningún conteo físico.</span>
          )}
        </Dato>

        <Dato titulo="Umbrales">
          <span className="text-xs text-slate-500">
            Mínimo{" "}
            {stock.stockMinimoL === null ? (
              <span className="text-slate-400">sin configurar</span>
            ) : (
              <b className="font-semibold text-slate-800">
                {fmt(stock.stockMinimoL, 0)} L{enCajas(stock.stockMinimoL)}
              </b>
            )}{" "}
            · Máximo{" "}
            {stock.stockMaximoL === null ? (
              <span className="text-slate-400">sin configurar</span>
            ) : (
              <b className="font-semibold text-slate-800">
                {fmt(stock.stockMaximoL, 0)} L{enCajas(stock.stockMaximoL)}
              </b>
            )}
          </span>
          <span className="text-xs text-slate-500">Avisan, no bloquean ningún registro.</span>
        </Dato>
      </div>

      <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <Dato titulo="En ruta este mes">
          <span className="text-[22px] font-bold tracking-tight text-slate-800">
            {fmt(enRutaMes.litros, 0)} L
            <small className="ml-1 text-[13px] font-medium text-slate-500">
              en {enRutaMes.compras} {enRutaMes.compras === 1 ? "compra" : "compras"} ·{" "}
              {fmtSoles(enRutaMes.total)}
            </small>
          </span>
          <span className="text-xs text-slate-500">
            No pasan por el almacén: cuentan para el tope y el ratio de cada unidad.
          </span>
        </Dato>
      </div>
    </aside>
  );
}
