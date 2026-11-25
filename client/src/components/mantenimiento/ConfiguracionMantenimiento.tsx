// client/src/components/mantenimiento/ConfiguracionMantenimiento.tsx
//
// La pantalla «Configuración del ecosistema» de la maqueta aprobada: las reglas operativas (interruptores), las
// metas del área y las áreas. Cada cambio se guarda al momento, sin botón «Guardar», como en la maqueta.
//
// Las reglas y las metas las cambia solo el administrador; las demás personas las ven apagadas. Si la carga falla
// no se muestra ningún control (no se podría guardar encima de valores que no se leyeron). Al guardar se aplica
// de la respuesta SOLO lo que se cambió, así una respuesta vieja no pisa otro cambio; y si falla, vuelve atrás.
import { useCallback, useEffect, useState } from "react";

import AreasDeMantenimiento from "./AreasDeMantenimiento";
import { METAS, REGLAS, avisoDeRegla, leerMeta, type Meta } from "./configMantenimiento";
import { guardarConfig, leerConfig, type ConfigMantenimiento } from "./mantenimientoApi";
import { useAuth } from "../../context/AuthContext";
import { usePuedeEscribir } from "../comunes/usePuedeEscribir";

export default function ConfiguracionMantenimiento() {
  const { usuario } = useAuth();
  const puedeEscribir = usePuedeEscribir("mantenimiento");
  const puedeConfigurar = puedeEscribir && usuario?.rol === "admin";
  const [config, setConfig] = useState<ConfigMantenimiento | null>(null);
  const [errorDeCarga, setErrorDeCarga] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState<ReadonlySet<string>>(new Set());
  /** Lo que se está escribiendo en una meta y todavía no se guardó. */
  const [borradores, setBorradores] = useState<Partial<Record<string, string>>>({});

  const cargar = useCallback(() => {
    setErrorDeCarga(null);
    return leerConfig()
      .then(setConfig)
      .catch((e: unknown) =>
        setErrorDeCarga(e instanceof Error ? e.message : "No se pudo cargar.")
      );
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargar();
  }, [cargar]);

  const quitarBorrador = (clave: string) =>
    setBorradores((b) => {
      const resto = { ...b };
      delete resto[clave];
      return resto;
    });

  const guardar = async <K extends keyof ConfigMantenimiento>(
    clave: K,
    valor: ConfigMantenimiento[K]
  ) => {
    if (!config || guardando.has(clave)) return;
    const antes = config[clave];
    setError(null);
    setGuardando((g) => new Set(g).add(clave));
    setConfig((c) => (c ? { ...c, [clave]: valor } : c));
    try {
      const quedo = await guardarConfig({ [clave]: valor } as Partial<ConfigMantenimiento>);
      setConfig((c) => (c ? { ...c, [clave]: quedo[clave] } : c));
    } catch (e) {
      setConfig((c) => (c ? { ...c, [clave]: antes } : c));
      setError(e instanceof Error ? e.message : "No se pudo guardar el cambio.");
    } finally {
      setGuardando((g) => {
        const resto = new Set(g);
        resto.delete(clave);
        return resto;
      });
    }
  };

  const confirmarMeta = (meta: Meta) => {
    const texto = borradores[meta.clave];
    if (texto === undefined || !config) return;
    const leida = leerMeta(texto, meta);
    quitarBorrador(meta.clave);
    if ("error" in leida) return setError(leida.error);
    if (leida.valor !== config[meta.clave]) void guardar(meta.clave, leida.valor);
  };

  return (
    <div className="space-y-5">
      <header>
        <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-slate-500">
          Seguimiento / Configuración
        </p>
        <h1 className="text-3xl font-semibold text-slate-900 mt-1">Configuración del ecosistema</h1>
        <p className="text-sm text-slate-500 mt-1">
          Reglas, metas y áreas de esta empresa. Cada empresa decide; todo se puede cambiar cuando
          quiera.
        </p>
      </header>

      {error && (
        <p
          role="alert"
          className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3"
        >
          {error}
        </p>
      )}

      {errorDeCarga && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3"
        >
          <span className="flex-1">No se pudieron leer las reglas y metas: {errorDeCarga}</span>
          <button onClick={() => cargar()} className="font-semibold underline">
            Reintentar
          </button>
        </div>
      )}
      {!config && !errorDeCarga && <p className="text-sm text-slate-500">Cargando…</p>}

      {config && (
        <>
          {!puedeConfigurar && (
            <p className="text-sm text-slate-600 bg-slate-100 rounded-lg p-3">
              Solo el administrador puede cambiar las reglas y las metas.
            </p>
          )}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
            <section
              aria-label="Reglas operativas"
              className="bg-white border border-slate-200 rounded-xl shadow-sm"
            >
              <div className="px-5 py-4 border-b border-slate-200">
                <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-slate-500">
                  Reglas operativas
                </p>
                <h2 className="text-lg font-semibold text-slate-900">Conexión entre módulos</h2>
              </div>
              <ul>
                {REGLAS.map((r) => {
                  const encendida = config[r.clave];
                  return (
                    <li
                      key={r.clave}
                      className="flex items-start gap-4 px-5 py-4 border-b border-slate-100 last:border-b-0"
                    >
                      <div className="flex-1 min-w-0">
                        <b className="block text-sm text-slate-900">{r.titulo}</b>
                        <span className="block text-xs leading-relaxed text-slate-500">
                          {r.descripcion}
                        </span>
                        <span className="mt-1 block text-[11px] font-semibold text-amber-700">
                          {avisoDeRegla(r, usuario)}
                        </span>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={encendida}
                        aria-label={r.titulo}
                        disabled={!puedeConfigurar || guardando.has(r.clave)}
                        onClick={() => guardar(r.clave, !encendida)}
                        className={`relative mt-1 h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
                          encendida ? "bg-[#84cc16]" : "bg-slate-300"
                        }`}
                      >
                        <span
                          className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                            encendida ? "translate-x-5" : ""
                          }`}
                        />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>

            <section
              aria-label="Metas del área"
              className="bg-white border border-slate-200 rounded-xl shadow-sm"
            >
              <div className="px-5 py-4 border-b border-slate-200">
                <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-slate-500">
                  Parámetros
                </p>
                <h2 className="text-lg font-semibold text-slate-900">Metas del área</h2>
              </div>
              <div>
                {METAS.map((m) => (
                  <label
                    key={m.clave}
                    className="flex items-center gap-4 px-5 py-4 border-b border-slate-100"
                  >
                    <b className="flex-1 min-w-0 text-sm text-slate-900">{m.titulo}</b>
                    <span className="flex items-center gap-2 shrink-0">
                      <input
                        type="text"
                        inputMode="numeric"
                        aria-label={m.titulo}
                        value={borradores[m.clave] ?? String(config[m.clave])}
                        disabled={!puedeConfigurar || guardando.has(m.clave)}
                        onChange={(e) =>
                          setBorradores((b) => ({ ...b, [m.clave]: e.target.value }))
                        }
                        onBlur={() => confirmarMeta(m)}
                        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                        className="h-10 w-24 rounded-lg border border-slate-300 bg-white px-3 text-right text-sm font-semibold text-slate-800 outline-none focus:border-[#84cc16] disabled:bg-slate-50 disabled:text-slate-500"
                      />
                      <em className="w-10 text-xs not-italic text-slate-500">{m.unidad}</em>
                    </span>
                  </label>
                ))}
              </div>
              <p className="m-4 text-xs text-slate-600 border border-dashed border-slate-300 rounded-lg p-3">
                Las metas se compararán en Indicadores y en el Tablero de preventivo cuando existan.
              </p>
            </section>
          </div>
        </>
      )}

      <AreasDeMantenimiento puedeEscribir={puedeEscribir} />
    </div>
  );
}
