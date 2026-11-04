// La cisterna del proveedor, acostada: un cilindro largo y bajo con su cabina y sus ruedas. El
// líquido sube desde abajo como en un cilindro horizontal de verdad. Sin umbral ni capacidad: el
// 100% es lo que quedó al recibir (ver nivelCisterna.ts). Los colores van en hex, como el cilindro
// de "Nivel de tanque", para verse igual en el tema claro y en el oscuro.
import { useId } from "react";

import { coloresDeLaCisterna, type EstadoDelPlazo } from "./nivelCisterna";

// El vidrio del cilindro, en coordenadas del dibujo (ancho 320, alto 120).
const TANQUE = { x: 92, y: 18, ancho: 220, alto: 70, radio: 32 };

export default function CisternaAcostada({
  pct,
  plazo,
  descripcion,
}: {
  /** Cuánto del vidrio se llena, entre 0 y 100. */
  pct: number;
  plazo: EstadoDelPlazo;
  /** Lo que lee un lector de pantalla, con las cantidades reales. */
  descripcion: string;
}) {
  const id = useId();
  const [color, claro, oscuro, brillo] = coloresDeLaCisterna(plazo);
  const lleno = (TANQUE.alto * Math.min(100, Math.max(0, pct))) / 100;
  const nivelY = TANQUE.y + TANQUE.alto - lleno;
  return (
    <svg
      role="img"
      aria-label={descripcion}
      viewBox="0 0 320 120"
      className="w-full max-w-md h-auto"
      style={{ filter: pct > 0 ? `drop-shadow(0 0 12px ${brillo})` : undefined }}
    >
      <defs>
        <clipPath id={`${id}-vidrio`}>
          <rect
            x={TANQUE.x}
            y={TANQUE.y}
            width={TANQUE.ancho}
            height={TANQUE.alto}
            rx={TANQUE.radio}
          />
        </clipPath>
        <linearGradient id={`${id}-liquido`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={claro} />
          <stop offset="0.35" stopColor={color} />
          <stop offset="1" stopColor={oscuro} />
        </linearGradient>
        <linearGradient id={`${id}-reflejo`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.35" />
          <stop offset="0.4" stopColor="#fff" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity="0.35" />
        </linearGradient>
      </defs>
      {/* Chasis y ruedas */}
      <rect x="8" y="88" width="304" height="8" rx="3" fill="#334155" />
      {[40, 150, 188, 276].map((cx) => (
        <g key={cx}>
          <circle cx={cx} cy="100" r="13" fill="#0f1115" stroke="#334155" strokeWidth="4" />
          <circle cx={cx} cy="100" r="4" fill="#94a3b8" />
        </g>
      ))}
      {/* Cabina */}
      <path
        d="M8 88 V44 Q8 36 16 36 H56 L78 58 V88 Z"
        fill="#1e293b"
        stroke="#334155"
        strokeWidth="3"
      />
      <path d="M26 44 H52 L66 58 H26 Z" fill="#475569" opacity="0.8" />
      {/* Fondo del cilindro, líquido y vidrio */}
      <rect
        x={TANQUE.x}
        y={TANQUE.y}
        width={TANQUE.ancho}
        height={TANQUE.alto}
        rx={TANQUE.radio}
        fill="#0f1115"
      />
      <g clipPath={`url(#${id}-vidrio)`}>
        <rect
          x={TANQUE.x}
          y={nivelY}
          width={TANQUE.ancho}
          height={lleno}
          fill={`url(#${id}-liquido)`}
          style={{ transition: "y 700ms ease-out, height 700ms ease-out" }}
        />
        {pct > 0 && pct < 100 && (
          <rect
            x={TANQUE.x}
            y={nivelY}
            width={TANQUE.ancho}
            height="2"
            fill="#fff"
            opacity="0.45"
            style={{ transition: "y 700ms ease-out" }}
          />
        )}
        <rect
          x={TANQUE.x}
          y={TANQUE.y}
          width={TANQUE.ancho}
          height={TANQUE.alto}
          fill={`url(#${id}-reflejo)`}
        />
      </g>
      <rect
        x={TANQUE.x}
        y={TANQUE.y}
        width={TANQUE.ancho}
        height={TANQUE.alto}
        rx={TANQUE.radio}
        fill="none"
        stroke="#334155"
        strokeWidth="4"
      />
    </svg>
  );
}
