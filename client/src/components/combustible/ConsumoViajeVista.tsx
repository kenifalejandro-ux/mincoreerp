// client/src/components/combustible/ConsumoViajeVista.tsx
//
// "Consumo por viaje" dentro de Viajes: el ranking de lo que cargó cada viaje y
// cuánto rindió contra el promedio de su ruta, de combustible o de urea. Antes era
// una vista del Histórico de Combustible y otra del de Urea; ahora vive acá, con su
// propio período y su selector de producto. La tabla es la de siempre
// (ConsumoPorViaje); este componente solo le pone el filtro.
import { useState } from "react";

import ConsumoPorViaje from "./ConsumoPorViaje";
import { useAuth } from "../../context/AuthContext";

type Producto = "combustible" | "urea";

const PERFILES_DE_OFICINA = ["admin", "operador", "lectura"];

export default function ConsumoViajeVista() {
  const { usuario } = useAuth();
  const [producto, setProducto] = useState<Producto>("combustible");
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  // Lo aplicado con "Consultar": la tabla no se recarga a cada letra del filtro.
  const [aplicado, setAplicado] = useState({ desde: "", hasta: "", n: 0 });

  // Urea tiene su propio permiso, y el servidor pide también que el submenú Urea esté
  // abierto: un permiso de "vista" suelto, con Urea apagado, no sirve.
  const permisoDeUrea = (pestana: string) => {
    if (usuario?.permisosPestanas?.["combustible:urea"] === false) return false;
    return (
      usuario?.permisosPestanas?.[`combustible:urea:${pestana}`] ??
      (usuario?.rol === "admin" || PERFILES_DE_OFICINA.includes(usuario?.rol ?? ""))
    );
  };
  const puedeVerUrea = permisoDeUrea("vista");

  const consultar = () =>
    setAplicado((p) => ({
      desde: desde ? new Date(`${desde}T00:00:00`).toISOString() : "",
      hasta: hasta ? new Date(`${hasta}T23:59:59`).toISOString() : "",
      n: p.n + 1,
    }));

  const campo =
    "rounded border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-800 outline-none focus:border-slate-500";

  return (
    <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-end gap-3">
        {puedeVerUrea && (
          <label className="flex flex-col gap-1 text-xs font-semibold uppercase text-slate-500">
            Producto
            <select
              value={producto}
              onChange={(e) => setProducto(e.target.value as Producto)}
              className={campo}
            >
              <option value="combustible">Combustible</option>
              <option value="urea">Urea</option>
            </select>
          </label>
        )}
        <label className="flex flex-col gap-1 text-xs font-semibold uppercase text-slate-500">
          Desde
          <input
            type="date"
            value={desde}
            onChange={(e) => setDesde(e.target.value)}
            className={campo}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold uppercase text-slate-500">
          Hasta
          <input
            type="date"
            value={hasta}
            onChange={(e) => setHasta(e.target.value)}
            className={campo}
          />
        </label>
        <button
          type="button"
          onClick={consultar}
          className="rounded bg-[#a3e635] px-3 py-1.5 text-sm font-medium text-black hover:bg-[#bef264]"
        >
          Consultar
        </button>
      </div>
      <ConsumoPorViaje
        key={producto}
        producto={producto}
        desde={aplicado.desde}
        hasta={aplicado.hasta}
        recargar={aplicado.n}
        puedeExportar={producto === "combustible" ? true : permisoDeUrea("exportar")}
      />
    </div>
  );
}
