// client/src/components/proveedores/TablaDeCompras.tsx
//
// La tabla de compras de cisterna. La usan «Compras y recepciones» y la pestaña «Compras» de la ficha,
// para que se vean igual. En la ficha se oculta la columna del proveedor.
import {
  ETIQUETA_DOCUMENTO,
  ETIQUETA_ESTADO,
  formatoCantidad,
  formatoDia,
  formatoSoles,
  lecturaDeDiferencia,
} from "./comprasProveedores";
import type { CompraDeCisterna, EstadoCompra } from "./proveedoresApi";

const TONO_ESTADO: Record<EstadoCompra, string> = {
  registrada: "bg-slate-100 text-slate-600",
  por_llegar: "bg-sky-50 text-sky-700",
  recibida: "bg-emerald-50 text-emerald-700",
  anulada: "bg-red-50 text-red-700",
};

function Estado({ estado }: { estado: EstadoCompra }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-semibold ${TONO_ESTADO[estado]}`}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-current" />
      {ETIQUETA_ESTADO[estado]}
    </span>
  );
}

function Recepcion({ compra }: { compra: CompraDeCisterna }) {
  if (compra.estado === "anulada") {
    return (
      <span className="text-xs text-slate-500">
        Anulada: {compra.motivoAnulacion ?? "sin motivo"}
      </span>
    );
  }
  if (!compra.recepcion) {
    return (
      <span className="text-slate-500">
        {compra.estado === "por_llegar" ? "Esperando la descarga" : "Aún no llega"}
      </span>
    );
  }
  const lectura = lecturaDeDiferencia(compra.recepcion);
  const color =
    lectura.tono === "alerta"
      ? "text-red-700 font-semibold"
      : lectura.tono === "aviso"
        ? "text-amber-700"
        : "text-emerald-700";
  return (
    <span>
      <b className="tabular-nums text-slate-900">
        {formatoCantidad(compra.recepcion.descargado, compra.recepcion.unidad)}
      </b>
      <span className={`block text-xs ${color}`}>{lectura.texto}</span>
    </span>
  );
}

export default function TablaDeCompras({
  compras,
  conProveedor,
  onAbrirProveedor,
}: {
  compras: CompraDeCisterna[];
  conProveedor: boolean;
  onAbrirProveedor?: (proveedorId: number) => void;
}) {
  const columnas = conProveedor ? 7 : 6;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[900px] text-sm">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wider text-slate-500 bg-slate-50 border-b border-slate-200">
            <th className="px-4 py-3">Documento</th>
            {conProveedor && <th className="px-4 py-3">Proveedor</th>}
            <th className="px-4 py-3">Combustible</th>
            <th className="px-4 py-3">Costo</th>
            <th className="px-4 py-3">Llegada estimada</th>
            <th className="px-4 py-3">Estado</th>
            <th className="px-4 py-3">Recepción</th>
          </tr>
        </thead>
        <tbody>
          {compras.length === 0 && (
            <tr>
              <td colSpan={columnas} className="px-4 py-8 text-center text-slate-500">
                Ninguna compra coincide.
              </td>
            </tr>
          )}
          {compras.map((c) => (
            <tr key={c.id} className="border-b border-slate-100 hover:bg-slate-50 align-top">
              <td className="px-4 py-3">
                <b className="text-slate-900">{c.numeroDocumento}</b>
                <span className="block text-xs text-slate-500">
                  {ETIQUETA_DOCUMENTO[c.tipoDocumento] ?? c.tipoDocumento} ·{" "}
                  {formatoDia(c.fechaCompra)}
                </span>
              </td>
              {conProveedor && (
                <td className="px-4 py-3">
                  <button
                    onClick={() => onAbrirProveedor?.(c.proveedorId)}
                    className="text-left"
                    aria-label={`Abrir ${c.proveedorNombre}`}
                  >
                    <span className="block font-semibold text-slate-900 hover:underline">
                      {c.proveedorNombre}
                    </span>
                    <span className="block text-xs text-slate-500">{c.proveedorCodigo}</span>
                  </button>
                </td>
              )}
              <td className="px-4 py-3">
                <b className="text-slate-900">{c.combustible}</b>
                <span className="block text-xs text-slate-500">
                  {formatoCantidad(c.cantidadFacturada, c.unidad)}
                </span>
              </td>
              <td className="px-4 py-3">
                <b className="tabular-nums text-slate-900">{formatoSoles(c.total)}</b>
                <span className="block text-xs text-slate-500">
                  {formatoSoles(c.costoUnitario)} por {c.unidad === "L" ? "litro" : "galón"}
                </span>
              </td>
              <td className="px-4 py-3 tabular-nums">{formatoDia(c.llegadaEstimada)}</td>
              <td className="px-4 py-3">
                <Estado estado={c.estado} />
              </td>
              <td className="px-4 py-3">
                <Recepcion compra={c} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
