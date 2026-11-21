// client/src/components/proveedores/useCompras.ts
//
// Carga las compras de cisterna (Compras y recepciones). Solo lectura.
import { useCallback, useEffect, useState } from "react";

import { listarCompras, type RespuestaCompras } from "./proveedoresApi";

export function useCompras() {
  const [datos, setDatos] = useState<RespuestaCompras | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Cambia cada vez que hay que volver a leer (después de registrar, habilitar o anular).
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let vigente = true;
    listarCompras()
      .then((r) => {
        if (vigente) {
          setDatos(r);
          setError(null);
        }
      })
      .catch((e: Error) => vigente && setError(e.message));
    return () => {
      vigente = false;
    };
  }, [version]);
  const recargar = useCallback(() => setVersion((v) => v + 1), []);
  return { datos, error, recargar };
}
