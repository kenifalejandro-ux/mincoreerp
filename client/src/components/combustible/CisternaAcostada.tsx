// La cisterna del proveedor, acostada: un cilindro largo y bajo, con el brillo del cilindro de "Nivel
// de tanque" y su escala de 100 a 20 %. El líquido sube desde abajo. Sin umbral ni capacidad: el
// 100% es lo que quedó al recibir (ver nivelCisterna.ts). Los colores van en hex, como el cilindro
// de "Nivel de tanque", para verse igual en el tema claro y en el oscuro.
import { useId } from "react";

import { coloresDeLaCisterna, type EstadoDelPlazo } from "./nivelCisterna";

// El vidrio del cilindro, en coordenadas del dibujo (ancho 320, alto 148). A la izquierda queda el
// lugar de la escala.
const TANQUE = { x: 40, y: 12, ancho: 272, alto: 132, radio: 54 };
const MARCAS = [100, 80, 60, 40, 20];
// Marcas finas cada 10 % entre las numeradas, como la varilla de una cisterna.
const MARCAS_FINAS = [90, 70, 50, 30, 10];
// Los anillos de soldadura del cuerpo: dividen el largo en cuatro tramos.
const ANILLOS = [1, 2, 3];

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
  const yDe = (marca: number) => TANQUE.y + TANQUE.alto - (TANQUE.alto * marca) / 100;
  return (
    <svg
      role="img"
      aria-label={descripcion}
      viewBox="0 0 320 152"
      className="w-full h-auto"
      style={{ filter: pct > 0 ? `drop-shadow(0 0 14px ${brillo})` : undefined }}
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
          <stop offset="1" stopColor="#000" stopOpacity="0.4" />
        </linearGradient>
        {/* La franja de luz a lo largo del cilindro, más viva en el centro y apagada en las puntas. */}
        <linearGradient id={`${id}-franja`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity="0" />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0.55" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* La boca de inspección, sobre el lomo del cilindro */}
      <rect
        x={TANQUE.x + TANQUE.ancho / 2 - 18}
        y={TANQUE.y - 7}
        width="36"
        height="12"
        rx="4"
        fill="#334155"
      />
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
        {pct > 0 && (
          <rect
            x={TANQUE.x}
            y={nivelY + Math.min(lleno, TANQUE.alto * 0.28)}
            width={TANQUE.ancho}
            height="8"
            fill={`url(#${id}-franja)`}
            style={{ transition: "y 700ms ease-out" }}
          />
        )}
        {pct > 0 && pct < 100 && (
          <rect
            x={TANQUE.x}
            y={nivelY}
            width={TANQUE.ancho}
            height="2"
            fill="#fff"
            opacity="0.5"
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
        {/* Los anillos de soldadura: una sombra y un filo de luz, como las costuras de la chapa */}
        {ANILLOS.map((k) => {
          const x = TANQUE.x + (TANQUE.ancho * k) / (ANILLOS.length + 1);
          return (
            <g key={k}>
              <rect
                x={x - 2}
                y={TANQUE.y}
                width="4"
                height={TANQUE.alto}
                fill="#000"
                opacity="0.28"
              />
              <rect
                x={x + 2}
                y={TANQUE.y}
                width="1.5"
                height={TANQUE.alto}
                fill="#fff"
                opacity="0.22"
              />
            </g>
          );
        })}
        {/* Las rayas de la escala, tenues para no tapar el líquido */}
        {MARCAS.map((m) => (
          <line
            key={m}
            x1={TANQUE.x}
            x2={TANQUE.x + TANQUE.ancho}
            y1={yDe(m)}
            y2={yDe(m)}
            stroke="#94a3b8"
            strokeWidth="0.8"
            strokeDasharray="3 4"
            opacity="0.5"
          />
        ))}
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
      {/* La escala, a la izquierda del vidrio */}
      {MARCAS.map((m) => (
        <text
          key={m}
          x={TANQUE.x - 6}
          y={yDe(m) + 3}
          textAnchor="end"
          fontSize="9"
          fontFamily="monospace"
          fill="#94a3b8"
        >
          {m}%
        </text>
      ))}
      {/* Las marcas de la escala: largas en las numeradas, cortas entre ellas */}
      {MARCAS.map((m) => (
        <line
          key={`l${m}`}
          x1={TANQUE.x - 4}
          x2={TANQUE.x}
          y1={yDe(m)}
          y2={yDe(m)}
          stroke="#94a3b8"
          strokeWidth="1.2"
        />
      ))}
      {MARCAS_FINAS.map((m) => (
        <line
          key={`f${m}`}
          x1={TANQUE.x - 2}
          x2={TANQUE.x}
          y1={yDe(m)}
          y2={yDe(m)}
          stroke="#64748b"
          strokeWidth="1"
        />
      ))}
    </svg>
  );
}
