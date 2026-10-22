// A dónde va el saldo de una tanqueta que vuelve al grifo (0143/0145/0146): se
// queda en la tanqueta, vuelve al tanque (pozo) o pasa a otra tanqueta de la
// misma sede. Nada viene elegido de antemano: quien la recibe decide.
import { useEffect, useState } from "react";

import { type DestinoElegido, type OtraTanqueta, SIN_DESTINO } from "./destinoDelRetornoDatos";
import DestinoUnidad from "./DestinoUnidad";
import { useUnidadesDeDestino } from "./useUnidadesDeDestino";
import { apiFetch } from "../../services/apiClient";

/** Litros que tiene un galón (la tanqueta mide en galones; un tanque puede medir en litros). */
const LITROS_POR_GALON = 3.785411784;

interface TanqueDelPozo {
  id: number;
  codigo: string;
  tanque_nombre: string;
  unidad: "gal" | "L";
  capacidad_total: string;
  nivel_teorico: string | null;
  activo: boolean;
  grifo_interno_id: number | null;
}

const formatear = (n: number) => n.toLocaleString("es-PE", { maximumFractionDigits: 2 });

export default function DestinoDelRetorno({
  tanqueta,
  cantidad,
  otras,
  valor,
  onCambio,
}: {
  tanqueta: { id: string; grifo_interno_id: number; equipo_asignado_id: number | null };
  /** Lo que el grifero dice que volvió (gal): lo que habría que mover. */
  cantidad: number;
  otras: OtraTanqueta[];
  valor: DestinoElegido;
  onCambio: (d: DestinoElegido) => void;
}) {
  const [tanques, setTanques] = useState<TanqueDelPozo[] | null>(null);
  const [errorTanques, setErrorTanques] = useState(false);

  useEffect(() => {
    let vigente = true;
    (async () => {
      try {
        const res = await apiFetch("/api/erp/combustible");
        const body = await res.json().catch(() => null);
        if (!vigente) return;
        if (res.ok && Array.isArray(body)) setTanques(body);
        else setErrorTanques(true);
      } catch {
        if (vigente) setErrorTanques(true);
      }
    })();
    return () => {
      vigente = false;
    };
  }, []);

  const hayCantidad = cantidad > 0.005;
  const unidades = useUnidadesDeDestino(tanqueta.equipo_asignado_id);

  // Los tanques de la sede, con el espacio que les queda y cuánto entraría en su unidad.
  const delPozo = (tanques ?? [])
    .filter((t) => t.activo && Number(t.grifo_interno_id) === Number(tanqueta.grifo_interno_id))
    .filter((t) => t.nivel_teorico !== null)
    .map((t) => {
      const libre = Math.max(0, Number(t.capacidad_total) - Number(t.nivel_teorico));
      const entra = t.unidad === "L" ? cantidad * LITROS_POR_GALON : cantidad;
      return { t, libre, entra, cabe: entra <= libre + 0.005 };
    });

  const otrasConEspacio = otras
    .filter(
      (o) =>
        o.activa &&
        o.id !== tanqueta.id &&
        Number(o.grifo_interno_id) === Number(tanqueta.grifo_interno_id) &&
        Number(o.libre) > 0
    )
    .map((o) => ({ o, libre: Number(o.libre), cabe: cantidad <= Number(o.libre) + 0.001 }));

  const motivoPozo = !hayCantidad
    ? "No hay saldo que mover"
    : errorTanques
      ? "No se pudieron cargar los tanques"
      : tanques === null
        ? "Buscando tanques..."
        : delPozo.length === 0
          ? "No hay un tanque activo con lectura en esta sede"
          : null;
  const motivoTanqueta = !hayCantidad
    ? "No hay saldo que mover"
    : otrasConEspacio.length === 0
      ? "No hay otra tanqueta con espacio en esta sede"
      : null;

  const motivoUnidad = !hayCantidad ? "No hay saldo que mover" : unidades.motivo;

  const elegido = delPozo.find((x) => String(x.t.id) === valor.id);

  const opcion = (
    destino: "reserva" | "pozo" | "tanqueta" | "unidad",
    texto: string,
    motivoNo: string | null
  ) => (
    <div>
      <label className={`flex items-center gap-2 text-sm ${motivoNo ? "text-slate-400" : ""}`}>
        <input
          type="radio"
          name="retorno-destino"
          disabled={motivoNo !== null}
          checked={valor.destino === destino}
          onChange={() => onCambio({ ...SIN_DESTINO, destino })}
        />
        <span>{texto}</span>
      </label>
      {motivoNo && <p className="ml-6 text-xs text-slate-500">{motivoNo}</p>}
    </div>
  );

  return (
    <fieldset className="space-y-2">
      <legend className="text-xs font-bold text-slate-700 uppercase mb-1">
        ¿A dónde va el saldo?
      </legend>
      {opcion("reserva", "Se queda en la tanqueta, sin unidad", null)}

      {opcion("pozo", "Volver al tanque (pozo)", motivoPozo)}
      {valor.destino === "pozo" && (
        <div className="ml-6 space-y-1">
          <label htmlFor="retorno-tanque" className="text-xs font-bold text-slate-700 uppercase">
            ¿A qué tanque?
          </label>
          <select
            id="retorno-tanque"
            className="w-full border border-slate-200 rounded-xl p-3 text-sm"
            value={valor.id}
            onChange={(e) => onCambio({ ...SIN_DESTINO, destino: "pozo", id: e.target.value })}
          >
            <option value="">Elegir tanque</option>
            {delPozo.map(({ t, libre, cabe }) => (
              <option key={t.id} value={t.id} disabled={!cabe}>
                {t.codigo} · {t.tanque_nombre} · espacio para {formatear(libre)} {t.unidad}
                {cabe ? "" : " · no cabe"}
              </option>
            ))}
          </select>
          {elegido && elegido.t.unidad === "L" && (
            <p className="text-xs text-slate-600">
              El tanque mide en litros: entran {formatear(elegido.entra)} L.
            </p>
          )}
        </div>
      )}

      {opcion("tanqueta", "Pasa a otra tanqueta", motivoTanqueta)}
      {valor.destino === "tanqueta" && (
        <div className="ml-6 space-y-1">
          <label htmlFor="retorno-otra" className="text-xs font-bold text-slate-700 uppercase">
            ¿A cuál?
          </label>
          <select
            id="retorno-otra"
            className="w-full border border-slate-200 rounded-xl p-3 text-sm"
            value={valor.id}
            onChange={(e) => onCambio({ ...SIN_DESTINO, destino: "tanqueta", id: e.target.value })}
          >
            <option value="">Elegir tanqueta</option>
            {otrasConEspacio.map(({ o, libre, cabe }) => (
              <option key={o.id} value={o.id} disabled={!cabe}>
                {o.codigo} · tiene {formatear(libre)} gal libres{cabe ? "" : " · no cabe"}
              </option>
            ))}
          </select>
        </div>
      )}
      {opcion("unidad", "Pasa a otra unidad", motivoUnidad)}
      {valor.destino === "unidad" && (
        <DestinoUnidad unidades={unidades.otras} valor={valor} onCambio={onCambio} />
      )}
    </fieldset>
  );
}
