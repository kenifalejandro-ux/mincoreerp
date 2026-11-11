// La vista «Marcas» del Control TV: cada unidad como el ícono de su tipo, de «Salida» a «Regreso»
// según sus marcas (llegadas y salidas de las paradas). Sin GPS es una estimación. Se muestra dentro
// del marco del mapa (junto a «Digital» y «Satélite»); la leyenda de estados que filtra vive en el mapa.
import { CATS, categoriaDe, posicionEnRuta } from "./controlTvLogica";
import { IconoTipo } from "./iconosUnidad";
import { anchoDeIcono } from "./tiposUnidad";
import { estadoDelViaje, paradasDelViaje } from "../combustible/paradasViaje";
import { unidadLabel, type FilaViaje } from "../combustible/viajesFormato";

/** Alto del ícono dentro de la ficha. */
const ALTO_FICHA = 16;
const COLOR = Object.fromEntries(CATS.map((c) => [c.k, c.c]));

export function MarcasEnVivo({
  viajes,
  onElegir,
  anchoPanel = 900,
}: {
  viajes: FilaViaje[];
  onElegir: (id: string) => void;
  /** Ancho aproximado del panel en píxeles (unos 360 en el celular): sirve para separar las fichas. */
  anchoPanel?: number;
}) {
  const filas = 12;
  const orden = [6, 5, 7, 4, 8, 3, 9, 2, 10, 1, 11, 0];
  const ultimo = orden.map(() => -99);
  const anchoDe = orden.map(() => 4.6);
  // Lo que ocupa cada ficha, en % del ancho (se estima sobre el ancho del panel): un tráiler es más largo
  // que una camioneta, y las fichas de una misma fila no se montan.
  const ancho = (v: FilaViaje) =>
    ((anchoDeIcono(v.equipo_tipo, ALTO_FICHA) + 14) * 100) / anchoPanel;
  const puestas = viajes
    .map((v) => ({ v, x: 4 + posicionEnRuta(v) * 92 }))
    .sort((a, b) => a.x - b.x)
    .map(({ v, x }) => {
      // Si no cabe en ninguna fila de su punto, se corre a la derecha hasta que haya lugar: las
      // unidades que están en el mismo punto quedan juntas, sin montarse.
      let px = x;
      let fila = -1;
      for (let intento = 0; intento < 40 && fila < 0; intento++) {
        fila = orden.find((o) => px - ultimo[o] >= (ancho(v) + anchoDe[o]) / 2 + 0.6) ?? -1;
        if (fila < 0) px += 1.2;
      }
      if (fila < 0) fila = orden[0];
      ultimo[fila] = px;
      anchoDe[fila] = ancho(v);
      return { v, x: Math.min(px, 97), fila };
    });
  return (
    <div className="absolute inset-0">
      {[
        ["Salida", "4%"],
        ["Destino", "50%"],
        ["Regreso", "96%"],
      ].map(([t, l]) => (
        <span
          key={t}
          className="absolute top-1.5 -translate-x-1/2 text-[10px] uppercase tracking-[.14em] text-slate-400"
          style={{ left: l }}
        >
          {t}
        </span>
      ))}
      {puestas.map(({ v, x, fila }) => {
        const cat = categoriaDe(v);
        const estado = estadoDelViaje(paradasDelViaje(v), v.descansos)?.texto ?? "";
        return (
          <button
            key={v.id}
            onClick={() => onElegir(v.id)}
            aria-label={`Ver ${unidadLabel(v)} en su Control TV`}
            title={`${unidadLabel(v)} · ${v.conductor_nombre ?? "sin conductor"} · ${v.equipo_tipo ?? "Otro"} · ${estado}`}
            className={`absolute grid h-[24px] -translate-x-1/2 -translate-y-1/2 place-items-center rounded-lg px-1.5 cursor-pointer hover:bg-white/15 hover:z-10 ${
              cat === "detenida" ? "animate-pulse motion-reduce:animate-none" : ""
            }`}
            style={{
              left: `${x.toFixed(2)}%`,
              top: `${(9 + ((fila + 0.5) / filas) * 88).toFixed(2)}%`,
              color: COLOR[cat],
            }}
          >
            <IconoTipo tipo={v.equipo_tipo} alto={ALTO_FICHA} />
          </button>
        );
      })}
      <p className="absolute bottom-12 right-3 hidden text-[11px] text-slate-400 min-[900px]:block">
        Posición estimada por las marcas · con GPS será la real
      </p>
    </div>
  );
}
