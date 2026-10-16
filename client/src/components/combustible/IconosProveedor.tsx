// Íconos de la pantalla Proveedores. Trazo simple (como los de lucide) y color
// heredado del texto, para que sigan el tema. Interno = cisterna (llega a la
// planta); externo = surtidor (se compra en ruta); urea = estación con
// marquesina; combustible = gota.
const BASE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

export function IconoCisterna({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 36 20" className={className} {...BASE}>
      <rect x="9" y="2.5" width="24" height="9.5" rx="4.75" />
      <path d="M21 2.5V1M2 14v-5l3-3.5h4V14M2 14h31" />
      <circle cx="7" cy="16" r="2" />
      <circle cx="24" cy="16" r="2" />
      <circle cx="30" cy="16" r="2" />
    </svg>
  );
}

export function IconoSurtidor({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...BASE}>
      <rect x="4" y="3" width="10" height="18" rx="1.5" />
      <rect x="6.5" y="6" width="5" height="4" rx=".5" />
      <path d="M3 21h12M14 8h2.5A1.5 1.5 0 0 1 18 9.5V16a1.5 1.5 0 0 0 3 0V8l-2.5-2.5" />
    </svg>
  );
}

export function IconoGota({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...BASE}>
      <path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z" />
    </svg>
  );
}

export function IconoEstacion({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...BASE}>
      <path d="M2 7l2.2-4h15.6L22 7z" />
      <path d="M5 7v13M19 7v13M2 20h20" />
      <rect x="9.5" y="12" width="5" height="8" rx=".6" />
      <path d="M11 14.5h2" />
    </svg>
  );
}
