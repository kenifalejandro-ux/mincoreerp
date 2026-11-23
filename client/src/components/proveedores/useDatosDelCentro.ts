// client/src/components/proveedores/useDatosDelCentro.ts
//
// Los datos del Centro de gestión: los proveedores (siempre), los precios (solo quien los ve) y los últimos
// movimientos (solo el admin). Cada parte se pide aparte: si una falla o la persona no la ve, el resto sigue.
// `recargar` vuelve a leer todo (por ejemplo, después de registrar un proveedor).
import { useCallback, useEffect, useState } from "react";

import { leerHistorialDeProveedores, type EventoDeHistorial } from "./historialProveedores";
import {
  listarPrecios,
  listarProveedores,
  type FilaPrecio,
  type ProveedorEnDirectorio,
} from "./proveedoresApi";

/** Cuántos movimientos recientes se muestran. */
export const MOVIMIENTOS_RECIENTES = 5;

export function useDatosDelCentro(verPrecios: boolean, verHistorial: boolean) {
  const [lista, setLista] = useState<ProveedorEnDirectorio[] | null>(null);
  const [precios, setPrecios] = useState<FilaPrecio[] | null>(null);
  const [eventos, setEventos] = useState<EventoDeHistorial[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let vigente = true;
    listarProveedores()
      .then((r) => {
        if (!vigente) return;
        setLista(r);
        setError(null);
      })
      .catch((e: Error) => vigente && setError(e.message));
    if (verPrecios) {
      listarPrecios()
        .then((r) => vigente && setPrecios(r.filas))
        .catch(() => vigente && setPrecios(null));
    }
    if (verHistorial) {
      leerHistorialDeProveedores({ limite: MOVIMIENTOS_RECIENTES })
        .then((r) => vigente && setEventos(r.eventos))
        .catch(() => vigente && setEventos(null));
    }
    return () => {
      vigente = false;
    };
  }, [verPrecios, verHistorial, version]);

  const recargar = useCallback(() => setVersion((v) => v + 1), []);
  return { lista, precios, eventos, error, recargar };
}
