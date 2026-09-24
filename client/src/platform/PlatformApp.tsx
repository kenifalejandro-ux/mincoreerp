// client/src/platform/PlatformApp.tsx
//
// Se renderiza fuera de <AuthProvider> (ver main.tsx) — no usa useAuth()
// en ningún momento, la sesión acá es la cookie httpOnly `platform_session`
// (ver platformApi.ts), completamente separada de la de cualquier tenant.

import { useEffect, useState } from "react";

import AlertasBillingView from "./AlertasBillingView";
import AuditoriaView from "./AuditoriaView";
import CambiarPasswordObligatorio from "./CambiarPasswordObligatorio";
import PlatformAdminsView from "./PlatformAdminsView";
import {
  whoamiApi,
  cerrarSesionPlataformaApi,
  listarTenantsApi,
  obtenerAlertasBillingApi,
  type TenantPlataforma,
  type QuienSoy,
} from "./platformApi";
import PlatformLoginPage from "./PlatformLoginPage";
import TenantDetalleView from "./TenantDetalleView";
import TenantsView from "./TenantsView";

type Seccion = "tenants" | "auditoria" | "admins" | "alertas";

export default function PlatformApp() {
  const [quienSoy, setQuienSoy] = useState<QuienSoy | null | undefined>(undefined);
  const [seccion, setSeccion] = useState<Seccion>("tenants");
  const [tenantSeleccionado, setTenantSeleccionado] = useState<TenantPlataforma | null>(null);
  const [vencidasCount, setVencidasCount] = useState(0);

  useEffect(() => {
    whoamiApi()
      .then(setQuienSoy)
      .catch(() => setQuienSoy(null));
  }, []);

  useEffect(() => {
    if (!quienSoy) return;
    // Best-effort: solo alimenta el badge del nav, no bloquea nada si falla.
    obtenerAlertasBillingApi()
      .then((a) => setVencidasCount(a.vencidas.length))
      .catch(() => {});
  }, [quienSoy, seccion]);

  async function irATenant(tenantId: string) {
    const tenants = await listarTenantsApi();
    const tenant = tenants.find((t) => t.id === tenantId);
    if (tenant) {
      setTenantSeleccionado(tenant);
      setSeccion("tenants");
    }
  }

  if (quienSoy === undefined) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <p className="text-slate-400 text-sm">Cargando...</p>
      </div>
    );
  }

  if (!quienSoy) {
    return <PlatformLoginPage onExito={() => whoamiApi().then(setQuienSoy)} />;
  }

  if (quienSoy.debeCambiarPassword) {
    return <CambiarPasswordObligatorio onListo={() => whoamiApi().then(setQuienSoy)} />;
  }

  async function salir() {
    await cerrarSesionPlataformaApi();
    setQuienSoy(null);
    setTenantSeleccionado(null);
  }

  return (
    <div className="min-h-screen bg-slate-950">
      <header className="border-b border-slate-800 px-4 sm:px-6 py-3 sm:py-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <span className="text-slate-100 font-light text-sm tracking-tight">
            MinCore ERP · Plataforma
          </span>
          <nav className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <button
              onClick={() => {
                setSeccion("tenants");
                setTenantSeleccionado(null);
              }}
              className={`text-sm ${seccion === "tenants" ? "text-slate-100" : "text-slate-500 hover:text-slate-300"}`}
            >
              Empresas
            </button>
            <button
              onClick={() => setSeccion("alertas")}
              className={`text-sm flex items-center gap-1.5 ${seccion === "alertas" ? "text-slate-100" : "text-slate-500 hover:text-slate-300"}`}
            >
              Alertas
              {vencidasCount > 0 && (
                <span className="px-1.5 py-0.5 rounded-full bg-red-950 text-red-400 text-xs">
                  {vencidasCount}
                </span>
              )}
            </button>
            <button
              onClick={() => setSeccion("auditoria")}
              className={`text-sm ${seccion === "auditoria" ? "text-slate-100" : "text-slate-500 hover:text-slate-300"}`}
            >
              Auditoría
            </button>
            {quienSoy.esSuperAdmin && (
              <button
                onClick={() => setSeccion("admins")}
                className={`text-sm ${seccion === "admins" ? "text-slate-100" : "text-slate-500 hover:text-slate-300"}`}
              >
                Admins
              </button>
            )}
          </nav>
        </div>
        <div className="flex items-center gap-4">
          <span
            className={`text-xs ${
              quienSoy.actorType === "emergency_shared_secret" ? "text-amber-400" : "text-slate-500"
            }`}
            title={
              quienSoy.actorType === "emergency_shared_secret"
                ? "Acceso de emergencia (secreto compartido)"
                : ""
            }
          >
            {quienSoy.actorLabel}
          </span>
          <button onClick={salir} className="text-sm text-slate-500 hover:text-slate-300">
            Salir
          </button>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
        {seccion === "tenants" &&
          (tenantSeleccionado ? (
            <TenantDetalleView
              tenant={tenantSeleccionado}
              onVolver={() => setTenantSeleccionado(null)}
              onCambio={async () => {
                const tenants = await listarTenantsApi();
                const actualizado = tenants.find((t) => t.id === tenantSeleccionado.id);
                setTenantSeleccionado(actualizado ?? null);
              }}
            />
          ) : (
            <TenantsView onSeleccionar={setTenantSeleccionado} />
          ))}

        {seccion === "alertas" && <AlertasBillingView onSeleccionarTenant={irATenant} />}

        {seccion === "auditoria" && <AuditoriaView />}

        {seccion === "admins" && quienSoy.esSuperAdmin && <PlatformAdminsView />}
      </main>
    </div>
  );
}
