// client/src/components/ordenes_trabajo/useCatalogosDeOrden.ts
//
// Las listas que usa el alta de una orden: unidades, IPERC y a quién se puede asignar.
import { useEffect, useState } from "react";

import { apiFetch } from "../../services/apiClient";

export interface CatalogosDeOrden {
  equipos: { id: number; placa_codigo: string }[];
  ipercs: { id: number; area_frente: string; estado: string }[];
  asignables: { id: string; nombre: string }[];
}

async function lista<T>(ruta: string): Promise<T[]> {
  try {
    const res = await apiFetch(ruta);
    const body = await res.json();
    const filas = Array.isArray(body) ? body : body.data;
    return res.ok && Array.isArray(filas) ? filas : [];
  } catch {
    return [];
  }
}

/** `soloMecanicos`: la oficina de Mantenimiento asigna solo al perfil Mecánico. `conAsignables` en falso para
 *  quien no puede escribir: no se pide a quién asignar. */
export function useCatalogosDeOrden({
  conUnidades,
  conIperc,
  soloMecanicos = false,
  conAsignables = true,
}: {
  conUnidades: boolean;
  conIperc: boolean;
  soloMecanicos?: boolean;
  conAsignables?: boolean;
}): CatalogosDeOrden {
  const [equipos, setEquipos] = useState<CatalogosDeOrden["equipos"]>([]);
  const [ipercs, setIpercs] = useState<CatalogosDeOrden["ipercs"]>([]);
  const [asignables, setAsignables] = useState<CatalogosDeOrden["asignables"]>([]);

  useEffect(() => {
    // Sin un módulo de unidades o sin IPERC no se pide su lista (el servidor la negaría).
    if (conUnidades)
      void lista("/api/erp/ordenes_trabajo/unidades").then((d) => setEquipos(d as never));
    if (conIperc) void lista("/api/erp/iperc?pageSize=200").then((d) => setIpercs(d as never));
    if (!conAsignables) return;
    const ruta = soloMecanicos ? "mecanicos" : "usuarios-asignables";
    void lista(`/api/erp/ordenes_trabajo/${ruta}`).then((d) => setAsignables(d as never));
  }, [conUnidades, conIperc, soloMecanicos, conAsignables]);

  return { equipos, ipercs, asignables };
}
