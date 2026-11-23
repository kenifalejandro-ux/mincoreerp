/** src/server/shared/utils/nombreDeProveedor.ts
 *
 * ¿Ya hay un proveedor con ESTE nombre? El índice único de la base (migrations/0063) compara el texto tal cual,
 * así que «GRIFO DUP», «Grifo Dup» y «Grifo  Dup» (dos espacios) pasaban como tres proveedores distintos. Acá se
 * compara sin distinguir mayúsculas, con los espacios colapsados y sin caracteres invisibles.
 *
 * Es neutral a propósito: el catálogo de proveedores (`combustible_grifos`) se da de alta desde DOS módulos
 * (Proveedores y Combustible) y los dos usan esta misma regla sin importarse entre sí.
 *
 * Límite: es una comprobación ANTES de guardar, no una restricción de la base. Dos altas simultáneas con nombres
 * casi iguales aún podrían colarse; cerrarlo del todo pide un índice único, que puede fallar si ya hay
 * duplicados en una empresa, y por eso no se hizo acá. */
import type { PoolClient } from "pg";

// Espacios de ancho cero y marca de orden de bytes (U+200B a U+200D, U+2060 y U+FEFF): se escriben por su código
// para que el archivo no lleve caracteres invisibles.
const INVISIBLES = String.fromCodePoint(0x200b, 0x200c, 0x200d, 0x2060, 0xfeff);
const sinInvisibles = (texto: string) => [...texto].filter((c) => !INVISIBLES.includes(c)).join("");

/** La clave con la que se comparan dos nombres. */
export function claveDeNombre(nombre: string): string {
  return sinInvisibles(nombre).replace(/\s+/g, " ").trim().toLowerCase();
}

/** El nombre del proveedor de la empresa que se parece a `nombre` (el comodín «Otros» incluido), o `null`.
 *  `exceptoId`: al editar, el propio proveedor no cuenta. */
export async function nombreParecidoExistente(
  client: PoolClient,
  tenantId: string,
  nombre: string,
  exceptoId?: number
): Promise<string | null> {
  const r = await client.query<{ nombre: string }>(
    `SELECT nombre FROM combustible_grifos
      WHERE tenant_id = $1 AND ($3::int IS NULL OR id <> $3)
        AND lower(btrim(regexp_replace(regexp_replace(nombre, '[' || $4 || ']', '', 'g'), '\\s+', ' ', 'g'))) = $2
      LIMIT 1`,
    [tenantId, claveDeNombre(nombre), exceptoId ?? null, INVISIBLES]
  );
  return r.rows[0]?.nombre ?? null;
}
