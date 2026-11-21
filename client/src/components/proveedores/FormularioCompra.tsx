// client/src/components/proveedores/FormularioCompra.tsx
//
// «Registrar compra»: lo que se anota cuando se compra una cisterna. Pide lo que importa (proveedor,
// documento, fecha de emisión, llegada a planta y cantidad) y rellena solo el costo (con el precio vigente
// del proveedor), la unidad y el transportista desde lo último de ese proveedor. Quien lo monta le pone
// `key`: cada apertura nace con su formulario y su identificador de reenvío (`cliente_uuid`), así un doble
// clic o un reintento no crea dos compras; además el botón se bloquea mientras guarda.
import { X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";

import {
  cuerpoDeLaCompra,
  formularioInicial,
  precioVigenteDe,
  problemasDeLaCompra,
  sugerenciasPara,
  type FormularioDeCompra,
} from "./comprasFormulario";
import { ETIQUETA_DOCUMENTO, formatoSoles } from "./comprasProveedores";
import {
  registrarCompra,
  type CompraDeCisterna,
  type DatosFormularioCompra,
  type TipoCombustibleCompra,
} from "./proveedoresApi";

const COMBUSTIBLES: { valor: TipoCombustibleCompra; texto: string }[] = [
  { valor: "diesel_b5", texto: "Diésel B5" },
  { valor: "gasolina_90", texto: "Gasolina 90" },
  { valor: "glp", texto: "GLP" },
];

const CAMPO =
  "h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-800 outline-none focus:border-[#84cc16]";
const ETIQUETA = "block text-xs font-semibold text-slate-600";

export default function FormularioCompra({
  datos,
  compras,
  onRegistrada,
  onCerrar,
}: {
  datos: DatosFormularioCompra;
  /** Las compras que ya se ven en pantalla: de ahí salen las sugerencias por proveedor. */
  compras: CompraDeCisterna[];
  onRegistrada: (compra: CompraDeCisterna) => void;
  onCerrar: () => void;
}) {
  const [form, setForm] = useState<FormularioDeCompra>(() => formularioInicial(datos));
  // Lo que la persona ya escribió a mano no se pisa con una sugerencia nueva.
  const [tocados, setTocados] = useState<ReadonlySet<keyof FormularioDeCompra>>(new Set());
  const [clienteUuid] = useState(() => crypto.randomUUID());
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

  const cambiar = <K extends keyof FormularioDeCompra>(campo: K, valor: FormularioDeCompra[K]) => {
    setTocados((t) => new Set(t).add(campo));
    setForm((f) => ({ ...f, [campo]: valor }));
  };

  const aplicarSugerencias = (proveedor: string, tipo: TipoCombustibleCompra | undefined) => {
    if (proveedor === "") return;
    const sugerido = sugerenciasPara(Number(proveedor), compras, datos, tipo);
    setForm((f) => {
      const siguiente = { ...f };
      for (const [campo, valor] of Object.entries(sugerido) as [
        keyof FormularioDeCompra,
        string,
      ][]) {
        if (!tocados.has(campo)) (siguiente as Record<string, string>)[campo] = valor;
      }
      return siguiente;
    });
  };

  const precio =
    form.grifo_id === ""
      ? null
      : precioVigenteDe(Number(form.grifo_id), form.tipo_combustible, datos);

  const enviar = async (e: FormEvent) => {
    e.preventDefault();
    if (guardando) return;
    const faltan = problemasDeLaCompra(form);
    setProblemas(faltan);
    if (faltan.length > 0) return;
    setError(null);
    setGuardando(true);
    try {
      onRegistrada(await registrarCompra(cuerpoDeLaCompra(form, clienteUuid)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo registrar la compra.");
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
        aria-labelledby="form-compra-titulo"
        onSubmit={enviar}
        className="w-full max-w-2xl max-h-[92vh] overflow-y-auto rounded-2xl bg-white shadow-xl"
      >
        <header className="flex items-start justify-between p-5 border-b border-slate-200">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-slate-500">
              Nueva compra
            </p>
            <h2 id="form-compra-titulo" className="text-xl font-semibold text-slate-900">
              Registrar compra
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

        <div className="p-5 grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="compra-proveedor" className={ETIQUETA}>
              Proveedor
            </label>
            <select
              id="compra-proveedor"
              ref={primero}
              className={`${CAMPO} mt-1`}
              value={form.grifo_id}
              onChange={(e) => {
                cambiar("grifo_id", e.target.value);
                aplicarSugerencias(e.target.value, undefined);
              }}
            >
              <option value="">Elige un proveedor</option>
              {datos.proveedores.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nombre}
                </option>
              ))}
            </select>
            {datos.proveedores.length === 0 && (
              <p className="mt-1 text-xs text-amber-700">
                No hay proveedores de tanque activos. Registra uno en el Directorio, marcando
                «Combustible · Interno».
              </p>
            )}
          </div>
          <div>
            <label htmlFor="compra-combustible" className={ETIQUETA}>
              Combustible
            </label>
            <select
              id="compra-combustible"
              className={`${CAMPO} mt-1`}
              value={form.tipo_combustible}
              onChange={(e) => {
                const tipo = e.target.value as TipoCombustibleCompra;
                cambiar("tipo_combustible", tipo);
                aplicarSugerencias(form.grifo_id, tipo);
              }}
            >
              {COMBUSTIBLES.map((c) => (
                <option key={c.valor} value={c.valor}>
                  {c.texto}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="compra-documento" className={ETIQUETA}>
              Tipo de documento
            </label>
            <select
              id="compra-documento"
              className={`${CAMPO} mt-1`}
              value={form.tipo_documento}
              onChange={(e) =>
                cambiar("tipo_documento", e.target.value as FormularioDeCompra["tipo_documento"])
              }
            >
              {Object.entries(ETIQUETA_DOCUMENTO).map(([valor, texto]) => (
                <option key={valor} value={valor}>
                  {texto}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="compra-numero" className={ETIQUETA}>
              Número del documento
            </label>
            <input
              id="compra-numero"
              className={`${CAMPO} mt-1`}
              value={form.numero_documento}
              onChange={(e) => cambiar("numero_documento", e.target.value)}
              maxLength={100}
            />
          </div>

          <div>
            <label htmlFor="compra-emision" className={ETIQUETA}>
              Fecha de emisión
            </label>
            <input
              id="compra-emision"
              type="date"
              className={`${CAMPO} mt-1`}
              value={form.fecha_compra}
              onChange={(e) => cambiar("fecha_compra", e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="compra-llegada" className={ETIQUETA}>
              Llegada a planta (estimada)
            </label>
            <input
              id="compra-llegada"
              type="date"
              className={`${CAMPO} mt-1`}
              value={form.llegada_estimada}
              onChange={(e) => cambiar("llegada_estimada", e.target.value)}
            />
          </div>

          <div>
            <label htmlFor="compra-cantidad" className={ETIQUETA}>
              Cantidad facturada
            </label>
            <input
              id="compra-cantidad"
              inputMode="decimal"
              className={`${CAMPO} mt-1`}
              value={form.cantidad_facturada}
              onChange={(e) => cambiar("cantidad_facturada", e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="compra-unidad" className={ETIQUETA}>
              Unidad
            </label>
            <select
              id="compra-unidad"
              className={`${CAMPO} mt-1`}
              value={form.unidad}
              onChange={(e) => cambiar("unidad", e.target.value as "gal" | "L")}
            >
              <option value="gal">Galones</option>
              <option value="L">Litros</option>
            </select>
          </div>

          <div>
            <label htmlFor="compra-sede" className={ETIQUETA}>
              Sede de llegada
            </label>
            <select
              id="compra-sede"
              className={`${CAMPO} mt-1`}
              value={form.grifo_interno_id}
              onChange={(e) => cambiar("grifo_interno_id", e.target.value)}
            >
              <option value="">Elige la sede</option>
              {datos.sedes.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.sede} · {s.nombre}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="compra-costo" className={ETIQUETA}>
              Costo por {form.unidad === "L" ? "litro" : "galón"} (S/)
            </label>
            <input
              id="compra-costo"
              inputMode="decimal"
              className={`${CAMPO} mt-1`}
              value={form.costo_unitario}
              onChange={(e) => cambiar("costo_unitario", e.target.value)}
            />
            {precio !== null && (
              <p className="mt-1 text-xs text-slate-500">
                Precio vigente del proveedor: <b>{formatoSoles(precio)}</b>. Escribe el de la
                factura si es otro.
              </p>
            )}
          </div>

          <div>
            <label htmlFor="compra-transportista" className={ETIQUETA}>
              Empresa de transporte (opcional)
            </label>
            <input
              id="compra-transportista"
              className={`${CAMPO} mt-1`}
              value={form.transportista}
              onChange={(e) => cambiar("transportista", e.target.value)}
              maxLength={150}
            />
          </div>
          <div>
            <label htmlFor="compra-transportista-ruc" className={ETIQUETA}>
              RUC del transportista (opcional)
            </label>
            <input
              id="compra-transportista-ruc"
              inputMode="numeric"
              maxLength={11}
              className={`${CAMPO} mt-1`}
              value={form.transportista_ruc}
              onChange={(e) => cambiar("transportista_ruc", e.target.value)}
            />
          </div>

          {(problemas.length > 0 || error) && (
            <div
              role="alert"
              className="sm:col-span-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3 space-y-1"
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
            {guardando ? "Guardando…" : "Registrar compra"}
          </button>
        </footer>
      </form>
    </div>
  );
}
