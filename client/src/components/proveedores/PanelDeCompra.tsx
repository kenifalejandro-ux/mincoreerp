// client/src/components/proveedores/PanelDeCompra.tsx
//
// El panel de detalle de UNA compra de cisterna: el documento, el producto y su precio, el transporte y la
// recepción (lo que se descargó contra lo facturado). Solo lectura. Desde aquí se puede pasar a la ficha del
// proveedor.
import {
  ETIQUETA_DOCUMENTO,
  ETIQUETA_ESTADO,
  formatoCantidad,
  formatoDia,
  formatoSoles,
  lecturaDeDiferencia,
} from "./comprasProveedores";
import PanelDeDetalle from "./PanelDeDetalle";
import { Panel } from "./PanelesDeFicha";
import type { CompraDeCisterna } from "./proveedoresApi";

const TONO = {
  alerta: "text-red-700 font-semibold",
  aviso: "text-amber-700",
  neutra: "text-emerald-700",
} as const;

function Dato({ etiqueta, valor }: { etiqueta: string; valor: string | null | undefined }) {
  return (
    <div>
      <dt className="text-[11px] text-slate-500 mb-0.5">{etiqueta}</dt>
      <dd className="font-semibold text-slate-900">{valor || "—"}</dd>
    </div>
  );
}

const fechaYHora = (iso: string) =>
  new Date(iso).toLocaleString("es-PE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Lima",
  });

export default function PanelDeCompra({
  compra,
  onCerrar,
  onAbrirProveedor,
}: {
  compra: CompraDeCisterna;
  onCerrar: () => void;
  /** Pasa a la ficha del proveedor, en este mismo panel. */
  onAbrirProveedor?: (proveedorId: number) => void;
}) {
  const r = compra.recepcion;
  const lectura = r ? lecturaDeDiferencia(r) : null;
  return (
    <PanelDeDetalle etiqueta="Detalle de la compra" titulo="Compra" onCerrar={onCerrar}>
      <div className="space-y-5">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-[22px] font-semibold text-slate-900">
              Compra {compra.numeroDocumento}
            </h1>
            <p className="text-sm text-slate-500 mt-1">
              {ETIQUETA_DOCUMENTO[compra.tipoDocumento] ?? compra.tipoDocumento} ·{" "}
              {formatoDia(compra.fechaCompra)} · {ETIQUETA_ESTADO[compra.estado]}
            </p>
          </div>
          {onAbrirProveedor && (
            <button
              onClick={() => onAbrirProveedor(compra.proveedorId)}
              className="h-10 px-4 rounded-lg border border-slate-300 bg-white text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              Abrir ficha de {compra.proveedorNombre}
            </button>
          )}
        </header>

        {compra.estado === "anulada" && (
          <p
            role="status"
            className="text-sm text-red-800 bg-red-50 border border-red-200 rounded-lg p-3"
          >
            Compra anulada: {compra.motivoAnulacion ?? "sin motivo"}.
          </p>
        )}

        <Panel kicker="Documento" titulo="Datos de la compra">
          <dl className="grid gap-x-8 gap-y-4 px-5 pb-5 pt-1 sm:grid-cols-2">
            <Dato
              etiqueta="Proveedor"
              valor={`${compra.proveedorNombre} · ${compra.proveedorCodigo}`}
            />
            <Dato
              etiqueta="Documento"
              valor={`${ETIQUETA_DOCUMENTO[compra.tipoDocumento] ?? compra.tipoDocumento} ${compra.numeroDocumento}`}
            />
            <Dato etiqueta="Fecha de compra" valor={formatoDia(compra.fechaCompra)} />
            <Dato etiqueta="Llegada estimada" valor={formatoDia(compra.llegadaEstimada)} />
          </dl>
        </Panel>

        <Panel kicker="Producto" titulo={compra.combustible}>
          <dl className="grid gap-x-8 gap-y-4 px-5 pb-5 pt-1 sm:grid-cols-3">
            <Dato
              etiqueta="Cantidad facturada"
              valor={formatoCantidad(compra.cantidadFacturada, compra.unidad)}
            />
            <Dato
              etiqueta={`Precio por ${compra.unidad === "L" ? "litro" : "galón"}`}
              valor={formatoSoles(compra.costoUnitario)}
            />
            <Dato etiqueta="Total" valor={formatoSoles(compra.total)} />
          </dl>
        </Panel>

        <Panel kicker="Transporte" titulo="Quién lo trae">
          <dl className="grid gap-x-8 gap-y-4 px-5 pb-5 pt-1 sm:grid-cols-2">
            <Dato etiqueta="Placa" valor={compra.placa} />
            <Dato etiqueta="Chofer" valor={compra.chofer} />
            <Dato etiqueta="Transportista" valor={compra.transportista} />
            <Dato etiqueta="RUC del transportista" valor={compra.transportistaRuc} />
          </dl>
        </Panel>

        <Panel kicker="Recepción" titulo="Lo que llegó">
          {r && lectura ? (
            <dl className="grid gap-x-8 gap-y-4 px-5 pb-5 pt-1 sm:grid-cols-3">
              <Dato etiqueta="Descargado" valor={formatoCantidad(r.descargado, r.unidad)} />
              <div>
                <dt className="text-[11px] text-slate-500 mb-0.5">Contra lo facturado</dt>
                <dd className={`font-semibold ${TONO[lectura.tono]}`}>{lectura.texto}</dd>
              </div>
              <Dato etiqueta="Recibida el" valor={fechaYHora(r.recibidoEn)} />
            </dl>
          ) : (
            <p className="px-5 pb-5 text-sm text-slate-500">
              {compra.estado === "anulada"
                ? "La compra se anuló: no habrá recepción."
                : compra.estado === "por_llegar"
                  ? "Esperando la descarga en cancha."
                  : "Aún no llega: primero hay que habilitarla para que la cancha la reciba."}
            </p>
          )}
        </Panel>
      </div>
    </PanelDeDetalle>
  );
}
