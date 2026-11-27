// client/src/components/mantenimiento/planesPreventivo.ts
//
// Los planes de preventivo tal como los pinta la pantalla: tipos, textos y cuentas. Sin React. El próximo
// servicio y su estado los calcula el servidor; aquí solo se escriben.
import { marcarNovedadVista, novedadVigente } from "../controlTv/novedad";

export type Nivel = 1 | 2 | 3;
export type Medida = "horometro" | "odometro";
export type EstadoPreventivo = "vencido" | "proximo" | "al_dia" | "sin_datos";

export interface PlanPreventivo {
  id: number;
  tipo_equipo: string;
  medida: Medida;
  intervalo: number;
  aviso_antes: number;
  ciclo: Nivel[];
  niveles: Partial<Record<`${Nivel}`, { tareas: string[]; repuestos: string[] }>>;
  version: number;
  equipos: number;
}

export interface ListaDePlanes {
  planes: PlanPreventivo[];
  tiposSinPlan: { tipo: string; equipos: number }[];
}

export interface EquipoConPlan {
  equipo_id: number;
  placa_codigo: string;
  plan_id: number;
  medidor_del_equipo: Medida;
  lectura: number;
  propiedad: "propia" | "alquilada";
  estado: EstadoPreventivo;
  motivo: "medidor_distinto" | "sin_servicio" | null;
  proximo: { nivel: Nivel; faltan: number } | null;
}

export const NOMBRE_DE_NIVEL: Record<Nivel, string> = {
  1: "Servicio básico",
  2: "Servicio intermedio",
  3: "Servicio mayor",
};

export const ETIQUETA_DE_ESTADO: Record<EstadoPreventivo, string> = {
  vencido: "Vencido",
  proximo: "Próximo",
  al_dia: "Al día",
  sin_datos: "Sin datos",
};

export const FONDO_DE_NIVEL: Record<Nivel, string> = {
  1: "bg-[#7cb518]",
  2: "bg-[#1768e4]",
  3: "bg-[#9333ea]",
};
export const BORDE_DE_NIVEL: Record<Nivel, string> = {
  1: "border-[#7cb518]",
  2: "border-[#1768e4]",
  3: "border-[#9333ea]",
};
export const caja = "rounded-xl border border-slate-200 bg-white shadow-sm";
export const antetitulo = "text-[10px] font-bold uppercase tracking-[0.13em] text-slate-500";

export const unidadDe = (medida: Medida) => (medida === "horometro" ? "h" : "km");
export const numero = (n: number) => n.toLocaleString("es-PE", { maximumFractionDigits: 2 });
export const cantidad = (n: number, uno: string, varios: string) =>
  `${numero(n)} ${n === 1 ? uno : varios}`;

/** Los niveles que el plan define, de menor a mayor. */
export const nivelesDelPlan = (p: Pick<PlanPreventivo, "niveles">) =>
  ([1, 2, 3] as Nivel[]).filter((n) => p.niveles[`${n}`]);

/** El nivel cuyas tareas también se hacen en este (cada uno suma a las del anterior). */
export function nivelQueIncluye(p: Pick<PlanPreventivo, "niveles">, nivel: Nivel) {
  const lista = nivelesDelPlan(p);
  return lista[lista.indexOf(nivel) - 1] ?? null;
}

export const vecesEnElCiclo = (ciclo: Nivel[], nivel: Nivel) =>
  cantidad(ciclo.filter((n) => n === nivel).length, "vez por ciclo", "veces por ciclo");

/** Los puntos de la regla: a qué lectura, contando desde cero, cae cada servicio de una vuelta. */
export const marcasDelCiclo = (p: Pick<PlanPreventivo, "ciclo" | "intervalo">) =>
  p.ciclo.map((nivel, i) => ({ nivel, en: p.intervalo * (i + 1) }));

/** «en 20 h», «pasó 90 km» o «toca ahora»; sin cálculo, por qué no lo hay. */
export function textoDeFaltan(e: EquipoConPlan, medida: Medida) {
  if (!e.proximo) {
    return e.motivo === "medidor_distinto"
      ? `El equipo mide en ${unidadDe(e.medidor_del_equipo)} y el plan en ${unidadDe(medida)}`
      : "Sin un servicio registrado";
  }
  const { faltan } = e.proximo;
  if (faltan === 0) return "toca ahora";
  return `${faltan < 0 ? "pasó" : "en"} ${numero(Math.abs(faltan))} ${unidadDe(medida)}`;
}

/** Cuánto del intervalo se lleva recorrido, de 3 a 100 (para que la barra siempre se vea). */
export const avanceDelIntervalo = (faltan: number, intervalo: number) =>
  Math.min(100, Math.max(3, ((intervalo - faltan) / intervalo) * 100));

const NOVEDAD = "mantenimiento-preventivo-2026-11";
export const preventivoEsNuevo = () => novedadVigente(Date.now(), undefined, NOVEDAD);
export const marcarPreventivoVisto = () => marcarNovedadVista(Date.now(), undefined, NOVEDAD);

const NOVEDAD_EDITAR = "mantenimiento-planes-editar-2026-11";
export const editarPlanesEsNuevo = () => novedadVigente(Date.now(), undefined, NOVEDAD_EDITAR);
export const marcarEditarPlanesVisto = () =>
  marcarNovedadVista(Date.now(), undefined, NOVEDAD_EDITAR);
