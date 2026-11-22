// client/src/components/proveedores/PestanaPronto.tsx
//
// Una pestaña de la ficha que todavía no existe (Contratos, Documentos): la franja «Pronto» y el panel vacío de
// la maqueta, sin botones ni cifras de ejemplo que parezcan reales.
export default function PestanaPronto({
  kicker,
  titulo,
  aviso,
  vacio,
}: {
  kicker: string;
  titulo: string;
  aviso: string;
  vacio: string;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600 shadow-sm">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">
          <span className="h-1.5 w-1.5 rounded-full bg-current" />
          Pronto
        </span>
        <span>{aviso}</span>
      </div>
      <section className="bg-white border border-slate-200 rounded-xl shadow-sm">
        <div className="px-5 py-4 border-b border-slate-200">
          <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-slate-500">
            {kicker}
          </p>
          <h2 className="text-base font-semibold text-slate-900">{titulo}</h2>
        </div>
        <p className="p-9 text-center text-sm text-slate-500">{vacio}</p>
      </section>
    </div>
  );
}
