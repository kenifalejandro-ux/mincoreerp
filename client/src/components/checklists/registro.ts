// client/src/components/checklists/registro.ts
//
// Lo que se anota y lo que se avisa al registrar un checklist, sin React: el resultado, la lectura del
// medidor y el mensaje que ve quien lo llenó.

export const RESULTADOS: Record<string, { texto: string; clase: string }> = {
  bien: { texto: "Bien", clase: "text-emerald-600" },
  observado: { texto: "Observado", clase: "text-amber-600" },
  no_apta: { texto: "No apta", clase: "px-2.5 py-1 rounded-full bg-red-100 text-red-700" },
};

export const resultadoDe = (resultado: string) => RESULTADOS[resultado] ?? RESULTADOS.observado;

export const SALIDAS: Record<string, { texto: string; clase: string }> = {
  no_sale: { texto: "No sale", clase: "text-red-600" },
  por_autorizar: { texto: "Por autorizar", clase: "text-amber-700" },
  autorizada: { texto: "Salida autorizada", clase: "text-emerald-600" },
  rechazada: { texto: "No autorizada: no sale", clase: "text-red-600" },
};

interface Persona {
  rol: string;
  permisosPestanas?: Record<string, boolean>;
}

/** Las casillas de Administración. El servidor es quien decide; esto solo muestra u oculta. */
export const puedeAutorizarSalida = (u: Persona | null | undefined) =>
  !!u && (u.rol === "admin" || u.permisosPestanas?.["checklists:salida:autorizar"] === true);
/** No nace para nadie, tampoco para el admin. */
export const puedeOmitirCriticas = (u: Persona | null | undefined) =>
  u?.permisosPestanas?.["checklists:salida:omitir_criticas"] === true;

export type Respuesta = "bien" | "malo" | "na" | "";

/** Con qué sale cada pregunta: las críticas sin respuesta (hay que elegir), las demás en «Bien». */
export const respuestaInicial = (critica?: boolean): Respuesta => (critica ? "" : "bien");

/** Lo que se manda: las respondidas. `faltan` son las críticas sin responder. */
export function respuestasParaEnviar(
  preguntas: { id: number; descripcion: string; critica?: boolean }[],
  respuestas: Record<number, { estado: Respuesta; observacion: string }>
) {
  const todas = preguntas.map((p) => ({
    descripcion: p.descripcion,
    critica: p.critica ?? false,
    estado: respuestas[p.id]?.estado ?? respuestaInicial(p.critica),
    observacion: respuestas[p.id]?.observacion || undefined,
  }));
  return {
    items: todas
      .filter((i) => i.estado !== "")
      .map(({ descripcion, estado, observacion }) => ({ descripcion, estado, observacion })),
    faltan: todas.filter((i) => i.estado === "").map((i) => i.descripcion),
    fallaCritica: todas.some((i) => i.critica && i.estado === "malo"),
    fallaMenor: todas.some((i) => !i.critica && i.estado === "malo"),
  };
}

const LECTURA_MAXIMA = 9_999_999;

/** La lectura escrita a mano. `valor` undefined = no se anotó. Admite hasta dos decimales con coma o punto,
 *  y rechaza el separador de miles: «125.000» se leería como 125. */
export function leerLectura(texto: string): { valor?: number; problema?: string } {
  const limpio = texto.trim();
  if (!limpio) return {};
  if (!/^\d+([.,]\d{1,2})?$/.test(limpio)) {
    return {
      problema:
        "La lectura va solo con números, sin separador de miles (ej. 125000 o 1520,5). Máximo dos decimales.",
    };
  }
  const valor = Number(limpio.replace(",", "."));
  if (valor > LECTURA_MAXIMA) return { problema: "La lectura es demasiado grande: revísala." };
  return { valor };
}

/** El aviso tras registrar con señal, o null si no hay nada que contar. */
export function avisoDelRegistro(r: {
  resultado?: string;
  salida?: string | null;
  orden_trabajo_id?: number | null;
  orden_nueva_id?: number | null;
  aviso_registro?: string | null;
}): string | null {
  const partes: string[] = [];
  if (r.resultado === "no_apta") {
    partes.push("Falló un punto crítico: el checklist quedó NO APTA y la unidad no sale.");
    if (r.orden_nueva_id) partes.push(`Se generó la orden de trabajo #${r.orden_nueva_id}.`);
    else if (r.orden_trabajo_id) {
      partes.push(`Ya había una orden abierta por esa falla: #${r.orden_trabajo_id}.`);
    }
  }
  if (r.salida === "por_autorizar") {
    partes.push("Hay una falla menor: la unidad espera a que autoricen su salida.");
  }
  if (r.aviso_registro) partes.push(r.aviso_registro);
  return partes.length > 0 ? ["Checklist registrado.", ...partes].join(" ") : null;
}

/** El aviso cuando quedó en la cola del dispositivo. Qué es crítico lo dice el formato que se tuvo delante;
 *  la orden la decide el servidor al recibirlo, así que aquí no se promete. */
export function avisoSinSenal(fallaCritica: boolean, fallaMenor = false): string {
  const base =
    "Sin conexión: el checklist quedó guardado en este equipo y se enviará solo cuando vuelva la señal.";
  if (fallaCritica) return `${base} Falló un punto crítico: queda NO APTA y la unidad no sale.`;
  if (fallaMenor) return `${base} Hay una falla menor: la unidad espera autorización para salir.`;
  return base;
}
