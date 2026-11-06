// Lógica pura de «Empezar un viaje» (0179): el conductor crea e inicia su propio viaje. Sin React,
// para probarla sola: los pasos, las validaciones y el cuerpo que se manda a crear-mio.

export type TipoViaje = "ida" | "ida_vuelta" | "varias";

export interface CatalogoUnidad {
  id: number;
  placa: string;
  tipo: string;
  por_completar: boolean;
  asignada_a_mi: boolean;
  ruta: { origen_id: number; destino_id: number; origen: string; destino: string } | null;
}

export interface CatalogoViaje {
  puede_crear_viaje: boolean;
  lugares: { id: number; nombre: string }[];
  unidades: CatalogoUnidad[];
  relevos: { id: string; nombre: string }[];
}

export const PASOS = ["tipo", "unidad", "ruta", "relevo", "confirmar"] as const;
export type PasoViaje = (typeof PASOS)[number];

/** La unidad elegida: una registrada (su id), una nueva (se registra con la placa) o ninguna aún. */
export type UnidadElegida = number | "nueva" | null;

export interface BorradorViaje {
  tipo: TipoViaje;
  unidad: UnidadElegida;
  placa: string;
  nombre: string;
  sale: number | null;
  llega: number | null;
  /** Solo en «varias paradas»: el recorrido completo, en orden (null = sin elegir). */
  paradas: (number | null)[];
  relevoId: string;
  odometro: string;
}

const RE_PLACA = /^[A-Z0-9]{3,20}$/;

/** La placa como la compara el servidor: mayúsculas, sin espacios ni guiones. */
export function normalizarPlaca(texto: string): string {
  return texto.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** La unidad que Equipos le asignó al conductor, si tiene. */
export function unidadAsignada(c: CatalogoViaje): CatalogoUnidad | null {
  return c.unidades.find((u) => u.asignada_a_mi) ?? null;
}

export function unidadRegistrada(c: CatalogoViaje, id: UnidadElegida): CatalogoUnidad | null {
  return typeof id === "number" ? (c.unidades.find((u) => u.id === id) ?? null) : null;
}

/** Un borrador nuevo: con la unidad asignada ya marcada y su ruta puesta, para que solo confirme. */
export function borradorInicial(c: CatalogoViaje, nombre: string): BorradorViaje {
  const u = unidadAsignada(c);
  return conRutaDeUnidad(
    {
      tipo: "ida",
      unidad: u ? u.id : null,
      placa: "",
      nombre,
      sale: null,
      llega: null,
      paradas: [null, null, null],
      relevoId: "",
      odometro: "",
    },
    u
  );
}

/** Pone en el borrador la ruta de esa unidad (o la deja vacía si no tiene o es nueva). */
export function conRutaDeUnidad(b: BorradorViaje, u: CatalogoUnidad | null): BorradorViaje {
  const r = u?.ruta ?? null;
  return {
    ...b,
    sale: r ? r.origen_id : null,
    llega: r ? r.destino_id : null,
    paradas: r ? [r.origen_id, r.destino_id, null] : [null, null, null],
  };
}

/** El recorrido completo según el tipo: A → B, A → B → A, o las paradas que escribió. */
export function paradasFinales(b: BorradorViaje): (number | null)[] {
  if (b.tipo === "ida") return [b.sale, b.llega];
  if (b.tipo === "ida_vuelta") return [b.sale, b.llega, b.sale];
  return b.paradas;
}

export function errorUnidad(b: BorradorViaje, c: CatalogoViaje): string {
  if (b.unidad === null) return "Elige tu unidad.";
  if (b.unidad !== "nueva") return "";
  const p = normalizarPlaca(b.placa);
  if (!RE_PLACA.test(p)) return "Escribe la placa, por ejemplo ABC-123.";
  if (c.unidades.some((u) => normalizarPlaca(u.placa) === p)) {
    return "Esa placa ya está registrada: elígela de la lista.";
  }
  if (b.nombre.trim().length < 5) return "Escribe tu nombre completo.";
  return "";
}

export function errorRuta(b: BorradorViaje): string {
  const p = paradasFinales(b);
  if (p.some((x) => x === null)) return "Falta elegir algún lugar.";
  for (let i = 1; i < p.length; i++) {
    if (p[i] === p[i - 1]) return "Dos lugares seguidos tienen que ser distintos.";
  }
  return "";
}

export function lecturaOdometro(texto: string): number | null {
  const n = parseFloat(texto.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function errorOdometro(b: BorradorViaje): string {
  return lecturaOdometro(b.odometro) === null ? "Escribe el odómetro de salida." : "";
}

/** El error del paso en que está, para habilitar «Siguiente» (vacío = puede seguir). */
export function errorDelPaso(paso: PasoViaje, b: BorradorViaje, c: CatalogoViaje): string {
  if (paso === "unidad") return errorUnidad(b, c);
  if (paso === "ruta") return errorRuta(b);
  if (paso === "confirmar") return errorOdometro(b);
  return "";
}

/** El cuerpo de `POST /api/erp/viajes/crear-mio`. `idCliente` es el mismo en todos los reintentos;
 *  va también como `cliente_uuid`, que es el que lee la cola sin señal. `marcadoEn` es la hora en
 *  que tocó «Salir ahora»: sin señal, vale como hora de salida. */
export function cuerpoCrearMiViaje(b: BorradorViaje, idCliente: string, marcadoEn: string) {
  const lectura = lecturaOdometro(b.odometro);
  return {
    id_cliente: idCliente,
    cliente_uuid: idCliente,
    marcado_en: marcadoEn,
    ...(b.unidad === "nueva"
      ? { unidad_nueva: { placa: b.placa.trim().toUpperCase(), nombre: b.nombre.trim() } }
      : { equipo_id: b.unidad as number }),
    paradas: paradasFinales(b) as number[],
    ...(b.relevoId ? { relevo_usuario_id: b.relevoId } : {}),
    medidor_inicio: lectura as number,
  };
}
