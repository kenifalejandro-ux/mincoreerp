// El viaje que el conductor creó SIN señal (0179): lo que se guarda en el celular mientras la cola no
// lo envía, para mostrarlo como «pendiente de enviar», y el último catálogo que se bajó con señal,
// para poder armar un viaje sin ella. Todo por usuario: un celular compartido no mezcla conductores.
import type { CatalogoViaje } from "./empezarViaje";
import { listarPendientes } from "../../offline/offlineQueue";

export interface CreacionPendiente {
  /** Identificador del intento: el mismo de la cola (`cliente_uuid`). */
  idCliente: string;
  unidad: string;
  ruta: string;
  /** Cuándo tocó «Salir ahora» (la hora que vale para la salida). */
  marcadoEn: string;
  odometro: number;
  unidadNueva: boolean;
}

const clavePendiente = (usuarioId: string) => `mi-viaje-crea:${usuarioId}`;
const claveCatalogo = (usuarioId: string) => `mi-viaje-catalogo:${usuarioId}`;

function leer<T>(clave: string): T | null {
  try {
    const crudo = localStorage.getItem(clave);
    return crudo ? (JSON.parse(crudo) as T) : null;
  } catch {
    return null;
  }
}

function guardar(clave: string, valor: unknown) {
  try {
    if (valor === null) localStorage.removeItem(clave);
    else localStorage.setItem(clave, JSON.stringify(valor));
  } catch {
    // Sin almacenamiento (modo privado): solo se pierde la vista sin señal.
  }
}

export const leerPendiente = (usuarioId: string) =>
  leer<CreacionPendiente>(clavePendiente(usuarioId));
export const guardarPendiente = (usuarioId: string, p: CreacionPendiente | null) =>
  guardar(clavePendiente(usuarioId), p);
export const leerCatalogo = (usuarioId: string) => leer<CatalogoViaje>(claveCatalogo(usuarioId));
export const guardarCatalogo = (usuarioId: string, c: CatalogoViaje | null) =>
  guardar(claveCatalogo(usuarioId), c);

/** ¿Sigue esperando en la cola la creación de este viaje? */
export async function creacionEnCola(idCliente: string): Promise<boolean> {
  try {
    const cola = await listarPendientes();
    return cola.some((e) => e.clienteUuid === idCliente && /\/viajes\/crear-mio$/.test(e.url));
  } catch {
    // Sin acceso a la cola no se puede afirmar que ya salió: se deja el aviso.
    return true;
  }
}
