// client/src/components/proveedores/EcosistemaProveedores.tsx
//
// El ecosistema «Gestión de proveedores»: un espacio aparte dentro del ERP, con su propia cabecera y su
// propio menú, para que el menú del ERP no crezca con cada pantalla. Va FUERA del Layout del ERP (ver
// App.tsx): fondo claro y paneles blancos; el menú lateral conserva el diseño del ERP (fondo
// #192526, borde lima, ítems a todo el ancho con hover lima).
//
// PR1: Centro de gestión y Directorio funcionan (solo lectura). Lo demás está en el menú como
// «Pronto» para mostrar a dónde va el ecosistema, sin cifras de ejemplo.
import {
  AlertTriangle,
  Building2,
  ClipboardCheck,
  Clock,
  FileText,
  FolderOpen,
  LayoutGrid,
  LogOut,
  Menu,
  Receipt,
  ShieldCheck,
  Sparkles,
  Star,
  Truck,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";

import CentroDeGestion from "./CentroDeGestion";
import DirectorioProveedores from "./DirectorioProveedores";
import SeccionPronto from "./SeccionPronto";
import { useAuth } from "../../context/AuthContext";

interface ItemDeMenu {
  id: string;
  label: string;
  Icono: LucideIcon;
  /** Sin pantalla todavía. */
  pronto?: { descripcion: string };
}

const GRUPOS: { etiqueta: string; items: ItemDeMenu[] }[] = [
  { etiqueta: "", items: [{ id: "centro", label: "Centro de gestión", Icono: LayoutGrid }] },
  {
    etiqueta: "Empresas",
    items: [
      { id: "directorio", label: "Directorio de proveedores", Icono: Building2 },
      {
        id: "contactos",
        label: "Contactos",
        Icono: Users,
        pronto: { descripcion: "Las personas de contacto de cada proveedor." },
      },
    ],
  },
  {
    etiqueta: "Control y validación",
    items: [
      {
        id: "homologacion",
        label: "Homologación",
        Icono: ShieldCheck,
        pronto: {
          descripcion:
            "Aprobar a cada proveedor antes de que reciba pedidos. Se enciende por empresa.",
        },
      },
      {
        id: "documentos",
        label: "Gestión documental",
        Icono: FolderOpen,
        pronto: { descripcion: "Registros y certificados de cada proveedor, con su vencimiento." },
      },
      {
        id: "contratos",
        label: "Contratos",
        Icono: FileText,
        pronto: { descripcion: "Vigencias y condiciones de los contratos con proveedores." },
      },
      {
        id: "riesgos",
        label: "Riesgos y cumplimiento",
        Icono: AlertTriangle,
        pronto: { descripcion: "Qué proveedores necesitan atención antes de que sea un problema." },
      },
    ],
  },
  {
    etiqueta: "Abastecimiento",
    items: [
      {
        id: "comercial",
        label: "Gestión comercial",
        Icono: Star,
        pronto: { descripcion: "Los precios negociados con cada proveedor, para compararlos." },
      },
      {
        id: "compras",
        label: "Compras y recepciones",
        Icono: Truck,
        pronto: { descripcion: "Registrar la compra y seguirla hasta la recepción en cancha." },
      },
      {
        id: "pagos",
        label: "Facturación y pagos",
        Icono: Receipt,
        pronto: { descripcion: "Facturas de compra y pagos a proveedores." },
      },
    ],
  },
  {
    etiqueta: "Seguimiento",
    items: [
      {
        id: "evaluacion",
        label: "Evaluación y desempeño",
        Icono: ClipboardCheck,
        pronto: { descripcion: "Cómo está cumpliendo cada proveedor." },
      },
      {
        id: "historial",
        label: "Historial y auditoría",
        Icono: Clock,
        pronto: { descripcion: "Quién cambió qué y cuándo en los datos de proveedores." },
      },
    ],
  },
];

const TODOS = GRUPOS.flatMap((g) => g.items);

export default function EcosistemaProveedores({ onSalir }: { onSalir?: () => void }) {
  const { usuario, logout } = useAuth();
  const [seccion, setSeccion] = useState("centro");
  const [menuAbierto, setMenuAbierto] = useState(false);

  const actual = TODOS.find((i) => i.id === seccion) ?? TODOS[0];
  const irA = (id: string) => {
    setSeccion(id);
    setMenuAbierto(false);
  };

  return (
    <div className="min-h-screen bg-[#f4f6f9] text-slate-700 font-sans">
      <header className="fixed inset-x-0 top-0 z-40 h-16 bg-white border-b border-slate-200 flex items-center gap-3 px-4 sm:px-6">
        <button
          onClick={() => setMenuAbierto(true)}
          aria-label="Abrir el menú"
          className="lg:hidden p-2 -ml-2 rounded-md text-slate-600 hover:bg-slate-100"
        >
          <Menu size={20} />
        </button>
        <div className="flex items-center gap-3 lg:w-56 shrink-0">
          <span className="w-9 h-9 rounded-lg bg-[#0A1014] grid place-items-center">
            <img src="/logos/mincore-logo-512-sin-fondo.png" alt="MinCore" className="w-7 h-7" />
          </span>
          <span className="hidden sm:block font-semibold tracking-wide text-slate-900">
            MINCORE{" "}
            <span className="text-[9px] font-extrabold tracking-[0.16em] text-[#4d7c0f]">ERP</span>
          </span>
        </div>
        <div className="hidden md:flex flex-col leading-tight pl-5 border-l border-slate-200">
          <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
            Gestión empresarial
          </span>
          <b className="text-sm text-slate-900">Gestión de proveedores</b>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <div className="flex items-center gap-2" title={usuario?.nombre}>
            <span className="w-8 h-8 rounded-full bg-[#BADC1E]/30 text-[#3f6212] grid place-items-center text-xs font-bold">
              {(usuario?.nombre ?? "?").slice(0, 2).toUpperCase()}
            </span>
            <span className="hidden md:block text-sm font-medium text-slate-800">
              {usuario?.nombre}
            </span>
          </div>
          <button
            onClick={() => logout()}
            title="Cerrar sesión"
            aria-label="Cerrar sesión"
            className="p-2 rounded-md text-slate-500 hover:text-slate-900 hover:bg-slate-100"
          >
            <LogOut size={18} />
          </button>
        </div>
      </header>

      {menuAbierto && (
        <button
          aria-label="Cerrar el menú"
          onClick={() => setMenuAbierto(false)}
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
        />
      )}

      <aside
        aria-label="Menú de Gestión de proveedores"
        className={`fixed top-16 bottom-0 left-0 z-50 w-64 overflow-y-auto bg-[#192526] border-l-[3px] border-[#BADC1E] flex flex-col transition-transform duration-300 lg:translate-x-0 ${
          menuAbierto ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="p-4 border-b border-white/10">
          <div className="flex items-center justify-between">
            <button
              onClick={onSalir}
              className="flex items-center gap-2 text-xs text-slate-400 hover:text-[#BADC1E]"
            >
              <span aria-hidden>←</span> Volver al ERP
            </button>
            <button
              onClick={() => setMenuAbierto(false)}
              aria-label="Cerrar el menú"
              className="lg:hidden text-slate-400 hover:text-white"
            >
              <X size={18} />
            </button>
          </div>
          <div className="flex items-center gap-3 mt-4">
            <span className="w-9 h-9 rounded-lg bg-[#BADC1E]/15 text-[#BADC1E] grid place-items-center">
              <Building2 size={18} />
            </span>
            <div>
              <small className="block text-[9px] font-bold tracking-[0.14em] text-slate-400">
                ECOSISTEMA
              </small>
              <b className="text-sm text-slate-50">Gestión de proveedores</b>
            </div>
          </div>
        </div>

        <nav className="flex-1 py-3 flex flex-col gap-0.5">
          {GRUPOS.map((g, i) => (
            <div key={g.etiqueta || i} className="mb-2">
              {g.etiqueta && (
                <p className="px-6 pt-3 pb-1.5 text-[9px] font-bold uppercase tracking-[0.12em] text-slate-500">
                  {g.etiqueta}
                </p>
              )}
              {g.items.map(({ id, label, Icono, pronto }) => {
                const activo = seccion === id;
                return (
                  <button
                    key={id}
                    onClick={() => irA(id)}
                    aria-current={activo ? "page" : undefined}
                    className={`group w-full text-left px-6 py-3 flex items-center gap-3 text-sm transition-all ${
                      activo
                        ? "bg-[#BADC1E] text-[#0A1014] font-semibold"
                        : `${pronto ? "text-slate-500" : "text-slate-400"} hover:bg-[#BADC1E] hover:text-[#0A1014] font-medium`
                    }`}
                  >
                    <Icono
                      size={18}
                      strokeWidth={2}
                      className={`shrink-0 ${activo ? "text-[#0A1014]" : "text-slate-500 group-hover:text-[#0A1014]"}`}
                    />
                    <span className="tracking-tight flex-1">{label}</span>
                    {pronto && (
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full border border-dashed border-slate-600 text-slate-500 group-hover:border-[#0A1014]/40 group-hover:text-[#0A1014]">
                        Pronto
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
        <p className="px-6 py-4 text-[11px] text-slate-500 border-t border-white/10 flex items-center gap-2">
          <Sparkles size={14} /> Cada empresa usa solo lo que contrató.
        </p>
      </aside>

      <main className="pt-16 lg:pl-64">
        <div className="p-4 sm:p-6 lg:p-8 max-w-[1500px]">
          {actual.id === "centro" && <CentroDeGestion onIrAlDirectorio={() => irA("directorio")} />}
          {actual.id === "directorio" && <DirectorioProveedores />}
          {actual.pronto && (
            <SeccionPronto
              titulo={actual.label}
              descripcion={actual.pronto.descripcion}
              onVolver={() => irA("centro")}
            />
          )}
        </div>
      </main>
    </div>
  );
}
