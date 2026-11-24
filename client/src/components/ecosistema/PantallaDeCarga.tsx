// client/src/components/ecosistema/PantallaDeCarga.tsx
//
// La pantalla que cubre el salto entre el ERP y un ecosistema (y de vuelta): sin ella el cambio de
// menú, de colores y de cabecera se siente brusco y parece que se sigue en la misma pantalla. Hoy
// lleva un ícono; la imagen con elementos 3D se agrega al final (no es prioridad).
//
// Con «reducir movimiento» no hay animación: el texto queda quieto y la barra aparece llena.
import { LayoutGrid, type LucideIcon } from "lucide-react";

import type { TransicionDeEcosistema } from "./transicionDeEcosistema";

/** Lo que identifica al ecosistema al que se entra (viene de su declaración en `ecosistemas.ts`). */
export interface EcosistemaEnCarga {
  titulo: string;
  Icono: LucideIcon;
}

const PASOS_AL_ENTRAR = [
  "Verificando tu acceso…",
  "Cargando tu empresa…",
  "Preparando tu espacio de trabajo…",
];

const AL_VOLVER = {
  aviso: "Volviendo al ERP",
  titulo: "MINCORE ERP",
  pasos: ["Guardando tu sesión…", "Volviendo al menú principal…", "Listo…"],
  Icono: LayoutGrid,
};

export default function PantallaDeCarga({
  tipo,
  ecosistema,
}: {
  tipo: TransicionDeEcosistema;
  /** A cuál se entra. Al volver al ERP no hace falta. */
  ecosistema?: EcosistemaEnCarga;
}) {
  const { aviso, titulo, pasos, Icono } =
    tipo === "entrar" && ecosistema
      ? {
          aviso: "Entrando al ecosistema",
          titulo: ecosistema.titulo,
          pasos: PASOS_AL_ENTRAR,
          Icono: ecosistema.Icono,
        }
      : AL_VOLVER;
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={`${aviso}: ${titulo}`}
      data-testid="pantalla-de-carga"
      className="fixed inset-0 z-[300] flex flex-col items-center justify-center gap-3 text-center text-slate-200 bg-[radial-gradient(circle_at_50%_40%,#16301a_0,#0d1719_55%)]"
    >
      <img
        src="/logos/mincore-logo-512-sin-fondo.png"
        alt=""
        className="w-12 h-12 rounded-xl mb-1"
      />
      <div className="w-20 h-20 rounded-[20px] bg-[#BADC1E]/10 border border-[#BADC1E]/40 text-[#BADC1E] grid place-items-center motion-safe:animate-pulse">
        <Icono size={36} strokeWidth={1.8} />
      </div>
      <p className="text-[10px] font-bold tracking-[0.2em] uppercase text-slate-400">{aviso}</p>
      <h2 className="text-3xl font-semibold text-slate-50">{titulo}</h2>
      <p className="h-5 text-sm text-slate-400">
        <span className="motion-safe:hidden">{pasos[pasos.length - 1]}</span>
        <span className="relative hidden w-72 motion-safe:block">
          {pasos.map((paso, i) => (
            <span
              key={paso}
              className="absolute inset-x-0 opacity-0 motion-safe:animate-[paso-carga_0.6s_ease_both]"
              style={{
                animationDelay: `${i * 0.6}s`,
                ...(i === pasos.length - 1 ? { animationName: "paso-carga-final" } : {}),
              }}
            >
              {paso}
            </span>
          ))}
        </span>
      </p>
      <div className="w-64 h-1 rounded bg-[#203033] overflow-hidden mt-1">
        <div className="h-full rounded bg-[#BADC1E] w-full motion-safe:w-0 motion-safe:animate-[barra-carga_1.75s_cubic-bezier(.4,0,.2,1)_forwards]" />
      </div>
    </div>
  );
}
