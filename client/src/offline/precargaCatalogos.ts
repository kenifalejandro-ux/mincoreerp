// client/src/offline/precargaCatalogos.ts
//
// Baja, con red, las lecturas que los formularios de cada perfil necesitan para
// armarse sin señal. El service worker las guarda al pasar (reglas
// `erp-catalogos` de vite.config.js), pero solo las que el usuario alcanzó a
// abrir: sin esta precarga, quien entra por primera vez y se queda sin señal
// ve los desplegables vacíos.
//
// Las URL deben ser IDÉNTICAS a las que piden las pantallas (el caché las
// reconoce por URL completa, con su query).

import { estaOnline } from "./connectivity";
import { apiFetch } from "../services/apiClient";
import type { UsuarioPayload } from "../services/authApi";

type Rol = UsuarioPayload["rol"];

const C = "/api/erp/combustible";

// Conductor: Mi viaje, Compra en ruta, Tanques y Urea.
const CONDUCTOR = [
  `${C}/equipos-destino?pageSize=200`,
  // "Carga desde tanqueta" pide estas dos al abrirse.
  `${C}/tanquetas/formulario`,
  `${C}/config/formulario-despacho`,
  `${C}/grifos/para-formulario`,
  `${C}/urea/proveedores`,
  `${C}/urea/presentaciones`,
  `${C}/urea/precios`,
];

// Grifero: Control de Combustible (registrar recepción y despacho).
const GRIFERO = [
  C,
  `${C}/equipos-destino?pageSize=200`,
  `${C}/grifos`,
  `${C}/tanquetas/formulario`,
  `${C}/config/formulario-despacho`,
];

// Operador: lo de los dos, más Equipos.
const EQUIPOS = [
  "/api/erp/equipos?page=1&pageSize=200",
  "/api/erp/equipos/lugares",
  "/api/erp/sedes",
];

const POR_ROL: Partial<Record<Rol, string[]>> = {
  conductor_ruta: CONDUCTOR,
  grifero: GRIFERO,
  operador: [...new Set([...CONDUCTOR, ...GRIFERO, ...EQUIPOS])],
};

let enCurso = false;

/** El caché lo llena el service worker al ver pasar la petición: si la precarga
 *  sale antes de que él tome el control de la página (primer arranque o recién
 *  actualizado), las primeras peticiones van directo a la red y no quedan
 *  guardadas. Se espera a que sea el controlador, con un tope para no colgarse
 *  donde no hay service worker. */
async function esperarServiceWorker(): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  try {
    await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(r, 4000))]);
    if (navigator.serviceWorker.controller) return;
    await new Promise<void>((resolver) => {
      const plazo = setTimeout(resolver, 4000);
      navigator.serviceWorker.addEventListener(
        "controllerchange",
        () => {
          clearTimeout(plazo);
          resolver();
        },
        { once: true }
      );
    });
  } catch {
    // Sin service worker utilizable: se precarga igual, sin caché no hay daño.
  }
}

/** Mejor esfuerzo: un fallo no se reporta ni interrumpe, es solo precarga. */
export async function precargarCatalogos(usuario: UsuarioPayload): Promise<void> {
  const urls = POR_ROL[usuario.rol];
  if (!urls || enCurso || !estaOnline()) return;
  if (usuario.modulosPermitidos && !usuario.modulosPermitidos.includes("combustible")) return;
  enCurso = true;
  try {
    await esperarServiceWorker();
    for (const url of urls) {
      try {
        const res = await apiFetch(url);
        // Los puntos precintados de cada tanque (la varilla los pide).
        if (url === C && res.ok) {
          const tanques = await res.json().catch(() => null);
          if (Array.isArray(tanques)) {
            for (const t of tanques) {
              if (typeof t?.id === "number")
                await apiFetch(`${C}/${t.id}/precintos`).catch(() => {});
            }
          }
        }
      } catch {
        // sin red a mitad de camino: se completa en la próxima entrada
      }
    }
  } finally {
    enCurso = false;
  }
}
