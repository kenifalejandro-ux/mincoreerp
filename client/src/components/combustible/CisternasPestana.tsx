// La pestaña "Cisternas": lo que quedó en la cisterna del proveedor, con su nivel dibujado, su
// antigüedad frente al plazo y lo que ya salió de ella; y su Historial (las vaciadas y las de una
// recepción anulada), con filtros por proveedor y estado. Repartir y pasar al tanque se hacen desde
// acá (el modal es RepartirCisterna). Lectura la ve sin botones. El servidor ya filtra por sede y
// por permiso: acá solo se muestra.
import { useState } from "react";

import CisternaAcostada from "./CisternaAcostada";
import CisternaCapsula from "./CisternaCapsula";
import type { CisternaConSaldo, CisternaDeLista, SalidaDeCisterna } from "./cisternasTipos";
import { filtrarHistorial, proveedoresDe, QUE_ES, type FiltroEstado } from "./historialCisternas";
import {
  diasConSaldo,
  estadoDelPlazo,
  porcentajeDelNivel,
  type EstadoDelPlazo,
} from "./nivelCisterna";

const formatear = (n: number) => n.toLocaleString("es-PE", { maximumFractionDigits: 2 });

const CHIP_PLAZO: Record<EstadoDelPlazo, string> = {
  sin_plazo: "text-[#94a3b8]",
  en_plazo: "text-cyan-300",
  por_vencer: "text-amber-300",
  vencido: "text-red-400",
};

/** Cuántas salidas se muestran en la tarjeta; el resto queda en el historial. */
const SALIDAS_VISIBLES = 4;

function TarjetaCisterna({
  c,
  puedeRepartir,
  onRepartir,
}: {
  c: CisternaDeLista;
  puedeRepartir: boolean;
  onRepartir: (c: CisternaConSaldo) => void;
}) {
  const saldo = Number(c.saldo);
  const inicial = Number(c.cantidad);
  const pct = porcentajeDelNivel(saldo, inicial);
  const dias = diasConSaldo(c.recibido_en);
  const plazo = estadoDelPlazo(dias, c.plazo_dias);
  const salidas = c.salidas ?? [];
  return (
    <article className="bg-[#192526] border border-[#2a2e37] rounded-lg p-4 sm:p-6 shadow-lg flex flex-col gap-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-bold text-white">{c.proveedor ?? "Sin proveedor"}</h2>
        <p className="text-[11px] font-mono text-[#94a3b8]">
          Recepción #{c.recepcion_id} · {new Date(c.recibido_en).toLocaleDateString("es-PE")} ·
          tanque {c.tanque_codigo}
        </p>
      </header>
      <div className="flex justify-center">
        <CisternaAcostada
          pct={pct}
          plazo={plazo}
          descripcion={`Cisterna de ${c.proveedor ?? "proveedor sin nombre"}: ${formatear(saldo)} de ${formatear(inicial)} ${c.unidad}`}
        />
      </div>
      <div className="bg-[#0D1719] border border-[#334155] rounded px-4 py-3 text-center">
        <div className="text-[10px] text-[#94a3b8] font-bold uppercase mb-1">
          Queda de lo que sobró
        </div>
        <div className="font-mono text-2xl font-bold tracking-tight flex items-baseline justify-center gap-1 text-white">
          <span>{formatear(saldo)}</span>
          <span className="text-xs text-[#94a3b8]">
            / {formatear(inicial)} {c.unidad}
          </span>
        </div>
        <p className={`mt-1 text-xs ${CHIP_PLAZO[plazo]}`}>
          {dias === 0 ? "Llegó hoy" : `Lleva ${dias} ${dias === 1 ? "día" : "días"} con saldo`}
          {c.plazo_dias ? ` · plazo ${c.plazo_dias} días` : ""}
          {plazo === "vencido" ? " · plazo vencido" : ""}
        </p>
      </div>
      {salidas.length > 0 && (
        <section aria-label="Salidas de esta cisterna">
          <h3 className="text-[10px] text-[#94a3b8] font-bold uppercase mb-2">Salidas</h3>
          <ul className="space-y-1">
            {salidas.slice(-SALIDAS_VISIBLES).map((s) => (
              <li key={s.id} className="flex justify-between gap-3 text-xs text-[#e2e8f0]">
                <span className="truncate">
                  {QUE_ES[s.tipo]}
                  {s.destino ? ` ${s.destino}` : ""}
                </span>
                <span className="font-mono shrink-0">
                  {formatear(Number(s.cantidad))} {c.unidad} ·{" "}
                  {new Date(s.fecha).toLocaleDateString("es-PE")}
                </span>
              </li>
            ))}
          </ul>
          {salidas.length > SALIDAS_VISIBLES && (
            <p className="mt-1 text-[11px] text-[#94a3b8]">
              y {salidas.length - SALIDAS_VISIBLES} salidas anteriores
            </p>
          )}
        </section>
      )}
      {puedeRepartir && (
        <button
          type="button"
          onClick={() => onRepartir(c)}
          className="flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-semibold transition-all active:scale-95 bg-[#a3e635] text-black hover:bg-[#bef264] border border-[#65a30d]"
        >
          Repartir
        </button>
      )}
    </article>
  );
}

type Vista = "saldo" | "historial";

const BOTON_VISTA =
  "px-4 py-2 rounded-lg text-sm font-semibold whitespace-nowrap transition-all active:scale-95 border";
const CAMPO_FILTRO =
  "bg-[#0D1719] border border-[#334155] rounded px-3 py-2 text-sm font-semibold text-white";

export default function CisternasPestana({
  cisternas,
  historial,
  error,
  puedeRepartir,
  onRepartir,
}: {
  /** Las que tienen saldo. null: todavía no llegó la primera respuesta. */
  cisternas: CisternaDeLista[] | null;
  /** Las vaciadas y las de una recepción anulada. null: todavía no llegó. */
  historial: CisternaDeLista[] | null;
  error: string | null;
  puedeRepartir: boolean;
  onRepartir: (c: CisternaConSaldo) => void;
}) {
  const [vista, setVista] = useState<Vista>("saldo");
  const [proveedor, setProveedor] = useState("");
  const [estado, setEstado] = useState<FiltroEstado>("todas");
  const proveedores = proveedoresDe(historial ?? []);
  // Un proveedor que ya no está en la lista (se recargó el historial) no deja el filtro "pegado"
  // en algo que no existe: se trata como "todos".
  const proveedorVigente = proveedores.some((p) => p.valor === proveedor) ? proveedor : "";
  const visibles = filtrarHistorial(historial ?? [], proveedorVigente, estado);
  const lista = vista === "saldo" ? cisternas : historial;
  const cuenta = (l: CisternaDeLista[] | null) => (l ? ` (${l.length})` : "");
  return (
    <div>
      <div className="mb-6 lg:mb-10">
        <h1 className="text-lg sm:text-xl lg:text-2xl font-extrabold text-white tracking-tight">
          Cisternas
        </h1>
        <p className="text-xs sm:text-sm text-[#94a3b8]">
          {vista === "saldo"
            ? "Combustible que quedó en la cisterna del proveedor y todavía se puede repartir"
            : "Las cisternas que ya se vaciaron y las de una recepción anulada"}
        </p>
      </div>
      <div role="group" aria-label="Vista de cisternas" className="mb-6 flex flex-wrap gap-2">
        {(
          [
            ["saldo", "Con saldo", cisternas],
            ["historial", "Historial", historial],
          ] as const
        ).map(([valor, texto, datos]) => (
          <button
            key={valor}
            type="button"
            aria-pressed={vista === valor}
            onClick={() => setVista(valor)}
            className={`${BOTON_VISTA} ${
              vista === valor
                ? "bg-[#192526] text-white border-[#a3e635]"
                : "bg-transparent text-[#e2e8f0] border-[#334155] hover:bg-[#2a2e37]"
            }`}
          >
            {texto}
            {cuenta(datos)}
          </button>
        ))}
      </div>
      {vista === "historial" && historial && historial.length > 0 && (
        <div className="mb-6 flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <label
              htmlFor="cisternas-filtro-proveedor"
              className="block text-[10px] text-[#94a3b8] font-bold uppercase"
            >
              Proveedor
            </label>
            <select
              id="cisternas-filtro-proveedor"
              className={CAMPO_FILTRO}
              value={proveedorVigente}
              onChange={(e) => setProveedor(e.target.value)}
            >
              <option value="">Todos</option>
              {proveedores.map((p) => (
                <option key={p.valor} value={p.valor}>
                  {p.nombre}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label
              htmlFor="cisternas-filtro-estado"
              className="block text-[10px] text-[#94a3b8] font-bold uppercase"
            >
              Estado
            </label>
            <select
              id="cisternas-filtro-estado"
              className={CAMPO_FILTRO}
              value={estado}
              onChange={(e) => setEstado(e.target.value as FiltroEstado)}
            >
              <option value="todas">Todas</option>
              <option value="vaciada">Vaciadas</option>
              <option value="anulada">Anuladas</option>
            </select>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="mb-4 text-sm font-medium text-amber-300">
          {error}
          {lista ? " Lo que se ve es lo último que se supo." : ""}
        </p>
      )}
      {lista === null ? (
        !error && <p className="text-sm text-[#94a3b8]">Cargando cisternas...</p>
      ) : vista === "saldo" ? (
        lista.length === 0 ? (
          <div className="bg-[#192526] border border-dashed border-[#334155] rounded-xl p-10 text-center text-[#94a3b8]">
            No hay cisternas con saldo.
          </div>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            {lista.map((c) => (
              <TarjetaCisterna
                key={c.id}
                c={c}
                puedeRepartir={puedeRepartir}
                onRepartir={onRepartir}
              />
            ))}
          </div>
        )
      ) : visibles.length === 0 ? (
        <div className="bg-[#192526] border border-dashed border-[#334155] rounded-xl p-10 text-center text-[#94a3b8]">
          {lista.length === 0
            ? "Todavía no hay cisternas en el historial."
            : "Ninguna cisterna coincide con el filtro."}
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {visibles.map((c) => (
            <CisternaCapsula key={c.id} c={c} />
          ))}
        </div>
      )}
    </div>
  );
}

/** El aviso corto de Tanques: lleva a la pestaña, donde se ve y se reparte. */
export function AvisoCisternas({ cantidad, onVer }: { cantidad: number; onVer: () => void }) {
  if (cantidad === 0) return null;
  return (
    <div className="mb-6 bg-sky-50 border border-sky-200 rounded-lg p-4 flex flex-wrap items-center gap-3">
      <p className="text-sm text-sky-900 font-light flex-1">
        <strong>{cantidad === 1 ? "1 cisterna" : `${cantidad} cisternas`}</strong> con saldo por
        repartir.
      </p>
      <button type="button" onClick={onVer} className="text-sm font-bold text-sky-900 underline">
        Ver
      </button>
    </div>
  );
}
