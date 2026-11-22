// client/src/components/proveedores/proveedoresApi.ts
//
// Lectura del ecosistema «Gestión de proveedores» (/api/erp/proveedores). PR1: solo GET.
import { apiFetch } from "../../services/apiClient";

export type TipoProveedor = "Combustible" | "Urea";

export interface Proveedor {
  id: number;
  codigo: string;
  nombre: string;
  ruc: string | null;
  activo: boolean;
  tipos: TipoProveedor[];
  combustible: { interno: boolean; externo: boolean };
  urea: { interno: boolean; externo: boolean };
}

export interface PrecioDelDirectorio {
  producto: string;
  precio: number;
  unidad: string;
}

/** Una fila del Directorio: el proveedor más lo que pide la maqueta (ciudad, ficha completa y precio). */
export interface ProveedorEnDirectorio extends Proveedor {
  ciudad: string | null;
  fichaCompleta: { porcentaje: number; faltan: string[] };
  /** Ausente si esta persona no ve precios; `null` si el proveedor no tiene ninguno vigente. */
  precioVigente?: PrecioDelDirectorio | null;
}

export interface ResumenProveedores {
  total: number;
  activos: number;
  inactivos: number;
  combustible: number;
  urea: number;
  internos: number;
  externos: number;
}

async function leer<T>(ruta: string): Promise<T> {
  const res = await apiFetch(`/api/erp/proveedores${ruta}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || data.error || `No se pudo cargar (HTTP ${res.status})`);
  }
  return data as T;
}

export const listarProveedores = () => leer<ProveedorEnDirectorio[]>("");
export const resumenProveedores = () => leer<ResumenProveedores>("/resumen");

/** Lo que se carga al registrar o editar un proveedor. INTERNO es la compra para despachar desde la
 *  planta (`tanque`, y `urea` para la del almacén) y EXTERNO la que se hace en ruta. */
export interface DatosProveedor {
  nombre: string;
  /** "" = sin RUC. */
  ruc: string;
  abastece_tanque: boolean;
  abastece_ruta: boolean;
  abastece_urea: boolean;
  abastece_urea_ruta: boolean;
}

async function enviar<T>(
  ruta: string,
  metodo: "POST" | "PUT" | "PATCH",
  cuerpo?: object
): Promise<T> {
  const res = await apiFetch(`/api/erp/proveedores${ruta}`, {
    method: metodo,
    headers: { "Content-Type": "application/json" },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      data.errors?.[0]?.message ||
        data.message ||
        data.error ||
        `No se pudo guardar (HTTP ${res.status})`
    );
  }
  return data as T;
}

export const crearProveedor = (datos: DatosProveedor) => enviar<Proveedor>("", "POST", datos);
export const actualizarProveedor = (id: number, datos: DatosProveedor & { activo: boolean }) =>
  enviar<Proveedor>(`/${id}`, "PUT", datos);

// ── Gestión comercial: precios de proveedores (solo lectura) ─────────────────────────────────────

export interface EntradaPrecio {
  id: number;
  precio: number;
  /** ISO 8601. */
  desde: string;
  por: string | null;
  marca: string | null;
  anulado: boolean;
  motivo: string | null;
}

export interface FilaPrecio {
  clave: string;
  proveedorId: number;
  proveedorCodigo: string;
  proveedorNombre: string;
  proveedorActivo: boolean;
  producto: "combustible" | "urea";
  codigo: string;
  /** «Diésel B5» o «Caja (20 L)». */
  detalle: string;
  /** «galón» o «envase». */
  unidad: string;
  vigente: EntradaPrecio | null;
  anterior: EntradaPrecio | null;
  programado: EntradaPrecio | null;
  historial: EntradaPrecio[];
}

export interface RespuestaPrecios {
  /** Qué productos puede ver esta persona. */
  combustible: boolean;
  urea: boolean;
  filas: FilaPrecio[];
}

export const listarPrecios = () => leer<RespuestaPrecios>("/precios");

// ── Compras y recepciones (solo lectura): las compras de cisterna de Combustible ───────────────────

export type TipoCombustibleCompra = "diesel_b5" | "gasolina_90" | "glp";

export type EstadoCompra = "registrada" | "por_llegar" | "recibida" | "anulada";

export interface RecepcionDeCompra {
  id: number;
  /** ISO 8601. */
  recibidoEn: string;
  /** Lo que entró al tanque más lo repartido. */
  descargado: number;
  unidad: string;
  /** Descargado menos lo que dice el documento, en galones (negativo: llegó menos). */
  diferenciaGalones: number;
  fueraDeTolerancia: boolean;
}

export interface CompraDeCisterna {
  id: number;
  estado: EstadoCompra;
  proveedorId: number;
  proveedorCodigo: string;
  proveedorNombre: string;
  /** `diesel_b5`, `gasolina_90` o `glp`. */
  tipoCombustible: TipoCombustibleCompra;
  combustible: string;
  unidad: string;
  tipoDocumento: string;
  numeroDocumento: string;
  fechaCompra: string;
  llegadaEstimada: string;
  cantidadFacturada: number;
  costoUnitario: number;
  total: number;
  placa: string | null;
  chofer: string | null;
  transportista: string | null;
  transportistaRuc: string | null;
  habilitada: boolean;
  motivoAnulacion: string | null;
  recepcion: RecepcionDeCompra | null;
}

export interface RespuestaCompras {
  /** Si gestiona compras ve todas; si no, solo las ya por llegar (como en Cisternas). */
  gestiona: boolean;
  /** Galones de diferencia que la empresa tolera. */
  tolerancia: number;
  compras: CompraDeCisterna[];
}

export const listarCompras = () => leer<RespuestaCompras>("/compras");

// ── Registrar, habilitar y anular compras (PR5b) ────────────────────────────────────────────────────

/** Lo que trae el formulario: proveedores de tanque activos, las sedes que puede elegir esta persona y el
 *  precio de compra que rige hoy por proveedor y combustible. */
export interface DatosFormularioCompra {
  proveedores: { id: number; nombre: string }[];
  sedes: { id: number; nombre: string; sede: string }[];
  precios: { grifo_id: number; tipo_combustible: TipoCombustibleCompra; precio_unitario: string }[];
}

export interface CuerpoCompra {
  /** Se fija al abrir el formulario: un reintento no crea una segunda compra. */
  cliente_uuid: string;
  grifo_interno_id: number;
  grifo_id: number;
  tipo_combustible: TipoCombustibleCompra;
  unidad: "gal" | "L";
  tipo_documento: "factura" | "guia_remision";
  numero_documento: string;
  fecha_compra: string;
  llegada_estimada: string;
  cantidad_facturada: number;
  costo_unitario: number;
  transportista?: string;
  transportista_ruc?: string;
}

export const datosFormularioCompra = () => leer<DatosFormularioCompra>("/compras/formulario");
export const registrarCompra = (cuerpo: CuerpoCompra) =>
  enviar<CompraDeCisterna>("/compras", "POST", cuerpo);
export const habilitarCompra = (id: number) =>
  enviar<CompraDeCisterna>(`/compras/${id}/habilitar`, "PATCH");
export const anularCompra = (id: number, motivo: string) =>
  enviar<CompraDeCisterna>(`/compras/${id}/anular`, "PATCH", { motivo });

// ── Cargar y anular precios de proveedores (PR4b) ───────────────────────────────────────────────

export type TipoCombustibleDePrecio = TipoCombustibleCompra;

/** Lo que trae el formulario: a qué proveedores y presentaciones se les puede poner precio, según los
 *  permisos de esta persona (`combustible` / `urea` dicen qué productos puede cargar). */
export interface DatosFormularioPrecio {
  combustible: boolean;
  urea: boolean;
  proveedoresCombustible: { id: number; nombre: string }[];
  proveedoresUrea: { id: number; nombre: string }[];
  presentaciones: { codigo: string; nombre: string; litros: string | null }[];
}

export interface CuerpoPreciosCombustible {
  tipo_combustible: TipoCombustibleDePrecio;
  grifo_ids: number[];
  precio_unitario: number;
  /** ISO 8601; ausente = rige desde ahora. */
  vigente_desde?: string;
}

export interface CuerpoPrecioUrea {
  grifo_id: number;
  presentacion: string;
  marca?: string;
  precio_por_bulto: number;
  vigente_desde?: string;
}

export const datosFormularioPrecio = () => leer<DatosFormularioPrecio>("/precios/formulario");
export const cargarPreciosCombustible = (cuerpo: CuerpoPreciosCombustible) =>
  enviar<unknown>("/precios/combustible", "POST", cuerpo);
export const cargarPrecioUrea = (cuerpo: CuerpoPrecioUrea) =>
  enviar<unknown>("/precios/urea", "POST", cuerpo);
export const anularPrecio = (producto: "combustible" | "urea", id: number, motivo: string) =>
  enviar<unknown>(`/precios/${producto}/${id}/anular`, "PATCH", { motivo });

// ── Ficha del proveedor (PR3a): datos de contacto, condiciones de pago y personas de contacto ─────

export type FormaDePago = "contado" | "credito";
export type MonedaDePago = "PEN" | "USD";

export interface DatosFicha {
  ciudad: string | null;
  direccion: string | null;
  telefono: string | null;
  correo: string | null;
  formaPago: FormaDePago | null;
  plazoPagoDias: number | null;
  moneda: MonedaDePago | null;
}

export interface Contacto {
  id: number;
  nombre: string;
  cargo: string | null;
  telefono: string | null;
  correo: string | null;
  principal: boolean;
}

export interface FichaProveedor {
  datos: DatosFicha;
  contactos: Contacto[];
}

/** Lo que se envía al guardar los datos: todo opcional (vacío = sin dato). */
export interface CuerpoDatosFicha {
  ciudad: string | null;
  direccion: string | null;
  telefono: string | null;
  correo: string | null;
  forma_pago: FormaDePago | null;
  plazo_pago_dias: number | null;
  moneda: MonedaDePago | null;
}

export interface CuerpoContacto {
  nombre: string;
  cargo: string | null;
  telefono: string | null;
  correo: string | null;
  principal: boolean;
  /** Solo al crear: un reintento con el mismo valor no duplica el contacto. */
  cliente_uuid?: string;
}

export const fichaDeProveedor = (id: number) => leer<FichaProveedor>(`/${id}/ficha`);
export const guardarDatosFicha = (id: number, cuerpo: CuerpoDatosFicha) =>
  enviar<DatosFicha>(`/${id}/ficha`, "PUT", cuerpo);
export const crearContacto = (id: number, cuerpo: CuerpoContacto) =>
  enviar<Contacto>(`/${id}/contactos`, "POST", cuerpo);
export const actualizarContacto = (id: number, contactoId: number, cuerpo: CuerpoContacto) =>
  enviar<Contacto>(`/${id}/contactos/${contactoId}`, "PUT", cuerpo);
export const quitarContacto = (id: number, contactoId: number) =>
  enviar<{ ok: true }>(`/${id}/contactos/${contactoId}/quitar`, "PATCH");

// ── Cuentas bancarias (PR3b) ─────────────────────────────────────────────────────────────────────
// El número completo NUNCA viene en la lista: solo `verNumeroCompleto` lo trae, con permiso aparte, y deja
// constancia en la bitácora cada vez.

export type TipoDeCuenta = "corriente" | "ahorros" | "detraccion";

export interface CuentaBancaria {
  id: number;
  banco: string;
  tipoCuenta: TipoDeCuenta;
  moneda: MonedaDePago;
  titular: string | null;
  /** «•••• 1234». */
  numeroEnmascarado: string;
  principal: boolean;
}

export interface RespuestaCuentas {
  /** Puede ver el número entero (permiso `cuentas:ver_completa`). */
  verCompleta: boolean;
  /** Puede agregar, editar y quitar (permiso `cuentas:editar`). */
  puedeEditar: boolean;
  cuentas: CuentaBancaria[];
}

export interface CuerpoCuenta {
  banco: string;
  tipo_cuenta: TipoDeCuenta;
  moneda: MonedaDePago;
  titular: string | null;
  principal: boolean;
  /** Al crear es obligatorio; al editar, ausente = se conserva el que está. */
  numero?: string;
  /** Solo al crear: un reintento con el mismo valor no duplica la cuenta. */
  cliente_uuid?: string;
}

export const cuentasDeProveedor = (id: number) => leer<RespuestaCuentas>(`/${id}/cuentas`);
export const crearCuenta = (id: number, cuerpo: CuerpoCuenta) =>
  enviar<CuentaBancaria>(`/${id}/cuentas`, "POST", cuerpo);
export const actualizarCuenta = (id: number, cuentaId: number, cuerpo: CuerpoCuenta) =>
  enviar<CuentaBancaria>(`/${id}/cuentas/${cuentaId}`, "PUT", cuerpo);
export const quitarCuenta = (id: number, cuentaId: number, motivo: string) =>
  enviar<{ ok: true }>(`/${id}/cuentas/${cuentaId}/quitar`, "PATCH", { motivo });
export const verNumeroCompleto = (id: number, cuentaId: number) =>
  enviar<{ numero: string }>(`/${id}/cuentas/${cuentaId}/ver-completa`, "POST");
