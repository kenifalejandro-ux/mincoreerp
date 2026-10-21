// client/src/components/combustible/PendientesDeEnvio.tsx
//
// Lo registrado sin señal, mientras espera a sincronizarse. Se pone arriba de
// un historial: sin esto, la persona no ve su registro en ninguna parte y no
// sabe si quedó guardado. Al sincronizarse la entrada sale de la cola y pasa a
// la lista real del historial.

import { useEffect, useState } from "react";

import { listarPendientes, suscribirseACola } from "../../offline/offlineQueue";
import {
  pendientesDeLaCola,
  type AmbitoPendiente,
  type Pendiente,
} from "../../offline/pendientesCola";

function fechaCorta(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleString("es-PE", { dateStyle: "short", timeStyle: "short" });
}

export default function PendientesDeEnvio({ ambito }: { ambito: AmbitoPendiente }) {
  const [pendientes, setPendientes] = useState<Pendiente[]>([]);

  // La cola avisa cada vez que algo entra o sale: se relee entonces.
  useEffect(() => {
    let vivo = true;
    const desuscribir = suscribirseACola(() => {
      listarPendientes()
        .then((entradas) => {
          if (vivo) setPendientes(pendientesDeLaCola(entradas, ambito));
        })
        .catch(() => {});
    });
    return () => {
      vivo = false;
      desuscribir();
    };
  }, [ambito]);

  if (pendientes.length === 0) return null;

  return (
    <div
      role="status"
      className="m-4 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
    >
      <p className="font-semibold">
        Pendientes de enviar ({pendientes.length}): guardados en este equipo, se enviarán solos
        cuando vuelva la señal.
      </p>
      <ul className="mt-1 divide-y divide-amber-200">
        {pendientes.map((p) => (
          <li key={p.clienteUuid} className="flex flex-wrap items-baseline gap-x-3 py-1">
            <span className="font-mono">{p.titulo}</span>
            <span className="text-xs">{fechaCorta(p.fecha)}</span>
            {p.detalle && <span>{p.detalle}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
