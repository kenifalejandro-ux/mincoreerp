// client/src/components/combustible/useAlertasCombustibleStream.ts
//
// Primer consumidor real del stream SSE del tenant del lado del cliente
// (GET /api/eventos/stream) -- hasta ahora esa infraestructura solo existía
// en el backend. El servidor manda el tipo del evento como `event:` SSE,
// no dentro de `data` (ver enviarEventoSSE en src/server/shared/utils/sse.ts),
// así que hace falta addEventListener por tipo, no el onmessage genérico.
//
// Solo se conecta si `activo` es true -- el llamador decide eso según rol
// (admin) y módulo habilitado, para no abrir el stream de nada para
// operador/lectura.

import { useCallback, useEffect, useRef, useState } from "react";

import { apiFetch } from "../../services/apiClient";

export interface AlertaCombustible {
  id: number;
  tipo:
    | "hueco_detectado"
    | "vale_anulado"
    | "sobredespacho"
    | "despacho_tardio"
    | "diferencia_recepcion"
    | "nivel_bajo"
    | "medidor_inconsistente"
    | "descuadre_inventario"
    | "descuadre_ciclo"
    | "tanque_sin_medir"
    | "vale_fuera_de_orden"
    | "lectura_retroactiva"
    | "tope_diario_excedido";
  // Nullable desde la migración 0073: las alertas de recepción y de nivel
  // no son sobre un vale, así que se anclan al tanque o a la recepción.
  serie_talonario: string | null;
  n_vale: number | null;
  despacho_id: number | null;
  combustible_id: number | null;
  recepcion_id: number | null;
  detalle: Record<string, unknown>;
  creado_en: string;
  leida_en: string | null;
  resuelta_en: string | null;
  resuelta_por: string | null;
}

interface RespuestaAlertas {
  data: AlertaCombustible[];
  pagination: { total: number };
}

export function useAlertasCombustibleStream(activo: boolean) {
  const [alertas, setAlertas] = useState<AlertaCombustible[]>([]);
  const [noLeidas, setNoLeidas] = useState(0);
  const eventSourceRef = useRef<EventSource | null>(null);

  const cargar = useCallback(async () => {
    try {
      const res = await apiFetch("/api/erp/combustible/alertas?solo_no_leidas=true&pageSize=10");
      if (!res.ok) return;
      const body: RespuestaAlertas = await res.json();
      setAlertas(body.data);
      setNoLeidas(body.pagination.total);
    } catch {
      // Sin red o el endpoint falló -- la campanita simplemente se queda
      // con el último valor conocido, no rompe nada mostrar un número viejo.
    }
  }, []);

  useEffect(() => {
    if (!activo) return;

    // Patrón estándar de carga al montar -- ver IpercView.tsx / CombustiblePanel.tsx.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargar();

    const es = new EventSource("/api/eventos/stream", { withCredentials: true });
    eventSourceRef.current = es;
    es.addEventListener("combustible.alerta_creada", () => {
      cargar();
    });

    // ── Por qué el stream no alcanza ────────────────────────────────────
    //
    // Durante semanas la campanita mostró un contador viejo y hubo que
    // recargar la página para ver alertas que ya existían en la base. El
    // servidor estaba bien (hay test que lo prueba: los eventos salen), así
    // que el corte estaba en el camino -- un proxy que bufferea, la pestaña
    // dormida, una conexión que se cayó y no volvió.
    //
    // La conclusión de fondo: para un módulo anti-fraude, el número de
    // alertas sin leer no puede depender de que un socket haya sobrevivido.
    // El stream queda como el camino RÁPIDO; estas dos redes lo respaldan.

    // 1. Al volver a la pestaña. Cubre el caso más común y más barato: el
    //    usuario estuvo en otra ventana mientras llegaba la alerta.
    const alVolver = () => {
      if (document.visibilityState === "visible") cargar();
    };
    document.addEventListener("visibilitychange", alVolver);
    window.addEventListener("focus", alVolver);

    // 2. Un repaso periódico, corra o no el stream. 60s es suficientemente
    //    lento para no pesar (una consulta paginada a 10 filas) y
    //    suficientemente rápido para que nadie tenga que recargar a mano.
    const repaso = setInterval(cargar, 60_000);

    return () => {
      es.close();
      eventSourceRef.current = null;
      document.removeEventListener("visibilitychange", alVolver);
      window.removeEventListener("focus", alVolver);
      clearInterval(repaso);
    };
  }, [activo, cargar]);

  /** Marca leídas SOLO las que están en pantalla, por id.
   *
   *  Antes mandaba un body vacío, que del lado del servidor significa "todas
   *  las no leídas del tenant". Kenif lo sufrió en vivo: una alerta de
   *  descuadre nació a las 03:13:39 y quedó marcada como leída a las
   *  03:13:48 -- nueve segundos, sin que él la hubiera visto nunca. Estaba
   *  limpiando los huecos viejos que sí tenía en pantalla.
   *
   *  Y como el estado de lectura es compartido entre todos los admins del
   *  tenant (migración 0068), ese clic también la ocultó para los demás.
   *
   *  Mandar los ids visibles hace que el botón signifique lo que dice: "vi
   *  estas". Lo que llegó después sigue sin leer, que es la verdad. */
  const marcarTodasLeidas = useCallback(async () => {
    const ids = alertas.map((a) => a.id);
    if (ids.length === 0) return;

    await apiFetch("/api/erp/combustible/alertas/leidas", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    await cargar();
  }, [alertas, cargar]);

  /** Marca leída UNA alerta: la que el usuario acaba de abrir. Abrir es
   *  verla, y eso sí justifica marcarla -- a diferencia del botón masivo,
   *  que marcaba cosas que nunca se mostraron. */
  const marcarUnaLeida = useCallback(
    async (id: number) => {
      await apiFetch("/api/erp/combustible/alertas/leidas", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [id] }),
      });
      await cargar();
    },
    [cargar]
  );

  return { alertas, noLeidas, marcarTodasLeidas, marcarUnaLeida, recargar: cargar };
}
