// client/src/components/administracion/OrdenesView.tsx
//
// "Administración → Órdenes": las órdenes administrativas con correlativo y
// su doble firma (ver docs/architecture/cuentas-perfiles-y-administracion.md
// §11).
//
// Cada alta, baja, desbloqueo, reseteo o cambio de permisos genera una orden.
// No es un formulario que se aplica y desaparece: es un documento que queda, y
// una orden aplicada es el respaldo de por qué alguien tiene el acceso que
// tiene.
import { useCallback, useEffect, useState } from "react";

import {
  aprobarOrdenApi,
  cambiarDobleFirmaApi,
  estadoDobleFirmaApi,
  listarOrdenesApi,
  rechazarOrdenApi,
  type EstadoDeOrden,
  type OrdenAdministrativa,
} from "../../services/administracionApi";
import { useAuth } from "../../context/AuthContext";

const TIPOS: Record<string, string> = {
  alta_usuario: "Alta de usuario",
  baja_usuario: "Baja de usuario",
  reactivar_usuario: "Reactivación",
  desbloquear_usuario: "Desbloqueo",
  resetear_clave: "Reseteo de clave",
  cambiar_permisos: "Cambio de permisos",
  cambiar_doble_firma: "Doble firma",
};

const ESTADOS: Record<EstadoDeOrden, { titulo: string; clase: string }> = {
  pendiente: { titulo: "Pendiente de firma", clase: "text-amber-700 bg-amber-50 border-amber-200" },
  aplicada: { titulo: "Aplicada", clase: "text-emerald-700 bg-emerald-50 border-emerald-200" },
  rechazada: { titulo: "Rechazada", clase: "text-red-700 bg-red-50 border-red-200" },
  vencida: { titulo: "Vencida", clase: "text-slate-600 bg-slate-50 border-slate-200" },
  fallida: { titulo: "Falló al aplicarse", clase: "text-red-700 bg-red-50 border-red-200" },
};

function fechaLegible(iso: string): string {
  return new Date(iso).toLocaleString("es-PE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function OrdenesView() {
  const { usuario } = useAuth();
  const [ordenes, setOrdenes] = useState<OrdenAdministrativa[]>([]);
  const [dobleFirma, setDobleFirma] = useState(false);
  const [admins, setAdmins] = useState(0);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [abierta, setAbierta] = useState<string | null>(null);
  const [motivo, setMotivo] = useState("");
  const [trabajando, setTrabajando] = useState(false);

  const cargar = useCallback(async () => {
    try {
      const [lista, estado] = await Promise.all([listarOrdenesApi(), estadoDobleFirmaApi()]);
      setOrdenes(lista);
      setDobleFirma(estado.dobleFirma);
      setAdmins(estado.administradoresActivos);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar las órdenes.");
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const resolver = async (orden: OrdenAdministrativa, aprobar: boolean) => {
    if (trabajando) return;
    if (!aprobar && !motivo.trim()) {
      setError("Decile por qué la rechazás: quien la pidió necesita saber qué corregir.");
      return;
    }
    setTrabajando(true);
    setError(null);
    setAviso(null);
    try {
      if (aprobar) {
        await aprobarOrdenApi(orden.id, motivo.trim() || undefined);
        setAviso(`${orden.correlativo} firmada y aplicada.`);
      } else {
        await rechazarOrdenApi(orden.id, motivo.trim());
        setAviso(`${orden.correlativo} rechazada.`);
      }
      setAbierta(null);
      setMotivo("");
      await cargar();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo resolver la orden.");
    } finally {
      setTrabajando(false);
    }
  };

  const cambiarDobleFirma = async (encender: boolean) => {
    const razon = window.prompt(
      encender
        ? "¿Por qué activás la doble firma? Queda registrado."
        : "¿Por qué desactivás la doble firma? Queda registrado y necesita la firma de otro administrador."
    );
    if (!razon?.trim()) return;

    setTrabajando(true);
    setError(null);
    setAviso(null);
    try {
      const resultado = await cambiarDobleFirmaApi(encender, razon.trim());
      setAviso(
        resultado.pendiente
          ? `Queda pendiente de la firma de otro administrador (${resultado.orden.correlativo}).`
          : encender
            ? "Doble firma activada."
            : "Doble firma desactivada."
      );
      await cargar();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cambiar la doble firma.");
    } finally {
      setTrabajando(false);
    }
  };

  if (cargando) return <div className="p-20 text-center text-slate-500">Cargando...</div>;

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-xl font-bold text-slate-800">Órdenes</h2>
        <p className="text-slate-600 text-sm">
          Cada alta, baja, desbloqueo o cambio de permisos deja una orden con número. Una orden
          aplicada es el respaldo de por qué alguien tiene el acceso que tiene.
        </p>
      </div>

      <div className="bg-white border border-slate-200 rounded-3xl p-5 shadow-sm mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <p className="text-sm font-bold text-slate-800">
            Doble firma: {dobleFirma ? "activada" : "desactivada"}
          </p>
          <p className="text-xs text-slate-500 mt-1">
            {dobleFirma
              ? "Cada orden la pide un administrador y la firma otro. Cortar el acceso de alguien que no es administrador sigue siendo inmediato."
              : `Las órdenes se aplican con una sola firma. Para activarla hacen falta dos administradores activos (hoy hay ${admins}).`}
          </p>
        </div>
        <button
          type="button"
          disabled={trabajando || (!dobleFirma && admins < 2)}
          onClick={() => void cambiarDobleFirma(!dobleFirma)}
          className="px-5 py-2.5 border border-slate-200 bg-white hover:bg-slate-50 text-sm font-bold text-slate-700 rounded-xl disabled:opacity-40 whitespace-nowrap"
        >
          {dobleFirma ? "Desactivar" : "Activar"}
        </button>
      </div>

      {error && (
        <p className="mb-4 text-sm font-semibold text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-3">
          {error}
        </p>
      )}
      {aviso && (
        <p className="mb-4 text-sm font-semibold text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3">
          {aviso}
        </p>
      )}

      <div className="space-y-3">
        {ordenes.map((orden) => {
          const estado = ESTADOS[orden.estado];
          const esMia = orden.solicitanteId === usuario?.id;
          const puedeFirmar = orden.estado === "pendiente" && !esMia;

          return (
            <div
              key={orden.id}
              className="bg-white border border-slate-200 rounded-3xl p-5 shadow-sm"
            >
              <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="font-mono text-sm font-bold text-slate-900">
                      {orden.correlativo}
                    </span>
                    <span
                      className={`px-2.5 py-0.5 rounded-full border text-[11px] font-bold uppercase ${estado.clase}`}
                    >
                      {estado.titulo}
                    </span>
                    {orden.firmasRequeridas === 1 && orden.estado === "aplicada" && (
                      <span className="text-[11px] font-bold text-slate-400 uppercase">
                        Una firma
                      </span>
                    )}
                  </div>

                  <p className="mt-1 text-sm font-semibold text-slate-800">
                    {TIPOS[orden.tipo] ?? orden.tipo}
                    {orden.usuarioNombre && (
                      <span className="font-normal text-slate-600"> · {orden.usuarioNombre}</span>
                    )}
                  </p>
                  <p className="text-xs text-slate-500">{orden.motivo}</p>

                  <p className="mt-2 text-xs text-slate-500">
                    Pedida por {orden.solicitanteNombre} el {fechaLegible(orden.creadoEn)}
                    {orden.aprobadorNombre && (
                      <>
                        {" · "}
                        {orden.estado === "rechazada" ? "rechazada" : "firmada"} por{" "}
                        {orden.aprobadorNombre}
                        {orden.resueltaEn && ` el ${fechaLegible(orden.resueltaEn)}`}
                      </>
                    )}
                  </p>
                  {orden.motivoResolucion && (
                    <p className="text-xs text-slate-500 italic">“{orden.motivoResolucion}”</p>
                  )}
                  {orden.error && (
                    <p className="mt-2 text-xs font-semibold text-red-700">{orden.error}</p>
                  )}
                </div>

                <div className="flex gap-2 shrink-0">
                  {(orden.antes || Object.keys(orden.payload).length > 0) && (
                    <button
                      type="button"
                      onClick={() => setAbierta(abierta === orden.id ? null : orden.id)}
                      className="px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-100 rounded-lg"
                    >
                      {abierta === orden.id ? "Ocultar" : "Ver el cambio"}
                    </button>
                  )}
                </div>
              </div>

              {orden.estado === "pendiente" && esMia && (
                <p className="mt-3 text-xs font-semibold text-slate-500">
                  La pediste vos: la tiene que firmar otro administrador.
                </p>
              )}

              {abierta === orden.id && (
                <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="border border-slate-200 rounded-2xl p-3">
                    <p className="text-[11px] font-bold text-slate-500 uppercase mb-1">Antes</p>
                    <pre className="text-xs text-slate-700 whitespace-pre-wrap overflow-x-auto">
                      {orden.antes ? JSON.stringify(orden.antes, null, 2) : "—"}
                    </pre>
                  </div>
                  <div className="border border-slate-200 rounded-2xl p-3">
                    <p className="text-[11px] font-bold text-slate-500 uppercase mb-1">Se pidió</p>
                    <pre className="text-xs text-slate-700 whitespace-pre-wrap overflow-x-auto">
                      {JSON.stringify(orden.payload, null, 2)}
                    </pre>
                  </div>
                </div>
              )}

              {puedeFirmar && (
                <div className="mt-4 border-t border-slate-100 pt-4 flex flex-col sm:flex-row gap-2">
                  <input
                    type="text"
                    maxLength={500}
                    placeholder="Motivo (obligatorio para rechazar)"
                    className="flex-1 border border-slate-200 rounded-xl px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-900"
                    value={abierta === orden.id ? motivo : motivo}
                    onChange={(e) => setMotivo(e.target.value)}
                  />
                  <button
                    type="button"
                    disabled={trabajando}
                    onClick={() => void resolver(orden, true)}
                    className="px-5 py-2.5 bg-slate-900 hover:bg-slate-800 text-white text-sm font-bold rounded-xl disabled:opacity-50"
                  >
                    Firmar y aplicar
                  </button>
                  <button
                    type="button"
                    disabled={trabajando}
                    onClick={() => void resolver(orden, false)}
                    className="px-5 py-2.5 border border-red-200 text-red-700 hover:bg-red-50 text-sm font-bold rounded-xl disabled:opacity-50"
                  >
                    Rechazar
                  </button>
                </div>
              )}
            </div>
          );
        })}

        {ordenes.length === 0 && (
          <div className="bg-white border border-slate-200 rounded-3xl p-10 text-center text-sm text-slate-500 shadow-sm">
            Todavía no hay órdenes.
          </div>
        )}
      </div>
    </div>
  );
}
