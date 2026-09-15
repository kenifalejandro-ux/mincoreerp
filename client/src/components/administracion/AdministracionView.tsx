// client/src/components/administracion/AdministracionView.tsx
//
// El menú **Administración**, tal como Kenif lo pidió sobre el telebanking de
// su banco (ver docs/architecture/cuentas-perfiles-y-administracion.md §10):
//
//   Administración de usuarios  quién entra, con qué y en qué estado
//   Configuración               las autonomías: módulos y nivel por persona
//   Log de eventos              todo lo que se hizo, filtrable por fecha
//   Órdenes                     las órdenes con correlativo y su doble firma
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

type Seccion = "usuarios" | "configuracion" | "eventos" | "ordenes";

const SECCIONES: { id: Seccion; titulo: string }[] = [
  { id: "usuarios", titulo: "Usuarios" },
  { id: "configuracion", titulo: "Configuración" },
  { id: "eventos", titulo: "Log de eventos" },
  { id: "ordenes", titulo: "Órdenes" },
];

export default function AdministracionView() {
  const [seccion, setSeccion] = useState<Seccion>("usuarios");

  return (
    <div className="p-4 lg:p-8 animate-in fade-in duration-500">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-slate-800">Administración</h1>
        <p className="text-slate-600">
          Quién entra a tu empresa, qué puede hacer, y qué se hizo en el sistema
        </p>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-slate-200 mb-6">
        {SECCIONES.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setSeccion(s.id)}
            className={`px-5 py-3 text-sm font-semibold border-b-2 -mb-px transition-colors ${
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
        {/* Usuarios trae su propio encabezado y padding: se renderiza entero,
            sin el margen exterior de esta pantalla. */}
        {seccion === "usuarios" && (
          <div className="-m-4 lg:-m-8 -mt-2 lg:-mt-2">
            <UsuariosView />
          </div>
        )}
        {seccion === "configuracion" && <ConfiguracionView />}
        {seccion === "eventos" && <LogDeEventosView />}
        {seccion === "ordenes" && <OrdenesView />}
      </Suspense>
    </div>
  );
}
