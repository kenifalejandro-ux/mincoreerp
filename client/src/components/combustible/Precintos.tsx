// Precintos numerados del tanque (migración 0095).
//
// Un precinto es un sello con un número impreso que, una vez cortado, no se
// vuelve a cerrar. El control está en anotar el número: si en la varilla el
// que se ve no es el registrado, alguien abrió el tanque sin registrarlo.
//
// Vive aparte del panel porque son tres piezas que se usan en tres lugares:
// la ventana de gestión (puntos, cambios, historial), los campos de la
// varilla y los de la recepción.
import { useEffect, useState } from "react";

import {
  leerError,
  puntosAVerificar,
  usePuntosPrecinto,
  type PrecintoVisto,
  type PuntoPrecinto,
} from "./precintosDatos";
import { apiFetch } from "../../services/apiClient";
import VentanaFlotante from "../comunes/VentanaFlotante";

interface FilaHistorialPrecinto {
  tipo: "colocacion" | "no_coincide";
  ocurrido_en: string;
  punto: string;
  numero: string | null;
  numero_esperado: string | null;
  motivo: string | null;
  recepcion_id: string | null;
  persona: string | null;
}

const fecha = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("es-PE", { dateStyle: "short", timeStyle: "short" }) : "—";

/** Campos de la varilla. No muestra el número registrado A PROPÓSITO: quien
 *  mide tiene que leer el sello, no copiar lo que la pantalla espera (la
 *  misma lección que la varilla exacta). */
export function CamposPrecintoVarilla({
  puntos,
  error,
  valores,
  onCambiar,
}: {
  puntos: PuntoPrecinto[] | null;
  error: string | null;
  valores: Record<number, PrecintoVisto>;
  onCambiar: (puntoId: number, v: PrecintoVisto) => void;
}) {
  if (error) {
    return (
      <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl p-3">
        Este tanque usa precintos y no se pudieron cargar sus puntos ({error}). Sin ellos la lectura
        se va a rechazar.
      </p>
    );
  }
  const aVerificar = puntosAVerificar(puntos);
  if (aVerificar.length === 0) return null;
  return (
    <fieldset className="space-y-3 border border-slate-200 rounded-xl p-4">
      <legend className="text-xs font-bold text-slate-700 uppercase px-1">
        Precintos que ves ahora
      </legend>
      {aVerificar.map((p) => {
        const v = valores[p.id] ?? { numero: "", sinPrecinto: false };
        return (
          <div key={p.id} className="space-y-1">
            <label htmlFor={`precinto-visto-${p.id}`} className="text-sm text-slate-700">
              {p.nombre}
            </label>
            <input
              id={`precinto-visto-${p.id}`}
              type="text"
              required={!v.sinPrecinto}
              disabled={v.sinPrecinto}
              className="w-full border border-slate-200 rounded-xl p-3 text-sm outline-none disabled:bg-slate-100"
              placeholder="Número impreso en el sello"
              value={v.numero}
              onChange={(e) => onCambiar(p.id, { ...v, numero: e.target.value })}
            />
            <label className="flex items-center gap-2 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={v.sinPrecinto}
                onChange={(e) => onCambiar(p.id, { numero: "", sinPrecinto: e.target.checked })}
              />
              No hay precinto
            </label>
          </div>
        );
      })}
    </fieldset>
  );
}

/** Campos de la recepción: el sello NUEVO de cada punto que se abre al
 *  recibir. */
export function CamposPrecintoRecepcion({
  puntos,
  error,
  valores,
  onCambiar,
}: {
  puntos: PuntoPrecinto[] | null;
  error: string | null;
  valores: Record<number, string>;
  onCambiar: (puntoId: number, numero: string) => void;
}) {
  if (error) {
    return <p className="text-sm text-red-600">No se pudieron cargar los precintos: {error}</p>;
  }
  const seAbren = (puntos ?? []).filter((p) => p.activo && p.se_abre_en_recepcion);
  if (seAbren.length === 0) return null;
  return (
    <fieldset className="space-y-3 border border-slate-200 rounded-xl p-4">
      <legend className="text-xs font-bold text-slate-700 uppercase px-1">
        Precinto nuevo al cerrar
      </legend>
      {seAbren.map((p) => (
        <div key={p.id} className="space-y-1">
          <label htmlFor={`precinto-nuevo-${p.id}`} className="text-sm text-slate-700">
            {p.nombre} <span className="text-slate-400">(se retira el {p.numero_vigente})</span>
          </label>
          <input
            id={`precinto-nuevo-${p.id}`}
            type="text"
            required
            className="w-full border border-slate-200 rounded-xl p-3 text-sm outline-none"
            placeholder="Número del sello que se coloca"
            value={valores[p.id] ?? ""}
            onChange={(e) => onCambiar(p.id, e.target.value)}
          />
        </div>
      ))}
    </fieldset>
  );
}

/** La ventana de gestión: puntos con su sello vigente, alta, cambio fuera de
 *  una recepción, baja e historial. Los permisos los decide el servidor (el
 *  grifero no cambia sellos; solo admin da de alta o de baja): acá se muestra
 *  el error que devuelva. */
export function VentanaPrecintos({
  tanque,
  onCerrar,
}: {
  tanque: { id: number; codigo: string; tanque_nombre: string };
  onCerrar: () => void;
}) {
  const { puntos, error, recargar } = usePuntosPrecinto(tanque.id, true);
  const [historial, setHistorial] = useState<FilaHistorialPrecinto[] | null>(null);
  const [nuevo, setNuevo] = useState({ nombre: "", numero: "", seAbre: false });
  const [cambio, setCambio] = useState<{ puntoId: number; numero: string; motivo: string } | null>(
    null
  );
  const [enviando, setEnviando] = useState(false);

  const [vueltaHistorial, setVueltaHistorial] = useState(0);

  useEffect(() => {
    let vigente = true;
    (async () => {
      const res = await apiFetch(`/api/erp/combustible/${tanque.id}/precintos/historial`);
      // 403 para quien no es admin: la ventana sigue sirviendo sin historial.
      const filas = res.ok ? ((await res.json()) as FilaHistorialPrecinto[]) : null;
      if (vigente) setHistorial(filas);
    })();
    return () => {
      vigente = false;
    };
  }, [tanque.id, vueltaHistorial]);

  const refrescar = () => {
    recargar();
    setVueltaHistorial((v) => v + 1);
  };

  const crearPunto = async (e: React.FormEvent) => {
    e.preventDefault();
    if (enviando) return;
    setEnviando(true);
    try {
      const res = await apiFetch(`/api/erp/combustible/${tanque.id}/precintos/puntos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nombre: nuevo.nombre.trim(),
          numero: nuevo.numero.trim(),
          se_abre_en_recepcion: nuevo.seAbre,
        }),
      });
      if (!res.ok) {
        alert(await leerError(res, "No se pudo crear el punto."));
        return;
      }
      setNuevo({ nombre: "", numero: "", seAbre: false });
      refrescar();
    } finally {
      setEnviando(false);
    }
  };

  const guardarCambio = async (e: React.FormEvent) => {
    e.preventDefault();
    if (enviando || !cambio) return;
    setEnviando(true);
    try {
      const res = await apiFetch(
        `/api/erp/combustible/precintos/puntos/${cambio.puntoId}/cambios`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ numero: cambio.numero.trim(), motivo: cambio.motivo.trim() }),
        }
      );
      if (!res.ok) {
        alert(await leerError(res, "No se pudo registrar el cambio."));
        return;
      }
      setCambio(null);
      refrescar();
    } finally {
      setEnviando(false);
    }
  };

  const darDeBaja = async (p: PuntoPrecinto) => {
    const motivo = window.prompt(
      `Dar de baja "${p.nombre}" deja de vigilar ese punto y avisa a los administradores. ¿Por qué?`
    );
    if (!motivo?.trim()) return;
    const res = await apiFetch(`/api/erp/combustible/precintos/puntos/${p.id}/baja`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ motivo: motivo.trim() }),
    });
    if (!res.ok) {
      alert(await leerError(res, "No se pudo dar de baja."));
      return;
    }
    refrescar();
  };

  return (
    <VentanaFlotante
      id="combustible-precintos"
      titulo={`Precintos — ${tanque.codigo}`}
      subtitulo={tanque.tanque_nombre}
      onCerrar={onCerrar}
      anchoInicial={760}
      altoInicial={640}
    >
      <div className="p-6 space-y-6 overflow-auto">
        <p className="text-xs text-slate-500">
          Cada apertura del tanque tiene que quedar registrada como un cambio de precinto. La
          recepción lo registra sola en los puntos que se abren al recibir; cualquier otro cambio se
          anota acá, con motivo, y avisa a los administradores.
        </p>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <section>
          <h4 className="text-sm font-bold text-slate-700 uppercase tracking-wide mb-2">
            Puntos precintados
          </h4>
          {!puntos || puntos.length === 0 ? (
            <p className="text-sm text-slate-400">Este tanque todavía no tiene puntos.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-max text-sm border-collapse">
                <thead>
                  <tr className="text-left text-xs font-bold text-slate-700 uppercase border-b">
                    <th className="p-2">Punto</th>
                    <th className="p-2">Precinto vigente</th>
                    <th className="p-2">Desde</th>
                    <th className="p-2" />
                  </tr>
                </thead>
                <tbody>
                  {puntos.map((p) => (
                    <tr key={p.id} className={`border-b ${p.activo ? "" : "text-slate-400"}`}>
                      <td className="p-2">
                        <div className="font-medium">{p.nombre}</div>
                        <div className="text-[11px] text-slate-400">
                          {!p.activo
                            ? `Dado de baja: ${p.motivo_baja ?? ""}`
                            : p.se_abre_en_recepcion
                              ? "Se abre al recibir"
                              : "No se abre al recibir"}
                        </div>
                      </td>
                      <td className="p-2 font-mono">{p.numero_vigente ?? "—"}</td>
                      <td className="p-2">
                        <div>{fecha(p.colocado_en)}</div>
                        <div className="text-[11px] text-slate-400">
                          {p.colocado_por ?? ""} {p.motivo_vigente ? `· ${p.motivo_vigente}` : ""}
                        </div>
                      </td>
                      <td className="p-2 text-right whitespace-nowrap">
                        {p.activo && (
                          <>
                            <button
                              type="button"
                              onClick={() => setCambio({ puntoId: p.id, numero: "", motivo: "" })}
                              className="px-2 py-1 text-xs border border-slate-200 rounded-lg hover:bg-slate-50"
                            >
                              Cambiar
                            </button>{" "}
                            <button
                              type="button"
                              onClick={() => darDeBaja(p)}
                              className="px-2 py-1 text-xs text-red-600 border border-red-200 rounded-lg hover:bg-red-50"
                            >
                              Dar de baja
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {cambio && (
          <form
            onSubmit={guardarCambio}
            className="space-y-3 border border-amber-200 bg-amber-50 rounded-xl p-4"
          >
            <p className="text-sm text-amber-800">
              Cambio fuera de una recepción en{" "}
              <strong>{puntos?.find((p) => p.id === cambio.puntoId)?.nombre}</strong>. Queda como
              alerta y les llega un correo a los administradores.
            </p>
            <label htmlFor="precinto-cambio-numero" className="block text-xs font-bold uppercase">
              Número del precinto nuevo
            </label>
            <input
              id="precinto-cambio-numero"
              required
              className="w-full border border-slate-200 rounded-xl p-3 text-sm outline-none bg-white"
              value={cambio.numero}
              onChange={(e) => setCambio({ ...cambio, numero: e.target.value })}
            />
            <label htmlFor="precinto-cambio-motivo" className="block text-xs font-bold uppercase">
              Motivo
            </label>
            <input
              id="precinto-cambio-motivo"
              required
              className="w-full border border-slate-200 rounded-xl p-3 text-sm outline-none bg-white"
              placeholder="Ej.: se cortó para cambiar el filtro"
              value={cambio.motivo}
              onChange={(e) => setCambio({ ...cambio, motivo: e.target.value })}
            />
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={enviando}
                className="px-4 py-2 bg-slate-900 text-white text-sm rounded-lg disabled:opacity-50"
              >
                Registrar cambio
              </button>
              <button
                type="button"
                onClick={() => setCambio(null)}
                className="px-4 py-2 border border-slate-200 text-sm rounded-lg"
              >
                Cancelar
              </button>
            </div>
          </form>
        )}

        <form onSubmit={crearPunto} className="space-y-3 border border-slate-200 rounded-xl p-4">
          <h4 className="text-sm font-bold text-slate-700 uppercase tracking-wide">
            Agregar un punto
          </h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <label htmlFor="precinto-punto-nombre" className="text-xs font-bold uppercase">
                Dónde
              </label>
              <input
                id="precinto-punto-nombre"
                required
                maxLength={60}
                className="w-full border border-slate-200 rounded-xl p-3 text-sm outline-none"
                placeholder="Boca de llenado, drenaje..."
                value={nuevo.nombre}
                onChange={(e) => setNuevo({ ...nuevo, nombre: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="precinto-punto-numero" className="text-xs font-bold uppercase">
                Número del precinto colocado
              </label>
              <input
                id="precinto-punto-numero"
                required
                maxLength={40}
                className="w-full border border-slate-200 rounded-xl p-3 text-sm outline-none"
                value={nuevo.numero}
                onChange={(e) => setNuevo({ ...nuevo, numero: e.target.value })}
              />
            </div>
          </div>
          <label className="flex items-start gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              className="mt-1"
              checked={nuevo.seAbre}
              onChange={(e) => setNuevo({ ...nuevo, seAbre: e.target.checked })}
            />
            <span>
              Se abre en cada recepción
              <span className="block text-xs text-slate-500">
                La recepción va a exigir el número del precinto nuevo de este punto.
              </span>
            </span>
          </label>
          <button
            type="submit"
            disabled={enviando}
            className="px-4 py-2 bg-slate-900 text-white text-sm rounded-lg disabled:opacity-50"
          >
            Agregar punto
          </button>
        </form>

        {historial && (
          <section>
            <h4 className="text-sm font-bold text-slate-700 uppercase tracking-wide mb-2">
              Historial
            </h4>
            {historial.length === 0 ? (
              <p className="text-sm text-slate-400">Sin movimientos.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-max text-sm border-collapse">
                  <thead>
                    <tr className="text-left text-xs font-bold text-slate-700 uppercase border-b">
                      <th className="p-2">Cuándo</th>
                      <th className="p-2">Punto</th>
                      <th className="p-2">Qué pasó</th>
                      <th className="p-2">Quién</th>
                    </tr>
                  </thead>
                  <tbody>
                    {historial.map((h, i) => (
                      <tr
                        key={`${h.tipo}-${h.ocurrido_en}-${i}`}
                        className={`border-b ${h.tipo === "no_coincide" ? "text-red-700" : ""}`}
                      >
                        <td className="p-2 whitespace-nowrap">{fecha(h.ocurrido_en)}</td>
                        <td className="p-2">{h.punto}</td>
                        <td className="p-2">
                          {h.tipo === "colocacion"
                            ? `Se colocó el ${h.numero} · ${h.motivo ?? ""}`
                            : h.numero === null
                              ? `Varilla: no había precinto (registrado ${h.numero_esperado})`
                              : `Varilla: se vio el ${h.numero}, registrado ${h.numero_esperado}`}
                        </td>
                        <td className="p-2">{h.persona ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}
      </div>
    </VentanaFlotante>
  );
}
