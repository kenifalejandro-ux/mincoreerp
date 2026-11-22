// client/src/components/proveedores/CuentasDeProveedor.tsx
//
// La pestaña «Cuentas» de la ficha: las cuentas bancarias del proveedor, con el número enmascarado. Ver el
// número completo y agregar, editar o quitar son permisos aparte (el servidor manda qué puede hacer esta
// persona). El número completo se muestra unos segundos y se vuelve a ocultar; cada vez que se pide queda en
// la bitácora.
import { Eye, EyeOff, Pencil, Plus, Star, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { numeroEnGrupos, textoDeMonedaDeCuenta, textoDeTipoDeCuenta } from "./cuentasFormulario";
import FormularioCuenta from "./FormularioCuenta";
import {
  cuentasDeProveedor,
  verNumeroCompleto,
  type CuentaBancaria,
  type RespuestaCuentas,
} from "./proveedoresApi";
import QuitarCuenta from "./QuitarCuenta";

/** Cuánto se deja a la vista un número completo antes de volver a ocultarlo. */
const SEGUNDOS_A_LA_VISTA = 30;

export default function CuentasDeProveedor({ proveedorId }: { proveedorId: number }) {
  const [datos, setDatos] = useState<RespuestaCuentas | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const recargar = useCallback(() => setVersion((v) => v + 1), []);
  // `null` = cerrado; `{}` = agregar; `{ cuenta }` = editar.
  const [formulario, setFormulario] = useState<{ cuenta?: CuentaBancaria } | null>(null);
  const [quitando, setQuitando] = useState<CuentaBancaria | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  // El número completo a la vista (uno a la vez) y el temporizador que lo oculta.
  const [visible, setVisible] = useState<{ id: number; numero: string } | null>(null);
  const [pidiendo, setPidiendo] = useState<number | null>(null);
  const temporizador = useRef<ReturnType<typeof setTimeout> | null>(null);

  const ocultar = useCallback(() => {
    if (temporizador.current) clearTimeout(temporizador.current);
    temporizador.current = null;
    setVisible(null);
  }, []);
  useEffect(() => ocultar, [ocultar]);

  useEffect(() => {
    let vigente = true;
    cuentasDeProveedor(proveedorId)
      .then((r) => {
        if (vigente) {
          setDatos(r);
          setError(null);
        }
      })
      .catch((e: Error) => vigente && setError(e.message));
    return () => {
      vigente = false;
    };
  }, [proveedorId, version]);

  const mostrar = async (cuenta: CuentaBancaria) => {
    if (pidiendo !== null) return;
    setPidiendo(cuenta.id);
    setError(null);
    try {
      const { numero } = await verNumeroCompleto(proveedorId, cuenta.id);
      if (temporizador.current) clearTimeout(temporizador.current);
      setVisible({ id: cuenta.id, numero });
      temporizador.current = setTimeout(ocultar, SEGUNDOS_A_LA_VISTA * 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo mostrar el número.");
    } finally {
      setPidiendo(null);
    }
  };

  if (error && !datos)
    return (
      <p
        role="alert"
        className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3"
      >
        {error}
      </p>
    );
  if (!datos) return <p className="text-sm text-slate-500">Cargando…</p>;

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Cuentas bancarias</h2>
          <p className="text-xs text-slate-500">
            El número se guarda cifrado. Cada vez que alguien lo ve completo o cambia una cuenta,
            queda en la bitácora.
          </p>
        </div>
        {datos.puedeEditar && (
          <button
            onClick={() => setFormulario({})}
            className="flex items-center gap-2 h-10 px-4 rounded-lg bg-[#BADC1E] text-[#0A1014] text-sm font-semibold hover:brightness-95"
          >
            <Plus size={16} /> Agregar cuenta
          </button>
        )}
      </div>
      {aviso && (
        <p
          role="status"
          className="text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg p-3"
        >
          {aviso}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3"
        >
          {error}
        </p>
      )}

      {datos.cuentas.length === 0 ? (
        <p className="text-sm text-slate-600 bg-white border border-dashed border-slate-300 rounded-xl p-5">
          Este proveedor todavía no tiene cuentas bancarias.
          {datos.puedeEditar ? " Agrega la primera con «Agregar cuenta»." : ""}
        </p>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {datos.cuentas.map((c) => {
            const abierto = visible?.id === c.id;
            return (
              <li
                key={c.id}
                className="bg-white border border-slate-200 rounded-xl shadow-sm p-4 space-y-2"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-900 flex flex-wrap items-center gap-2">
                      {c.banco}
                      {c.principal && (
                        <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-[#BADC1E]/25 text-[#3f6212]">
                          <Star size={10} /> Principal
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-slate-500">
                      {textoDeTipoDeCuenta(c.tipoCuenta)} · {textoDeMonedaDeCuenta(c.moneda)}
                    </p>
                    {c.titular && <p className="text-xs text-slate-500">Titular: {c.titular}</p>}
                  </div>
                  {datos.puedeEditar && (
                    <div className="flex gap-1 shrink-0">
                      <button
                        onClick={() => setFormulario({ cuenta: c })}
                        aria-label={`Editar cuenta ${c.banco} ${c.numeroEnmascarado}`}
                        className="p-2 rounded-md text-slate-500 hover:text-slate-900 hover:bg-slate-100"
                      >
                        <Pencil size={15} />
                      </button>
                      <button
                        onClick={() => setQuitando(c)}
                        aria-label={`Quitar cuenta ${c.banco} ${c.numeroEnmascarado}`}
                        className="p-2 rounded-md text-slate-500 hover:text-red-700 hover:bg-red-50"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  )}
                </div>
                <p
                  className="font-mono text-sm text-slate-800 break-all"
                  aria-label={`Número de la cuenta ${c.banco}`}
                >
                  {abierto ? numeroEnGrupos(visible.numero) : c.numeroEnmascarado}
                </p>
                {datos.verCompleta &&
                  (abierto ? (
                    <button
                      onClick={ocultar}
                      className="flex items-center gap-2 text-xs font-semibold text-slate-600 hover:text-slate-900"
                    >
                      <EyeOff size={14} /> Ocultar número
                    </button>
                  ) : (
                    <button
                      onClick={() => mostrar(c)}
                      disabled={pidiendo !== null}
                      aria-label={`Ver número completo de la cuenta ${c.banco} ${c.numeroEnmascarado}`}
                      className="flex items-center gap-2 text-xs font-semibold text-slate-600 hover:text-slate-900 disabled:opacity-60"
                    >
                      <Eye size={14} /> {pidiendo === c.id ? "Abriendo…" : "Ver número completo"}
                    </button>
                  ))}
              </li>
            );
          })}
        </ul>
      )}

      {formulario && (
        <FormularioCuenta
          proveedorId={proveedorId}
          cuenta={formulario.cuenta}
          onCerrar={() => setFormulario(null)}
          onGuardado={(mensaje) => {
            setFormulario(null);
            ocultar();
            setAviso(mensaje);
            recargar();
          }}
        />
      )}
      {quitando && (
        <QuitarCuenta
          proveedorId={proveedorId}
          cuentaId={quitando.id}
          descripcion={`${quitando.banco} ${quitando.numeroEnmascarado}`}
          onCerrar={() => setQuitando(null)}
          onQuitada={() => {
            setQuitando(null);
            ocultar();
            setAviso("Cuenta quitada.");
            recargar();
          }}
        />
      )}
    </section>
  );
}
