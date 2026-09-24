// client/src/components/administracion/AdministracionView.tsx
//
// El menú **Administración**, tal como Kenif lo pidió sobre el telebanking de
// su banco (ver docs/architecture/cuentas-perfiles-y-administracion.md §10):
//
//   Administración de usuarios  quién entra, con qué y en qué estado
//   Configuración               las autonomías: módulos y nivel por persona
//   Log de eventos              todo lo que se hizo, filtrable por fecha
//   Órdenes                     las órdenes con correlativo y su doble firma
//   Sedes y grifos              las plantas y sus grifos internos (0097)
//
// Solo lo ve un administrador. El sidebar no dibuja la entrada para nadie
// más y el servidor rechaza igual cada ruta (requireRole("admin")): la
// pantalla evita mostrar una puerta cerrada, no es el control.
import { lazy, Suspense, useState } from "react";

import UsuariosView from "../usuarios/UsuariosView";

// Las pestañas que no son la primera viajan al navegador recién cuando se
// abren: la mayoría de las visitas a Administración son para dar de alta a
// alguien y se van sin tocar las demás.
const ConfiguracionView = lazy(() => import("./ConfiguracionView"));
const LogDeEventosView = lazy(() => import("./LogDeEventosView"));
const OrdenesView = lazy(() => import("./OrdenesView"));
const SedesYGrifosView = lazy(() => import("./SedesYGrifosView"));

type Seccion = "usuarios" | "configuracion" | "eventos" | "ordenes" | "sedes";

const SECCIONES: { id: Seccion; titulo: string }[] = [
  { id: "usuarios", titulo: "Usuarios" },
  { id: "configuracion", titulo: "Configuración" },
  { id: "eventos", titulo: "Log de eventos" },
  { id: "ordenes", titulo: "Órdenes" },
  { id: "sedes", titulo: "Sedes y grifos" },
];

export default function AdministracionView() {
  const [seccion, setSeccion] = useState<Seccion>("usuarios");

  return (
    <div className="p-2 sm:p-4 lg:p-8 animate-in fade-in duration-500">
      <div className="mb-6">
        <h1 className="text-lg sm:text-xl lg:text-2xl font-bold text-slate-800 tracking-tight">
          Administración
        </h1>
        <p className="text-xs sm:text-sm text-slate-600">
          Quién entra a tu empresa, qué puede hacer, y qué se hizo en el sistema
        </p>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-slate-200 mb-6">
        {SECCIONES.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setSeccion(s.id)}
            className={`px-3 sm:px-5 py-2.5 sm:py-3 text-xs sm:text-sm font-semibold border-b-2 -mb-px transition-colors ${
              seccion === s.id
                ? "border-[#DDF500] text-slate-900"
                : "border-transparent text-slate-500 hover:text-slate-800"
            }`}
          >
            {s.titulo}
          </button>
        ))}
      </div>

      <Suspense fallback={<div className="p-20 text-center text-slate-500">Cargando...</div>}>
        {seccion === "usuarios" && <UsuariosView />}
        {seccion === "configuracion" && <ConfiguracionView />}
        {seccion === "eventos" && <LogDeEventosView />}
        {seccion === "ordenes" && <OrdenesView />}
        {seccion === "sedes" && <SedesYGrifosView />}
      </Suspense>
    </div>
  );
}
