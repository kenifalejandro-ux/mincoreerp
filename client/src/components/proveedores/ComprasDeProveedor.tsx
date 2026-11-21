// client/src/components/proveedores/ComprasDeProveedor.tsx
//
// La pestaña «Compras» de la ficha: las compras de cisterna de UN proveedor. Solo lectura.
import TablaDeCompras from "./TablaDeCompras";
import { useCompras } from "./useCompras";

export default function ComprasDeProveedor({ proveedorId }: { proveedorId: number }) {
  const { datos, error } = useCompras();
  if (error)
    return (
      <p
        role="alert"
        className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3"
      >
        {error}
      </p>
    );
  if (datos === null) return <p className="text-sm text-slate-500">Cargando…</p>;
  const compras = datos.compras.filter((c) => c.proveedorId === proveedorId);
  if (compras.length === 0)
    return (
      <section className="bg-white border border-slate-200 rounded-xl shadow-sm p-6 text-sm text-slate-600">
        <h2 className="text-base font-semibold text-slate-900 mb-1">Sin compras</h2>
        Este proveedor todavía no tiene compras de cisterna. Se registran en Combustible →
        Cisternas.
      </section>
    );
  return (
    <section className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
      <TablaDeCompras compras={compras} conProveedor={false} />
    </section>
  );
}
