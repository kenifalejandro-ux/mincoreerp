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

import { useAuth } from "../../context/AuthContext";
import { apiFetch } from "../../services/apiClient";
import { MODULOS_CON_BANDEJA } from "../bandeja/bandejaAcceso";
import { suscribirseAlStreamDeAlertas } from "../combustible/streamDeAlertas";

/** El resumen de cada Bandeja: la de Combustible y la de Viajes (0188), una por tabla. */
const RESUMEN_DE_FUENTE: Record<string, string> = {
  combustible: "/api/erp/combustible/alertas/resumen",
  viajes: "/api/erp/viajes/alertas/resumen",
};

export function useContadorBandeja(activo: boolean) {
  const { usuario } = useAuth();
  const [pendientes, setPendientes] = useState(0);
  const [criticas, setCriticas] = useState(0);
  // Solo las fuentes que esta persona ve: sumar la de un módulo que no tiene daría 403.
  const fuentes = usuario
    ? MODULOS_CON_BANDEJA.filter((m) => m.visiblePara(usuario)).map((m) => m.id)
    : [];
  const claveDeFuentes = fuentes.join(",");

  const cargar = useCallback(async () => {
    try {
      let p = 0;
      let c = 0;
      for (const id of claveDeFuentes.split(",").filter(Boolean)) {
        const res = await apiFetch(RESUMEN_DE_FUENTE[id]);
        if (!res.ok) continue;
        const r: { pendientes: number; criticasPendientes: number } = await res.json();
        p += r.pendientes;
        c += r.criticasPendientes;
      }
      setPendientes(p);
      setCriticas(c);
    } catch {
      // Sin red se queda el último número: no rompe el menú.
    }
  }, [claveDeFuentes]);

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
