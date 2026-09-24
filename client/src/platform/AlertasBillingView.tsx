// client/src/platform/AlertasBillingView.tsx
//
// Vencidas/fallidas/próximas de TODOS los tenants en una sola pantalla --
// ver obtenerAlertasBillingService(). Sin esto, saber quién debe o a quién
// le rebotó la tarjeta significaba entrar tenant por tenant a revisar la
// sección "Suscripción y cobro" de cada uno.

import { useEffect, useState } from "react";

import {
  obtenerAlertasBillingApi,
  procesarVencimientosBillingApi,
  type AlertaBilling,
  type AlertasBilling,
  type ResultadoProcesarVencimientos,
} from "./platformApi";

function fecha(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString() : "—";
}

function FilaAlerta({
  alerta,
  onSeleccionarTenant,
}: {
  alerta: AlertaBilling;
  onSeleccionarTenant: (tenantId: string) => void;
}) {
  return (
    <tr className="border-t border-slate-800 text-slate-300">
      <td className="px-4 py-3">
        <button
          onClick={() => onSeleccionarTenant(alerta.tenantId)}
          className="text-slate-100 hover:underline underline-offset-2"
        >
          {alerta.tenantNombre}
        </button>
        <span className="block text-xs text-slate-500">{alerta.tenantSlug}</span>
      </td>
      <td className="px-4 py-3 text-xs text-slate-500">
        {alerta.tipo === "suscripcion" ? "Suscripción" : "Implementación"}
        {alerta.descripcion && <span> · {alerta.descripcion}</span>}
      </td>
      <td className="px-4 py-3">
        {alerta.moneda} {alerta.monto.toFixed(2)}
        {alerta.saldo > 0 && alerta.saldo < alerta.monto && (
          <span className="block text-xs text-amber-400">
            Saldo {alerta.moneda} {alerta.saldo.toFixed(2)}
          </span>
        )}
      </td>
      <td className="px-4 py-3 text-xs text-slate-500">
        {alerta.motivoFallo ?? fecha(alerta.fechaVencimiento)}
      </td>
      {alerta.diasAtraso > 0 && (
        <td className="px-4 py-3 text-xs text-red-400">
          {alerta.diasAtraso} {alerta.diasAtraso === 1 ? "día" : "días"} de atraso
        </td>
      )}
    </tr>
  );
}

function TablaAlertas({
  titulo,
  descripcion,
  alertas,
  columnaExtra,
  onSeleccionarTenant,
}: {
  titulo: string;
  descripcion: string;
  alertas: AlertaBilling[];
  columnaExtra: string;
  onSeleccionarTenant: (tenantId: string) => void;
}) {
  return (
    <div className="mb-8">
      <h3 className="text-sm text-slate-200 mb-1">
        {titulo} <span className="text-slate-500">({alertas.length})</span>
      </h3>
      <p className="text-xs text-slate-500 mb-3">{descripcion}</p>
      {alertas.length === 0 ? (
        <p className="text-sm text-slate-600 border border-slate-800 rounded-xl px-4 py-6 text-center">
          Nada acá.
        </p>
      ) : (
        <div className="border border-slate-800 rounded-xl overflow-hidden overflow-x-auto">
          <table className="w-full min-w-max text-sm">
            <thead>
              <tr className="bg-slate-900 text-slate-400 text-left">
                <th className="px-4 py-3 font-light">Tenant</th>
                <th className="px-4 py-3 font-light">Cobro</th>
                <th className="px-4 py-3 font-light">Monto</th>
                <th className="px-4 py-3 font-light">{columnaExtra}</th>
                {alertas.some((a) => a.diasAtraso > 0) && (
                  <th className="px-4 py-3 font-light">Atraso</th>
                )}
              </tr>
            </thead>
            <tbody>
              {alertas.map((a) => (
                <FilaAlerta key={a.cobroId} alerta={a} onSeleccionarTenant={onSeleccionarTenant} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function AlertasBillingView({
  onSeleccionarTenant,
}: {
  onSeleccionarTenant: (tenantId: string) => void;
}) {
  const [alertas, setAlertas] = useState<AlertasBilling | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ejecutando, setEjecutando] = useState(false);
  const [resultadoMotor, setResultadoMotor] = useState<ResultadoProcesarVencimientos | null>(null);

  async function cargar() {
    setCargando(true);
    try {
      setAlertas(await obtenerAlertasBillingApi());
      setError(null);
    } catch (err: any) {
      setError(err.message || "No se pudieron cargar las alertas de billing");
    } finally {
      setCargando(false);
    }
  }

  async function ejecutarMotor() {
    setEjecutando(true);
    try {
      setResultadoMotor(await procesarVencimientosBillingApi());
      setError(null);
      await cargar();
    } catch (err: any) {
      setError(err.message || "No se pudo ejecutar el motor de facturación");
    } finally {
      setEjecutando(false);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargar();
  }, []);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
        <h2 className="text-lg font-light text-slate-100">Alertas de billing</h2>
        <div className="flex items-center gap-3">
          <button
            onClick={ejecutarMotor}
            disabled={ejecutando}
            title="Corre el mismo motor que el cron diario: genera cobros próximos a vencer, cobra tarjetas vencidas, mueve a gracia/suspendida lo que corresponda. Para TODOS los tenants."
            className="px-3 py-1.5 rounded-lg bg-slate-100 text-slate-900 text-xs font-medium hover:bg-white disabled:opacity-50 transition-colors"
          >
            {ejecutando ? "Ejecutando..." : "▶ Ejecutar motor de facturación ahora"}
          </button>
          <button
            onClick={cargar}
            disabled={cargando}
            className="text-xs text-slate-500 hover:text-slate-300 underline underline-offset-2 disabled:opacity-50"
          >
            {cargando ? "Actualizando..." : "Actualizar"}
          </button>
        </div>
      </div>
      <p className="text-xs text-slate-500 mb-3">
        Cruza todos los tenants -- lo que necesita tu atención sin tener que entrar uno por uno.
      </p>

      {resultadoMotor && (
        <p className="text-sm text-emerald-400 bg-emerald-950/40 border border-emerald-900 rounded-lg px-3 py-2 mb-4">
          ✓ Motor ejecutado: {resultadoMotor.cobrosGenerados} cobro(s) generado(s) ·{" "}
          {resultadoMotor.cobrosAutomaticosExitosos} cobro(s) automático(s) exitoso(s) ·{" "}
          {resultadoMotor.cobrosAutomaticosFallidos} fallido(s) · {resultadoMotor.entraronEnGracia}{" "}
          entraron en gracia · {resultadoMotor.suspendidas} suspendida(s)
        </p>
      )}

      {error && (
        <p className="text-sm text-red-400 bg-red-950/40 border border-red-900 rounded-lg px-3 py-2 mb-4">
          {error}
        </p>
      )}

      {cargando && !alertas ? (
        <p className="text-sm text-slate-400">Cargando...</p>
      ) : (
        alertas && (
          <>
            <TablaAlertas
              titulo="Vencidas"
              descripcion="Cobros pendientes cuya fecha de vencimiento ya pasó -- transferencia sin confirmar, o tarjeta que todavía no se intentó cobrar."
              alertas={alertas.vencidas}
              columnaExtra="Venció"
              onSeleccionarTenant={onSeleccionarTenant}
            />
            <TablaAlertas
              titulo="Tarjeta rechazada"
              descripcion="Intentos de cobro automático que fallaron en los últimos 30 días y todavía no se resolvieron con un cobro exitoso."
              alertas={alertas.fallidas}
              columnaExtra="Motivo"
              onSeleccionarTenant={onSeleccionarTenant}
            />
            <TablaAlertas
              titulo="Próximas a vencer"
              descripcion="Renovaciones ya generadas que vencen en los próximos días -- para saber con anticipación, no enterarte cuando ya venció."
              alertas={alertas.proximas}
              columnaExtra="Vence"
              onSeleccionarTenant={onSeleccionarTenant}
            />
          </>
        )
      )}
    </div>
  );
}
