/** src/modules/proveedores/proveedores.precios.ts
 *
 * Gestión comercial (PR4, solo lectura): arma, a partir de los precios que ya guarda Combustible, la
 * fila «proveedor × producto» con su precio vigente, el anterior, el programado y la historia. Lógica
 * pura: sin base ni red, para probarla sola.
 *
 * Las reglas son las de Combustible (migraciones 0063 y 0121) y acá se respetan igual:
 *   · Un precio se APILA con su `vigente_desde`; nunca se edita ni se pisa. Uno mal cargado se anula
 *     con motivo y queda como evidencia.
 *   · El VIGENTE es el más reciente NO anulado cuya fecha ya llegó. Uno con fecha futura es
 *     «programado»: todavía no rige.
 *   · Combustible: el precio de un proveedor es el de RUTA (el externo). La «venta interna» es de los
 *     tanques y no es un precio de proveedor, así que no se lista acá. Los proveedores de ruta
 *     «deben» precio de los tipos de combustible que la empresa maneja en sus tanques.
 *   · Urea: por proveedor y presentación (precio por envase).
 */
import type { ProveedorDto } from "./proveedores.service";

export type ProductoPrecio = "combustible" | "urea";

export const ETIQUETA_COMBUSTIBLE: Record<string, string> = {
  diesel_b5: "Diésel B5",
  gasolina_90: "Gasolina 90",
  glp: "GLP",
};

export interface EntradaPrecioDto {
  id: number;
  precio: number;
  /** ISO 8601. */
  desde: string;
  por: string | null;
  marca: string | null;
  anulado: boolean;
  motivo: string | null;
}

export interface FilaPrecioDto {
  clave: string;
  proveedorId: number;
  proveedorCodigo: string;
  proveedorNombre: string;
  proveedorActivo: boolean;
  producto: ProductoPrecio;
  /** `diesel_b5` / `gasolina_90` / `glp`, o el código de la presentación de urea. */
  codigo: string;
  /** «Diésel B5» o «Caja (20 L)». */
  detalle: string;
  /** «galón» o «envase». */
  unidad: string;
  vigente: EntradaPrecioDto | null;
  /** El precio válido inmediatamente anterior al vigente, para la variación. */
  anterior: EntradaPrecioDto | null;
  /** El próximo precio con fecha futura (el más cercano). */
  programado: EntradaPrecioDto | null;
  /** Toda la historia, anulados incluidos, del más nuevo al más viejo. */
  historial: EntradaPrecioDto[];
}

export interface FilaPrecioCombustibleDb {
  id: number;
  tipo_combustible: string;
  grifo_id: number;
  precio_unitario: string;
  vigente_desde: Date | string;
  registrado_por: string | null;
  anulada_en: Date | string | null;
  motivo_anulacion: string | null;
}

export interface FilaPrecioUreaDb {
  id: number;
  grifo_id: number;
  presentacion: string;
  marca: string | null;
  precio_por_bulto: string;
  vigente_desde: Date | string;
  registrado_por: string | null;
  anulada_en: Date | string | null;
  motivo_anulacion: string | null;
}

export interface PresentacionDb {
  codigo: string;
  nombre: string;
  litros: string | null;
}

export interface FuentesPrecios {
  proveedores: ProveedorDto[];
  preciosCombustible: FilaPrecioCombustibleDb[];
  preciosUrea: FilaPrecioUreaDb[];
  /** Tipos de combustible de los tanques activos de la empresa. */
  tiposEnTanques: string[];
  /** Presentaciones de urea activas. */
  presentaciones: PresentacionDb[];
}

const aIso = (f: Date | string) => new Date(f).toISOString();

const textoPresentacion = (nombre: string, litros: string | null) =>
  litros ? `${nombre} (${Number(litros)} L)` : nombre;

/** Del más nuevo al más viejo; a igual fecha, el de mayor id (el último cargado). */
function masNuevoPrimero(
  a: EntradaPrecioDto & { _id: number },
  b: EntradaPrecioDto & { _id: number }
) {
  const d = new Date(b.desde).getTime() - new Date(a.desde).getTime();
  return d !== 0 ? d : b._id - a._id;
}

function resolver(entradas: EntradaPrecioDto[], ahora: Date) {
  const ordenadas = [...entradas]
    .map((e) => ({ ...e, _id: e.id }))
    .sort(masNuevoPrimero)
    .map(({ _id: _omitido, ...e }) => e);
  const validas = ordenadas.filter((e) => !e.anulado);
  const rigen = validas.filter((e) => new Date(e.desde).getTime() <= ahora.getTime());
  const futuras = validas.filter((e) => new Date(e.desde).getTime() > ahora.getTime());
  return {
    vigente: rigen[0] ?? null,
    anterior: rigen[1] ?? null,
    // La más cercana en el tiempo: la última de la lista descendente.
    programado: futuras.length ? futuras[futuras.length - 1] : null,
    historial: ordenadas,
  };
}

export function armarFilasDePrecios(
  f: FuentesPrecios,
  ver: { combustible: boolean; urea: boolean },
  ahora: Date = new Date()
): FilaPrecioDto[] {
  const proveedores = new Map(f.proveedores.map((p) => [p.id, p]));
  interface Borrador {
    proveedorId: number;
    producto: ProductoPrecio;
    codigo: string;
    detalle: string;
    unidad: string;
    entradas: EntradaPrecioDto[];
  }
  const filas = new Map<string, Borrador>();
  const asegurar = (b: Omit<Borrador, "entradas">): Borrador => {
    const clave = `${b.producto}|${b.proveedorId}|${b.codigo}`;
    let fila = filas.get(clave);
    if (!fila) {
      fila = { ...b, entradas: [] };
      filas.set(clave, fila);
    }
    return fila;
  };

  if (ver.combustible) {
    const tipos = new Set(f.tiposEnTanques);
    for (const p of f.proveedores.filter((x) => x.activo && x.combustible.externo)) {
      for (const tipo of tipos) {
        asegurar({
          proveedorId: p.id,
          producto: "combustible",
          codigo: tipo,
          detalle: ETIQUETA_COMBUSTIBLE[tipo] ?? tipo,
          unidad: "galón",
        });
      }
    }
    for (const r of f.preciosCombustible) {
      if (!proveedores.has(r.grifo_id)) continue; // el comodín «Otros» u otra empresa
      asegurar({
        proveedorId: r.grifo_id,
        producto: "combustible",
        codigo: r.tipo_combustible,
        detalle: ETIQUETA_COMBUSTIBLE[r.tipo_combustible] ?? r.tipo_combustible,
        unidad: "galón",
      }).entradas.push({
        id: r.id,
        precio: Number(r.precio_unitario),
        desde: aIso(r.vigente_desde),
        por: r.registrado_por,
        marca: null,
        anulado: r.anulada_en !== null,
        motivo: r.motivo_anulacion,
      });
    }
  }

  if (ver.urea) {
    const nombres = new Map(f.presentaciones.map((x) => [x.codigo, x]));
    for (const p of f.proveedores.filter((x) => x.activo && (x.urea.interno || x.urea.externo))) {
      for (const pr of f.presentaciones) {
        asegurar({
          proveedorId: p.id,
          producto: "urea",
          codigo: pr.codigo,
          detalle: textoPresentacion(pr.nombre, pr.litros),
          unidad: "envase",
        });
      }
    }
    for (const r of f.preciosUrea) {
      if (!proveedores.has(r.grifo_id)) continue;
      const pr = nombres.get(r.presentacion);
      asegurar({
        proveedorId: r.grifo_id,
        producto: "urea",
        codigo: r.presentacion,
        detalle: pr ? textoPresentacion(pr.nombre, pr.litros) : r.presentacion,
        unidad: "envase",
      }).entradas.push({
        id: r.id,
        precio: Number(r.precio_por_bulto),
        desde: aIso(r.vigente_desde),
        por: r.registrado_por,
        marca: r.marca,
        anulado: r.anulada_en !== null,
        motivo: r.motivo_anulacion,
      });
    }
  }

  return [...filas.entries()]
    .map(([clave, b]): FilaPrecioDto => {
      const p = proveedores.get(b.proveedorId)!;
      return {
        clave,
        proveedorId: p.id,
        proveedorCodigo: p.codigo,
        proveedorNombre: p.nombre,
        proveedorActivo: p.activo,
        producto: b.producto,
        codigo: b.codigo,
        detalle: b.detalle,
        unidad: b.unidad,
        ...resolver(b.entradas, ahora),
      };
    })
    .sort(
      (a, b) =>
        a.producto.localeCompare(b.producto) ||
        a.detalle.localeCompare(b.detalle, "es") ||
        a.proveedorNombre.localeCompare(b.proveedorNombre, "es")
    );
}
