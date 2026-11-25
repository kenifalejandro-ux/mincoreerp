// client/src/components/mantenimiento/configMantenimiento.ts
//
// La pantalla de Configuración sin React: qué reglas y metas hay (los textos de la maqueta aprobada), cómo se
// lee lo que se escribe en una meta y qué se avisa de cada regla.
//
// Las reglas se guardan pero TODAVÍA NO ACTÚAN: cada una se aplica en el módulo dueño de su flujo cuando ese flujo
// entre al ecosistema. Por eso cada regla lo dice; la pantalla no puede prometer algo que no ocurre.
import { tieneModulo } from "../../modules/tieneModulo";

export type ClaveDeRegla =
  "ot_de_hallazgo" | "bloquea_sin_iperc" | "alerta_repuestos" | "exige_conformidad";
export type ClaveDeMeta =
  "meta_disponibilidad" | "meta_preventivo" | "meta_mttr_horas" | "meta_mtbf_horas";

export interface Regla {
  clave: ClaveDeRegla;
  titulo: string;
  descripcion: string;
  /** Cuándo empezará a actuar. */
  llegaCon: string;
  /** Los módulos sin los que la regla no tendría sobre qué actuar. */
  necesita: { id: string; nombre: string }[];
}

const OT = { id: "ordenes_trabajo", nombre: "Órdenes de Trabajo" };

export const REGLAS: Regla[] = [
  {
    clave: "ot_de_hallazgo",
    titulo: "Crear OT desde un hallazgo crítico",
    descripcion:
      "Cuando un checklist sea «NO APTA», se crea sola una OT urgente ligada a la unidad. Aplica a los checklists nuevos.",
    llegaCon: "Checklists y Órdenes de trabajo",
    necesita: [{ id: "checklists", nombre: "Checklists" }, OT],
  },
  {
    clave: "bloquea_sin_iperc",
    titulo: "Bloquear el inicio sin IPERC autorizado",
    descripcion:
      "Impide iniciar una OT mientras no exista la autorización de seguridad. Si se apaga, el IPERC queda como recomendado.",
    llegaCon: "Órdenes de trabajo",
    necesita: [OT, { id: "iperc", nombre: "IPERC" }],
  },
  {
    clave: "alerta_repuestos",
    titulo: "Alertar cuando falten repuestos para un MP",
    descripcion:
      "Avisa al planificador si un servicio próximo no tiene todos sus repuestos. Necesita el módulo Almacén.",
    llegaCon: "Mantenimiento preventivo",
    necesita: [{ id: "repuestos", nombre: "Almacén" }],
  },
  {
    clave: "exige_conformidad",
    titulo: "Exigir conformidad antes de liberar la unidad",
    descripcion:
      "Después de que el mecánico cierra la OT, alguien prueba el equipo y da la conformidad. Apagado: la unidad vuelve a operar al cerrar.",
    llegaCon: "Órdenes de trabajo",
    necesita: [OT],
  },
];

export interface Meta {
  clave: ClaveDeMeta;
  titulo: string;
  unidad: "%" | "horas";
  /** Espejo de los límites del servidor (mantenimiento.schema.ts). */
  maximo: number;
}

export const METAS: Meta[] = [
  { clave: "meta_disponibilidad", titulo: "Disponibilidad mínima", unidad: "%", maximo: 100 },
  { clave: "meta_preventivo", titulo: "Cumplimiento del preventivo", unidad: "%", maximo: 100 },
  {
    clave: "meta_mttr_horas",
    titulo: "Tiempo de reparación máximo (MTTR)",
    unidad: "horas",
    maximo: 10_000,
  },
  {
    clave: "meta_mtbf_horas",
    titulo: "Tiempo entre fallas mínimo (MTBF)",
    unidad: "horas",
    maximo: 100_000,
  },
];

/** Lo que se escribió en una meta: un entero entre 1 y su máximo, o por qué no sirve. */
export function leerMeta(texto: string, meta: Meta): { valor: number } | { error: string } {
  const limpio = texto.trim();
  const valor = Number(limpio);
  if (!/^\d+$/.test(limpio) || valor < 1 || valor > meta.maximo) {
    return {
      error: `${meta.titulo}: escribe un número entero entre 1 y ${meta.maximo.toLocaleString("en-US")}.`,
    };
  }
  return { valor };
}

/** Lo que se avisa bajo una regla: que aún no actúa y, si a la persona le faltan módulos, cuáles. */
export function avisoDeRegla(
  regla: Regla,
  usuario: { modulosPermitidos: string[] } | null | undefined
): string {
  const faltan = regla.necesita.filter((m) => !tieneModulo(usuario, m.id)).map((m) => m.nombre);
  const base = `Aún no actúa: llega con ${regla.llegaCon}.`;
  if (faltan.length === 0) return base;
  return `${base} Necesita ${faltan.length === 1 ? "el módulo" : "los módulos"} ${faltan.join(" y ")}.`;
}
