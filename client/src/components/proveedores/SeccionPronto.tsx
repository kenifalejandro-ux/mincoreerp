// client/src/components/proveedores/SeccionPronto.tsx
//
// Lo que el ecosistema va a tener pero todavía no existe. Se muestra como lo que es: no hay botones
// ni cifras de ejemplo que parezcan reales.
import { Sparkles } from "lucide-react";

export default function SeccionPronto({
  titulo,
  descripcion,
  onVolver,
}: {
  titulo: string;
  descripcion: string;
  onVolver: () => void;
}) {
  return (
    <section
      aria-labelledby="pronto-titulo"
      className="min-h-[420px] flex flex-col items-center justify-center text-center bg-white border border-slate-200 rounded-xl shadow-sm p-10"
    >
      <div className="w-16 h-16 rounded-2xl bg-[#BADC1E]/20 text-[#4d7c0f] grid place-items-center mb-4">
        <Sparkles size={30} />
      </div>
      <span className="text-[10px] font-bold uppercase tracking-[0.13em] text-slate-500">
        Pronto
      </span>
      <h2 id="pronto-titulo" className="text-2xl font-semibold text-slate-900 mt-1">
        {titulo}
      </h2>
      <p className="max-w-md text-sm text-slate-500 mt-2 mb-5">{descripcion}</p>
      <button
        onClick={onVolver}
        className="h-10 px-4 rounded-lg border border-slate-300 bg-white text-sm font-semibold text-slate-700 hover:bg-slate-50"
      >
        Volver al centro de gestión
      </button>
    </section>
  );
}
