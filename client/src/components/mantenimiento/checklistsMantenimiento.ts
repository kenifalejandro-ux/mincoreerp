// client/src/components/mantenimiento/checklistsMantenimiento.ts
//
// La lógica de Checklists → Registros, sin React: qué se le pide al servidor y cómo se dice cada resultado.
export type ResultadoDeChecklist = "bien" | "observado" | "no_apta";

/** Los nombres de la maqueta, con su color. */
export const RESULTADO_EN_OFICINA: Record<ResultadoDeChecklist, { texto: string; clase: string }> =
  {
    bien: { texto: "Apta", clase: "bg-emerald-100 text-emerald-600" },
    observado: { texto: "Con observaciones", clase: "bg-amber-100 text-amber-700" },
    no_apta: { texto: "No apta", clase: "bg-red-100 text-red-700" },
  };

export interface RegistroDeChecklist {
  id: number;
  equipo_id: number | null;
  placa_codigo: string | null;
  activo_texto: string | null;
  usuario_id: string;
  usuario_nombre: string;
  creado_en: string;
  resultado: ResultadoDeChecklist;
  fallas: string | null;
  salida: string | null;
  salida_motivo: string | null;
  salida_por_nombre: string | null;
  lectura_valor: number | null;
  observaciones_generales: string | null;
  aviso_registro: string | null;
  /** Vacía si la empresa no usa Órdenes de trabajo. */
  ordenes_trabajo: number[];
}

export interface PreguntaRespondida {
  id: number;
  descripcion: string;
  estado: "bien" | "malo" | "na";
  observacion: string | null;
  critica: boolean;
}
export type DetalleDeChecklist = RegistroDeChecklist & { items: PreguntaRespondida[] };

export interface ChecklistsDeHoy {
  total: number;
  bien: number;
  observado: number;
  no_apta: number;
}

export interface FiltrosDeRegistros {
  busqueda: string;
  resultado: ResultadoDeChecklist | "";
  porAutorizar: boolean;
}
export const SIN_FILTROS: FiltrosDeRegistros = { busqueda: "", resultado: "", porAutorizar: false };

export const REGISTROS_POR_PAGINA = 25;

/** La consulta de una página: solo viaja lo que se filtró. */
export function consultaDeRegistros(filtros: FiltrosDeRegistros, cursor: number | null): string {
  const p = new URLSearchParams({ pageSize: String(REGISTROS_POR_PAGINA) });
  const q = filtros.busqueda.trim();
  if (q) p.set("q", q);
  if (filtros.resultado) p.set("resultado", filtros.resultado);
  if (filtros.porAutorizar) p.set("salida", "por_autorizar");
  if (cursor !== null) p.set("cursor", String(cursor));
  return `?${p}`;
}

export const unidadDelRegistro = (
  c: Pick<RegistroDeChecklist, "placa_codigo" | "activo_texto" | "equipo_id">
) => c.placa_codigo ?? c.activo_texto ?? (c.equipo_id ? `Unidad ${c.equipo_id}` : "Sin unidad");

/** La franja del panel: qué significa el resultado para la unidad. */
export function consecuencia(
  c: Pick<RegistroDeChecklist, "resultado" | "salida" | "salida_motivo" | "salida_por_nombre">
): { tono: "red" | "amber" | "green"; titulo: string; detalle: string } {
  const decidio = [c.salida_por_nombre, c.salida_motivo].filter(Boolean).join(": ");
  if (c.salida === "autorizada") {
    return { tono: "green", titulo: "Salida autorizada: la unidad sale", detalle: decidio };
  }
  if (c.salida === "rechazada") {
    return { tono: "red", titulo: "Salida no autorizada: la unidad no sale", detalle: decidio };
  }
  if (c.salida === "por_autorizar") {
    return {
      tono: "amber",
      titulo: "Con observaciones: espera autorización",
      detalle: "La unidad sale cuando alguien autorice.",
    };
  }
  if (c.resultado === "no_apta") {
    return {
      tono: "red",
      titulo: "No apta: la unidad no puede salir",
      detalle: "Falló una pregunta crítica.",
    };
  }
  if (c.resultado === "observado") {
    return {
      tono: "amber",
      titulo: "Con observaciones",
      detalle: "Hay fallas que no son críticas.",
    };
  }
  return { tono: "green", titulo: "Apta: sin fallas", detalle: "La unidad puede salir." };
}
