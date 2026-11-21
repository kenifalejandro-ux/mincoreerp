// client/src/components/proveedores/useFicha.ts
//
// Carga la ficha de un proveedor (datos, condiciones de pago y contactos). `recargar` vuelve a leer
// después de guardar.
import { useCallback, useEffect, useState } from "react";

import { fichaDeProveedor, type FichaProveedor } from "./proveedoresApi";

export function useFicha(proveedorId: number) {
  const [ficha, setFicha] = useState<FichaProveedor | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Cambia cada vez que hay que volver a leer.
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let vigente = true;
    fichaDeProveedor(proveedorId)
      .then((r) => {
        if (vigente) {
          setFicha(r);
          setError(null);
        }
      })
      .catch((e: Error) => vigente && setError(e.message));
    return () => {
      vigente = false;
    };
  }, [proveedorId, version]);
  const recargar = useCallback(() => setVersion((v) => v + 1), []);
  return { ficha, error, recargar };
}
