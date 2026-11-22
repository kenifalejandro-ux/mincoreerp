// client/src/components/comunes/useBarraLima.ts
//
// La barra de scroll «overlay» del ERP: fina, invisible en reposo y lima solo mientras se hace scroll. La usan
// el Layout del ERP y el ecosistema «Gestión de proveedores» (que va fuera del Layout). Pone la clase
// `barra-lima` en <body> (la que leen las reglas de styles/tema-oscuro.css) y marca `scrolling-activo` en lo que
// se está desplazando. El scroll no burbujea: se escucha en captura sobre el document, para que valga también en
// los modales y en cualquier contenedor con scroll.
import { useEffect } from "react";

export const CLASE_BARRA_LIMA = "barra-lima";
export const CLASE_SCROLL_ACTIVO = "scrolling-activo";
/** Cuánto sigue lima la barra después del último movimiento. */
export const MS_BARRA_VISIBLE = 800;

export function useBarraLima() {
  useEffect(() => {
    document.body.classList.add(CLASE_BARRA_LIMA);
    const timers = new WeakMap<Element, number>();
    const alScrollear = (e: Event) => {
      const el = e.target instanceof Element ? e.target : document.documentElement;
      if (!el.classList.contains(CLASE_SCROLL_ACTIVO)) el.classList.add(CLASE_SCROLL_ACTIVO);
      window.clearTimeout(timers.get(el));
      timers.set(
        el,
        window.setTimeout(() => el.classList.remove(CLASE_SCROLL_ACTIVO), MS_BARRA_VISIBLE)
      );
    };
    document.addEventListener("scroll", alScrollear, true);
    return () => {
      document.removeEventListener("scroll", alScrollear, true);
      document.body.classList.remove(CLASE_BARRA_LIMA);
    };
  }, []);
}
