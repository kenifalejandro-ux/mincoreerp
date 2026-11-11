// Una sección de la vista de una unidad. En escritorio y TV es una tarjeta fija; en el celular se
// pliega con un toque en su título, para no bajar y bajar: abre solo lo que se necesita.
import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

import { useEsMovil } from "./useEsMovil";

const CARD = "rounded-xl border border-white/10 bg-white/[0.04] p-3";
const TITULO = "text-[11px] font-bold uppercase tracking-[.16em] text-slate-400";

export function SeccionTv({
  titulo,
  icono,
  children,
  abierta = true,
  derecha,
}: {
  titulo: string;
  /** Un ícono que va antes del título. */
  icono?: ReactNode;
  children: ReactNode;
  /** En el celular, si arranca abierta. */
  abierta?: boolean;
  /** Una nota corta a la derecha del título (en escritorio y TV). */
  derecha?: ReactNode;
}) {
  const movil = useEsMovil();
  if (!movil) {
    return (
      <section className="flex min-h-0 flex-col overflow-hidden rounded-[10px] border border-white/10 bg-[#0e191c]">
        <h2
          className={`${TITULO} flex items-center gap-2 whitespace-nowrap border-b border-white/10 px-3.5 py-2 text-slate-300`}
        >
          {icono}
          {titulo}
          {derecha && (
            <span className="ml-auto text-[11px] font-medium normal-case tracking-normal text-slate-400">
              {derecha}
            </span>
          )}
        </h2>
        <div className="flex min-h-0 flex-1 flex-col gap-2 px-3.5 py-2.5">{children}</div>
      </section>
    );
  }
  return (
    <details open={abierta} className={`${CARD} group`}>
      <summary
        className={`${TITULO} flex min-h-9 cursor-pointer list-none items-center justify-between [&::-webkit-details-marker]:hidden`}
      >
        <span className="flex items-center gap-2">
          {icono}
          {titulo}
        </span>
        <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <div className="mt-1.5 flex flex-col gap-1.5">{children}</div>
    </details>
  );
}
