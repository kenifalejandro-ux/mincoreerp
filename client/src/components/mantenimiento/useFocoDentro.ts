// client/src/components/mantenimiento/useFocoDentro.ts
//
// Mantiene el teclado dentro de una ventana: del último control, Tab vuelve al primero (y al revés con
// Mayús+Tab), así no se activa sin ver algo de la página de atrás.
import { useEffect, useRef } from "react";

const ENFOCABLES =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useFocoDentro<T extends HTMLElement>() {
  const ventana = useRef<T>(null);
  useEffect(() => {
    const alTeclear = (e: KeyboardEvent) => {
      const caja = ventana.current;
      if (e.key !== "Tab" || !caja) return;
      const lista = Array.from(caja.querySelectorAll<HTMLElement>(ENFOCABLES)).filter(
        (el) => el.offsetParent !== null
      );
      const primero = lista[0];
      const ultimo = lista[lista.length - 1];
      if (!primero || !ultimo) return;
      const actual = document.activeElement;
      // El foco quedó fuera (por ejemplo, al deshabilitarse el botón que lo tenía): vuelve a entrar.
      if (!caja.contains(actual)) {
        e.preventDefault();
        (e.shiftKey ? ultimo : primero).focus();
      } else if (e.shiftKey && actual === primero) {
        e.preventDefault();
        ultimo.focus();
      } else if (!e.shiftKey && actual === ultimo) {
        e.preventDefault();
        primero.focus();
      }
    };
    document.addEventListener("keydown", alTeclear);
    return () => document.removeEventListener("keydown", alTeclear);
  }, []);
  return ventana;
}
