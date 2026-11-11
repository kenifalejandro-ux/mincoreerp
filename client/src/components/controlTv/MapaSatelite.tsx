// El mapa satélite del Control TV (segunda opción del mapa digital): la misma ruta y las mismas
// unidades sobre la imagen satelital de Esri, con Leaflet. Necesita internet para bajar las imágenes;
// si no hay, avisa y se vuelve a «Digital». Se carga solo cuando alguien lo pide (no pesa al abrir).
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useRef, useState } from "react";

import { escaparHtml, type PosicionMapa, type Punto } from "./mapaLogica";

export interface UnidadSatelite {
  id: string;
  placa: string;
  conductor: string;
  ruta: string;
  color: string;
  pos: PosicionMapa | null;
}

export interface LugarSatelite {
  id: string;
  nombre: string;
  punto: Punto;
}

const TILES =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const ATRIBUCION = "Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics";

export default function MapaSatelite({
  unidades,
  lugares,
  rutas,
  elegida,
  onElegir,
}: {
  unidades: UnidadSatelite[];
  lugares: LugarSatelite[];
  /** Cada tramo de cada viaje como una lista de puntos. */
  rutas: Punto[][];
  elegida: string | null;
  onElegir: (id: string) => void;
}) {
  const contenedor = useRef<HTMLDivElement>(null);
  const mapa = useRef<L.Map | null>(null);
  const capa = useRef<L.LayerGroup | null>(null);
  const encuadrado = useRef(false);
  const [sinImagenes, setSinImagenes] = useState(false);

  // El mapa se crea una vez y se destruye al salir.
  useEffect(() => {
    const el = contenedor.current;
    if (!el) return;
    const m = L.map(el, { zoomControl: true, attributionControl: true, zoomSnap: 0.5 });
    const tiles = L.tileLayer(TILES, { attribution: ATRIBUCION, maxZoom: 16 }).addTo(m);
    // Si las imágenes no llegan (sin internet), se avisa en vez de dejar un cuadro gris.
    let fallos = 0;
    tiles.on("tileerror", () => {
      fallos += 1;
      if (fallos >= 3) setSinImagenes(true);
    });
    tiles.on("tileload", () => {
      fallos = 0;
      setSinImagenes(false);
    });
    m.setView([-7.4, -77.4], 6);
    capa.current = L.layerGroup().addTo(m);
    mapa.current = m;
    // Si el contenedor cambia de tamaño (pantalla completa), Leaflet tiene que enterarse.
    const o = new ResizeObserver(() => m.invalidateSize());
    o.observe(el);
    return () => {
      o.disconnect();
      m.remove();
      mapa.current = null;
      capa.current = null;
      encuadrado.current = false;
    };
  }, []);

  // Las rutas, los lugares y las unidades se redibujan cuando cambian los datos.
  useEffect(() => {
    const m = mapa.current;
    const g = capa.current;
    if (!m || !g) return;
    g.clearLayers();
    for (const r of rutas) {
      const puntos = r.map((p) => [p.lat, p.lon] as L.LatLngTuple);
      L.polyline(puntos, { color: "#BADC1E", weight: 7, opacity: 0.18, interactive: false }).addTo(
        g
      );
      L.polyline(puntos, {
        color: "#d4f25a",
        weight: 2.4,
        opacity: 0.95,
        interactive: false,
      }).addTo(g);
    }
    for (const l of lugares) {
      L.circleMarker([l.punto.lat, l.punto.lon], {
        radius: 5,
        color: "#BADC1E",
        weight: 2,
        fillColor: "#fbffe0",
        fillOpacity: 1,
      })
        .bindTooltip(escaparHtml(l.nombre), {
          permanent: true,
          direction: "right",
          offset: [8, 0],
          className: "etq-lugar",
        })
        .addTo(g);
    }
    for (const u of unidades) {
      if (!u.pos) continue;
      const marca = L.circleMarker([u.pos.punto.lat, u.pos.punto.lon], {
        radius: elegida === u.id ? 9 : 7,
        color: "#fff",
        weight: elegida === u.id ? 3 : 1.5,
        fillColor: u.color,
        fillOpacity: 1,
      });
      marca
        .bindTooltip(
          `<b>${escaparHtml(u.placa)}</b> · ${escaparHtml(u.conductor)}<small>${escaparHtml(u.ruta)}</small>`,
          {
            permanent: elegida === u.id,
            direction: "top",
            offset: [0, -8],
            className: "etq-unidad",
          }
        )
        .on("click", () => onElegir(u.id))
        .addTo(g);
    }
    // Se encuadra una sola vez, con lo que haya; después el usuario mueve el mapa a su gusto.
    if (!encuadrado.current) {
      const todos: L.LatLngTuple[] = [
        ...lugares.map((l) => [l.punto.lat, l.punto.lon] as L.LatLngTuple),
        ...unidades
          .filter((u) => u.pos)
          .map((u) => [u.pos!.punto.lat, u.pos!.punto.lon] as L.LatLngTuple),
      ];
      if (todos.length > 0) {
        m.fitBounds(L.latLngBounds(todos), { padding: [48, 48], maxZoom: 11 });
        encuadrado.current = true;
      }
    }
  }, [unidades, lugares, rutas, elegida, onElegir]);

  // Al elegir una unidad en la lista, el mapa se centra en ella.
  useEffect(() => {
    const m = mapa.current;
    const u = unidades.find((x) => x.id === elegida);
    if (m && u?.pos)
      m.flyTo([u.pos.punto.lat, u.pos.punto.lon], Math.max(m.getZoom(), 9), { duration: 0.6 });
    // Solo cuando cambia la elegida, no cuando se refrescan los datos.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elegida]);

  return (
    <div className="relative h-full w-full">
      <style>{`
        .etq-lugar.leaflet-tooltip{background:transparent;border:0;box-shadow:none;color:#fff;font:800 12px Inter,system-ui,sans-serif;letter-spacing:.05em;text-transform:uppercase;text-shadow:0 0 4px #000,0 0 8px #000;padding:0}
        .etq-lugar.leaflet-tooltip:before{display:none}
        .etq-unidad.leaflet-tooltip{background:rgba(6,12,13,.88);border:1px solid rgba(186,220,30,.7);border-radius:7px;box-shadow:none;color:#fff;font:600 10.5px Inter,system-ui,sans-serif;padding:3px 7px;line-height:1.3;white-space:nowrap}
        .etq-unidad.leaflet-tooltip:before{display:none}
        .etq-unidad small{display:block;color:rgb(186,220,30);font-size:9.5px}
      `}</style>
      <div ref={contenedor} className="h-full w-full" style={{ background: "#060c0d" }} />
      {sinImagenes && (
        <p
          role="status"
          className="absolute inset-x-4 top-3 z-[500] rounded-lg border border-amber-400/30 bg-black/75 p-2 text-xs text-amber-200"
        >
          No se pudieron bajar las imágenes del satélite. Revisa la conexión o vuelve a «Digital»,
          que funciona sin internet.
        </p>
      )}
    </div>
  );
}
