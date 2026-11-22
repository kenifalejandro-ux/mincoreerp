// client/src/components/proveedores/usePrecios.ts
//
// Carga los precios de proveedores (Gestión comercial). Con `habilitado = false` no pide nada. `recargar` vuelve a leer después de cargar o anular
// un precio.
import { useCallback, useEffect, useState } from "react";

import { listarPrecios, type RespuestaPrecios } from "./proveedoresApi";

export function usePrecios(habilitado = true) {
  const [datos, setDatos] = useState<RespuestaPrecios | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Cambia cada vez que hay que volver a leer.
  const [version, setVersion] = useState(0);
  useEffect(() => {
    // Sin permiso para ver precios no se pide nada (el servidor respondería 403).
    if (!habilitado) return;
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
  }, [version, habilitado]);
  const recargar = useCallback(() => setVersion((v) => v + 1), []);
  return { datos, error, recargar };
}
