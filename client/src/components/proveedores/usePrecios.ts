// client/src/components/proveedores/usePrecios.ts
//
// Carga los precios de proveedores (Gestión comercial). `recargar` vuelve a leer después de cargar o anular
// un precio.
import { useCallback, useEffect, useState } from "react";

import { listarPrecios, type RespuestaPrecios } from "./proveedoresApi";

export function usePrecios() {
  const [datos, setDatos] = useState<RespuestaPrecios | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Cambia cada vez que hay que volver a leer.
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let vigente = true;
    listarPrecios()
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
