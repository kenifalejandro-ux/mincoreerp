// El tablero de un viaje: quién maneja, qué unidad, por dónde va, cuánto lleva
// cargado y cuándo llega, comparado con lo que suele tomar esa ruta. Se
// actualiza solo mientras está abierto.
import { Droplets, Flag, Fuel, Gauge, MapPin, Play, Timer } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { BarraRuta, LineaTiempo, TarjetaViaje, Tile, type CargaViaje } from "./PiezasViaje";
import { duracion, fmt, ruta, unidadLabel, type FilaViaje, type Producto } from "./viajesFormato";
import { apiFetch } from "../../services/apiClient";
import VentanaFlotante from "../comunes/VentanaFlotante";

interface EstadisticasRuta {
  viajes: number;
  duracion_min: number | null;
  combustible_gal: number | null;
  urea_l: number | null;
}

interface Detalle {
  viaje: FilaViaje;
  cargas: CargaViaje[];
  ruta: EstadisticasRuta;
}

const LITROS_POR_GALON = 3.785411784;

/** "+12% vs. ruta" en color: rojo si se pasa de 20%. */
function Comparacion({ valor, promedio }: { valor: number; promedio: number | null }) {
  if (!promedio) return null;
  const pct = ((valor - promedio) / promedio) * 100;
  const color = pct > 20 ? "text-red-400" : pct < -5 ? "text-emerald-400" : "text-[#94a3b8]";
  return (
    <span className={`text-xs ${color}`}>
      {pct > 0 ? "+" : ""}
      {fmt(pct, 0)}% vs. ruta
    </span>
  );
}

export function DetalleViajeVentana({
  viajeId,
  onCerrar,
}: {
  viajeId: string;
  onCerrar: () => void;
}) {
  const [datos, setDatos] = useState<Detalle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ahora, setAhora] = useState(() => Date.now());

  const cargar = useCallback(async () => {
    const res = await apiFetch(`/api/erp/combustible/viajes/${viajeId}`);
    const body = await res.json().catch(() => null);
    if (!res.ok) setError(body?.error ?? "No se pudo cargar el viaje.");
    else {
      setError(null);
      setDatos(body);
    }
  }, [viajeId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void cargar();
    const es = new EventSource("/api/eventos/stream", { withCredentials: true });
    const refrescar = () => void cargar();
    es.addEventListener("combustible.viaje_actualizado", refrescar);
    es.addEventListener("combustible.despacho_creado", refrescar);
    es.addEventListener("combustible.despacho_anulado", refrescar);
    const reloj = window.setInterval(() => setAhora(Date.now()), 30_000);
    return () => {
      es.close();
      window.clearInterval(reloj);
    };
  }, [cargar]);

  const v = datos?.viaje;
  const enCurso = v?.estado === "en_curso";
  const medidor = v?.tipo_medidor === "horometro" ? "h" : "km";
  const etiquetaMedidor = v?.tipo_medidor === "horometro" ? "Horómetro" : "Odómetro";

  const litros = (p: Producto) =>
    (datos?.cargas ?? [])
      .filter((c) => c.producto === p)
      .reduce((s, c) => s + Number(c.cantidad) * (c.unidad === "gal" ? LITROS_POR_GALON : 1), 0);
  const combustibleGal = litros("combustible") / LITROS_POR_GALON;
  const ureaL = litros("urea");
  const cuenta = Number(v?.cuenta_como ?? 1) || 1;

  // Duración: la real si cerró, la transcurrida si va en ruta.
  const inicio = v?.inicio_en ? Date.parse(v.inicio_en) : null;
  const fin = v?.fin_en ? Date.parse(v.fin_en) : null;
  const minutos = inicio ? ((fin ?? ahora) - inicio) / 60_000 : null;
  const esperado = datos?.ruta.duracion_min ?? null;
  const progreso =
    v?.estado === "cerrado"
      ? 100
      : minutos !== null && esperado
        ? Math.min(100, (minutos / esperado) * 100)
        : 0;
  const llegadaEstimada = inicio && esperado ? inicio + esperado * 60_000 : null;
  const demora =
    enCurso && minutos !== null && esperado && minutos > esperado ? minutos - esperado : 0;

  const historial =
    datos && datos.ruta.viajes > 0
      ? `según ${datos.ruta.viajes} viaje${datos.ruta.viajes === 1 ? "" : "s"} de esta ruta`
      : "sin historial de esta ruta todavía";

  return (
    <VentanaFlotante
      id={`combustible-viaje-${viajeId}`}
      titulo={v ? `Viaje V-${v.numero} · ${ruta(v)}` : "Viaje"}
      subtitulo={v ? unidadLabel(v) : undefined}
      onCerrar={onCerrar}
      anchoInicial={820}
      altoInicial={640}
    >
      {error && <p className="p-4 text-sm text-red-400">{error}</p>}
      {datos && v && (
        <div className="p-4 space-y-4">
          <TarjetaViaje
            v={v}
            textoEstado={
              enCurso
                ? "En ruta · en vivo"
                : v.estado === "programado"
                  ? "Programado"
                  : v.estado === "anulado"
                    ? "Anulado"
                    : "Llegó"
            }
            hijos={
              <BarraRuta
                origen={v.origen}
                destino={v.destino}
                tipoUnidad={v.equipo_tipo}
                inicio={v.inicio_en}
                fin={v.fin_en}
                progreso={progreso}
                demora={demora}
                llegadaEstimada={llegadaEstimada}
                esperadoMin={esperado}
                ahora={ahora}
                nota={historial}
              />
            }
          />

          {/* ── Los números del viaje ── */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Tile
              icono={<Timer className="w-4 h-4" />}
              titulo={enCurso ? "En ruta" : "Duración"}
              valor={minutos !== null ? duracion(minutos) : "—"}
              pie={esperado ? <span>promedio {duracion(esperado)}</span> : undefined}
            />
            <Tile
              icono={<Fuel className="w-4 h-4" />}
              titulo="Combustible"
              valor={`${fmt(combustibleGal, 1)} gal`}
              pie={
                <>
                  {datos.ruta.combustible_gal !== null && (
                    <span>prom. {fmt(datos.ruta.combustible_gal, 1)}</span>
                  )}
                  {v.estado === "cerrado" && (
                    <Comparacion
                      valor={combustibleGal / cuenta}
                      promedio={datos.ruta.combustible_gal}
                    />
                  )}
                </>
              }
            />
            <Tile
              icono={<Droplets className="w-4 h-4" />}
              titulo="Urea"
              valor={`${fmt(ureaL, 1)} L`}
              acento="text-sky-400"
              pie={datos.ruta.urea_l ? <span>prom. {fmt(datos.ruta.urea_l, 1)} L</span> : undefined}
            />
            <Tile
              icono={<Gauge className="w-4 h-4" />}
              titulo={etiquetaMedidor}
              valor={
                v.recorrido
                  ? `${fmt(Number(v.recorrido), 1)} ${medidor}`
                  : v.medidor_inicio
                    ? `${fmt(Number(v.medidor_inicio), 1)}`
                    : "—"
              }
              pie={
                v.medidor_inicio ? (
                  <span>
                    {fmt(Number(v.medidor_inicio), 1)} →{" "}
                    {v.medidor_fin ? fmt(Number(v.medidor_fin), 1) : "…"}
                    {v.recorrido_sin_viaje && Number(v.recorrido_sin_viaje) > 0
                      ? ` · ${fmt(Number(v.recorrido_sin_viaje), 1)} ${medidor} fuera de viaje`
                      : ""}
                  </span>
                ) : undefined
              }
            />
          </div>

          {(v.ruta_por_confirmar || v.estado === "anulado") && (
            <div className="rounded-xl bg-amber-500/10 border border-amber-500/30 p-3 text-sm text-amber-200">
              {v.estado === "anulado"
                ? `Anulado: ${v.motivo_anulacion ?? ""}`
                : `Ruta por confirmar${v.nota_ruta ? `: ${v.nota_ruta}` : ""}. No entra a los promedios hasta que la oficina la confirme.`}
            </div>
          )}

          <LineaTiempo
            origen={v.origen}
            destino={v.destino}
            inicio={inicio}
            fin={fin}
            cargas={datos.cargas}
          />
        </div>
      )}
    </VentanaFlotante>
  );
}
