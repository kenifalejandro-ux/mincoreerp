// client/src/context/AuthContext.tsx

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { identificarUsuarioSentry } from "../config/sentry";
import { suscribirseAConectividad } from "../offline/connectivity";
import { drenar } from "../offline/offlineSync";
import { borrarPerfil, guardarPerfil, leerPerfil } from "../offline/perfilOffline";
import { precargarCatalogos } from "../offline/precargaCatalogos";
import {
  alinearCacheConTenant,
  marcarSesionConfirmada,
  registrarUsuarioActivo,
} from "../offline/sesionOffline";
import { registrarSesionExpirada } from "../services/apiClient";
import { getMeApi, logoutApi, type UsuarioPayload } from "../services/authApi";

interface AuthContextType {
  usuario: UsuarioPayload | null;
  cargando: boolean;
  login: (usuario: UsuarioPayload) => Promise<void>;
  /** Entrada sin señal con la clave ya comprobada contra la huella local. */
  loginSinConexion: (usuario: UsuarioPayload, confirmadoEn: number) => Promise<void>;
  logout: () => Promise<void>;
  estaAutenticado: boolean;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [usuario, setUsuario] = useState<UsuarioPayload | null>(null);
  const [cargando, setCargando] = useState(true);
  // true cuando la sesión se restauró desde el perfil guardado porque no había
  // red: el servidor todavía no la confirmó (ver offline/perfilOffline.ts).
  const [sesionSinConfirmar, setSesionSinConfirmar] = useState(false);
  // Quién es la persona de la pantalla, para compararla con la que confirme el
  // servidor al reconectar (ver el efecto de revalidación).
  const usuarioRef = useRef<UsuarioPayload | null>(null);
  useEffect(() => {
    usuarioRef.current = usuario;
  }, [usuario]);

  // La sesión vive en una cookie httpOnly: el cliente no puede leerla, así
  // que la única forma de saber si hay sesión activa es preguntarle al backend.
  useEffect(() => {
    getMeApi()
      .then(async (u) => {
        await alinearCacheConTenant(u.tenantId);
        guardarPerfil(u);
        setUsuario(u);
      })
      .catch((err) => {
        // fetch() solo tira TypeError cuando no hay red. Ahí no se sabe si la
        // sesión sigue viva, y el conductor/grifero en cancha no puede quedarse
        // fuera: se reabre con el perfil que el servidor confirmó por última
        // vez. Cualquier otro error (401...) es que el servidor no lo reconoce.
        const perfil = err instanceof TypeError ? leerPerfil() : null;
        if (perfil) {
          marcarSesionConfirmada(false);
          setUsuario(perfil);
          setSesionSinConfirmar(true);
        } else {
          setUsuario(null);
        }
      })
      .finally(() => setCargando(false));
  }, []);

  // Etiqueta los eventos de Sentry con el tenant y el rol del usuario
  // activo. Acá y no en el login: este efecto también corre cuando la
  // sesión se restaura sola al abrir la app (el getMe de arriba) y cuando
  // se cae por un refresh vencido, casos que no pasan por login(). Sin
  // esto, un error reportado no dice de qué tenant vino, que es lo primero
  // que hace falta para saber si algo le pasa a un cliente o a todos.
  useEffect(() => {
    identificarUsuarioSentry(usuario);
  }, [usuario]);

  // La cola offline y el caché de catálogos viven en el dispositivo (por
  // origen), no en la sesión — en una tablet compartida en planta hay que
  // decirles de quién es lo guardado. Acá y no en login() por el mismo
  // motivo que el efecto de Sentry: también corre cuando la sesión se
  // restaura sola al abrir la app. Ver offline/sesionOffline.ts.
  useEffect(() => {
    registrarUsuarioActivo(usuario?.id ?? null);
    // Y drenar lo que este usuario haya dejado pendiente. Hace falta un
    // disparo acá además del listener de "online": el caso típico es el
    // operario que llenó checklists sin señal, cerró la app, y la vuelve a
    // abrir ya con red — ahí nunca hubo transición offline→online que
    // disparar, y sin esto sus checklists se quedarían en el dispositivo
    // esperando a que la conexión se corte y vuelva.
    if (usuario) void drenar();
  }, [usuario]);

  // Con la sesión confirmada por el servidor, deja listos para el modo sin
  // señal los catálogos que sus formularios necesitan.
  useEffect(() => {
    if (usuario && !sesionSinConfirmar) void precargarCatalogos(usuario);
  }, [usuario, sesionSinConfirmar]);

  // Al volver la señal, el servidor confirma (o rechaza) la sesión restaurada:
  // un usuario desactivado o con la clave cambiada no sigue entrando.
  useEffect(() => {
    if (!sesionSinConfirmar) return;
    return suscribirseAConectividad((online) => {
      if (!online) return;
      getMeApi()
        .then(async (u) => {
          // La cookie que respondió puede ser de OTRA persona: quien tenía la
          // sesión pulsó SALIR sin señal (la cookie no se revocó) y otra entró
          // con su clave local. Esa persona no queda como la del servidor ni
          // lo que encoló se firma con la cuenta ajena: se cierra la sesión del
          // servidor y se pide entrar de nuevo.
          if (u.id !== usuarioRef.current?.id) {
            try {
              await logoutApi();
            } catch {
              // se limpia del lado del cliente de todas formas
            }
            borrarPerfil();
            marcarSesionConfirmada(true);
            setUsuario(null);
            setSesionSinConfirmar(false);
            return;
          }
          guardarPerfil(u);
          marcarSesionConfirmada(true);
          setUsuario(u);
          setSesionSinConfirmar(false);
          void drenar();
        })
        .catch((err) => {
          if (err instanceof TypeError) return; // sigue sin red: reintenta en el próximo aviso
          borrarPerfil();
          marcarSesionConfirmada(true);
          setUsuario(null);
          setSesionSinConfirmar(false);
        });
    });
  }, [sesionSinConfirmar]);

  // apiFetch llama acá cuando un 401 no se pudo resolver con /api/auth/refresh
  // (refresh token vencido, revocado, o inexistente) — cualquier pantalla que
  // esté abierta debe volver a mostrar el login, no quedarse pegada mostrando
  // datos de una sesión que el backend ya no reconoce.
  useEffect(() => {
    registrarSesionExpirada(() => {
      borrarPerfil();
      marcarSesionConfirmada(true);
      setSesionSinConfirmar(false);
      setUsuario(null);
    });
  }, []);

  // Memoizadas con useCallback (identidad estable, solo llaman a setUsuario
  // que React ya garantiza estable) para que los componentes que las meten
  // en un array de dependencias de useEffect no reinicialicen ese efecto en
  // cada render.
  const login = useCallback(async (usuario: UsuarioPayload) => {
    // Antes de mostrar nada, que las listas guardadas sean de esta empresa.
    await alinearCacheConTenant(usuario.tenantId);
    guardarPerfil(usuario);
    marcarSesionConfirmada(true);
    setSesionSinConfirmar(false);
    setUsuario(usuario);
  }, []);

  // El servidor no confirmó nada: la clave se comprobó contra la huella de este
  // equipo. La fecha de la última confirmación se conserva (no se renueva) y la
  // sesión queda "sin confirmar" hasta que vuelva la señal.
  const loginSinConexion = useCallback(async (usuario: UsuarioPayload, confirmadoEn: number) => {
    await alinearCacheConTenant(usuario.tenantId);
    guardarPerfil(usuario, confirmadoEn);
    marcarSesionConfirmada(false);
    setUsuario(usuario);
    setSesionSinConfirmar(true);
  }, []);

  const logout = useCallback(async () => {
    borrarPerfil();
    marcarSesionConfirmada(true);
    try {
      await logoutApi();
    } catch {
      // sesión de todas formas se limpia del lado del cliente
    }
    // Las listas guardadas NO se borran: quien sale tiene que poder volver a
    // entrar sin señal y encontrarlas. Que no se mezclen entre empresas lo
    // resuelve alinearCacheConTenant al entrar. La cola tampoco se borra — puede
    // tener trabajo sin sincronizar (ver offline/sesionOffline.ts).
    setUsuario(null);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        usuario,
        cargando,
        login,
        loginSinConexion,
        logout,
        estaAutenticado: !!usuario,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

// Colocar el hook junto a su Provider en el mismo archivo es el patrón
// estándar de Context en React -- separarlo a otro archivo solo por Fast
// Refresh sería más ruido que valor para un solo hook.
// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth debe usarse dentro de <AuthProvider>");
  return ctx;
}
