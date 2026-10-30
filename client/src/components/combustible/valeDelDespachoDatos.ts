// Cuándo el formulario de despacho NO pide serie ni número de vale (0161).
//
// Llenar una tanqueta desde el tanque sin decir para qué unidad va es un
// traspaso interno: el vale es de la entrega a la unidad. Con unidad elegida
// el vale se pide, como siempre. Espejo de la regla del servidor.

export function despachoSinVale(f: {
  origen: string;
  tipo_destino: string;
  tanqueta_destino_id: string;
  tanqueta_equipo_id: string;
}): boolean {
  return (
    f.origen === "tanque_propio" &&
    f.tipo_destino === "reserva_cubeta" &&
    f.tanqueta_destino_id !== "" &&
    f.tanqueta_equipo_id === ""
  );
}
