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
  orden_trabajo_id?: number | null;
  aviso_registro?: string | null;
}): string | null {
  const partes: string[] = [];
  if (r.resultado === "no_apta") {
    partes.push("Falló un punto crítico: el checklist quedó NO APTA.");
    if (r.orden_trabajo_id) partes.push(`Se generó la orden de trabajo #${r.orden_trabajo_id}.`);
  }
  if (r.aviso_registro) partes.push(r.aviso_registro);
  return partes.length > 0 ? ["Checklist registrado.", ...partes].join(" ") : null;
}

/** El aviso cuando quedó en la cola del dispositivo. Qué es crítico lo dice el formato que se tuvo delante;
 *  la orden la decide el servidor al recibirlo, así que aquí no se promete. */
export function avisoSinSenal(fallaCritica: boolean): string {
  const base =
    "Sin conexión: el checklist quedó guardado en este equipo y se enviará solo cuando vuelva la señal.";
  return fallaCritica ? `${base} Falló un punto crítico: queda NO APTA.` : base;
}
