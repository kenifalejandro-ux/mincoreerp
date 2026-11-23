// client/src/components/proveedores/useAccesoDeLaFicha.ts
//
// Qué pestañas de la ficha ve esta persona (precios, compras, cuentas e historial). Lo usan el panel de detalle
// de un proveedor y cualquier pantalla que abra su ficha. El servidor exige lo mismo: esto decide qué se dibuja.
import type { AccesoDeLaFicha } from "./fichaProveedor";
import { puedeVerHistorialDeProveedores } from "./historialProveedores";
import {
  puedeVerComprasDeProveedores,
  puedeVerCuentasDeProveedores,
  puedeVerPreciosDeProveedores,
} from "./proveedoresAcceso";
import { useAuth } from "../../context/AuthContext";

export function useAccesoDeLaFicha(): AccesoDeLaFicha {
  const { usuario } = useAuth();
  return {
    verPrecios: puedeVerPreciosDeProveedores(usuario),
    verCompras: puedeVerComprasDeProveedores(usuario),
    verCuentas: puedeVerCuentasDeProveedores(usuario),
    verHistorial: puedeVerHistorialDeProveedores(usuario),
  };
}
