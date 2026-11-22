// client/src/components/proveedores/FormularioPrecio.tsx
//
// «Nuevo precio» de proveedores. Combustible: el mismo precio para varios proveedores de ruta a la vez (todo
// o nada). Urea: un proveedor y una presentación, con su marca. El precio se APILA con su vigencia (nunca se
// edita) y muestra en vivo cuánto cambia contra el vigente; un salto de más del 50 % pide confirmación.
// Quien lo monta le pone `key`. El botón se bloquea mientras guarda, y repetir un precio es inofensivo: se
// apila igual y se puede anular.
import { X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";

import {
  cuerpoDelPrecio,
  formularioInicialDePrecio,
  necesitaConfirmacion,
  problemasDelPrecio,
  UMBRAL_CONFIRMACION_PCT,
  variacionesContraVigente,
  type FormularioDePrecio,
} from "./preciosFormulario";
import {
  cargarPrecioUrea,
  cargarPreciosCombustible,
  type DatosFormularioPrecio,
  type FilaPrecio,
  type TipoCombustibleDePrecio,
} from "./proveedoresApi";

const COMBUSTIBLES: { valor: TipoCombustibleDePrecio; texto: string }[] = [
  { valor: "diesel_b5", texto: "Diésel B5" },
  { valor: "gasolina_90", texto: "Gasolina 90" },
  { valor: "glp", texto: "GLP" },
];

const CAMPO =
  "h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-800 outline-none focus:border-[#84cc16]";
const ETIQUETA = "block text-xs font-semibold text-slate-600";

export default function FormularioPrecio({
  datos,
  filas,
  proveedorInicial,
  onCargado,
  onCerrar,
}: {
  datos: DatosFormularioPrecio;
  /** Los precios que ya se ven en pantalla: de ahí sale la variación contra el vigente. */
  filas: FilaPrecio[];
  /** Abre con este proveedor ya elegido (desde su ficha). */
  proveedorInicial?: number;
  onCargado: (mensaje: string) => void;
  onCerrar: () => void;
}) {
  const [form, setForm] = useState<FormularioDePrecio>(() =>
    formularioInicialDePrecio(datos, proveedorInicial)
  );
  const [guardando, setGuardando] = useState(false);
  const [problemas, setProblemas] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const primero = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    primero.current?.focus();
    const alTeclear = (e: KeyboardEvent) => e.key === "Escape" && onCerrar();
    window.addEventListener("keydown", alTeclear);
    return () => window.removeEventListener("keydown", alTeclear);
  }, [onCerrar]);

  const cambiar = <K extends keyof FormularioDePrecio>(campo: K, valor: FormularioDePrecio[K]) =>
    // Cambiar cualquier dato invalida la confirmación que se había marcado.
    setForm((f) => ({
      ...f,
      [campo]: valor,
      confirmado: campo === "confirmado" ? (valor as boolean) : false,
    }));

  const variaciones = variacionesContraVigente(form, filas);
  const pideConfirmar = necesitaConfirmacion(variaciones);
  const nombreDe = (id: number) =>
    [...datos.proveedoresCombustible, ...datos.proveedoresUrea].find((p) => p.id === id)?.nombre ??
    `#${id}`;
  const alternar = (id: number) =>
    cambiar(
      "grifo_ids",
      form.grifo_ids.includes(id) ? form.grifo_ids.filter((x) => x !== id) : [...form.grifo_ids, id]
    );
  const unidad = form.producto === "combustible" ? "galón" : "envase";

  const enviar = async (e: FormEvent) => {
    e.preventDefault();
    if (guardando) return;
    const faltan = problemasDelPrecio(form, filas);
    setProblemas(faltan);
    if (faltan.length > 0) return;
    setError(null);
    setGuardando(true);
    try {
      const pedido = cuerpoDelPrecio(form);
      if (pedido.producto === "combustible") {
        await cargarPreciosCombustible(pedido.cuerpo);
        onCargado(
          pedido.cuerpo.grifo_ids.length === 1
            ? "Precio cargado."
            : `Precio cargado a ${pedido.cuerpo.grifo_ids.length} proveedores.`
        );
      } else {
        await cargarPrecioUrea(pedido.cuerpo);
        onCargado("Precio cargado.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar el precio.");
    } finally {
      setGuardando(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] grid place-items-center bg-slate-900/60 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onCerrar()}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="form-precio-titulo"
        onSubmit={enviar}
        className="w-full max-w-xl max-h-[92vh] overflow-y-auto rounded-2xl bg-white shadow-xl"
      >
        <header className="flex items-start justify-between p-5 border-b border-slate-200">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-slate-500">
              Nuevo acuerdo
            </p>
            <h2 id="form-precio-titulo" className="text-xl font-semibold text-slate-900">
              Nuevo precio
            </h2>
          </div>
          <button
            type="button"
            onClick={onCerrar}
            aria-label="Cerrar"
            className="text-slate-500 hover:text-slate-900"
          >
            <X size={20} />
          </button>
        </header>

        <div className="p-5 space-y-4">
          {datos.combustible && datos.urea && (
            <div>
              <label htmlFor="precio-producto" className={ETIQUETA}>
                Producto
              </label>
              <select
                id="precio-producto"
                ref={primero}
                className={`${CAMPO} mt-1`}
                value={form.producto}
                onChange={(e) =>
                  cambiar("producto", e.target.value as FormularioDePrecio["producto"])
                }
              >
                <option value="combustible">Combustible</option>
                <option value="urea">Urea</option>
              </select>
            </div>
          )}

          {form.producto === "combustible" ? (
            <>
              <div>
                <label htmlFor="precio-combustible" className={ETIQUETA}>
                  Combustible
                </label>
                <select
                  id="precio-combustible"
                  className={`${CAMPO} mt-1`}
                  value={form.tipo_combustible}
                  onChange={(e) =>
                    cambiar("tipo_combustible", e.target.value as TipoCombustibleDePrecio)
                  }
                >
                  {COMBUSTIBLES.map((c) => (
                    <option key={c.valor} value={c.valor}>
                      {c.texto}
                    </option>
                  ))}
                </select>
              </div>
              <fieldset>
                <legend className={ETIQUETA}>Proveedores de ruta</legend>
                {datos.proveedoresCombustible.length === 0 ? (
                  <p className="mt-1 text-xs text-amber-700">
                    No hay proveedores de ruta activos. Registra uno en el Directorio, marcando
                    «Combustible · Externo».
                  </p>
                ) : (
                  <div className="mt-1 space-y-1.5 max-h-44 overflow-y-auto">
                    {datos.proveedoresCombustible.map((p) => (
                      <label
                        key={p.id}
                        className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 cursor-pointer has-[:checked]:border-[#84cc16] has-[:checked]:bg-[#BADC1E]/10"
                      >
                        <input
                          type="checkbox"
                          checked={form.grifo_ids.includes(p.id)}
                          onChange={() => alternar(p.id)}
                          className="accent-[#65a30d]"
                        />
                        {p.nombre}
                      </label>
                    ))}
                  </div>
                )}
              </fieldset>
            </>
          ) : (
            <>
              <div>
                <label htmlFor="precio-proveedor" className={ETIQUETA}>
                  Proveedor
                </label>
                <select
                  id="precio-proveedor"
                  ref={datos.combustible ? undefined : primero}
                  className={`${CAMPO} mt-1`}
                  value={form.grifo_id}
                  onChange={(e) => cambiar("grifo_id", e.target.value)}
                >
                  <option value="">Elige un proveedor</option>
                  {datos.proveedoresUrea.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.nombre}
                    </option>
                  ))}
                </select>
                {datos.proveedoresUrea.length === 0 && (
                  <p className="mt-1 text-xs text-amber-700">
                    No hay proveedores de urea activos. Registra uno en el Directorio, marcando
                    «Urea · Interno» o «Urea · Externo».
                  </p>
                )}
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="precio-presentacion" className={ETIQUETA}>
                    Presentación
                  </label>
                  <select
                    id="precio-presentacion"
                    className={`${CAMPO} mt-1`}
                    value={form.presentacion}
                    onChange={(e) => cambiar("presentacion", e.target.value)}
                  >
                    {datos.presentaciones.map((p) => (
                      <option key={p.codigo} value={p.codigo}>
                        {p.nombre}
                        {p.litros ? ` (${Number(p.litros)} L)` : ""}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="precio-marca" className={ETIQUETA}>
                    Marca (opcional)
                  </label>
                  <input
                    id="precio-marca"
                    className={`${CAMPO} mt-1`}
                    value={form.marca}
                    onChange={(e) => cambiar("marca", e.target.value)}
                    maxLength={80}
                  />
                </div>
              </div>
            </>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="precio-monto" className={ETIQUETA}>
                Precio por {unidad} (S/)
              </label>
              <input
                id="precio-monto"
                inputMode="decimal"
                className={`${CAMPO} mt-1`}
                value={form.precio}
                onChange={(e) => cambiar("precio", e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="precio-desde" className={ETIQUETA}>
                Rige desde (opcional)
              </label>
              <input
                id="precio-desde"
                type="datetime-local"
                className={`${CAMPO} mt-1`}
                value={form.vigente_desde}
                onChange={(e) => cambiar("vigente_desde", e.target.value)}
              />
              <p className="mt-1 text-xs text-slate-500">Vacío: rige desde ahora.</p>
            </div>
            <div>
              <label htmlFor="precio-hasta" className={ETIQUETA}>
                Vigencia hasta (opcional)
              </label>
              <input
                id="precio-hasta"
                type="date"
                className={`${CAMPO} mt-1`}
                value={form.vigente_hasta}
                onChange={(e) => cambiar("vigente_hasta", e.target.value)}
              />
              <p className="mt-1 text-xs text-slate-500">
                Solo avisa cuando vence; el precio sigue rigiendo hasta que cargues otro.
              </p>
            </div>
          </div>

          {variaciones.length > 0 && (
            <ul aria-label="Variación contra el precio vigente" className="text-xs space-y-1">
              {variaciones.map((v) => (
                <li
                  key={v.proveedorId}
                  className={
                    Math.abs(v.pct) > UMBRAL_CONFIRMACION_PCT
                      ? "text-red-700 font-semibold"
                      : "text-slate-600"
                  }
                >
                  {nombreDe(v.proveedorId)}: {v.pct >= 0 ? "▲" : "▼"} {Math.abs(v.pct).toFixed(1)} %
                  contra su precio vigente
                </li>
              ))}
            </ul>
          )}
          {pideConfirmar && (
            <label className="flex items-start gap-2 text-sm text-red-800 bg-red-50 border border-red-200 rounded-lg p-3">
              <input
                type="checkbox"
                checked={form.confirmado}
                onChange={(e) => cambiar("confirmado", e.target.checked)}
                className="mt-0.5 accent-[#dc2626]"
              />
              Confirmo el cambio: es de más de {UMBRAL_CONFIRMACION_PCT} % contra el precio vigente.
            </label>
          )}

          {(problemas.length > 0 || error) && (
            <div
              role="alert"
              className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3 space-y-1"
            >
              {problemas.map((p) => (
                <p key={p}>{p}</p>
              ))}
              {error && <p>{error}</p>}
            </div>
          )}
        </div>

        <footer className="flex justify-end gap-2 p-5 border-t border-slate-200">
          <button
            type="button"
            onClick={onCerrar}
            className="h-10 px-4 rounded-lg border border-slate-300 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Cancelar
          </button>
          <button
            type="submit"
            disabled={guardando}
            className="h-10 px-4 rounded-lg bg-[#BADC1E] text-[#0A1014] text-sm font-semibold hover:brightness-95 disabled:opacity-60"
          >
            {guardando ? "Guardando…" : "Cargar precio"}
          </button>
        </footer>
      </form>
    </div>
  );
}
