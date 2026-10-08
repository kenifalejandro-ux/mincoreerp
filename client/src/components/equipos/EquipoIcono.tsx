// client/src/components/equipos/EquipoIcono.tsx
//
// Dibujo lineal por tipo de maquinaria (hechos para este proyecto). Toma el
// color del texto: quien lo use decide si va en lima o en gris.
import type { ReactNode } from "react";

import { claveIcono, type ClaveIcono } from "./equiposVista";

const rueda = (cx: number, cy: number, r = 3.6) => (
  <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={r} />
);

const TRAZOS: Record<ClaveIcono, ReactNode> = {
  volquete: (
    <>
      <path d="M3 26V16h9l5 6v4" />
      <path d="M19 26V11l32-4-3 19" />
      <path d="M3 26h46" />
      {rueda(11, 28)}
      {rueda(35, 28)}
      {rueda(44, 28)}
    </>
  ),
  excavadora: (
    <>
      <rect x="5" y="25" width="30" height="7" rx="3.5" />
      <path d="M10 25v-9h11l4 9" />
      <path d="M21 17 33 6l13 8" />
      <path d="M46 14l-5 12" />
      <path d="M41 26h7l-2-6" />
    </>
  ),
  retroexcavadora: (
    <>
      <path d="M17 24V11h15v13" />
      <path d="M33 17l11-10 8 12" />
      <path d="M3 18h8l-2 8H4z" />
      <path d="M11 21h6" />
      {rueda(14, 29, 4)}
      {rueda(37, 27, 6.5)}
    </>
  ),
  cargador: (
    <>
      <path d="M17 24V11h17v13" />
      <path d="M17 17 8 22" />
      <path d="M2 18h9l-1 9H3z" />
      {rueda(16, 29, 4.5)}
      {rueda(37, 28, 5.5)}
    </>
  ),
  camioneta: (
    <>
      <path d="M4 25v-8h9l5-7h12l5 7h3" />
      <path d="M36 17h16v8" />
      <path d="M4 25h48" />
      {rueda(14, 27, 4)}
      {rueda(42, 27, 4)}
    </>
  ),
  trailer: (
    <>
      <path d="M3 26V12h12l5 7v7" />
      <path d="M23 26V9h31v17" />
      <path d="M3 26h51" />
      {rueda(11, 28)}
      {rueda(35, 28)}
      {rueda(45, 28)}
    </>
  ),
  bombona: (
    <>
      <path d="M7 10h42a4 4 0 0 1 4 4v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4v-8a4 4 0 0 1 4-4z" />
      <path d="M26 10V6h5v4" />
      <path d="M14 26v3M42 26v3" />
      <path d="M12 15v6M44 15v6" />
    </>
  ),
  carreta: (
    <>
      <path d="M3 21h50" />
      <path d="M3 21v-4h8" />
      <path d="M36 21v3M46 21v3" />
      {rueda(37, 27)}
      {rueda(46, 27)}
      <path d="M8 24l8-3" />
    </>
  ),
  generico: (
    <>
      <rect x="8" y="9" width="40" height="18" rx="3" />
      <path d="M16 27v3M40 27v3M14 18h28" />
    </>
  ),
};

export default function EquipoIcono({
  tipo,
  className = "w-10 h-6",
}: {
  tipo: string;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 56 36"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {TRAZOS[claveIcono(tipo)]}
    </svg>
  );
}
