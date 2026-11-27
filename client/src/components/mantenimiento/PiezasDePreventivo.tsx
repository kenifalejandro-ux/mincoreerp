// client/src/components/mantenimiento/PiezasDePreventivo.tsx
//
// Las piezas que comparten la pantalla de Planes y el panel de un nivel.
import {
  ETIQUETA_DE_ESTADO,
  FONDO_DE_NIVEL,
  type EstadoPreventivo,
  type Nivel,
} from "./planesPreventivo";

export function ChipDeNivel({ nivel }: { nivel: Nivel }) {
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-extrabold text-white ${FONDO_DE_NIVEL[nivel]}`}
    >
      MP{nivel}
    </span>
  );
}

const TONO: Record<EstadoPreventivo, string> = {
  vencido: "bg-red-50 text-red-700",
  proximo: "bg-amber-50 text-amber-800",
  al_dia: "bg-emerald-50 text-emerald-700",
  sin_datos: "bg-slate-100 text-slate-600",
};

export function ChipDeEstado({ estado }: { estado: EstadoPreventivo }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-bold ${TONO[estado]}`}
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
      {ETIQUETA_DE_ESTADO[estado]}
    </span>
  );
}
