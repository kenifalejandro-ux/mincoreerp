// client/src/App.tsx
import { Suspense, lazy, useState, type ComponentType } from "react";

import Layout from "./components/layout/Layout";
import { useAuth } from "./context/AuthContext";
import { MODULOS_CLIENTE } from "./modules/registry";
import CambiarPasswordObligatoria from "./pages/CambiarPasswordObligatoria";
import LoginPage from "./pages/LoginPage";

// Facturación no es un módulo del registry (ver Sidebar.tsx) -- se resuelve
// aparte, no vía MODULOS_CLIENTE.find().
const FacturacionView = lazy(() => import("./components/facturacion/FacturacionView"));

// Administración tampoco: la gente de la empresa no se contrata ni se
// factura, y un tenant sin ningún módulo habilitado igual tiene que poder dar
// de alta a su personal. Es la única pestaña que además depende del ROL -- el
// Sidebar no la muestra si no sos admin, y el backend la rechaza igual
// (requireRole).
const AdministracionView = lazy(() => import("./components/administracion/AdministracionView"));

type UsuarioDeSesion = { rol: string; modulosPermitidos: string[] } | null;

/** El id del MÓDULO detrás de un activeTab, sin la sub-pestaña. Solo
 *  Combustible tiene submenú hoy ("combustible:historico" -- ver
 *  Sidebar.tsx); el permiso y el componente a cargar dependen del módulo,
 *  no de cuál de sus sub-pestañas esté abierta. */
function moduloIdDe(tab: string): string {
  return tab.split(":")[0];
}

/** Si esta pestaña existe PARA ESTE usuario. Las dos que no son módulos van
 *  primero: Facturación la ve cualquiera, Administración solo el admin. */
function pestaniaDisponible(tab: string, usuario: UsuarioDeSesion): boolean {
  const moduloId = moduloIdDe(tab);
  if (moduloId === "facturacion") return true;
  if (moduloId === "administracion") return usuario?.rol === "admin";
  return (usuario?.modulosPermitidos ?? []).includes(moduloId);
}

/** Con qué abre la app: el dashboard si lo tiene, y si no el primer módulo
 *  que sí, en el orden del menú. */
function primeraPestania(usuario: UsuarioDeSesion): string {
  const permitidos = usuario?.modulosPermitidos ?? [];
  if (permitidos.includes("dashboard")) return "dashboard";
  return MODULOS_CLIENTE.find((m) => permitidos.includes(m.id))?.id ?? "dashboard";
}

function App() {
  const { usuario, cargando, estaAutenticado, login } = useAuth();
  const [activeTab, setActiveTab] = useState("dashboard");

  // "dashboard" fijo dejaba la pantalla EN BLANCO a cualquiera que no tuviera
  // ese módulo: el Sidebar no le dibuja el botón, activeTab queda apuntando a
  // un módulo que no está en su lista y no se renderiza nada. Era latente
  // --hasta ahora todo usuario tenía todos los módulos-- y dejó de serlo con
  // los roles de cancha (0085), que solo ven Combustible.
  //
  // Se corrige DERIVANDO en cada render en vez de con un efecto que corrija
  // el estado: el usuario llega asincrónicamente (AuthContext pregunta al
  // backend), así que en el primer render todavía es null y cualquier valor
  // inicial calculado ahí sería el equivocado. Derivar no tiene ese problema
  // ni pinta un frame en blanco antes de acomodarse.
  const tabActiva = pestaniaDisponible(activeTab, usuario) ? activeTab : primeraPestania(usuario);

  if (cargando) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="text-white text-xl">Cargando MinCore ERP...</div>
      </div>
    );
  }

  if (!estaAutenticado) {
    return <LoginPage />;
  }

  if (usuario!.debeCambiarPassword) {
    // Actualiza el usuario en memoria en vez de re-pedir /api/auth/me: el
    // JWT actual seguiría diciendo `true` hasta el próximo login/refresh
    // (ver el comentario de cambiarMiPasswordApi en services/authApi.ts).
    return (
      <CambiarPasswordObligatoria
        onListo={() => login({ ...usuario!, debeCambiarPassword: false })}
      />
    );
  }

  // El componente de cada módulo viaja al navegador recién cuando se abre
  // (React.lazy, ver modules/registry.tsx) — agregar un módulo nuevo no
  // infla el chunk inicial de los que ya existen.
  const moduloIdActivo = moduloIdDe(tabActiva);
  const moduloActivo = MODULOS_CLIENTE.find((m) => m.id === moduloIdActivo);
  const ComponenteActivo =
    moduloIdActivo === "facturacion"
      ? FacturacionView
      : moduloIdActivo === "administracion"
        ? AdministracionView
        : moduloActivo?.componente;
  // Combustible es, por ahora, el único módulo con sub-pestaña (ver
  // Sidebar.tsx) -- se la pasamos como prop en vez de que el panel la lea
  // de activeTab directamente, para no acoplar ese componente al formato
  // "modulo:subpestaña" del sidebar.
  const propsExtra =
    moduloIdActivo === "combustible"
      ? {
          pestanaInicial:
            tabActiva === "combustible:historico"
              ? "historico"
              : tabActiva === "combustible:urea"
                ? "urea"
                : tabActiva === "combustible:auditoria"
                  ? "auditoria"
                  : tabActiva === "combustible:bitacora"
                    ? "bitacora"
                    : "tanques",
        }
      : {};

  // El registry tipa cada componente sin props (ComponentType<{}>) porque la
  // gran mayoría no las recibe -- Combustible es la única excepción, así que
  // el cast queda acá, localizado, en vez de aflojar el tipo para todos.
  const ComponenteConProps = ComponenteActivo as ComponentType<Record<string, unknown>> | undefined;

  return (
    <Layout activeTab={tabActiva} setActiveTab={setActiveTab}>
      <Suspense fallback={<div className="p-20 text-center text-slate-500">Cargando...</div>}>
        {ComponenteConProps && <ComponenteConProps {...propsExtra} />}
      </Suspense>
    </Layout>
  );
}

export default App;
