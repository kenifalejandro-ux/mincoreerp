// client/src/App.tsx

import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
} from "react";

import { puedeVerBandeja } from "./components/bandeja/bandejaAcceso";
import { puedeVerCisternas } from "./components/combustible/cisternasAcceso";
import {
  puedeCompraEnRuta,
  puedeVerDespachoGrifo,
} from "./components/combustible/compraEnRutaAcceso";
import { puedeVerPrecios } from "./components/combustible/preciosAcceso";
import { edicionDeProveedoresEnElEcosistema } from "./components/combustible/proveedoresEnEcosistema";
import PantallaDeCarga from "./components/ecosistema/PantallaDeCarga";
import {
  duracionDeTransicion,
  type TransicionDeEcosistema,
} from "./components/ecosistema/transicionDeEcosistema";
import {
  miViajeVaEnFlota,
  puedeVerMiViaje,
  puedeVerUnidades,
  puedeVerViajes,
} from "./components/flota/flotaAcceso";
import Layout from "./components/layout/Layout";
import { useAuth } from "./context/AuthContext";
import {
  ecosistemaDeLaPestana,
  ecosistemaDeLaRuta,
  ecosistemaDeModulo,
  moduloDeLaPestana,
  type DefinicionDeEcosistema,
} from "./ecosistemas/ecosistemas";
import { iconoDe } from "./ecosistemas/iconos";
import { MODULOS_CLIENTE } from "./modules/registry";
import CambiarPasswordObligatoria from "./pages/CambiarPasswordObligatoria";
import LoginPage from "./pages/LoginPage";

// -----------------------------------------------------------------------------
// COMPONENTES QUE NO FORMAN PARTE DEL REGISTRY
// -----------------------------------------------------------------------------

const FacturacionView = lazy(() => import("./components/facturacion/FacturacionView"));

const AdministracionView = lazy(() => import("./components/administracion/AdministracionView"));

const BandejaView = lazy(() => import("./components/bandeja/BandejaView"));

// -----------------------------------------------------------------------------
// TIPOS
// -----------------------------------------------------------------------------

type UsuarioDeSesion = {
  rol: string;
  modulosPermitidos: string[];
  permisosPestanas?: Record<string, boolean>;
} | null;

// -----------------------------------------------------------------------------
// DISPONIBILIDAD DE PESTAÑAS
// -----------------------------------------------------------------------------

/**
 * Obtiene el identificador del módulo detrás de una pestaña.
 */
function moduloIdDe(tab: string): string {
  return moduloDeLaPestana(tab);
}

/**
 * Determina si una pestaña está disponible para el usuario actual.
 *
 * Las pestañas especiales se resuelven antes de consultar
 * los módulos convencionales.
 */
function pestaniaDisponible(tab: string, usuario: UsuarioDeSesion): boolean {
  const moduloId = moduloIdDe(tab);
  // Facturación.
  if (moduloId === "facturacion") {
    if (usuario?.rol === "admin") return true;

    const override = usuario?.permisosPestanas?.["facturacion:principal"];

    if (override !== undefined) return override;

    return false;
  }

  // Administración.
  if (moduloId === "administracion") {
    return usuario?.rol === "admin";
  }

  // Ecosistemas.
  const ecosistema = ecosistemaDeModulo(moduloId);

  if (ecosistema) {
    return ecosistema.puedeVer(usuario);
  }

  // Bandeja.
  if (moduloId === "bandeja") {
    return puedeVerBandeja(usuario);
  }

  // ---------------------------------------------------------------------------
  // FLOTA
  // ---------------------------------------------------------------------------

  if (moduloId === "flota") {
    if (tab === "flota:mi_viaje") {
      return miViajeVaEnFlota(usuario);
    }

    return tab === "flota:viajes" ? puedeVerViajes(usuario) : puedeVerUnidades(usuario);
  }

  // ---------------------------------------------------------------------------
  // COMBUSTIBLE
  // ---------------------------------------------------------------------------

  if (moduloId === "combustible") {
    if (tab === "combustible:compra_ruta") {
      return puedeCompraEnRuta(usuario);
    }

    if (tab === "combustible:cisternas") {
      return puedeVerCisternas(usuario);
    }

    if (tab === "combustible:precios") {
      return puedeVerPrecios(usuario);
    }

    if (tab === "combustible:mi_viaje") {
      return puedeVerMiViaje(usuario);
    }

    if (tab === "combustible:despacho_grifo") {
      return puedeVerDespachoGrifo(usuario);
    }

    // Si el usuario administra proveedores desde el ecosistema,
    // no debe seguir apareciendo la antigua pestaña de combustible.
    if (tab === "combustible:proveedores" && edicionDeProveedoresEnElEcosistema(usuario)) {
      return false;
    }

    const pestana = tab === "combustible" ? "tanques" : tab.split(":")[1];

    const override = usuario?.permisosPestanas?.[`combustible:${pestana}`];

    if (override !== undefined) {
      return override;
    }

    // Compatibilidad con permisos anteriores.
    if (tab === "combustible:proveedores") {
      const antiguo = usuario?.permisosPestanas?.["combustible:tanques:proveedores"];

      return antiguo ?? (usuario?.rol === "admin" || usuario?.rol === "operador");
    }

    // Grifero.
    if (usuario?.rol === "grifero") {
      return tab === "combustible" || tab === "combustible:tanquetas";
    }

    // Conductor.
    if (usuario?.rol === "conductor_ruta") {
      return tab === "combustible";
    }

    // Encargado de Urea.
    if (usuario?.rol === "encargado_urea") {
      return tab === "combustible:urea";
    }
  }

  return (usuario?.modulosPermitidos ?? []).includes(moduloId);
}

// -----------------------------------------------------------------------------
// PESTAÑA INICIAL
// -----------------------------------------------------------------------------

/**
 * Determina la primera pestaña que puede abrir el usuario.
 */
function primeraPestania(usuario: UsuarioDeSesion): string {
  const override = (pestana: string) => usuario?.permisosPestanas?.[`combustible:${pestana}`];

  if (usuario?.rol === "conductor_ruta" && puedeVerMiViaje(usuario)) {
    return miViajeVaEnFlota(usuario) ? "flota:mi_viaje" : "combustible:mi_viaje";
  }

  if (usuario?.rol === "conductor_ruta" && override("tanques") !== false) {
    return "combustible";
  }

  if (usuario?.rol === "conductor_ruta" && puedeCompraEnRuta(usuario)) {
    return "combustible:compra_ruta";
  }

  if (usuario?.rol === "encargado_urea" && override("urea") !== false) {
    return "combustible:urea";
  }

  if (usuario?.rol === "grifero" && override("tanques") !== false) {
    return "combustible";
  }

  if (
    usuario?.rol === "operador" &&
    override("tanques") !== false &&
    (usuario.modulosPermitidos ?? []).includes("combustible")
  ) {
    return "combustible";
  }

  const permitidos = usuario?.modulosPermitidos ?? [];

  if (permitidos.includes("dashboard")) {
    return "dashboard";
  }

  return MODULOS_CLIENTE.find((m) => permitidos.includes(m.id))?.id ?? "dashboard";
}

// -----------------------------------------------------------------------------
// APP
// -----------------------------------------------------------------------------

function App() {
  const { usuario, cargando, estaAutenticado, login } = useAuth();

  // ---------------------------------------------------------------------------
  // ESTADO DE NAVEGACIÓN
  // ---------------------------------------------------------------------------

  const [activeTab, setActiveTab] = useState(
    () => ecosistemaDeLaRuta(window.location.pathname)?.pestaniaDeEntrada ?? "dashboard"
  );

  // Pestaña desde la cual se ingresó al ecosistema.
  const pestaniaAnterior = useRef<string | null>(null);

  // ---------------------------------------------------------------------------
  // TRANSICIONES
  // ---------------------------------------------------------------------------

  const [transicion, setTransicion] = useState<{
    tipo: TransicionDeEcosistema;
    ecosistema?: DefinicionDeEcosistema;
  } | null>(null);

  const temporizador = useRef<number | undefined>(undefined);

  useEffect(() => {
    return () => {
      window.clearTimeout(temporizador.current);
    };
  }, []);

  /**
   * Navegación centralizada entre ERP y ecosistemas.
   */
  const irA = useCallback(
    (destino: string) => {
      const alDestino = ecosistemaDeLaPestana(destino);
      const delOrigen = ecosistemaDeLaPestana(activeTab);

      // Movimiento dentro del mismo ecosistema:
      // no necesita pantalla de transición.
      if (alDestino?.id === delOrigen?.id) {
        setActiveTab(destino);
        return;
      }

      const entra = alDestino !== undefined;
      const vuelve = !entra;

      // Evitar dobles transiciones.
      if (temporizador.current !== undefined) {
        return;
      }

      // Recordar el origen solo cuando se entra desde el ERP.
      if (entra && delOrigen === undefined) {
        pestaniaAnterior.current = activeTab;
      }

      setTransicion({
        tipo: entra ? "entrar" : "volver",
        ecosistema: alDestino ?? delOrigen,
      });

      temporizador.current = window.setTimeout(() => {
        // Al salir del ecosistema se vuelve a la raíz.
        if (vuelve) {
          window.history.pushState(null, "", "/");
        }

        setActiveTab(destino);
        setTransicion(null);

        temporizador.current = undefined;
      }, duracionDeTransicion());
    },
    [activeTab]
  );

  // ---------------------------------------------------------------------------
  // EVENTOS DE NAVEGACIÓN INTERNA
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const alPedir = (e: Event) => {
      irA((e as CustomEvent<string>).detail);
    };

    window.addEventListener("mincore:ir-a-pestana", alPedir);

    return () => {
      window.removeEventListener("mincore:ir-a-pestana", alPedir);
    };
  }, [irA]);

  // ---------------------------------------------------------------------------
  // ATRÁS Y ADELANTE DEL NAVEGADOR
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const alVolver = () => {
      if (!usuario) return;

      const deLaRuta = ecosistemaDeLaRuta(window.location.pathname);

      const enEcosistema =
        ecosistemaDeLaPestana(activeTab) !== undefined && pestaniaDisponible(activeTab, usuario);

      if (deLaRuta && !enEcosistema) {
        setActiveTab(deLaRuta.pestaniaDeEntrada);
      } else if (!deLaRuta && enEcosistema) {
        const anterior = pestaniaAnterior.current;

        setActiveTab(
          anterior && pestaniaDisponible(anterior, usuario) ? anterior : primeraPestania(usuario)
        );
      }
    };

    window.addEventListener("popstate", alVolver);

    return () => {
      window.removeEventListener("popstate", alVolver);
    };
  }, [activeTab, usuario]);

  // ---------------------------------------------------------------------------
  // VALIDACIÓN DE ACCESO A RUTAS
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (cargando || !estaAutenticado || !usuario) {
      return;
    }

    const enEcosistema =
      ecosistemaDeLaPestana(activeTab) !== undefined && pestaniaDisponible(activeTab, usuario);

    // Una dirección de ecosistema sin permisos vuelve a la raíz.
    if (!enEcosistema && ecosistemaDeLaRuta(window.location.pathname)) {
      window.history.replaceState(null, "", "/");
    }
  }, [cargando, estaAutenticado, usuario, activeTab]);

  // ---------------------------------------------------------------------------
  // PESTAÑA EFECTIVAMENTE DISPONIBLE
  // ---------------------------------------------------------------------------

  const tabActiva = pestaniaDisponible(activeTab, usuario) ? activeTab : primeraPestania(usuario);

  // ---------------------------------------------------------------------------
  // CARGA Y AUTENTICACIÓN
  // ---------------------------------------------------------------------------

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
    return (
      <CambiarPasswordObligatoria
        onListo={() =>
          login({
            ...usuario!,
            debeCambiarPassword: false,
          })
        }
      />
    );
  }

  // ---------------------------------------------------------------------------
  // RESOLUCIÓN DEL MÓDULO ACTIVO
  // ---------------------------------------------------------------------------

  const moduloIdActivo = moduloIdDe(tabActiva);

  const moduloActivo = MODULOS_CLIENTE.find((m) => m.id === moduloIdActivo);

  const ComponenteActivo =
    moduloIdActivo === "facturacion"
      ? FacturacionView
      : moduloIdActivo === "administracion"
        ? AdministracionView
        : moduloIdActivo === "bandeja"
          ? BandejaView
          : moduloActivo?.componente;

  // ---------------------------------------------------------------------------
  // PROPIEDADES INTERNAS DE LOS MÓDULOS
  // ---------------------------------------------------------------------------

  const propsExtra =
    moduloIdActivo === "combustible"
      ? {
          pestanaInicial:
            tabActiva === "combustible:historico"
              ? "historico"
              : tabActiva === "combustible:tanquetas"
                ? "tanquetas"
                : tabActiva === "combustible:cisternas"
                  ? "cisternas"
                  : tabActiva === "combustible:mi_viaje"
                    ? "mi_viaje"
                    : tabActiva === "combustible:despacho_grifo"
                      ? "despacho_grifo"
                      : tabActiva === "combustible:compra_ruta"
                        ? "compra_ruta"
                        : tabActiva === "combustible:urea"
                          ? "urea"
                          : tabActiva === "combustible:precios"
                            ? "precios"
                            : tabActiva === "combustible:proveedores"
                              ? "proveedores"
                              : tabActiva === "combustible:auditoria"
                                ? "auditoria"
                                : tabActiva === "combustible:bitacora"
                                  ? "bitacora"
                                  : "tanques",
        }
      : moduloIdActivo === "flota"
        ? {
            pestanaInicial:
              tabActiva === "flota:viajes"
                ? "viajes"
                : tabActiva === "flota:mi_viaje"
                  ? "mi_viaje"
                  : "unidades",
          }
        : {};

  // ---------------------------------------------------------------------------
  // TIPADO DEL COMPONENTE ACTIVO
  // ---------------------------------------------------------------------------

  const ComponenteConProps = ComponenteActivo as ComponentType<Record<string, unknown>> | undefined;

  // ---------------------------------------------------------------------------
  // RENDER PRINCIPAL
  // ---------------------------------------------------------------------------

  return (
    <>
      {ecosistemaDeLaPestana(tabActiva) ? (
        // ---------------------------------------------------------------------
        // ENTORNO DEL ECOSISTEMA
        // ---------------------------------------------------------------------

        <Suspense fallback={<div className="p-20 text-center text-slate-500">Cargando...</div>}>
          {ComponenteConProps && (
            <ComponenteConProps
              onSalir={
                ecosistemaDeLaPestana(primeraPestania(usuario))
                  ? undefined
                  : () => irA(primeraPestania(usuario))
              }
            />
          )}
        </Suspense>
      ) : (
        // ---------------------------------------------------------------------
        // ENTORNO PRINCIPAL DEL ERP
        // ---------------------------------------------------------------------

        <Layout activeTab={tabActiva} setActiveTab={irA}>
          <Suspense fallback={<div className="p-20 text-center text-slate-500">Cargando...</div>}>
            {ComponenteConProps && <ComponenteConProps {...propsExtra} />}
          </Suspense>
        </Layout>
      )}

      {/* ------------------------------------------------------------------- */}
      {/* TRANSICIÓN ENTRE ENTORNOS                                            */}
      {/* ------------------------------------------------------------------- */}

      {transicion && (
        <PantallaDeCarga
          tipo={transicion.tipo}
          ecosistema={
            transicion.ecosistema && {
              titulo: transicion.ecosistema.titulo,

              Icono: iconoDe(transicion.ecosistema.icono),

              imagen: transicion.ecosistema.imagen,

              // NUEVO:
              // Cada ecosistema conserva su identidad cromática.
              acento: transicion.ecosistema.acento,
            }
          }
        />
      )}
    </>
  );
}

export default App;
