// client/src/components/proveedores/usePrecios.ts
//
// Carga los precios de proveedores (Gestión comercial). Solo lectura.
import { useEffect, useState } from "react";

import { listarPrecios, type RespuestaPrecios } from "./proveedoresApi";

export function usePrecios() {
  const [datos, setDatos] = useState<RespuestaPrecios | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let vigente = true;
    listarPrecios()
      .then((r) => vigente && setDatos(r))
      .catch((e: Error) => vigente && setError(e.message));
    return () => {
      vigente = false;
    };
  }, []);
  return { datos, error };
}
