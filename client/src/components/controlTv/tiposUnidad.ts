// Los dibujos y la clase de ícono de cada tipo de unidad del Control TV: los 12 tipos del registro de unidades (camioneta,
// cargador frontal, camión baranda, tracto remolcador, excavadora, retroexcavadora, volquete, tráiler,
// carretas, bombona, perforadora y otro). El tipo es texto libre: se compara sin mayúsculas ni
// tildes y lo que no se reconoce cae en «Otro».

export type ClaseTipo =
  | "trailer"
  | "tracto"
  | "volquete"
  | "baranda"
  | "camioneta"
  | "carreta"
  | "bombona"
  | "cargador"
  | "excavadora"
  | "retro"
  | "perforadora"
  | "otro";

export const FORMA: Record<ClaseTipo, string> = {
  trailer:
    '<rect x="1" y="6" width="18" height="10" rx="1"/><path d="M19 14h2V8h4l5 5v4h-2M21 17h-2"/><path d="M22 8v5h7"/><circle cx="5" cy="19" r="2.2"/><circle cx="11" cy="19" r="2.2"/><circle cx="25" cy="19" r="2.2"/>',
  tracto:
    '<path d="M3 15h9V6h8l6 7v4h-2"/><path d="M15 6v7h11"/><path d="M12 17h6M3 15v2h3"/><circle cx="9" cy="19" r="2.4"/><circle cx="21" cy="19" r="2.4"/>',
  volquete:
    '<path d="M2 15 5 6h13l-1 9z"/><path d="M19 16V9h5l5 5v3h-2M21 17h-1M11 17h6"/><circle cx="8" cy="19" r="2.4"/><circle cx="24" cy="19" r="2.4"/>',
  baranda:
    '<path d="M2 16V7M8 16V7M14 16V7M20 16V7M2 7h18M2 11.5h18M2 16h18"/><path d="M21 16V9h4l5 5v3h-2"/><circle cx="8" cy="19" r="2.2"/><circle cx="25" cy="19" r="2.2"/>',
  camioneta:
    '<path d="M2 17v-5h10l3-5h7l5 5h3v5h-2M6 17H5M20 17h-8"/><path d="M15 7v5h12"/><circle cx="8" cy="18" r="2.6"/><circle cx="24" cy="18" r="2.6"/>',
  carreta:
    '<path d="M3 14h22l4-3"/><path d="M3 14v-4M9 14v-4M15 14v-4M21 14v-4"/><path d="M3 10h18"/><circle cx="9" cy="18" r="2.4"/><circle cx="16" cy="18" r="2.4"/>',
  bombona:
    '<rect x="1" y="6" width="23" height="10" rx="5"/><path d="M24 11h5v6"/><path d="M12 6V3h3v3"/><circle cx="8" cy="19" r="2.3"/><circle cx="15" cy="19" r="2.3"/>',
  cargador:
    '<path d="M13 16h13v-5h-6l-2-5h-5z"/><path d="M13 9 6 13"/><path d="M1 18l1-7 6 2v5z"/><circle cx="15" cy="19" r="3"/><circle cx="24" cy="19" r="3"/>',
  excavadora:
    '<rect x="8" y="18" width="21" height="5" rx="2.5"/><path d="M14 18v-7h11v7"/><path d="M19 11V7h5v4"/><path d="M14 13 7 3 2 8"/><path d="M2 8l1 7 5-3"/>',
  retro:
    '<path d="M12 15h12v-4h3M12 15V6h7v5h5"/><path d="M12 11 6 4 2 10l3 4"/><path d="M27 11l3 5-5 1"/><circle cx="14" cy="19" r="3"/><circle cx="24" cy="19.5" r="2.4"/>',
  perforadora:
    '<rect x="9" y="18" width="20" height="5" rx="2.5"/><path d="M13 18v-6h12v6"/><path d="M5 23V1M2 1h6M5 8l8 5M3 23h4"/>',
  otro: '<path d="M2 16V7h15v9"/><path d="M17 10h6l5 4v3h-2M17 17h3M9 17h-3"/><circle cx="8" cy="19" r="2.3"/><circle cx="23" cy="19" r="2.3"/>',
};

/** La clase de ícono de un tipo de unidad escrito a mano. */
export function claseDeTipo(tipo: string | null | undefined): ClaseTipo {
  const t = String(tipo ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  if (/retro/.test(t)) return "retro";
  if (/excavad/.test(t)) return "excavadora";
  if (/cargador/.test(t)) return "cargador";
  if (/perfora/.test(t)) return "perforadora";
  if (/volquet/.test(t)) return "volquete";
  if (/baranda/.test(t)) return "baranda";
  if (/camioneta|pick.?up/.test(t)) return "camioneta";
  if (/trailer/.test(t)) return "trailer";
  if (/tracto/.test(t)) return "tracto";
  if (/carreta/.test(t)) return "carreta";
  if (/bombona|cisterna/.test(t)) return "bombona";
  return "otro";
}
