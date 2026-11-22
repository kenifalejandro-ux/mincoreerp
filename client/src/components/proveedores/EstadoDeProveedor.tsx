// client/src/components/proveedores/EstadoDeProveedor.tsx
//
// La etiqueta «Activo» / «Desactivado» de un proveedor (el Directorio y la cabecera de su ficha).
export default function EstadoDeProveedor({ activo }: { activo: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-semibold ${
        activo ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"
      }`}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-current" />
      {activo ? "Activo" : "Desactivado"}
    </span>
  );
}
