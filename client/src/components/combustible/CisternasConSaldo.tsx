import { X } from "lucide-react";
import { useEffect, useState } from "react";

import UnidadYValeDeLinea, { type UnidadYVale } from "./UnidadYValeDeLinea";
import { apiFetch } from "../../services/apiClient";
import { mensajeDeError } from "../../utils/mensajeDeError";

// El modal para repartir lo que quedó en la cisterna del proveedor (migración 0168). Lo abre la
// pestaña "Cisternas" con la cisterna elegida; el aviso de Tanques solo lleva a esa pestaña. Se
// reparte con despachos de excedente: a una unidad (con vale y medidor) o a una tanqueta (sin
// unidad no lleva vale), o se pasa al tanque. El servidor valida el saldo, la sede y el espacio;
// acá solo se avisa antes de mandar.

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

interface TanqueOpcion {
  id: number;
  codigo: string;
  tanque_nombre: string;
  tipo_combustible: string;
  unidad: string;
  capacidad_total: string;
  nivel_teorico: string | null;
  activo: boolean;
  grifo_interno_id: number | null;
}

type SalidaA = "equipo" | "tanqueta" | "tanque";

const FORM_INICIAL = {
  destino: "equipo" as SalidaA,
  cantidad: "",
  equipo_id: "",
  serie_talonario: "",
  n_vale: "",
  medidor: "",
  tanqueta_id: "",
  tanque_id: "",
  unidadTanqueta: {} as UnidadYVale,
};

const formatear = (n: number) => n.toLocaleString("es-PE");

export default function RepartirCisterna({
  cisterna: elegida,
  equipos,
  tanques,
  onCerrar,
  onRegistrado,
}: {
  cisterna: CisternaConSaldo;
  equipos: UnidadOpcion[];
  tanques: TanqueOpcion[];
  onCerrar: () => void;
  onRegistrado: (mensaje: string) => Promise<void>;
}) {
  // Quien lo monta le pone `key` con el id de la cisterna: cada apertura nace con su formulario,
  // su identificador de reenvío y sus tanquetas, sin arrastrar lo de la anterior.
  const [form, setForm] = useState({ ...FORM_INICIAL, cantidad: String(Number(elegida.saldo)) });
  const [tanquetas, setTanquetas] = useState<TanquetaOpcion[]>([]);
  const [clienteUuid] = useState(() => crypto.randomUUID());
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Las tanquetas de la sede con su espacio libre (la misma lista del vale del tanque).
  useEffect(() => {
    let vigente = true;
    apiFetch("/api/erp/combustible/tanquetas/formulario")
      .then((r) => (r.ok ? r.json() : []))
      .then((b) => {
        if (vigente) setTanquetas(Array.isArray(b) ? b : []);
      })
      .catch(() => {
        if (vigente) setTanquetas([]);
      });
    return () => {
      vigente = false;
    };
  }, []);

  const cambiar = (cambio: Partial<typeof FORM_INICIAL>) => setForm((f) => ({ ...f, ...cambio }));

  // Pasar lo que queda al tanque (0169): una entrada del tanque, sin vale ni medidor.
  const registrarAlTanque = async (c: CisternaConSaldo) => {
    const cantidad = Number(form.cantidad);
    setEnviando(true);
    setError(null);
    try {
      const res = await apiFetch("/api/erp/combustible/despachos/cisterna-al-tanque", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cliente_uuid: clienteUuid,
          linea_id: Number(c.id),
          combustible_id: Number(form.tanque_id),
          cantidad,
        }),
      });
      if (!res.ok) {
        const cuerpo = await res.json().catch(() => ({}));
        setError(mensajeDeError(cuerpo, "No se pudo pasar la cisterna al tanque."));
        return;
      }
      const tanque = tanques.find((t) => String(t.id) === form.tanque_id)?.codigo ?? "el tanque";
      onCerrar();
      await onRegistrado(
        res.status === 202
          ? `Sin conexión: el pase de ${formatear(cantidad)} ${c.unidad} de la cisterna a ${tanque} quedó guardado en este equipo y se enviará solo cuando vuelva la señal.`
          : `Pase registrado: ${formatear(cantidad)} ${c.unidad} de la cisterna a ${tanque}.`
      );
    } finally {
      setEnviando(false);
    }
  };

  const registrar = async (c: CisternaConSaldo) => {
    if (enviando) return;
    if (form.destino === "tanque") {
      await registrarAlTanque(c);
      return;
    }
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
      onCerrar();
      await onRegistrado(
        res.status === 202
          ? `Sin conexión: la salida de ${formatear(cantidad)} ${c.unidad} a ${destino} quedó guardada en este equipo y se enviará sola cuando vuelva la señal.`
          : `Salida registrada: ${formatear(cantidad)} ${c.unidad} de la cisterna a ${destino}.`
      );
    } finally {
      setEnviando(false);
    }
  };

  const saldo = Number(elegida.saldo);
  const cantidad = Number(form.cantidad);
  const tanquetaElegida = tanquetas.find((t) => String(t.id) === form.tanqueta_id);
  // Un tanque recibe lo de la cisterna si es de la misma sede, producto y unidad.
  const tanquesDestino = tanques.filter(
    (t) =>
      t.activo &&
      t.grifo_interno_id === elegida.grifo_interno_id &&
      t.tipo_combustible === elegida.tipo_combustible &&
      t.unidad === elegida.unidad
  );
  const tanqueElegido = tanquesDestino.find((t) => String(t.id) === form.tanque_id);
  // null = el tanque no tiene varilla: sin ella no se sabe cuánto espacio queda.
  const libreDelTanque =
    tanqueElegido && tanqueElegido.nivel_teorico !== null
      ? Math.max(0, Number(tanqueElegido.capacidad_total) - Number(tanqueElegido.nivel_teorico))
      : null;
  const unidadDeTanqueta = (form.unidadTanqueta.tanqueta_equipo_id ?? "") !== "";
  const cantidadValida = cantidad > 0 && cantidad <= saldo + 0.001;
  const destinoCompleto =
    form.destino === "equipo"
      ? form.equipo_id !== "" && form.serie_talonario.trim() !== "" && Number(form.n_vale) > 0
      : form.destino === "tanque"
        ? form.tanque_id !== "" && libreDelTanque !== null && cantidad <= libreDelTanque + 0.001
        : form.tanqueta_id !== "" &&
          (tanquetaElegida ? cantidad <= tanquetaElegida.libre + 0.001 : true) &&
          (!unidadDeTanqueta ||
            ((form.unidadTanqueta.serie_talonario ?? "").trim() !== "" &&
              Number(form.unidadTanqueta.n_vale) > 0));
  const campo = "w-full border border-slate-200 rounded-xl p-3 text-sm";
  const etiqueta = "text-xs font-bold text-slate-700 uppercase";

  return (
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
            onClick={onCerrar}
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
                    tanque_id: "",
                    medidor: "",
                    unidadTanqueta: {},
                  })
                }
              >
                <option value="equipo">A una unidad</option>
                <option value="tanqueta">A una tanqueta</option>
                <option value="tanque">Al tanque</option>
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
          ) : form.destino === "tanque" ? (
            <div className="space-y-1">
              <label htmlFor="cis-tanque" className={etiqueta}>
                Tanque
              </label>
              <select
                id="cis-tanque"
                className={campo}
                value={form.tanque_id}
                onChange={(e) => cambiar({ tanque_id: e.target.value })}
              >
                <option value="">Elegir...</option>
                {tanquesDestino.map((t) => {
                  const libre =
                    t.nivel_teorico === null
                      ? null
                      : Math.max(0, Number(t.capacidad_total) - Number(t.nivel_teorico));
                  return (
                    <option key={t.id} value={t.id}>
                      {t.codigo} ·{" "}
                      {libre === null
                        ? "sin varilla"
                        : `libre ${formatear(Number(libre.toFixed(2)))}`}
                    </option>
                  );
                })}
              </select>
              {tanquesDestino.length === 0 && (
                <p className="text-xs text-amber-700">
                  No hay un tanque de esta sede con el mismo producto y unidad.
                </p>
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
                  : form.destino === "tanque" && tanqueElegido && libreDelTanque === null
                    ? `${tanqueElegido.codigo} no tiene lectura de varilla: registra una antes.`
                    : form.destino === "tanque" &&
                        tanqueElegido &&
                        libreDelTanque !== null &&
                        cantidad > libreDelTanque + 0.001
                      ? `${tanqueElegido.codigo} solo tiene espacio para ${formatear(Number(libreDelTanque.toFixed(2)))} ${elegida.unidad}.`
                      : !destinoCompleto
                        ? form.destino === "equipo"
                          ? "Elige la unidad y anota el vale."
                          : form.destino === "tanque"
                            ? "Elige el tanque."
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
            onClick={onCerrar}
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
            {enviando
              ? "Registrando..."
              : form.destino === "tanque"
                ? "Pasar al tanque"
                : "Registrar salida"}
          </button>
        </div>
      </div>
    </div>
  );
}
