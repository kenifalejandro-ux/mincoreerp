// La pestaña "Cisternas": lo que quedó en la cisterna del proveedor, con su nivel dibujado, su
// antigüedad frente al plazo y lo que ya salió de ella; y su Historial (las vaciadas y las de una
// recepción anulada), con filtros por proveedor y estado. Repartir y pasar al tanque se hacen desde
// acá (el modal es RepartirCisterna). Lectura la ve sin botones. El servidor ya filtra por sede y
// por permiso: acá solo se muestra.
import { useState } from "react";

import CisternaAcostada from "./CisternaAcostada";
import CisternaCapsula from "./CisternaCapsula";
import type { CisternaConSaldo, CisternaDeLista } from "./cisternasTipos";
import { renglonesDelDesglose, textoDelMovimiento, totalEntregado } from "./desgloseCisterna";
import { filtrarHistorial, proveedoresDe, type FiltroEstado } from "./historialCisternas";
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
  const desglose = renglonesDelDesglose(c);
  const movimientos = c.movimientos ?? [];
  return (
    <article className="bg-[#192526] border border-[#2a2e37] rounded-lg p-4 sm:p-6 shadow-lg flex flex-col gap-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-bold text-white">{c.proveedor ?? "Sin proveedor"}</h2>
        <p className="text-[11px] font-mono text-[#94a3b8]">
          Recepción #{c.recepcion_id} · {new Date(c.recibido_en).toLocaleDateString("es-PE")} ·
          tanque {c.tanque_codigo}
        </p>
      </header>
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] gap-6">
        <div className="flex flex-col gap-4">
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
            <p className="text-xs font-mono text-[#94a3b8]">{pct.toFixed(0)} %</p>
            <p className={`mt-1 text-xs ${CHIP_PLAZO[plazo]}`}>
              {dias === 0 ? "Llegó hoy" : `Lleva ${dias} ${dias === 1 ? "día" : "días"} con saldo`}
              {c.plazo_dias ? ` · plazo ${c.plazo_dias} días` : ""}
              {plazo === "vencido" ? " · plazo vencido" : ""}
            </p>
          </div>
          {puedeRepartir && (
            <button
              type="button"
              onClick={() => onRepartir(c)}
              className="flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-semibold transition-all active:scale-95 bg-[#a3e635] text-black hover:bg-[#bef264] border border-[#65a30d]"
            >
              Repartir
            </button>
          )}
        </div>
        <div className="flex flex-col gap-5">
          {desglose.length > 0 && (
            <section aria-label="Adónde fue lo que llegó">
              <h3 className="text-[10px] text-[#94a3b8] font-bold uppercase mb-2">
                Adónde fue lo que llegó · {formatear(totalEntregado(c))} {c.unidad}
              </h3>
              <ul className="space-y-1">
                {desglose.map((r) => (
                  <li
                    key={r.clave}
                    className={`flex justify-between gap-3 text-xs ${
                      r.enCisterna ? "text-cyan-300 font-semibold" : "text-[#e2e8f0]"
                    }`}
                  >
                    <span>{r.texto}</span>
                    <span className="font-mono shrink-0">
                      {formatear(r.cantidad)} {c.unidad}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section aria-label="Movimientos de esta cisterna">
            <h3 className="text-[10px] text-[#94a3b8] font-bold uppercase mb-2">
              Movimientos de la cisterna
            </h3>
            {movimientos.length === 0 ? (
              <p className="text-xs text-[#94a3b8]">Todavía no salió nada de esta cisterna.</p>
            ) : (
              <table className="w-full text-xs text-[#e2e8f0]">
                <thead>
                  <tr className="text-left text-[10px] uppercase text-[#94a3b8]">
                    <th className="pb-1 font-bold">Movimiento</th>
                    <th className="pb-1 font-bold text-right">Cantidad</th>
                    <th className="pb-1 font-bold text-right">Saldo</th>
                  </tr>
                </thead>
                <tbody>
                  {movimientos.map((m, i) => (
                    <tr key={`${m.tipo}-${i}`} className="border-t border-[#2a2e37]">
                      <td className="py-1 pr-2">
                        {textoDelMovimiento(m)}
                        <span className="block text-[10px] text-[#64748b]">
                          {new Date(m.fecha).toLocaleDateString("es-PE")}
                        </span>
                      </td>
                      <td
                        className={`py-1 text-right font-mono ${
                          m.tipo === "entrada" ? "text-cyan-300" : ""
                        }`}
                      >
                        {m.tipo === "entrada" ? "+" : "−"}
                        {formatear(Number(m.cantidad))}
                      </td>
                      <td className="py-1 text-right font-mono">{formatear(m.saldo)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      </div>
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
          <div className="grid grid-cols-1 gap-4">
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
