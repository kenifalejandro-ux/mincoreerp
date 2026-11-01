// Las dos pestañas de "Mi tanqueta": Movimientos (el kardex) y Mis cargas (su historial). Con el
// patrón WAI-ARIA: flechas, Inicio y Fin cambian de pestaña y mueven el foco; solo la activa está
// en el orden del Tab. Cada pestaña apunta a su panel (`idPanel`).
import { useRef, type KeyboardEvent } from "react";

import { idPanel, idPestana, type VistaDeTanqueta } from "./pestanasDeTanquetaIds";

const PESTANAS: { id: VistaDeTanqueta; texto: string }[] = [
  { id: "movimientos", texto: "Movimientos" },
  { id: "cargas", texto: "Mis cargas" },
];

export default function PestanasDeTanqueta({
  vista,
  onCambiar,
}: {
  vista: VistaDeTanqueta;
  onCambiar: (v: VistaDeTanqueta) => void;
}) {
  const botones = useRef<Partial<Record<VistaDeTanqueta, HTMLButtonElement | null>>>({});

  const alTeclear = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const n = PESTANAS.length;
    const destino =
      e.key === "ArrowRight"
        ? (i + 1) % n
        : e.key === "ArrowLeft"
          ? (i + n - 1) % n
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? n - 1
              : null;
    if (destino === null) return;
    e.preventDefault();
    const id = PESTANAS[destino].id;
    onCambiar(id);
    botones.current[id]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label="Secciones de Mi tanqueta"
      className="mb-4 flex gap-1 border-b border-[#2a2e37]"
    >
      {PESTANAS.map((p, i) => (
        <button
          key={p.id}
          ref={(el) => {
            botones.current[p.id] = el;
          }}
          id={idPestana(p.id)}
          type="button"
          role="tab"
          aria-selected={vista === p.id}
          aria-controls={idPanel(p.id)}
          tabIndex={vista === p.id ? 0 : -1}
          onClick={() => onCambiar(p.id)}
          onKeyDown={(e) => alTeclear(e, i)}
          className={`-mb-px border-b-2 px-4 py-2 text-xs font-bold uppercase tracking-[0.18em] transition-colors ${
            vista === p.id
              ? "border-[#BADC1E] text-[#BADC1E]"
              : "border-transparent text-[#94a3b8] hover:text-white"
          }`}
        >
          {p.texto}
        </button>
      ))}
    </div>
  );
}
