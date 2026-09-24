// client/src/platform/AuditoriaView.tsx

import { useEffect, useState, type FormEvent } from "react";

import { listarAuditoriaApi, type EntradaAuditoria } from "./platformApi";

const ACCIONES = [
  "crear_tenant",
  "cambiar_estado_tenant",
  "actualizar_modulos_tenant",
  "actualizar_dominio_tenant",
  "crear_usuario",
  "cambiar_estado_usuario",
  "actualizar_modulos_usuario",
  "platform.session.started",
  "platform.session.ended",
  "platform.session.rechazada",
  "platform.session.revocada",
  "crear_platform_admin",
  "cambiar_estado_platform_admin",
];

/** Extrae `motivo` de `detalle` cuando existe (cambiar_estado_tenant /
 *  cambiar_estado_usuario) — el resto de las acciones no lo tienen. */
function motivoDe(detalle: unknown): string | null {
  if (detalle && typeof detalle === "object" && "motivo" in detalle) {
    const valor = (detalle as { motivo?: unknown }).motivo;
    return typeof valor === "string" ? valor : null;
  }
  return null;
}

interface Filtros {
  accion: string;
  resultado: "" | "success" | "failure";
  sessionId: string;
  actorId: string;
  desde: string;
  hasta: string;
}

const FILTROS_VACIOS: Filtros = {
  accion: "",
  resultado: "",
  sessionId: "",
  actorId: "",
  desde: "",
  hasta: "",
};

export default function AuditoriaView() {
  const [filtros, setFiltros] = useState<Filtros>(FILTROS_VACIOS);
  const [entradas, setEntradas] = useState<EntradaAuditoria[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);
  const [cargandoMas, setCargandoMas] = useState(false);

  async function cargar(reiniciar: boolean, cursorActual: string | null) {
    (reiniciar ? setCargando : setCargandoMas)(true);
    try {
      const pagina = await listarAuditoriaApi({
        accion: filtros.accion || undefined,
        resultado: filtros.resultado || undefined,
        sessionId: filtros.sessionId || undefined,
        actorId: filtros.actorId || undefined,
        desde: filtros.desde ? new Date(filtros.desde).toISOString() : undefined,
        hasta: filtros.hasta ? new Date(filtros.hasta).toISOString() : undefined,
        cursor: reiniciar ? undefined : cursorActual || undefined,
      });
      setEntradas((prev) => (reiniciar ? pagina.entradas : [...prev, ...pagina.entradas]));
      setCursor(pagina.siguienteCursor);
      setError(null);
    } catch (err: any) {
      setError(err.message || "No se pudo cargar la auditoría");
    } finally {
      setCargando(false);
      setCargandoMas(false);
    }
  }

  useEffect(() => {
    // Patrón estándar de carga al montar (setCargando(true) -> fetch ->
    // setCargando(false)), usado en toda la app.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargar(true, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function aplicarFiltros(e: FormEvent) {
    e.preventDefault();
    cargar(true, null);
  }

  function limpiarFiltros() {
    setFiltros(FILTROS_VACIOS);
    cargar(true, null);
  }

  return (
    <div>
      <h2 className="text-lg font-light text-slate-100 mb-1">Auditoría de plataforma</h2>
      <p className="text-xs text-slate-500 mb-4">
        Qué se hizo, a qué tenant/usuario, desde qué IP y quién lo hizo — un admin individual queda
        identificado por su correo; el acceso de emergencia (secreto compartido) queda marcado como
        tal.
      </p>

      <form
        onSubmit={aplicarFiltros}
        className="bg-slate-900 border border-slate-800 rounded-xl p-4 mb-6 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 items-end"
      >
        <label className="flex flex-col gap-1 text-xs text-slate-500">
          Acción
          <select
            value={filtros.accion}
            onChange={(e) => setFiltros((f) => ({ ...f, accion: e.target.value }))}
            className="px-2 py-1.5 rounded-lg border border-slate-700 bg-slate-950 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500/30"
          >
            <option value="">Todas</option>
            {ACCIONES.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-slate-500">
          Resultado
          <select
            value={filtros.resultado}
            onChange={(e) =>
              setFiltros((f) => ({ ...f, resultado: e.target.value as Filtros["resultado"] }))
            }
            className="px-2 py-1.5 rounded-lg border border-slate-700 bg-slate-950 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500/30"
          >
            <option value="">Todos</option>
            <option value="success">ok</option>
            <option value="failure">falló</option>
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-slate-500">
          Desde
          <input
            type="datetime-local"
            value={filtros.desde}
            onChange={(e) => setFiltros((f) => ({ ...f, desde: e.target.value }))}
            className="px-2 py-1.5 rounded-lg border border-slate-700 bg-slate-950 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500/30"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-slate-500">
          Hasta
          <input
            type="datetime-local"
            value={filtros.hasta}
            onChange={(e) => setFiltros((f) => ({ ...f, hasta: e.target.value }))}
            className="px-2 py-1.5 rounded-lg border border-slate-700 bg-slate-950 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500/30"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-slate-500">
          Session ID
          <input
            value={filtros.sessionId}
            onChange={(e) => setFiltros((f) => ({ ...f, sessionId: e.target.value }))}
            placeholder="pegar desde una fila"
            className="px-2 py-1.5 rounded-lg border border-slate-700 bg-slate-950 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500/30"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-slate-500">
          Actor ID
          <input
            value={filtros.actorId}
            onChange={(e) => setFiltros((f) => ({ ...f, actorId: e.target.value }))}
            placeholder="pegar desde una fila"
            className="px-2 py-1.5 rounded-lg border border-slate-700 bg-slate-950 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500/30"
          />
        </label>

        <div className="flex gap-2">
          <button
            type="submit"
            className="px-3 py-1.5 rounded-lg bg-slate-100 text-slate-900 text-sm font-medium hover:bg-white transition-colors"
          >
            Filtrar
          </button>
          <button
            type="button"
            onClick={limpiarFiltros}
            className="px-3 py-1.5 rounded-lg text-sm text-slate-400 hover:text-slate-100"
          >
            Limpiar
          </button>
        </div>
      </form>

      {error && (
        <p className="text-sm text-red-400 bg-red-950/40 border border-red-900 rounded-lg px-3 py-2 mb-4">
          {error}
        </p>
      )}

      {cargando ? (
        <p className="text-sm text-slate-400">Cargando...</p>
      ) : (
        <>
          <div className="border border-slate-800 rounded-xl overflow-hidden overflow-x-auto">
            <table className="w-full min-w-max text-sm">
              <thead>
                <tr className="bg-slate-900 text-slate-400 text-left">
                  <th className="px-4 py-3 font-light whitespace-nowrap">Fecha</th>
                  <th className="px-4 py-3 font-light">Acción</th>
                  <th className="px-4 py-3 font-light">Resultado</th>
                  <th className="px-4 py-3 font-light">Actor</th>
                  <th className="px-4 py-3 font-light">Tenant</th>
                  <th className="px-4 py-3 font-light">Usuario</th>
                  <th className="px-4 py-3 font-light">Motivo</th>
                  <th className="px-4 py-3 font-light">IP</th>
                  <th className="px-4 py-3 font-light">User-Agent</th>
                  <th className="px-4 py-3 font-light">Request ID</th>
                  <th className="px-4 py-3 font-light">Session ID</th>
                  <th className="px-4 py-3 font-light">Detalle</th>
                </tr>
              </thead>
              <tbody>
                {entradas.map((e) => (
                  <tr key={e.id} className="border-t border-slate-800 text-slate-300">
                    <td className="px-4 py-3 whitespace-nowrap text-xs text-slate-500">
                      {new Date(e.creadoEn).toLocaleString()}
                    </td>
                    <td className="px-4 py-3">{e.accion}</td>
                    <td className="px-4 py-3">
                      <span
                        className={e.resultado === "failure" ? "text-red-400" : "text-emerald-400"}
                      >
                        {e.resultado === "failure" ? "falló" : "ok"}
                      </span>
                    </td>
                    <td
                      className={`px-4 py-3 text-xs max-w-[10rem] truncate ${
                        e.actorType === "emergency_shared_secret"
                          ? "text-amber-400"
                          : "text-slate-500"
                      }`}
                      title={e.actorId || ""}
                    >
                      {e.actorLabel || "—"}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500">
                      {e.tenantNombre || e.tenantId || "—"}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500">
                      {e.usuarioEmail || e.usuarioId || "—"}
                    </td>
                    <td
                      className="px-4 py-3 text-xs text-slate-500 max-w-[10rem] truncate"
                      title={motivoDe(e.detalle) || ""}
                    >
                      {motivoDe(e.detalle) || "—"}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500">{e.ip || "—"}</td>
                    <td
                      className="px-4 py-3 text-xs text-slate-500 max-w-[12rem] truncate"
                      title={e.userAgent || ""}
                    >
                      {e.userAgent || "—"}
                    </td>
                    <td
                      className="px-4 py-3 text-xs text-slate-500 max-w-[10rem] truncate"
                      title={e.requestId || ""}
                    >
                      {e.requestId || "—"}
                    </td>
                    <td
                      className="px-4 py-3 text-xs text-slate-500 max-w-[10rem] truncate"
                      title={e.sessionId || ""}
                    >
                      {e.sessionId || "—"}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500 max-w-xs truncate">
                      {e.detalle ? JSON.stringify(e.detalle) : "—"}
                    </td>
                  </tr>
                ))}
                {entradas.length === 0 && (
                  <tr>
                    <td colSpan={12} className="px-4 py-6 text-center text-slate-500">
                      Sin actividad registrada todavía.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {cursor && (
            <div className="flex justify-center mt-4">
              <button
                onClick={() => cargar(false, cursor)}
                disabled={cargandoMas}
                className="px-4 py-2 rounded-lg bg-slate-900 border border-slate-800 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50 transition-colors"
              >
                {cargandoMas ? "Cargando..." : "Cargar más"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
