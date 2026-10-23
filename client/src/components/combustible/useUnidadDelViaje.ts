// client/src/components/combustible/useUnidadDelViaje.ts
//
// La unidad del viaje del conductor, para precargar y bloquear "Compra en ruta".
// Sin viaje (o para otro rol) devuelve null y el formulario queda manual.
//
// - Sin señal usa la última unidad vista en este dispositivo (por usuario).
// - Si el encargado corrige el viaje con la pantalla abierta, el evento
//   `combustible.viaje_actualizado` vuelve a pedirla y se deja un aviso.
// - Escucha por la conexión compartida (streamDeAlertas.ts): no abre otra.

import { useCallback, useEffect, useRef, useState } from "react";

import { suscribirseAEventos } from "./streamDeAlertas";
import { apiFetch } from "../../services/apiClient";

export interface UnidadDelViaje {
  equipo_id: number;
  placa_codigo: string;
}

const claveCache = (usuarioId: string) => `unidad-viaje:${usuarioId}`;

function leerCache(usuarioId: string | undefined): UnidadDelViaje | null {
  if (!usuarioId) return null;
  try {
    const crudo = localStorage.getItem(claveCache(usuarioId));
    return crudo ? (JSON.parse(crudo) as UnidadDelViaje) : null;
  } catch {
    return null;
  }
}

function guardarCache(usuarioId: string, unidad: UnidadDelViaje | null) {
  try {
    if (unidad) localStorage.setItem(claveCache(usuarioId), JSON.stringify(unidad));
    else localStorage.removeItem(claveCache(usuarioId));
  } catch {
    // Sin almacenamiento (modo privado): solo se pierde la vista sin señal.
  }
}

export function useUnidadDelViaje(activo: boolean, usuarioId: string | undefined) {
  const [unidad, setUnidad] = useState<UnidadDelViaje | null>(() =>
    activo ? leerCache(usuarioId) : null
  );
  const [aviso, setAviso] = useState<string | null>(null);
  // Qué unidad había antes de la última respuesta del servidor (undefined = no
  // se sabe: primera vez en este dispositivo). Sirve para avisar solo cuando
  // algo CAMBIÓ, no al abrir.
  const anterior = useRef<number | null | undefined>(
    activo ? (leerCache(usuarioId)?.equipo_id ?? undefined) : undefined
  );

  const cargar = useCallback(async () => {
    if (!usuarioId) return;
    try {
      const res = await apiFetch("/api/erp/combustible/viajes/mi-unidad");
      if (!res.ok) return;
      const body = await res.json().catch(() => null);
      const d = body?.data;
      const nueva: UnidadDelViaje | null = d
        ? { equipo_id: Number(d.equipo_id), placa_codigo: String(d.placa_codigo) }
        : null;
      const antes = anterior.current;
      anterior.current = nueva?.equipo_id ?? null;
      guardarCache(usuarioId, nueva);
      setUnidad(nueva);
      if (antes !== undefined && antes !== (nueva?.equipo_id ?? null)) {
        setAviso(
          nueva
            ? `Tu viaje cambió: la unidad ahora es ${nueva.placa_codigo}.`
            : "Ya no tienes un viaje asignado: elige la unidad."
        );
      }
    } catch {
      // Sin señal: se queda con la última unidad conocida.
    }
  }, [usuarioId]);

  useEffect(() => {
    if (!activo) return;
    // Patrón estándar de carga al montar -- ver IpercView.tsx.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void cargar();
    const darDeBaja = suscribirseAEventos(["combustible.viaje_actualizado"], () => void cargar());
    const alVolver = () => void cargar();
    window.addEventListener("online", alVolver);
    return () => {
      darDeBaja();
      window.removeEventListener("online", alVolver);
    };
  }, [activo, cargar]);

  const cerrarAviso = useCallback(() => setAviso(null), []);
  return { unidad: activo ? unidad : null, aviso, cerrarAviso };
}
