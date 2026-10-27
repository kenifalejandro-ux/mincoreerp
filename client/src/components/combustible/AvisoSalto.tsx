// Mi viaje: una lectura del medidor muy lejos de la última casi siempre es un error de tipeo. Se
// pide confirmar antes de mandarla; el servidor no la rechaza porque a veces es cierta.
import { fmt } from "./viajesFormato";

const BTN =
  "flex-1 rounded-xl px-3 py-2 text-sm font-semibold border border-amber-500/50 text-amber-100";

export function AvisoSalto({
  lectura,
  minimo,
  unidad,
  onConfirmar,
  onCorregir,
}: {
  lectura: number;
  minimo: number;
  unidad: string;
  onConfirmar: () => void;
  onCorregir: () => void;
}) {
  return (
    <div
      role="alert"
      className="rounded-xl bg-amber-500/10 border border-amber-500/30 p-3 text-sm text-amber-200 space-y-2"
    >
      <p>
        Son {fmt(lectura - minimo, 1)} {unidad} desde la última lectura ({fmt(minimo, 1)}). ¿Está
        bien?
      </p>
      <div className="flex gap-2">
        <button className={`${BTN} bg-amber-500/20`} onClick={onConfirmar}>
          Sí, es correcto
        </button>
        <button className={BTN} onClick={onCorregir} autoFocus>
          Corregir
        </button>
      </div>
    </div>
  );
}
