// client/src/pages/CambiarPasswordObligatoria.tsx
//
// Pantalla completa (no un modal superpuesto) que App.tsx muestra en vez
// del ERP cuando usuario.debeCambiarPassword es true -- la cuenta entró
// con una clave genérica que un admin le puso al darla de alta (panel o
// SCIM), y no tiene forma de saltear esta pantalla salvo cambiarla.

import { useState, type FormEvent } from "react";

import { useAuth } from "../context/AuthContext";
import { cambiarMiPasswordApi } from "../services/authApi";

export default function CambiarPasswordObligatoria({ onListo }: { onListo: () => void }) {
  const { logout } = useAuth();
  const [passwordActual, setPasswordActual] = useState("");
  const [passwordNueva, setPasswordNueva] = useState("");
  const [confirmacion, setConfirmacion] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (passwordNueva !== confirmacion) {
      setError("Las contraseñas no coinciden");
      return;
    }

    setEnviando(true);
    try {
      await cambiarMiPasswordApi(passwordActual, passwordNueva);
      onListo();
    } catch (err: any) {
      setError(err.message || "No se pudo cambiar la contraseña");
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#DDF500] flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center gap-3 mb-8">
          <div className="w-11 h-11 bg-[#FFFFFF] rounded-lg flex items-center justify-center">
            <span className="text-zinc-900 font-semibold text-base">M</span>
          </div>
          <h1 className="text-xl font-light text-slate-900 tracking-tight">
            Poné tu propia contraseña
          </h1>
          <p className="text-sm font-light text-zinc-800 text-center">
            Entraste con una clave temporal. Antes de seguir, tenés que reemplazarla por una propia.
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-[#1D2124] border border-slate-200 rounded-xl p-6 space-y-4 shadow-sm"
        >
          <div>
            <label
              className="block text-sm font-light text-slate-100 mb-1.5"
              htmlFor="passwordActual"
            >
              Contraseña temporal
            </label>
            <input
              id="passwordActual"
              type="password"
              required
              autoComplete="current-password"
              value={passwordActual}
              onChange={(e) => setPasswordActual(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-400"
              placeholder="••••••••"
            />
          </div>

          <div>
            <label
              className="block text-sm font-light text-slate-100 mb-1.5"
              htmlFor="passwordNueva"
            >
              Nueva contraseña
            </label>
            <input
              id="passwordNueva"
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              value={passwordNueva}
              onChange={(e) => setPasswordNueva(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-400"
              placeholder="••••••••"
            />
          </div>

          <div>
            <label
              className="block text-sm font-light text-slate-100 mb-1.5"
              htmlFor="confirmacion"
            >
              Confirmar nueva contraseña
            </label>
            <input
              id="confirmacion"
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              value={confirmacion}
              onChange={(e) => setConfirmacion(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-400"
              placeholder="••••••••"
            />
          </div>

          {error && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={enviando}
            className="w-full py-2.5 rounded-lg bg-[#DDF500] text-zinc-900 text-sm font-medium hover:bg-[#DDF500]/80 disabled:opacity-50 transition-colors"
          >
            {enviando ? "Guardando..." : "Guardar y continuar"}
          </button>
        </form>

        {/* La única salida de esta pantalla que no sea cambiar la clave.
            Hasta acá no había ninguna: quien entraba con una clave temporal
            que no era suya --la tablet compartida de planta, el admin
            probando la clave que acaba de dictar-- quedaba encerrado sin más
            opción que borrar las cookies del navegador. Dejó de ser un caso
            raro cuando el personal de cancha empezó a entrar con DNI: cada
            alta pasa por esta pantalla. */}
        <button
          type="button"
          onClick={() => void logout()}
          className="w-full mt-4 text-sm font-light text-zinc-800 hover:text-zinc-900 underline underline-offset-2"
        >
          No sos vos? Cerrar sesión
        </button>
      </div>
    </div>
  );
}
