// Las unidades a las que puede pasar el saldo de una tanqueta que vuelve. Salen de
// la misma lista que usa "Asignar" (equipos-destino), que ya está en la precarga
// para trabajar sin señal.
import { useEffect, useState } from "react";

import { apiFetch } from "../../services/apiClient";

export interface UnidadOpcion {
  id: number;
  placa_codigo: string;
}

/** Las unidades a las que puede pasar el saldo (menos la que la trajo), o por qué no hay. */
export function useUnidadesDeDestino(equipoOrigenId: number | null) {
  const [unidades, setUnidades] = useState<UnidadOpcion[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let vigente = true;
    (async () => {
      try {
        const res = await apiFetch("/api/erp/combustible/equipos-destino?pageSize=200");
        const body = await res.json().catch(() => null);
        if (!vigente) return;
        if (res.ok && Array.isArray(body?.data)) setUnidades(body.data);
        else setError(true);
      } catch {
        if (vigente) setError(true);
      }
    })();
    return () => {
      vigente = false;
    };
  }, []);

  const otras = (unidades ?? []).filter((u) => u.id !== equipoOrigenId);
  const motivo = error
    ? "No se pudieron cargar las unidades"
    : unidades === null
      ? "Buscando unidades..."
      : otras.length === 0
        ? "No hay otra unidad activa"
        : null;
  return { otras, motivo };
}
