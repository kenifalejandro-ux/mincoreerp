// La etiqueta «Nuevo» del ícono de TV de la barra superior: avisa a la oficina que el Control TV trae
// algo nuevo. Sale hasta 24 horas después del primer clic en el ícono. Cada novedad tiene su propia
// clave: al sacar otra, vuelve a salir sin tocar lo anterior. Se guarda en el navegador de cada persona;
// si no hay almacenamiento (ventana privada), simplemente sale siempre.

/** La novedad de ahora. Para avisar de otra, se cambia esta clave. */
export const NOVEDAD_CONTROL_TV = "mapa-iconos-2026-11";
export const HORAS_DE_AVISO = 24;

type Almacen = Pick<Storage, "getItem" | "setItem">;

const clave = (id: string) => `controlTv.novedad.${id}`;

function almacenDelNavegador(): Almacen | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** ¿Hay que mostrar «Nuevo»? Sí hasta 24 horas después del primer clic; sin clic todavía, sí. */
export function novedadVigente(
  ahora = Date.now(),
  almacen: Almacen | null = almacenDelNavegador(),
  id = NOVEDAD_CONTROL_TV
): boolean {
  try {
    const visto = Number(almacen?.getItem(clave(id)));
    if (!Number.isFinite(visto) || visto <= 0) return true;
    return ahora - visto < HORAS_DE_AVISO * 3_600_000;
  } catch {
    return true;
  }
}

/** Anota el primer clic (los siguientes no mueven la hora). */
export function marcarNovedadVista(
  ahora = Date.now(),
  almacen: Almacen | null = almacenDelNavegador(),
  id = NOVEDAD_CONTROL_TV
): void {
  try {
    if (!almacen) return;
    const previo = Number(almacen.getItem(clave(id)));
    if (Number.isFinite(previo) && previo > 0) return;
    almacen.setItem(clave(id), String(ahora));
  } catch {
    // Sin almacenamiento: la etiqueta seguirá saliendo; no es grave.
  }
}
