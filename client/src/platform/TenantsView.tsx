// client/src/platform/TenantsView.tsx

import { useEffect, useState, type FormEvent } from "react";

import PasswordInput from "./PasswordInput";
import { listarTenantsApi, crearTenantApi, type TenantPlataforma } from "./platformApi";

export default function TenantsView({
  onSeleccionar,
}: {
  onSeleccionar: (tenant: TenantPlataforma) => void;
}) {
  const [tenants, setTenants] = useState<TenantPlataforma[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mostrarForm, setMostrarForm] = useState(false);

  async function recargar() {
    setCargando(true);
    try {
      setTenants(await listarTenantsApi());
      setError(null);
    } catch (err: any) {
      setError(err.message || "No se pudo cargar la lista de tenants");
    } finally {
      setCargando(false);
    }
  }

  useEffect(() => {
    // Patrón estándar de carga al montar (setCargando(true) -> fetch ->
    // setCargando(false)), usado en toda la app.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    recargar();
  }, []);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-light text-slate-100">Empresas (tenants)</h2>
        <button
          onClick={() => setMostrarForm((v) => !v)}
          className="px-4 py-2 rounded-lg bg-slate-100 text-slate-900 text-sm font-medium hover:bg-white transition-colors"
        >
          {mostrarForm ? "Cancelar" : "+ Nueva empresa"}
        </button>
      </div>

      {mostrarForm && (
        <NuevoTenantForm
          onCreado={() => {
            setMostrarForm(false);
            recargar();
          }}
        />
      )}

      {error && (
        <p className="text-sm text-red-400 bg-red-950/40 border border-red-900 rounded-lg px-3 py-2 mb-4">
          {error}
        </p>
      )}

      {cargando ? (
        <p className="text-sm text-slate-400">Cargando...</p>
      ) : (
        <div className="border border-slate-800 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-max text-sm">
              <thead>
                <tr className="bg-slate-900 text-slate-400 text-left">
                  <th className="px-4 py-3 font-light">Nombre</th>
                  <th className="px-4 py-3 font-light">Slug</th>
                  <th className="px-4 py-3 font-light">Dominio propio</th>
                  <th className="px-4 py-3 font-light">Estado</th>
                </tr>
              </thead>
              <tbody>
                {tenants.map((t) => (
                  <tr
                    key={t.id}
                    onClick={() => onSeleccionar(t)}
                    className="border-t border-slate-800 text-slate-200 hover:bg-slate-900 cursor-pointer transition-colors"
                  >
                    <td className="px-4 py-3">{t.nombre}</td>
                    <td className="px-4 py-3 text-slate-400">{t.slug}</td>
                    <td className="px-4 py-3 text-slate-400">{t.dominioPersonalizado || "—"}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`px-2 py-0.5 rounded-full text-xs ${
                          t.activo
                            ? "bg-emerald-950 text-emerald-400"
                            : "bg-slate-800 text-slate-400"
                        }`}
                      >
                        {t.activo ? "Activo" : "Desactivado"}
                      </span>
                    </td>
                  </tr>
                ))}
                {tenants.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-6 text-center text-slate-500">
                      No hay tenants todavía.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function NuevoTenantForm({ onCreado }: { onCreado: () => void }) {
  const [tenantNombre, setTenantNombre] = useState("");
  const [tenantSlug, setTenantSlug] = useState("");
  const [adminNombre, setAdminNombre] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  // Una sola key por apertura del formulario (no por click): así un
  // doble-click o un retry tras un timeout de red no crean dos tenants —
  // ver POST /api/platform/tenants (Idempotency-Key) y platformIdempotency.service.ts.
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setEnviando(true);
    try {
      await crearTenantApi(
        { tenantNombre, tenantSlug, adminNombre, adminEmail, adminPassword },
        idempotencyKey
      );
      onCreado();
    } catch (err: any) {
      setError(err.message || "No se pudo crear el tenant");
    } finally {
      setEnviando(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-slate-900 border border-slate-800 rounded-xl p-4 mb-6 grid grid-cols-1 sm:grid-cols-2 gap-3"
    >
      <input
        required
        value={tenantNombre}
        onChange={(e) => setTenantNombre(e.target.value)}
        placeholder="Nombre de la empresa"
        className="px-3 py-2 rounded-lg border border-slate-700 bg-slate-950 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500/30"
      />
      <input
        required
        value={tenantSlug}
        onChange={(e) => setTenantSlug(e.target.value)}
        placeholder="slug (ej. cushuro)"
        className="px-3 py-2 rounded-lg border border-slate-700 bg-slate-950 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500/30"
      />
      <input
        required
        value={adminNombre}
        onChange={(e) => setAdminNombre(e.target.value)}
        placeholder="Nombre del admin"
        className="px-3 py-2 rounded-lg border border-slate-700 bg-slate-950 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500/30"
      />
      <input
        required
        type="email"
        value={adminEmail}
        onChange={(e) => setAdminEmail(e.target.value)}
        placeholder="Correo del admin"
        className="px-3 py-2 rounded-lg border border-slate-700 bg-slate-950 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500/30"
      />
      <PasswordInput
        id="adminPassword"
        required
        minLength={8}
        value={adminPassword}
        onChange={setAdminPassword}
        placeholder="Contraseña inicial"
      />

      {error && (
        <p className="sm:col-span-2 text-sm text-red-400 bg-red-950/40 border border-red-900 rounded-lg px-3 py-2">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={enviando}
        className="sm:col-span-2 py-2.5 rounded-lg bg-slate-100 text-slate-900 text-sm font-medium hover:bg-white disabled:opacity-50 transition-colors"
      >
        {enviando ? "Creando..." : "Crear empresa"}
      </button>
    </form>
  );
}
