// client/src/components/proveedores/GestionComercial.tsx
//
// Gestión comercial (PR4, solo lectura): lo que cobra cada proveedor, con su precio vigente, cuánto
// cambió y desde cuándo rige. Los datos son los de Combustible → Precios: acá se consultan y se
// comparan; cargar o anular un precio se sigue haciendo allá.
import { Search } from "lucide-react";
import { useMemo, useState } from "react";

import { clavesConMejorPrecio, totales } from "./preciosProveedores";
import { type FilaPrecio } from "./proveedoresApi";
import { PrecioVigente, Programado, RigeDesde, Variacion } from "./TablaDePrecios";
import { usePrecios } from "./usePrecios";

type FiltroProducto = "todos" | "combustible" | "urea";
type FiltroEstado = "todos" | "con" | "sin";

function Total({ etiqueta, valor, detalle }: { etiqueta: string; valor: number; detalle: string }) {
  return (
    <article className="bg-white border border-slate-200 rounded-xl shadow-sm p-5">
      <p className="text-xs font-semibold text-slate-500">{etiqueta}</p>
      <p className="text-2xl font-semibold text-slate-900 tabular-nums">{valor}</p>
      <p className="text-xs text-slate-500">{detalle}</p>
    </article>
  );
}

export default function GestionComercial({
  onAbrirProveedor,
}: {
  onAbrirProveedor: (proveedorId: number) => void;
}) {
  const { datos, error } = usePrecios();
  const [busqueda, setBusqueda] = useState("");
  const [producto, setProducto] = useState<FiltroProducto>("todos");
  const [estado, setEstado] = useState<FiltroEstado>("todos");
  // La hora se toma una vez por pantalla: las antigüedades no cambian mientras se mira.
  const [ahora] = useState(() => Date.now());

  const filas = useMemo(() => datos?.filas ?? [], [datos]);
  const mejores = useMemo(() => clavesConMejorPrecio(filas), [filas]);
  const resumen = useMemo(() => totales(filas), [filas]);
  const visibles = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    return filas.filter((f: FilaPrecio) => {
      if (q && !`${f.proveedorNombre} ${f.proveedorCodigo} ${f.detalle}`.toLowerCase().includes(q))
        return false;
      if (producto !== "todos" && f.producto !== producto) return false;
      if (estado === "con" && !f.vigente) return false;
      if (estado === "sin" && f.vigente) return false;
      return true;
    });
  }, [filas, busqueda, producto, estado]);

  const control =
    "h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-700 outline-none focus:border-[#84cc16]";
  return (
    <div className="space-y-5">
      <header>
        <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-slate-500">
          Abastecimiento / Gestión comercial
        </p>
        <h1 className="text-3xl font-semibold text-slate-900 mt-1">Precios de proveedores</h1>
        <p className="text-sm text-slate-500 mt-1">
          Lo que cobra cada proveedor de ruta (combustible) y de urea, con su precio vigente.
        </p>
      </header>

      <section aria-label="Resumen" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Total
          etiqueta="Con precio vigente"
          valor={resumen.conPrecio}
          detalle="Proveedor × producto"
        />
        <Total
          etiqueta="Sin precio"
          valor={resumen.sinPrecio}
          detalle="Proveedores activos sin cargar"
        />
        <Total etiqueta="Programados" valor={resumen.programados} detalle="Con fecha futura" />
        <Total
          etiqueta="Subieron 5 % o más"
          valor={resumen.subieron}
          detalle="Frente al precio anterior"
        />
      </section>

      <section className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 p-4 border-b border-slate-200">
          <label className="relative flex-1 min-w-56 max-w-md">
            <span className="sr-only">Buscar</span>
            <Search size={16} className="absolute left-3 top-3 text-slate-400" />
            <input
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Buscar por proveedor o producto"
              className={`${control} w-full pl-9`}
            />
          </label>
          <select
            aria-label="Producto"
            className={control}
            value={producto}
            onChange={(e) => setProducto(e.target.value as FiltroProducto)}
          >
            <option value="todos">Combustible y urea</option>
            {datos?.combustible && <option value="combustible">Combustible</option>}
            {datos?.urea && <option value="urea">Urea</option>}
          </select>
          <select
            aria-label="Estado del precio"
            className={control}
            value={estado}
            onChange={(e) => setEstado(e.target.value as FiltroEstado)}
          >
            <option value="todos">Con y sin precio</option>
            <option value="con">Con precio</option>
            <option value="sin">Sin precio</option>
          </select>
        </div>

        {error && (
          <p
            role="alert"
            className="m-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3"
          >
            {error}
          </p>
        )}

        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider text-slate-500 bg-slate-50 border-b border-slate-200">
                <th className="px-4 py-3">Producto</th>
                <th className="px-4 py-3">Proveedor</th>
                <th className="px-4 py-3">Precio vigente</th>
                <th className="px-4 py-3">Vs. anterior</th>
                <th className="px-4 py-3">Rige desde</th>
                <th className="px-4 py-3">Programado</th>
              </tr>
            </thead>
            <tbody>
              {datos === null && !error && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                    Cargando…
                  </td>
                </tr>
              )}
              {datos !== null && visibles.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                    {filas.length === 0
                      ? "Todavía no hay precios de proveedores. Se cargan en Combustible → Precios."
                      : "Ningún precio coincide con los filtros."}
                  </td>
                </tr>
              )}
              {visibles.map((f) => (
                <tr key={f.clave} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <b className="text-slate-900">{f.detalle}</b>
                    <span className="block text-xs text-slate-500">
                      {f.producto === "combustible" ? "Combustible" : "Urea"}
                    </span>
                    {mejores.has(f.clave) && (
                      <span className="mt-0.5 inline-block text-xs font-bold text-emerald-700">
                        Mejor precio
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => onAbrirProveedor(f.proveedorId)}
                      className="text-left"
                      aria-label={`Abrir ${f.proveedorNombre}`}
                    >
                      <span className="block font-semibold text-slate-900 hover:underline">
                        {f.proveedorNombre}
                      </span>
                      <span className="block text-xs text-slate-500">
                        {f.proveedorCodigo}
                        {f.proveedorActivo ? "" : " · desactivado"}
                      </span>
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <PrecioVigente fila={f} />
                  </td>
                  <td className="px-4 py-3">
                    <Variacion fila={f} />
                  </td>
                  <td className="px-4 py-3">
                    <RigeDesde fila={f} ahora={ahora} />
                  </td>
                  <td className="px-4 py-3">
                    <Programado fila={f} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="px-4 py-3 text-xs text-slate-500">
          Aquí solo se consultan. Los precios se cargan y se anulan en Combustible → Precios.
        </p>
      </section>
    </div>
  );
}
