// El ícono de cada tipo de unidad del Control TV (los dibujos están en tiposUnidad.ts). Cada tipo
// tiene su propio largo: se dibuja a un alto y el ancho sale del dibujo.
import { claseDeTipo, FORMAS } from "./tiposUnidad";

export function IconoTipo({
  tipo,
  alto = 24,
  className = "",
}: {
  tipo: string | null | undefined;
  /** Alto en píxeles; el ancho es el que pide el dibujo de ese tipo. */
  alto?: number;
  className?: string;
}) {
  const forma = FORMAS[claseDeTipo(tipo)];
  return (
    <svg
      viewBox={`0 0 ${forma.w} 24`}
      width={(forma.w * alto) / 24}
      height={alto}
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      // El dibujo es fijo (tiposUnidad.ts), nunca texto del usuario.
      dangerouslySetInnerHTML={{ __html: forma.d }}
    />
  );
}
