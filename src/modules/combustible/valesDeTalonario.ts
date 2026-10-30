// Revisión del talonario para los vales que NO son un despacho: el de una
// asignación de tanqueta a unidad (0141) y el de una línea de excedente (0140).
// Los despachos hacen lo mismo en CombustibleController.procesarAlertasDespachoCreado;
// acá se hace para uno o varios números de una misma serie a la vez, porque una
// recepción puede traer varias líneas (101, 102 y 103) y ninguna debe verse
// "fuera de orden" por culpa de las otras.
import type { PoolClient } from "pg";

import { CombustibleRepository } from "./combustible.repository";

/** Cuántos números puede saltar un vale respecto del último de su serie. Cada
 *  número salteado genera su propia alerta de hueco: un dígito de más dejaría
 *  miles de alertas (5ª auditoría). */
export const MAX_SALTO_TALONARIO = 300;

const repo = new CombustibleRepository();

/** El mensaje de rechazo si estos vales juntos saltan demasiado, o null. Se evalúa
 *  ANTES de guardar, una sola vez por tanda: lo que cuenta es el número más alto
 *  contra el último de la serie. Medirlo línea por línea dejaba pasar 5 líneas de
 *  300 saltos cada una (1.495 alertas de hueco en una sola recepción). */
export async function mensajeDeSalto(
  client: PoolClient,
  tenantId: string,
  serie: string,
  vales: number[]
): Promise<string | null> {
  if (vales.length === 0) return null;
  const mayor = Math.max(...vales);
  // Sin vales anteriores en la serie, el más bajo de la tanda es el primero.
  const base =
    (await repo.findMaxNValeDeSerie(client, tenantId, "combustible", serie)) ?? Math.min(...vales);
  if (mayor - base <= MAX_SALTO_TALONARIO) return null;
  return (
    `el vale ${mayor} salta ${mayor - base - 1} números desde el último cargado de la serie ` +
    `${serie} (${base}). Revisá el número: un dígito de más deja miles de vales ` +
    `marcados como faltantes. Si el talonario realmente arranca en ${mayor}, cargalo como una ` +
    `serie nueva`
  );
}

export interface RevisionDeVales {
  /** Cada número que falta y el vale que lo reveló. */
  huecos: { n: number; reveladoPor: number }[];
  /** Vales que entraron por debajo del máximo sin que un hueco alertado los esperara. */
  fueraDeOrden: { n: number; maximo: number }[];
  /** Vales que llenaron un hueco ya congelado como anomalía. */
  tardios: number[];
}

/** Lo que revela haber guardado estos vales. Ya están guardados: el máximo
 *  "anterior" se calcula SIN ellos, y se recorren de menor a mayor. */
export async function revisarValesDeTalonario(
  client: PoolClient,
  tenantId: string,
  serie: string,
  vales: number[]
): Promise<RevisionDeVales> {
  const orden = [...new Set(vales)].sort((a, b) => a - b);
  const resultado: RevisionDeVales = { huecos: [], fueraDeOrden: [], tardios: [] };
  let maximo = await repo.findMaxNValeDeSerieSalvo(client, tenantId, "combustible", serie, orden);
  for (const n of orden) {
    // Si el vale venía a llenar un hueco ya alertado, se resuelve solo; si el
    // hueco ya estaba congelado, no, y el vale es un despacho tardío.
    const { llegoTarde } = await repo.resolverAlertaHuecoSiExiste(
      client,
      tenantId,
      "combustible",
      serie,
      n
    );
    if (llegoTarde) resultado.tardios.push(n);
    const loEsperaba = await repo.existioHuecoPara(client, tenantId, "combustible", serie, n);
    if (maximo !== null && n > maximo + 1) {
      for (let faltante = maximo + 1; faltante < n; faltante++) {
        resultado.huecos.push({ n: faltante, reveladoPor: n });
      }
    } else if (maximo !== null && n < maximo && !loEsperaba) {
      resultado.fueraDeOrden.push({ n, maximo });
    }
    maximo = Math.max(maximo ?? n, n);
  }
  return resultado;
}
