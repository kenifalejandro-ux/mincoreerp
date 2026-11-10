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

/** Un círculo de rueda (radio 2.5 y centro a 19.5 salvo que se indique). */
const R = (cx: number, cy = 19.5, r = 2.5) => `<circle cx="${cx}" cy="${cy}" r="${r}"/>`;

/** El dibujo de cada tipo: alto fijo de 24 y ancho propio (un tráiler es largo; una camioneta, corta).
 *  Todos miran a la derecha. El dibujo es fijo (nunca texto del usuario). */
export const FORMAS: Record<ClaseTipo, { w: number; d: string }> = {
  trailer: {
    w: 76,
    d: `<rect x="2" y="4" width="45" height="12" rx="1.5"/><path d="M2 10h45M2 16h50"/><path d="M50 16V7h8l5 5v4M58 7v5h5M63 12h5l3 3v1M52 16h19"/><path d="M47 16h4"/>${R(10)}${R(17)}${R(24)}${R(57)}${R(67)}`,
  },
  tracto: {
    w: 44,
    d: `<path d="M2 16h40"/><path d="M5 16v-2h12v2"/><path d="M20 16V6h9l6 6M35 12h4l3 3v1"/><path d="M29 6v6h6"/>${R(9)}${R(15)}${R(33)}`,
  },
  volquete: {
    w: 44,
    d: `<path d="M2 6l2 10h22l1-11z"/><path d="M9 5.5l.7 10.5M16 5.5l.5 10.5"/><path d="M2 16h40"/><path d="M29 16V8h6l6 5v3"/><path d="M35 8v5h6"/>${R(9)}${R(17)}${R(35)}`,
  },
  baranda: {
    w: 46,
    d: `<rect x="2" y="5" width="27" height="11" rx="1"/><path d="M8 5v11M14 5v11M20 5v11M2 10.5h27"/><path d="M2 16h42"/><path d="M31 16V8h6l5 5v3"/><path d="M37 8v5h5"/>${R(9)}${R(17)}${R(37)}`,
  },
  camioneta: {
    w: 36,
    d: `<path d="M2 17v-6h11l3-5h6l4 5h4l3 2v4h-2"/><path d="M13 11h12M19 6v5M2 17h3M11 17h12"/><path d="M26 11v6" opacity="0"/>${R(8, 18, 2.8)}${R(28, 18, 2.8)}`,
  },
  carreta: {
    w: 62,
    d: `<rect x="2" y="13" width="46" height="3.5" rx="1"/><path d="M6 13V8M14 13V8M22 13V8M30 13V8M38 13V8M6 8h32"/><path d="M48 14h5l3-5h5M52 16.5h8"/>${R(13)}${R(20)}${R(27)}`,
  },
  bombona: {
    w: 66,
    d: `<rect x="2" y="4" width="46" height="12" rx="6"/><path d="M17 4V1.5h6V4M2 16h58"/><path d="M50 16V7h7l5 5v4"/><path d="M57 7v5h5"/>${R(11)}${R(18)}${R(25)}${R(55)}`,
  },
  cargador: {
    w: 42,
    d: `<path d="M3 16v-5h9V5h11l4 5v6z"/><path d="M17 5V3h-4"/><path d="M20 12l10 3"/><path d="M30 9h8l-2 9h-8z"/>${R(10, 18.5, 3.5)}${R(23, 18.5, 3.5)}`,
  },
  excavadora: {
    w: 46,
    d: `<rect x="3" y="17" width="28" height="5" rx="2.5"/><path d="M7 17v-7h15v7"/><path d="M15 10V5h7l2 5"/><path d="M22 11l9-8 9 6"/><path d="M40 9l-4 9"/><path d="M34 18h8l-2-5z"/>`,
  },
  retro: {
    w: 42,
    d: `<path d="M13 15V5h9l2 5h6v5z"/><path d="M13 11L6 3 2 9l2 8"/><path d="M30 12h4M34 9h5v8h-5z"/>${R(13, 18.5, 3.5)}${R(28, 19, 2.8)}`,
  },
  perforadora: {
    w: 36,
    d: `<rect x="3" y="19" width="26" height="4" rx="2"/><path d="M7 19v-6h20v6"/><path d="M11 13V1M8 1h6M11 5l6 5"/><path d="M20 13V8h6v5M32 21V3M29 21h6"/>`,
  },
  otro: {
    w: 36,
    d: `<path d="M2 16V7h16v9"/><path d="M18 10h7l5 4v3h-2M18 17h3M10 17H6"/>${R(9)}${R(26)}`,
  },
};

/** El ancho en píxeles de un ícono dibujado a ese alto. */
export const anchoDeIcono = (tipo: string | null | undefined, alto: number) =>
  (FORMAS[claseDeTipo(tipo)].w * alto) / 24;

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
