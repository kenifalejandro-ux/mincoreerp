// client/src/components/proveedores/usePuedeCargarPrecios.ts
//
// ¿Esta persona puede cargar y anular precios de proveedores? Hace falta poder escribir en el módulo
// (Lectura y «Consultas» no), rol admin u operador, y ver al menos un producto (los permisos de Precios de
// Combustible: `combustible` o `urea` en la respuesta de /precios). El servidor exige lo mismo, esto solo
// decide si se dibujan los botones.
import { useAuth } from "../../context/AuthContext";
import { usePuedeEscribir } from "../comunes/usePuedeEscribir";

export function usePuedeCargarPrecios(
  visibles: { combustible: boolean; urea: boolean } | null | undefined
) {
  const { usuario } = useAuth();
  const puedeEscribir = usePuedeEscribir("proveedores");
  const conRol = usuario?.rol === "admin" || usuario?.rol === "operador";
  return puedeEscribir && conRol && !!visibles && (visibles.combustible || visibles.urea);
}
