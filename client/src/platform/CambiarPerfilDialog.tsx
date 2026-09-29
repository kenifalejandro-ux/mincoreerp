import { useState, type FormEvent } from "react";

import type { RolUsuarioTenant, UsuarioPlataforma } from "./platformApi";

const PERFILES: { rol: RolUsuarioTenant; nombre: string; detalle: string }[] = [
  {
    rol: "admin",
    nombre: "Administrador",
    detalle: "Acceso administrativo completo al tenant.",
  },
  {
    rol: "operador",
    nombre: "Operador",
    detalle: "Opera los módulos asignados, sin administrar usuarios.",
  },
  {
    rol: "lectura",
    nombre: "Solo lectura",
    detalle: "Consulta la información de los módulos asignados.",
  },
  {
    rol: "grifero",
    nombre: "Grifero",
    detalle: "Acceso operativo restringido al módulo Combustible.",
  },
  {
    rol: "conductor_ruta",
    nombre: "Conductor de ruta",
    detalle: "Registra compras de combustible realizadas en grifos externos.",
  },
];

export default function CambiarPerfilDialog({
  usuario,
  onConfirmar,
  onCancelar,
}: {
  usuario: UsuarioPlataforma;
  onConfirmar: (rol: RolUsuarioTenant, motivo: string) => Promise<void>;
  onCancelar: () => void;
}) {
  const [rol, setRol] = useState<RolUsuarioTenant>(usuario.rol as RolUsuarioTenant);
  const [motivo, setMotivo] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const perfil = PERFILES.find((opcion) => opcion.rol === rol);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (enviando || rol === usuario.rol) return;
    setEnviando(true);
    setError(null);
    try {
      await onConfirmar(rol, motivo.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cambiar el perfil.");
      setEnviando(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl"
      >
        <h3 className="mb-1 text-sm font-semibold text-slate-100">
          Cambiar perfil de {usuario.nombre}
        </h3>
        <p className="mb-4 text-xs text-slate-400">
          El cambio se registra en auditoría y cerrará las sesiones actuales de esta persona.
        </p>

        <label htmlFor="perfil-usuario" className="mb-1 block text-xs text-slate-300">
          Nuevo perfil
        </label>
        <select
          id="perfil-usuario"
          value={rol}
          onChange={(e) => setRol(e.target.value as RolUsuarioTenant)}
          className="mb-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500/40"
        >
          {PERFILES.map((opcion) => (
            <option key={opcion.rol} value={opcion.rol}>
              {opcion.nombre}
            </option>
          ))}
        </select>
        {perfil && <p className="mb-4 text-xs text-slate-500">{perfil.detalle}</p>}

        <label htmlFor="perfil-motivo" className="mb-1 block text-xs text-slate-300">
          Motivo obligatorio
        </label>
        <textarea
          id="perfil-motivo"
          required
          minLength={1}
          maxLength={500}
          rows={3}
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          placeholder="Ej: se reasignan sus funciones a operación de ruta"
          className="mb-3 w-full resize-y rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-slate-500/40"
        />

        {error && (
          <p className="mb-3 rounded-lg border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-400">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancelar}
            disabled={enviando}
            className="rounded-lg px-3 py-1.5 text-sm text-slate-400 hover:text-slate-100 disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="submit"
            disabled={enviando || rol === usuario.rol || !motivo.trim()}
            className="rounded-lg bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-900 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {enviando ? "Guardando..." : "Guardar perfil"}
          </button>
        </div>
      </form>
    </div>
  );
}
