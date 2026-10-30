// El cuadre de cada salida de una tanqueta (GET /tanquetas/:id/cuadre): la forma de lo que
// devuelve el servidor y cómo se dice en una línea.

export interface SalidaCuadre {
  fuente: "asignacion" | "llenado" | "excedente";
  vale: string;
  unidad: string | null;
  inicio: string;
  fin: string | null;
  estado: "abierta" | "cerrada" | "sin_retorno";
  salioCon: number | null;
  cargo: number;
  cargas: number;
  debiaVolver: number | null;
  volvio: number | null;
  diferencia: number | null;
  motivo: string | null;
  destinoDelRetorno: string | null;
  llevaAhora: number | null;
}

const gal = (n: number) => `${n.toLocaleString("es-PE", { maximumFractionDigits: 2 })} gal`;

/** La diferencia con su signo: −2 gal falta, +2 gal sobra. */
const conSigno = (n: number) => `${n < 0 ? "−" : "+"}${gal(Math.abs(n))}`;

/** La salida en una línea:
 *  Vale A-2-15 · unidad VQ-12 — salió con 100 gal · cargó 70 gal (2 cargas) · debía volver con
 *  30 gal · volvió con 28 gal · diferencia −2 gal (motivo: "se derramó al bajarla") */
export function describirSalida(s: SalidaCuadre): string {
  const cabecera = `Vale ${s.vale} · unidad ${s.unidad ?? "sin dato"}`;
  const salio = s.salioCon === null ? "sin cantidad registrada" : `salió con ${gal(s.salioCon)}`;
  const cargas = `${s.cargas} ${s.cargas === 1 ? "carga" : "cargas"}`;
  const cargo = s.cargas === 0 ? "no cargó" : `cargó ${gal(s.cargo)} (${cargas})`;
  const partes = [salio, cargo];
  if (s.estado === "abierta") {
    partes.push("va con la unidad");
    if (s.llevaAhora !== null) partes.push(`lleva ${gal(s.llevaAhora)}`);
  } else if (s.estado === "sin_retorno") {
    partes.push("no se registró su retorno");
  } else if (s.debiaVolver !== null && s.volvio !== null && s.diferencia !== null) {
    partes.push(`debía volver con ${gal(s.debiaVolver)}`, `volvió con ${gal(s.volvio)}`);
    partes.push(
      s.diferencia === 0
        ? "cuadra"
        : `diferencia ${conSigno(s.diferencia)}${s.motivo ? ` (motivo: "${s.motivo}")` : ""}`
    );
  }
  return `${cabecera} — ${partes.join(" · ")}`;
}
