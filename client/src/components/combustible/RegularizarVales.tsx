// Regularizar los vales que faltan del talonario: cada tramo abre sus vales uno por uno, cada uno con
// su casilla y su botón «Regularizar», y la barra de abajo regulariza los marcados con un mismo motivo.
// Es una explicación, no un borrado: el kardex sigue mostrando el salto. Un vale que sí despachó
// combustible no se regulariza, se registra como despacho. Necesita conexión: el servidor comprueba
// que esos números no tengan vale, y sin señal no se guarda nada en silencio.
import { useState } from "react";

import { apiFetch } from "../../services/apiClient";
import { mensajeDeError } from "../../utils/mensajeDeError";
import {
  MOTIVOS_BAJA,
  fechaCorta,
  rangoTexto,
  textoBaja,
  textoVecinos,
  valeTexto,
  type SerieTalonario,
  type TramoFaltante,
} from "./valesFaltantesLogica";

/** Manda la regularización. Devuelve el texto del error, o null si salió bien. */
async function regularizarVales(
  serie: string,
  numeros: number[],
  motivo: string,
  detalle: string
): Promise<string | null> {
  if (!motivo) return "Elige un motivo.";
  if (motivo === "otro" && !detalle.trim()) return "Con «Otro» el detalle es obligatorio.";
  try {
    const res = await apiFetch("/api/erp/combustible/despachos/talonarios/bajas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serie,
        numeros,
        motivo,
        ...(detalle.trim() ? { detalle: detalle.trim() } : {}),
      }),
    });
    if (res.ok) return null;
    return mensajeDeError(await res.json().catch(() => ({})), "No se pudo regularizar.");
  } catch {
    return "Sin conexión: regularizar necesita señal. Inténtalo de nuevo cuando vuelva.";
  }
}

function CamposDeMotivo({
  motivo,
  detalle,
  onMotivo,
  onDetalle,
  id,
}: {
  motivo: string;
  detalle: string;
  onMotivo: (v: string) => void;
  onDetalle: (v: string) => void;
  id: string;
}) {
  return (
    <>
      <label className="flex flex-col gap-1 text-xs font-bold uppercase text-slate-600">
        Motivo
        <select
          id={`${id}-motivo`}
          className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm font-normal normal-case"
          value={motivo}
          onChange={(e) => onMotivo(e.target.value)}
        >
          <option value="">Elige un motivo</option>
          {MOTIVOS_BAJA.map((m) => (
            <option key={m.valor} value={m.valor}>
              {m.texto}
            </option>
          ))}
        </select>
      </label>
      <label className="flex min-w-[200px] flex-1 flex-col gap-1 text-xs font-bold uppercase text-slate-600">
        Detalle {motivo === "otro" ? "(obligatorio)" : "(opcional)"}
        <input
          id={`${id}-detalle`}
          type="text"
          maxLength={300}
          className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm font-normal normal-case"
          value={detalle}
          onChange={(e) => onDetalle(e.target.value)}
        />
      </label>
    </>
  );
}

/** Los tramos de una serie, cada uno con sus vales. `seleccion` son los vales marcados. */
export function TramosRegularizables({
  serie,
  puedeRegularizar,
  seleccion,
  onSeleccion,
  onCambio,
}: {
  serie: SerieTalonario;
  puedeRegularizar: boolean;
  seleccion: number[];
  onSeleccion: (numeros: number[]) => void;
  onCambio: () => void;
}) {
  const [uno, setUno] = useState<number | null>(null);
  const [motivo, setMotivo] = useState("");
  const [detalle, setDetalle] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const marcados = new Set(seleccion);

  const alternar = (n: number) =>
    onSeleccion(marcados.has(n) ? seleccion.filter((x) => x !== n) : [...seleccion, n]);

  const alternarTramo = (t: TramoFaltante) => {
    const pendientes = t.vales.filter((v) => !v.baja).map((v) => v.n);
    const todos = pendientes.every((n) => marcados.has(n));
    onSeleccion(
      todos
        ? seleccion.filter((n) => !pendientes.includes(n))
        : [...new Set([...seleccion, ...pendientes])]
    );
  };

  const abrirUno = (n: number) => {
    setUno(n);
    setMotivo("");
    setDetalle("");
    setError(null);
  };

  const confirmarUno = async () => {
    if (uno === null) return;
    setEnviando(true);
    const fallo = await regularizarVales(serie.serie, [uno], motivo, detalle);
    setEnviando(false);
    if (fallo) return setError(fallo);
    setUno(null);
    onCambio();
  };

  return (
    <div className="space-y-3">
      {serie.tramos.map((t) => {
        const pendientes = t.vales.filter((v) => !v.baja);
        const todos = pendientes.length > 0 && pendientes.every((v) => marcados.has(v.n));
        return (
          <section key={t.desde} className="overflow-hidden rounded-lg border border-slate-200">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-slate-50 px-3 py-2">
              {puedeRegularizar && pendientes.length > 0 && (
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={todos}
                  onChange={() => alternarTramo(t)}
                  aria-label={`Marcar todo el tramo ${rangoTexto(t)}`}
                />
              )}
              <span className="font-mono font-semibold text-slate-800">{rangoTexto(t)}</span>
              <span className="text-xs text-slate-500">
                ({t.cantidad === 1 ? "1 vale" : `${t.cantidad} vales`} · {t.explicados}{" "}
                regularizados)
              </span>
              <span className="flex-1" />
              {pendientes.length === 0 ? (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
                  Tramo regularizado
                </span>
              ) : (
                <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">
                  {pendientes.length} sin explicar
                </span>
              )}
            </div>
            <p className="border-t border-slate-100 px-3 py-1.5 text-xs text-slate-500">
              {textoVecinos(serie.serie, t, fechaCorta)}
            </p>
            <ul className="max-h-64 divide-y divide-slate-100 overflow-y-auto border-t border-slate-100">
              {t.vales.map((v) => (
                <li key={v.n}>
                  <div className="grid grid-cols-[1.5rem_8rem_minmax(0,1fr)_auto] items-center gap-2 px-3 py-1.5 text-sm">
                    {puedeRegularizar && !v.baja ? (
                      <input
                        type="checkbox"
                        className="h-4 w-4"
                        checked={marcados.has(v.n)}
                        onChange={() => alternar(v.n)}
                        aria-label={`Marcar el vale ${valeTexto(serie.serie, v.n)}`}
                      />
                    ) : (
                      <span />
                    )}
                    <span className="font-mono">{valeTexto(serie.serie, v.n)}</span>
                    {v.baja ? (
                      <span className="min-w-0 text-xs text-slate-500">
                        <span className="mr-1 rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-800">
                          Regularizado
                        </span>
                        {textoBaja(v.baja, fechaCorta)}
                      </span>
                    ) : (
                      <span>
                        <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">
                          Sin explicar
                        </span>
                      </span>
                    )}
                    {!v.baja &&
                      (puedeRegularizar ? (
                        <button
                          onClick={() => abrirUno(v.n)}
                          className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                        >
                          Regularizar
                        </button>
                      ) : (
                        <span className="text-xs text-slate-400">Solo lectura</span>
                      ))}
                  </div>
                  {uno === v.n && (
                    <div className="flex flex-wrap items-end gap-2 bg-slate-50 px-3 py-2.5 pl-12">
                      <CamposDeMotivo
                        id={`reg-${v.n}`}
                        motivo={motivo}
                        detalle={detalle}
                        onMotivo={setMotivo}
                        onDetalle={setDetalle}
                      />
                      <button
                        onClick={confirmarUno}
                        disabled={enviando}
                        className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
                      >
                        {enviando ? "Guardando..." : "Confirmar"}
                      </button>
                      <button
                        onClick={() => setUno(null)}
                        disabled={enviando}
                        className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-white"
                      >
                        Cancelar
                      </button>
                      {error && <p className="basis-full text-xs text-red-600">{error}</p>}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      <p className="text-xs text-slate-500">
        «Registrado por» es quien guardó el vale de al lado: no prueba quién tenía el que falta. Un
        vale que sí despachó combustible no se regulariza: se registra como despacho.
      </p>
    </div>
  );
}

/** La barra de abajo: regulariza todos los vales marcados con un mismo motivo. */
export function BarraRegularizar({
  serie,
  numeros,
  onQuitar,
  onHecha,
}: {
  serie: string;
  numeros: number[];
  onQuitar: () => void;
  onHecha: () => void;
}) {
  const [motivo, setMotivo] = useState("");
  const [detalle, setDetalle] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirmar = async () => {
    setEnviando(true);
    setError(null);
    const fallo = await regularizarVales(serie, numeros, motivo, detalle);
    setEnviando(false);
    if (fallo) return setError(fallo);
    setMotivo("");
    setDetalle("");
    onHecha();
  };

  return (
    <div className="sticky bottom-0 -mx-6 -mb-4 flex flex-wrap items-end gap-3 border-t-2 border-lime-400 bg-white px-6 py-3 shadow-[0_-4px_12px_rgba(0,0,0,0.08)]">
      <span className="self-center font-bold text-slate-800">
        {numeros.length === 1 ? "1 vale seleccionado" : `${numeros.length} vales seleccionados`}
      </span>
      <CamposDeMotivo
        id="reg-masiva"
        motivo={motivo}
        detalle={detalle}
        onMotivo={setMotivo}
        onDetalle={setDetalle}
      />
      <button
        onClick={confirmar}
        disabled={enviando}
        className="rounded-lg bg-lime-400 px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-lime-300 disabled:opacity-50"
      >
        {enviando ? "Guardando..." : "Regularizar seleccionados"}
      </button>
      <button
        onClick={onQuitar}
        disabled={enviando}
        className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"
      >
        Quitar selección
      </button>
      {error && <p className="basis-full text-xs text-red-600">{error}</p>}
    </div>
  );
}
