// client/src/components/proveedores/useAccionesDeProveedor.tsx
//
// Las acciones de un proveedor (editar, desactivar o reactivar, eliminar) y sus diálogos, en un solo lugar para
// que el Directorio (menú de cada fila) y el panel de detalle (Más acciones) hagan lo mismo. `acciones(p)` da el
// menú que le toca a esta persona; `dialogos` es lo que hay que dibujar.
import { useCallback, useState, type ReactNode } from "react";

import { accionesDelProveedor, ETIQUETA_DE_ACCION, type IdDeAccion } from "./accionesDeProveedor";
import CambiarEstadoDeProveedor from "./CambiarEstadoDeProveedor";
import EliminarProveedor from "./EliminarProveedor";
import FormularioProveedor from "./FormularioProveedor";
import type { AccionDeMenu } from "./MasAcciones";
import type { ProveedorBasico } from "./proveedoresApi";
import { usePuedeEditarProveedor } from "./usePuedeEditarProveedor";
import { useAuth } from "../../context/AuthContext";

type Abierta = { accion: "editar" | "estado" | "eliminar"; proveedor: ProveedorBasico } | null;

export function useAccionesDeProveedor({
  onCambio,
  onEliminado,
}: {
  /** Se editó, desactivó o reactivó un proveedor: quien llama vuelve a leer lo que muestra. */
  onCambio: () => void;
  /** Se eliminó un proveedor (por si lo que se mostraba era él). */
  onEliminado?: (id: number) => void;
}): { acciones: (p: ProveedorBasico) => AccionDeMenu[]; dialogos: ReactNode } {
  const { usuario } = useAuth();
  const puedeEditar = usePuedeEditarProveedor();
  const [abierta, setAbierta] = useState<Abierta>(null);
  const cerrar = useCallback(() => setAbierta(null), []);

  const acciones = (p: ProveedorBasico): AccionDeMenu[] =>
    accionesDelProveedor({ activo: p.activo, puedeEditar, esAdmin: usuario?.rol === "admin" }).map(
      (id: IdDeAccion): AccionDeMenu => ({
        id,
        etiqueta: ETIQUETA_DE_ACCION[id],
        peligrosa: id === "eliminar" || id === "desactivar",
        alElegir: () =>
          setAbierta({
            accion: id === "editar" ? "editar" : id === "eliminar" ? "eliminar" : "estado",
            proveedor: p,
          }),
      })
    );

  const dialogos = abierta && (
    <>
      {abierta.accion === "editar" && (
        <FormularioProveedor
          proveedor={abierta.proveedor}
          onGuardado={() => {
            setAbierta(null);
            onCambio();
          }}
          onCerrar={cerrar}
        />
      )}
      {abierta.accion === "estado" && (
        <CambiarEstadoDeProveedor
          proveedor={abierta.proveedor}
          onCambiado={() => {
            setAbierta(null);
            onCambio();
          }}
          onCerrar={cerrar}
        />
      )}
      {abierta.accion === "eliminar" && (
        <EliminarProveedor
          proveedor={abierta.proveedor}
          onEliminado={() => {
            const id = abierta.proveedor.id;
            setAbierta(null);
            onCambio();
            onEliminado?.(id);
          }}
          onDesactivarEnSuLugar={() =>
            setAbierta({ accion: "estado", proveedor: abierta.proveedor })
          }
          onCerrar={cerrar}
        />
      )}
    </>
  );

  return { acciones, dialogos };
}
