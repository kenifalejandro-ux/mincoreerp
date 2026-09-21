// client/src/components/comunes/useSedes.ts
//
// Las sedes y grifos internos de la empresa (migración 0097), para los
// selectores de tanque y de equipo.
//
// `hayVarios` es LA regla de "cero fricción": con un solo grifo activo nadie
// ve un selector, una columna ni un filtro nuevo. Una empresa sin el módulo
// Combustible siempre tiene uno solo (el "Principal"), así que queda cubierta
// sin preguntar por módulos.
import { useCallback, useEffect, useMemo, useState } from "react";

import { listarSedesApi, type Sede } from "../../services/sedesApi";

export interface OpcionDeGrifo {
  id: number;
  nombre: string;
  sede: string;
  /** "Sede · Grifo", o solo el grifo si hay una sola sede. */
  etiqueta: string;
}

export function useSedes() {
  const [sedes, setSedes] = useState<Sede[]>([]);
  const [vuelta, setVuelta] = useState(0);

  useEffect(() => {
    let vigente = true;
    (async () => {
      try {
        const lista = await listarSedesApi();
        if (vigente) setSedes(lista);
      } catch {
        // Sin la lista no hay selector: el servidor asigna el grifo si hay
        // uno solo, y lo exige con un mensaje claro si hay varios.
      }
    })();
    return () => {
      vigente = false;
    };
  }, [vuelta]);

  const grifosActivos = useMemo<OpcionDeGrifo[]>(() => {
    const sedesActivas = sedes.filter((s) => s.activo);
    const variasSedes = sedesActivas.length > 1;
    return sedesActivas.flatMap((s) =>
      s.grifos
        .filter((g) => g.activo)
        .map((g) => ({
          id: g.id,
          nombre: g.nombre,
          sede: s.nombre,
          etiqueta: variasSedes ? `${s.nombre} · ${g.nombre}` : g.nombre,
        }))
    );
  }, [sedes]);

  /** El nombre de un grifo por id, incluidos los dados de baja: un tanque
   *  viejo puede seguir apuntando a uno. */
  const nombreDeGrifo = useCallback(
    (id: number | null | undefined) => {
      if (id == null) return "—";
      for (const s of sedes) {
        const g = s.grifos.find((x) => x.id === id);
        if (g) return sedes.length > 1 ? `${s.nombre} · ${g.nombre}` : g.nombre;
      }
      return "—";
    },
    [sedes]
  );

  return {
    sedes,
    grifosActivos,
    hayVarios: grifosActivos.length > 1,
    nombreDeGrifo,
    recargar: () => setVuelta((v) => v + 1),
  };
}
