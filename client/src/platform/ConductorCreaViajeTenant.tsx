// client/src/platform/ConductorCreaViajeTenant.tsx
//
// Interruptor por empresa (migración 0179): que sus conductores puedan crear e iniciar su propio
// viaje desde el celular. Apagado por defecto; se enciende para la empresa que lo pida.

import { useState } from "react";

import { cambiarConductorCreaViajeApi } from "./platformApi";

export default function ConductorCreaViajeTenant({
  tenantId,
  inicial,
  onError,
  onCambio,
}: {
  tenantId: string;
  inicial: boolean;
  onError: (mensaje: string | null) => void;
  onCambio: () => void;
}) {
  const [activo, setActivo] = useState(inicial);
  const [guardando, setGuardando] = useState(false);

  async function cambiar(nuevo: boolean) {
    // Sin doble clic: mientras se guarda no se acepta otro cambio.
    if (guardando) return;
    onError(null);
    setGuardando(true);
    try {
      await cambiarConductorCreaViajeApi(tenantId, nuevo);
      setActivo(nuevo);
      onCambio();
    } catch (error) {
      onError(error instanceof Error ? error.message : "No se pudo guardar el cambio");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 mb-6">
      <h3 className="text-sm font-light text-slate-400 mb-3">Viajes: conductor</h3>
      <label className="flex items-start gap-3 text-sm text-slate-200">
        <input
          type="checkbox"
          checked={activo}
          disabled={guardando}
          onChange={(event) => void cambiar(event.target.checked)}
          className="mt-0.5 h-4 w-4 accent-lime-500"
        />
        <span>
          Los conductores pueden crear su propio viaje desde el celular
          <small className="block text-xs text-slate-500">
            Apagado por defecto. Con esto encendido, «Mi viaje» muestra «Empezar un viaje» a quien
            no tiene un viaje asignado ni en curso.
          </small>
        </span>
      </label>
    </div>
  );
}
