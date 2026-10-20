// client/src/components/combustible/CompraEnRuta.tsx
//
// "Compra en ruta" (migración 0135): UNA boleta o factura con combustible,
// urea o los dos. El conductor compra en el mismo grifo y recibe un solo papel;
// registrarlo en dos formularios no cuadraba con el papel.
//
// Una sola llamada (POST /compras-ruta) crea los dos despachos y la cabecera
// con el cuadre: se guardan los dos o ninguno. Sirve sin señal: la compra y su
// foto quedan en la cola del dispositivo y se envían solas (offlineRegistry.ts).
//
// Cada sección pide SU permiso (compraEnRutaAcceso.ts); un conductor que solo
// registra una de las dos no ve la otra.
import { ClipboardCheck, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAuth } from "../../context/AuthContext";
import { apiFetch } from "../../services/apiClient";
import { mensajeDeError } from "../../utils/mensajeDeError";
import {
  ahoraParaInputLocal,
  estadoRenglones,
  nuevoRenglon,
  precioVigenteUrea,
  presentacionPorDefecto,
  presentacionesActivas,
} from "../ureaCompartido";
import {
  AvisoSinEnvases,
  BotonArchivo,
  ConductorDeLaUnidad,
  RenglonesUrea,
  type Equipo as EquipoUrea,
  type PrecioUrea,
  type PresentacionFila,
  type RenglonCompra,
} from "../UreaPanel";
import {
  borrarBorrador,
  guardarBorrador,
  leerBorrador,
  type BorradorCompraRuta,
} from "./borradorCompraRuta";
import { seccionesCompraEnRuta } from "./compraEnRutaAcceso";
import { prepararFotoComprobante } from "./fotoComprobante";
import HistorialComprasRuta from "./HistorialComprasRuta";

/** Lo mismo que el servidor tolera sin pedir motivo (TOLERANCIA_CUADRE_COMPRA_RUTA
 *  en combustible.schema.ts): el redondeo por línea. */
const TOLERANCIA_CENTAVOS = 10;

type TipoCombustible = "diesel_b5" | "gasolina_90" | "glp";
const ETIQUETA_COMBUSTIBLE: Record<TipoCombustible, string> = {
  diesel_b5: "Diésel B5",
  gasolina_90: "Gasolina 90",
  glp: "GLP",
};

interface EquipoCompra extends EquipoUrea {
  tipo_medidor?: "horometro" | "odometro" | null;
}

interface Proveedor {
  id: number;
  nombre: string;
}

interface UltimoMedidor {
  lectura_horometro: number | null;
  lectura_odometro: number | null;
  despachado_en: string;
}

const centavos = (n: number) => Math.round(n * 100);
const soles = (c: number) =>
  `S/ ${(c / 100).toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const CLASE_ETIQUETA = "text-[11px] font-bold text-slate-700 uppercase tracking-wide";
const CLASE_CAMPO =
  "w-full border border-slate-200 rounded-xl px-3 py-2 text-sm outline-none bg-white focus:ring-2 focus:ring-slate-900 disabled:opacity-50 disabled:cursor-not-allowed";

function Seccion({
  titulo,
  activa,
  onCambiar,
  children,
  textoInterruptor,
}: {
  titulo: string;
  /** undefined = la sección es obligatoria (el único producto que el usuario
   *  puede registrar): no hay interruptor. */
  activa?: boolean;
  onCambiar?: (activa: boolean) => void;
  textoInterruptor: string;
  children: React.ReactNode;
}) {
  const conInterruptor = activa !== undefined && onCambiar !== undefined;
  return (
    <section className="flex flex-col gap-3 border-t border-slate-200 py-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-800">{titulo}</h3>
        {conInterruptor && (
          <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-slate-600">
            <input
              type="checkbox"
              checked={activa}
              onChange={(e) => onCambiar(e.target.checked)}
              className="h-4 w-4 accent-[#BADC1E]"
            />
            {textoInterruptor}
          </label>
        )}
      </div>
      {(activa ?? true) && children}
    </section>
  );
}

function FormularioCompra({
  onRegistrada,
}: {
  /** La compra quedó registrada (o en la cola sin señal): la ventana se cierra y
   *  la página muestra este mensaje. */
  onRegistrada: (mensaje: string) => void;
}) {
  const { usuario } = useAuth();
  const secciones = useMemo(() => seccionesCompraEnRuta(usuario), [usuario]);
  const soloUna = secciones.combustible !== secciones.urea;

  // ── Datos de apoyo ──────────────────────────────────────────────────────
  const [equipos, setEquipos] = useState<EquipoCompra[]>([]);
  const [provCombustible, setProvCombustible] = useState<Proveedor[]>([]);
  const [provUrea, setProvUrea] = useState<Proveedor[]>([]);
  const [presentaciones, setPresentaciones] = useState<PresentacionFila[]>([]);
  const [preciosUrea, setPreciosUrea] = useState<PrecioUrea[]>([]);
  const [errorCarga, setErrorCarga] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    try {
      const [rEq, rComb, rUreaProv, rPres, rPrecios] = await Promise.all([
        apiFetch("/api/erp/combustible/equipos-destino?pageSize=200"),
        secciones.combustible
          ? apiFetch("/api/erp/combustible/grifos/para-formulario")
          : Promise.resolve(null),
        secciones.urea ? apiFetch("/api/erp/combustible/urea/proveedores") : Promise.resolve(null),
        secciones.urea
          ? apiFetch("/api/erp/combustible/urea/presentaciones")
          : Promise.resolve(null),
        secciones.urea ? apiFetch("/api/erp/combustible/urea/precios") : Promise.resolve(null),
      ]);
      const json = async (r: Response | null) => (r?.ok ? await r.json().catch(() => null) : null);
      const equiposBody = await json(rEq);
      setEquipos(Array.isArray(equiposBody?.data) ? equiposBody.data : []);
      const comb = await json(rComb);
      setProvCombustible(Array.isArray(comb) ? comb : []);
      const urea = await json(rUreaProv);
      setProvUrea(
        Array.isArray(urea)
          ? urea.filter((g: { abastece_urea_ruta?: boolean }) => g.abastece_urea_ruta)
          : []
      );
      const pres = await json(rPres);
      setPresentaciones(Array.isArray(pres) ? pres : []);
      const precios = await json(rPrecios);
      setPreciosUrea(Array.isArray(precios) ? precios : []);
      setErrorCarga(null);
    } catch {
      setErrorCarga(
        "No se pudieron cargar las unidades y proveedores. Revisa tu conexión y vuelve a abrir esta pantalla."
      );
    }
  }, [secciones.combustible, secciones.urea]);

  useEffect(() => {
    // Patrón estándar de carga al montar -- ver IpercView.tsx.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void cargar();
  }, [cargar]);

  // ── El formulario ───────────────────────────────────────────────────────
  // El uuid de la COMPRA: lo genera el dispositivo una vez. Reintentar el envío
  // (doble clic, cola offline) manda el mismo y no duplica nada.
  const [clienteUuid, setClienteUuid] = useState(() => crypto.randomUUID());
  const [equipoId, setEquipoId] = useState("");
  const [grifoId, setGrifoId] = useState("");
  const [comprobanteTipo, setComprobanteTipo] = useState<"boleta" | "factura">("boleta");
  const [comprobanteNumero, setComprobanteNumero] = useState("");
  const [fecha, setFecha] = useState(ahoraParaInputLocal());
  // Mismo criterio que el despacho: si nadie toca la hora, se manda el momento
  // real del envío, no el de cuando se abrió la pantalla.
  const [fechaEditada, setFechaEditada] = useState(false);
  const [foto, setFoto] = useState<File | null>(null);
  const [errorFoto, setErrorFoto] = useState<string | null>(null);

  const [incluyeCombustible, setIncluyeCombustible] = useState(secciones.combustible);
  const [incluyeUrea, setIncluyeUrea] = useState(!secciones.combustible && secciones.urea);

  const [tipoCombustible, setTipoCombustible] = useState<TipoCombustible>("diesel_b5");
  const [galones, setGalones] = useState("");
  const [costoUnitario, setCostoUnitario] = useState("");
  const [costoEditado, setCostoEditado] = useState(false);
  const [horometro, setHorometro] = useState("");
  const [odometro, setOdometro] = useState("");
  const [horas, setHoras] = useState("");
  const [horasEditadas, setHorasEditadas] = useState(false);
  const [medidorCargado, setMedidorCargado] = useState<{
    equipoId: string;
    ultimo: UltimoMedidor | null;
  } | null>(null);

  const activas = presentacionesActivas(presentaciones);
  const [renglones, setRenglones] = useState<RenglonCompra[]>(() => [nuevoRenglon("")]);
  // Las presentaciones llegan después de montar: el primer renglón toma la de
  // referencia apenas existe.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRenglones((rs) =>
      rs.length === 1 && rs[0].presentacion === "" && rs[0].cantidad === ""
        ? [nuevoRenglon(presentacionPorDefecto(presentaciones))]
        : rs
    );
  }, [presentaciones]);

  const [totalBoleta, setTotalBoleta] = useState("");
  const [motivo, setMotivo] = useState("");
  const [observaciones, setObservaciones] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── El borrador (borradorCompraRuta.ts) ─────────────────────────────────
  // Lo escrito se guarda en el dispositivo y se recupera al volver: si se cierra
  // la pantalla o se va la señal a mitad de la boleta, no se pierde. La foto no
  // entra (pesa); se avisa que hay que volver a elegirla.
  const usuarioId = usuario?.id;
  const [borradorListo, setBorradorListo] = useState(false);
  const [borradorRecuperadoEn, setBorradorRecuperadoEn] = useState<number | null>(null);
  // Lo último escrito, para guardarlo al instante si la pantalla pasa a segundo
  // plano: en el celular, cambiar de app puede matar la pestaña antes de que
  // venza la pausa del autoguardado.
  const datosDelBorrador = useRef<BorradorCompraRuta | null>(null);
  useEffect(() => {
    if (!usuarioId) return;
    const guardarYa = () => {
      if (document.visibilityState === "hidden" && datosDelBorrador.current) {
        guardarBorrador(usuarioId, datosDelBorrador.current);
      }
    };
    document.addEventListener("visibilitychange", guardarYa);
    window.addEventListener("pagehide", guardarYa);
    return () => {
      document.removeEventListener("visibilitychange", guardarYa);
      window.removeEventListener("pagehide", guardarYa);
      // Cerrar la ventana desmonta el formulario: lo último escrito se guarda ya,
      // sin esperar la pausa del autoguardado.
      if (datosDelBorrador.current) guardarBorrador(usuarioId, datosDelBorrador.current);
    };
  }, [usuarioId]);

  useEffect(() => {
    // Se lee UNA vez al montar. El autoguardado espera a `borradorListo`: sin
    // eso, el primer render (formulario vacío) borraría el borrador antes de
    // que se alcance a recuperar.
    /* eslint-disable react-hooks/set-state-in-effect */
    if (!usuarioId) return;
    const guardado = leerBorrador(usuarioId);
    if (guardado) {
      const d = guardado.datos;
      setClienteUuid(d.clienteUuid as ReturnType<typeof crypto.randomUUID>);
      setEquipoId(d.equipoId);
      setGrifoId(d.grifoId);
      setComprobanteTipo(d.comprobanteTipo);
      setComprobanteNumero(d.comprobanteNumero);
      setFecha(d.fecha);
      setFechaEditada(d.fechaEditada);
      // Un permiso que cambió desde que se guardó manda sobre el borrador.
      setIncluyeCombustible(d.incluyeCombustible && secciones.combustible);
      setIncluyeUrea(d.incluyeUrea && secciones.urea);
      setTipoCombustible(d.tipoCombustible as TipoCombustible);
      setGalones(d.galones);
      setCostoUnitario(d.costoUnitario);
      setCostoEditado(d.costoEditado);
      setHorometro(d.horometro);
      setOdometro(d.odometro);
      setHoras(d.horas);
      setHorasEditadas(d.horasEditadas);
      if (d.renglones.length > 0) setRenglones(d.renglones);
      setTotalBoleta(d.totalBoleta);
      setMotivo(d.motivo);
      setObservaciones(d.observaciones);
      setBorradorRecuperadoEn(guardado.guardadoEn);
    }
    setBorradorListo(true);
    /* eslint-enable react-hooks/set-state-in-effect */
    // Solo al montar con el usuario: las secciones no cambian en la sesión.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usuarioId]);

  useEffect(() => {
    if (!usuarioId || !borradorListo) return;
    const datos: BorradorCompraRuta = {
      clienteUuid,
      equipoId,
      grifoId,
      comprobanteTipo,
      comprobanteNumero,
      fecha,
      fechaEditada,
      incluyeCombustible,
      incluyeUrea,
      tipoCombustible,
      galones,
      costoUnitario,
      costoEditado,
      horometro,
      odometro,
      horas,
      horasEditadas,
      renglones,
      totalBoleta,
      motivo,
      observaciones,
    };
    datosDelBorrador.current = datos;
    // Con una pausa: escribir en el almacenamiento en cada tecla es trabajo
    // de más, y la última tecla es la que importa.
    const t = window.setTimeout(() => guardarBorrador(usuarioId, datos), 400);
    return () => window.clearTimeout(t);
  }, [
    usuarioId,
    borradorListo,
    clienteUuid,
    equipoId,
    grifoId,
    comprobanteTipo,
    comprobanteNumero,
    fecha,
    fechaEditada,
    incluyeCombustible,
    incluyeUrea,
    tipoCombustible,
    galones,
    costoUnitario,
    costoEditado,
    horometro,
    odometro,
    horas,
    horasEditadas,
    renglones,
    totalBoleta,
    motivo,
    observaciones,
  ]);

  const equipo = equipos.find((e) => String(e.id) === equipoId);
  const midePorHorometro = equipo?.tipo_medidor === "horometro";
  const midePorOdometro = equipo?.tipo_medidor === "odometro";

  // El proveedor tiene que vender lo que se compra: con las dos secciones, los
  // que venden las dos cosas en ruta; con una, los de esa. El servidor vuelve a
  // validarlo (validarRolGrifo).
  const proveedores = useMemo(() => {
    if (incluyeCombustible && incluyeUrea) {
      const ids = new Set(provUrea.map((p) => p.id));
      return provCombustible.filter((p) => ids.has(p.id));
    }
    return incluyeUrea ? provUrea : provCombustible;
  }, [incluyeCombustible, incluyeUrea, provCombustible, provUrea]);
  const grifoVigente = proveedores.some((p) => String(p.id) === grifoId) ? grifoId : "";

  // ── La hora y el precio de catálogo ─────────────────────────────────────
  const fechaIso = () => (fechaEditada ? new Date(fecha).toISOString() : new Date().toISOString());

  // Autocompleta el C.U. con el precio vigente A LA FECHA de la compra (un vale
  // offline se carga horas antes de sincronizar). Nunca pisa lo tipeado.
  useEffect(() => {
    if (!incluyeCombustible || costoEditado || !grifoVigente) return;
    const params = new URLSearchParams({
      tipo_combustible: tipoCombustible,
      fecha: fechaEditada ? new Date(fecha).toISOString() : new Date().toISOString(),
      grifo_id: grifoVigente,
    });
    let cancelado = false;
    apiFetch(`/api/erp/combustible/precios/vigente-formulario?${params.toString()}`)
      .then((res) => res.json())
      .then((body) => {
        if (!cancelado && body?.precio) setCostoUnitario(String(body.precio.precio_unitario));
      })
      .catch(() => {
        // Sin precio cargado o sin red: el campo queda manual.
      });
    return () => {
      cancelado = true;
    };
  }, [incluyeCombustible, costoEditado, grifoVigente, tipoCombustible, fecha, fechaEditada]);

  // La carga anterior de la unidad: con ella las horas abastecidas salen solas.
  useEffect(() => {
    if (!incluyeCombustible || equipoId === "") return;
    let cancelado = false;
    const antes = fechaEditada
      ? `?antes_de=${encodeURIComponent(new Date(fecha).toISOString())}`
      : "";
    apiFetch(`/api/erp/combustible/equipos/${equipoId}/ultimo-medidor${antes}`)
      .then(async (res) => {
        if (!res.ok) return;
        const cuerpo = (await res.json()) as { ultimo: UltimoMedidor | null };
        if (!cancelado) setMedidorCargado({ equipoId, ultimo: cuerpo.ultimo });
      })
      .catch(() => {});
    return () => {
      cancelado = true;
    };
  }, [incluyeCombustible, equipoId, fecha, fechaEditada]);

  const ultimo = medidorCargado?.equipoId === equipoId ? medidorCargado.ultimo : undefined;
  const horometroAnterior = ultimo?.lectura_horometro ?? null;
  const horometroActual = horometro === "" ? null : Number(horometro);
  const horometroValido = horometroActual !== null && Number.isFinite(horometroActual);
  const horometroRetrocede =
    midePorHorometro && horometroAnterior !== null && horometroValido
      ? horometroActual < horometroAnterior
      : false;
  const horasSugeridas =
    midePorHorometro && horometroAnterior !== null && horometroValido && !horometroRetrocede
      ? Math.round((horometroActual - horometroAnterior) * 100) / 100
      : null;
  const horasMostradas = horasEditadas
    ? horas
    : horasSugeridas === null
      ? ""
      : String(horasSugeridas);

  // ── Totales y cuadre ────────────────────────────────────────────────────
  const totalCombustibleC = incluyeCombustible
    ? centavos(Number(galones || 0) * Number(costoUnitario || 0))
    : 0;
  const totalUreaC = incluyeUrea
    ? renglones.reduce((a, r) => a + centavos(Number(r.cantidad || 0) * Number(r.precio || 0)), 0)
    : 0;
  const totalSistemaC = totalCombustibleC + totalUreaC;
  const hayTotalBoleta = totalBoleta.trim() !== "" && Number.isFinite(Number(totalBoleta));
  const totalBoletaC = hayTotalBoleta ? centavos(Number(totalBoleta)) : 0;
  const diferenciaC = totalBoletaC - totalSistemaC;
  const cuadra = Math.abs(diferenciaC) <= TOLERANCIA_CENTAVOS;
  const pideMotivo = false;

  const urea = estadoRenglones(renglones, true);
  // Qué falta para poder registrar, en palabras: un botón apagado sin decir por
  // qué hace pensar que lo que falta es la foto (que es opcional).
  const faltantes: string[] = [];
  if (equipoId === "") faltantes.push("la unidad");
  if (grifoVigente === "") faltantes.push("el proveedor");
  if (!incluyeCombustible && !incluyeUrea) faltantes.push("combustible o urea");
  if (incluyeCombustible) {
    if (!(Number(galones) > 0)) faltantes.push("los galones");
    if (!(Number(costoUnitario) > 0)) faltantes.push("el C.U. del combustible");
    if (equipo && !equipo.tipo_medidor) {
      faltantes.push("el tipo de medidor de la unidad (se configura en Equipos)");
    } else if ((midePorOdometro ? odometro : horometro) === "" && equipo) {
      faltantes.push("la lectura del medidor");
    }
    if (horasMostradas === "") faltantes.push("las horas abastecidas");
  }
  if (incluyeUrea) {
    if (activas.length === 0) faltantes.push("un envase de urea activo");
    else if (!urea.listos) faltantes.push("cantidad y precio de la urea");
  }
  if (comprobanteNumero.trim() === "") faltantes.push("el N° del comprobante");
  if (pideMotivo && motivo.trim() === "") faltantes.push("el motivo de la diferencia");
  const puedeEnviar = !enviando && faltantes.length === 0;

  // ── Foto ────────────────────────────────────────────────────────────────
  /** JPG/PNG o PDF, comprimida en el teléfono antes de subir (la señal en ruta
   *  es mala), máximo 6 MB: lo mismo que las compras sueltas. */
  const elegirFoto = async (archivo: File | undefined) => {
    setErrorFoto(null);
    if (!archivo) {
      setFoto(null);
      return;
    }
    const r = await prepararFotoComprobante(archivo);
    if ("error" in r) {
      setErrorFoto(r.error);
      setFoto(null);
      return;
    }
    setFoto(r.lista);
  };

  // ── Envío ───────────────────────────────────────────────────────────────
  const limpiar = () => {
    if (usuarioId) borrarBorrador(usuarioId);
    datosDelBorrador.current = null;
    setBorradorRecuperadoEn(null);
    setClienteUuid(crypto.randomUUID());
    setEquipoId("");
    setGrifoId("");
    setComprobanteTipo("boleta");
    setComprobanteNumero("");
    setFecha(ahoraParaInputLocal());
    setFechaEditada(false);
    setFoto(null);
    setErrorFoto(null);
    setIncluyeCombustible(secciones.combustible);
    setIncluyeUrea(!secciones.combustible && secciones.urea);
    setTipoCombustible("diesel_b5");
    setGalones("");
    setCostoUnitario("");
    setCostoEditado(false);
    setHorometro("");
    setOdometro("");
    setHoras("");
    setHorasEditadas(false);
    setMedidorCargado(null);
    setRenglones([nuevoRenglon(presentacionPorDefecto(presentaciones))]);
    setTotalBoleta("");
    setMotivo("");
    setObservaciones("");
    setError(null);
  };

  const enviar = async (e: React.FormEvent) => {
    e.preventDefault();
    // El botón bloqueado no alcanza: un segundo toque entra antes de que
    // React repinte. El uuid igual impediría el duplicado, pero evitamos el
    // viaje.
    if (!puedeEnviar) return;
    setEnviando(true);
    setError(null);
    try {
      const body = {
        cliente_uuid: clienteUuid,
        grifo_id: Number(grifoVigente),
        comprobante_tipo: comprobanteTipo,
        comprobante_numero: comprobanteNumero.trim(),
        equipo_id: Number(equipoId),
        despachado_en: fechaIso(),
        total_boleta: hayTotalBoleta ? Number(totalBoleta) : totalSistemaC / 100,
        motivo_descuadre: pideMotivo ? motivo.trim() : undefined,
        observaciones: observaciones.trim() || undefined,
        combustible: incluyeCombustible
          ? {
              tipo_combustible: tipoCombustible,
              cantidad: Number(galones),
              costo_unitario: Number(costoUnitario),
              lectura_horometro: midePorHorometro ? Number(horometro) : undefined,
              lectura_odometro: midePorOdometro ? Number(odometro) : undefined,
              horas_abastecidas: Number(horasMostradas),
            }
          : undefined,
        urea: incluyeUrea
          ? {
              // POR BULTO cada uno: el servidor resuelve el factor de cada
              // presentación y suma los litros.
              lineas: renglones.map((r) => ({
                presentacion: r.presentacion,
                cantidad_bultos: Number(r.cantidad),
                costo_unitario: Number(r.precio),
              })),
            }
          : undefined,
      };
      const res = await apiFetch("/api/erp/combustible/compras-ruta", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      // 202 = sin red: quedó en la cola del dispositivo y se envía sola.
      if (!res.ok && res.status !== 202) {
        const cuerpo = await res.json().catch(() => null);
        setError(mensajeDeError(cuerpo, "No se pudo registrar la compra."));
        return;
      }

      // La foto va DESPUÉS y apunta a la compra por su uuid: sin señal, la
      // compra todavía no tiene id. La cola drena en orden.
      let resultadoFoto: "subida" | "encolada" | "fallo" | "sin_foto" = "sin_foto";
      if (foto) {
        const formData = new FormData();
        formData.append("archivo", foto);
        // El uuid de ESTA entrada de la cola, distinto al de la compra.
        formData.append("cliente_uuid", crypto.randomUUID());
        try {
          const rf = await apiFetch(
            `/api/erp/combustible/compras-ruta/por-uuid/${clienteUuid}/comprobante`,
            { method: "POST", body: formData }
          );
          resultadoFoto = rf.status === 202 ? "encolada" : rf.ok ? "subida" : "fallo";
        } catch {
          resultadoFoto = "fallo";
        }
      }

      const papel = `la ${comprobanteTipo} ${comprobanteNumero.trim()}`;
      const mensaje =
        res.status === 202
          ? `Sin conexión: ${papel} quedó guardada en este equipo y se enviará sola${foto ? ", con su foto," : ""} cuando vuelva la señal.`
          : resultadoFoto === "sin_foto"
            ? `Compra registrada (${papel}). Tienes 24 horas para adjuntar la foto desde el historial.`
            : resultadoFoto === "fallo"
              ? `Compra registrada (${papel}), pero la foto NO se pudo subir: adjúntala desde el historial.`
              : resultadoFoto === "encolada"
                ? `Compra registrada (${papel}). La foto se enviará cuando vuelva la señal.`
                : `Compra registrada (${papel}), con su comprobante.`;
      // Primero limpiar (borra el borrador) y recién después avisar: avisar cierra
      // la ventana y desmonta este formulario.
      limpiar();
      // El historial unificado muestra la boleta nueva.
      window.dispatchEvent(new Event("combustible:actualizado"));
      onRegistrada(mensaje);
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="px-5 pb-1 pt-4">
      {borradorRecuperadoEn !== null && (
        <div
          role="status"
          className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
        >
          <span>
            Recuperamos lo que estabas escribiendo (guardado a las{" "}
            {new Date(borradorRecuperadoEn).toLocaleTimeString("es-PE", {
              hour: "2-digit",
              minute: "2-digit",
            })}
            ). La foto no se guarda: vuelve a elegirla.
          </span>
          <button
            type="button"
            onClick={limpiar}
            className="rounded-lg border border-amber-300 px-3 py-1 text-xs font-semibold hover:bg-amber-100"
          >
            Empezar de cero
          </button>
        </div>
      )}
      {errorCarga && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {errorCarga}
        </div>
      )}

      <form onSubmit={enviar} noValidate>
        <Seccion titulo="Unidad y proveedor" textoInterruptor="">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className={CLASE_ETIQUETA}>Unidad</span>
              <select
                id="compra-unidad"
                className={CLASE_CAMPO}
                value={equipoId}
                onChange={(e) => {
                  // Otra unidad, otro contexto: lo escrito para la anterior no aplica.
                  setEquipoId(e.target.value);
                  setHorasEditadas(false);
                  setHorometro("");
                  setOdometro("");
                }}
              >
                <option value="">Elegir unidad</option>
                {equipos.map((eq) => (
                  <option key={eq.id} value={eq.id}>
                    {eq.placa_codigo} — {eq.tipo}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className={CLASE_ETIQUETA}>Proveedor</span>
              <select
                id="compra-proveedor"
                className={CLASE_CAMPO}
                value={grifoVigente}
                onChange={(e) => {
                  setGrifoId(e.target.value);
                  setCostoEditado(false);
                  // El precio de catálogo de la urea es por proveedor.
                  setRenglones((rs) =>
                    rs.map((r) => {
                      if (!r.precioAuto) return r;
                      const v = precioVigenteUrea(
                        preciosUrea,
                        e.target.value,
                        r.presentacion,
                        fechaEditada ? fecha : ""
                      );
                      return { ...r, precio: v ? String(Number(v.precio_por_bulto)) : "" };
                    })
                  );
                }}
              >
                <option value="">Elegir proveedor</option>
                {proveedores.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.nombre}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {equipo && incluyeUrea && <ConductorDeLaUnidad equipo={equipo} />}
          {equipoId !== "" && incluyeCombustible && !equipo?.tipo_medidor && (
            <p className="text-xs text-red-600">
              Esta unidad no tiene tipo de medidor (horómetro/odómetro). Configúralo en Equipos
              antes de continuar.
            </p>
          )}
          {proveedores.length === 0 && (
            <p className="text-xs text-amber-700">
              {incluyeCombustible && incluyeUrea
                ? "Ningún proveedor vende combustible y urea en ruta a la vez. Registra cada producto por separado o pídele a un administrador que marque el proveedor."
                : "No hay proveedores marcados para esto. Pídele a un administrador que los marque en Combustible → Proveedores."}
            </p>
          )}
        </Seccion>

        {secciones.combustible && (
          <Seccion
            titulo="Combustible"
            activa={soloUna ? undefined : incluyeCombustible}
            onCambiar={soloUna ? undefined : setIncluyeCombustible}
            textoInterruptor="Incluye combustible"
          >
            <div className="grid grid-cols-6 gap-3">
              <label className="col-span-3 flex flex-col gap-1">
                <span className={CLASE_ETIQUETA}>Combustible</span>
                <select
                  id="compra-tipo-combustible"
                  className={CLASE_CAMPO}
                  value={tipoCombustible}
                  onChange={(e) => {
                    setTipoCombustible(e.target.value as TipoCombustible);
                    setCostoEditado(false);
                  }}
                >
                  {(Object.keys(ETIQUETA_COMBUSTIBLE) as TipoCombustible[]).map((t) => (
                    <option key={t} value={t}>
                      {ETIQUETA_COMBUSTIBLE[t]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="col-span-3 flex flex-col gap-1">
                <span className={CLASE_ETIQUETA}>Galones</span>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  id="compra-galones"
                  className={CLASE_CAMPO}
                  value={galones}
                  onChange={(e) => setGalones(e.target.value)}
                />
              </label>
              <label className="col-span-2 flex flex-col gap-1">
                <span className={CLASE_ETIQUETA}>{midePorOdometro ? "Odómetro" : "Horómetro"}</span>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  disabled={!equipo?.tipo_medidor}
                  id="compra-medidor"
                  className={CLASE_CAMPO}
                  value={midePorOdometro ? odometro : horometro}
                  onChange={(e) =>
                    midePorOdometro ? setOdometro(e.target.value) : setHorometro(e.target.value)
                  }
                />
              </label>
              <label className="col-span-2 flex flex-col gap-1">
                <span className={CLASE_ETIQUETA}>C.U. (S/ gal)</span>
                <input
                  type="number"
                  min={0}
                  step="0.0001"
                  id="compra-costo-unitario"
                  className={CLASE_CAMPO}
                  value={costoUnitario}
                  onChange={(e) => {
                    setCostoUnitario(e.target.value);
                    setCostoEditado(true);
                  }}
                />
              </label>
              <label className="col-span-2 flex flex-col gap-1">
                <span className={CLASE_ETIQUETA}>C. total</span>
                <input
                  readOnly
                  className={CLASE_CAMPO}
                  value={totalCombustibleC > 0 ? soles(totalCombustibleC) : "—"}
                />
              </label>
              <label className="col-span-6 flex flex-col gap-1">
                <span className={CLASE_ETIQUETA}>Horas abastecidas (desde la carga anterior)</span>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  id="compra-horas"
                  className={CLASE_CAMPO}
                  value={horasMostradas}
                  onChange={(e) => {
                    // Vaciarlo devuelve el campo al cálculo automático.
                    setHorasEditadas(e.target.value !== "");
                    setHoras(e.target.value);
                  }}
                />
                {midePorHorometro && ultimo !== undefined && (
                  <span
                    className={`text-xs ${horometroRetrocede ? "text-amber-600" : "text-slate-400"}`}
                  >
                    {horometroAnterior === null
                      ? "No hay una carga anterior con horómetro de esta unidad: escribe las horas a mano."
                      : horometroRetrocede
                        ? `La lectura es menor que la de la carga anterior (${horometroAnterior.toLocaleString("es-PE")} h). Revísala; si es correcta, escribe las horas a mano.`
                        : `Carga anterior: ${horometroAnterior.toLocaleString("es-PE")} h. Las horas se calculan solas; puedes corregirlas.`}
                  </span>
                )}
              </label>
            </div>
            <p className="text-xs text-slate-400">
              El costo se autocompleta con el precio vigente a la fecha. Puedes corregirlo si ese
              día pagaste distinto.
            </p>
          </Seccion>
        )}

        {secciones.urea && (
          <Seccion
            titulo="Urea"
            activa={soloUna ? undefined : incluyeUrea}
            onCambiar={soloUna ? undefined : setIncluyeUrea}
            textoInterruptor="Incluye urea"
          >
            {activas.length === 0 && <AvisoSinEnvases />}
            <RenglonesUrea
              renglones={renglones}
              setRenglones={setRenglones}
              activas={activas}
              conPrecio
              vigentePara={(codigo) =>
                precioVigenteUrea(preciosUrea, grifoVigente, codigo, fechaEditada ? fecha : "")
              }
              titulo="Qué se compró"
            />
            <p className="text-xs text-slate-400">
              La urea comprada en ruta no baja el stock del almacén: nunca pasó por el depósito.
            </p>
          </Seccion>
        )}

        <Seccion titulo="Datos de la boleta" textoInterruptor="">
          <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-3">
            <label className="flex flex-col gap-1">
              <span className={CLASE_ETIQUETA}>Comprobante</span>
              <select
                id="compra-comprobante-tipo"
                className={CLASE_CAMPO}
                value={comprobanteTipo}
                onChange={(e) => setComprobanteTipo(e.target.value as "boleta" | "factura")}
              >
                <option value="boleta">Boleta</option>
                <option value="factura">Factura</option>
              </select>
            </label>
            <label className="flex min-w-0 flex-col gap-1">
              <span className={CLASE_ETIQUETA}>N° del comprobante</span>
              <input
                id="compra-comprobante-numero"
                className={CLASE_CAMPO}
                value={comprobanteNumero}
                onChange={(e) => setComprobanteNumero(e.target.value)}
                placeholder="Ej. B001-00012345"
              />
            </label>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className={CLASE_ETIQUETA}>Fecha y hora</span>
              <input
                type="datetime-local"
                id="compra-fecha"
                className={CLASE_CAMPO}
                value={fecha}
                onChange={(e) => {
                  setFecha(e.target.value);
                  setFechaEditada(true);
                }}
              />
            </label>
            <div className="flex flex-col gap-1">
              <span className={CLASE_ETIQUETA}>
                Foto o PDF de la boleta (opcional ahora; 24 h para subirla)
              </span>
              <BotonArchivo
                archivo={foto}
                onElegir={elegirFoto}
                texto="Subir foto de la boleta"
                destacado
              />
              {errorFoto && <span className="text-xs text-red-600">{errorFoto}</span>}
            </div>
          </div>
        </Seccion>

        <Seccion titulo="Cuadre con el papel" textoInterruptor="">
          <div className="grid grid-cols-3 gap-2">
            {[
              ["Combustible", totalCombustibleC],
              ["Urea", totalUreaC],
              ["Suma del sistema", totalSistemaC],
            ].map(([nombre, valor]) => (
              <div key={nombre as string} className="rounded-xl border border-slate-200 p-2">
                <span className="block text-[10px] font-bold uppercase tracking-wide text-slate-500">
                  {nombre}
                </span>
                <span className="text-sm font-bold tabular-nums text-slate-800">
                  {soles(valor as number)}
                </span>
              </div>
            ))}
          </div>
          <label className="flex flex-col gap-1">
            <span className={CLASE_ETIQUETA}>Total de la boleta (opcional)</span>
            <input
              type="number"
              min={0}
              step="0.01"
              id="compra-total-boleta"
              className={CLASE_CAMPO}
              value={totalBoleta}
              onChange={(e) => setTotalBoleta(e.target.value)}
              placeholder="Ej. 745.00"
            />
          </label>
          {!hayTotalBoleta ? (
            <p className="rounded-xl border border-slate-200 px-3 py-2 text-xs text-slate-500">
              Si quieres, escribe el total del papel; si no, se guarda la suma del sistema.
            </p>
          ) : cuadra ? (
            <p
              role="status"
              className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800"
            >
              Cuadra: la boleta coincide con lo registrado.
            </p>
          ) : (
            <p className="rounded-xl border border-slate-200 px-3 py-2 text-xs text-slate-500">
              El grifo maneja su propio precio: se guarda el total de la boleta y la diferencia (
              {soles(Math.abs(diferenciaC))}) queda registrada.
            </p>
          )}
          <label className="flex flex-col gap-1">
            <span className={CLASE_ETIQUETA}>Observaciones (opcional)</span>
            <input
              className={CLASE_CAMPO}
              value={observaciones}
              onChange={(e) => setObservaciones(e.target.value)}
            />
          </label>
        </Seccion>

        {error && (
          <div role="alert" className="mb-3 rounded-xl bg-red-50 p-3 text-sm text-red-700">
            {error}
          </div>
        )}
        {faltantes.length > 0 && !enviando && (
          <div
            role="status"
            className="mb-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
          >
            <strong>Para registrar falta:</strong> {faltantes.join(", ")}.
            <span className="mt-1 block text-xs">
              La foto de la boleta es opcional: puedes subirla después desde el historial.
            </span>
          </div>
        )}
        <div className="flex justify-end gap-2 border-t border-slate-200 py-4">
          <button
            type="button"
            onClick={limpiar}
            disabled={enviando}
            className="rounded-xl px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            Limpiar
          </button>
          <button
            type="submit"
            disabled={!puedeEnviar}
            className="rounded-xl border border-[#BADC1E] bg-[#BADC1E] px-5 py-2 text-sm font-semibold text-[#0A1014] hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {enviando ? "Guardando…" : "Registrar compra"}
          </button>
        </div>
      </form>
    </div>
  );
}

/** La pantalla "Compra en ruta": el historial de las boletas en primer plano y un
 *  botón para registrar una nueva, que abre el formulario en una ventana. Es lo
 *  mismo que ve el conductor en Tanques, con el botón de registrar. */
export default function CompraEnRuta() {
  const { usuario } = useAuth();
  const secciones = useMemo(() => seccionesCompraEnRuta(usuario), [usuario]);
  const [abierto, setAbierto] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);

  useEffect(() => {
    if (!abierto) return;
    const alTeclear = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAbierto(false);
    };
    window.addEventListener("keydown", alTeclear);
    return () => window.removeEventListener("keydown", alTeclear);
  }, [abierto]);

  if (!secciones.combustible && !secciones.urea) {
    return (
      <div className="p-6 text-sm text-slate-500">
        Tu perfil no registra compras en ruta. Si lo necesitas, pídeselo a un administrador.
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 flex flex-col gap-4 lg:mb-10 lg:flex-row lg:items-center lg:justify-between lg:gap-6">
        <div className="shrink-0">
          <h1 className="text-lg font-extrabold tracking-tight text-white sm:text-xl lg:text-2xl">
            Compra en ruta
          </h1>
          <p className="text-xs text-[#94a3b8] sm:text-sm">
            {secciones.combustible && secciones.urea
              ? "Una sola boleta o factura, aunque hayas comprado combustible y urea juntos."
              : "Tus boletas o facturas de lo que compraste en el viaje."}
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setAviso(null);
            setAbierto(true);
          }}
          className="flex items-center gap-2 whitespace-nowrap rounded-lg border border-[#a3e635] bg-[#192526] px-3 py-2 text-sm font-semibold text-white transition-all hover:bg-[#0D1719] active:scale-95"
        >
          <ClipboardCheck className="h-4 w-4 shrink-0" /> Registrar compra
        </button>
      </div>

      {aviso && (
        <div
          role="status"
          className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800"
        >
          {aviso}
        </div>
      )}

      <HistorialComprasRuta />

      {abierto && (
        // Cerrar NO borra lo escrito: el borrador se guarda al desmontar. Por eso
        // tocar fuera de la ventana no la cierra (en el celular, un toque de más
        // no debe tirar la ventana); se cierra con la X, Escape o al registrar.
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 sm:p-6">
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Registrar compra en ruta"
            className="w-full max-w-xl bg-white shadow-xl sm:rounded-2xl"
          >
            <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-5 py-3 sm:rounded-t-2xl">
              <h2 className="text-lg font-bold text-slate-800">Registrar compra en ruta</h2>
              <button
                type="button"
                onClick={() => setAbierto(false)}
                aria-label="Cerrar"
                className="rounded-lg p-1 text-slate-500 hover:bg-slate-100"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <FormularioCompra
              onRegistrada={(mensaje) => {
                setAviso(mensaje);
                setAbierto(false);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
