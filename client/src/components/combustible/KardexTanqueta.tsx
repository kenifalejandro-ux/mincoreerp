// El kardex de la tanqueta del conductor: todo lo que la mueve (también lo que registraron otros:
// un relevo, el grifero), con el saldo que quedó después de cada fila. La última fila es el saldo
// del cilindro de al lado. Solo lectura; el servidor ya quitó costos, quién registró y motivos.
//
// Cada fila cabe en UNA línea: lo largo (el conductor) se corta con "…" y el nombre completo sale
// al pasar el cursor; si aun así no cabe, la tabla se desplaza de lado y la columna Saldo queda
// fija a la derecha, siempre a la vista.
import { useState } from "react";

import type { FilaKardex, KardexDeTanqueta } from "./kardexTanquetaDatos";

// Los formateadores se crean UNA vez: `toLocaleString` arma uno nuevo en cada llamada y con 500
// filas por refresco eso congelaba la pantalla (190 ms contra 3 ms).
const NUMERO = new Intl.NumberFormat("es-PE", { maximumFractionDigits: 2 });
const DIA = new Intl.DateTimeFormat("es-PE", { day: "2-digit", month: "2-digit", year: "2-digit" });
const HORA = new Intl.DateTimeFormat("es-PE", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** Lo que se muestra de un número: un -0.004 no debe verse "-0". */
const formatear = (n: number) => NUMERO.format(Math.abs(n) < 0.005 ? 0 : n);

/** "31/10/26 · 23:17": fecha y hora corta en una sola línea (24 h para ahorrar ancho). */
const fechaCorta = (iso: string) => {
  const d = new Date(iso);
  return `${DIA.format(d)} · ${HORA.format(d)}`;
};

/** Cuántas filas se pintan de entrada; el resto, con "Ver más". */
const FILAS_INICIALES = 100;

/** Lo que pasó, en pocas palabras para que quepa en una línea. */
function describir(f: FilaKardex): string {
  const otra = f.referencia ?? "otra tanqueta";
  switch (f.tipo) {
    case "excedente":
      return f.referencia ? `Excedente (${f.referencia})` : "Excedente de recepción";
    case "prevision":
      // Llenar una tanqueta sin unidad no lleva vale: es un traspaso.
      return f.vale === null ? `Traspaso desde ${otra}` : `Llenada desde ${otra}`;
    case "traslado_recibido":
      return `Llegó de ${otra}`;
    case "carga_ruta":
      return "Carga en ruta";
    case "carga_planta":
      return "Carga en planta";
    case "retorno":
      return "Ajuste del grifero";
    case "retorno_pozo":
      return `Volvió al pozo ${f.referencia ?? ""}`.trim();
    case "retorno_traslado":
      return `Pasó a ${otra}`;
    case "asignacion":
      return f.lleva === null
        ? "Salida a la unidad"
        : `Salida a la unidad · ${formatear(f.lleva)} gal`;
    default:
      // Un tipo que el servidor agregó después de este cliente: se muestra sin romper nada.
      return "Movimiento";
  }
}

/** La barrita de color a la izquierda de cada fila: de un vistazo, qué clase de movimiento es. */
function colorDeLaBarra(f: FilaKardex): string {
  if (f.anulada) return "border-l-red-500/70";
  if (f.entra > 0) return "border-l-lime-400";
  if (f.sale > 0) return "border-l-amber-400";
  return "border-l-sky-400/70"; // la asignación: lleva el vale, no mueve combustible
}

const TH =
  "px-2.5 py-2 text-[10px] font-bold uppercase tracking-[0.18em] text-[#94a3b8] whitespace-nowrap";
const TD = "px-2.5 py-2 whitespace-nowrap";
const SALDO_FIJO = "sticky right-0 shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.7)]";

export default function KardexTanqueta({
  kardex,
  codigo,
  saldoCilindro,
  cargando,
  error,
}: {
  kardex: KardexDeTanqueta | null;
  codigo: string;
  /** El saldo que dice el cilindro: la etiqueta "cuadra" se compara con lo que se VE, no solo con
   *  lo que el servidor calculó en otro instante. */
  saldoCilindro: number;
  cargando: boolean;
  error: string | null;
}) {
  // Quien lo monta le pone `key` = la tanqueta, así que cada una parte con su lista corta.
  const [verTodas, setVerTodas] = useState(false);
  const filas = kardex ? (verTodas ? kardex.filas : kardex.filas.slice(0, FILAS_INICIALES)) : [];
  const alDia = kardex !== null && Math.abs(kardex.saldoFinal - saldoCilindro) < 0.005;
  return (
    <section
      className="min-w-0 overflow-hidden rounded-md border border-t-2 border-[#2a2e37] border-t-[#BADC1E]/70 bg-[#192526]"
      aria-label="Movimientos de la tanqueta"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#2a2e37] bg-[#0f1a1b] px-4 py-3">
        <div className="flex items-center gap-3">
          <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-[#94a3b8]">Kardex</h2>
          <span className="rounded-sm border border-[#334155] bg-[#0D1719] px-2 py-0.5 font-mono text-xs font-bold text-white">
            {codigo}
          </span>
          {kardex && (
            <span
              className={`rounded-sm border px-2 py-0.5 text-[10px] font-bold tracking-widest ${
                !kardex.cuadra
                  ? "border-amber-400/50 bg-amber-400/10 text-amber-300"
                  : alDia
                    ? "border-lime-400/40 bg-lime-400/10 text-lime-300"
                    : "border-sky-400/40 bg-sky-400/10 text-sky-300"
              }`}
            >
              {!kardex.cuadra ? "NO CUADRA" : alDia ? "CUADRA CON EL CILINDRO" : "ACTUALIZANDO…"}
            </span>
          )}
        </div>
        {kardex && (
          <span className="font-mono text-xs text-[#94a3b8]">
            {kardex.total} {kardex.total === 1 ? "MOVIMIENTO" : "MOVIMIENTOS"}
          </span>
        )}
      </div>
      {error && <p className="px-4 py-3 text-sm text-amber-400">{error}</p>}
      {kardex && !kardex.cuadra && (
        <p className="border-b border-[#2a2e37] px-4 py-3 text-sm text-amber-400">
          La fila más reciente ({formatear(kardex.saldoFinal)} gal) no coincide con el saldo de la
          tanqueta. Avisa al administrador.
        </p>
      )}
      {!kardex && !error && (
        <p className="p-8 text-center text-sm text-[#94a3b8]">
          {cargando ? "Cargando movimientos…" : "Sin movimientos para mostrar."}
        </p>
      )}
      {kardex && filas.length === 0 && (
        <p className="p-8 text-center text-sm text-[#94a3b8]">
          Todavía no hay movimientos en esta tanqueta.
        </p>
      )}
      {kardex && filas.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-max text-left text-[13px] tabular-nums">
            <thead className="bg-[#0f1a1b]">
              <tr className="border-b border-[#2a2e37]">
                <th className={TH}>Fecha</th>
                <th className={TH}>Vale</th>
                <th className={TH}>Movimiento</th>
                <th className={TH}>Unidad</th>
                <th className={TH}>Conductor</th>
                <th className={`${TH} text-right`}>Cantidad</th>
                <th className={`${TH} ${SALDO_FIJO} bg-[#0f1a1b] text-right`}>Saldo</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#243133] text-[#e2e8f0]">
              {filas.map((f) => {
                // La opacidad va en las celdas que se mueven, NO en la fila: la del Saldo fijo
                // quedaría translúcida y las columnas se verían pasar a través de ella.
                const tenue = f.anulada ? "opacity-60" : "";
                return (
                  <tr key={f.clave} className="hover:bg-[#1e2f30]">
                    <td
                      className={`${TD} ${tenue} border-l-[3px] font-mono text-xs ${colorDeLaBarra(f)}`}
                    >
                      {fechaCorta(f.fecha)}
                    </td>
                    <td className={`${TD} ${tenue} font-mono text-xs`}>{f.vale ?? "–"}</td>
                    <td className={`${TD} ${tenue}`}>
                      <span className={f.anulada ? "line-through" : ""}>{describir(f)}</span>
                      {f.anulada && (
                        <span className="ml-2 rounded-sm border border-red-400/60 px-1 text-[11px] font-bold text-red-300">
                          ANULADA
                        </span>
                      )}
                    </td>
                    <td className={`${TD} ${tenue} font-mono text-xs`}>{f.unidad ?? "–"}</td>
                    <td
                      className={`${TD} ${tenue} max-w-[150px] truncate`}
                      title={f.conductor ?? undefined}
                    >
                      {f.conductor ?? "–"}
                    </td>
                    <td
                      className={`${TD} ${tenue} text-right font-mono ${
                        f.entra > 0 ? "text-lime-300" : "text-amber-300"
                      }`}
                    >
                      {f.entra > 0 && `+${formatear(f.entra)}`}
                      {f.sale > 0 && `−${formatear(f.sale)}`}
                      {f.anulada && f.cantidad !== null && (
                        <span className="text-[#94a3b8] line-through">{formatear(f.cantidad)}</span>
                      )}
                    </td>
                    <td
                      className={`${TD} ${SALDO_FIJO} bg-[#152021] text-right font-mono text-sm font-bold ${
                        f.saldo < 0 ? "text-red-400" : f.anulada ? "text-[#94a3b8]" : "text-white"
                      }`}
                    >
                      {formatear(f.saldo)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {kardex && !verTodas && kardex.filas.length > FILAS_INICIALES && (
        <div className="border-t border-[#2a2e37] px-4 py-2">
          <button
            type="button"
            onClick={() => setVerTodas(true)}
            className="rounded border border-[#334155] px-3 py-1 text-xs font-semibold text-[#94a3b8] hover:text-white"
          >
            Ver las {kardex.filas.length - FILAS_INICIALES} restantes
          </button>
        </div>
      )}
      {kardex?.truncado && (
        <p className="border-t border-[#2a2e37] px-4 py-2 text-xs text-[#94a3b8]">
          Se muestran los {kardex.filas.length} más recientes de {kardex.total}.
        </p>
      )}
    </section>
  );
}
