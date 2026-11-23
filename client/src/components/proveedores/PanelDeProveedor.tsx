// client/src/components/proveedores/PanelDeProveedor.tsx
//
// El panel de detalle de UN proveedor: su ficha completa (Resumen, Datos generales, Contactos, Cuentas,
// Comercial, Contratos, Documentos, Compras e Historial) dentro del panel lateral. Se abre desde el
// Directorio, Gestión comercial, Compras e Historial sin cambiar de pantalla. Trae al proveedor por su id, así
// que sirve desde cualquier pantalla (no depende de la lista del Directorio).
import { useCallback, useEffect, useRef, useState } from "react";

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

  // `onNoExiste` llega como una función nueva en cada vuelta del padre: si `leer` dependiera de ella, cualquier
  // cambio de estado de arriba (editar, abrir el menú, «atrás») volvería a pedir el proveedor. Va en una ref.
  const alNoExistir = useRef(onNoExiste);
  useEffect(() => {
    alNoExistir.current = onNoExiste;
  }, [onNoExiste]);
  // Cada lectura lleva su número: solo la ÚLTIMA puede actualizar la pantalla (una respuesta lenta de antes de
  // editar no pisa a la de después), y al cerrar el panel ninguna actualiza nada.
  const ultimaLectura = useRef({ n: 0 });

  const leer = useCallback(() => {
    const lectura = ultimaLectura.current;
    const numero = ++lectura.n;
    return obtenerProveedor(proveedorId)
      .then((p) => {
        if (numero !== lectura.n) return;
        setProveedor(p);
        setError(null);
      })
      .catch((e: Error) => {
        if (numero !== lectura.n) return;
        if (e instanceof ErrorDeApi && e.estado === 404) alNoExistir.current?.();
        else setError(e.message);
      });
  }, [proveedorId]);
  useEffect(() => {
    const lectura = ultimaLectura.current;
    void leer();
    return () => {
      lectura.n++;
    };
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
