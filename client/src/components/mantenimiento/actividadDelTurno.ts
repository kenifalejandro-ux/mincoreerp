// client/src/components/mantenimiento/actividadDelTurno.ts
//
// Los textos de «Actividad del turno», sin React: el servidor manda qué pasó y aquí se dice con palabras, con el
// efecto de cada paso.
import type { Movimiento, MovimientoDeOrden } from "./mantenimientoApi";

export interface PasoDelTurno {
  clave: string;
  icono: "checklist" | "orden" | "hecho";
  tono: "red" | "amber" | "blue" | "green";
  titulo: string;
  /** Unidad y fallas, o unidad y título de la orden. */
  detalle: string;
  efecto: string;
}

const unir = (...partes: (string | null)[]) => partes.filter(Boolean).join(" · ");

/** Cómo está hoy la unidad de una orden; null si no se sabe (activo escrito a mano o equipo quitado). */
const comoSigue = (estado: MovimientoDeOrden["unidad_hoy"]) =>
  estado === "detenida"
    ? "La unidad sigue detenida"
    : estado === "en_mantenimiento"
      ? "La unidad está en mantenimiento"
      : null;

function efectoDeOrden(m: MovimientoDeOrden): string {
  if (m.tipo === "orden_cerrada") {
    if (m.unidad_hoy === "operativa") return "La unidad está operativa";
    return comoSigue(m.unidad_hoy) ?? "La orden quedó cerrada";
  }
  if (m.estado === "completada") return "Ya está completada";
  if (m.estado === "cancelada") return "Después se canceló";
  if (m.tipo === "orden_creada" && m.sin_mecanico) {
    return m.unidad_hoy === "detenida"
      ? "Falta asignar mecánico: la unidad sigue detenida"
      : "Falta asignar mecánico";
  }
  return comoSigue(m.unidad_hoy) ?? "La orden sigue abierta";
}

export function pasoDelTurno(m: Movimiento): PasoDelTurno {
  if (m.tipo === "checklist") {
    const textos = {
      no_apta: ["red", "Checklist «No apta»", "La unidad no puede salir"],
      observado: ["amber", "Checklist con observaciones", "La falla quedó registrada"],
      bien: ["green", "Checklist sin fallas", "La unidad puede salir"],
    } as const;
    const [tono, titulo, sinOrden] = textos[m.resultado];
    return {
      clave: `checklist-${m.checklist_id}`,
      icono: "checklist",
      tono,
      titulo,
      detalle: unir(m.unidad, m.fallas),
      efecto: m.orden
        ? m.orden.nueva
          ? `Generó la OT #${m.orden.id}`
          : `Quedó anotado en la OT #${m.orden.id}, que ya existía`
        : m.por_autorizar
          ? "Espera autorización para salir"
          : sinOrden,
    };
  }
  if (m.tipo === "salida") {
    return {
      clave: `salida-${m.checklist_id}`,
      icono: "checklist",
      tono: m.autorizada ? "green" : "red",
      titulo: m.autorizada ? "Salida autorizada" : "Salida no autorizada",
      detalle: unir(m.unidad, m.fallas),
      efecto: m.autorizada ? "La unidad puede salir" : "La unidad no puede salir",
    };
  }
  const cancelada = m.estado === "cancelada";
  const [icono, tono, verbo] =
    m.tipo === "orden_creada"
      ? (["orden", m.detiene ? "red" : "amber", "creada"] as const)
      : m.tipo === "orden_iniciada"
        ? (["orden", "blue", "iniciada"] as const)
        : cancelada
          ? (["orden", "amber", "cancelada"] as const)
          : (["hecho", "green", "completada"] as const);
  return {
    clave: `${m.tipo}-${m.orden_id}`,
    icono,
    tono,
    titulo: `OT #${m.orden_id} ${verbo}`,
    detalle: unir(m.unidad, m.titulo),
    efecto: efectoDeOrden(m),
  };
}

const ZONA = "America/Lima";
const diaEnPeru = (fecha: Date) => fecha.toLocaleDateString("en-CA", { timeZone: ZONA });

/** «Hoy 05:40», «Ayer 18:30» o «22/11 11:20», en hora de Perú. */
export function cuandoFue(iso: string, ahora = new Date()): string {
  const fecha = new Date(iso);
  const hora = fecha.toLocaleTimeString("es-PE", {
    timeZone: ZONA,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const dia = diaEnPeru(fecha);
  if (dia === diaEnPeru(ahora)) return `Hoy ${hora}`;
  if (dia === diaEnPeru(new Date(ahora.getTime() - 86_400_000))) return `Ayer ${hora}`;
  const [, mes, numero] = dia.split("-");
  return `${numero}/${mes} ${hora}`;
}
