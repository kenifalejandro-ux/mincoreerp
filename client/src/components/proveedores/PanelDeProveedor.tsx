// client/src/components/proveedores/PanelDeProveedor.tsx
//
// El panel de detalle de UN proveedor: su ficha completa (Resumen, Datos generales, Contactos, Cuentas,
// Comercial, Contratos, Documentos, Compras e Historial) dentro del panel lateral. Se abre desde el
// Directorio, Gestión comercial, Compras e Historial sin cambiar de pantalla. Trae al proveedor por su id, así
// que sirve desde cualquier pantalla (no depende de la lista del Directorio).
import { useCallback, useEffect, useState } from "react";

import FichaDeProveedor from "./FichaDeProveedor";
import type { PestanaFicha } from "./fichaProveedor";
import PanelDeDetalle from "./PanelDeDetalle";
import { ErrorDeApi, obtenerProveedor, type ProveedorBasico } from "./proveedoresApi";
import { useAccesoDeLaFicha } from "./useAccesoDeLaFicha";
import { useAccionesDeProveedor } from "./useAccionesDeProveedor";

export default function PanelDeProveedor({
  proveedorId,
  pestanaInicial,
  onCerrar,
  onPestana,
  onCambio,
  onEliminado,
  onNoExiste,
}: {
  proveedorId: number;
  pestanaInicial: PestanaFicha;
  onCerrar: () => void;
  /** La persona cambió de pestaña (la pantalla puede reflejarlo en la dirección). */
  onPestana?: (pestana: PestanaFicha) => void;
  /** Se editó, desactivó o reactivó el proveedor: la pantalla de atrás puede volver a leer su lista. */
  onCambio?: () => void;
  /** Se eliminó el proveedor: la pantalla cierra el panel (ya no hay ficha que mostrar). */
  onEliminado?: () => void;
  /** El proveedor no existe (un enlace viejo): la pantalla cierra el panel y corrige la dirección. */
  onNoExiste?: () => void;
}) {
  const acceso = useAccesoDeLaFicha();
  const [proveedor, setProveedor] = useState<ProveedorBasico | null>(null);
  const [error, setError] = useState<string | null>(null);

  const leer = useCallback(
    () =>
      obtenerProveedor(proveedorId)
        .then((p) => {
          setProveedor(p);
          setError(null);
        })
        .catch((e: Error) => {
          if (e instanceof ErrorDeApi && e.estado === 404) onNoExiste?.();
          else setError(e.message);
        }),
    [proveedorId, onNoExiste]
  );
  useEffect(() => {
    void leer();
  }, [leer]);

  const { acciones, dialogos } = useAccionesDeProveedor({
    onCambio: () => {
      void leer();
      onCambio?.();
    },
    onEliminado: () => onEliminado?.(),
  });

  return (
    <PanelDeDetalle etiqueta="Detalle del proveedor" titulo="Proveedor" onCerrar={onCerrar}>
      {error && (
        <p
          role="alert"
          className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3"
        >
          {error}
        </p>
      )}
      {!proveedor && !error && <p className="text-sm text-slate-500">Cargando…</p>}
      {proveedor && (
        <FichaDeProveedor
          key={proveedor.id}
          proveedor={proveedor}
          acceso={acceso}
          pestanaInicial={pestanaInicial}
          onPestana={onPestana}
          acciones={acciones(proveedor)}
        />
      )}
      {dialogos}
    </PanelDeDetalle>
  );
}
