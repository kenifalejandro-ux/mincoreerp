// client/src/services/administracionApi.ts
//
// El menú Administración de la empresa: log de eventos y órdenes. Los
// usuarios y sus autonomías viven en usuariosApi.ts, que ya existía.
//
// Todo esto exige rol admin del lado del servidor; acá no se replica el
// control, solo se evita mostrar puertas cerradas.

import { apiFetch } from "./apiClient";

async function leerRespuesta(res: Response) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      data.errors?.[0]?.message || data.message || `No se pudo completar (HTTP ${res.status})`
    );
  }
  return data;
}

export interface EventoDeBitacora {
  id: string;
  accion: string;
  creadoEn: string;
  actor: string;
  actorTipo: string;
  usuarioId: string | null;
  usuarioNombre: string | null;
  resultado: string;
  detalle: Record<string, unknown> | null;
  ip: string | null;
}

export interface PaginaDeEventos {
  eventos: EventoDeBitacora[];
  /** Cursor para "ver más", o null si no hay más. */
  siguiente: string | null;
}

export async function listarEventosApi(filtro: {
  desde?: string;
  hasta?: string;
  accion?: string;
  usuarioId?: string;
  antesDe?: string;
}): Promise<PaginaDeEventos> {
  const params = new URLSearchParams();
  for (const [clave, valor] of Object.entries(filtro)) {
    if (valor) params.set(clave, valor);
  }
  const query = params.toString();
  return leerRespuesta(
    await apiFetch(`/api/erp/administracion/eventos${query ? `?${query}` : ""}`)
  );
}

export async function accionesDeBitacoraApi(): Promise<string[]> {
  const data = await leerRespuesta(await apiFetch("/api/erp/administracion/eventos/acciones"));
  return data.acciones ?? [];
}
