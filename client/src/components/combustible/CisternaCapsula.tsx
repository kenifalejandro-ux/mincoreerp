// La cisterna del Historial en una tarjeta horizontal: una barra en cápsula en vez del dibujo
// grande. Pesa poco y se lee bien en el celular. Una cisterna vaciada tiene la barra en cero; una
// anulada, gris y sin nivel (su recepción no existió, no se dibuja saldo que no hubo).
import type { CisternaDeLista } from "./cisternasTipos";
import { diasQueDuro, fechaDeLaUltimaSalida, QUE_ES } from "./historialCisternas";
import { porcentajeDelNivel } from "./nivelCisterna";

const formatear = (n: number) => n.toLocaleString("es-PE", { maximumFractionDigits: 2 });
const fecha = (iso: string) => new Date(iso).toLocaleDateString("es-PE");

const ESTADO: Record<"vaciada" | "anulada", { texto: string; chip: string; barra: string }> = {
  vaciada: {
    texto: "Vaciada",
    chip: "text-cyan-300 border-cyan-700",
    barra: "linear-gradient(90deg, #155e75, #22d3ee)",
  },
  anulada: {
    texto: "Anulada",
    chip: "text-slate-300 border-slate-600",
    barra: "linear-gradient(90deg, #334155, #64748b)",
  },
};

export default function CisternaCapsula({ c }: { c: CisternaDeLista }) {
  const anulada = c.estado === "anulada";
  const marca = ESTADO[anulada ? "anulada" : "vaciada"];
  const inicial = Number(c.cantidad);
  const saldo = Number(c.saldo);
  // La anulada nunca muestra nivel; la vaciada, lo que le quede (cero).
  const pct = anulada ? 0 : porcentajeDelNivel(saldo, inicial);
  const salidas = c.salidas ?? [];
  const duro = diasQueDuro(c);
  const ultima = fechaDeLaUltimaSalida(c);
  return (
    <article className="bg-[#192526] border border-[#2a2e37] rounded-2xl p-4 shadow-lg flex flex-col gap-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-bold text-white truncate">
            {c.proveedor ?? "Sin proveedor"}
          </h3>
          <p className="text-[11px] font-mono text-[#94a3b8]">
            Recepción #{c.recepcion_id} · {fecha(c.recibido_en)} · tanque {c.tanque_codigo}
          </p>
        </div>
        <span
          className={`shrink-0 text-[11px] font-bold uppercase tracking-wide border rounded-full px-3 py-1 ${marca.chip}`}
        >
          {marca.texto}
        </span>
      </header>
      <div
        role="img"
        aria-label={`${marca.texto}: ${formatear(anulada ? inicial : saldo)} de ${formatear(inicial)} ${c.unidad}`}
        className="h-4 rounded-full bg-[#0f1115] border border-[#334155] overflow-hidden"
      >
        <div
          className="h-full rounded-full"
          style={{ width: `${pct}%`, background: marca.barra }}
        />
      </div>
      <p className="text-xs text-[#e2e8f0]">
        {anulada ? (
          <>
            Se registraron {formatear(inicial)} {c.unidad}, pero la recepción se anuló
            {c.anulada_por_nombre ? ` (${c.anulada_por_nombre}` : ""}
            {c.anulada_en ? `${c.anulada_por_nombre ? ", " : " ("}${fecha(c.anulada_en)}` : ""}
            {c.anulada_por_nombre || c.anulada_en ? ")" : ""}.
            {c.motivo_anulacion ? ` Motivo: ${c.motivo_anulacion}.` : ""}
          </>
        ) : (
          <>
            Se repartieron {formatear(inicial)} {c.unidad}
            {ultima && duro !== null
              ? ` hasta el ${fecha(ultima)}, ${duro === 0 ? "el mismo día" : `${duro} ${duro === 1 ? "día" : "días"} después de llegar`}`
              : ""}
            .
          </>
        )}
      </p>
      {salidas.length > 0 && (
        <details className="text-xs text-[#e2e8f0]">
          <summary className="cursor-pointer text-[#94a3b8] font-semibold">
            Salidas ({salidas.length})
          </summary>
          <ul className="mt-2 space-y-1">
            {salidas.map((s) => (
              <li key={s.id} className="flex justify-between gap-3">
                <span className="truncate">
                  {QUE_ES[s.tipo]}
                  {s.destino ? ` ${s.destino}` : ""}
                </span>
                <span className="font-mono shrink-0">
                  {formatear(Number(s.cantidad))} {c.unidad} · {fecha(s.fecha)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </article>
  );
}
