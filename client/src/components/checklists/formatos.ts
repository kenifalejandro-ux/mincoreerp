// client/src/components/checklists/formatos.ts
//
// Los formatos de checklist y sus versiones, sin React: tipos, las llamadas y cómo se arma lo que se guarda.
import { apiFetch } from "../../services/apiClient";

export interface Plantilla {
  id: number;
  nombre: string;
  tipo_equipo: string | null;
  creado_en: string;
  /** Pueden faltar en una respuesta guardada sin señal antes de que existieran las versiones. */
  version?: number;
  activa?: boolean;
}

export interface PlantillaConItems extends Plantilla {
  items: { id: number; descripcion: string; orden: number; critica?: boolean }[];
}

export interface ItemDeFormato {
  descripcion: string;
  critica: boolean;
}

export interface VersionDeFormato {
  version: number;
  nombre: string;
  tipo_equipo: string | null;
  items: ItemDeFormato[];
  cambio: string | null;
  creado_en: string;
  creado_por_nombre: string | null;
}

export interface FormularioDeFormato {
  nombre: string;
  tipo_equipo: string;
  cambio: string;
  items: ItemDeFormato[];
}

export const FORMULARIO_VACIO: FormularioDeFormato = {
  nombre: "",
  tipo_equipo: "",
  cambio: "",
  items: [{ descripcion: "", critica: false }],
};

export function formularioDe(p: PlantillaConItems): FormularioDeFormato {
  return {
    nombre: p.nombre,
    tipo_equipo: p.tipo_equipo ?? "",
    cambio: "",
    items: p.items.map((i) => ({ descripcion: i.descripcion, critica: i.critica ?? false })),
  };
}

/** Lo que se manda: sin las preguntas en blanco. `versionBase` null es un formato nuevo. */
export function cuerpoDelFormato(f: FormularioDeFormato, versionBase: number | null) {
  const items = f.items
    .map((i) => ({ descripcion: i.descripcion.trim(), critica: i.critica }))
    .filter((i) => i.descripcion)
    .map((i, orden) => ({ ...i, orden }));
  const base = { nombre: f.nombre.trim(), tipo_equipo: f.tipo_equipo.trim() || undefined, items };
  return versionBase === null
    ? base
    : { ...base, version_base: versionBase, cambio: f.cambio.trim() };
}

/** Por qué no se puede guardar todavía, o null. */
export function problemaDelFormato(f: FormularioDeFormato, esEdicion: boolean): string | null {
  if (!f.nombre.trim()) return "Escribe el nombre del formato.";
  if (!f.items.some((i) => i.descripcion.trim())) return "La plantilla necesita al menos un ítem.";
  if (esEdicion && f.cambio.trim().length < 3) return "Escribe qué cambió (al menos 3 letras).";
  return null;
}

/** Los formatos que se ofrecen para llenar: los desactivados no. */
export const formatosParaLlenar = (lista: Plantilla[]) => lista.filter((p) => p.activa !== false);

const RUTA = "/api/erp/checklists/plantillas";

async function mensaje(res: Response, porDefecto: string) {
  const data = await res.json().catch(() => ({}));
  return data.errors?.[0]?.message || data.message || data.error || porDefecto;
}

async function pedir(ruta: string, porDefecto: string, metodo = "GET", cuerpo?: unknown) {
  const res = await apiFetch(`${RUTA}${ruta}`, {
    method: metodo,
    headers: { "Content-Type": "application/json" },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  if (!res.ok) throw new Error(await mensaje(res, porDefecto));
  return res.json();
}

export const leerFormato = (id: number): Promise<PlantillaConItems> =>
  pedir(`/${id}`, "No se pudo abrir el formato.");
export const guardarFormato = (f: FormularioDeFormato, editando: PlantillaConItems | null) =>
  editando
    ? pedir(
        `/${editando.id}`,
        "No se pudo guardar el formato.",
        "PUT",
        cuerpoDelFormato(f, editando.version ?? 1)
      )
    : pedir("", "Error al crear la plantilla.", "POST", cuerpoDelFormato(f, null));
export const leerVersiones = (id: number): Promise<VersionDeFormato[]> =>
  pedir(`/${id}/versiones`, "No se pudieron leer las versiones.");
export const volverAVersion = (id: number, version: number, versionBase: number) =>
  pedir(`/${id}/versiones/${version}/restaurar`, "No se pudo volver a esa versión.", "POST", {
    version_base: versionBase,
  });
export const activarFormato = (id: number, activa: boolean) =>
  pedir(`/${id}/estado`, "No se pudo cambiar el estado.", "PATCH", { activa });
export const eliminarFormato = (id: number) =>
  pedir(`/${id}`, "No se pudo eliminar el formato.", "DELETE");
