// El mapa satélite del Control TV (segunda opción del mapa digital): la misma ruta y las mismas
// unidades sobre la imagen satelital de Esri, con Leaflet. Necesita internet para bajar las imágenes;
// si no hay, avisa y se vuelve a «Digital». Se carga solo cuando alguien lo pide (no pesa al abrir).
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useRef, useState } from "react";

import { svgDeTipo } from "./iconosCanvas";
import { escaparHtml, type PosicionMapa, type Punto } from "./mapaLogica";
import { anchoDeIcono } from "./tiposUnidad";

export interface UnidadSatelite {
  id: string;
  placa: string;
  conductor: string;
  ruta: string;
  color: string;
  /** El tipo de unidad, para dibujar su avatar. */
  tipo: string | null;
  pos: PosicionMapa | null;
}

export interface LugarSatelite {
  id: string;
  nombre: string;
  punto: Punto;
  /** El pin de GPS va en el origen y en el destino; una parada es un punto chico. */
  papel: "origen" | "destino" | "parada";
}

const TILES =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const ATRIBUCION = "Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics";

/** El pin de GPS (la punta queda en el lugar): ámbar en la salida, verde en la llegada. */
function pinDe(papel: "origen" | "destino"): L.DivIcon {
  const col = papel === "origen" ? "#fbbf24" : "#34d399";
  return L.divIcon({
    className: "",
    iconSize: [22, 28],
    iconAnchor: [11, 27],
    html: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="22" height="28" fill="rgba(6,12,13,.92)" stroke="${col}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="filter:drop-shadow(0 0 4px ${col})"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3" fill="${col}" stroke="none"/></svg>`,
  });
}

/** El avatar de la unidad: el ícono de su tipo, del color de su estado, en una cápsula oscura. */
function avatarDe(u: UnidadSatelite, elegida: boolean): L.DivIcon {
  const alto = 8;
  const w = Math.round(anchoDeIcono(u.tipo, alto));
  const ancho = w + 8;
  return L.divIcon({
    className: "",
    iconSize: [ancho, 13],
    iconAnchor: [ancho / 2, 6.5],
    html: `<div style="width:${ancho}px;height:13px;display:grid;place-items:center;border-radius:5px;background:rgba(6,12,13,.92);border:${elegida ? 1.5 : 1}px solid ${elegida ? "#fff" : u.color};box-sizing:border-box">${svgDeTipo(u.tipo, u.color, alto)}</div>`,
  });
}

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
      const marca =
        l.papel === "parada"
          ? L.circleMarker([l.punto.lat, l.punto.lon], {
              radius: 3.5,
              color: "#BADC1E",
              weight: 1.5,
              fillColor: "#fbffe0",
              fillOpacity: 1,
            })
          : L.marker([l.punto.lat, l.punto.lon], { icon: pinDe(l.papel), keyboard: false });
      marca
        .bindTooltip(escaparHtml(l.nombre), {
          permanent: true,
          direction: "right",
          offset: [l.papel === "parada" ? 6 : 10, l.papel === "parada" ? 0 : -12],
          className: "etq-lugar",
        })
        .addTo(g);
    }
    for (const u of unidades) {
      if (!u.pos) continue;
      const marca = L.marker([u.pos.punto.lat, u.pos.punto.lon], {
        icon: avatarDe(u, elegida === u.id),
        keyboard: false,
      });
      marca
        .bindTooltip(
          `<b>${escaparHtml(u.placa)}</b> · ${escaparHtml(u.conductor)}<small>${escaparHtml(u.ruta)}</small>`,
          {
            permanent: elegida === u.id,
            direction: "top",
            offset: [0, -9],
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
