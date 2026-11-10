// El ícono de cada tipo de unidad del Control TV (los dibujos están en tiposUnidad.ts).
import { claseDeTipo, FORMA } from "./tiposUnidad";

export function IconoTipo({
  tipo,
  className = "w-8 h-6",
}: {
  tipo: string | null | undefined;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 32 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      // El dibujo es fijo (arriba), nunca texto del usuario.
      dangerouslySetInnerHTML={{ __html: FORMA[claseDeTipo(tipo)] }}
    />
  );
}
