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
  type ValeFaltante,
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

/** Manda el deshacer. Devuelve el texto del error, o null si salió bien. */
async function deshacerRegularizacion(
  serie: string,
  numeros: number[],
  motivo: string
): Promise<string | null> {
  if (!motivo.trim()) return "Escribe por qué se deshace.";
  try {
    const res = await apiFetch("/api/erp/combustible/despachos/talonarios/bajas/deshacer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serie, numeros, motivo: motivo.trim() }),
    });
    if (res.ok) return null;
    return mensajeDeError(await res.json().catch(() => ({})), "No se pudo deshacer.");
  } catch {
    return "Sin conexión: deshacer necesita señal. Inténtalo de nuevo cuando vuelva.";
  }
}

function CampoMotivoDeshacer({
  id,
  valor,
  onCambio,
}: {
  id: string;
  valor: string;
  onCambio: (v: string) => void;
}) {
  return (
    <label className="flex min-w-[220px] flex-1 flex-col gap-1 text-xs font-bold uppercase text-slate-600">
      Por qué se deshace
      <input
        id={id}
        type="text"
        maxLength={300}
        className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm font-normal normal-case"
        value={valor}
        onChange={(e) => onCambio(e.target.value)}
      />
    </label>
  );
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
  const [motivoDeshacer, setMotivoDeshacer] = useState("");
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
    setMotivoDeshacer("");
    setError(null);
  };

  const confirmarUno = async (deshacer: boolean) => {
    if (uno === null) return;
    setEnviando(true);
    const fallo = deshacer
      ? await deshacerRegularizacion(serie.serie, [uno], motivoDeshacer)
      : await regularizarVales(serie.serie, [uno], motivo, detalle);
    setEnviando(false);
    if (fallo) return setError(fallo);
    setUno(null);
    onCambio();
  };

  const formularioUno = (v: ValeFaltante) => (
    <div className="flex flex-wrap items-end gap-2 bg-slate-50 px-3 py-2.5 pl-12">
      {v.baja ? (
        <CampoMotivoDeshacer
          id={`des-${v.n}`}
          valor={motivoDeshacer}
          onCambio={setMotivoDeshacer}
        />
      ) : (
        <CamposDeMotivo
          id={`reg-${v.n}`}
          motivo={motivo}
          detalle={detalle}
          onMotivo={setMotivo}
          onDetalle={setDetalle}
        />
      )}
      <button
        onClick={() => confirmarUno(!!v.baja)}
        disabled={enviando}
        className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
      >
        {enviando ? "Guardando..." : v.baja ? "Deshacer regularización" : "Confirmar"}
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
  );

  /** El botón de la fila: «Regularizar» en lima (la acción principal) o «Deshacer», neutro. */
  const botonUno = (v: ValeFaltante) =>
    puedeRegularizar ? (
      <button
        onClick={() => abrirUno(v.n)}
        className={
          v.baja
            ? "rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            : "rounded-lg bg-lime-400 px-3 py-1 text-xs font-semibold text-slate-900 hover:bg-lime-300"
        }
      >
        {v.baja ? "Deshacer" : "Regularizar"}
      </button>
    ) : (
      !v.baja && <span className="text-xs text-slate-400">Solo lectura</span>
    );

  return (
    <div className="space-y-3">
      {serie.tramos.map((t) => {
        const pendientes = t.vales.filter((v) => !v.baja);
        const todos = pendientes.length > 0 && pendientes.every((v) => marcados.has(v.n));
        if (t.vales.length === 1) {
          // Un solo vale: una sola fila, sin encabezado de tramo que repita lo mismo.
          const v = t.vales[0];
          return (
            <section key={t.desde} className="overflow-hidden rounded-lg border border-slate-200">
              <div className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-start gap-3 px-3 py-2.5">
                {puedeRegularizar ? (
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4"
                    checked={marcados.has(v.n)}
                    onChange={() => alternar(v.n)}
                    aria-label={`Marcar el vale ${valeTexto(serie.serie, v.n)}`}
                  />
                ) : (
                  <span />
                )}
                <div className="min-w-0 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-mono font-semibold text-slate-800">
                      {valeTexto(serie.serie, v.n)}
                    </span>
                    {v.baja ? (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
                        Regularizado
                      </span>
                    ) : (
                      <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">
                        Sin explicar
                      </span>
                    )}
                  </div>
                  {v.baja && (
                    <p className="text-xs text-slate-500">{textoBaja(v.baja, fechaCorta)}</p>
                  )}
                  <p className="text-xs text-slate-500">
                    {textoVecinos(serie.serie, t, fechaCorta)}
                  </p>
                </div>
                {botonUno(v)}
              </div>
              {uno === v.n && formularioUno(v)}
            </section>
          );
        }
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
                    {puedeRegularizar ? (
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
                    {botonUno(v)}
                  </div>
                  {uno === v.n && formularioUno(v)}
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

/** La barra de abajo. Con vales sin explicar marcados, los regulariza con un mismo motivo. Con vales
 *  regularizados marcados, los deshace con el motivo escrito. Mezclados no se pueden: son dos cosas. */
export function BarraRegularizar({
  serie,
  numeros,
  regularizados,
  onQuitar,
  onHecha,
}: {
  serie: string;
  numeros: number[];
  /** Los números de la serie que ya están regularizados. */
  regularizados: Set<number>;
  onQuitar: () => void;
  onHecha: () => void;
}) {
  const [motivo, setMotivo] = useState("");
  const [detalle, setDetalle] = useState("");
  const [motivoDeshacer, setMotivoDeshacer] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const aDeshacer = numeros.filter((n) => regularizados.has(n));
  const mezclado = aDeshacer.length > 0 && aDeshacer.length < numeros.length;
  const deshaciendo = aDeshacer.length > 0 && !mezclado;

  const confirmar = async () => {
    setEnviando(true);
    setError(null);
    const fallo = deshaciendo
      ? await deshacerRegularizacion(serie, numeros, motivoDeshacer)
      : await regularizarVales(serie, numeros, motivo, detalle);
    setEnviando(false);
    if (fallo) return setError(fallo);
    setMotivo("");
    setDetalle("");
    setMotivoDeshacer("");
    onHecha();
  };

  const conteo =
    numeros.length === 1 ? "1 vale seleccionado" : `${numeros.length} vales seleccionados`;

  return (
    <div className="sticky bottom-0 -mx-6 -mb-4 flex flex-wrap items-end gap-3 border-t-2 border-lime-400 bg-white px-6 py-3 shadow-[0_-4px_12px_rgba(0,0,0,0.08)]">
      <span className="self-center font-bold text-slate-800">{conteo}</span>
      {mezclado ? (
        <p className="self-center text-sm text-slate-600">
          Hay vales regularizados y sin explicar. Marca solo de un tipo: los sin explicar se
          regularizan y los regularizados se deshacen.
        </p>
      ) : deshaciendo ? (
        <>
          <CampoMotivoDeshacer
            id="des-masiva"
            valor={motivoDeshacer}
            onCambio={setMotivoDeshacer}
          />
          <button
            onClick={confirmar}
            disabled={enviando}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {enviando ? "Guardando..." : "Deshacer regularización"}
          </button>
        </>
      ) : (
        <>
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
        </>
      )}
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
