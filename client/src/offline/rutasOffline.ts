// client/src/offline/rutasOffline.ts
//
// Decide si una request concreta es elegible para la cola offline,
// leyéndolo de ESCRITURAS_OFFLINE — este archivo no tiene ninguna lista
// propia de rutas.
//
// Es la pieza que hace que sumar un módulo al offline sea declarativo:
// agregarlo a ../modules/offlineRegistry.ts (y al registry del backend)
// alcanza; ni offlineQueue/offlineSync se tocan. Mismo criterio que ya usan
// `tablas` o `cuota` en el registry del backend — ver
// docs/adr/0002-contrato-de-modulo.md.

import { ESCRITURAS_OFFLINE, RUTA_DE_MODULO } from "../modules/offlineRegistry";

export interface RutaOffline {
  moduloId: string;
  metodo: string;
  /** Path absoluto, tal como lo arma routes/index.ts en el backend. Puede
   *  tener UN segmento comodín (`:id`) para rutas anidadas -- ver
   *  `segmentosCoinciden` más abajo. El id real que reemplaza al comodín
   *  no hace falta guardarlo acá: ya viaja completo dentro de la URL de la
   *  request original, que es lo que queda en `EntradaCola.url` para el
   *  reenvío (ver offlineQueue.ts). Esta ruta solo decide SI califica. */
  path: string;
}

/** Compara segmento por segmento; un segmento del patrón que empieza con
 *  `:` matchea cualquier valor concreto en esa posición. Un solo comodín
 *  por ruta alcanza hoy (ej. `/:id/versiones` de Documentos) -- no hay
 *  caso real con más de uno todavía. */
function segmentosCoinciden(patron: string, path: string): boolean {
  const segsPatron = patron.split("/");
  const segsPath = path.split("/");
  if (segsPatron.length !== segsPath.length) return false;
  return segsPatron.every((seg, i) => seg.startsWith(":") || seg === segsPath[i]);
}

/** Se calcula una sola vez: la declaración es estática, no cambia en
 *  runtime. */
const RUTAS: RutaOffline[] = Object.entries(ESCRITURAS_OFFLINE).flatMap(([moduloId, escrituras]) =>
  escrituras.map((escritura) => ({
    moduloId,
    metodo: escritura.metodo,
    // "/" es el montaje raíz del módulo: POST /api/erp/checklists, sin
    // barra final (así lo emite el cliente y así lo matchea Express).
    path: `/api/erp/${RUTA_DE_MODULO[moduloId] ?? moduloId}${escritura.ruta === "/" ? "" : escritura.ruta}`,
  }))
);

/** Normaliza para comparar: saca el origin (apiFetch recibe paths
 *  relativos, pero una URL absoluta debe matchear igual), el query string
 *  y la barra final. */
function normalizarPath(url: string): string {
  const sinOrigin = url.startsWith("http")
    ? new URL(url).pathname
    : (url.split("?")[0] ?? url).split("#")[0];
  const soloPath = (sinOrigin ?? "").split("?")[0] ?? "";
  return soloPath.length > 1 && soloPath.endsWith("/") ? soloPath.slice(0, -1) : soloPath;
}

/** El módulo dueño de esta request si es encolable, o null si no lo es.
 *
 *  Un `null` acá NO es un error: es el caso normal de toda lectura (GET) y
 *  de toda escritura que no declaró soporte offline. Esas deben fallar
 *  como siempre cuando no hay red — encolar a ciegas un DELETE, o una
 *  creación que el servidor no atiende con idempotentInsert(), haría que
 *  el reintento duplique o borre algo dos veces. */
export function moduloParaEncolar(url: string, metodo: string): string | null {
  const path = normalizarPath(url);
  const metodoNormalizado = metodo.toUpperCase();
  const match = RUTAS.find(
    (r) => r.metodo === metodoNormalizado && segmentosCoinciden(r.path, path)
  );
  return match ? match.moduloId : null;
}

/** Solo para tests y diagnóstico: qué quedó declarado como offline. */
export function rutasOfflineDeclaradas(): RutaOffline[] {
  return [...RUTAS];
}
