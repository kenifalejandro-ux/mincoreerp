/** src/modules/proveedores/proveedores.service.ts
 *
 * Arma lo que ve el ecosistema a partir de las banderas de `combustible_grifos`. Las palabras son
 * las del ERP: INTERNO = compra para despachar desde la planta (abastece_tanque, y abastece_urea para
 * la urea del almacén) y EXTERNO = se compra en el recorrido de ruta (abastece_ruta y
 * abastece_urea_ruta).
 */
import type { PoolClient } from "pg";

import { AppError } from "../../server/shared/middlewares/error.middleware";
import { cifrar, descifrar, huellaDe } from "../../server/shared/utils/platformCrypto";
import {
  calcularFichaCompleta,
  precioDelDirectorio,
  type FichaCompleta,
  type PrecioDelDirectorio,
} from "./proveedores.directorio";
import { armarFilasDePrecios, type FilaPrecioDto } from "./proveedores.precios";
import { armarCompras, type CompraDto } from "./proveedores.compras";
import {
  PATRON_DE_CATEGORIA,
  PATRON_DE_TODO,
  describirEvento,
  proveedorDelEvento,
  type CategoriaDeHistorial,
} from "./proveedores.historial";
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
  ActualizarCuentaProveedorInput,
  ActualizarProveedorInput,
  ContactoProveedorInput,
  CrearCuentaProveedorInput,
  CrearPreciosProveedoresInput,
  CrearProveedorInput,
  GuardarDatosProveedorInput,
  QuitarCuentaProveedorInput,
} from "../../server/schemas/proveedores.schema";
import {
  CuentaDuplicadaError,
  ProveedorDuplicadoError,
  ProveedoresRepository,
  type FilaContacto,
  type FilaCuenta,
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

export interface ProveedorEnDirectorioDto extends ProveedorDto {
  ciudad: string | null;
  fichaCompleta: FichaCompleta;
  /** El primer precio vigente. Ausente si esta persona no ve precios; `null` si no tiene ninguno. */
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
  ciudad: string | null;
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

/** Una cuenta bancaria como sale a la pantalla: el número NUNCA viaja, solo sus últimos 4 dígitos. */
export interface CuentaDto {
  id: number;
  banco: string;
  tipoCuenta: "corriente" | "ahorros" | "detraccion";
  moneda: "PEN" | "USD";
  titular: string | null;
  /** «•••• 1234». */
  numeroEnmascarado: string;
  principal: boolean;
}

export const enmascarar = (ultimos4: string) => `•••• ${ultimos4}`;

export function cuentaADto(fila: FilaCuenta): CuentaDto {
  return {
    id: Number(fila.id),
    banco: fila.banco,
    tipoCuenta: fila.tipo_cuenta,
    moneda: fila.moneda,
    titular: fila.titular,
    numeroEnmascarado: enmascarar(fila.numero_ultimos4),
    principal: fila.principal,
  };
}

/** Lo que se guarda del número: cifrado, sus últimos 4 y su huella (para no repetir la cuenta). */
function protegerNumero(numero: string) {
  return {
    numero_cifrado: cifrar(numero),
    numero_ultimos4: numero.slice(-4),
    numero_huella: huellaDe(numero),
  };
}

function comoErrorDeCuenta(err: unknown): unknown {
  return err instanceof CuentaDuplicadaError ? new AppError(409, err.message) : err;
}

export interface EventoDeHistorialDto {
  id: string;
  accion: string;
  titulo: string;
  categoria: CategoriaDeHistorial | null;
  creadoEn: string;
  /** Quién lo hizo (nombre), o la etiqueta del actor si ya no existe la persona. */
  actor: string | null;
  proveedorId: number | null;
  proveedorNombre: string | null;
  lineas: string[];
}

export interface PaginaDeHistorial {
  eventos: EventoDeHistorialDto[];
  /** El cursor para la página siguiente, o null si no hay más. */
  siguiente: string | null;
}

export interface FiltroDeHistorial {
  categoria?: CategoriaDeHistorial;
  desde?: string;
  hasta?: string;
  /** Texto del nombre del proveedor. */
  proveedor?: string;
  /** Un proveedor exacto (la pestaña Historial de su ficha). Manda sobre el texto. */
  proveedorId?: number;
  antesDe?: string;
  limite: number;
}

export interface FichaProveedorDto {
  datos: DatosProveedorDto;
  contactos: ContactoDto[];
}

const DATOS_VACIOS: DatosProveedorDto = {
  direccion: null,
  ciudad: null,
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
    ciudad: fila.ciudad,
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

  /** El Directorio: cada proveedor con su ciudad, qué tan completa está su ficha y, para quien ve precios, su
   *  precio vigente (`precioVigente` ausente = esta persona no ve precios; `null` = no tiene ninguno). */
  async listarParaElDirectorio(
    client: PoolClient,
    tenantId: string,
    ver: { combustible: boolean; urea: boolean }
  ): Promise<ProveedorEnDirectorioDto[]> {
    const [proveedores, fichas, filasDePrecios] = await Promise.all([
      this.listar(client, tenantId),
      this.repository.fichasParaElDirectorio(client, tenantId),
      ver.combustible || ver.urea ? this.precios(client, tenantId, ver) : Promise.resolve(null),
    ]);
    const fichaDe = new Map(fichas.map((f) => [f.grifo_id, f]));
    const preciosDe = new Map<number, FilaPrecioDto[]>();
    for (const f of filasDePrecios ?? []) {
      preciosDe.set(f.proveedorId, [...(preciosDe.get(f.proveedorId) ?? []), f]);
    }
    return proveedores.map((p): ProveedorEnDirectorioDto => {
      const f = fichaDe.get(p.id);
      return {
        ...p,
        ciudad: f?.ciudad ?? null,
        fichaCompleta: calcularFichaCompleta({
          ruc: p.ruc,
          direccion: f?.direccion ?? null,
          telefono: f?.telefono ?? null,
          formaPago: f?.forma_pago ?? null,
          tieneContacto: f?.tiene_contacto ?? false,
          contactoConTelefono: f?.contacto_con_telefono ?? false,
        }),
        ...(filasDePrecios
          ? { precioVigente: precioDelDirectorio(preciosDe.get(p.id) ?? []) }
          : {}),
      };
    });
  }

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

  // ── Historial y auditoría: lo que se hizo con los proveedores, de la bitácora de la empresa ───────

  async historial(
    client: PoolClient,
    tenantId: string,
    filtro: FiltroDeHistorial
  ): Promise<PaginaDeHistorial> {
    let proveedorIds: number[] | undefined;
    if (filtro.proveedorId !== undefined) {
      proveedorIds = [filtro.proveedorId];
    } else if (filtro.proveedor && filtro.proveedor.trim() !== "") {
      proveedorIds = await this.repository.idsDeProveedoresPorNombre(
        client,
        tenantId,
        filtro.proveedor.trim()
      );
      if (proveedorIds.length === 0) return { eventos: [], siguiente: null };
    }
    // Se pide uno de más para saber si hay página siguiente sin contar el total.
    const filas = await this.repository.eventosDeHistorial(client, tenantId, {
      patron: filtro.categoria ? PATRON_DE_CATEGORIA[filtro.categoria] : PATRON_DE_TODO,
      desde: filtro.desde,
      hasta: filtro.hasta,
      antesDe: filtro.antesDe,
      proveedorIds,
      limite: filtro.limite + 1,
    });
    const hayMas = filas.length > filtro.limite;
    const pagina = hayMas ? filas.slice(0, filtro.limite) : filas;
    const ids = [
      ...new Set(
        pagina.map((f) => proveedorDelEvento(f.detalle)).filter((id): id is number => id !== null)
      ),
    ];
    const nombres = await this.repository.nombresDeProveedores(client, tenantId, ids);
    const eventos = pagina.map((f): EventoDeHistorialDto => {
      const proveedorId = proveedorDelEvento(f.detalle);
      const { titulo, categoria, lineas } = describirEvento(f.accion, f.detalle);
      return {
        id: String(f.id),
        accion: f.accion,
        titulo,
        categoria,
        creadoEn: new Date(f.creadoEn).toISOString(),
        actor: f.actor,
        proveedorId,
        proveedorNombre: proveedorId === null ? null : (nombres.get(proveedorId) ?? null),
        lineas,
      };
    });
    return { eventos, siguiente: hayMas ? eventos[eventos.length - 1].id : null };
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

  // ── Cuentas bancarias (PR3b) ──────────────────────────────────────────────────────────────────────
  // El número se guarda cifrado y solo se descifra para «ver completo» (que el llamador audita). Nunca
  // sale en una lista, ni en una respuesta de alta o edición, ni en la auditoría.

  async cuentas(client: PoolClient, tenantId: string, id: number): Promise<CuentaDto[]> {
    await this.exigirProveedor(client, tenantId, id);
    return (await this.repository.cuentasActivas(client, tenantId, id)).map(cuentaADto);
  }

  /** `creado: false` = un reintento de una ya guardada (mismo `cliente_uuid`). */
  async crearCuenta(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    id: number,
    data: CrearCuentaProveedorInput
  ): Promise<{ cuenta: CuentaDto; creado: boolean }> {
    await this.exigirProveedor(client, tenantId, id);
    if (data.cliente_uuid) {
      const previa = await this.repository.cuentaPorClienteUuid(
        client,
        tenantId,
        id,
        data.cliente_uuid
      );
      if (previa) return { cuenta: cuentaADto(previa), creado: false };
    }
    // La primera cuenta del proveedor es la principal aunque no se marque.
    const hayCuentas = (await this.repository.cuentasActivas(client, tenantId, id)).length > 0;
    const principal = data.principal || !hayCuentas;
    if (principal) await this.repository.quitarPrincipalDeCuentas(client, tenantId, id, usuarioId);
    try {
      const fila = await this.repository.crearCuenta(client, tenantId, usuarioId, id, {
        banco: data.banco,
        tipo_cuenta: data.tipo_cuenta,
        moneda: data.moneda,
        titular: data.titular,
        principal,
        cliente_uuid: data.cliente_uuid,
        ...protegerNumero(data.numero),
      });
      if (!fila) {
        const ganadora = await this.repository.cuentaPorClienteUuid(
          client,
          tenantId,
          id,
          data.cliente_uuid ?? ""
        );
        if (ganadora) return { cuenta: cuentaADto(ganadora), creado: false };
        throw new AppError(409, "No se pudo guardar la cuenta");
      }
      return { cuenta: cuentaADto(fila), creado: true };
    } catch (err) {
      throw comoErrorDeCuenta(err);
    }
  }

  /** Devuelve la cuenta y, si cambió el número, los últimos 4 de antes (para la bitácora). */
  async actualizarCuenta(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    id: number,
    cuentaId: number,
    data: ActualizarCuentaProveedorInput
  ): Promise<{ cuenta: CuentaDto; cambioElNumero: boolean; ultimos4Anteriores: string }> {
    await this.exigirProveedor(client, tenantId, id);
    const actual = await this.repository.cuentaPorId(client, tenantId, id, cuentaId);
    if (!actual || !actual.activo) throw new AppError(404, "Cuenta no encontrada");
    if (data.principal) {
      await this.repository.quitarPrincipalDeCuentas(client, tenantId, id, usuarioId);
    }
    // Quitarle la marca a la única principal dejaría al proveedor sin cuenta principal: se conserva.
    const principal = data.principal || actual.principal;
    try {
      const fila = await this.repository.actualizarCuenta(
        client,
        tenantId,
        usuarioId,
        id,
        cuentaId,
        {
          banco: data.banco,
          tipo_cuenta: data.tipo_cuenta,
          moneda: data.moneda,
          titular: data.titular,
          principal,
          numero: data.numero === undefined ? undefined : protegerNumero(data.numero),
        }
      );
      if (!fila) throw new AppError(404, "Cuenta no encontrada");
      return {
        cuenta: cuentaADto(fila),
        cambioElNumero: data.numero !== undefined,
        ultimos4Anteriores: actual.numero_ultimos4,
      };
    } catch (err) {
      throw comoErrorDeCuenta(err);
    }
  }

  async quitarCuenta(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    id: number,
    cuentaId: number,
    data: QuitarCuentaProveedorInput
  ): Promise<void> {
    await this.exigirProveedor(client, tenantId, id);
    const fila = await this.repository.desactivarCuenta(
      client,
      tenantId,
      usuarioId,
      id,
      cuentaId,
      data.motivo
    );
    if (!fila) throw new AppError(404, "Cuenta no encontrada");
    await this.repository.ascenderPrimeraCuenta(client, tenantId, id);
  }

  /** El número completo de UNA cuenta activa. Quien llama tiene que haber exigido el permiso y dejar la
   *  bitácora: este método solo descifra. */
  async numeroCompleto(
    client: PoolClient,
    tenantId: string,
    id: number,
    cuentaId: number
  ): Promise<string> {
    await this.exigirProveedor(client, tenantId, id);
    const cifrado = await this.repository.numeroCifradoDe(client, tenantId, id, cuentaId);
    if (!cifrado) throw new AppError(404, "Cuenta no encontrada");
    return descifrar(cifrado);
  }

  /** Gestión comercial: solo lo que este perfil puede ver (combustible y/o urea). */
  async precios(
    client: PoolClient,
    tenantId: string,
    ver: { combustible: boolean; urea: boolean },
    ahora: Date = new Date()
  ): Promise<FilaPrecioDto[]> {
    const proveedores = await this.listar(client, tenantId);
    const [preciosCombustible, preciosUrea, tiposEnTanques, presentaciones, condiciones] =
      await Promise.all([
        ver.combustible
          ? this.repository.listarPreciosCombustibleDeProveedores(client, tenantId)
          : [],
        ver.urea ? this.repository.listarPreciosUrea(client, tenantId) : [],
        ver.combustible ? this.repository.tiposDeCombustibleEnTanques(client, tenantId) : [],
        ver.urea ? this.repository.presentacionesDeUreaActivas(client, tenantId) : [],
        this.repository.condicionesDePago(client, tenantId),
      ]);
    const condicionesDePago = new Map(
      condiciones.map((c) => [
        c.grifo_id,
        { formaPago: c.forma_pago, plazoPagoDias: c.plazo_pago_dias },
      ])
    );
    return armarFilasDePrecios(
      {
        proveedores,
        preciosCombustible,
        preciosUrea,
        tiposEnTanques,
        presentaciones,
        condicionesDePago,
      },
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
