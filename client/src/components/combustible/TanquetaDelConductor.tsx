// Lo que el conductor ve en vez de elegir tanqueta y unidad (migración 0139):
// la tanqueta que le asignaron, ya puesta. Solo carga galones y medidor.
// `tanquetas` viene del servidor ya filtrado a SU unidad y con la activa
// primero; si lleva dos o tres, la carga se reparte de una a otra.
export interface TanquetaAsignadaVista {
  id: number;
  codigo: string;
  saldo: number;
  equipo_asignado: string | null;
}

const formatear = (n: number) => n.toLocaleString("es-PE", { maximumFractionDigits: 2 });

export default function TanquetaDelConductor({
  tanquetas,
  cantidad,
  sinUnidad = false,
}: {
  tanquetas: TanquetaAsignadaVista[];
  cantidad: string;
  /** El servidor dice que este conductor no tiene ninguna unidad a su cargo en Equipos. */
  sinUnidad?: boolean;
}) {
  const [activa, siguiente] = tanquetas;
  if (!activa && sinUnidad) {
    return (
      <p className="text-sm text-amber-700">
        Tu usuario no tiene ninguna unidad a su cargo en Equipos. Pídele al administrador que revise
        tu DNI en la unidad que manejas.
      </p>
    );
  }
  if (!activa) {
    return (
      <p className="text-sm text-amber-700">
        No hay una tanqueta asignada a tu unidad (o no se pudo cargar la lista). Pídele al grifero o
        al administrador que te la asigne.
      </p>
    );
  }
  const galones = Number(cantidad);
  return (
    <div className="space-y-2">
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
        <p>
          Tanqueta <strong>{activa.codigo}</strong> · quedan{" "}
          <strong>{formatear(activa.saldo)} gal</strong>
        </p>
        {activa.equipo_asignado && (
          <p>
            Unidad <strong>{activa.equipo_asignado}</strong>
          </p>
        )}
      </div>
      {siguiente && galones > activa.saldo && (
        <p className="text-xs text-amber-700">
          En {activa.codigo} quedan {formatear(activa.saldo)} gal: registra esa cantidad y luego el
          resto desde {siguiente.codigo}.
        </p>
      )}
    </div>
  );
}
