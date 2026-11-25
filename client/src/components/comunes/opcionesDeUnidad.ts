// client/src/components/comunes/opcionesDeUnidad.ts
//
// Las opciones del selector de unidad: primero la de «no elegir ninguna» y después las unidades por su placa.
export function opcionesDeUnidad(
  unidades: { id: number; placa_codigo: string }[],
  sinElegir: string
) {
  return [
    { valor: "", etiqueta: sinElegir },
    ...unidades.map((u) => ({ valor: String(u.id), etiqueta: u.placa_codigo })),
  ];
}
