// client/src/components/proveedores/useCompras.ts
//
// Carga las compras de cisterna (Compras y recepciones). Solo lectura.
import { useEffect, useState } from "react";

import { listarCompras, type RespuestaCompras } from "./proveedoresApi";

export function useCompras() {
  const [datos, setDatos] = useState<RespuestaCompras | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let vigente = true;
    listarCompras()
      .then((r) => vigente && setDatos(r))
      .catch((e: Error) => vigente && setError(e.message));
    return () => {
      vigente = false;
    };
  }, []);
  return { datos, error };
}
