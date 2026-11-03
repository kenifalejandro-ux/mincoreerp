import { X } from "lucide-react";
import { useState } from "react";

import UnidadYValeDeLinea, { type UnidadYVale } from "./UnidadYValeDeLinea";
import { apiFetch } from "../../services/apiClient";
import { mensajeDeError } from "../../utils/mensajeDeError";

// Lo que quedó en la cisterna del proveedor (migración 0168). Desde acá se
// reparte con despachos de excedente: a una unidad (con vale y medidor) o a una
// tanqueta (sin unidad no lleva vale). El servidor valida el saldo, la sede y el
// espacio de la tanqueta; acá solo se avisa antes de mandar.

export interface CisternaConSaldo {
  id: string;
  cantidad: string;
  saldo: string;
  recepcion_id: string;
  recibido_en: string;
  costo_unitario: string;
  tanque_codigo: string;
  tipo_combustible: "diesel_b5" | "gasolina_90" | "glp";
  unidad: string;
  grifo_interno_id: number | null;
  proveedor: string | null;
}

interface UnidadOpcion {
  id: number;
  placa_codigo: string;
  tipo_medidor: "horometro" | "odometro" | null;
}

interface TanquetaOpcion {
  id: number;
  codigo: string;
  grifo_interno_id: number;
  libre: number;
}

type SalidaA = "equipo" | "tanqueta";

const FORM_INICIAL = {
  destino: "equipo" as SalidaA,
  cantidad: "",
  equipo_id: "",
  serie_talonario: "",
  n_vale: "",
  medidor: "",
  tanqueta_id: "",
  unidadTanqueta: {} as UnidadYVale,
};

const formatear = (n: number) => n.toLocaleString("es-PE");

export default function CisternasConSaldo({
  cisternas,
  equipos,
  onRegistrado,
}: {
  cisternas: CisternaConSaldo[];
  equipos: UnidadOpcion[];
  onRegistrado: (mensaje: string) => Promise<void>;
}) {
  const [elegida, setElegida] = useState<CisternaConSaldo | null>(null);
  const [form, setForm] = useState(FORM_INICIAL);
  const [tanquetas, setTanquetas] = useState<TanquetaOpcion[]>([]);
  const [clienteUuid, setClienteUuid] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (cisternas.length === 0 && !elegida) return null;

  const abrir = (c: CisternaConSaldo) => {
    setForm({ ...FORM_INICIAL, cantidad: String(Number(c.saldo)) });
    setError(null);
    setClienteUuid(crypto.randomUUID());
    setTanquetas([]);
    setElegida(c);
    // Las tanquetas de la sede con su espacio libre (la misma lista del vale del tanque).
    apiFetch("/api/erp/combustible/tanquetas/formulario")
      .then((r) => (r.ok ? r.json() : []))
      .then((b) => setTanquetas(Array.isArray(b) ? b : []))
      .catch(() => setTanquetas([]));
  };

  const cambiar = (cambio: Partial<typeof FORM_INICIAL>) => setForm((f) => ({ ...f, ...cambio }));

  const registrar = async (c: CisternaConSaldo) => {
    if (enviando) return;
    const cantidad = Number(form.cantidad);
    const aUnidad = form.destino === "equipo";
    const unidadDeLaTanqueta = form.unidadTanqueta.tanqueta_equipo_id ?? "";
    const conVale = aUnidad || unidadDeLaTanqueta !== "";
    const equipo = equipos.find((e) => String(e.id) === form.equipo_id);
    const medidor = form.medidor !== "" ? Number(form.medidor) : undefined;
    const vale = aUnidad
      ? { serie_talonario: form.serie_talonario.trim(), n_vale: Number(form.n_vale) }
      : unidadDeLaTanqueta !== ""
        ? {
            serie_talonario: (form.unidadTanqueta.serie_talonario ?? "").trim(),
            n_vale: Number(form.unidadTanqueta.n_vale),
          }
        : null;

    setEnviando(true);
    setError(null);
    try {
      const res = await apiFetch("/api/erp/combustible/despachos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cliente_uuid: clienteUuid,
          origen: "excedente_recepcion",
          excedente_linea_id: Number(c.id),
          tipo_combustible: c.tipo_combustible,
          tipo_destino: aUnidad ? "equipo" : "reserva_cubeta",
          equipo_id: aUnidad ? Number(form.equipo_id) : undefined,
          tanqueta_destino_id: aUnidad ? undefined : Number(form.tanqueta_id),
          tanqueta_equipo_id: !aUnidad && conVale ? Number(unidadDeLaTanqueta) : undefined,
          ...(vale ?? {}),
          cantidad,
          lectura_horometro: aUnidad && equipo?.tipo_medidor === "horometro" ? medidor : undefined,
          lectura_odometro: aUnidad && equipo?.tipo_medidor === "odometro" ? medidor : undefined,
          costo_unitario: Number(c.costo_unitario),
          despachado_en: new Date().toISOString(),
        }),
      });
      if (!res.ok) {
        const cuerpo = await res.json().catch(() => ({}));
        setError(mensajeDeError(cuerpo, "No se pudo registrar la salida de la cisterna."));
        return;
      }
      const destino = aUnidad
        ? (equipo?.placa_codigo ?? "la unidad")
        : (tanquetas.find((t) => String(t.id) === form.tanqueta_id)?.codigo ?? "la tanqueta");
      setElegida(null);
      await onRegistrado(
        res.status === 202
          ? `Sin conexión: la salida de ${formatear(cantidad)} ${c.unidad} a ${destino} quedó guardada en este equipo y se enviará sola cuando vuelva la señal.`
          : `Salida registrada: ${formatear(cantidad)} ${c.unidad} de la cisterna a ${destino}.`
      );
    } finally {
      setEnviando(false);
    }
  };

  const saldo = elegida ? Number(elegida.saldo) : 0;
  const cantidad = Number(form.cantidad);
  const tanquetaElegida = tanquetas.find((t) => String(t.id) === form.tanqueta_id);
  const unidadDeTanqueta = (form.unidadTanqueta.tanqueta_equipo_id ?? "") !== "";
  const cantidadValida = cantidad > 0 && cantidad <= saldo + 0.001;
  const destinoCompleto =
    form.destino === "equipo"
      ? form.equipo_id !== "" && form.serie_talonario.trim() !== "" && Number(form.n_vale) > 0
      : form.tanqueta_id !== "" &&
        (tanquetaElegida ? cantidad <= tanquetaElegida.libre + 0.001 : true) &&
        (!unidadDeTanqueta ||
          ((form.unidadTanqueta.serie_talonario ?? "").trim() !== "" &&
            Number(form.unidadTanqueta.n_vale) > 0));
  const campo = "w-full border border-slate-200 rounded-xl p-3 text-sm";
  const etiqueta = "text-xs font-bold text-slate-700 uppercase";

  return (
    <>
      {cisternas.length > 0 && (
        <div className="mb-6 bg-sky-50 border border-sky-200 rounded-lg p-4 space-y-2">
          <p className="text-sm font-bold text-sky-900">Cisterna con saldo</p>
          {cisternas.map((c) => (
            <div key={c.id} className="flex flex-wrap items-center gap-3">
              <p className="text-sm text-sky-900 font-light flex-1">
                Quedan <strong>{formatear(Number(c.saldo))}</strong> {c.unidad} en la cisterna
                {c.proveedor ? ` de ${c.proveedor}` : ""} (recepción #{c.recepcion_id} del{" "}
                {new Date(c.recibido_en).toLocaleDateString("es-PE")}, tanque {c.tanque_codigo}).
              </p>
              <button
                type="button"
                onClick={() => abrir(c)}
                className="text-sm font-bold text-sky-900 underline"
              >
                Repartir
              </button>
            </div>
          ))}
        </div>
      )}
      {elegida && (
        <div className="fixed inset-0 bg-[#0D1719]/90 backdrop-blur-sm flex justify-center items-center z-[60] p-4">
          <div className="bg-white w-full max-w-xl rounded-3xl shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b flex items-start gap-3">
              <div className="flex-1">
                <h3 className="text-xl font-bold">Repartir lo que quedó en la cisterna</h3>
                <p className="text-sm text-slate-600">
                  Recepción #{elegida.recepcion_id}: quedan{" "}
                  <strong>
                    {formatear(saldo)} {elegida.unidad}
                  </strong>
                  . El costo es el de la factura.
                </p>
              </div>
              <button
                type="button"
                aria-label="Cerrar"
                onClick={() => setElegida(null)}
                className="text-slate-400 hover:text-slate-700"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 space-y-3">
              <div className="grid grid-cols-12 gap-2">
                <div className="col-span-12 sm:col-span-6 space-y-1">
                  <label htmlFor="cis-destino" className={etiqueta}>
                    A dónde va
                  </label>
                  <select
                    id="cis-destino"
                    className={campo}
                    value={form.destino}
                    onChange={(e) =>
                      cambiar({
                        destino: e.target.value as SalidaA,
                        equipo_id: "",
                        tanqueta_id: "",
                        medidor: "",
                        unidadTanqueta: {},
                      })
                    }
                  >
                    <option value="equipo">A una unidad</option>
                    <option value="tanqueta">A una tanqueta</option>
                  </select>
                </div>
                <div className="col-span-12 sm:col-span-6 space-y-1">
                  <label htmlFor="cis-cantidad" className={etiqueta}>
                    Cantidad ({elegida.unidad})
                  </label>
                  <input
                    id="cis-cantidad"
                    type="number"
                    min={0}
                    step="0.01"
                    className={campo}
                    value={form.cantidad}
                    onChange={(e) => cambiar({ cantidad: e.target.value })}
                  />
                </div>
              </div>
              {form.destino === "equipo" ? (
                <div className="grid grid-cols-12 gap-2">
                  <div className="col-span-12 sm:col-span-6 space-y-1">
                    <label htmlFor="cis-unidad" className={etiqueta}>
                      Unidad
                    </label>
                    <select
                      id="cis-unidad"
                      className={campo}
                      value={form.equipo_id}
                      onChange={(e) => cambiar({ equipo_id: e.target.value, medidor: "" })}
                    >
                      <option value="">Elegir...</option>
                      {equipos.map((eq) => (
                        <option key={eq.id} value={eq.id}>
                          {eq.placa_codigo}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="col-span-6 sm:col-span-3 space-y-1">
                    <label htmlFor="cis-serie" className={etiqueta}>
                      Serie del talonario
                    </label>
                    <input
                      id="cis-serie"
                      maxLength={20}
                      className={campo}
                      value={form.serie_talonario}
                      onChange={(e) => cambiar({ serie_talonario: e.target.value })}
                    />
                  </div>
                  <div className="col-span-6 sm:col-span-3 space-y-1">
                    <label htmlFor="cis-vale" className={etiqueta}>
                      N° de vale
                    </label>
                    <input
                      id="cis-vale"
                      type="number"
                      min={1}
                      step={1}
                      className={campo}
                      value={form.n_vale}
                      onChange={(e) => cambiar({ n_vale: e.target.value })}
                    />
                  </div>
                  {equipos.find((e) => String(e.id) === form.equipo_id)?.tipo_medidor && (
                    <div className="col-span-12 space-y-1">
                      <label htmlFor="cis-medidor" className={etiqueta}>
                        {equipos.find((e) => String(e.id) === form.equipo_id)?.tipo_medidor ===
                        "horometro"
                          ? "Horómetro"
                          : "Odómetro"}{" "}
                        de la unidad
                      </label>
                      <input
                        id="cis-medidor"
                        type="number"
                        min={0}
                        step="0.01"
                        className={campo}
                        value={form.medidor}
                        onChange={(e) => cambiar({ medidor: e.target.value })}
                      />
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <div className="space-y-1">
                    <label htmlFor="cis-tanqueta" className={etiqueta}>
                      Tanqueta
                    </label>
                    <select
                      id="cis-tanqueta"
                      className={campo}
                      value={form.tanqueta_id}
                      onChange={(e) => cambiar({ tanqueta_id: e.target.value })}
                    >
                      <option value="">Elegir...</option>
                      {tanquetas
                        .filter((t) => t.grifo_interno_id === elegida.grifo_interno_id)
                        .map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.codigo} (libre {formatear(t.libre)})
                          </option>
                        ))}
                    </select>
                  </div>
                  <UnidadYValeDeLinea
                    indice={0}
                    unidades={equipos}
                    valor={form.unidadTanqueta}
                    onCambio={(cambio) =>
                      cambiar({ unidadTanqueta: { ...form.unidadTanqueta, ...cambio } })
                    }
                  />
                </>
              )}
              <p
                className={`text-sm font-bold ${cantidadValida && destinoCompleto ? "text-emerald-700" : "text-amber-700"}`}
              >
                {cantidad > saldo + 0.001
                  ? `En la cisterna solo quedan ${formatear(saldo)} ${elegida.unidad}.`
                  : !cantidadValida
                    ? "Escribe la cantidad."
                    : form.destino === "tanqueta" &&
                        tanquetaElegida &&
                        cantidad > tanquetaElegida.libre + 0.001
                      ? `${tanquetaElegida.codigo} solo admite ${formatear(tanquetaElegida.libre)} gal.`
                      : !destinoCompleto
                        ? form.destino === "equipo"
                          ? "Elige la unidad y anota el vale."
                          : "Elige la tanqueta (y el vale si la lleva una unidad)."
                        : `Quedarán ${formatear(Number((saldo - cantidad).toFixed(2)))} ${elegida.unidad} en la cisterna.`}
              </p>
              {error && (
                <p role="alert" className="text-sm text-red-700">
                  {error}
                </p>
              )}
            </div>
            <div className="p-6 border-t flex gap-3">
              <button
                type="button"
                onClick={() => setElegida(null)}
                className="flex-1 border border-slate-200 font-bold py-3 rounded-2xl hover:bg-slate-50"
              >
                Volver
              </button>
              <button
                type="button"
                disabled={!cantidadValida || !destinoCompleto || enviando}
                onClick={() => registrar(elegida)}
                className="flex-1 bg-sky-600 text-white font-bold py-3 rounded-2xl hover:bg-sky-700 disabled:opacity-50"
              >
                {enviando ? "Registrando..." : "Registrar salida"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
