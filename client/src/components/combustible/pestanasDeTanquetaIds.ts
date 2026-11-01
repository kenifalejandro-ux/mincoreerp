// Los identificadores de las pestañas de "Mi tanqueta" y de sus paneles, aparte del componente
// (un archivo de componente no puede exportar funciones).
export type VistaDeTanqueta = "movimientos" | "cargas";

export const idPestana = (v: VistaDeTanqueta) => `mi-tanqueta-pestana-${v}`;
export const idPanel = (v: VistaDeTanqueta) => `mi-tanqueta-panel-${v}`;
