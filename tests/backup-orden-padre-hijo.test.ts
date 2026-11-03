/** tests/backup-orden-padre-hijo.test.ts
 *
 * El restore recorre TABLAS_TENANT en orden y reasigna los ids con un mapa por
 * tabla (platformBackup.service.ts: restaurarTablas). Si una tabla va ANTES de
 * la que referencia, su FK no se reasigna: conserva el id del tenant ORIGEN, que
 * existe en la base, así que Postgres no protesta y el restore "pasa" dejando
 * una fila apuntando a otro tenant. Por eso el orden padre -> hijo se vigila acá.
 */
import { describe, it, expect } from "vitest";
import { MODULOS } from "../src/modules/registry";

// El orden de los módulos, tal cual lo concatena el restore (platformBackup.service.ts).
const TABLAS_TENANT = MODULOS.flatMap((m) => m.tablas);

describe("backup: cada tabla va después de las que referencia", () => {
  it("ninguna FK declarada apunta a una tabla que se restaura más tarde", () => {
    const posicion = new Map(TABLAS_TENANT.map((t, i) => [t.nombre, i]));
    const mal: string[] = [];
    for (const t of TABLAS_TENANT) {
      for (const [columna, padre] of Object.entries(t.fks ?? {})) {
        const donde = posicion.get(padre);
        if (donde !== undefined && donde > posicion.get(t.nombre)!) {
          mal.push(`${t.nombre}.${columna} -> ${padre}`);
        }
      }
    }
    expect(mal).toEqual([]);
  });
});
