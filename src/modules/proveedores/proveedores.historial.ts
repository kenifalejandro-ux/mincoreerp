/** src/modules/proveedores/proveedores.historial.ts
 *
 * «Historial y auditoría» del ecosistema: lo que la gente de la empresa hizo con los proveedores, leído de
 * la bitácora que el ERP ya escribe en cada cambio (`platform_audit_log`, acciones `proveedores.*`). Acá
 * solo vive la parte pura: cómo se dice cada acción con palabras y a qué grupo pertenece. Sin base de datos.
 *
 * La bitácora guarda ids y referencias, nunca el contenido de negocio (ver moduleAudit.ts): lo que se
 * muestra sale de ahí, así que un número de cuenta, un teléfono o una dirección no aparecen jamás.
 */

export type CategoriaDeHistorial = "proveedor" | "precios" | "compras" | "ficha" | "cuentas";

export const CATEGORIAS_DE_HISTORIAL: { id: CategoriaDeHistorial; etiqueta: string }[] = [
  { id: "proveedor", etiqueta: "Proveedores" },
  { id: "precios", etiqueta: "Precios" },
  { id: "compras", etiqueta: "Compras" },
  { id: "ficha", etiqueta: "Datos y contactos" },
  { id: "cuentas", etiqueta: "Cuentas bancarias" },
];

/** Qué acciones son de cada grupo, como expresión regular sobre el nombre de la acción. */
export const PATRON_DE_CATEGORIA: Record<CategoriaDeHistorial, string> = {
  proveedor: "^proveedores\\.(crear|actualizar)$",
  precios: "^proveedores\\.precio_",
  compras: "^proveedores\\.compra_",
  ficha: "^proveedores\\.(datos_|contacto_)",
  cuentas: "^proveedores\\.cuenta_",
};

/** Todo lo que el ecosistema escribe en la bitácora. */
export const PATRON_DE_TODO = "^proveedores\\.";

export interface EventoDescrito {
  titulo: string;
  categoria: CategoriaDeHistorial | null;
  /** Detalle legible, una línea por dato. */
  lineas: string[];
}

type Detalle = Record<string, unknown> | null | undefined;

const COMBUSTIBLES: Record<string, string> = {
  diesel_b5: "Diésel B5",
  gasolina_90: "Gasolina 90",
  glp: "GLP",
};

const CAMPOS_DE_LA_FICHA: Record<string, string> = {
  direccion: "dirección",
  ciudad: "ciudad",
  telefono: "teléfono",
  correo: "correo",
  formaPago: "forma de pago",
  plazoPagoDias: "plazo de pago",
  moneda: "moneda",
};

const texto = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const numero = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const soles = (n: number) => `S/ ${n.toFixed(2)}`;

function lineaDeCuenta(d: Detalle): string | null {
  const banco = texto(d?.banco);
  const ultimos = texto(d?.ultimos4);
  if (!banco && !ultimos) return null;
  return [banco, ultimos ? `•••• ${ultimos}` : null].filter(Boolean).join(" ");
}

function lineaDePrecio(d: Detalle): string | null {
  if (d?.producto === "urea") {
    const presentacion = texto(d?.presentacion);
    const precio = numero(d?.precioPorBulto);
    return [
      "Urea",
      presentacion ? `(${presentacion})` : null,
      precio !== null ? `· ${soles(precio)} por bulto` : null,
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (d?.producto === "combustible") {
    const tipo = texto(d?.tipoCombustible);
    const precio = numero(d?.precioUnitario);
    return [
      tipo ? (COMBUSTIBLES[tipo] ?? tipo) : "Combustible",
      precio !== null ? `· ${soles(precio)} por galón` : null,
    ]
      .filter(Boolean)
      .join(" ");
  }
  return null;
}

/** Cómo se dice una acción de la bitácora, con sus datos. Una acción desconocida (de un PR futuro) se
 *  muestra con su nombre en vez de ocultarse: es mejor un renglón feo que un hueco en la auditoría. */
export function describirEvento(accion: string, detalle: Detalle): EventoDescrito {
  const d = detalle ?? {};
  const lineas: string[] = [];
  const agregar = (l: string | null) => l && lineas.push(l);
  const motivo = texto(d.motivo);

  switch (accion) {
    case "proveedores.crear": {
      const tipos = Array.isArray(d.tipos) ? d.tipos.filter((t) => typeof t === "string") : [];
      agregar(tipos.length ? `Abastece: ${tipos.join(" y ")}` : null);
      return { titulo: "Registró un proveedor", categoria: "proveedor", lineas };
    }
    case "proveedores.actualizar":
      if (typeof d.activo === "boolean") agregar(d.activo ? "Queda activo" : "Queda desactivado");
      return { titulo: "Editó un proveedor", categoria: "proveedor", lineas };

    case "proveedores.precio_crear":
      agregar(lineaDePrecio(d));
      if (d.masivo === true) agregar("Carga masiva a varios proveedores");
      return { titulo: "Cargó un precio", categoria: "precios", lineas };
    case "proveedores.precio_anular":
      agregar(lineaDePrecio(d) ?? (texto(d.producto) === "urea" ? "Urea" : "Combustible"));
      agregar(motivo ? `Motivo: ${motivo}` : null);
      return { titulo: "Anuló un precio", categoria: "precios", lineas };

    case "proveedores.compra_crear":
      agregar(numero(d.compraId) !== null ? `Compra n.º ${d.compraId}` : null);
      return { titulo: "Registró una compra", categoria: "compras", lineas };
    case "proveedores.compra_habilitar":
      agregar(numero(d.compraId) !== null ? `Compra n.º ${d.compraId}` : null);
      return { titulo: "Habilitó una compra para la cancha", categoria: "compras", lineas };
    case "proveedores.compra_anular":
      agregar(numero(d.compraId) !== null ? `Compra n.º ${d.compraId}` : null);
      return { titulo: "Anuló una compra", categoria: "compras", lineas };

    case "proveedores.datos_editar": {
      const campos = Array.isArray(d.campos)
        ? d.campos.map((c) => CAMPOS_DE_LA_FICHA[String(c)] ?? String(c))
        : [];
      agregar(campos.length ? `Cambió: ${campos.join(", ")}` : "Sin cambios");
      return { titulo: "Editó los datos y las condiciones de pago", categoria: "ficha", lineas };
    }
    case "proveedores.contacto_crear":
      return { titulo: "Agregó un contacto", categoria: "ficha", lineas };
    case "proveedores.contacto_editar":
      return { titulo: "Editó un contacto", categoria: "ficha", lineas };
    case "proveedores.contacto_quitar":
      return { titulo: "Quitó un contacto", categoria: "ficha", lineas };

    case "proveedores.cuenta_crear":
      agregar(lineaDeCuenta(d));
      return { titulo: "Agregó una cuenta bancaria", categoria: "cuentas", lineas };
    case "proveedores.cuenta_editar":
      agregar(lineaDeCuenta(d));
      return { titulo: "Editó una cuenta bancaria", categoria: "cuentas", lineas };
    case "proveedores.cuenta_cambiar_numero": {
      const antes = texto(d.ultimos4Anteriores);
      const despues = texto(d.ultimos4Nuevos);
      agregar(texto(d.banco));
      agregar(antes && despues ? `Número: •••• ${antes} → •••• ${despues}` : null);
      return { titulo: "Cambió el número de una cuenta", categoria: "cuentas", lineas };
    }
    case "proveedores.cuenta_ver":
      agregar(texto(d.ultimos4) ? `Cuenta •••• ${d.ultimos4}` : null);
      return { titulo: "Vio el número completo de una cuenta", categoria: "cuentas", lineas };
    case "proveedores.cuenta_quitar":
      agregar(motivo ? `Motivo: ${motivo}` : null);
      return { titulo: "Quitó una cuenta bancaria", categoria: "cuentas", lineas };
  }
  return {
    titulo: accion.replace(/^proveedores\./, "").replace(/_/g, " "),
    categoria: null,
    lineas,
  };
}

/** El `proveedorId` de un evento, si lo trae. */
export function proveedorDelEvento(detalle: Detalle): number | null {
  const id = numero(detalle?.proveedorId);
  return id !== null && Number.isInteger(id) && id > 0 ? id : null;
}
