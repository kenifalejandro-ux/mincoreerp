// Precintos numerados (migración 0095): los datos que comparten la ventana
// de gestión, la varilla y la recepción. Separado de Precintos.tsx porque un
// archivo de componentes que además exporta hooks rompe el recargado en
// caliente de Vite (react-refresh/only-export-components).
import { useEffect, useState } from "react";

import { apiFetch } from "../../services/apiClient";

export interface PuntoPrecinto {
  id: number;
  nombre: string;
  se_abre_en_recepcion: boolean;
  activo: boolean;
  motivo_baja: string | null;
  numero_vigente: string | null;
  colocado_en: string | null;
  motivo_vigente: string | null;
  colocado_por: string | null;
}

/** Lo que se anota de un punto en la varilla: el número, o "no hay". */
export interface PrecintoVisto {
  numero: string;
  sinPrecinto: boolean;
}

export async function leerError(res: Response, porDefecto: string) {
  const body = await res.json().catch(() => ({}));
  return (body.error || body.errors?.[0]?.message || porDefecto) as string;
}

/** Los puntos de un tanque. `null` = no aplica (tanque sin precintos o sin
 *  tanque elegido). Si el GET falla sin red y no está en el caché del
 *  service worker, queda en `error`: el formulario lo dice en vez de dejar
 *  los campos vacíos y que el servidor rechace la varilla después.
 *
 *  `recargar` cambia un contador que vuelve a disparar el efecto: así el
 *  único setState vive después del await, nunca sincrónico en el efecto. */
export function usePuntosPrecinto(tanqueId: number | null, usaPrecintos: boolean) {
  const [estado, setEstado] = useState<{
    clave: string;
    puntos: PuntoPrecinto[] | null;
    error: string | null;
  }>({ clave: "", puntos: null, error: null });
  const [vuelta, setVuelta] = useState(0);
  const aplica = tanqueId !== null && usaPrecintos;
  const clave = `${tanqueId}-${vuelta}`;

  useEffect(() => {
    if (!aplica) return;
    let vigente = true;
    (async () => {
      try {
        const res = await apiFetch(`/api/erp/combustible/${tanqueId}/precintos`);
        if (!res.ok) throw new Error(await leerError(res, "No se pudieron cargar los precintos"));
        const puntos = (await res.json()) as PuntoPrecinto[];
        if (vigente) setEstado({ clave, puntos, error: null });
      } catch (e) {
        if (vigente) {
          setEstado({
            clave,
            puntos: null,
            error: e instanceof Error ? e.message : "No se pudieron cargar los precintos",
          });
        }
      }
    })();
    return () => {
      vigente = false;
    };
  }, [aplica, tanqueId, clave]);

  // Lo cargado para OTRO tanque no se muestra mientras llega el nuevo.
  const alDia = aplica && estado.clave.startsWith(`${tanqueId}-`);
  return {
    puntos: alDia ? estado.puntos : null,
    error: alDia ? estado.error : null,
    recargar: () => setVuelta((v) => v + 1),
  };
}

/** Los puntos que la varilla tiene que anotar: activos y con un sello
 *  registrado. */
export const puntosAVerificar = (puntos: PuntoPrecinto[] | null) =>
  (puntos ?? []).filter((p) => p.activo && p.numero_vigente !== null);
