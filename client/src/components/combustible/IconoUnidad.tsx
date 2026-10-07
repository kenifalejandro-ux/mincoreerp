import { Car, Container, Tractor, Truck } from "lucide-react";

import { claseDeUnidad } from "./viajesFormato";

/** El ícono de la unidad según su tipo: camión, auto, maquinaria o contenedor. */
export function IconoUnidad({ tipo, className }: { tipo: string | null; className?: string }) {
  const clase = claseDeUnidad(tipo);
  if (clase === "auto") return <Car className={className} aria-hidden />;
  if (clase === "maquina") return <Tractor className={className} aria-hidden />;
  if (clase === "contenedor") return <Container className={className} aria-hidden />;
  return <Truck className={className} aria-hidden />;
}
