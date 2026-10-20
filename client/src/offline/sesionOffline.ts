// client/src/offline/sesionOffline.ts
//
// De quién es lo que hay guardado en este dispositivo.
//
// Hace falta porque IndexedDB y el caché del service worker son POR ORIGEN,
// no por usuario ni por tenant — a diferencia de la cookie de sesión, que
// se borra al desloguear. Una tablet compartida en planta es el caso normal
// (varios operarios del mismo turno), así que sin esto pasan dos cosas
// concretas y silenciosas:
//
//   1. La cola de Carlos (llenada sin señal) se drenaría bajo la sesión de
//      María si ella entra primero cuando vuelve la red. El servidor toma
//      el autor del JWT, no del body: el checklist quedaría firmado por
//      María. No es un bug de permisos —María sí puede crear checklists—
//      pero el dato queda mal atribuido, y en un registro de seguridad
//      minera eso importa.
//   2. Los catálogos cacheados (equipos, plantillas) de un tenant seguirían
//      sirviéndose después de que entre alguien de OTRO tenant en el mismo
//      dispositivo. RLS protege la base, no el caché del navegador.
//
// El (1) se resuelve estampando el usuario en cada entrada y filtrando al
// drenar; el (2) borrando los cachés de datos al cerrar sesión.

/** Prefijo de los cachés que crea el service worker para datos de la API
 *  (ver runtimeCaching en client/vite.config.js). El del app shell NO
 *  entra: son assets públicos, iguales para todos. */
const PREFIJO_CACHE_DATOS = "erp-catalogos";

let usuarioActivoId: string | null = null;

/** Lo llama AuthContext cada vez que cambia el usuario en sesión. */
export function registrarUsuarioActivo(id: string | null): void {
  usuarioActivoId = id;
}

export function usuarioActivo(): string | null {
  return usuarioActivoId;
}

/** Borra los catálogos cacheados. Se llama al cerrar sesión — NO se toca
 *  la cola: puede tener trabajo real sin sincronizar, y borrarla haría
 *  desaparecer checklists que el operario ya dio por guardados. Las
 *  entradas quedan esperando a que su dueño vuelva a entrar. */
export async function limpiarCacheDeDatos(esperaMaxMs = 1500): Promise<boolean> {
  if (typeof caches === "undefined") return true;
  let terminada = false;
  const limpieza = (async () => {
    try {
      const nombres = await caches.keys();
      await Promise.all(
        nombres.filter((n) => n.startsWith(PREFIJO_CACHE_DATOS)).map((n) => caches.delete(n))
      );
      terminada = true;
    } catch {
      // Sin caches API utilizable: no se pudo confirmar el borrado.
    }
  })();
  // CacheStorage puede tardar mucho o no responder (visto en Firefox con la
  // máquina cargada): cerrar sesión no puede quedarse esperándolo, porque
  // `logout` recién saca al usuario DESPUÉS de esto y la pantalla seguía
  // mostrando la sesión ya cerrada en el servidor. Pasado el plazo se sigue; la
  // limpieza termina por su cuenta, y el próximo login es una acción humana que
  // llega mucho después.
  let plazo: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    limpieza,
    new Promise<void>((resolver) => {
      plazo = setTimeout(resolver, esperaMaxMs);
    }),
  ]);
  clearTimeout(plazo);
  return terminada;
}

const MARCA_TENANT = "erp-cache-tenant";

/** Las listas guardadas son de UN tenant. SALIR ya no las borra (quien sale
 *  tiene que poder volver a entrar sin señal y encontrarlas); lo que impide
 *  que se mezclen es esta marca: si entra alguien de otro tenant, o no se sabe
 *  de quién eran, se borran antes de usarlas. RLS protege la base, no el caché
 *  del navegador. */
export async function alinearCacheConTenant(tenantId: string): Promise<void> {
  try {
    if (localStorage.getItem(MARCA_TENANT) === tenantId) return;
  } catch {
    // Sin localStorage no se puede saber de quién es el caché: se limpia.
  }
  // La marca se escribe SOLO si el borrado terminó. Si venció el plazo, sin
  // marca se vuelve a intentar en la próxima entrada, y no se da por bueno un
  // caché de otra empresa.
  const borrado = await limpiarCacheDeDatos(10_000);
  if (!borrado) return;
  try {
    localStorage.setItem(MARCA_TENANT, tenantId);
  } catch {
    // nada que marcar
  }
}

// Si la sesión de la pantalla todavía no la confirmó el servidor (se entró sin
// señal con la clave local), la cola NO se drena: la cookie que viajaría puede
// ser de otra persona, y lo encolado quedaría firmado por ella.
let sesionConfirmada = true;

export function marcarSesionConfirmada(confirmada: boolean): void {
  sesionConfirmada = confirmada;
}

export function haySesionConfirmada(): boolean {
  return sesionConfirmada;
}
