// El cuadre de cada salida de una tanqueta, en el historial. Solo lectura.
import { useEffect, useState } from "react";

import { describirSalida, type SalidaCuadre } from "./cuadreTanquetaDatos";
import { apiFetch } from "../../services/apiClient";

export default function CuadreTanqueta({ tanquetaId }: { tanquetaId: string | number }) {
  const [salidas, setSalidas] = useState<SalidaCuadre[] | null>(null);
  const [fallo, setFallo] = useState(false);

  useEffect(() => {
    // Quien lo usa lo monta con `key` = la tanqueta, así que cada una parte de cero. Si se cierra
    // o se abre otra antes de que llegue la respuesta, la vieja no pisa a la nueva.
    let vigente = true;
    apiFetch(`/api/erp/combustible/tanquetas/${tanquetaId}/cuadre`)
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!vigente) return;
        if (res.ok && Array.isArray(body)) setSalidas(body as SalidaCuadre[]);
        else setFallo(true);
      })
      .catch(() => {
        if (vigente) setFallo(true);
      });
    return () => {
      vigente = false;
    };
  }, [tanquetaId]);

  if (fallo) {
    return (
      <p className="p-4 text-sm text-[#94a3b8]">No se pudo cargar el cuadre de las salidas.</p>
    );
  }
  if (salidas === null || salidas.length === 0) return null;

  return (
    <section className="p-3 border-b border-[#2a2e37]" aria-label="Cuadre de cada salida">
      <h4 className="text-[11px] uppercase text-[#94a3b8] mb-2">Cuadre de cada salida</h4>
      <ul className="space-y-2 text-sm">
        {salidas.map((s) => (
          <li key={`${s.fuente}-${s.inicio}-${s.vale}`}>{describirSalida(s)}</li>
        ))}
      </ul>
    </section>
  );
}
