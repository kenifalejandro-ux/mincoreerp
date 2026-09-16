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

// ── Órdenes administrativas y doble firma ────────────────────────────────

export type EstadoDeOrden = "pendiente" | "aplicada" | "rechazada" | "vencida" | "fallida";

export interface OrdenAdministrativa {
  id: string;
  correlativo: string;
  tipo: string;
  estado: EstadoDeOrden;
  usuarioId: string | null;
  usuarioNombre: string | null;
  payload: Record<string, unknown>;
  antes: Record<string, unknown> | null;
  motivo: string;
  solicitanteId: string;
  solicitanteNombre: string;
  firmasRequeridas: number;
  aprobadorId: string | null;
  aprobadorNombre: string | null;
  motivoResolucion: string | null;
  resueltaEn: string | null;
  expiraEn: string;
  error: string | null;
  creadoEn: string;
}

export async function listarOrdenesApi(estado?: EstadoDeOrden): Promise<OrdenAdministrativa[]> {
  const query = estado ? `?estado=${estado}` : "";
  const data = await leerRespuesta(await apiFetch(`/api/erp/administracion/ordenes${query}`));
  return data.ordenes ?? [];
}

export async function aprobarOrdenApi(ordenId: string, motivo?: string): Promise<void> {
  await leerRespuesta(
    await apiFetch(`/api/erp/administracion/ordenes/${ordenId}/aprobar`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(motivo ? { motivo } : {}),
    })
  );
}

export async function rechazarOrdenApi(ordenId: string, motivo: string): Promise<void> {
  await leerRespuesta(
    await apiFetch(`/api/erp/administracion/ordenes/${ordenId}/rechazar`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ motivo }),
    })
  );
}

export async function estadoDobleFirmaApi(): Promise<{
  dobleFirma: boolean;
  administradoresActivos: number;
}> {
  return leerRespuesta(await apiFetch("/api/erp/administracion/doble-firma"));
}

/** Encenderla se aplica de una (endurecer); apagarla queda pendiente de la
 *  firma de otro administrador. */
export async function cambiarDobleFirmaApi(
  dobleFirma: boolean,
  motivo: string
): Promise<{ pendiente: true; orden: OrdenAdministrativa } | { pendiente: false }> {
  const data = await leerRespuesta(
    await apiFetch("/api/erp/administracion/doble-firma", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dobleFirma, motivo }),
    })
  );
  const orden = data.orden as OrdenAdministrativa | undefined;
  return orden?.estado === "pendiente" ? { pendiente: true, orden } : { pendiente: false };
}
