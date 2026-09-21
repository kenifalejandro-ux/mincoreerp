import { useEffect } from "react";

import EstadoOffline from "./EstadoOffline";
import Header from "./Header";
import Sidebar from "./Sidebar";

interface LayoutProps {
  activeTab: string;
  setActiveTab: (tab: any) => void;
  children: React.ReactNode;
}

export default function Layout({ activeTab, setActiveTab, children }: LayoutProps) {
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

      <div className="flex flex-1 min-h-0">
        <Sidebar activeTab={activeTab} setActiveTab={setActiveTab} />

        <main className="flex-1 min-w-0 p-4 lg:p-6 overflow-y-auto">
          <div className="w-full">{children}</div>
        </main>
      </div>
    </div>
  );
}
