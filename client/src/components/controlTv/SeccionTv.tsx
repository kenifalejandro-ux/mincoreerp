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
}: {
  titulo: string;
  /** Un ícono que va antes del título. */
  icono?: ReactNode;
  children: ReactNode;
  /** En el celular, si arranca abierta. */
  abierta?: boolean;
}) {
  const movil = useEsMovil();
  if (!movil) {
    return (
      <section className={`${CARD} flex flex-col gap-1.5`}>
        <h2 className={`${TITULO} flex items-center gap-2`}>
          {icono}
          {titulo}
        </h2>
        {children}
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
