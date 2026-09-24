import { ChevronsRight } from "lucide-react";
import { useEffect, useState } from "react";

import EstadoOffline from "./EstadoOffline";
import Header from "./Header";
import Sidebar from "./Sidebar";

interface LayoutProps {
  activeTab: string;
  setActiveTab: (tab: any) => void;
  children: React.ReactNode;
}

// A partir de este ancho el sidebar convive con el contenido (empuja el
// layout al colapsarse); por debajo es un drawer que se superpone (overlay)
// porque no hay espacio para las dos cosas a la vez.
const BREAKPOINT_SIDEBAR_FIJO = 1024;

export default function Layout({ activeTab, setActiveTab, children }: LayoutProps) {
  const [sidebarAbierto, setSidebarAbierto] = useState(
    () => typeof window !== "undefined" && window.innerWidth >= BREAKPOINT_SIDEBAR_FIJO
  );

  // En mobile/tablet el sidebar es un drawer: elegir una pestaña debe
  // cerrarlo solo. En desktop, donde el sidebar empuja el contenido en vez
  // de taparlo, se queda como está.
  const handleSetActiveTab = (tab: any) => {
    setActiveTab(tab);
    if (window.innerWidth < BREAKPOINT_SIDEBAR_FIJO) setSidebarAbierto(false);
  };

  // La clase va en <body> (no en este div) para alcanzar también las ventanas
  // que se renderizan con createPortal. Ver styles/tema-oscuro.css.
  useEffect(() => {
    document.body.classList.add("tema-oscuro");
    return () => document.body.classList.remove("tema-oscuro");
  }, []);

  // Scroll "overlay": la barra solo se pinta (lima) mientras se scrollea.
  // El scroll no burbujea, por eso se escucha en captura sobre el document.
  useEffect(() => {
    const timers = new WeakMap<Element, number>();
    const alScrollear = (e: Event) => {
      const el = e.target instanceof Element ? e.target : document.documentElement;
      if (!el.classList.contains("scrolling-activo")) el.classList.add("scrolling-activo");
      window.clearTimeout(timers.get(el));
      timers.set(
        el,
        window.setTimeout(() => el.classList.remove("scrolling-activo"), 800)
      );
    };
    document.addEventListener("scroll", alScrollear, true);
    return () => document.removeEventListener("scroll", alScrollear, true);
  }, []);

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-[#0D1719] text-[#e2e8f0] font-sans">
      <Header onIrACombustible={() => setActiveTab("combustible")} />
      <EstadoOffline />

      <div className="flex flex-1 min-h-0 relative">
        {/* Overlay: solo en mobile/tablet, donde el sidebar es un drawer que
            tapa el contenido en vez de empujarlo. */}
        {sidebarAbierto && (
          <div
            className="absolute inset-0 z-30 bg-black/50 lg:hidden"
            onClick={() => setSidebarAbierto(false)}
          />
        )}

        <Sidebar
          activeTab={activeTab}
          setActiveTab={handleSetActiveTab}
          abierto={sidebarAbierto}
          onToggle={() => setSidebarAbierto((v) => !v)}
        />

        {/* Pestaña para reabrir cuando el sidebar está oculto -- vive acá y
            no en Sidebar porque cuando está cerrado el aside no se ve. */}
        {!sidebarAbierto && (
          <button
            onClick={() => setSidebarAbierto(true)}
            aria-label="Mostrar menú"
            title="Mostrar menú"
            className="fixed top-1/2 left-0 -translate-y-1/2 z-30 bg-[#192526] border border-[#BADC1E] border-l-0 rounded-r-md p-2 text-[#BADC1E] hover:bg-[#1f2e30] transition-colors"
          >
            <ChevronsRight size={18} />
          </button>
        )}

        <main className="flex-1 min-w-0 p-3 sm:p-4 lg:p-6 overflow-y-auto">
          <div className="w-full">{children}</div>
        </main>
      </div>
    </div>
  );
}
