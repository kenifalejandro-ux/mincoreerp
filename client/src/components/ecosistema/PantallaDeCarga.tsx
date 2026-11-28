// client/src/components/ecosistema/PantallaDeCarga.tsx
//
// Pantalla de transición entre el ERP y sus ecosistemas.
//
// Responsabilidades:
// - Cubrir visualmente el cambio de entorno.
// - Mostrar la identidad del ecosistema.
// - Mantener su color corporativo.
// - Comunicar el estado de la transición.
// - Respetar la preferencia de movimiento reducido.
//
// La pantalla no controla la navegación ni los permisos.
// Eso corresponde a App.tsx.

// ✅ Correcto
import { LayoutGrid, type LucideIcon } from "lucide-react";

import type { TransicionDeEcosistema } from "./transicionDeEcosistema";
import type { AcentoDeEcosistema } from "../../ecosistemas/ecosistemas";

// -----------------------------------------------------------------------------
// TIPOS
// -----------------------------------------------------------------------------

/**
 * Información visual del ecosistema durante la transición.
 */
export interface EcosistemaEnCarga {
  titulo: string;
  Icono: LucideIcon;
  imagen?: string;
  acento?: AcentoDeEcosistema;
}

// -----------------------------------------------------------------------------
// MENSAJES
// -----------------------------------------------------------------------------

const PASOS_AL_ENTRAR = [
  "Verificando tu acceso…",
  "Cargando tu empresa…",
  "Preparando tu espacio de trabajo…",
];

const PASOS_AL_VOLVER = ["Guardando tu sesión…", "Volviendo al menú principal…", "Listo…"];

// -----------------------------------------------------------------------------
// PALETAS DE IDENTIDAD VISUAL
// -----------------------------------------------------------------------------

const COLORES_ACENTO: Record<
  AcentoDeEcosistema,
  {
    principal: string;
    fondo: string;
    borde: string;
  }
> = {
  lima: {
    principal: "#BADC1E",
    fondo: "rgba(186, 220, 30, 0.10)",
    borde: "rgba(186, 220, 30, 0.40)",
  },

  naranja: {
    principal: "#F59E0B",
    fondo: "rgba(245, 158, 11, 0.10)",
    borde: "rgba(245, 158, 11, 0.40)",
  },

  azul: {
    principal: "#38BDF8",
    fondo: "rgba(56, 189, 248, 0.10)",
    borde: "rgba(56, 189, 248, 0.40)",
  },
};

// -----------------------------------------------------------------------------
// COMPONENTE
// -----------------------------------------------------------------------------

export default function PantallaDeCarga({
  tipo,
  ecosistema,
}: {
  tipo: TransicionDeEcosistema;
  ecosistema?: EcosistemaEnCarga;
}) {
  // ---------------------------------------------------------------------------
  // DATOS DE LA TRANSICIÓN
  // ---------------------------------------------------------------------------

  const entrando = tipo === "entrar";

  const aviso = entrando ? "Entrando al ecosistema" : "Volviendo al ERP";

  // Si falta accidentalmente la definición del ecosistema,
  // no mostramos un mensaje incorrecto de regreso al ERP.
  const titulo = entrando ? (ecosistema?.titulo ?? "Preparando ecosistema") : "MINCORE ERP";

  const Icono = entrando ? (ecosistema?.Icono ?? LayoutGrid) : LayoutGrid;

  const pasos = entrando ? PASOS_AL_ENTRAR : PASOS_AL_VOLVER;

  // Al volver, App.tsx entrega el ecosistema de origen.
  // Así podemos conservar también su imagen y su identidad visual.
  const imagen = ecosistema?.imagen;

  const acento = COLORES_ACENTO[ecosistema?.acento ?? "lima"];

  // ---------------------------------------------------------------------------
  // RENDER
  // ---------------------------------------------------------------------------

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-busy="true"
      aria-label={`${aviso}: ${titulo}`}
      data-testid="pantalla-de-carga"
      className="
        fixed inset-0 z-[300]
        isolate overflow-hidden
        flex items-center justify-center
        px-6 py-10
        text-center text-slate-200
        bg-[radial-gradient(circle_at_50%_40%,#16301a_0,#0d1719_55%)]
      "
    >
      {/* ------------------------------------------------------------------ */}
      {/* FONDO DEL ECOSISTEMA                                                */}
      {/* ------------------------------------------------------------------ */}

      {imagen && (
        <>
          <img
            src={imagen}
            alt=""
            aria-hidden="true"
            draggable={false}
            className="
              absolute inset-0 z-0
              h-full w-full
              object-cover
            "
          />

          <span
            aria-hidden="true"
            className="
              absolute inset-0 z-10
              bg-gradient-to-b
              from-[#0d1719]/65
              via-[#0d1719]/80
              to-[#0d1719]/90
            "
          />
        </>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* CONTENIDO                                                          */}
      {/* ------------------------------------------------------------------ */}

      <div
        className="
          relative z-20
          flex flex-col items-center
          justify-center
          gap-3
          w-full max-w-lg
        "
      >
        {/* Logo MinCore */}

        <img
          src="/logos/mincore-logo-512-sin-fondo.png"
          alt=""
          aria-hidden="true"
          draggable={false}
          className="
            h-12 w-12
            rounded-xl
            mb-1
            object-contain
          "
        />

        {/* Identidad visual del ecosistema */}

        <div
          aria-hidden="true"
          className="
            grid place-items-center
            h-20 w-20
            rounded-[20px]
            border
            shadow-[0_0_35px_rgba(0,0,0,0.20)]
            motion-safe:animate-pulse
          "
          style={{
            color: acento.principal,
            backgroundColor: acento.fondo,
            borderColor: acento.borde,
          }}
        >
          <Icono size={36} strokeWidth={1.8} />
        </div>

        {/* Identificación de la transición */}

        <p
          className="
            mt-2
            text-[10px]
            font-bold
            tracking-[0.2em]
            uppercase
            text-slate-400
          "
        >
          {aviso}
        </p>

        {/* Nombre del ecosistema */}

        <h2
          className="
            text-2xl sm:text-3xl
            font-semibold
            tracking-tight
            text-slate-50
          "
        >
          {titulo}
        </h2>

        {/* ---------------------------------------------------------------- */}
        {/* MENSAJES ANIMADOS                                                */}
        {/* ---------------------------------------------------------------- */}

        <p className="relative h-5 w-full text-sm text-slate-400">
          {/* Versión estática para usuarios con movimiento reducido */}

          <span className="motion-safe:hidden">{pasos[pasos.length - 1]}</span>

          {/* Versión animada */}

          <span
            className="
              relative hidden
              h-5 w-full
              motion-safe:block
            "
          >
            {pasos.map((paso, i) => (
              <span
                key={paso}
                className="
                  absolute inset-x-0
                  opacity-0
                  motion-safe:animate-[paso-carga_0.6s_ease_both]
                "
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

        {/* ---------------------------------------------------------------- */}
        {/* BARRA DE TRANSICIÓN                                               */}
        {/* ---------------------------------------------------------------- */}

        <div
          aria-hidden="true"
          className="
            mt-1
            h-1 w-64 max-w-full
            overflow-hidden
            rounded-full
            bg-[#203033]
          "
        >
          <div
            className="
              h-full w-full
              rounded-full
              motion-safe:w-0
              motion-safe:animate-[barra-carga_1.75s_cubic-bezier(.4,0,.2,1)_forwards]
            "
            style={{
              backgroundColor: acento.principal,
            }}
          />
        </div>
      </div>
    </div>
  );
}
