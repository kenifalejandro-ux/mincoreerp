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
  /** Calculado por el servidor al consultar la lista (M5). */
  estado?: EstadoDeUnidad;
  /** «Qué pasa»; null si está operativa. */
  motivo?: string | null;
}

export type EstadoDeUnidad = "detenida" | "en_mantenimiento" | "operativa";

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
  /** La meta de Configuración: tiñe cada área en el Centro. */
  meta_disponibilidad: number;
  estados: { operativas: number; en_mantenimiento: number; detenidas: number };
  /** Solo las áreas con equipos, por nombre; «sin área» al final. */
  estado_por_area: AreaDelCentro[];
  /** null si la persona no tiene Órdenes de trabajo. */
  ordenes: OrdenesDelCentro | null;
  /** null si la persona no tiene Checklists. */
  checklists: ChecklistsDelCentro | null;
}

export interface UnidadDelCentro {
  id: number;
  placa: string;
  estado: EstadoDeUnidad;
  alquilada: boolean;
}
export interface AreaDelCentro {
  area_id: number | null;
  nombre: string | null;
  unidades: UnidadDelCentro[];
}
/** Cuántos casos hay y los primeros que se nombran. */
export interface Aviso<T> {
  total: number;
  casos: T[];
}
export interface OrdenSinMecanico {
  id: number;
  unidad: string | null;
  titulo: string;
  urgente: boolean;
}
export interface OrdenesDelCentro {
  abiertas: number;
  urgentes: number;
  sin_mecanico: Aviso<OrdenSinMecanico> & { urgentes: number };
  del_mes: { correctivo: number; preventivo: number };
}
export interface ChecklistDelCentro {
  id: number;
  unidad: string | null;
  fallas: string | null;
}
export interface ChecklistsDelCentro {
  hechos_hoy: number;
  sin_checklist_hoy: Aviso<string>;
  no_aptos_hoy: Aviso<ChecklistDelCentro>;
  por_autorizar: Aviso<ChecklistDelCentro>;
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

/** Las reglas y metas de la empresa. Se guardan; todavía no actúan (ver configMantenimiento.ts). */
export interface ConfigMantenimiento {
  ot_de_hallazgo: boolean;
  bloquea_sin_iperc: boolean;
  alerta_repuestos: boolean;
  exige_conformidad: boolean;
  meta_disponibilidad: number;
  meta_preventivo: number;
  meta_mttr_horas: number;
  meta_mtbf_horas: number;
}
export const leerConfig = () => leer<ConfigMantenimiento>("/config");
/** Se manda solo lo que cambia; devuelve cómo quedó. Solo el admin. */
export const guardarConfig = (cambios: Partial<ConfigMantenimiento>) =>
  escribir<ConfigMantenimiento>("PUT", "/config", cambios);
