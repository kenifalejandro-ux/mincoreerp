// client/src/components/proveedores/ComprasYRecepciones.tsx
//
// Compras y recepciones (PR5, solo lectura): las compras de cisterna con su estado y, si ya se
// descargaron, lo recibido contra el documento. Son las de Combustible → Cisternas: acá se consultan;
// registrar, habilitar o anular una compra se sigue haciendo allá.
import { Search } from "lucide-react";
import { useMemo, useState } from "react";

import { ETIQUETA_ESTADO, totalesCompras } from "./comprasProveedores";
import type { EstadoCompra } from "./proveedoresApi";
import TablaDeCompras from "./TablaDeCompras";
import { useCompras } from "./useCompras";

type FiltroEstado = "todos" | EstadoCompra;

function Total({ etiqueta, valor, detalle }: { etiqueta: string; valor: number; detalle: string }) {
  return (
    <article className="bg-white border border-slate-200 rounded-xl shadow-sm p-5">
      <p className="text-xs font-semibold text-slate-500">{etiqueta}</p>
      <p className="text-2xl font-semibold text-slate-900 tabular-nums">{valor}</p>
      <p className="text-xs text-slate-500">{detalle}</p>
    </article>
  );
}

export default function ComprasYRecepciones({
  onAbrirProveedor,
}: {
  onAbrirProveedor: (proveedorId: number) => void;
}) {
  const { datos, error } = useCompras();
  const [busqueda, setBusqueda] = useState("");
  const [estado, setEstado] = useState<FiltroEstado>("todos");

  const compras = useMemo(() => datos?.compras ?? [], [datos]);
  const resumen = useMemo(() => totalesCompras(compras), [compras]);
  const visibles = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    return compras.filter((c) => {
      if (
        q &&
        !`${c.numeroDocumento} ${c.proveedorNombre} ${c.proveedorCodigo}`.toLowerCase().includes(q)
      )
        return false;
      return estado === "todos" || c.estado === estado;
    });
  }, [compras, busqueda, estado]);

  const control =
    "h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-700 outline-none focus:border-[#84cc16]";
  return (
    <div className="space-y-5">
      <header>
        <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-slate-500">
          Abastecimiento / Compras y recepciones
        </p>
        <h1 className="text-3xl font-semibold text-slate-900 mt-1">Compras y recepciones</h1>
        <p className="text-sm text-slate-500 mt-1">
          Lo que se compra a cada proveedor y cómo llegó a la cancha.
        </p>
      </header>

      <section aria-label="Resumen" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Total etiqueta="Por llegar" valor={resumen.porLlegar} detalle="Esperan la descarga" />
        <Total etiqueta="Recibidas" valor={resumen.recibidas} detalle="Ya descargadas" />
        <Total
          etiqueta="Con diferencia"
          valor={resumen.conDiferencia}
          detalle={datos ? `Fuera de ${datos.tolerancia} gal de tolerancia` : "Fuera de tolerancia"}
        />
        <Total etiqueta="Anuladas" valor={resumen.anuladas} detalle="Sin efecto" />
      </section>

      <section className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 p-4 border-b border-slate-200">
          <label className="relative flex-1 min-w-56 max-w-md">
            <span className="sr-only">Buscar</span>
            <Search size={16} className="absolute left-3 top-3 text-slate-400" />
            <input
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Buscar por documento o proveedor"
              className={`${control} w-full pl-9`}
            />
          </label>
          <select
            aria-label="Estado de la compra"
            className={control}
            value={estado}
            onChange={(e) => setEstado(e.target.value as FiltroEstado)}
          >
            <option value="todos">Todos los estados</option>
            {(Object.keys(ETIQUETA_ESTADO) as EstadoCompra[]).map((e) => (
              <option key={e} value={e}>
                {ETIQUETA_ESTADO[e]}
              </option>
            ))}
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
        {datos === null && !error && (
          <p className="px-4 py-8 text-center text-slate-500">Cargando…</p>
        )}
        {datos !== null && (
          <>
            {compras.length === 0 ? (
              <p className="px-4 py-8 text-center text-slate-500">
                Todavía no hay compras de cisterna. Se registran en Combustible → Cisternas.
              </p>
            ) : (
              <TablaDeCompras compras={visibles} conProveedor onAbrirProveedor={onAbrirProveedor} />
            )}
            <p className="px-4 py-3 text-xs text-slate-500">
              Aquí solo se consultan. Las compras se registran, habilitan y anulan en Combustible →
              Cisternas.
              {!datos.gestiona &&
                " Tu perfil ve solo las compras que ya están por llegar, igual que allá."}
            </p>
          </>
        )}
      </section>
    </div>
  );
}
