/** tests/ecosistemas.test.ts
 *
 * La declaración de ecosistemas del cliente (client/src/ecosistemas/ecosistemas.ts): a qué ecosistema pertenece
 * una pestaña, un módulo o una dirección, y quién lo ve. Es lo que permite que App.tsx y el menú no nombren a
 * ningún ecosistema. Se prueba con el real (Proveedores) y con uno ficticio: sumar otro es agregarlo a la lista.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, it, expect } from "vitest";

import {
  ECOSISTEMAS,
  ecosistemaDeLaPestana,
  ecosistemaDeLaRuta,
  ecosistemaDeModulo,
  moduloDeLaPestana,
  modulosDeEcosistemas,
  type DefinicionDeEcosistema,
} from "../client/src/ecosistemas/ecosistemas";

/** Un segundo ecosistema inventado para el test: no existe en el ERP. */
const MANTENIMIENTO: DefinicionDeEcosistema = {
  id: "mantenimiento",
  titulo: "Gestión de mantenimiento",
  icono: "edificio",
  modulos: ["checklists", "ordenes_trabajo"],
  prefijoDeRuta: "/mantenimiento",
  pestaniaDeEntrada: "checklists",
  submenu: [],
  puedeVer: (u) =>
    !!u && u.modulosPermitidos.some((m) => ["checklists", "ordenes_trabajo"].includes(m)),
};
const DOS = [...ECOSISTEMAS, MANTENIMIENTO];

describe("ecosistemas: el declarado hoy", () => {
  it("Proveedores es el único y sus datos son los de siempre", () => {
    expect(ECOSISTEMAS.map((e) => e.id)).toEqual(["proveedores"]);
    const [p] = ECOSISTEMAS;
    expect(p.titulo).toBe("Gestión de proveedores");
    expect(p.icono).toBe("edificio");
    expect(p.modulos).toEqual(["proveedores"]);
    expect(p.prefijoDeRuta).toBe("/proveedores");
    expect(p.pestaniaDeEntrada).toBe("proveedores:centro");
    expect(p.submenu.map((s) => s.tab)).toEqual(["proveedores:centro"]);
  });

  it("cada módulo declarado existe en el registro del cliente y su pestaña de entrada es suya", () => {
    // El registro del cliente es un .tsx con React: se lee como texto para no cargarlo aquí.
    const texto = readFileSync(resolve(__dirname, "../client/src/modules/registry.tsx"), "utf8");
    const registro = [...texto.matchAll(/^\s+id: "([a-z_]+)",/gm)].map((m) => m[1]);
    for (const e of ECOSISTEMAS) {
      for (const modulo of e.modulos) expect(registro, `${e.id}: ${modulo}`).toContain(modulo);
      expect(e.modulos).toContain(moduloDeLaPestana(e.pestaniaDeEntrada));
      for (const s of e.submenu) expect(e.modulos).toContain(moduloDeLaPestana(s.tab));
    }
  });

  it("ningún módulo vive en dos ecosistemas", () => {
    const todos = modulosDeEcosistemas(DOS);
    expect(new Set(todos).size).toBe(todos.length);
  });

  it("lo ve quien tiene el módulo; sin sesión o sin el módulo, no", () => {
    const [p] = ECOSISTEMAS;
    expect(p.puedeVer({ modulosPermitidos: ["combustible", "proveedores"] })).toBe(true);
    expect(p.puedeVer({ modulosPermitidos: ["combustible"] })).toBe(false);
    expect(p.puedeVer(null)).toBe(false);
    expect(p.puedeVer(undefined)).toBe(false);
  });
});

describe("ecosistemaDeLaPestana / ecosistemaDeModulo", () => {
  it("una pestaña o un módulo de un ecosistema devuelven ese ecosistema", () => {
    expect(ecosistemaDeLaPestana("proveedores:centro")?.id).toBe("proveedores");
    expect(ecosistemaDeLaPestana("proveedores")?.id).toBe("proveedores");
    expect(ecosistemaDeModulo("proveedores")?.id).toBe("proveedores");
  });

  it("lo que no es de un ecosistema no devuelve nada (ni siquiera lo que se le parece)", () => {
    for (const tab of ["dashboard", "combustible", "combustible:proveedores", "flota:viajes", ""]) {
      expect(ecosistemaDeLaPestana(tab), tab).toBeUndefined();
    }
    expect(ecosistemaDeModulo("combustible")).toBeUndefined();
  });

  it("con un segundo ecosistema, cada pestaña cae en el suyo", () => {
    expect(ecosistemaDeLaPestana("checklists", DOS)?.id).toBe("mantenimiento");
    expect(ecosistemaDeLaPestana("ordenes_trabajo", DOS)?.id).toBe("mantenimiento");
    expect(ecosistemaDeLaPestana("proveedores:directorio", DOS)?.id).toBe("proveedores");
    expect(ecosistemaDeLaPestana("iperc", DOS)).toBeUndefined();
    // Sin pasarlo, solo existe el de hoy: lo ficticio no se cuela.
    expect(ecosistemaDeLaPestana("checklists")).toBeUndefined();
  });
});

describe("ecosistemaDeLaRuta", () => {
  it("reconoce el prefijo y lo que cuelga de él", () => {
    for (const ruta of ["/proveedores", "/proveedores/", "/proveedores/directorio/3/cuentas"]) {
      expect(ecosistemaDeLaRuta(ruta)?.id, ruta).toBe("proveedores");
    }
  });

  it("el prefijo es un tramo completo: /proveedoresX y otras no son suyas", () => {
    for (const ruta of ["/", "/proveedoresX", "/plataforma", "/control-tv", "/mantenimiento"]) {
      expect(ecosistemaDeLaRuta(ruta), ruta).toBeUndefined();
    }
  });

  it("con un segundo ecosistema, cada dirección va al suyo", () => {
    expect(ecosistemaDeLaRuta("/mantenimiento/ordenes", DOS)?.id).toBe("mantenimiento");
    expect(ecosistemaDeLaRuta("/proveedores/precios", DOS)?.id).toBe("proveedores");
    expect(ecosistemaDeLaRuta("/mantenimientoX", DOS)).toBeUndefined();
  });
});

describe("guardián: App.tsx no nombra ningún ecosistema", () => {
  const app = readFileSync(resolve(__dirname, "../client/src/App.tsx"), "utf8");

  it("no compara con el id de un ecosistema ni importa de su carpeta", () => {
    for (const e of ECOSISTEMAS) {
      for (const modulo of e.modulos) {
        expect(app, `compara con «${modulo}»`).not.toMatch(
          new RegExp(`(===|!==)\\s*"${modulo}"|"${modulo}"\\s*(===|!==)`)
        );
      }
      expect(app, `pestaña de entrada de ${e.id}`).not.toContain(`"${e.pestaniaDeEntrada}"`);
      expect(app, `importa de la carpeta de ${e.id}`).not.toMatch(
        new RegExp(`from\\s+"[./]*components/${e.id}/`)
      );
    }
  });

  it("decide por la declaración", () => {
    expect(app).toContain('from "./ecosistemas/ecosistemas"');
    expect(app).toContain("ecosistemaDeLaPestana");
    expect(app).toContain("ecosistemaDeLaRuta");
  });
});
