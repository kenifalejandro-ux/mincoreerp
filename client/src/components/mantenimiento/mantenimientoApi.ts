// client/src/components/mantenimiento/mantenimientoApi.ts
//
// Lectura del ecosistema «Gestión de mantenimiento» (/api/erp/mantenimiento).
import { apiFetch } from "../../services/apiClient";

export interface EquipoMantenimiento {
  id: number;
  placa_codigo: string;
  tipo: string;
  marca: string | null;
  modelo: string | null;
  medidor: "horometro" | "odometro";
  lectura: number;
  propiedad: "propia" | "alquilada";
  area_id: number | null;
  area: string | null;
  /** Unidad creada sin ficha (por ejemplo desde Combustible): falta completar sus datos. */
  por_completar: boolean;
}

export interface ListaDeEquipos {
  equipos: EquipoMantenimiento[];
  tipos: string[];
  total: number;
}

/** Lo que el servidor devuelve cuando algo falla: un mensaje o la lista de campos inválidos. */
async function mensajeDeError(res: Response): Promise<string> {
  const data = await res.json().catch(() => ({}));
  return (
    data.errors?.[0]?.message ||
    data.message ||
    data.error ||
    `No se pudo guardar (HTTP ${res.status})`
  );
}

async function leer<T>(ruta: string): Promise<T> {
  const res = await apiFetch(`/api/erp/mantenimiento${ruta}`);
  if (!res.ok) throw new Error(await mensajeDeError(res));
  return (await res.json()) as T;
}

async function escribir<T>(
  metodo: "POST" | "PUT" | "PATCH" | "DELETE",
  ruta: string,
  cuerpo?: unknown
) {
  const res = await apiFetch(`/api/erp/mantenimiento${ruta}`, {
    method: metodo,
    headers: { "Content-Type": "application/json" },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  if (!res.ok) throw new Error(await mensajeDeError(res));
  return (await res.json()) as T;
}

export interface AreaMantenimiento {
  id: number;
  nombre: string;
  /** Equipos activos que tiene; con alguno no se puede quitar. */
  equipos: number;
}

/** Lo que se manda al registrar o editar un equipo. */
export interface DatosDeEquipo {
  placa_codigo: string;
  tipo: string;
  marca: string;
  modelo: string;
  medidor: "horometro" | "odometro";
  lectura: number;
  propiedad: "propia" | "alquilada";
  area_id: number | null;
}

export const listarEquipos = () => leer<ListaDeEquipos>("/equipos");
export const listarAreas = () => leer<AreaMantenimiento[]>("/areas");
/** `clienteUuid` se fija al abrir el formulario: un reintento (doble clic, mala señal) no crea otro equipo. */
export const crearEquipo = (datos: DatosDeEquipo, clienteUuid: string) =>
  escribir<EquipoMantenimiento>("POST", "/equipos", { ...datos, cliente_uuid: clienteUuid });
export const actualizarEquipo = (id: number, datos: DatosDeEquipo) =>
  escribir<EquipoMantenimiento>("PUT", `/equipos/${id}`, datos);
export const quitarEquipo = (id: number, motivo: string) =>
  escribir<{ ok: true }>("PATCH", `/equipos/${id}/quitar`, { motivo });
export const crearArea = (nombre: string) =>
  escribir<AreaMantenimiento>("POST", "/areas", { nombre });
export const quitarArea = (id: number) => escribir<{ ok: true }>("DELETE", `/areas/${id}`);

export interface ResumenMantenimiento {
  total: number;
  propios: number;
  alquilados: number;
  sin_area: number;
  areas: AreaMantenimiento[];
  /** Unidades que registró Operaciones (Flota) y Mantenimiento aún no completó. 0 sin Flota. */
  por_importar: number;
}
export const resumenMantenimiento = () => leer<ResumenMantenimiento>("/resumen");

/** Las unidades de Operaciones sin completar: comparten el maestro de equipos, solo les falta su área y su propiedad. */
export const listarPendientes = () =>
  leer<{ equipos: EquipoMantenimiento[] }>("/equipos/pendientes").then((d) => d.equipos);
/** Les da el área y la propiedad. Repetirla no hace nada (devuelve 0 completadas). */
export const completarEquipos = (datos: {
  ids: number[];
  propiedad: "propia" | "alquilada";
  area_id: number | null;
}) => escribir<{ completados: number; ids: number[] }>("POST", "/equipos/completar", datos);
