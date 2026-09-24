// client/src/components/facturacion/FacturacionView.tsx
//
// Facturación no es un módulo del registry (ver App.tsx/Sidebar.tsx): es
// transversal, visible siempre. Dos opciones a propósito, aunque solo una
// funcione hoy -- "Facturación" (factura/boleta) queda visible mostrando
// que existe y que no está disponible todavía, en vez de ocultarla, hasta
// que haya empresa formal para emitir esos comprobantes.
import { useEffect, useState } from "react";

import { apiFetch } from "../../services/apiClient";

interface Comprobante {
  id: string;
  numero: string | null;
  concepto: string;
  monto: string;
  moneda: string;
  emitidoEn: string | null;
  creadoEn: string;
}

type Opcion = "facturacion" | "comprobante_pago";

async function descargarComprobante(id: string) {
  const res = await apiFetch(`/api/facturacion/comprobantes/${id}/pdf`);
  if (!res.ok) return;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `comprobante-${id}.pdf`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function FacturacionView() {
  const [opcion, setOpcion] = useState<Opcion>("comprobante_pago");
  const [comprobantes, setComprobantes] = useState<Comprobante[]>([]);
  const [cargando, setCargando] = useState(true);

  useEffect(() => {
    apiFetch("/api/facturacion/comprobantes")
      .then((res) => res.json())
      .then((data) => setComprobantes(data.comprobantes ?? []))
      .finally(() => setCargando(false));
  }, []);

  return (
    <div className="p-2 sm:p-4 lg:p-8 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Facturación</h1>

      <div className="flex gap-2 mb-6 border-b">
        <button
          onClick={() => setOpcion("facturacion")}
          className={`px-4 py-2 -mb-px border-b-2 font-medium ${
            opcion === "facturacion"
              ? "border-blue-600 text-blue-700"
              : "border-transparent text-gray-500 hover:text-gray-700"
          }`}
        >
          Facturación
        </button>
        <button
          onClick={() => setOpcion("comprobante_pago")}
          className={`px-4 py-2 -mb-px border-b-2 font-medium ${
            opcion === "comprobante_pago"
              ? "border-blue-600 text-blue-700"
              : "border-transparent text-gray-500 hover:text-gray-700"
          }`}
        >
          Comprobante de pago
        </button>
      </div>

      {opcion === "facturacion" && (
        <div className="bg-gray-50 border border-gray-200 rounded-xl p-6 text-gray-600">
          Disponible próximamente. Mientras tanto, descargá tu constancia de pago desde
          &quot;Comprobante de pago&quot;.
        </div>
      )}

      {opcion === "comprobante_pago" && (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          {cargando ? (
            <div className="p-6 text-gray-500">Cargando...</div>
          ) : comprobantes.length === 0 ? (
            <div className="p-6 text-gray-500">Todavía no tenés comprobantes de pago.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-max text-left">
                <thead className="bg-gray-50 text-sm text-gray-500">
                  <tr>
                    <th className="px-4 py-3">Fecha</th>
                    <th className="px-4 py-3">Concepto</th>
                    <th className="px-4 py-3">Monto</th>
                    <th className="px-4 py-3">Número</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {comprobantes.map((c) => (
                    <tr key={c.id}>
                      <td className="px-4 py-3">
                        {new Date(c.creadoEn).toLocaleDateString("es-PE")}
                      </td>
                      <td className="px-4 py-3">{c.concepto}</td>
                      <td className="px-4 py-3">
                        {c.monto} {c.moneda}
                      </td>
                      <td className="px-4 py-3 text-gray-500">{c.numero ?? "—"}</td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => descargarComprobante(c.id)}
                          className="text-blue-600 hover:text-blue-800 font-medium"
                        >
                          Descargar
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
