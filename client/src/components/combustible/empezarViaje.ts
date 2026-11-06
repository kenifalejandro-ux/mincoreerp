// Lógica pura de «Empezar un viaje» (0179): el conductor crea e inicia su propio viaje. Sin React,
// para probarla sola: los pasos, las validaciones y el cuerpo que se manda a crear-mio.

export type TipoViaje = "ida" | "ida_vuelta" | "varias";

export interface CatalogoUnidad {
  id: number;
  placa: string;
  tipo: string;
  /** Qué lee el conductor en el tablero al marcar (null = no configurado). */
  tipo_medidor: "horometro" | "odometro" | null;
  por_completar: boolean;
  asignada_a_mi: boolean;
  ruta: { origen_id: number; destino_id: number; origen: string; destino: string } | null;
}

export interface CatalogoViaje {
  puede_crear_viaje: boolean;
  lugares: { id: number; nombre: string }[];
  unidades: CatalogoUnidad[];
  /** `con_cuenta: false` = solo figura en Equipos: se anota por su nombre, sin cuenta. */
  relevos: { id: string; nombre: string; con_cuenta: boolean }[];
}

/** Un lugar del recorrido: uno del catálogo (su id), uno que el conductor escribió (su nombre,
 *  se agrega al catálogo al crear el viaje) o ninguno todavía. */
export type Lugar = number | string | null;

/** El nombre de un lugar, para mostrarlo y para comparar (sin importar mayúsculas). */
export function nombreDeLugar(l: Lugar, c: CatalogoViaje): string {
  if (typeof l === "string") return l.trim();
  return c.lugares.find((x) => x.id === l)?.nombre ?? "";
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
  sale: Lugar;
  llega: Lugar;
  /** Solo en «varias paradas»: el recorrido completo, en orden (null = sin elegir). */
  paradas: Lugar[];
  relevoId: string;
  /** Un relevo que no está registrado: solo el nombre, como dato del viaje (sin cuenta no maneja en el sistema). */
  relevoNombre: string;
  odometro: string;
  /** Por qué sale en una unidad distinta a la asignada (opcional). */
  motivoUnidad: string;
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

/** Las unidades que coinciden con lo que escribió (por placa), como máximo `max`: el celular nunca
 *  muestra la flota entera. Con menos de 2 letras no se busca. La asignada al conductor no se repite. */
export function buscarUnidades(c: CatalogoViaje, texto: string, max = 6): CatalogoUnidad[] {
  const q = normalizarPlaca(texto);
  if (q.length < 2) return [];
  return c.unidades
    .filter((u) => !u.asignada_a_mi && normalizarPlaca(u.placa).includes(q))
    .slice(0, max);
}

const sinTildes = (t: string) =>
  t
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();

/** Los conductores registrados que coinciden con lo que escribió (por nombre), como máximo `max`.
 *  Con menos de 2 letras no se busca: nunca se muestra la lista entera. */
export function buscarRelevos(c: CatalogoViaje, texto: string, max = 6) {
  const q = sinTildes(texto);
  if (q.length < 2) return [];
  return c.relevos.filter((r) => sinTildes(r.nombre).includes(q)).slice(0, max);
}

/** Lo escrito se puede guardar como relevo sin cuenta: parece un nombre y no es el de ningún registrado. */
export function nombreDeRelevoNuevo(c: CatalogoViaje, texto: string): boolean {
  const q = sinTildes(texto);
  return q.length >= 3 && !c.relevos.some((r) => sinTildes(r.nombre) === q);
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
      relevoNombre: "",
      odometro: "",
      motivoUnidad: "",
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
export function paradasFinales(b: BorradorViaje): Lugar[] {
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

export function errorRuta(b: BorradorViaje, c?: CatalogoViaje): string {
  const p = paradasFinales(b);
  // Dos lugares seguidos son el mismo si tienen el mismo nombre, aunque uno sea del catálogo y el
  // otro escrito a mano (con el catálogo a la mano); sin él, solo si son el mismo id o texto.
  const clave = (l: Lugar) =>
    c ? nombreDeLugar(l, c).toLowerCase() : typeof l === "string" ? l.trim().toLowerCase() : l;
  if (p.some((x) => x === null || (typeof x === "string" && !x.trim()))) {
    return "Falta elegir algún lugar.";
  }
  for (let i = 1; i < p.length; i++) {
    if (clave(p[i]) === clave(p[i - 1])) return "Dos lugares seguidos tienen que ser distintos.";
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
  if (paso === "ruta") return errorRuta(b, c);
  if (paso === "confirmar") return errorOdometro(b);
  return "";
}

/** El cuerpo de `POST /api/erp/viajes/crear-mio`. `idCliente` es el mismo en todos los reintentos;
 *  va también como `cliente_uuid`, que es el que lee la cola sin señal. `marcadoEn` es la hora en
 *  que tocó «Salir ahora»: sin señal, vale como hora de salida. */
export function cuerpoCrearMiViaje(
  b: BorradorViaje,
  idCliente: string,
  marcadoEn: string,
  /** El id de la unidad que Equipos le asignó (null si no tiene): el motivo solo vale si eligió otra. */
  asignadaId: number | null = null
) {
  const lectura = lecturaOdometro(b.odometro);
  return {
    id_cliente: idCliente,
    cliente_uuid: idCliente,
    marcado_en: marcadoEn,
    ...(b.unidad === "nueva"
      ? { unidad_nueva: { placa: b.placa.trim().toUpperCase(), nombre: b.nombre.trim() } }
      : { equipo_id: b.unidad as number }),
    // Los del catálogo van por su id; los escritos a mano, por su nombre (el servidor los agrega).
    paradas: paradasFinales(b).map((l) => (typeof l === "string" ? { nombre: l.trim() } : l)) as (
      number | { nombre: string }
    )[],
    ...(b.relevoId ? { relevo_usuario_id: b.relevoId } : {}),
    ...(!b.relevoId && b.relevoNombre.trim() ? { relevo_nombre: b.relevoNombre.trim() } : {}),
    // El motivo solo vale si eligió una unidad registrada distinta a la que tiene asignada.
    ...(b.motivoUnidad.trim() && typeof b.unidad === "number" && b.unidad !== asignadaId
      ? { motivo_unidad: b.motivoUnidad.trim() }
      : {}),
    medidor_inicio: lectura as number,
  };
}
