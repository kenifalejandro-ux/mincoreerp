// El viaje que el conductor creó SIN señal (0179): lo que se guarda en el celular mientras la cola no
// lo envía, para mostrarlo como «pendiente de enviar», y el último catálogo que se bajó con señal,
// para poder armar un viaje sin ella. Todo por usuario: un celular compartido no mezcla conductores.
import type { CatalogoViaje } from "./empezarViaje";
import type { FilaViaje } from "./viajesFormato";
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
  /** Lo necesario para mostrarlo como viaje en curso mientras la cola no lo envía. */
  paradas: { id: number | null; nombre: string }[];
  placa: string;
  tipoUnidad: string | null;
  tipoMedidor: "horometro" | "odometro" | null;
  conductorNombre: string;
  conductorDni: string;
  relevoNombre: string | null;
  /** El relevo no tiene cuenta (se anotó por su nombre): se podrá marcar «el relevo maneja». */
  relevoSinCuenta: boolean;
}

/** El viaje creado sin señal se identifica en el celular con este prefijo y su `id_cliente`: aún no
 *  tiene número del servidor. Sus marcas viajan por `/por-cliente/<id_cliente>/…`. */
export const PREFIJO_VIAJE_LOCAL = "cli:";
export const esViajeLocal = (id: string) => id.startsWith(PREFIJO_VIAJE_LOCAL);

/** La parte de la URL que identifica el viaje: su número, o `por-cliente/<id_cliente>` si aún no existe. */
export const rutaDeViaje = (id: string) =>
  esViajeLocal(id) ? `por-cliente/${id.slice(PREFIJO_VIAJE_LOCAL.length)}` : id;

/** El viaje que el conductor creó sin señal, tal como se ve en «Mi viaje»: en curso, con su salida
 *  ya marcada, para que pueda marcar llegadas, descansos y el cierre aunque el servidor aún no lo
 *  conozca. Las marcas quedan en la cola, después de la creación, y se envían en ese orden. */
export function filaDePendiente(p: CreacionPendiente) {
  const paradas = p.paradas.map((x, orden) => ({
    orden,
    lugar_id: x.id ?? 0,
    lugar: x.nombre,
    llegada_en: null,
    llegada_medidor: null,
    salida_en: orden === 0 ? p.marcadoEn : null,
    salida_medidor: orden === 0 ? p.odometro : null,
  }));
  const fila: FilaViaje & {
    combustible_gal: string;
    urea_l: string;
    previo: null;
    pendiente: boolean;
  } = {
    id: PREFIJO_VIAJE_LOCAL + p.idCliente,
    numero: 0,
    creado_por_conductor: true,
    equipo_id: 0,
    placa_codigo: p.placa,
    codigo_interno: null,
    equipo_tipo: p.tipoUnidad,
    tipo_medidor: p.tipoMedidor,
    conductor_nombre: p.conductorNombre,
    conductor_dni: p.conductorDni,
    relevo_dni: null,
    relevo_nombre: p.relevoNombre,
    relevo_sin_cuenta: p.relevoSinCuenta ? p.relevoNombre : null,
    manejo: [],
    volante_dni: p.conductorDni,
    turnos: null,
    entrega_pendiente: null,
    origen_id: String(paradas[0]?.lugar_id ?? 0),
    origen: paradas[0]?.lugar ?? "",
    destino_id: String(paradas[1]?.lugar_id ?? 0),
    destino: paradas[1]?.lugar ?? "",
    inicio_en: p.marcadoEn,
    fin_en: null,
    medidor_previo: null,
    medidor_inicio: String(p.odometro),
    medidor_fin: null,
    medidor_actual: String(p.odometro),
    salida_programada_en: null,
    desfase_tolerancia_min: 10,
    desfase_salida_min: null,
    recorrido: null,
    recorrido_sin_viaje: null,
    ruta_por_confirmar: false,
    inicio_origen_hora: "dispositivo",
    fin_origen_hora: null,
    nota_ruta: null,
    paradas,
    descansos: [],
    estado: "en_curso",
    observaciones: null,
    motivo_anulacion: null,
    cargas: "0",
    cantidad: "0",
    promedio_ruta_unidad: null,
    viajes_ruta_unidad: "0",
    promedio_ruta: null,
    viajes_ruta: "0",
    combustible_gal: "0",
    urea_l: "0",
    previo: null,
    pendiente: true,
  };
  return fila;
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
