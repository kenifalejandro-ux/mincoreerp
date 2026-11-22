// client/src/components/proveedores/usePuedeEditarProveedor.ts
//
// ¿Esta persona puede editar la ficha del proveedor (datos, condiciones de pago, contactos)? Hace falta
// poder escribir en el módulo (Lectura y «Consultas» no) y rol admin u operador. El servidor exige lo
// mismo; esto solo decide si se dibujan los botones.
import { useAuth } from "../../context/AuthContext";
import { usePuedeEscribir } from "../comunes/usePuedeEscribir";

export function usePuedeEditarProveedor() {
  const { usuario } = useAuth();
  const puedeEscribir = usePuedeEscribir("proveedores");
  return puedeEscribir && (usuario?.rol === "admin" || usuario?.rol === "operador");
}
