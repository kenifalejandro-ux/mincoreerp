// client/src/pages/LoginPage.tsx

import { useEffect, useRef, useState, type FormEvent } from "react";

import { useAuth } from "../context/AuthContext";
import {
  loginApi,
  googleLoginApi,
  forgotPasswordApi,
  ssoDisponibleApi,
  ssoIniciarUrl,
} from "../services/authApi";

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: {
            client_id: string;
            callback: (response: { credential: string }) => void;
          }) => void;
          renderButton: (parent: HTMLElement, options: Record<string, unknown>) => void;
        };
      };
    };
  }
}

const SUBDOMINIOS_RESERVADOS = new Set(["www", "app", "api", "admin"]);

/** Réplica en el cliente de resolveTenantSubdomain.ts (backend): si la app
 *  corre en "<slug>.<apexDomain>", el cliente entra directo por esa URL sin
 *  ver el campo "Empresa" — el backend igual vuelve a resolverlo del Host
 *  real de la petición, así que esto es solo para decidir qué mostrar en
 *  pantalla, nunca la fuente de verdad. Sin VITE_APP_APEX_DOMAIN
 *  configurado (o en localhost/dominio raíz) devuelve null y el campo
 *  manual sigue siendo el único camino — así es como entra hoy el dueño de
 *  la plataforma. */
function resolverSlugDeSubdominio(): string | null {
  const apexDomain = (import.meta.env.VITE_APP_APEX_DOMAIN as string | undefined)?.toLowerCase();
  if (!apexDomain) return null;

  const host = window.location.hostname.toLowerCase();
  if (host === apexDomain || !host.endsWith(`.${apexDomain}`)) return null;

  const slug = host.slice(0, -(apexDomain.length + 1));
  if (!slug || slug.includes(".") || SUBDOMINIOS_RESERVADOS.has(slug)) return null;

  return slug;
}

const SLUG_POR_DEFECTO =
  (import.meta.env.VITE_DEFAULT_TENANT_SLUG as string | undefined)?.trim() || null;

/** true si el host actual no es reconocible como "acceso del dueño de la
 *  plataforma" (localhost, o el dominio raíz configurado) — en ese caso
 *  puede ser tanto un subdominio propio como el dominio propio de un
 *  cliente (ej. "cushuro.pe"): en ambos casos el backend resuelve el
 *  tenant del Host real (ver resolveTenantSubdomain.ts), así que el
 *  frontend no necesita — ni puede, un dominio de cliente no sigue ningún
 *  patrón predecible — adivinar cuál es; solo oculta el campo y confía. */
function esHostDeClienteNoReconocido(): boolean {
  const apexDomain = (import.meta.env.VITE_APP_APEX_DOMAIN as string | undefined)?.toLowerCase();
  const host = window.location.hostname.toLowerCase();
  return host !== "localhost" && host !== "127.0.0.1" && host !== apexDomain;
}

export default function LoginPage() {
  const { login } = useAuth();
  const slugDeSubdominio = useState(resolverSlugDeSubdominio)[0];
  const esDominioDeCliente = useState(esHostDeClienteNoReconocido)[0];
  // Prioridad: subdominio propio reconocible > dominio de cliente (propio o
  // subdominio, resuelto por el backend, valor real desconocido acá) >
  // tenant por defecto del propio entorno (dueño de la plataforma) > campo
  // manual como último recurso.
  const slugResuelto = slugDeSubdominio ?? (esDominioDeCliente ? "auto" : null) ?? SLUG_POR_DEFECTO;
  const [tenantSlug, setTenantSlug] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [modo, setModo] = useState<"login" | "olvide">("login");
  const [mensajeOlvide, setMensajeOlvide] = useState<string | null>(null);

  const [ssoDisponible, setSsoDisponible] = useState(false);

  const googleBtnRef = useRef<HTMLDivElement>(null);
  // El callback de Google Identity Services se registra una sola vez (ver
  // useEffect más abajo) — usamos un ref para leer el slug vigente al
  // momento del click, en vez de uno capturado por el closure en el mount.
  const tenantSlugEfectivo = slugResuelto ?? tenantSlug;
  const tenantSlugRef = useRef(tenantSlugEfectivo);
  useEffect(() => {
    tenantSlugRef.current = tenantSlugEfectivo;
  }, [tenantSlugEfectivo]);
  const googleClientId = import.meta.env.VITE_GOOGLE_LOGIN_CLIENT_ID as string | undefined;

  // Botón "Iniciar sesión con SSO" — solo se muestra si el tenant resuelto
  // (por subdominio/dominio propio, o el que el usuario ya tipeó a mano)
  // tiene tenant_sso_config activo. Se re-chequea cada vez que cambia el
  // slug efectivo, así el campo manual también lo actualiza en vivo.
  useEffect(() => {
    // Con el slug vacío no hay nada que consultar -- el `false` para ese
    // caso se deriva en el render (ver ssoRealmenteDisponible más abajo),
    // no hace falta setState acá.
    if (!tenantSlugEfectivo.trim()) return;
    let cancelado = false;
    ssoDisponibleApi(tenantSlugEfectivo)
      .then((disponible) => {
        if (!cancelado) setSsoDisponible(disponible);
      })
      .catch(() => {
        if (!cancelado) setSsoDisponible(false);
      });
    return () => {
      cancelado = true;
    };
  }, [tenantSlugEfectivo]);
  // Evita mostrar un `ssoDisponible` desactualizado si el usuario borra un
  // slug que antes sí tenía SSO habilitado.
  const ssoRealmenteDisponible = tenantSlugEfectivo.trim() !== "" && ssoDisponible;

  // Si el callback de SSO falló y redirigió de vuelta acá con un error
  // (ver GET /api/auth/sso/callback), se lo mostramos igual que cualquier
  // otro error de login.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ssoError = params.get("ssoError");
    if (ssoError) {
      // Lectura única de un query param al montar (sincronización con la
      // URL, no un valor derivado de props/state) -- caso legítimo de
      // efecto según la propia guía de React.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setError(ssoError);
      params.delete("ssoError");
      const resto = params.toString();
      window.history.replaceState(null, "", resto ? `?${resto}` : window.location.pathname);
    }
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setEnviando(true);
    try {
      const usuario = await loginApi(tenantSlugEfectivo, email, password);
      login(usuario);
    } catch (err: any) {
      setError(err.message || "No se pudo iniciar sesión");
    } finally {
      setEnviando(false);
    }
  }

  async function handleOlvide(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setEnviando(true);
    try {
      const mensaje = await forgotPasswordApi(tenantSlugEfectivo, email);
      setMensajeOlvide(mensaje);
    } catch (err: any) {
      // El backend siempre responde el mismo mensaje genérico salvo que
      // falle la validación (ej. falta el campo Empresa) — ese sí se
      // muestra tal cual.
      setError(err.message || "No se pudo procesar la solicitud");
    } finally {
      setEnviando(false);
    }
  }

  // Botón "Continuar con Google" (Google Identity Services)
  useEffect(() => {
    if (!googleClientId) return;

    let cancelado = false;

    function renderizarBoton() {
      if (cancelado || !window.google?.accounts?.id || !googleBtnRef.current) return;

      window.google.accounts.id.initialize({
        client_id: googleClientId!,
        callback: async ({ credential }) => {
          if (!tenantSlugRef.current.trim()) {
            setError("Ingresa primero el identificador de tu empresa");
            return;
          }
          setError(null);
          setEnviando(true);
          try {
            const usuario = await googleLoginApi(tenantSlugRef.current, credential);
            login(usuario);
          } catch (err: any) {
            setError(err.message || "No se pudo iniciar sesión con Google");
          } finally {
            setEnviando(false);
          }
        },
      });

      window.google.accounts.id.renderButton(googleBtnRef.current, {
        type: "standard",
        theme: "outline",
        size: "large",
        text: "continue_with",
        shape: "pill",
        width: 320,
        locale: "es",
      });
    }

    if (window.google?.accounts?.id) {
      renderizarBoton();
      return;
    }

    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = renderizarBoton;
    document.head.appendChild(script);

    return () => {
      cancelado = true;
    };
  }, [googleClientId, login]);

  return (
    <div className="min-h-screen bg-[#DDF500] flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center gap-3 mb-8">
          {/**logo-mincore */}
          <img
            src="/logos/mincore-logo-512-badge.png"
            alt="MinCore"
            className="w-14 h-14 rounded-xl"
          />

          <h1 className="text-xl font-light text-slate-900 tracking-tight">MinCore ERP</h1>
        </div>

        {modo === "olvide" ? (
          <form
            onSubmit={handleOlvide}
            className="bg-[#1D2124] border border-slate-200 rounded-xl p-6 space-y-4 shadow-sm"
          >
            {!slugResuelto && (
              <div>
                <label
                  className="block text-sm font-light text-slate-100 mb-1.5"
                  htmlFor="tenantSlugOlvide"
                >
                  Empresa
                </label>
                <input
                  id="tenantSlugOlvide"
                  type="text"
                  required
                  autoComplete="organization"
                  value={tenantSlug}
                  onChange={(e) => setTenantSlug(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-400"
                  placeholder="ej. cushuro"
                />
              </div>
            )}

            <div>
              <label
                className="block text-sm font-light text-slate-100 mb-1.5"
                htmlFor="emailOlvide"
              >
                Correo
              </label>
              <input
                id="emailOlvide"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-400"
                placeholder="tu@empresa.com"
              />
            </div>

            {error && (
              <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
                {error}
              </p>
            )}

            {mensajeOlvide && (
              <p className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2">
                {mensajeOlvide}
              </p>
            )}

            <button
              type="submit"
              disabled={enviando}
              className="w-full py-2.5 rounded-lg bg-[#DDF500] text-zinc-900 text-sm font-medium hover:bg-[#DDF500]/80 disabled:opacity-50 transition-colors"
            >
              {enviando ? "Enviando..." : "Enviar instrucciones"}
            </button>

            <button
              type="button"
              onClick={() => {
                setModo("login");
                setError(null);
                setMensajeOlvide(null);
              }}
              className="w-full text-center text-sm font-light text-slate-300 hover:text-slate-100"
            >
              Volver a iniciar sesión
            </button>
          </form>
        ) : (
          <form
            onSubmit={handleSubmit}
            className="bg-[#1D2124] border border-slate-200 rounded-xl p-6 space-y-4 shadow-sm"
          >
            {!slugResuelto && (
              <div>
                <label
                  className="block  text-sm font-light text-slate-100 mb-1.5"
                  htmlFor="tenantSlug"
                >
                  Empresa
                </label>
                <input
                  id="tenantSlug"
                  type="text"
                  required
                  autoComplete="organization"
                  value={tenantSlug}
                  onChange={(e) => setTenantSlug(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border  border-slate-200 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-400"
                  placeholder="ej. cushuro"
                />
              </div>
            )}

            {/* Correo O DNI en el mismo campo (migración 0084): el grifero y
                los conductores de ruta no tienen correo corporativo. `type`
                pasa de "email" a "text" -- si no, el navegador rechaza un DNI
                antes de que el formulario llegue a enviarse. */}
            <div>
              <label className="block text-sm  font-light text-slate-100 mb-1.5" htmlFor="email">
                Correo o DNI
              </label>
              <input
                id="email"
                type="text"
                required
                autoComplete="username"
                inputMode="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-400"
                placeholder="tu@empresa.com  ·  o tu DNI"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-sm font-light text-slate-100" htmlFor="password">
                  Contraseña
                </label>
                <button
                  type="button"
                  onClick={() => {
                    setModo("olvide");
                    setError(null);
                    setMensajeOlvide(null);
                  }}
                  className="text-xs font-light text-slate-300 hover:text-slate-100"
                >
                  ¿Olvidaste tu contraseña?
                </button>
              </div>
              <input
                id="password"
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
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
              {enviando ? "Ingresando..." : "Ingresar"}
            </button>

            {(googleClientId || ssoRealmenteDisponible) && (
              <div className="flex items-center gap-3 pt-1">
                <div className="flex-1 h-px bg-slate-200" />
                <span className="text-xs font-light text-slate-400">o continúa con</span>
                <div className="flex-1 h-px bg-slate-100" />
              </div>
            )}

            {googleClientId && <div ref={googleBtnRef} className="flex justify-center" />}

            {ssoRealmenteDisponible && (
              <button
                type="button"
                onClick={() => {
                  window.location.href = ssoIniciarUrl(tenantSlugEfectivo);
                }}
                className="w-full py-2.5 rounded-lg border border-slate-200 bg-transparent text-slate-100 text-sm font-medium hover:bg-white/5 transition-colors"
              >
                Iniciar sesión con SSO
              </button>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
