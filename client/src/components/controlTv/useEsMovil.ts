// ¿La pantalla es de celular? El Control TV usa una distribución distinta (pestañas abajo, cifras en
// dos columnas) por debajo de este ancho. Se actualiza si se gira el teléfono.
import { useEffect, useState } from "react";

const CONSULTA = "(max-width: 639px)";
/** Celular y tablet: por debajo de este ancho la vista de una unidad usa la barra de abajo. */
export const ANCHO_PANTALLA_CHICA = 1023;

function useConsulta(consulta: string): boolean {
  const [coincide, setCoincide] = useState(() => window.matchMedia(consulta).matches);
  useEffect(() => {
    const m = window.matchMedia(consulta);
    const actualizar = () => setCoincide(m.matches);
    m.addEventListener("change", actualizar);
    return () => m.removeEventListener("change", actualizar);
  }, [consulta]);
  return coincide;
}

export const useEsMovil = (): boolean => useConsulta(CONSULTA);

/** ¿Celular o tablet (menos de 1024 px)? La TV de cada conductor cambia a pestañas abajo. */
export const useEsPantallaChica = (): boolean =>
  useConsulta(`(max-width: ${ANCHO_PANTALLA_CHICA}px)`);
