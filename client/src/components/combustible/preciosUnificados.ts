// Lógica pura de la pantalla Precios (combustible + urea en una sola tabla).
// Sin React ni red: recibe las listas que ya devuelve el servidor y arma las
// filas, el precio vigente, el programado y la variación.
//
// Reglas que vienen del servidor y acá se respetan igual:
//   * Un precio se APILA con su `vigente_desde`; nunca se edita ni se pisa.
//   * El vigente es "el más reciente NO anulado cuya fecha ya llegó".
//   * Uno con fecha futura es "programado": todavía no rige.
//   * Combustible: un precio va a UN tanque (venta interna) o a UN proveedor de
//     ruta (compra), por tipo de combustible. Urea: por proveedor y presentación.

export type ProductoPrecio = "combustible" | "urea";
export type TipoPrecio = "interna" | "externa";
export type TipoCombustible = "diesel_b5" | "gasolina_90" | "glp";

export const ETIQUETA_COMBUSTIBLE: Record<TipoCombustible, string> = {
  diesel_b5: "Diésel B5",
  gasolina_90: "Gasolina 90",
  glp: "GLP",
};

export const UNIDAD_PRECIO: Record<ProductoPrecio, string> = {
  combustible: "galón",
  urea: "envase",
};

/** Un salto mayor a este porcentaje (hacia arriba o abajo) pide confirmación
 *  explícita antes de cargar el precio. */
export const UMBRAL_CONFIRMACION_PCT = 50;
/** Pasados estos días sin cambios, la antigüedad del precio se marca. */
export const DIAS_PRECIO_VIEJO = 7;

// ── Lo que devuelve el servidor ────────────────────────────────────────────

export interface PrecioCombustibleApi {
  id: number;
  tipo_combustible: TipoCombustible;
  combustible_id: number | null;
  grifo_id: number | null;
  precio_unitario: string;
  vigente_desde: string;
  tanque_nombre: string | null;
  grifo_nombre: string | null;
  registrado_por_nombre: string | null;
  anulada_en: string | null;
  motivo_anulacion: string | null;
}

export interface PrecioUreaApi {
  id: number;
  grifo_id: number;
  proveedor: string | null;
  presentacion: string;
  presentacion_nombre: string | null;
  presentacion_litros: string | null;
  marca: string | null;
  precio_por_bulto: string;
  vigente_desde: string;
  cargado_por: string | null;
  anulada_en: string | null;
  motivo_anulacion: string | null;
}

export interface TanquePrecio {
  id: number;
  tanque_nombre: string;
  tipo_combustible: TipoCombustible;
  activo: boolean;
}

export interface ProveedorPrecio {
  id: number;
  nombre: string;
  activo: boolean;
  abastece_ruta: boolean;
}

export interface ProveedorUreaPrecio {
  id: number;
  nombre: string;
}

export interface PresentacionPrecio {
  codigo: string;
  nombre: string;
  litros: string | null;
  activa: boolean;
}

// ── Lo que usa la pantalla ─────────────────────────────────────────────────

export interface EntradaPrecio {
  /** Id del precio en SU tabla (combustible_precios o combustible_urea_precios). */
  id: number;
  precio: number;
  desde: string;
  por: string | null;
  /** Motivo de la anulación; null si el precio sigue vigente en la historia. */
  anuladaMotivo: string | null;
  anulado: boolean;
  marca: string | null;
}

export interface FilaPrecio {
  clave: string;
  producto: ProductoPrecio;
  tipo: TipoPrecio;
  /** Tanque o proveedor. */
  destino: string;
  /** Tipo de combustible, o presentación de urea. */
  detalle: string;
  destinoId: number;
  /** Código del combustible o de la presentación de urea. */
  subtipo: string;
  entradas: EntradaPrecio[];
}

export interface FuentesPrecio {
  precios: PrecioCombustibleApi[];
  tanques: TanquePrecio[];
  proveedores: ProveedorPrecio[];
  preciosUrea: PrecioUreaApi[];
  proveedoresUrea: ProveedorUreaPrecio[];
  presentaciones: PresentacionPrecio[];
}

export const claveCombustible = (tipo: TipoPrecio, destinoId: number, comb: string) =>
  `c|${tipo === "interna" ? "t" : "g"}:${destinoId}|${comb}`;
export const claveUrea = (grifoId: number, presentacion: string) => `u|${grifoId}|${presentacion}`;

function porFechaDesc(a: EntradaPrecio, b: EntradaPrecio) {
  return new Date(b.desde).getTime() - new Date(a.desde).getTime();
}

const textoPresentacion = (nombre: string, litros: string | null) =>
  litros ? `${nombre} (${Number(litros)} L)` : nombre;

/** Arma todas las filas: las combinaciones que DEBERÍAN tener precio (para
 *  poder avisar "sin precio") más las que ya tienen historia, aunque su tanque
 *  o proveedor ya no esté activo. */
export function construirFilas(
  f: FuentesPrecio,
  ver: { combustible: boolean; urea: boolean }
): FilaPrecio[] {
  const filas = new Map<string, FilaPrecio>();

  if (ver.combustible) {
    const tanquesActivos = f.tanques.filter((t) => t.activo);
    // Tipos de combustible que el tenant realmente maneja en sus tanques: los
    // proveedores de ruta solo "deben" precio de esos, no de los tres.
    const tipos = new Set<TipoCombustible>(tanquesActivos.map((t) => t.tipo_combustible));

    for (const t of tanquesActivos) {
      const clave = claveCombustible("interna", t.id, t.tipo_combustible);
      filas.set(clave, {
        clave,
        producto: "combustible",
        tipo: "interna",
        destino: t.tanque_nombre,
        detalle: ETIQUETA_COMBUSTIBLE[t.tipo_combustible],
        destinoId: t.id,
        subtipo: t.tipo_combustible,
        entradas: [],
      });
    }
    for (const g of f.proveedores.filter((p) => p.activo && p.abastece_ruta)) {
      for (const tipo of tipos) {
        const clave = claveCombustible("externa", g.id, tipo);
        filas.set(clave, {
          clave,
          producto: "combustible",
          tipo: "externa",
          destino: g.nombre,
          detalle: ETIQUETA_COMBUSTIBLE[tipo],
          destinoId: g.id,
          subtipo: tipo,
          entradas: [],
        });
      }
    }
    for (const p of f.precios) {
      const tipo: TipoPrecio = p.combustible_id !== null ? "interna" : "externa";
      const destinoId = (p.combustible_id ?? p.grifo_id) as number;
      const clave = claveCombustible(tipo, destinoId, p.tipo_combustible);
      let fila = filas.get(clave);
      if (!fila) {
        fila = {
          clave,
          producto: "combustible",
          tipo,
          destino: (tipo === "interna" ? p.tanque_nombre : p.grifo_nombre) ?? `#${destinoId}`,
          detalle: ETIQUETA_COMBUSTIBLE[p.tipo_combustible],
          destinoId,
          subtipo: p.tipo_combustible,
          entradas: [],
        };
        filas.set(clave, fila);
      }
      fila.entradas.push({
        id: p.id,
        precio: Number(p.precio_unitario),
        desde: p.vigente_desde,
        por: p.registrado_por_nombre,
        anulado: p.anulada_en !== null,
        anuladaMotivo: p.motivo_anulacion,
        marca: null,
      });
    }
  }

  if (ver.urea) {
    const activas = f.presentaciones.filter((p) => p.activa);
    for (const g of f.proveedoresUrea) {
      for (const pr of activas) {
        const clave = claveUrea(g.id, pr.codigo);
        filas.set(clave, {
          clave,
          producto: "urea",
          tipo: "externa",
          destino: g.nombre,
          detalle: textoPresentacion(pr.nombre, pr.litros),
          destinoId: g.id,
          subtipo: pr.codigo,
          entradas: [],
        });
      }
    }
    for (const p of f.preciosUrea) {
      const clave = claveUrea(p.grifo_id, p.presentacion);
      let fila = filas.get(clave);
      if (!fila) {
        fila = {
          clave,
          producto: "urea",
          tipo: "externa",
          destino: p.proveedor ?? `#${p.grifo_id}`,
          detalle: textoPresentacion(
            p.presentacion_nombre ?? p.presentacion,
            p.presentacion_litros
          ),
          destinoId: p.grifo_id,
          subtipo: p.presentacion,
          entradas: [],
        };
        filas.set(clave, fila);
      }
      fila.entradas.push({
        id: p.id,
        precio: Number(p.precio_por_bulto),
        desde: p.vigente_desde,
        por: p.cargado_por,
        anulado: p.anulada_en !== null,
        anuladaMotivo: p.motivo_anulacion,
        marca: p.marca,
      });
    }
  }

  const lista = [...filas.values()];
  for (const fila of lista) fila.entradas.sort(porFechaDesc);
  const orden = (a: FilaPrecio, b: FilaPrecio) =>
    a.producto.localeCompare(b.producto) ||
    a.tipo.localeCompare(b.tipo) ||
    a.destino.localeCompare(b.destino, "es") ||
    a.detalle.localeCompare(b.detalle, "es");
  return lista.sort(orden);
}

// ── Vigente, programado, variación ─────────────────────────────────────────

/** El precio que rige AHORA: el más reciente no anulado cuya fecha ya llegó. */
export function vigente(fila: FilaPrecio, ahora: number): EntradaPrecio | null {
  return fila.entradas.find((e) => !e.anulado && new Date(e.desde).getTime() <= ahora) ?? null;
}

/** El próximo precio programado (fecha futura, no anulado), si hay. */
export function programado(fila: FilaPrecio, ahora: number): EntradaPrecio | null {
  const futuros = fila.entradas.filter((e) => !e.anulado && new Date(e.desde).getTime() > ahora);
  return futuros.length ? futuros[futuros.length - 1] : null;
}

/** El precio inmediatamente anterior a una entrada (no anulado). */
export function anterior(fila: FilaPrecio, entrada: EntradaPrecio): EntradaPrecio | null {
  const t = new Date(entrada.desde).getTime();
  return fila.entradas.find((e) => !e.anulado && new Date(e.desde).getTime() < t) ?? null;
}

export function variacionPct(nuevo: number, base: number): number {
  return ((nuevo - base) / base) * 100;
}

export function textoVariacion(pct: number): string {
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)} %`;
}

export function diasDesde(iso: string, ahora: number): number {
  return Math.max(0, Math.floor((ahora - new Date(iso).getTime()) / 86_400_000));
}

/** "S/ 24.80" o "S/ 24.10 – 25.60"; "—" si no hay ninguno. */
export function textoRango(valores: number[]): string {
  if (valores.length === 0) return "—";
  const min = Math.min(...valores);
  const max = Math.max(...valores);
  const f = (n: number) => n.toFixed(2);
  return min === max ? `S/ ${f(min)}` : `S/ ${f(min)} – ${f(max)}`;
}

/** Fecha del último cambio vigente entre varias filas, o null. */
export function ultimoCambio(filas: FilaPrecio[], ahora: number): string | null {
  let ultimo: string | null = null;
  for (const fila of filas) {
    const v = vigente(fila, ahora);
    if (v && (ultimo === null || new Date(v.desde) > new Date(ultimo))) ultimo = v.desde;
  }
  return ultimo;
}
