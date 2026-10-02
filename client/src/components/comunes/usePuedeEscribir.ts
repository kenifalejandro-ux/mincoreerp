import { useAuth } from "../../context/AuthContext";

/** ¿Este usuario puede cargar, editar o eliminar en el módulo? Los botones que
 *  abren un modal de escritura se OCULTAN con esto (no basta con que el
 *  servidor rechace): Lectura y cualquier módulo en "Consultas" no los ven.
 *  Todo módulo nuevo debe pasar sus botones de Registrar/Editar/Eliminar por
 *  acá. El servidor sigue siendo la barrera real. */
export function usePuedeEscribir(modulo: string): boolean {
  const { usuario } = useAuth();
  if (!usuario || usuario.rol === "lectura") return false;
  return !(usuario.modulosConsulta ?? []).includes(modulo);
}
