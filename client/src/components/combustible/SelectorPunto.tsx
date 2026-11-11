// Pone el punto de un lugar tocando el mapa del Perú (dibujado, sin internet). Es aproximado: para un
// punto exacto se pega la coordenada. Los puntitos son la tierra y las líneas, los departamentos.
import { useEffect, useRef } from "react";

import { aPixeles, aPunto, CAJA_PERU, type Punto } from "./coordenadasLogica";
import { PERU_DEPARTAMENTOS, type DepartamentoPeru } from "./peruDepartamentos";

const anillos = (d: DepartamentoPeru): number[][][] =>
  d.t === "Polygon" ? (d.c as number[][][]) : (d.c as number[][][][]).flat();

export function SelectorPunto({
  punto,
  onElegir,
}: {
  punto: Punto | null;
  onElegir: (p: Punto) => void;
}) {
  const lienzo = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const c = lienzo.current;
    if (!c) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = c.clientWidth;
    const H = c.clientHeight;
    c.width = W * dpr;
    c.height = H * dpr;
    const x = c.getContext("2d");
    if (!x) return;
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, W, H);
    const trazo = (ctx: CanvasRenderingContext2D) =>
      PERU_DEPARTAMENTOS.forEach((d) => {
        ctx.beginPath();
        anillos(d).forEach((r) =>
          r.forEach((p, i) => {
            const q = aPixeles({ lat: p[1], lon: p[0] }, W, H);
            if (i) ctx.lineTo(q.x, q.y);
            else ctx.moveTo(q.x, q.y);
          })
        );
      });
    // Tierra en puntitos, sobre una máscara de los polígonos.
    const m = document.createElement("canvas");
    m.width = W;
    m.height = H;
    const mx = m.getContext("2d");
    if (!mx) return;
    mx.fillStyle = "#fff";
    PERU_DEPARTAMENTOS.forEach((d) => {
      mx.beginPath();
      anillos(d).forEach((r) =>
        r.forEach((p, i) => {
          const q = aPixeles({ lat: p[1], lon: p[0] }, W, H);
          if (i) mx.lineTo(q.x, q.y);
          else mx.moveTo(q.x, q.y);
        })
      );
      mx.fill();
    });
    const datos = mx.getImageData(0, 0, W, H).data;
    x.fillStyle = "rgba(244,241,234,.4)";
    for (let y = 4; y < H; y += 8) {
      for (let px = 4; px < W; px += 8) {
        if (datos[(Math.floor(y) * W + Math.floor(px)) * 4 + 3] < 128) continue;
        x.beginPath();
        x.arc(px, y, 1, 0, Math.PI * 2);
        x.fill();
      }
    }
    x.strokeStyle = "rgba(233,200,147,.30)";
    x.lineWidth = 0.7;
    trazo(x);
    PERU_DEPARTAMENTOS.forEach((d) => {
      x.beginPath();
      anillos(d).forEach((r) =>
        r.forEach((p, i) => {
          const q = aPixeles({ lat: p[1], lon: p[0] }, W, H);
          if (i) x.lineTo(q.x, q.y);
          else x.moveTo(q.x, q.y);
        })
      );
      x.stroke();
    });
    if (punto) {
      const q = aPixeles(punto, W, H);
      x.fillStyle = "rgba(186,220,30,.25)";
      x.beginPath();
      x.arc(q.x, q.y, 11, 0, Math.PI * 2);
      x.fill();
      x.fillStyle = "#BADC1E";
      x.strokeStyle = "#fff";
      x.lineWidth = 1.5;
      x.beginPath();
      x.arc(q.x, q.y, 4.5, 0, Math.PI * 2);
      x.fill();
      x.stroke();
    }
  }, [punto]);

  return (
    <canvas
      ref={lienzo}
      role="img"
      aria-label="Mapa del Perú: toca para marcar el punto del lugar"
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onElegir(aPunto(e.clientX - r.left, e.clientY - r.top, r.width, r.height));
      }}
      className="h-[300px] w-full cursor-crosshair rounded-xl border border-white/10 bg-[#0a0a0a]"
      style={{
        aspectRatio: `${CAJA_PERU.lon1 - CAJA_PERU.lon0} / ${CAJA_PERU.lat1 - CAJA_PERU.lat0}`,
      }}
    />
  );
}
