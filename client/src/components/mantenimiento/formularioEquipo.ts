// client/src/components/mantenimiento/formularioEquipo.ts
//
// La lógica del formulario de equipos, sin React: el estado inicial, lo que se valida antes de enviar y el
// cuerpo que viaja. El servidor valida lo mismo (y rechaza una placa repetida); esto solo ahorra el viaje.
import type { DatosDeEquipo, EquipoMantenimiento } from "./mantenimientoApi";

export interface FormularioDeEquipo {
  placa: string;
  tipo: string;
  marca: string;
  modelo: string;
  medidor: "horometro" | "odometro";
  /** Texto, para poder escribir «12,5» o dejarlo vacío mientras se teclea. */
  lectura: string;
  propiedad: "propia" | "alquilada";
  /** Id del área como texto; "" = sin área. */
  area: string;
}

export const LECTURA_MAXIMA = 9_999_999.9;

export function formularioInicial(equipo?: EquipoMantenimiento): FormularioDeEquipo {
  return {
    placa: equipo?.placa_codigo ?? "",
    tipo: equipo?.tipo ?? "",
    marca: equipo?.marca ?? "",
    modelo: equipo?.modelo ?? "",
    medidor: equipo?.medidor ?? "horometro",
    lectura: equipo ? String(equipo.lectura) : "0",
    propiedad: equipo?.propiedad ?? "propia",
    area: equipo?.area_id != null ? String(equipo.area_id) : "",
  };
}

/** Acepta «1,234.5», «1234,5» o «1234.5»; devuelve NaN si no es un número. */
export function leerLectura(texto: string): number {
  const t = texto.trim().replace(/\s/g, "");
  if (t === "") return 0;
  // «12,5» (coma decimal) se lee como 12.5; «1,234.5» (coma de miles) como 1234.5.
  const normal = /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t) ? t.replace(/,/g, "") : t.replace(",", ".");
  return /^\d+(\.\d+)?$/.test(normal) ? Number(normal) : NaN;
}

/** Los problemas que impiden guardar, en el orden en que se ven en el formulario. */
export function problemasDelEquipo(f: FormularioDeEquipo): string[] {
  const problemas: string[] = [];
  if (!f.placa.trim()) problemas.push("Escribe la placa o el código.");
  if (!f.tipo.trim()) problemas.push("Escribe el tipo de equipo.");
  const lectura = leerLectura(f.lectura);
  if (Number.isNaN(lectura)) problemas.push("La lectura debe ser un número, por ejemplo 3250.5.");
  else if (lectura > LECTURA_MAXIMA) problemas.push("La lectura es demasiado grande.");
  return problemas;
}

export function cuerpoDelEquipo(f: FormularioDeEquipo): DatosDeEquipo {
  return {
    placa_codigo: f.placa.trim(),
    tipo: f.tipo.trim(),
    marca: f.marca.trim(),
    modelo: f.modelo.trim(),
    medidor: f.medidor,
    lectura: leerLectura(f.lectura),
    propiedad: f.propiedad,
    area_id: f.area === "" ? null : Number(f.area),
  };
}

export const MOTIVO_MINIMO = 3;
export const MOTIVO_MAXIMO = 300;

/** El problema del motivo para quitar un equipo, o null si está bien. */
export function problemaDelMotivo(motivo: string): string | null {
  const t = motivo.trim();
  if (t.length < MOTIVO_MINIMO) return `Escribe el motivo (al menos ${MOTIVO_MINIMO} letras).`;
  if (t.length > MOTIVO_MAXIMO) return `El motivo no puede pasar de ${MOTIVO_MAXIMO} letras.`;
  return null;
}
