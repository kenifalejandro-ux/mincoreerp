/** tests/modulos-autonomos.test.ts
 *
 * Vigila la regla de autonomía de los módulos (ver `opcionales` en
 * src/modules/types.ts): cada módulo funciona solo, y lo que lee de otro es
 * enriquecimiento DECLARADO. Un módulo que consulta tablas de otro, o importa
 * código de otro, sin declararlo en `opcionales` (o en `requiere`) hace fallar
 * este test: así lo nuevo nace autónomo y no depende de que alguien se acuerde
 * de revisarlo.
 *
 * Es un análisis ESTÁTICO del código fuente de src/modules (no usa la base):
 *  (a) SQL: `FROM|JOIN|INTO|UPDATE <tabla>` donde la tabla es de otro módulo.
 *  (b) Imports de archivos de otro módulo (los `import type` no cuentan: no
 *      acoplan en ejecución).
 *
 * Límites, a propósito: no ve SQL armado dinámicamente ni lecturas hechas a
 * través de una función de otro módulo (eso lo cubre (b) en buena parte), y
 * declarar `opcionales` no prueba que la lectura esté condicionada con
 * `tieneModulo()`: eso lo prueban los tests por escenario de cada módulo.
 *
 * ── EXCEPCIONES_CONOCIDAS ────────────────────────────────────────────────
 * Hoy hay dependencias que NO son opcionales y están sin declarar. Se listan
 * acá con su motivo y el paso que las elimina. La lista solo puede achicarse:
 * si una excepción deja de ocurrir, el test falla hasta que se borre. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { MODULOS } from "../src/modules/registry";

const RAIZ = resolve(__dirname, "..");
const MODULOS_DIR = join(RAIZ, "src", "modules");

// ── De quién es cada archivo ───────────────────────────────────────────────

/** El código de Viajes vive en la carpeta de Combustible (salió de ahí sin mover
 *  los archivos). Se asigna a mano; cuando se muevan, esto desaparece. */
const ARCHIVOS_DE_VIAJES_EN_COMBUSTIBLE = /^(viajes|controlTv|motivosDetencion)/;

const MODULO_DE_CARPETA: Record<string, string> = {
  equipos: "flota",
  viajes: "viajes",
  combustible: "combustible",
  checklists: "checklists",
  iperc: "iperc",
  ordenes_trabajo: "ordenes_trabajo",
  repuestos: "repuestos",
  documentos: "documentos",
  dashboard: "dashboard",
};

function moduloDeArchivo(rutaAbsoluta: string): string | null {
  const [carpeta, ...resto] = relative(MODULOS_DIR, rutaAbsoluta).split(/[\\/]/);
  if (!carpeta || resto.length === 0) return null; // registry.ts, types.ts
  if (carpeta === "combustible" && ARCHIVOS_DE_VIAJES_EN_COMBUSTIBLE.test(resto[0]))
    return "viajes";
  return MODULO_DE_CARPETA[carpeta] ?? null;
}

// ── De quién es cada tabla ─────────────────────────────────────────────────

/** Tablas que el registry declara dentro de Combustible pero son de otro módulo. */
const DUENO_DE_TABLA_POR_EXCEPCION: Record<string, string> = {
  combustible_lugares: "viajes",
  combustible_viajes: "viajes",
  combustible_viaje_paradas: "viajes",
  combustible_viaje_turnos: "viajes",
  combustible_viaje_descansos: "viajes",
  combustible_viaje_entregas: "viajes",
  combustible_viaje_manejo: "viajes",
  viaje_alertas: "viajes",
  combustible_viaje_ubicaciones: "viajes",
  equipo_rutas: "flota",
};

const duenoDeTabla = new Map<string, string>();
for (const modulo of MODULOS) {
  for (const t of modulo.tablas) duenoDeTabla.set(t.nombre, modulo.id);
}
for (const [tabla, dueno] of Object.entries(DUENO_DE_TABLA_POR_EXCEPCION)) {
  duenoDeTabla.set(tabla, dueno);
}

// ── Lo que declara cada módulo ─────────────────────────────────────────────

function declarados(id: string): Set<string> {
  const m = MODULOS.find((x) => x.id === id);
  return new Set([...(m?.requiere ?? []), ...(m?.opcionales ?? [])]);
}

// ── Análisis ───────────────────────────────────────────────────────────────

interface Cruce {
  lector: string;
  otro: string;
  tipo: "tabla" | "import";
  detalle: string;
  archivo: string;
}

function archivosTs(dir: string): string[] {
  return readdirSync(dir).flatMap((nombre) => {
    const ruta = join(dir, nombre);
    if (statSync(ruta).isDirectory()) return archivosTs(ruta);
    return ruta.endsWith(".ts") ? [ruta] : [];
  });
}

/** Sin comentarios: una tabla nombrada en un comentario no es una lectura. */
function sinComentarios(codigo: string): string {
  return codigo.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const RE_SQL = /\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-z_][a-z0-9_]*)/gi;
const RE_IMPORT = /^import\s+(?!type\b)[^;]*?from\s+["'](\.[^"']+)["']/gm;

function cruces(): Cruce[] {
  const resultado: Cruce[] = [];
  for (const archivo of archivosTs(MODULOS_DIR)) {
    const lector = moduloDeArchivo(archivo);
    if (!lector) continue;
    const codigo = sinComentarios(readFileSync(archivo, "utf8"));
    const rel = relative(RAIZ, archivo);

    for (const m of codigo.matchAll(RE_SQL)) {
      const tabla = m[1].toLowerCase();
      const otro = duenoDeTabla.get(tabla);
      if (otro && otro !== lector) {
        resultado.push({ lector, otro, tipo: "tabla", detalle: tabla, archivo: rel });
      }
    }

    for (const m of codigo.matchAll(RE_IMPORT)) {
      const destino = resolve(dirname(archivo), m[1]);
      const candidatos = [`${destino}.ts`, join(destino, "index.ts")];
      const real = candidatos.find((c) => {
        try {
          return statSync(c).isFile();
        } catch {
          return false;
        }
      });
      if (!real) continue;
      const otro = moduloDeArchivo(real);
      if (otro && otro !== lector) {
        resultado.push({ lector, otro, tipo: "import", detalle: m[1], archivo: rel });
      }
    }
  }
  return resultado;
}

/** Cruces que no están declarados ni en `requiere` ni en `opcionales`. */
function sinDeclarar(): Cruce[] {
  return cruces().filter((c) => !declarados(c.lector).has(c.otro));
}

const clave = (c: { lector: string; otro: string }) => `${c.lector} -> ${c.otro}`;

// ── Excepciones conocidas ──────────────────────────────────────────────────

/** Dependencias que hoy NO son opcionales y no están declaradas. Cada una dice por
 *  qué existe y qué la elimina. Esta lista solo se achica. */
const EXCEPCIONES_CONOCIDAS: Record<string, string> = {
  "combustible -> flota":
    "El vale, las tanquetas y la compra en ruta se despachan a una unidad (equipos, registro de Flota), " +
    "y Combustible lee sus datos y su conductor. Se resuelve al hacer autónomo a Combustible, que viene " +
    "después de Flota; sin `requiere`, por decisión de Kenif.",
};

describe("autonomía de módulos: lecturas cruzadas declaradas", () => {
  it("cada módulo declara en `opcionales`/`requiere` solo módulos que existen, sin repetirse ni citarse a sí mismo", () => {
    const ids = new Set(MODULOS.map((m) => m.id));
    for (const m of MODULOS) {
      const opcionales = m.opcionales ?? [];
      for (const o of opcionales) {
        expect(ids.has(o), `${m.id}.opcionales cita "${o}", que no es un módulo`).toBe(true);
        expect(o, `${m.id} se declara a sí mismo como opcional`).not.toBe(m.id);
        expect(
          (m.requiere ?? []).includes(o),
          `${m.id} declara "${o}" a la vez en requiere y en opcionales`
        ).toBe(false);
      }
      expect(new Set(opcionales).size, `${m.id}.opcionales tiene repetidos`).toBe(
        opcionales.length
      );
    }
  });

  it("ningún módulo lee tablas ni importa código de otro sin declararlo (salvo las excepciones conocidas)", () => {
    const nuevos = sinDeclarar().filter((c) => !(clave(c) in EXCEPCIONES_CONOCIDAS));
    // Una línea por par, con cuántas veces y en qué archivos: el detalle completo no ayuda a decidir.
    const porPar = new Map<string, { veces: number; donde: Set<string> }>();
    for (const c of nuevos) {
      const k = `${clave(c)}  [${c.tipo}]`;
      const f = porPar.get(k) ?? { veces: 0, donde: new Set<string>() };
      f.veces += 1;
      f.donde.add(`${c.archivo} (${c.detalle})`);
      porPar.set(k, f);
    }
    const mensaje = [...porPar]
      .map(([k, f]) => `  ${k} x${f.veces}\n      ${[...f.donde].join("\n      ")}`)
      .join("\n");
    expect(
      mensaje,
      "Lecturas cruzadas SIN declarar. Si enriquecen, agrégalas a `opcionales` del módulo que lee " +
        "(y condiciónalas con tieneModulo()); si son una dependencia dura, es una decisión de diseño."
    ).toBe("");
  });

  it("cada excepción conocida sigue ocurriendo (si ya no, se borra de la lista)", () => {
    const vigentes = new Set(sinDeclarar().map(clave));
    const viejas = Object.keys(EXCEPCIONES_CONOCIDAS).filter((k) => !vigentes.has(k));
    expect(
      viejas,
      `Estas excepciones ya no ocurren (o ahora están declaradas): bórralas de EXCEPCIONES_CONOCIDAS`
    ).toEqual([]);
  });

  it("reconoce de quién es cada archivo: el código de Viajes en la carpeta de Combustible no cuenta como Combustible", () => {
    expect(moduloDeArchivo(join(MODULOS_DIR, "combustible", "viajes.service.ts"))).toBe("viajes");
    expect(moduloDeArchivo(join(MODULOS_DIR, "combustible", "controlTvUnidad.service.ts"))).toBe(
      "viajes"
    );
    expect(moduloDeArchivo(join(MODULOS_DIR, "combustible", "combustible.service.ts"))).toBe(
      "combustible"
    );
    expect(moduloDeArchivo(join(MODULOS_DIR, "equipos", "equipos.service.ts"))).toBe("flota");
    expect(duenoDeTabla.get("combustible_viajes")).toBe("viajes");
    expect(duenoDeTabla.get("combustible_despachos")).toBe("combustible");
  });
});
