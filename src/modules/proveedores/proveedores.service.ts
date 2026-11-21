/** src/modules/proveedores/proveedores.service.ts
 *
 * Arma lo que ve el ecosistema a partir de las banderas de `combustible_grifos`. Las palabras son
 * las del ERP: INTERNO = compra para despachar desde la planta (abastece_tanque, y abastece_urea para
 * la urea del almacén) y EXTERNO = se compra en el recorrido de ruta (abastece_ruta y
 * abastece_urea_ruta).
 */
import type { PoolClient } from "pg";

import { AppError } from "../../server/shared/middlewares/error.middleware";
import { armarFilasDePrecios, type FilaPrecioDto } from "./proveedores.precios";
import { armarCompras, type CompraDto } from "./proveedores.compras";
import { CombustibleService } from "../combustible/combustible.service";
import {
  anularCompra,
  crearCompra,
  datosParaElFormulario,
  habilitarCompra,
  listarCompras,
  obtenerTolerancia,
} from "../combustible/comprasCisterna.service";
import type { AlcanceCombustible } from "../combustible/alcance";
import type {
  AnularCompraCisternaInput,
  AnularPrecioCombustibleInput,
  CrearCompraCisternaInput,
  CrearPrecioUreaInput,
} from "../../server/schemas/combustible.schema";
import type {
  ActualizarProveedorInput,
  ContactoProveedorInput,
  CrearPreciosProveedoresInput,
  CrearProveedorInput,
  GuardarDatosProveedorInput,
} from "../../server/schemas/proveedores.schema";
import {
  ProveedorDuplicadoError,
  ProveedoresRepository,
  type FilaContacto,
  type FilaDatosProveedor,
  type FilaProveedor,
} from "./proveedores.repository";

export type TipoProveedor = "Combustible" | "Urea";

export interface ProveedorDto {
  id: number;
  /** Mismo formato que la pestaña Proveedores de Combustible (PRV-009). */
  codigo: string;
  nombre: string;
  ruc: string | null;
  activo: boolean;
  tipos: TipoProveedor[];
  combustible: { interno: boolean; externo: boolean };
  urea: { interno: boolean; externo: boolean };
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

export function codigoDeProveedor(id: number): string {
  return `PRV-${String(id).padStart(3, "0")}`;
}

export function aDto(fila: FilaProveedor): ProveedorDto {
  const combustible = { interno: fila.abastece_tanque, externo: fila.abastece_ruta };
  const urea = { interno: fila.abastece_urea, externo: fila.abastece_urea_ruta };
  const tipos: TipoProveedor[] = [];
  if (combustible.interno || combustible.externo) tipos.push("Combustible");
  if (urea.interno || urea.externo) tipos.push("Urea");
  return {
    id: fila.id,
    codigo: codigoDeProveedor(fila.id),
    nombre: fila.nombre,
    ruc: fila.ruc,
    activo: fila.activo,
    tipos,
    combustible,
    urea,
  };
}

export function resumir(lista: ProveedorDto[]): ResumenProveedores {
  return {
    total: lista.length,
    activos: lista.filter((p) => p.activo).length,
    inactivos: lista.filter((p) => !p.activo).length,
    combustible: lista.filter((p) => p.tipos.includes("Combustible")).length,
    urea: lista.filter((p) => p.tipos.includes("Urea")).length,
    internos: lista.filter((p) => p.combustible.interno || p.urea.interno).length,
    externos: lista.filter((p) => p.combustible.externo || p.urea.externo).length,
  };
}

/** Las reglas de precios (proveedor de ruta y activo, urea y presentación activa) viven en
 *  CombustibleService y lanzan `Error` con un mensaje claro: acá pasan a 400, como allá. */
function comoErrorDeNegocioDePrecio(err: unknown): unknown {
  if (
    err instanceof Error &&
    !(err instanceof AppError) &&
    (err.message.includes("no existe en este tenant") ||
      err.message.includes("no está marcado como"))
  ) {
    return new AppError(400, err.message);
  }
  return err;
}

export interface DatosProveedorDto {
  direccion: string | null;
  telefono: string | null;
  correo: string | null;
  formaPago: "contado" | "credito" | null;
  plazoPagoDias: number | null;
  moneda: "PEN" | "USD" | null;
}

export interface ContactoDto {
  id: number;
  nombre: string;
  cargo: string | null;
  telefono: string | null;
  correo: string | null;
  principal: boolean;
}

export interface FichaProveedorDto {
  datos: DatosProveedorDto;
  contactos: ContactoDto[];
}

const DATOS_VACIOS: DatosProveedorDto = {
  direccion: null,
  telefono: null,
  correo: null,
  formaPago: null,
  plazoPagoDias: null,
  moneda: null,
};

export function datosADto(fila: FilaDatosProveedor | undefined): DatosProveedorDto {
  if (!fila) return { ...DATOS_VACIOS };
  return {
    direccion: fila.direccion,
    telefono: fila.telefono,
    correo: fila.correo,
    formaPago: fila.forma_pago,
    plazoPagoDias: fila.plazo_pago_dias,
    moneda: fila.moneda,
  };
}

export function contactoADto(fila: FilaContacto): ContactoDto {
  return {
    id: Number(fila.id),
    nombre: fila.nombre,
    cargo: fila.cargo,
    telefono: fila.telefono,
    correo: fila.correo,
    principal: fila.principal,
  };
}

/** Los campos de la ficha que cambiaron (para la auditoría: dice cuáles, no sus valores). */
export function camposCambiados(antes: DatosProveedorDto, despues: DatosProveedorDto): string[] {
  return (Object.keys(despues) as (keyof DatosProveedorDto)[]).filter(
    (k) => antes[k] !== despues[k]
  );
}

export interface FormularioDePrecios {
  /** Proveedores de ruta activos (combustible); vacío si esta persona no carga precios de combustible. */
  proveedoresCombustible: { id: number; nombre: string }[];
  /** Proveedores de urea activos; vacío si no carga precios de urea. */
  proveedoresUrea: { id: number; nombre: string }[];
  /** Presentaciones de urea activas. */
  presentaciones: { codigo: string; nombre: string; litros: string | null }[];
  combustible: boolean;
  urea: boolean;
}

export class ProveedoresService {
  constructor(
    private readonly repository = new ProveedoresRepository(),
    private readonly combustible = new CombustibleService()
  ) {}

  async listar(client: PoolClient, tenantId: string): Promise<ProveedorDto[]> {
    return (await this.repository.listar(client, tenantId)).map(aDto);
  }

  async resumen(client: PoolClient, tenantId: string): Promise<ResumenProveedores> {
    return resumir(await this.listar(client, tenantId));
  }

  async detalle(client: PoolClient, tenantId: string, id: number): Promise<ProveedorDto> {
    const fila = await this.repository.buscarPorId(client, tenantId, id);
    if (!fila) throw new AppError(404, "Proveedor no encontrado");
    return aDto(fila);
  }

  // ── Ficha (PR3a): datos de contacto, condiciones de pago y personas de contacto ───────────────────

  private async exigirProveedor(client: PoolClient, tenantId: string, id: number) {
    const fila = await this.repository.buscarPorId(client, tenantId, id);
    if (!fila) throw new AppError(404, "Proveedor no encontrado");
    return fila;
  }

  async ficha(client: PoolClient, tenantId: string, id: number): Promise<FichaProveedorDto> {
    await this.exigirProveedor(client, tenantId, id);
    const [datos, contactos] = await Promise.all([
      this.repository.datosDe(client, tenantId, id),
      this.repository.contactosActivos(client, tenantId, id),
    ]);
    return { datos: datosADto(datos), contactos: contactos.map(contactoADto) };
  }

  async guardarDatos(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    id: number,
    data: GuardarDatosProveedorInput
  ): Promise<{ datos: DatosProveedorDto; campos: string[] }> {
    await this.exigirProveedor(client, tenantId, id);
    const antes = datosADto(await this.repository.datosDe(client, tenantId, id));
    const fila = await this.repository.guardarDatos(client, tenantId, usuarioId, id, data);
    const datos = datosADto(fila);
    return { datos, campos: camposCambiados(antes, datos) };
  }

  /** `creado: false` = un reintento de uno ya guardado (mismo `cliente_uuid`). */
  async crearContacto(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    id: number,
    data: ContactoProveedorInput
  ): Promise<{ contacto: ContactoDto; creado: boolean }> {
    await this.exigirProveedor(client, tenantId, id);
    if (data.cliente_uuid) {
      const previo = await this.repository.contactoPorClienteUuid(
        client,
        tenantId,
        id,
        data.cliente_uuid
      );
      if (previo) return { contacto: contactoADto(previo), creado: false };
    }
    // El primer contacto del proveedor es el principal aunque no se marque.
    const hayContactos = (await this.repository.contactosActivos(client, tenantId, id)).length > 0;
    const principal = data.principal || !hayContactos;
    if (principal) await this.repository.quitarPrincipal(client, tenantId, id, usuarioId);
    const fila = await this.repository.crearContacto(client, tenantId, usuarioId, id, {
      ...data,
      principal,
    });
    if (!fila) {
      // El mismo `cliente_uuid` llegó en paralelo: se devuelve el que ganó.
      const ganador = await this.repository.contactoPorClienteUuid(
        client,
        tenantId,
        id,
        data.cliente_uuid ?? ""
      );
      if (ganador) return { contacto: contactoADto(ganador), creado: false };
      throw new AppError(409, "No se pudo guardar el contacto");
    }
    return { contacto: contactoADto(fila), creado: true };
  }

  async actualizarContacto(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    id: number,
    contactoId: number,
    data: ContactoProveedorInput
  ): Promise<ContactoDto> {
    await this.exigirProveedor(client, tenantId, id);
    const actual = await this.repository.contactoPorId(client, tenantId, id, contactoId);
    if (!actual || !actual.activo) throw new AppError(404, "Contacto no encontrado");
    if (data.principal) await this.repository.quitarPrincipal(client, tenantId, id, usuarioId);
    // Quitarle la marca al único principal deja al proveedor sin principal: se conserva.
    const principal = data.principal || actual.principal;
    const fila = await this.repository.actualizarContacto(
      client,
      tenantId,
      usuarioId,
      id,
      contactoId,
      { ...data, principal }
    );
    if (!fila) throw new AppError(404, "Contacto no encontrado");
    return contactoADto(fila);
  }

  async quitarContacto(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    id: number,
    contactoId: number
  ): Promise<void> {
    await this.exigirProveedor(client, tenantId, id);
    const fila = await this.repository.desactivarContacto(
      client,
      tenantId,
      usuarioId,
      id,
      contactoId
    );
    if (!fila) throw new AppError(404, "Contacto no encontrado");
    await this.repository.ascenderPrimerContacto(client, tenantId, id);
  }

  /** Gestión comercial: solo lo que este perfil puede ver (combustible y/o urea). */
  async precios(
    client: PoolClient,
    tenantId: string,
    ver: { combustible: boolean; urea: boolean },
    ahora: Date = new Date()
  ): Promise<FilaPrecioDto[]> {
    const proveedores = await this.listar(client, tenantId);
    const [preciosCombustible, preciosUrea, tiposEnTanques, presentaciones] = await Promise.all([
      ver.combustible
        ? this.repository.listarPreciosCombustibleDeProveedores(client, tenantId)
        : [],
      ver.urea ? this.repository.listarPreciosUrea(client, tenantId) : [],
      ver.combustible ? this.repository.tiposDeCombustibleEnTanques(client, tenantId) : [],
      ver.urea ? this.repository.presentacionesDeUreaActivas(client, tenantId) : [],
    ]);
    return armarFilasDePrecios(
      { proveedores, preciosCombustible, preciosUrea, tiposEnTanques, presentaciones },
      ver,
      ahora
    );
  }

  /** Compras y recepciones: las compras de cisterna de Combustible que este perfil puede ver (las mismas
   *  reglas de allá: alcance por sede y, si no gestiona compras, solo las ya por llegar), con lo que se
   *  descargó contra el documento. */
  async compras(
    client: PoolClient,
    tenantId: string,
    alcance: AlcanceCombustible,
    gestiona: boolean
  ): Promise<{ gestiona: boolean; tolerancia: number; compras: CompraDto[] }> {
    const filas = await listarCompras(client, tenantId, alcance, gestiona);
    const ids = filas.filter((f) => f.recepcion_id !== null).map((f) => Number(f.recepcion_id));
    const [recepciones, tolerancia] = await Promise.all([
      this.repository.recepcionesDeCompras(client, tenantId, ids),
      obtenerTolerancia(client, tenantId),
    ]);
    return {
      gestiona,
      tolerancia,
      compras: armarCompras(filas, new Map(recepciones.map((r) => [Number(r.id), r])), tolerancia),
    };
  }

  // ── Escribir precios (PR4b): las reglas son las de Combustible (CombustibleService), que valida
  // proveedor de ruta activo, proveedor y presentación de urea, y apila el precio sin pisar nada. Acá solo
  // se cargan precios de PROVEEDORES; los de tanque (venta interna) son de Combustible.

  async datosParaFormularioDePrecios(
    client: PoolClient,
    tenantId: string,
    ver: { combustible: boolean; urea: boolean }
  ): Promise<FormularioDePrecios> {
    const proveedores = await this.listar(client, tenantId);
    const presentaciones = ver.urea
      ? await this.repository.presentacionesDeUreaActivas(client, tenantId)
      : [];
    return {
      combustible: ver.combustible,
      urea: ver.urea,
      proveedoresCombustible: ver.combustible
        ? proveedores
            .filter((p) => p.activo && p.combustible.externo)
            .map((p) => ({ id: p.id, nombre: p.nombre }))
        : [],
      proveedoresUrea: ver.urea
        ? proveedores
            .filter((p) => p.activo && (p.urea.interno || p.urea.externo))
            .map((p) => ({ id: p.id, nombre: p.nombre }))
        : [],
      presentaciones,
    };
  }

  async crearPreciosCombustible(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    data: CrearPreciosProveedoresInput
  ) {
    try {
      return await this.combustible.crearPreciosMasivo(client, tenantId, usuarioId, data);
    } catch (err) {
      throw comoErrorDeNegocioDePrecio(err);
    }
  }

  async crearPrecioUrea(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    data: CrearPrecioUreaInput
  ) {
    try {
      return await this.combustible.crearPrecioUrea(client, tenantId, usuarioId, data);
    } catch (err) {
      throw comoErrorDeNegocioDePrecio(err);
    }
  }

  /** Anula un precio de combustible DE UN PROVEEDOR con motivo; nunca se borra. 404 si no existe o es de un
   *  tanque, 409 si ya estaba anulado. */
  async anularPrecioCombustible(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    id: number,
    data: AnularPrecioCombustibleInput
  ) {
    const existente = await this.combustible.getPrecioPorId(client, tenantId, id);
    if (!existente || existente.grifo_id === null) throw new AppError(404, "Precio no encontrado");
    const anulado = await this.combustible.anularPrecio(
      client,
      tenantId,
      id,
      usuarioId,
      data.motivo
    );
    if (!anulado) throw new AppError(409, "Este precio ya estaba anulado");
    return anulado;
  }

  async anularPrecioUrea(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    id: number,
    data: AnularPrecioCombustibleInput
  ) {
    const anulado = await this.combustible.anularPrecioUrea(
      client,
      tenantId,
      id,
      usuarioId,
      data.motivo
    );
    if (anulado) return anulado;
    throw (await this.combustible.existePrecioUrea(client, tenantId, id))
      ? new AppError(409, "Este precio ya estaba anulado")
      : new AppError(404, "Precio no encontrado");
  }

  // ── Escribir compras (PR5b): las reglas son las de Combustible, que ya valida proveedor de tanque,
  // documento repetido, sede, estados y la idempotencia por `cliente_uuid`. Se reutilizan las mismas
  // funciones: no se duplica ninguna regla. Lo que devuelven es una compra recién escrita: nunca está
  // recibida (anular o habilitar una recibida se rechaza), así que no lleva recepción.

  /** Lo que necesita el formulario: proveedores de tanque activos, sedes del alcance y precios vigentes. */
  datosParaElFormulario(client: PoolClient, tenantId: string, alcance: AlcanceCombustible) {
    return datosParaElFormulario(client, tenantId, alcance);
  }

  async registrarCompra(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    data: CrearCompraCisternaInput,
    alcance: AlcanceCombustible
  ): Promise<{ compra: CompraDto; creado: boolean }> {
    const { fila, creado } = await crearCompra(client, tenantId, usuarioId, data, alcance);
    return { compra: armarCompras([fila], new Map(), 0)[0], creado };
  }

  async habilitarCompra(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    id: number,
    alcance: AlcanceCombustible
  ): Promise<CompraDto> {
    const fila = await habilitarCompra(client, tenantId, usuarioId, id, alcance);
    return armarCompras([fila], new Map(), 0)[0];
  }

  async anularCompra(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    id: number,
    data: AnularCompraCisternaInput,
    alcance: AlcanceCombustible
  ): Promise<CompraDto> {
    const fila = await anularCompra(client, tenantId, usuarioId, id, data.motivo, alcance);
    return armarCompras([fila], new Map(), 0)[0];
  }

  async crear(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    data: CrearProveedorInput
  ): Promise<ProveedorDto> {
    try {
      return aDto(await this.repository.crear(client, tenantId, usuarioId, data));
    } catch (err) {
      throw comoErrorDeNegocio(err);
    }
  }

  async actualizar(
    client: PoolClient,
    tenantId: string,
    id: number,
    data: ActualizarProveedorInput
  ): Promise<ProveedorDto> {
    try {
      const fila = await this.repository.actualizar(client, tenantId, id, data);
      if (!fila) throw new AppError(404, "Proveedor no encontrado");
      return aDto(fila);
    } catch (err) {
      throw comoErrorDeNegocio(err);
    }
  }
}

function comoErrorDeNegocio(err: unknown): unknown {
  return err instanceof ProveedorDuplicadoError ? new AppError(409, err.message) : err;
}
