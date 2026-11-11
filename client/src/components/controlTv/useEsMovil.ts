// ¿La pantalla es de celular? El Control TV usa una distribución distinta (pestañas abajo, cifras en
// dos columnas) por debajo de este ancho. Se actualiza si se gira el teléfono.
import { useEffect, useState } from "react";

const CONSULTA = "(max-width: 639px)";

export function useEsMovil(): boolean {
  const [movil, setMovil] = useState(() => window.matchMedia(CONSULTA).matches);
  useEffect(() => {
    const m = window.matchMedia(CONSULTA);
    const actualizar = () => setMovil(m.matches);
    m.addEventListener("change", actualizar);
    return () => m.removeEventListener("change", actualizar);
  }, []);
  return movil;
}
