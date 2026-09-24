// client/src/platform/PlanYCuotasTenant.tsx
//
// Plan del tenant + uso real de cada cuota. Se muestran juntos a propósito:
// un límite solo se interpreta contra el consumo real, y el plan solo se
// entiende viendo qué límites impone. Ver docs/architecture/cuotas-por-tenant.md.
import { useEffect, useState } from "react";

import {
  listarPlanesApi,
  obtenerPlanDeTenantApi,
  asignarPlanTenantApi,
  obtenerCuotasTenantApi,
  fijarCuotaTenantApi,
  type Plan,
  type PlanDeTenant,
  type EstadoCuota,
} from "./platformApi";

const ETIQUETA_ORIGEN: Record<EstadoCuota["origen"], string> = {
  override: "excepción",
  plan: "plan",
  registry: "default",
};

function formatearBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const unidades = ["KiB", "MiB", "GiB", "TiB"];
  let valor = n / 1024;
  let i = 0;
  while (valor >= 1024 && i < unidades.length - 1) {
    valor /= 1024;
    i++;
  }
  return `${valor.toFixed(valor < 10 ? 1 : 0)} ${unidades[i]}`;
}

function formatearValor(valor: number, unidad: EstadoCuota["unidad"]): string {
  return unidad === "bytes" ? formatearBytes(valor) : valor.toLocaleString("es");
}

export default function PlanYCuotasTenant({
  tenantId,
  onError,
}: {
  tenantId: string;
  onError: (mensaje: string) => void;
}) {
  const [planes, setPlanes] = useState<Plan[]>([]);
  const [planActual, setPlanActual] = useState<PlanDeTenant | null>(null);
  const [cuotas, setCuotas] = useState<EstadoCuota[]>([]);
  const [guardando, setGuardando] = useState(false);
  const [editando, setEditando] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  useEffect(() => {
    let cancelado = false;
    (async () => {
      try {
        // soloActivos: un plan dado de baja no se ofrece para asignar, pero
        // el tenant que ya lo tenga lo conserva (ver la migración 0034).
        const [p, actual, c] = await Promise.all([
          listarPlanesApi(true),
          obtenerPlanDeTenantApi(tenantId),
          obtenerCuotasTenantApi(tenantId),
        ]);
        if (cancelado) return;
        setPlanes(p);
        setPlanActual(actual);
        setCuotas(c);
      } catch (err) {
        if (!cancelado)
          onError(err instanceof Error ? err.message : "No se pudieron cargar plan y cuotas");
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [tenantId, onError]);

  async function cambiarPlan(codigo: string) {
    setGuardando(true);
    setAviso(null);
    try {
      const { plan, recursosExcedidos } = await asignarPlanTenantApi(tenantId, codigo || null);
      setPlanActual(plan);
      setCuotas(await obtenerCuotasTenantApi(tenantId));

      // Bajar de plan NO borra nada, pero deja al cliente sin poder crear
      // hasta que baje volumen o vuelva a subir. Avisarlo acá evita que
      // aparezca después como creaciones rechazadas sin explicación.
      if (recursosExcedidos.length > 0) {
        setAviso(
          `El tenant quedó por encima del límite en: ${recursosExcedidos.join(", ")}. ` +
            `No se borró nada, pero no va a poder crear nuevos registros de esos recursos.`
        );
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : "No se pudo cambiar el plan");
    } finally {
      setGuardando(false);
    }
  }

  async function guardarOverride(recurso: string, texto: string) {
    setEditando(null);
    const limpio = texto.trim().toLowerCase();
    // "" → borra el override (vuelve al plan/registry); "ilimitado" → null.
    const limite = limpio === "" ? undefined : limpio === "ilimitado" ? null : Number(limpio);
    if (limite !== undefined && limite !== null && (!Number.isFinite(limite) || limite < 0)) {
      onError(
        `Valor inválido para ${recurso}: usá un número, "ilimitado", o vacío para volver al plan`
      );
      return;
    }

    setGuardando(true);
    try {
      setCuotas(await fijarCuotaTenantApi(tenantId, recurso, limite));
    } catch (err) {
      onError(err instanceof Error ? err.message : "No se pudo guardar la cuota");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <section className="border border-slate-700 rounded-xl p-4 space-y-4">
      <div className="flex items-center justify-between gap-4">
        <h3 className="text-sm font-medium text-slate-100">Plan y cuotas</h3>
        <select
          className="bg-[#1D2124] border border-slate-600 rounded-lg px-3 py-1.5 text-sm text-slate-100"
          value={planActual?.codigo ?? ""}
          disabled={guardando}
          onChange={(e) => cambiarPlan(e.target.value)}
        >
          <option value="">Sin plan (defaults)</option>
          {planes.map((p) => (
            <option key={p.id} value={p.codigo}>
              {p.nombre}
            </option>
          ))}
        </select>
      </div>

      {aviso && (
        <p className="text-xs text-amber-300 bg-amber-950/40 border border-amber-800 rounded-lg px-3 py-2">
          {aviso}
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-max text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-400 uppercase tracking-wide">
              <th className="pb-2 font-medium">Recurso</th>
              <th className="pb-2 font-medium">Uso</th>
              <th className="pb-2 font-medium">Límite</th>
              <th className="pb-2 font-medium">Origen</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {cuotas.map((c) => (
              <tr key={c.recurso} className={c.excedido ? "text-red-300" : "text-slate-200"}>
                <td className="py-2">{c.recurso}</td>
                <td className="py-2 tabular-nums">
                  {formatearValor(c.uso, c.unidad)}
                  {c.porcentaje !== null && (
                    <span
                      className={`ml-2 text-xs ${c.porcentaje >= 80 ? "text-amber-400" : "text-slate-500"}`}
                    >
                      {c.porcentaje}%
                    </span>
                  )}
                </td>
                <td className="py-2 tabular-nums">
                  {editando === c.recurso ? (
                    <input
                      autoFocus
                      defaultValue={c.limite === null ? "ilimitado" : String(c.limite)}
                      placeholder='número, "ilimitado", o vacío'
                      className="w-40 bg-[#1D2124] border border-slate-600 rounded px-2 py-1 text-sm"
                      onBlur={(e) => guardarOverride(c.recurso, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                        if (e.key === "Escape") setEditando(null);
                      }}
                    />
                  ) : (
                    <button
                      className="hover:underline decoration-dotted"
                      title="Fijar una excepción para este tenant. Vaciar el campo devuelve el control al plan."
                      onClick={() => setEditando(c.recurso)}
                    >
                      {c.limite === null ? "ilimitado" : formatearValor(c.limite, c.unidad)}
                    </button>
                  )}
                </td>
                <td className="py-2">
                  <span
                    className={`text-xs px-2 py-0.5 rounded ${
                      c.origen === "override"
                        ? "bg-blue-950 text-blue-300"
                        : c.origen === "plan"
                          ? "bg-slate-800 text-slate-300"
                          : "bg-transparent text-slate-500"
                    }`}
                  >
                    {ETIQUETA_ORIGEN[c.origen]}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-slate-500">
        Las cuotas solo bloquean la creación de registros nuevos: nunca borran ni ocultan datos ya
        cargados, y leer y borrar siguen funcionando aunque el tenant esté excedido.
      </p>
    </section>
  );
}
