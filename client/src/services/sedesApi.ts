// client/src/services/sedesApi.ts
//
// Sedes y grifos internos (migración 0097). La lista la lee cualquier usuario
// (los formularios de tanque y de equipo arman su selector con ella); crear,
// renombrar, dar de baja y reactivar exige rol admin del lado del servidor.

import { apiFetch } from "./apiClient";

async function leerRespuesta(res: Response) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      data.errors?.[0]?.message ||
        data.error ||
        data.message ||
        `No se pudo completar (HTTP ${res.status})`
    );
  }
  return data;
}

export interface GrifoInterno {
  id: number;
  sede_id: number;
  nombre: string;
  activo: boolean;
  motivo_baja: string | null;
  tanques_activos: number;
  equipos_activos: number;
}

export interface Sede {
  id: number;
  nombre: string;
  activo: boolean;
  motivo_baja: string | null;
  grifos: GrifoInterno[];
}

export interface MovimientoDeGrifo {
  id: string;
  movido_en: string;
  motivo: string;
  grifo_origen: string | null;
  sede_origen: string | null;
  grifo_destino: string;
  sede_destino: string;
  usuario: string | null;
}

export async function listarSedesApi(): Promise<Sede[]> {
  return (await leerRespuesta(await apiFetch("/api/erp/sedes"))).sedes ?? [];
}

const enviar = async (url: string, metodo: "POST" | "PUT" | "PATCH", cuerpo: object) =>
  leerRespuesta(
    await apiFetch(url, {
      method: metodo,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cuerpo),
    })
  );

const BASE = "/api/erp/administracion";

export const crearSedeApi = (nombre: string) => enviar(`${BASE}/sedes`, "POST", { nombre });
export const renombrarSedeApi = (id: number, nombre: string) =>
  enviar(`${BASE}/sedes/${id}`, "PUT", { nombre });
export const bajaSedeApi = (id: number, motivo: string) =>
  enviar(`${BASE}/sedes/${id}/baja`, "PATCH", { motivo });
export const reactivarSedeApi = (id: number, motivo: string) =>
  enviar(`${BASE}/sedes/${id}/reactivar`, "PATCH", { motivo });

export const crearGrifoApi = (sedeId: number, nombre: string) =>
  enviar(`${BASE}/grifos`, "POST", { sede_id: sedeId, nombre });
export const renombrarGrifoApi = (id: number, nombre: string) =>
  enviar(`${BASE}/grifos/${id}`, "PUT", { nombre });
export const bajaGrifoApi = (id: number, motivo: string) =>
  enviar(`${BASE}/grifos/${id}/baja`, "PATCH", { motivo });
export const reactivarGrifoApi = (id: number, motivo: string) =>
  enviar(`${BASE}/grifos/${id}/reactivar`, "PATCH", { motivo });

/** Tanque o equipo: cada uno vive en su módulo. */
const rutaDe = (que: "tanque" | "equipo", id: number) =>
  que === "tanque" ? `/api/erp/combustible/${id}` : `/api/erp/equipos/${id}`;

export const moverDeGrifoApi = (
  que: "tanque" | "equipo",
  id: number,
  grifoId: number,
  motivo: string
) => enviar(`${rutaDe(que, id)}/mover-grifo`, "POST", { grifo_interno_id: grifoId, motivo });

export async function listarMovimientosDeGrifoApi(
  que: "tanque" | "equipo",
  id: number
): Promise<MovimientoDeGrifo[]> {
  return leerRespuesta(await apiFetch(`${rutaDe(que, id)}/movimientos-grifo`));
}
