// client/src/platform/TenantDetalleView.tsx

import { useEffect, useState, type FormEvent } from "react";

import CambiarEstadoDialog from "./CambiarEstadoDialog";
import PasswordInput from "./PasswordInput";
import PlanYCuotasTenant from "./PlanYCuotasTenant";
import {
  type TenantPlataforma,
  type ModuloEstado,
  type EstadoModulo,
  type UsuarioPlataforma,
  type DominioTenant as DominioTenantData,
  type SaludTenant as SaludTenantData,
  type TenantBackup,
  type TenantSsoConfig,
  type TenantScimConfig,
  obtenerModulosTenantApi,
  actualizarModulosTenantApi,
  actualizarModuloGlobalApi,
  cambiarEstadoTenantApi,
  obtenerDominioTenantApi,
  actualizarDominioTenantApi,
  verificarDominioTenantApi,
  obtenerSaludTenantApi,
  listarBackupsTenantApi,
  crearBackupTenantApi,
  restaurarBackupApi,
  listarUsuariosTenantApi,
  crearUsuarioApi,
  cambiarEstadoUsuarioApi,
  obtenerModulosUsuarioApi,
  actualizarModulosUsuarioApi,
  obtenerSsoTenantApi,
  configurarSsoTenantApi,
  obtenerScimTenantApi,
  generarTokenScimApi,
  revocarTokenScimApi,
} from "./platformApi";
import SuscripcionTenant from "./SuscripcionTenant";

export default function TenantDetalleView({
  tenant,
  onVolver,
  onCambio,
}: {
  tenant: TenantPlataforma;
  onVolver: () => void;
  onCambio: () => void;
}) {
  const [modulos, setModulos] = useState<ModuloEstado[]>([]);
  const [usuarios, setUsuarios] = useState<UsuarioPlataforma[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [mostrarFormUsuario, setMostrarFormUsuario] = useState(false);
  const [usuarioExpandido, setUsuarioExpandido] = useState<string | null>(null);
  const [dialogTenantAbierto, setDialogTenantAbierto] = useState(false);
  const [usuarioParaCambiarEstado, setUsuarioParaCambiarEstado] =
    useState<UsuarioPlataforma | null>(null);

  async function recargar() {
    try {
      const [m, u] = await Promise.all([
        obtenerModulosTenantApi(tenant.id),
        listarUsuariosTenantApi(tenant.id),
      ]);
      setModulos(m);
      setUsuarios(u);
      setError(null);
    } catch (err: any) {
      setError(err.message || "No se pudo cargar el tenant");
    }
  }

  useEffect(() => {
    // Patrón estándar de carga al montar (setCargando(true) -> fetch ->
    // setCargando(false)), usado en toda la app.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    recargar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenant.id]);

  async function confirmarCambioEstadoTenant(motivo: string | undefined) {
    await cambiarEstadoTenantApi(tenant.id, !tenant.activo, motivo);
    setDialogTenantAbierto(false);
    onCambio();
  }

  return (
    <div>
      <button onClick={onVolver} className="text-sm text-slate-400 hover:text-slate-100 mb-4">
        ← Volver a empresas
      </button>

      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-light text-slate-100">{tenant.nombre}</h2>
          <p className="text-xs text-slate-500">{tenant.slug}</p>
        </div>
        <button
          onClick={() => setDialogTenantAbierto(true)}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            tenant.activo
              ? "bg-red-950 text-red-400 hover:bg-red-900"
              : "bg-emerald-950 text-emerald-400 hover:bg-emerald-900"
          }`}
        >
          {tenant.activo ? "Desactivar empresa" : "Activar empresa"}
        </button>
      </div>

      {dialogTenantAbierto && (
        <CambiarEstadoDialog
          activarA={!tenant.activo}
          entidadNombre={tenant.nombre}
          onConfirmar={confirmarCambioEstadoTenant}
          onCancelar={() => setDialogTenantAbierto(false)}
        />
      )}

      {usuarioParaCambiarEstado && (
        <CambiarEstadoDialog
          activarA={!usuarioParaCambiarEstado.activo}
          entidadNombre={
            usuarioParaCambiarEstado.email ??
            usuarioParaCambiarEstado.dni ??
            usuarioParaCambiarEstado.nombre
          }
          onConfirmar={async (motivo) => {
            await cambiarEstadoUsuarioApi(
              tenant.id,
              usuarioParaCambiarEstado.id,
              !usuarioParaCambiarEstado.activo,
              motivo
            );
            setUsuarioParaCambiarEstado(null);
            recargar();
          }}
          onCancelar={() => setUsuarioParaCambiarEstado(null)}
        />
      )}

      {error && (
        <p className="text-sm text-red-400 bg-red-950/40 border border-red-900 rounded-lg px-3 py-2 mb-4">
          {error}
        </p>
      )}

      <DominioTenant tenantId={tenant.id} />

      <SsoTenant tenantId={tenant.id} />

      <ScimTenant tenantId={tenant.id} />

      <SaludTenant tenantId={tenant.id} />

      <BackupsTenant tenantId={tenant.id} onError={setError} />

      <SuscripcionTenant tenantId={tenant.id} tenantActivo={tenant.activo} />

      <h3 className="text-sm font-light text-slate-400 mb-2">Módulos contratados</h3>
      <PlanYCuotasTenant tenantId={tenant.id} onError={setError} />

      <ModulosTenant
        tenantId={tenant.id}
        modulos={modulos}
        onModulosChange={setModulos}
        onError={setError}
      />

      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-light text-slate-400">Usuarios</h3>
        <button
          onClick={() => setMostrarFormUsuario((v) => !v)}
          className="text-sm text-slate-100 hover:text-white underline underline-offset-2"
        >
          {mostrarFormUsuario ? "Cancelar" : "+ Nuevo usuario"}
        </button>
      </div>

      {mostrarFormUsuario && (
        <NuevoUsuarioForm
          tenantId={tenant.id}
          onCreado={() => {
            setMostrarFormUsuario(false);
            recargar();
          }}
        />
      )}

      <div className="border border-slate-800 rounded-xl overflow-hidden">
        {usuarios.map((u) => (
          <div key={u.id} className="border-t border-slate-800 first:border-t-0">
            <div className="px-4 py-3 flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-200">{u.nombre}</p>
                <p className="text-xs text-slate-500">
                  {u.email ?? u.dni ?? "sin identificador"} · {u.rol}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span
                  className={`px-2 py-0.5 rounded-full text-xs ${
                    u.activo ? "bg-emerald-950 text-emerald-400" : "bg-slate-800 text-slate-400"
                  }`}
                >
                  {u.activo ? "Activo" : "Desactivado"}
                </span>
                <button
                  onClick={() => setUsuarioExpandido((v) => (v === u.id ? null : u.id))}
                  className="text-xs text-slate-400 hover:text-slate-100 underline underline-offset-2"
                >
                  Módulos
                </button>
                <button
                  onClick={() => setUsuarioParaCambiarEstado(u)}
                  className={`text-xs font-medium ${u.activo ? "text-red-400 hover:text-red-300" : "text-emerald-400 hover:text-emerald-300"}`}
                >
                  {u.activo ? "Desactivar" : "Activar"}
                </button>
              </div>
            </div>
            {usuarioExpandido === u.id && (
              <ModulosUsuario tenantId={tenant.id} usuarioId={u.id} onError={setError} />
            )}
          </div>
        ))}
        {usuarios.length === 0 && (
          <p className="px-4 py-6 text-center text-slate-500 text-sm">No hay usuarios todavía.</p>
        )}
      </div>
    </div>
  );
}

function ModulosTenant({
  tenantId,
  modulos,
  onModulosChange,
  onError,
}: {
  tenantId: string;
  modulos: ModuloEstado[];
  onModulosChange: (modulos: ModuloEstado[]) => void;
  onError: (msg: string) => void;
}) {
  const [guardandoModulo, setGuardandoModulo] = useState<string | null>(null);
  const [aplicandoGlobal, setAplicandoGlobal] = useState<string | null>(null);

  async function guardarCambio(modulo: string, cambios: Partial<ModuloEstado>) {
    const actualizados = modulos.map((m) => (m.modulo === modulo ? { ...m, ...cambios } : m));
    setGuardandoModulo(modulo);
    try {
      onModulosChange(
        await actualizarModulosTenantApi(
          tenantId,
          actualizados.map((m) => ({
            modulo: m.modulo,
            estado: m.estado,
            rolloutPorcentaje: m.rolloutPorcentaje,
            version: m.version,
          }))
        )
      );
    } catch (err: any) {
      onError(err.message || "No se pudo actualizar el módulo");
    } finally {
      setGuardandoModulo(null);
    }
  }

  async function aplicarGlobal(m: ModuloEstado) {
    if (
      !window.confirm(
        `¿Aplicar "${m.estado}" a ${m.modulo} en TODOS los tenants? Esto no se puede deshacer.`
      )
    ) {
      return;
    }
    setAplicandoGlobal(m.modulo);
    try {
      const afectados = await actualizarModuloGlobalApi(m.modulo, {
        estado: m.estado,
        rolloutPorcentaje: m.rolloutPorcentaje,
        version: m.version,
      });
      window.alert(`Aplicado a ${afectados} tenant(s).`);
    } catch (err: any) {
      onError(err.message || "No se pudo aplicar el cambio global");
    } finally {
      setAplicandoGlobal(null);
    }
  }

  return (
    <div className="space-y-2 mb-8">
      {modulos.map((m) => (
        <div
          key={m.modulo}
          className="flex flex-wrap items-center gap-2 bg-slate-900 border border-slate-800 rounded-lg px-3 py-2"
        >
          <span className="text-sm text-slate-200 w-28 shrink-0">{m.modulo}</span>

          <select
            value={m.estado}
            disabled={guardandoModulo === m.modulo}
            onChange={(e) => {
              const estado = e.target.value as EstadoModulo;
              guardarCambio(m.modulo, {
                estado,
                rolloutPorcentaje: estado === "rollout" ? (m.rolloutPorcentaje ?? 0) : null,
              });
            }}
            className="px-2 py-1 rounded-lg border border-slate-700 bg-slate-950 text-xs text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500/30 disabled:opacity-50"
          >
            <option value="habilitado">Habilitado</option>
            <option value="deshabilitado">Deshabilitado</option>
            <option value="rollout">Rollout</option>
          </select>

          {m.estado === "rollout" && (
            <>
              <input
                type="number"
                min={0}
                max={100}
                defaultValue={m.rolloutPorcentaje ?? 0}
                onBlur={(e) =>
                  guardarCambio(m.modulo, { rolloutPorcentaje: Number(e.target.value) })
                }
                className="w-16 px-2 py-1 rounded-lg border border-slate-700 bg-slate-950 text-xs text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500/30"
              />
              <span className="text-xs text-slate-500">%</span>
            </>
          )}

          <input
            defaultValue={m.version ?? ""}
            placeholder="versión (opcional)"
            onBlur={(e) => guardarCambio(m.modulo, { version: e.target.value.trim() || null })}
            className="w-28 px-2 py-1 rounded-lg border border-slate-700 bg-slate-950 text-xs text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500/30"
          />

          <button
            onClick={() => aplicarGlobal(m)}
            disabled={aplicandoGlobal === m.modulo}
            className="ml-auto text-xs text-slate-500 hover:text-slate-300 underline underline-offset-2 disabled:opacity-50"
          >
            Aplicar a todos los tenants
          </button>
        </div>
      ))}
    </div>
  );
}

const ETIQUETA_ALERTA: Record<string, string> = {
  alta_tasa_error_5xx: "Tasa de error 5xx alta",
  creacion_anomala_de_recursos: "Creación de recursos fuera de lo normal",
};

function SaludTenant({ tenantId }: { tenantId: string }) {
  const [salud, setSalud] = useState<SaludTenantData | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function cargar() {
    setCargando(true);
    try {
      setSalud(await obtenerSaludTenantApi(tenantId));
      setError(null);
    } catch (err: any) {
      setError(err.message || "No se pudo cargar la salud del tenant");
    } finally {
      setCargando(false);
    }
  }

  useEffect(() => {
    // Patrón estándar de carga al montar (setCargando(true) -> fetch ->
    // setCargando(false)), usado en toda la app.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 mb-6">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-light text-slate-400">Salud (últimas 24h)</h3>
        <button
          onClick={cargar}
          className="text-xs text-slate-500 hover:text-slate-300 underline underline-offset-2"
        >
          Actualizar
        </button>
      </div>

      {error && <p className="text-sm text-red-400 mb-2">{error}</p>}
      {cargando ? (
        <p className="text-sm text-slate-400">Cargando...</p>
      ) : salud ? (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <div>
              <p className="text-slate-500">Usuarios activos</p>
              <p className="text-slate-200 text-sm">
                {salud.usuariosActivos} / {salud.usuariosTotal}
              </p>
            </div>
            <div>
              <p className="text-slate-500">Último acceso</p>
              <p className="text-slate-200 text-sm">
                {salud.ultimoAcceso ? new Date(salud.ultimoAcceso).toLocaleString() : "—"}
              </p>
            </div>
            <div>
              <p className="text-slate-500">Requests</p>
              <p className="text-slate-200 text-sm">{salud.requestsUltimas24h}</p>
            </div>
            <div>
              <p className="text-slate-500">Tasa de error</p>
              <p
                className={`text-sm ${salud.tasaError > 0.05 ? "text-red-400" : "text-slate-200"}`}
              >
                {(salud.tasaError * 100).toFixed(1)}% ({salud.errores5xxUltimas24h})
              </p>
            </div>
          </div>

          {salud.alertas.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {salud.alertas.map((a) => (
                <span key={a} className="px-2 py-0.5 rounded-full text-xs bg-red-950 text-red-400">
                  ⚠ {ETIQUETA_ALERTA[a] || a}
                </span>
              ))}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

function BackupsTenant({
  tenantId,
  onError,
}: {
  tenantId: string;
  onError: (msg: string) => void;
}) {
  const [backups, setBackups] = useState<TenantBackup[]>([]);
  const [cargando, setCargando] = useState(true);
  const [creando, setCreando] = useState(false);
  const [restaurandoId, setRestaurandoId] = useState<string | null>(null);

  async function cargar() {
    setCargando(true);
    try {
      setBackups(await listarBackupsTenantApi(tenantId));
    } catch (err: any) {
      onError(err.message || "No se pudieron cargar los backups");
    } finally {
      setCargando(false);
    }
  }

  useEffect(() => {
    // Patrón estándar de carga al montar (setCargando(true) -> fetch ->
    // setCargando(false)), usado en toda la app.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  async function crear() {
    setCreando(true);
    try {
      await crearBackupTenantApi(tenantId);
      await cargar();
    } catch (err: any) {
      onError(err.message || "No se pudo crear el backup");
    } finally {
      setCreando(false);
    }
  }

  async function restaurar(backup: TenantBackup) {
    const totalFilas = Object.values(backup.tablas).reduce((a, b) => a + b, 0);
    const confirmado = window.confirm(
      `¿Restaurar este backup (${new Date(backup.creadoEn).toLocaleString()}, ${totalFilas} filas) sobre ESTE tenant? ` +
        `Esto borra todos los datos actuales del tenant y los reemplaza por los del backup. No se puede deshacer.`
    );
    if (!confirmado) return;

    setRestaurandoId(backup.id);
    try {
      await restaurarBackupApi(backup.id, tenantId);
      window.alert("Restauración completa.");
    } catch (err: any) {
      onError(err.message || "No se pudo restaurar el backup");
    } finally {
      setRestaurandoId(null);
    }
  }

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 mb-6">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-light text-slate-400">Backups</h3>
        <button
          onClick={crear}
          disabled={creando}
          className="px-3 py-1.5 rounded-lg bg-slate-800 text-slate-100 text-xs font-medium hover:bg-slate-700 disabled:opacity-50 transition-colors"
        >
          {creando ? "Creando..." : "+ Crear backup ahora"}
        </button>
      </div>

      {cargando ? (
        <p className="text-sm text-slate-400">Cargando...</p>
      ) : backups.length === 0 ? (
        <p className="text-xs text-slate-500">Sin backups todavía.</p>
      ) : (
        <ul className="space-y-1.5">
          {backups.map((b) => {
            const totalFilas = Object.values(b.tablas).reduce((a, x) => a + x, 0);
            return (
              <li key={b.id} className="flex items-center justify-between text-xs text-slate-400">
                <span>
                  {new Date(b.creadoEn).toLocaleString()} · {totalFilas} filas ·{" "}
                  {(b.tamanoBytes / 1024).toFixed(0)} KB
                </span>
                <button
                  onClick={() => restaurar(b)}
                  disabled={restaurandoId === b.id}
                  className="text-red-400 hover:text-red-300 font-medium disabled:opacity-50"
                >
                  {restaurandoId === b.id ? "Restaurando..." : "Restaurar sobre este tenant"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function DominioTenant({ tenantId }: { tenantId: string }) {
  const [info, setInfo] = useState<DominioTenantData | null>(null);
  const [valorInput, setValorInput] = useState("");
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [verificando, setVerificando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Patrón estándar de carga al montar (setCargando(true) -> fetch ->
    // setCargando(false)), usado en toda la app.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCargando(true);
    obtenerDominioTenantApi(tenantId)
      .then((data) => {
        setInfo(data);
        setValorInput(data.dominioPersonalizado || "");
        setError(null);
      })
      .catch((err) => setError(err.message || "No se pudo cargar el dominio"))
      .finally(() => setCargando(false));
  }, [tenantId]);

  async function guardar(e: FormEvent) {
    e.preventDefault();
    setGuardando(true);
    try {
      setInfo(await actualizarDominioTenantApi(tenantId, valorInput.trim() || null));
      setError(null);
    } catch (err: any) {
      setError(err.message || "No se pudo guardar el dominio");
    } finally {
      setGuardando(false);
    }
  }

  async function verificar() {
    setVerificando(true);
    try {
      setInfo(await verificarDominioTenantApi(tenantId));
      setError(null);
    } catch (err: any) {
      setError(err.message || "No se pudo verificar el dominio");
    } finally {
      setVerificando(false);
    }
  }

  const estado = info?.dominioEstado ?? "desactivado";
  const badge: Record<string, string> = {
    activo: "bg-emerald-950 text-emerald-400",
    pendiente_verificacion: "bg-amber-950 text-amber-400",
    fallido: "bg-red-950 text-red-400",
    desactivado: "bg-slate-800 text-slate-400",
  };
  const etiqueta: Record<string, string> = {
    activo: "Verificado",
    pendiente_verificacion: "Pendiente de verificación",
    fallido: "Verificación fallida",
    desactivado: "Sin dominio propio",
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 mb-6">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-light text-slate-400">Dominio propio</h3>
        {!cargando && (
          <span className={`px-2 py-0.5 rounded-full text-xs ${badge[estado]}`}>
            {etiqueta[estado]}
          </span>
        )}
      </div>

      <form onSubmit={guardar} className="flex gap-3 mb-3">
        <input
          value={valorInput}
          onChange={(e) => setValorInput(e.target.value)}
          placeholder="dominio propio (ej. cushuro.pe) — vacío para quitarlo"
          className="flex-1 px-3 py-2 rounded-lg border border-slate-700 bg-slate-950 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500/30"
        />
        <button
          type="submit"
          disabled={guardando}
          className="px-4 py-2 rounded-lg bg-slate-800 text-slate-100 text-sm font-medium hover:bg-slate-700 disabled:opacity-50 transition-colors"
        >
          {guardando ? "Guardando..." : "Guardar dominio"}
        </button>
      </form>

      {error && (
        <p className="text-sm text-red-400 bg-red-950/40 border border-red-900 rounded-lg px-3 py-2 mb-3">
          {error}
        </p>
      )}

      {(estado === "pendiente_verificacion" || estado === "fallido") &&
        info?.dominioRegistroEsperado && (
          <div className="bg-slate-950 border border-slate-800 rounded-lg p-3 space-y-2">
            <p className="text-xs text-slate-400">
              Agregá este registro TXT en el DNS de{" "}
              <span className="text-slate-200">{info.dominioPersonalizado}</span> para confirmar que
              lo controlás:
            </p>
            <div className="text-xs font-mono bg-slate-900 rounded px-2 py-1.5 text-slate-300 break-all">
              <div>Nombre: {info.dominioRegistroEsperado}</div>
              <div>Valor: {info.dominioValorEsperado}</div>
            </div>
            {estado === "fallido" && (
              <p className="text-xs text-red-400">
                El último intento no encontró el registro esperado
                {info.dominioUltimoIntentoEn
                  ? ` (${new Date(info.dominioUltimoIntentoEn).toLocaleString()})`
                  : ""}{" "}
                — la propagación de DNS puede tardar. Volvé a intentar cuando lo hayas configurado.
              </p>
            )}
            <button
              onClick={verificar}
              disabled={verificando}
              className="px-3 py-1.5 rounded-lg bg-slate-100 text-slate-900 text-xs font-medium hover:bg-white disabled:opacity-50 transition-colors"
            >
              {verificando ? "Verificando..." : "Verificar ahora"}
            </button>
          </div>
        )}

      {estado === "activo" && info?.dominioVerificadoEn && (
        <p className="text-xs text-slate-500">
          Verificado el {new Date(info.dominioVerificadoEn).toLocaleString()}.
        </p>
      )}
    </div>
  );
}

function SsoTenant({ tenantId }: { tenantId: string }) {
  const [config, setConfig] = useState<TenantSsoConfig | null>(null);
  const [issuerUrl, setIssuerUrl] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [dominioEmailPermitido, setDominioEmailPermitido] = useState("");
  const [activo, setActivo] = useState(false);
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Patrón estándar de carga al montar (setCargando(true) -> fetch ->
    // setCargando(false)), usado en toda la app.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCargando(true);
    obtenerSsoTenantApi(tenantId)
      .then((data) => {
        setConfig(data);
        setIssuerUrl(data.issuerUrl || "");
        setClientId(data.clientId || "");
        setDominioEmailPermitido(data.dominioEmailPermitido || "");
        setActivo(data.activo);
        setError(null);
      })
      .catch((err) => setError(err.message || "No se pudo cargar la config de SSO"))
      .finally(() => setCargando(false));
  }, [tenantId]);

  async function guardar(e: FormEvent) {
    e.preventDefault();
    setGuardando(true);
    try {
      const data = await configurarSsoTenantApi(tenantId, {
        issuerUrl: issuerUrl.trim(),
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        dominioEmailPermitido: dominioEmailPermitido.trim() || null,
        activo,
      });
      setConfig(data);
      setClientSecret(""); // nunca vuelve del backend — se limpia tras guardar
      setError(null);
    } catch (err: any) {
      setError(err.message || "No se pudo guardar la configuración de SSO");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 mb-6">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-light text-slate-400">SSO (OIDC)</h3>
        {!cargando && config?.configurado && (
          <span
            className={`px-2 py-0.5 rounded-full text-xs ${activo ? "bg-emerald-950 text-emerald-400" : "bg-slate-800 text-slate-400"}`}
          >
            {activo ? "Activo" : "Configurado, inactivo"}
          </span>
        )}
      </div>

      <form onSubmit={guardar} className="space-y-3">
        <input
          value={issuerUrl}
          onChange={(e) => setIssuerUrl(e.target.value)}
          placeholder="Issuer URL (ej. https://empresa.okta.com)"
          required
          className="w-full px-3 py-2 rounded-lg border border-slate-700 bg-slate-950 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500/30"
        />
        <div className="flex gap-3">
          <input
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="Client ID"
            required
            className="flex-1 px-3 py-2 rounded-lg border border-slate-700 bg-slate-950 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500/30"
          />
          <input
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder="Client secret"
            type="password"
            required
            className="flex-1 px-3 py-2 rounded-lg border border-slate-700 bg-slate-950 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500/30"
          />
        </div>
        {config?.configurado && (
          <p className="text-xs text-slate-500">
            El client secret nunca se muestra de nuevo — hay que volver a pegarlo cada vez que se
            guarda, aunque no haya cambiado.
          </p>
        )}
        <input
          value={dominioEmailPermitido}
          onChange={(e) => setDominioEmailPermitido(e.target.value)}
          placeholder="Dominio de email permitido (opcional, ej. empresa.com)"
          className="w-full px-3 py-2 rounded-lg border border-slate-700 bg-slate-950 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500/30"
        />
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input type="checkbox" checked={activo} onChange={(e) => setActivo(e.target.checked)} />
          Activo (muestra el botón de SSO en el login de esta empresa)
        </label>
        <button
          type="submit"
          disabled={guardando}
          className="px-4 py-2 rounded-lg bg-slate-800 text-slate-100 text-sm font-medium hover:bg-slate-700 disabled:opacity-50 transition-colors"
        >
          {guardando ? "Guardando..." : "Guardar SSO"}
        </button>
      </form>

      {error && (
        <p className="text-sm text-red-400 bg-red-950/40 border border-red-900 rounded-lg px-3 py-2 mt-3">
          {error}
        </p>
      )}
    </div>
  );
}

function ScimTenant({ tenantId }: { tenantId: string }) {
  const [config, setConfig] = useState<TenantScimConfig | null>(null);
  const [tokenNuevo, setTokenNuevo] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);
  const [procesando, setProcesando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function recargar() {
    try {
      setConfig(await obtenerScimTenantApi(tenantId));
      setError(null);
    } catch (err: any) {
      setError(err.message || "No se pudo cargar la config de SCIM");
    }
  }

  useEffect(() => {
    // Patrón estándar de carga al montar (setCargando(true) -> fetch ->
    // setCargando(false)), usado en toda la app.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCargando(true);
    recargar().finally(() => setCargando(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  async function rotar() {
    setProcesando(true);
    try {
      setTokenNuevo(await generarTokenScimApi(tenantId));
      await recargar();
    } catch (err: any) {
      setError(err.message || "No se pudo generar el token SCIM");
    } finally {
      setProcesando(false);
    }
  }

  async function revocar() {
    setProcesando(true);
    try {
      await revocarTokenScimApi(tenantId);
      setTokenNuevo(null);
      await recargar();
    } catch (err: any) {
      setError(err.message || "No se pudo revocar el token SCIM");
    } finally {
      setProcesando(false);
    }
  }

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 mb-6">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-light text-slate-400">SCIM (provisioning automático)</h3>
        {!cargando && config?.configurado && (
          <span
            className={`px-2 py-0.5 rounded-full text-xs ${config.activo ? "bg-emerald-950 text-emerald-400" : "bg-slate-800 text-slate-400"}`}
          >
            {config.activo ? "Activo" : "Revocado"}
          </span>
        )}
      </div>

      <p className="text-xs text-slate-500 mb-3">
        Endpoint: <span className="font-mono text-slate-300">/scim/v2</span> — autenticado con el
        token de abajo como bearer.
      </p>

      {tokenNuevo && (
        <div className="bg-slate-950 border border-amber-900 rounded-lg p-3 mb-3 space-y-1">
          <p className="text-xs text-amber-400">
            Copiá este token ahora — no se puede volver a mostrar (solo queda su hash guardado):
          </p>
          <div className="text-xs font-mono bg-slate-900 rounded px-2 py-1.5 text-slate-200 break-all">
            {tokenNuevo}
          </div>
        </div>
      )}

      <div className="flex gap-3">
        <button
          onClick={rotar}
          disabled={procesando}
          className="px-4 py-2 rounded-lg bg-slate-800 text-slate-100 text-sm font-medium hover:bg-slate-700 disabled:opacity-50 transition-colors"
        >
          {config?.configurado ? "Rotar token" : "Generar token"}
        </button>
        {config?.configurado && config.activo && (
          <button
            onClick={revocar}
            disabled={procesando}
            className="px-4 py-2 rounded-lg bg-red-950 text-red-400 text-sm font-medium hover:bg-red-900 disabled:opacity-50 transition-colors"
          >
            Revocar
          </button>
        )}
      </div>

      {error && (
        <p className="text-sm text-red-400 bg-red-950/40 border border-red-900 rounded-lg px-3 py-2 mt-3">
          {error}
        </p>
      )}
    </div>
  );
}

function ModulosUsuario({
  tenantId,
  usuarioId,
  onError,
}: {
  tenantId: string;
  usuarioId: string;
  onError: (msg: string) => void;
}) {
  const [modulos, setModulos] = useState<{ modulo: string; asignado: boolean }[]>([]);

  useEffect(() => {
    obtenerModulosUsuarioApi(tenantId, usuarioId)
      .then(setModulos)
      .catch((err) => onError(err.message || "No se pudieron cargar los módulos del usuario"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, usuarioId]);

  async function toggle(modulo: string) {
    const asignados = new Set(modulos.filter((m) => m.asignado).map((m) => m.modulo));
    if (asignados.has(modulo)) asignados.delete(modulo);
    else asignados.add(modulo);
    try {
      setModulos(await actualizarModulosUsuarioApi(tenantId, usuarioId, [...asignados]));
    } catch (err: any) {
      onError(err.message || "No se pudo actualizar el módulo del usuario");
    }
  }

  return (
    <div className="px-4 pb-3 flex flex-wrap gap-2 bg-slate-950/40">
      {modulos.map((m) => (
        <button
          key={m.modulo}
          onClick={() => toggle(m.modulo)}
          className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${
            m.asignado
              ? "bg-emerald-950 border-emerald-800 text-emerald-400"
              : "bg-slate-900 border-slate-800 text-slate-500"
          }`}
        >
          {m.modulo}
        </button>
      ))}
    </div>
  );
}

function NuevoUsuarioForm({ tenantId, onCreado }: { tenantId: string; onCreado: () => void }) {
  const [nombre, setNombre] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [rol, setRol] = useState("operador");
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setEnviando(true);
    try {
      await crearUsuarioApi(tenantId, { nombre, email, password, rol });
      onCreado();
    } catch (err: any) {
      setError(err.message || "No se pudo crear el usuario");
    } finally {
      setEnviando(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-slate-900 border border-slate-800 rounded-xl p-4 mb-4 grid grid-cols-1 sm:grid-cols-2 gap-3"
    >
      <input
        required
        value={nombre}
        onChange={(e) => setNombre(e.target.value)}
        placeholder="Nombre"
        className="px-3 py-2 rounded-lg border border-slate-700 bg-slate-950 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500/30"
      />
      <input
        required
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="Correo"
        className="px-3 py-2 rounded-lg border border-slate-700 bg-slate-950 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500/30"
      />
      <PasswordInput
        id="nuevoUsuarioPassword"
        required
        minLength={8}
        value={password}
        onChange={setPassword}
        placeholder="Contraseña inicial"
      />
      <select
        value={rol}
        onChange={(e) => setRol(e.target.value)}
        className="px-3 py-2 rounded-lg border border-slate-700 bg-slate-950 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500/30"
      >
        <option value="admin">admin</option>
        <option value="operador">operador</option>
        <option value="lectura">lectura</option>
      </select>

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
        {enviando ? "Creando..." : "Crear usuario"}
      </button>
    </form>
  );
}
