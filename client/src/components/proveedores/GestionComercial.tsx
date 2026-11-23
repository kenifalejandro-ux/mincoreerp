// client/src/components/proveedores/GestionComercial.tsx
//
// Gestión comercial («Precios negociados» en la maqueta): lo que cobra cada proveedor, con su precio vigente,
// cuánto cambió, hasta cuándo vale (opcional) y su condición de pago. Los datos son los mismos que usa
// Combustible (combustible_precios y los precios de urea): un precio cargado acá lo toman los despachos, las
// compras en ruta y los viajes.
import { Search } from "lucide-react";
import { useMemo, useState } from "react";

import BotonNuevoPrecio from "./BotonNuevoPrecio";
import {
  clavesConMejorPrecio,
  coincideConUso,
  diasDesde,
  formatoFecha,
  textoAntiguedad,
  totales,
  type FiltroDeUso,
} from "./preciosProveedores";
import { type FilaPrecio } from "./proveedoresApi";
import {
  CondicionDePago,
  PrecioVigente,
  Programado,
  UsoDelPrecio,
  VigenciaHasta,
  Variacion,
} from "./TablaDePrecios";
import { usePrecios } from "./usePrecios";
import { usePuedeCargarPrecios } from "./usePuedeCargarPrecios";

type FiltroEstado = "todos" | "con" | "sin";

function Total({
  etiqueta,
  valor,
  detalle,
  color = "text-slate-900",
}: {
  etiqueta: string;
  valor: number;
  detalle: string;
  color?: string;
}) {
  return (
    <article className="bg-white border border-slate-200 rounded-xl shadow-sm p-5">
      <p className="text-xs font-semibold text-slate-500">{etiqueta}</p>
      <p className={`text-2xl font-semibold tabular-nums ${color}`}>{valor}</p>
      <p className="text-xs text-slate-500">{detalle}</p>
    </article>
  );
}

export default function GestionComercial({
  onAbrirProveedor,
}: {
  onAbrirProveedor: (proveedorId: number) => void;
}) {
  const { datos, error, recargar } = usePrecios();
  const puedeCargar = usePuedeCargarPrecios(datos);
  const [aviso, setAviso] = useState<string | null>(null);
  const [busqueda, setBusqueda] = useState("");
  // Por nombre de producto («Diésel B5», «Caja (20 L)»), como en la maqueta.
  const [producto, setProducto] = useState<string>("todos");
  const [uso, setUso] = useState<FiltroDeUso>("todos");
  const [estado, setEstado] = useState<FiltroEstado>("todos");
  // La hora se toma una vez por pantalla: las antigüedades no cambian mientras se mira.
  const [ahora] = useState(() => Date.now());

  const filas = useMemo(() => datos?.filas ?? [], [datos]);
  const mejores = useMemo(() => clavesConMejorPrecio(filas), [filas]);
  const resumen = useMemo(() => totales(filas, ahora), [filas, ahora]);
  const productos = useMemo(
    () => [...new Set(filas.map((f) => f.detalle))].sort((a, b) => a.localeCompare(b, "es")),
    [filas]
  );
  const visibles = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    return filas.filter((f: FilaPrecio) => {
      if (q && !`${f.proveedorNombre} ${f.proveedorCodigo} ${f.detalle}`.toLowerCase().includes(q))
        return false;
      if (producto !== "todos" && f.detalle !== producto) return false;
      if (!coincideConUso(f.uso, uso)) return false;
      if (estado === "con" && !f.vigente) return false;
      if (estado === "sin" && f.vigente) return false;
      return true;
    });
  }, [filas, busqueda, producto, uso, estado]);

  const control =
    "h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-700 outline-none focus:border-[#84cc16]";
  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-slate-500">
            Abastecimiento / Gestión comercial
          </p>
          <h1 className="text-3xl font-semibold text-slate-900 mt-1">Precios negociados</h1>
          <p className="text-sm text-slate-500 mt-1">
            Compara lo que cobra cada proveedor y vigila vigencias y variaciones.
          </p>
        </div>
        {puedeCargar && (
          <BotonNuevoPrecio
            filas={filas}
            onCargado={(mensaje) => {
              setAviso(mensaje);
              recargar();
            }}
          />
        )}
      </header>

      {aviso && (
        <p
          role="status"
          className="text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg p-3"
        >
          {aviso}
        </p>
      )}

      <section aria-label="Resumen" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Total
          etiqueta="Precios vigentes"
          valor={resumen.conPrecio}
          detalle={`${resumen.productos} ${resumen.productos === 1 ? "producto" : "productos"}`}
        />
        <Total
          etiqueta="Vencen en 30 días"
          valor={resumen.vencenPronto}
          detalle={
            resumen.vencidos > 0
              ? `${resumen.vencidos} ya vencidos · renegociar a tiempo`
              : "Renegociar a tiempo"
          }
          color="text-amber-600"
        />
        <Total
          etiqueta="Alzas de 5 % o más"
          valor={resumen.subieron}
          detalle="Frente al precio anterior"
          color="text-red-600"
        />
        <Total
          etiqueta="Activos sin precio"
          valor={resumen.sinPrecio}
          detalle="Sin acuerdo cargado"
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
            onChange={(e) => setProducto(e.target.value)}
          >
            <option value="todos">Todos los productos</option>
            {productos.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <div
            role="group"
            aria-label="Uso"
            className="inline-flex rounded-lg border border-slate-300 bg-white p-0.5"
          >
            {(
              [
                ["todos", "Todos"],
                ["externo", "Externos"],
                ["interno", "Internos"],
              ] as const
            ).map(([valor, texto]) => (
              <button
                key={valor}
                type="button"
                aria-pressed={uso === valor}
                onClick={() => setUso(valor)}
                className={`h-9 px-3 rounded-md text-sm font-semibold ${
                  uso === valor
                    ? "bg-[#BADC1E] text-[#0A1014]"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                {texto}
              </button>
            ))}
          </div>
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
                <th className="px-4 py-3">Producto o servicio</th>
                <th className="px-4 py-3">Proveedor</th>
                <th className="px-4 py-3">Precio vigente</th>
                <th className="px-4 py-3">Vs. anterior</th>
                <th className="px-4 py-3">Vigencia hasta</th>
                <th className="px-4 py-3">Condición de pago</th>
                <th className="px-4 py-3">Uso</th>
              </tr>
            </thead>
            <tbody>
              {datos === null && !error && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                    Cargando…
                  </td>
                </tr>
              )}
              {datos !== null && visibles.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                    {filas.length === 0
                      ? `Todavía no hay precios de proveedores.${puedeCargar ? " Carga el primero con «Nuevo precio»." : " Se cargan en Combustible → Precios."}`
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
                      <span className="block font-semibold text-slate-900">
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
                    {f.programado && (
                      <span className="mt-1 block text-xs text-slate-500">
                        Programado: <Programado fila={f} />
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <Variacion fila={f} />
                  </td>
                  <td className="px-4 py-3">
                    <VigenciaHasta fila={f} ahora={ahora} />
                    {f.vigente && (
                      <span className="mt-1 block text-xs text-slate-400">
                        Rige desde {formatoFecha(f.vigente.desde)} ·{" "}
                        {textoAntiguedad(diasDesde(f.vigente.desde, ahora))}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <CondicionDePago fila={f} />
                  </td>
                  <td className="px-4 py-3">
                    <UsoDelPrecio fila={f} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="px-4 py-3 text-xs text-slate-500">
          {puedeCargar
            ? "Un precio nuevo rige desde su fecha y el anterior queda en la historia; uno mal cargado se anula desde la ficha del proveedor. La vigencia hasta es opcional y solo avisa: un precio vencido sigue rigiendo hasta que se cargue otro. Interno: compra para despachar desde la planta. Externo: se compra en el recorrido de ruta. Los precios de tanque (venta interna) se cargan en Combustible → Precios."
            : "Aquí solo se consultan. Los precios se cargan y se anulan en Combustible → Precios. Interno: compra para despachar desde la planta. Externo: se compra en el recorrido de ruta."}
        </p>
      </section>
    </div>
  );
}
