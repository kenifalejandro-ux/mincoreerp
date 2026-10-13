// client/src/components/bandeja/useContadorBandeja.ts
//
// El número al lado de "Bandeja" en el menú, como el de correos sin leer.
//
// Cuenta las PENDIENTES (sin resolver), no las sin leer: la lectura es
// compartida (migración 0068), así que si un admin abre una alerta el "sin
// leer" bajaría para todos, también para el operador que todavía no la vio. En
// un módulo anti-fraude lo que importa es lo que nadie cerró. Va en rojo si
// alguna pendiente es crítica (las que salen por correo al momento).
//
// Reemplaza a la franja roja "Hay N hallazgos sin resolver" de Tanques: el
// operador no tiene campanita, así que este número es su aviso.

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../services/apiClient";
import { suscribirseAlStreamDeAlertas } from "../combustible/streamDeAlertas";

export function useContadorBandeja(activo: boolean) {
  const [pendientes, setPendientes] = useState(0);
  const [criticas, setCriticas] = useState(0);

  const cargar = useCallback(async () => {
    try {
      const res = await apiFetch("/api/erp/combustible/alertas/resumen");
      if (!res.ok) return;
      const r: { pendientes: number; criticasPendientes: number } = await res.json();
      setPendientes(r.pendientes);
      setCriticas(r.criticasPendientes);
    } catch {
      // Sin red se queda el último número: no rompe el menú.
    }
  }, []);

  useEffect(() => {
    if (!activo) return;
    // Carga al montar: es carga de datos, el caso para el que existe el efecto.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void cargar();
    // La misma conexión en vivo que la campanita y la Bandeja, no otra.
    const darDeBaja = suscribirseAlStreamDeAlertas(cargar);
    const alActualizar = () => void cargar();
    window.addEventListener("combustible:actualizado", alActualizar);
    // El stream es el camino rápido; el número no puede depender de que el
    // socket haya sobrevivido (mismo criterio que la campanita).
    const alVolver = () => {
      if (document.visibilityState === "visible") void cargar();
    };
    document.addEventListener("visibilitychange", alVolver);
    const repaso = setInterval(cargar, 60_000);
    return () => {
      darDeBaja();
      window.removeEventListener("combustible:actualizado", alActualizar);
      document.removeEventListener("visibilitychange", alVolver);
      clearInterval(repaso);
    };
  }, [activo, cargar]);

  return { pendientes, criticas };
}
