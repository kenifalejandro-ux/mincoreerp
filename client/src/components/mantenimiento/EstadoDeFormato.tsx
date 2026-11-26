// client/src/components/mantenimiento/EstadoDeFormato.tsx
//
// La etiqueta «Activo / Desactivado» de un formato, en la lista y en su panel.
export default function EstadoDeFormato({ activa }: { activa: boolean }) {
  return (
    <span
      className={`px-2.5 py-1 rounded-full text-xs font-bold whitespace-nowrap ${
        activa ? "bg-emerald-100 text-emerald-600" : "bg-slate-100 text-slate-500"
      }`}
    >
      {activa ? "Activo" : "Desactivado"}
    </span>
  );
}
