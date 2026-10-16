// client/src/components/UreaAlmacen.tsx
//
// El almacén de urea a primera vista, EN FÍSICO: cuántas cajas, cuántas
// bolsas, cuántos baldes hay, cada envase en su estantería. Los litros son la
// suma de lo que cada movimiento registró -- nunca una división.
//
// Reemplaza al velocímetro y a las "equivalencias" (408 L ÷ 4 = "102 bolsas"):
// eran bolsas que nadie compró. El total contra mínimo y máximo vive en una
// sola barra, que además dice de qué envases está hecho.
//
// Solo dibuja: todo sale de GET /urea/estado (y del kardex para el detalle de
// un envase). Los colores del dibujo van en hex a propósito: el tema oscuro
// remapea la paleta de Tailwind y una caja de cartón no cambia de color.

import { useEffect, useId, useState } from "react";

import VentanaFlotante from "./comunes/VentanaFlotante";
import { apiFetch } from "../services/apiClient";
import "../styles/vidrio-urea.css";

/** Un envase del almacén, contado (ver findStockUreaPorEnvase). */
export interface EnvaseStock {
  /** El id en el catálogo: con él se pide la corrección de litros. */
  presentacionId: number | null;
  codigo: string | null;
  nombre: string;
  /** Litros por bulto del catálogo, hoy. */
  litrosPorBulto: number | null;
  activa: boolean;
  /** El envase principal: el que se abre grande y viene elegido en los formularios. */
  principal: boolean;
  /** Con signo: negativo = salieron más de las que entraron. */
  unidades: number;
  /** Suma de los litros que registró cada movimiento. */
  litros: number;
  entraronMes: number;
  salieronMes: number;
  /** Litros por bulto con los que se registró stock y que no son los del
   *  catálogo: el envase quedó con tamaños mezclados. */
  litrosRegistradosDistintos: number[];
  /** Lo que dio el último conteo para este envase, contra lo que los papeles
   *  esperaban ese día. null = ese conteo no tiene detalle por envase. */
  ultimoConteo?: {
    contadoEn: string;
    contadas: number;
    esperadas: number;
    diferencia: number;
    /** Litros sueltos de ese conteo: una caja abierta cuenta ahí, no acá. */
    sueltoL?: number | null;
  } | null;
}

export interface EstadoStockUrea {
  /** Puede ser NEGATIVO: los vales declaran más urea de la que las entradas
   *  explican. Se muestra con signo, no se tapa en 0 (ver el service). Es la
   *  suma de `envases[].litros`. */
  stockL: number;
  stockMinimoL: number | null;
  stockMaximoL: number | null;
  envases: EnvaseStock[];
  ultimoConteo: {
    contadoL: number;
    contadoEn: string;
    diferenciaL: number;
    /** 0132: litros fuera de un envase entero, ya sumados en contadoL. */
    sueltoL?: number | null;
  } | null;
  /** null = sin salidas en 30 días: no hay ritmo del que extrapolar. */
  consumoDiarioL: number | null;
  autonomiaDias: number | null;
  /** Compras en ruta del mes. No pasan por el almacén. */
  enRutaMes: { litros: number; compras: number; total: number };
}

type Nivel = "ok" | "bajo" | "alto" | "neg";
type TipoEnvase = "caja" | "bolsa" | "balde" | "bidon";

const fmt = (n: number, d = 1) => n.toLocaleString("es-PE", { maximumFractionDigits: d });
const fmtSoles = (n: number) =>
  `S/ ${n.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDiaMes = (iso: string) =>
  new Date(iso).toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit" });
const fmtFechaHora = (iso: string) =>
  new Date(iso).toLocaleString("es-PE", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

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

/** Un color por envase, en el orden en que llegan (el principal primero). */
const COLORES = ["#4f8fdc", "#2dd4bf", "#a78bfa", "#f472b6", "#facc15", "#fb923c"];

/** Cuántos se dibujan uno por uno. Más que esto, el número exacto sigue
 *  arriba y el resto se ve en la ventana ampliada. */
const MAX_EN_TARJETA = 96;
const MAX_EN_VENTANA = 600;

function nivelDe(s: EstadoStockUrea): Nivel {
  if (s.stockL < 0) return "neg";
  if (s.stockMinimoL !== null && s.stockL < s.stockMinimoL) return "bajo";
  if (s.stockMaximoL !== null && s.stockL > s.stockMaximoL) return "alto";
  return "ok";
}

/** "caja" -> "cajas", "bidón" -> "bidones"; singular si es uno. Solo se
 *  pluraliza la primera palabra: "Caja 20 L" es "cajas 20 L", no "caja 20 les". */
function plural(nombre: string, n = 2): string {
  const [primera, ...resto] = nombre.trim().toLowerCase().split(/\s+/);
  let palabra = primera;
  if (Math.abs(n) !== 1) {
    if (/ón$/.test(primera)) palabra = primera.replace(/ón$/, "ones");
    else palabra = /[aeiouáéíóú]$/.test(primera) ? `${primera}s` : `${primera}es`;
  }
  return [palabra, ...resto].join(" ");
}

/** Qué dibujo le toca a un envase. El catálogo es libre (0116), así que se
 *  reconoce por el nombre; lo que no se reconoce se dibuja como caja. */
function tipoDeEnvase(e: Pick<EnvaseStock, "codigo" | "nombre">): TipoEnvase {
  const t = `${e.codigo ?? ""} ${e.nombre}`.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (/bols|doypack|sach|saco/.test(t)) return "bolsa";
  if (/[bv]ald|cubet/.test(t)) return "balde";
  if (/bidon|galon|garraf|cilindr|tambor|ibc/.test(t)) return "bidon";
  return "caja";
}

const POR_FILA: Record<TipoEnvase, { tarjeta: number; ventana: number }> = {
  caja: { tarjeta: 8, ventana: 12 },
  bolsa: { tarjeta: 12, ventana: 16 },
  balde: { tarjeta: 8, ventana: 12 },
  bidon: { tarjeta: 8, ventana: 12 },
};

// ── El dibujo de cada envase, con su líquido adentro ────────────────────

/** Un envase cerrado, lleno. viewBox de 48: cada forma deja una "ventana"
 *  donde se ve el líquido (en la caja, un corte del cartón). */
function IconoEnvase({ tipo }: { tipo: TipoEnvase }) {
  const id = useId().replace(/:/g, "");
  const liq = `url(#liq-${id})`;
  return (
    <svg viewBox="0 0 48 48" className="block h-auto w-full" aria-hidden="true">
      <defs>
        <linearGradient id={`liq-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#cfe6f2" />
        </linearGradient>
      </defs>
      {tipo === "caja" && (
        <>
          <path d="M7 15 L12 8 H36 L41 15 Z" fill="#d9ab74" />
          <rect x="7" y="15" width="34" height="27" rx="2.5" fill="#b98a55" stroke="#8a6238" />
          <rect x="11" y="19" width="26" height="19" rx="3" fill="#0b2f43" />
          <rect x="11" y="20" width="26" height="18" rx="3" fill={liq} />
          <rect x="11" y="20" width="26" height="1.4" fill="#ffffff" />
          <rect x="7" y="38.5" width="34" height="3.5" fill="#3fae49" />
        </>
      )}
      {tipo === "bolsa" && (
        <>
          <rect x="21" y="5" width="6" height="6" rx="1" fill="#e5e7eb" />
          <path
            d="M12 10 H36 L39 14 V40 Q39 43 36 43 H12 Q9 43 9 40 V14 Z"
            fill="#2f7d3b"
            stroke="#1f5a2a"
          />
          <rect x="12" y="10" width="24" height="3" fill="#1f5a2a" />
          <rect x="14" y="17" width="20" height="21" rx="4" fill="#0b2f43" />
          <rect x="14" y="18" width="20" height="20" rx="4" fill={liq} />
          <rect x="14" y="18" width="20" height="1.4" fill="#ffffff" />
          <rect x="11" y="14" width="2" height="26" fill="#ffffff" opacity="0.14" />
        </>
      )}
      {tipo === "balde" && (
        <>
          <path d="M12 11 Q24 1 36 11" fill="none" stroke="#9ca3af" strokeWidth="1.6" />
          <path d="M9 16 H39 L36 43 H12 Z" fill="#1f2937" stroke="#0b1220" />
          <rect x="7" y="11" width="34" height="6" rx="3" fill="#374151" />
          <rect x="14" y="22" width="20" height="16" rx="3" fill="#0b2f43" />
          <rect x="14" y="23" width="20" height="15" rx="3" fill={liq} />
          <rect x="14" y="23" width="20" height="1.4" fill="#ffffff" />
          <rect x="12.6" y="39.5" width="22.8" height="3" fill="#3fae49" />
        </>
      )}
      {tipo === "bidon" && (
        <>
          <rect x="19" y="5" width="10" height="4" rx="1" fill="#2563eb" />
          <rect x="19" y="9" width="10" height="5" fill="#e8f1f5" />
          <path
            d="M34 18 Q43 18 43 26 Q43 33 37 33"
            fill="none"
            stroke="#9fb6c1"
            strokeWidth="1.6"
          />
          <path
            d="M14 14 H34 Q39 14 39 19 V39 Q39 43 35 43 H13 Q9 43 9 39 V19 Q9 14 14 14 Z"
            fill="#e8f1f5"
            fillOpacity="0.92"
            stroke="#9fb6c1"
          />
          <rect x="11.5" y="19" width="25" height="22" rx="3" fill={liq} stroke="#9fb6c1" />
          <rect x="11.5" y="19" width="25" height="1.4" fill="#ffffff" />
          <rect x="15" y="26" width="18" height="8" rx="1.5" fill="#3fae49" />
        </>
      )}
    </svg>
  );
}

/** Las unidades sobre repisas, en filas. Solo lo que hay: sin lugares
 *  vacíos, así 200 bolsas no ocupan media pantalla en lugares que no existen. */
function Estanteria({
  envase,
  porFila,
  maximo,
}: {
  envase: EnvaseStock;
  porFila: number;
  maximo: number;
}) {
  const tipo = tipoDeEnvase(envase);
  const dibujadas = Math.min(Math.max(envase.unidades, 0), maximo);
  const filas: number[] = [];
  for (let k = 0; k < dibujadas; k += porFila) filas.push(Math.min(porFila, dibujadas - k));

  if (envase.unidades <= 0) {
    return (
      <div
        className={`rounded-xl border border-dashed p-6 text-center text-sm ${
          envase.unidades < 0 ? "border-red-300 text-red-700" : "border-slate-300 text-slate-500"
        }`}
      >
        {envase.unidades < 0 ? (
          <>
            Salieron <strong>{fmt(-envase.unidades, 0)}</strong> {plural(envase.nombre)} más de las
            que entraron: o falta registrar una entrada, o hay vales por más de lo que salió.
          </>
        ) : (
          <>Sin stock. Aparece aquí al registrar una entrada de este envase.</>
        )}
      </div>
    );
  }

  return (
    <div
      className="vidrio-urea rounded-xl px-3.5 pb-3.5 pt-1"
      role="img"
      aria-label={`${fmt(envase.unidades, 0)} ${plural(envase.nombre, envase.unidades)} en la estantería`}
    >
      {filas.map((n, i) => (
        <div
          key={i}
          className="grid gap-2 border-b-[7px] border-[#4d5f66] pb-1.5 pt-3.5 shadow-[0_9px_9px_-7px_rgba(0,0,0,0.6)]"
          style={{ gridTemplateColumns: `repeat(${porFila}, minmax(0, 1fr))` }}
        >
          {Array.from({ length: n }, (_, j) => (
            <IconoEnvase key={j} tipo={tipo} />
          ))}
        </div>
      ))}
      {envase.unidades > dibujadas && (
        <div className="pt-3 text-center text-xs text-slate-400">
          + {fmt(envase.unidades - dibujadas, 0)} {plural(envase.nombre)} más
        </div>
      )}
    </div>
  );
}

/** El envase quedó con tamaños mezclados (se registró a 16 L y el catálogo
 *  dice 20 L): los litros mostrados son los registrados, y hay que decirlo. */
function AvisoTamanosMezclados({
  envase,
  onCorregir,
}: {
  envase: EnvaseStock;
  /** Solo con el check `urea:corregir_litros`. */
  onCorregir: (() => void) | null;
}) {
  if (envase.litrosRegistradosDistintos.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
      <span>
        Parte de estas {plural(envase.nombre)} se registró con{" "}
        <strong>
          {envase.litrosRegistradosDistintos.map((l) => `${fmt(l, 2)} L`).join(" y ")}
        </strong>{" "}
        por bulto, y el catálogo dice <strong>{fmt(envase.litrosPorBulto ?? 0, 2)} L</strong>. Los
        litros mostrados son los registrados. Si fue un error al darlo de alta, se corrige con
        &quot;Corregir litros&quot;, que recalcula todo su historial con motivo.
      </span>
      {onCorregir && (
        <button
          type="button"
          onClick={onCorregir}
          className="self-start rounded-xl border border-[#65a30d] bg-[#a3e635] px-3 py-1.5 text-xs font-semibold text-black hover:bg-[#bef264]"
        >
          Corregir litros
        </button>
      )}
    </div>
  );
}

// ── Corregir los litros de un envase con historial (0130) ───────────────

interface ResumenCorreccion {
  envase: { codigo: string; nombre: string };
  litrosCatalogoAntes: number;
  litrosDespues: number;
  litrosRegistrados: number[];
  stockAlmacenL: { antes: number; despues: number };
  envaseL: { unidades: number; antes: number; despues: number };
  filas: { entradas: number; vales: number; comprasEnRuta: number; conteos: number };
  valesRecosteados: number;
  conteosSinDetalle: number;
  avisos: string[];
}

/** Dos pasos a propósito: primero se VE el impacto (sin escribir nada), y
 *  recién después se aplica, con motivo. Reescribe el historial del envase:
 *  nadie debería hacerlo sin ver antes cuánto stock aparece o desaparece. */
export function ModalCorregirLitros({
  presentacionId,
  nombre,
  litrosRegistrados,
  onCerrar,
  onCorregido,
}: {
  presentacionId: number;
  nombre: string;
  litrosRegistrados: number[];
  onCerrar: () => void;
  onCorregido: () => void;
}) {
  const [litros, setLitros] = useState("");
  const [motivo, setMotivo] = useState("");
  const [resumen, setResumen] = useState<ResumenCorreccion | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valor = Number(litros);
  const valido = litros.trim() !== "" && Number.isFinite(valor) && valor > 0 && valor <= 2000;

  const pedir = async (aplicar: boolean) => {
    setEnviando(true);
    setError(null);
    try {
      const res = await apiFetch(
        `/api/erp/combustible/urea/presentaciones/${presentacionId}/correccion${aplicar ? "" : "/vista-previa"}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ litros: valor, ...(aplicar ? { motivo: motivo.trim() } : {}) }),
        }
      );
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error ?? "No se pudo calcular la corrección.");
        return;
      }
      if (aplicar) onCorregido();
      else setResumen(body as ResumenCorreccion);
    } finally {
      setEnviando(false);
    }
  };

  const cambio = (a: number, b: number) => (
    <>
      <strong>{fmt(a, 2)} L</strong> → <strong>{fmt(b, 2)} L</strong>
    </>
  );

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-label={`Corregir litros de ${nombre}`}
    >
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col gap-4 overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl">
        <h3 className="text-lg font-bold text-slate-800">
          Corregir litros de &quot;{nombre}&quot;
        </h3>
        <p className="text-sm text-slate-600">
          Hoy está registrado con{" "}
          <strong>{litrosRegistrados.map((l) => `${fmt(l, 2)} L`).join(" y ")}</strong> por bulto.
          La corrección recalcula <strong>todo su historial</strong>: entradas, vales, compras en
          ruta y conteos. El precio por bulto se conserva, cada valor anterior queda guardado, y
          gerencia recibe el aviso.
        </p>
        {error && <div className="rounded bg-red-50 p-2 text-sm text-red-600">{error}</div>}

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-gray-600">Litros reales por bulto</span>
          <input
            type="number"
            step="0.01"
            min={0}
            value={litros}
            onChange={(e) => {
              setLitros(e.target.value);
              setResumen(null);
            }}
            className="rounded border border-gray-300 px-3 py-2"
          />
        </label>

        {!resumen ? (
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onCerrar}
              className="rounded-xl px-4 py-2 text-sm text-slate-600 hover:bg-slate-50"
            >
              Cancelar
            </button>
            <button
              type="button"
              disabled={!valido || enviando}
              onClick={() => pedir(false)}
              className="rounded-xl border border-[#65a30d] bg-[#a3e635] px-4 py-2 text-sm font-semibold text-black hover:bg-[#bef264] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {enviando ? "Calculando…" : "Ver impacto"}
            </button>
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-1.5 rounded-xl border border-slate-200 p-3 text-sm text-slate-700">
              <span>
                Stock del almacén:{" "}
                {cambio(resumen.stockAlmacenL.antes, resumen.stockAlmacenL.despues)}
              </span>
              <span>
                {resumen.envaseL.unidades} {plural(nombre, resumen.envaseL.unidades)}:{" "}
                {cambio(resumen.envaseL.antes, resumen.envaseL.despues)}
              </span>
              <span>
                Se corrigen {resumen.filas.entradas} entradas, {resumen.filas.vales} vales,{" "}
                {resumen.filas.comprasEnRuta} renglones de compra en ruta y {resumen.filas.conteos}{" "}
                renglones de conteo.
              </span>
              {resumen.valesRecosteados > 0 && (
                <span>
                  Cambia el costo de {resumen.valesRecosteados}{" "}
                  {resumen.valesRecosteados === 1 ? "vale" : "vales"} (el promedio de las entradas
                  se mueve).
                </span>
              )}
            </div>
            {resumen.avisos.map((a) => (
              <div
                key={a}
                className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800"
              >
                {a}
              </div>
            ))}
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-gray-600">Motivo</span>
              <input
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                placeholder="Las cajas siempre fueron de 20 L; se dieron de alta con 16"
                className="rounded border border-gray-300 px-3 py-2"
              />
              <span className="text-xs text-slate-500">Queda en la bitácora con tu nombre.</span>
            </label>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onCerrar}
                className="rounded-xl px-4 py-2 text-sm text-slate-600 hover:bg-slate-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={!motivo.trim() || enviando}
                onClick={() => pedir(true)}
                className="rounded-xl border border-[#65a30d] bg-[#a3e635] px-4 py-2 text-sm font-semibold text-black hover:bg-[#bef264] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {enviando ? "Aplicando…" : "Aplicar corrección"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** "Cajas de 20 L". Si el nombre ya trae los litros ("Caja 20 L"), no se
 *  repiten: "Cajas 20 L de 20 L" no dice nada nuevo. */
function TituloEnvase(e: EnvaseStock) {
  const p = plural(e.nombre);
  const nombre = p.charAt(0).toUpperCase() + p.slice(1);
  const yaLoDice = /\d\s*(l|lt|lts|litros?)\b/i.test(e.nombre);
  return e.litrosPorBulto !== null && !yaLoDice
    ? `${nombre} de ${fmt(e.litrosPorBulto, 2)} L`
    : nombre;
}

/** "Este mes: +20 entraron · 3 salieron" -- sin "+0" ni "−0". */
function MovidoEsteMes({ envase }: { envase: EnvaseStock }) {
  return (
    <span className="text-xs text-slate-500">
      Este mes: {envase.entraronMes > 0 ? "+" : ""}
      {fmt(envase.entraronMes, 0)} {envase.entraronMes === 1 ? "entró" : "entraron"} ·{" "}
      {envase.salieronMes > 0 ? "−" : ""}
      {fmt(envase.salieronMes, 0)} {envase.salieronMes === 1 ? "salió" : "salieron"}
    </span>
  );
}

/** "Último conteo (14 oct): 9 de 10 — falta 1". El conteo no ajusta el
 *  stock: esto dice si la última vez que se fue a contar, este envase cuadró. */
function ConteoDelEnvase({ envase }: { envase: EnvaseStock }) {
  const c = envase.ultimoConteo;
  if (!c) return null;
  const n = Math.abs(c.diferencia);
  return (
    <span className="block text-xs text-slate-500">
      Último conteo ({fmtDiaMes(c.contadoEn)}): {fmt(c.contadas, 0)} de {fmt(c.esperadas, 0)}{" "}
      esperadas
      {c.diferencia === 0 ? (
        " — cuadró."
      ) : (
        <b className="font-semibold text-red-600">
          {" "}
          — {c.diferencia < 0 ? (n === 1 ? "falta" : "faltan") : n === 1 ? "sobra" : "sobran"}{" "}
          {fmt(n, 0)}
        </b>
      )}
      {c.diferencia < 0 && (c.sueltoL ?? 0) > 0 && (
        <> · ese conteo anotó {fmt(c.sueltoL!, 1)} L sueltos (puede ser un envase abierto)</>
      )}
    </span>
  );
}

// ── La barra del total: nivel contra mínimo y máximo, y de qué está hecho ──

function BarraNivel({ stock, colores }: { stock: EstadoStockUrea; colores: string[] }) {
  const { stockMinimoL: min, stockMaximoL: max } = stock;
  const positivos = stock.envases.filter((e) => e.litros > 0);
  const totalPositivo = positivos.reduce((a, e) => a + e.litros, 0);
  const escala = Math.max(
    max !== null ? max : Math.max(totalPositivo, min ?? 0) * 1.25,
    totalPositivo,
    min ?? 0,
    1
  );
  const pct = (l: number) => `${Math.min(100, (l / escala) * 100)}%`;

  // Dónde arranca cada segmento: la suma de los anteriores.
  const inicios = positivos.map((_, i) => positivos.slice(0, i).reduce((a, e) => a + e.litros, 0));
  return (
    <div className="flex flex-col gap-2">
      <div className="relative h-4 overflow-hidden rounded-full border border-slate-200 bg-slate-100">
        {/* Las zonas de fondo: la lectura "estoy bien o mal" del velocímetro. */}
        {min !== null && (
          <div
            className="absolute inset-y-0 left-0 bg-[#f87171] opacity-25"
            style={{ width: pct(min) }}
          />
        )}
        {max !== null && (
          <div
            className="absolute inset-y-0 bg-[#34d399] opacity-20"
            style={{ left: pct(min ?? 0), width: `calc(${pct(max)} - ${pct(min ?? 0)})` }}
          />
        )}
        {positivos.map((e, i) => {
          const izq = inicios[i];
          return (
            <div
              key={e.codigo ?? "sin-envase"}
              className="absolute inset-y-0"
              style={{
                left: pct(izq),
                width: pct(e.litros),
                background: colores[stock.envases.indexOf(e)],
              }}
              title={`${e.nombre}: ${fmt(e.litros, 1)} L`}
            />
          );
        })}
        {min !== null && (
          <div className="absolute inset-y-0 w-0.5 bg-[#ef4444]" style={{ left: pct(min) }} />
        )}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
        {positivos.map((e) => (
          <span key={e.codigo ?? "sin-envase"} className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-2.5 rounded-sm"
              style={{ background: colores[stock.envases.indexOf(e)] }}
            />
            {e.nombre} {fmt(e.litros, 1)} L
          </span>
        ))}
        {min !== null && (
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-0.5 bg-[#ef4444]" />
            Mínimo {fmt(min, 0)} L
          </span>
        )}
        {max !== null && <span>Máximo {fmt(max, 0)} L</span>}
      </div>
    </div>
  );
}

// ── La tarjeta del almacén ──────────────────────────────────────────────

export function AlmacenUrea({
  stock,
  puedeVerKardex,
  puedeCorregirLitros,
  onCorregido,
}: {
  stock: EstadoStockUrea;
  puedeVerKardex: boolean;
  /** El check `urea:corregir_litros`, que nace apagado para todos. */
  puedeCorregirLitros: boolean;
  onCorregido: () => void;
}) {
  const [corrigiendo, setCorrigiendo] = useState<EnvaseStock | null>(null);
  const corregir = (e: EnvaseStock) =>
    puedeCorregirLitros && e.presentacionId !== null ? () => setCorrigiendo(e) : null;
  const nivel = nivelDe(stock);
  const colores = stock.envases.map((_, i) => COLORES[i % COLORES.length]);
  const porDefecto = stock.envases.find((e) => e.principal) ?? stock.envases[0] ?? null;
  const [elegido, setElegido] = useState<string | null>(porDefecto?.codigo ?? null);
  const [ampliado, setAmpliado] = useState(false);

  const grande =
    stock.envases.find((e) => e.codigo === elegido) ?? porDefecto ?? stock.envases[0] ?? null;
  const pequenos = stock.envases.filter((e) => e !== grande);

  return (
    <section
      className="flex min-w-0 flex-col gap-4 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm"
      aria-label="Almacén de urea"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.09em] text-slate-500">
            Almacén central · Green 32 (AdBlue)
          </div>
          <span
            className={`text-3xl font-bold tracking-tight sm:text-4xl ${
              nivel === "bajo" || nivel === "neg" ? "text-red-600" : "text-slate-800"
            }`}
          >
            {fmt(stock.stockL, 1)} L
          </span>
        </div>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${CLASE_NIVEL[nivel]}`}>
          {ETIQUETA_NIVEL[nivel]}
        </span>
      </div>

      <BarraNivel stock={stock} colores={colores} />

      {stock.stockMinimoL === null && stock.stockMaximoL === null && (
        <div className="text-xs text-slate-400">
          Sin umbrales configurados no se avisa nada: defínelos en Configuración.
        </div>
      )}
      {nivel === "neg" && (
        <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          El stock de urea da <strong>negativo</strong>: los vales declaran más urea de la que las
          entradas registradas explican. O falta cargar una compra, o hay vales por más de lo que
          realmente salió.
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

      {grande === null ? (
        <div className="text-sm text-slate-500">
          No hay envases dados de alta. Agrégalos en Configuración → Envases.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          {/* El envase en grande: su estantería. */}
          <div className="flex min-w-0 flex-col gap-3 rounded-2xl border border-slate-200 p-4">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.09em] text-slate-500">
                  {TituloEnvase(grande)}
                </div>
                <div
                  className={`text-2xl font-bold ${grande.unidades < 0 ? "text-red-600" : "text-slate-800"}`}
                >
                  {fmt(grande.unidades, 0)} {plural(grande.nombre, grande.unidades)}
                </div>
              </div>
              <div className="text-lg font-semibold text-slate-500">{fmt(grande.litros, 1)} L</div>
            </div>
            <Estanteria
              envase={grande}
              porFila={POR_FILA[tipoDeEnvase(grande)].tarjeta}
              maximo={MAX_EN_TARJETA}
            />
            <AvisoTamanosMezclados envase={grande} onCorregir={corregir(grande)} />
            <ConteoDelEnvase envase={grande} />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <MovidoEsteMes envase={grande} />
              <button
                type="button"
                onClick={() => setAmpliado(true)}
                className="inline-flex items-center gap-2 rounded-xl border border-[#65a30d] bg-[#a3e635] px-3.5 py-1.5 text-sm font-semibold text-black hover:bg-[#bef264]"
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M4 9V4h5M20 15v5h-5M4 4l6 6M20 20l-6-6" />
                </svg>
                Ampliar
              </button>
            </div>
          </div>

          {/* Los otros, chicos pero con lo esencial: unidades y litros. */}
          {pequenos.length > 0 && (
            <div className="flex min-w-0 flex-col gap-3">
              {pequenos.map((e) => (
                <button
                  key={e.codigo ?? "sin-envase"}
                  type="button"
                  onClick={() => setElegido(e.codigo)}
                  className="flex items-center gap-3 rounded-2xl border border-slate-200 p-3 text-left hover:border-[#a3e635] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#a3e635]"
                >
                  <span className="w-11 shrink-0">
                    <IconoEnvase tipo={tipoDeEnvase(e)} />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[11px] font-semibold uppercase tracking-[0.09em] text-slate-500">
                      {TituloEnvase(e)}
                    </span>
                    <span
                      className={`text-lg font-bold ${e.unidades < 0 ? "text-red-600" : "text-slate-800"}`}
                    >
                      {fmt(e.unidades, 0)} {plural(e.nombre, e.unidades)}
                    </span>
                    <span className="text-xs text-slate-500">{fmt(e.litros, 1)} L</span>
                    <span className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100">
                      <span
                        className="block h-full rounded-full"
                        style={{
                          width: `${stock.stockL > 0 ? Math.max(0, Math.min(100, (e.litros / stock.stockL) * 100)) : 0}%`,
                          background: colores[stock.envases.indexOf(e)],
                        }}
                      />
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {ampliado && grande && (
        <VentanaFlotante
          id="urea-envase-detalle"
          titulo={TituloEnvase(grande)}
          subtitulo={`${fmt(grande.unidades, 0)} ${plural(grande.nombre, grande.unidades)} · ${fmt(grande.litros, 1)} L`}
          onCerrar={() => setAmpliado(false)}
          anchoInicial={880}
          altoInicial={620}
        >
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <DetalleEnvase
              envase={grande}
              puedeVerKardex={puedeVerKardex}
              onCorregir={corregir(grande)}
            />
          </div>
        </VentanaFlotante>
      )}
      {corrigiendo && corrigiendo.presentacionId !== null && (
        <ModalCorregirLitros
          presentacionId={corrigiendo.presentacionId}
          nombre={corrigiendo.nombre}
          litrosRegistrados={[
            ...new Set([
              ...corrigiendo.litrosRegistradosDistintos,
              ...(corrigiendo.litrosPorBulto !== null ? [corrigiendo.litrosPorBulto] : []),
            ]),
          ].sort((a, b) => a - b)}
          onCerrar={() => setCorrigiendo(null)}
          onCorregido={() => {
            setCorrigiendo(null);
            onCorregido();
          }}
        />
      )}
    </section>
  );
}

// ── La ventana ampliada de un envase ────────────────────────────────────

interface FilaKardexEnvase {
  ocurrido_en: string;
  tipo: "entrada" | "vale" | "conteo";
  referencia_id: number;
  documento: string;
  detalle: string;
  /** De qué está hecho el movimiento (0131): un vale mixto aparece en cada
   *  envase con SU parte. */
  renglones: { presentacion: string; bultos: number; litros: number }[];
  entrada: number;
  salida: number;
  anulada: boolean;
}

/** Una fila del kardex vista desde UN envase: sus bultos y sus litros. */
interface FilaDelEnvase extends FilaKardexEnvase {
  bultos: number;
  litros: number;
}

/** Del más nuevo al más viejo: cada fila lleva el saldo que dejó, partiendo
 *  de las unidades de hoy. */
function saldosHaciaAtras(masNuevoPrimero: FilaDelEnvase[], unidadesHoy: number) {
  const salida: (FilaDelEnvase & { delta: number; saldo: number })[] = [];
  let saldo = unidadesHoy;
  for (const f of masNuevoPrimero) {
    const delta = f.bultos * (f.tipo === "entrada" ? 1 : -1);
    salida.push({ ...f, delta, saldo });
    saldo -= delta;
  }
  return salida;
}

function DetalleEnvase({
  envase,
  puedeVerKardex,
  onCorregir,
}: {
  onCorregir: (() => void) | null;
  envase: EnvaseStock;
  puedeVerKardex: boolean;
}) {
  const [filas, setFilas] = useState<FilaKardexEnvase[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!puedeVerKardex) return;
    let vivo = true;
    // Los últimos 30 días (el kardex exige el período explícito).
    const hasta = new Date();
    const desde = new Date(hasta.getTime() - 30 * 86400000);
    const q = new URLSearchParams({ desde: desde.toISOString(), hasta: hasta.toISOString() });
    apiFetch(`/api/erp/combustible/urea/kardex?${q}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { filas: FilaKardexEnvase[] };
        if (vivo) setFilas(body.filas);
      })
      .catch(() => vivo && setError(true));
    return () => {
      vivo = false;
    };
  }, [puedeVerKardex]);

  // Los movimientos de ESTE envase, con su saldo en unidades. El saldo se
  // arma hacia atrás desde las unidades de hoy: el kardex trae el saldo en
  // litros del almacén entero, no por envase.
  const propios: FilaDelEnvase[] = (filas ?? [])
    .filter((f) => !f.anulada && f.tipo !== "conteo")
    .flatMap((f) => {
      const suyo = f.renglones.find((r) => r.presentacion === envase.codigo);
      return suyo ? [{ ...f, bultos: suyo.bultos, litros: suyo.litros }] : [];
    })
    .reverse();
  const conSaldo = saldosHaciaAtras(propios, envase.unidades);

  return (
    <div className="flex flex-col gap-4">
      <Estanteria
        envase={envase}
        porFila={POR_FILA[tipoDeEnvase(envase)].ventana}
        maximo={MAX_EN_VENTANA}
      />
      <AvisoTamanosMezclados envase={envase} onCorregir={onCorregir} />
      {/* Sin tamaños mezclados también puede estar mal (todo a 16 L y la caja
          es de 20): desde el detalle se puede corregir igual. */}
      {onCorregir && envase.litrosRegistradosDistintos.length === 0 && (
        <button
          type="button"
          onClick={onCorregir}
          className="self-start rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:border-[#a3e635]"
        >
          Corregir litros de este envase
        </button>
      )}
      <div>
        <MovidoEsteMes envase={envase} />
        <ConteoDelEnvase envase={envase} />
      </div>

      <div className="text-[11px] font-semibold uppercase tracking-[0.09em] text-slate-500">
        Movimientos de este envase · últimos 30 días
      </div>
      {!puedeVerKardex ? (
        <div className="text-sm text-slate-500">Ver los movimientos requiere acceso al kardex.</div>
      ) : error ? (
        <div className="text-sm text-red-600">No se pudieron cargar los movimientos.</div>
      ) : filas === null ? (
        <div className="text-sm text-slate-500">Cargando…</div>
      ) : conSaldo.length === 0 ? (
        <div className="text-sm text-slate-500">Sin movimientos de este envase en el período.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left">Fecha</th>
                <th className="px-3 py-2 text-left">Movimiento</th>
                <th className="px-3 py-2 text-left">Documento</th>
                <th className="px-3 py-2 text-left">Detalle</th>
                <th className="px-3 py-2 text-right">Cantidad</th>
                <th className="px-3 py-2 text-right">Litros</th>
                <th className="px-3 py-2 text-right">Saldo</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {conSaldo.map((f) => (
                <tr key={`${f.tipo}-${f.referencia_id}`}>
                  <td className="whitespace-nowrap px-3 py-2">{fmtFechaHora(f.ocurrido_en)}</td>
                  <td className="px-3 py-2">{f.tipo === "entrada" ? "Entrada" : "Vale"}</td>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">{f.documento}</td>
                  <td className="px-3 py-2 text-slate-500">{f.detalle}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {f.delta > 0 ? "+" : "−"}
                    {fmt(Math.abs(f.delta), 0)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmt(f.litros, 1)}</td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums">
                    {fmt(f.saldo, 0)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
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
  const { autonomiaDias, consumoDiarioL, ultimoConteo, enRutaMes } = stock;
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
                  {/* Un decimal: con 2.4 L/día, "2 L" no explica los 170 días. */}
                  {fmt(consumoDiarioL ?? 0, 1)} L por día
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
              {(ultimoConteo.sueltoL ?? 0) > 0 && (
                <span className="text-xs text-slate-500">
                  Incluye {fmt(ultimoConteo.sueltoL!, 1)} L sueltos (fuera de envases enteros).
                </span>
              )}
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
              <b className="font-semibold text-slate-800">{fmt(stock.stockMinimoL, 0)} L</b>
            )}{" "}
            · Máximo{" "}
            {stock.stockMaximoL === null ? (
              <span className="text-slate-400">sin configurar</span>
            ) : (
              <b className="font-semibold text-slate-800">{fmt(stock.stockMaximoL, 0)} L</b>
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
