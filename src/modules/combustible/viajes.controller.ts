import type { NextFunction, Request, Response } from "express";
import type { PoolClient } from "pg";
import { logger } from "../../server/config/logger";
import { capturarError } from "../../server/config/sentry";
import { withTenant } from "../../server/config/database";
import { AppError } from "../../server/shared/middlewares/error.middleware";
import { getTenantId } from "../../server/shared/utils/request";
import { contextoAuditoriaModulo } from "../../server/shared/utils/moduleAudit";
import { registrarAuditoria } from "../../server/services/platformAudit.service";
import { publicarEventoTenant } from "../../server/services/realtimeEvents.service";
import { pestanaPermitida } from "../../server/services/permisosPestanas.service";
import type {
  AnularViajeInput,
  CerrarMiViajeInput,
  CerrarViajeInput,
  CorregirMandoInput,
  CorregirMarcaDeParadaInput,
  CrearLugarInput,
  CrearMiViajeInput,
  EditarLugarInput,
  CrearViajeInput,
  EditarViajeInput,
  HistorialMioQuery,
  IniciarMiViajeInput,
  ManejaMioInput,
  IniciarViajeInput,
  ListarViajesQuery,
  MarcaSinOrdenInput,
  PonerAlDiaInput,
  RegistrarUbicacionInput,
} from "../../server/schemas/combustible.schema";
import { ambitoDe } from "./alcance";
import { CombustibleService } from "./combustible.service";
import { consumoControlTv, resumenControlTv, type PeriodoTv } from "./controlTv.service";
import { detalleControlTv } from "./controlTvDetalle.service";
import { resumenDeUnidad } from "./controlTvUnidad.service";
import * as viajes from "./viajes.service";
import {
  catalogoParaCrear,
  conductorPuedeCrearViaje,
  crearMiViaje,
} from "./viajesCreadosPorConductor";

const combustible = new CombustibleService();

const EVENTO = "combustible.viaje_actualizado";

type CuerpoMarca = {
  medidor?: number | null;
  orden?: number;
  marcado_en?: string;
  cliente_uuid?: string;
  llegada_en?: string;
  salida_en?: string;
  motivo?: string;
};

type CuerpoDescanso = {
  motivo?: string | null;
  donde?: string | null;
  marcado_en?: string;
  cliente_uuid?: string;
  inicio_en?: string;
  fin_en?: string;
  descanso_id?: number;
};

/** La alerta de "unidad detenida" al instante (E15e): abre la de una avería, accidente, huaico,
 *  bloqueo o tráfico recién marcado, o cierra la que ya no corresponde. Va en un SAVEPOINT: si la
 *  alerta falla, el descanso se guarda igual (sobre todo el que llega de un celular que estuvo sin
 *  señal) y el worker la crea en su siguiente pasada. */
async function alertaDeDetencion(c: PoolClient, tenantId: string, viajeId: number) {
  return enSavepoint(c, tenantId, viajeId, async () => {
    const { cambio } = await combustible.evaluarDetencionDeUnViaje(c, tenantId, viajeId);
    return cambio;
  });
}

/** Al cerrar o anular un viaje se cierran sus alertas (demorado y detenido) al instante, con el
 *  mismo cuidado: si falla, el cierre del viaje no se pierde y el worker las cierra después. */
function cerrarAlertasDelViaje(c: PoolClient, tenantId: string, viajeId: number) {
  return enSavepoint(c, tenantId, viajeId, () =>
    combustible.cerrarAlertasDeUnViaje(c, tenantId, viajeId)
  );
}

async function enSavepoint(
  c: PoolClient,
  tenantId: string,
  viajeId: number,
  paso: () => Promise<boolean>
) {
  await c.query("SAVEPOINT alerta_detencion");
  try {
    const cambio = await paso();
    await c.query("RELEASE SAVEPOINT alerta_detencion");
    return cambio;
  } catch (error) {
    await c.query("ROLLBACK TO SAVEPOINT alerta_detencion");
    logger.error({ err: error, tenantId, viajeId }, "No se pudo evaluar la alerta de detención");
    capturarError(error, { modulo: "combustible", viajeId, paso: "alerta_detencion" });
    return false;
  }
}

/** La campanita se entera al instante de una alerta de viaje que se abrió o se cerró. */
async function avisarCampanita(tenantId: string) {
  await publicarEventoTenant(tenantId, "combustible.alerta_creada", {
    tipo: "viaje_detenido",
  }).catch((err) => logger.warn({ err, tenantId }, "No se pudo publicar el evento"));
}

/** Empezar o terminar un descanso: el del propio conductor (por su DNI, con uuid y hora del
 *  celular) o el de la oficina por él (motivo obligatorio al empezar). */
function marcaDeDescanso(que: "inicio" | "fin", delConductor: boolean) {
  return async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    const id = Number(req.params.viajeId);
    const b = req.validatedBody as CuerpoDescanso;
    const marca = {
      motivo: b.motivo,
      donde: b.donde,
      marcado_en: b.marcado_en,
      cliente_uuid: b.cliente_uuid,
      hora: que === "inicio" ? b.inicio_en : b.fin_en,
      descanso_id: b.descanso_id,
    };
    const dni = delConductor ? (req.usuario!.dni ?? "") : undefined;
    const { r, alertaCambio } = await withTenant(tenantId, async (c) => {
      const r =
        que === "inicio"
          ? await viajes.iniciarDescanso(c, tenantId, req.usuario!.id, id, marca, dni)
          : await viajes.terminarDescanso(c, tenantId, req.usuario!.id, id, marca, dni);
      return { r, alertaCambio: r.repetido ? false : await alertaDeDetencion(c, tenantId, id) };
    });
    // La campanita se entera al instante de la alerta que se abrió o se cerró (ver `alertaDeDetencion`).
    if (alertaCambio) {
      await avisarCampanita(tenantId);
    }
    if (!r.repetido) {
      await auditar(req, `viaje_descanso_${que === "inicio" ? "iniciar" : "terminar"}`, {
        viajeId: id,
        numero: r.antes.numero,
        por: delConductor ? "conductor" : "oficina",
        motivo: b.motivo ?? null,
        donde: b.donde?.trim() || null,
        manual: marca.hora !== undefined,
      });
    }
    res.json(r.despues);
  };
}

/** Llegada o salida de una parada: la del propio conductor (por su DNI, con
 *  uuid y hora del celular) o la de la oficina por él (hora a mano y motivo). */
function marcaDeParada(que: "llegada" | "salida", delConductor: boolean) {
  return async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    const id = Number(req.params.viajeId);
    const b = req.validatedBody as CuerpoMarca;
    const marca = {
      medidor: b.medidor,
      orden: b.orden,
      marcado_en: b.marcado_en,
      cliente_uuid: b.cliente_uuid,
      hora: que === "llegada" ? b.llegada_en : b.salida_en,
    };
    const dni = delConductor ? (req.usuario!.dni ?? "") : undefined;
    const { r, alertaCambio } = await withTenant(tenantId, async (c) => {
      const r =
        que === "llegada"
          ? await viajes.llegarAParada(c, tenantId, req.usuario!.id, id, marca, dni)
          : await viajes.salirDeParada(c, tenantId, req.usuario!.id, id, marca, dni);
      // Llegar a una parada termina el tramo (y la llegada a la última, el viaje): la demora de
      // ese tramo ya no existe, se cierra al instante; la del siguiente la abre el worker.
      const cierra = que === "llegada" && !r.repetido;
      return { r, alertaCambio: cierra ? await cerrarAlertasDelViaje(c, tenantId, id) : false };
    });
    if (alertaCambio) await avisarCampanita(tenantId);
    if (!r.repetido) {
      await auditar(req, r.cierra ? "viaje_cerrar" : `viaje_${que}`, {
        viajeId: id,
        numero: r.antes.numero,
        parada: r.orden,
        por: delConductor ? "conductor" : "oficina",
        medidor: b.medidor ?? null,
        motivo: b.motivo,
        manual: marca.hora !== undefined,
      });
    }
    res.json(r.despues);
  };
}

/** Entregar, aceptar o retirar el mando: siempre lo hace el conductor, por su DNI. */
function marcaDeMando(que: "entregar" | "aceptar" | "retirar") {
  return async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    const id = Number(req.params.viajeId);
    const b = (req.validatedBody ?? {}) as { medidor?: number | null; lugar?: string | null } & {
      marcado_en?: string;
      cliente_uuid?: string;
    };
    const dni = req.usuario!.dni ?? "";
    const usuarioId = req.usuario!.id;
    const r = await withTenant(tenantId, (c) =>
      que === "entregar"
        ? viajes.entregarMando(c, tenantId, usuarioId, id, b, dni)
        : que === "aceptar"
          ? viajes.aceptarMando(c, tenantId, usuarioId, id, b, dni)
          : viajes.retirarEntrega(c, tenantId, usuarioId, id, dni)
    );
    if (!r.repetido) {
      await auditar(req, `viaje_mando_${que}`, {
        viajeId: id,
        numero: r.antes.numero,
        por: "conductor",
        medidor: b.medidor ?? null,
        lugar: b.lugar ?? null,
      });
    }
    res.json(r.despues);
  };
}

async function auditar(req: Request, accion: string, detalle: Record<string, unknown>) {
  const tenantId = getTenantId(req);
  await registrarAuditoria({
    accion: `combustible.${accion}`,
    tenantId,
    usuarioId: req.usuario!.id,
    detalle,
    contexto: contextoAuditoriaModulo(req),
  });
  await publicarEventoTenant(tenantId, EVENTO, {});
}

export const viajesController = {
  async listarLugares(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    res.json({ data: await withTenant(tenantId, (c) => viajes.listarLugares(c, tenantId)) });
  },

  async crearLugar(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    const lugar = await withTenant(tenantId, (c) =>
      viajes.crearLugar(c, tenantId, req.usuario!.id, req.validatedBody as CrearLugarInput)
    );
    await auditar(req, "lugar_crear", { lugarId: lugar.id, nombre: lugar.nombre });
    res.status(201).json(lugar);
  },

  async editarLugar(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    const id = Number(req.params.lugarId);
    // El id llega de la URL: uno desbordado no debe llegar a Postgres como bigint.
    if (!Number.isSafeInteger(id)) throw new AppError(404, "El lugar no existe");
    const { despues, campos } = await withTenant(tenantId, (c) =>
      viajes.editarLugar(c, tenantId, id, req.validatedBody as EditarLugarInput)
    );
    if (campos.length) {
      // Solo ids y los NOMBRES de los campos: la auditoría no copia el contenido del tenant.
      const accion = campos.includes("activo")
        ? despues.activo
          ? "lugar_activar"
          : "lugar_desactivar"
        : "lugar_editar";
      await auditar(req, accion, { lugarId: id, campos });
    }
    res.json(despues);
  },

  /** GET /viajes (panel de gestión) y GET /viajes/consumo (Histórico): la
   *  misma consulta, con permisos distintos. */
  async listar(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    const q = req.validatedQuery as ListarViajesQuery;
    const filas = await withTenant(tenantId, (c) =>
      viajes.listarViajes(c, tenantId, q, ambitoDe(req))
    );
    res.json({ data: filas });
  },

  /** El resumen de cada conductor en un período (km, horas al volante, puntualidad y consumo). */
  async resumenConductores(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    const q = req.validatedQuery as ListarViajesQuery;
    const filas = await withTenant(tenantId, (c) =>
      viajes.resumenPorConductor(c, tenantId, q, ambitoDe(req))
    );
    res.json({ data: filas });
  },

  /** Cada producto tiene su propio permiso: combustible pide "Consumo por viaje"
   *  (pestaña de Viajes), urea la consulta de Urea. */
  async listarConsumo(req: Request, res: Response) {
    const q = req.validatedQuery as ListarViajesQuery;
    const pestana = q.producto === "urea" ? "urea:vista" : "viajes:consumo";
    const u = req.usuario!;
    if (
      !pestanaPermitida(
        { rol: u.rol, permisosPestanas: u.permisosPestanas },
        "combustible",
        pestana
      )
    ) {
      res.status(403).json({ ok: false, message: "Pestaña no disponible para este perfil" });
      return;
    }
    return viajesController.listar(req, res);
  },

  async detalle(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    const id = Number(req.params.viajeId);
    const r = await withTenant(tenantId, (c) =>
      viajes.cargasDelViaje(c, tenantId, id, ambitoDe(req), true)
    );
    if (!r) {
      res.status(404).json({ error: "El viaje no existe" });
      return;
    }
    res.json(r);
  },

  async crear(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    const data = req.validatedBody as CrearViajeInput;
    const viaje = await withTenant(tenantId, (c) =>
      viajes.crearViaje(c, tenantId, req.usuario!.id, data)
    );
    await auditar(req, "viaje_crear", { viajeId: viaje.id, numero: viaje.numero, ...data });
    res.status(201).json(viaje);
  },

  async medidorPrevio(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    const id = Number(req.params.viajeId);
    const r = await withTenant(tenantId, async (c) => {
      const v = await viajes.getViaje(c, tenantId, id);
      return v ? viajes.medidorPrevio(c, tenantId, v.equipo_id) : null;
    });
    if (!r) {
      res.status(404).json({ error: "El viaje no existe" });
      return;
    }
    res.json(r);
  },

  async iniciar(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    const id = Number(req.params.viajeId);
    const data = req.validatedBody as IniciarViajeInput;
    const { antes, despues } = await withTenant(tenantId, (c) =>
      viajes.iniciarViaje(
        c,
        tenantId,
        req.usuario!.id,
        id,
        data,
        undefined,
        req.usuario!.rol === "admin"
      )
    );
    await auditar(req, "viaje_iniciar", {
      viajeId: id,
      numero: antes.numero,
      manual: data.inicio_en !== undefined,
      ...data,
      medidor_previo: despues?.medidor_previo ?? null,
    });
    res.json(despues);
  },

  /** GET /viajes/mios: lo que ve el conductor en "Mi viaje", por su DNI. */
  async mios(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    const dni = req.usuario!.dni ?? "";
    const data = await withTenant(tenantId, (c) => viajes.viajesDelConductor(c, tenantId, dni));
    res.json({ data, sinDni: !dni.trim() });
  },

  /** GET /viajes/mios/historial: sus viajes cerrados, por páginas. */
  async historialMio(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    const dni = req.usuario!.dni ?? "";
    const { limite, antes } = req.validatedQuery as HistorialMioQuery;
    const r = await withTenant(tenantId, (c) =>
      viajes.historialDelConductor(c, tenantId, dni, limite, antes)
    );
    res.json({ ...r, sinDni: !dni.trim() });
  },

  /** GET /viajes/mi-unidad: la unidad del viaje del conductor, para precargar
   *  la compra en ruta. Sin viaje (o sin DNI) devuelve data: null y todo sigue manual. */
  async miUnidad(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    const dni = req.usuario!.dni ?? "";
    const data = await withTenant(tenantId, (c) => viajes.unidadDelViajeActivo(c, tenantId, dni));
    res.json({ data });
  },

  async conductores(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    res.json({ data: await withTenant(tenantId, (c) => viajes.listarConductores(c, tenantId)) });
  },

  async iniciarMio(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    const id = Number(req.params.viajeId);
    const data = req.validatedBody as IniciarMiViajeInput;
    const r = await withTenant(tenantId, (c) =>
      viajes.iniciarViaje(c, tenantId, req.usuario!.id, id, data, req.usuario!.dni ?? "")
    );
    if (!r.repetido) {
      await auditar(req, "viaje_iniciar", {
        viajeId: id,
        numero: r.antes.numero,
        por: "conductor",
        origen_hora: r.despues?.inicio_origen_hora,
        ...data,
        medidor_previo: r.despues?.medidor_previo ?? null,
      });
    }
    res.json(r.despues);
  },

  /** ¿Puede este conductor ver «Empezar un viaje»? Lo decide el interruptor de su empresa. */
  async miConfig(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    const puede = await withTenant(tenantId, (c) => conductorPuedeCrearViaje(c, tenantId));
    res.json({ puede_crear_viaje: puede });
  },

  /** Las marcas del conductor sobre un viaje que creó sin señal: llegan por su `id_cliente` (el celular
   *  aún no conoce el número). Lo busca y deja `viajeId` para que siga el mismo camino de siempre.
   *  Si el viaje todavía no existe, 404: la cola envía en orden, así que solo pasa si su creación se
   *  descartó, y entonces estas marcas se descartan con ella. */
  async resolverPorCliente(req: Request, res: Response, next: NextFunction) {
    const tenantId = getTenantId(req);
    const r = await withTenant(tenantId, (c) =>
      c.query(`SELECT id FROM combustible_viajes WHERE tenant_id = $1 AND id_cliente = $2`, [
        tenantId,
        req.params.idCliente,
      ])
    );
    if (!r.rows[0]) throw new AppError(404, "Ese viaje todavía no existe");
    req.params.viajeId = String(r.rows[0].id);
    next();
  },

  /** GET /viajes/mios/catalogo: lugares, unidades con su ruta y relevos para armar el viaje. Con el
   *  interruptor de la empresa apagado devuelve `puede_crear_viaje: false` y nada más. */
  async miCatalogo(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    const data = await withTenant(tenantId, (c) =>
      catalogoParaCrear(c, tenantId, {
        usuarioId: req.usuario!.id,
        dni: req.usuario!.dni ?? "",
        nombre: req.usuario!.nombre,
      })
    );
    res.json(data);
  },

  /** El conductor crea e inicia su propio viaje (0179). 201 al crearlo, 200 si es un reintento del
   *  mismo identificador, 403 con el interruptor de la empresa apagado y 409 si ya tiene un viaje
   *  (se devuelve el que tiene). La alerta para la oficina se abre en un SAVEPOINT: si falla, el
   *  viaje se guarda igual. */
  async crearMio(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    const data = req.validatedBody as CrearMiViajeInput;
    const { r, alertaCambio } = await withTenant(tenantId, async (c) => {
      const r = await crearMiViaje(
        c,
        tenantId,
        { usuarioId: req.usuario!.id, dni: req.usuario!.dni ?? "", nombre: req.usuario!.nombre },
        data
      );
      if (r.repetido) return { r, alertaCambio: false };
      const v = r.viaje;
      const alertaCambio = await enSavepoint(c, tenantId, Number(v.id), () =>
        combustible.abrirAlertaViajeCreadoPorConductor(
          c,
          tenantId,
          {
            id: Number(v.id),
            numero: v.numero,
            unidad: v.placa_codigo ?? v.codigo_interno ?? null,
            conductor: v.conductor_nombre ?? null,
          },
          { de: v.origen ?? null, a: v.destino ?? null, unidadNueva: r.unidadNueva }
        )
      );
      return { r, alertaCambio };
    });
    if (alertaCambio) await avisarCampanita(tenantId);
    if (!r.repetido) {
      await auditar(req, "viaje_crear_mio", {
        viajeId: Number(r.viaje.id),
        numero: r.viaje.numero,
        por: "conductor",
        unidad_nueva: r.unidadNueva,
        origen_hora: r.viaje.inicio_origen_hora,
        id_cliente: data.id_cliente,
      });
    }
    res.status(r.repetido ? 200 : 201).json(r.viaje);
  },

  async cerrarMio(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    const id = Number(req.params.viajeId);
    const data = req.validatedBody as CerrarMiViajeInput;
    const { r, alertaCambio } = await withTenant(tenantId, async (c) => {
      const r = await viajes.cerrarViaje(
        c,
        tenantId,
        req.usuario!.id,
        id,
        data,
        req.usuario!.dni ?? ""
      );
      return { r, alertaCambio: r.repetido ? false : await cerrarAlertasDelViaje(c, tenantId, id) };
    });
    if (alertaCambio) await avisarCampanita(tenantId);
    if (!r.repetido) {
      await auditar(req, "viaje_cerrar", {
        viajeId: id,
        numero: r.antes.numero,
        por: "conductor",
        origen_hora: r.despues?.fin_origen_hora,
        ...data,
      });
    }
    res.json(r.despues);
  },

  /** «El relevo maneja» de un relevo sin cuenta: solo deja historial (0180). */
  async manejaMio(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    const id = Number(req.params.viajeId);
    const data = req.validatedBody as ManejaMioInput;
    const r = await withTenant(tenantId, (c) =>
      viajes.registrarManejo(c, tenantId, req.usuario!.id, id, data, req.usuario!.dni ?? "")
    );
    if (!r.repetido) {
      await auditar(req, "viaje_maneja", {
        viajeId: id,
        numero: r.antes.numero,
        por: "conductor",
        quien: data.quien,
      });
    }
    res.json(r.despues);
  },

  /** La oficina anota dónde está la unidad del viaje (lugar del catálogo o texto libre). */
  async registrarUbicacion(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    const id = Number(req.params.viajeId);
    const b = req.validatedBody as RegistrarUbicacionInput;
    const r = await withTenant(tenantId, (c) =>
      viajes.registrarUbicacion(c, tenantId, req.usuario!.id, id, b)
    );
    if (!r.repetido) {
      await auditar(req, "viaje_ubicacion", {
        viajeId: id,
        numero: r.antes.numero,
        por: "oficina",
        lugarId: b.lugar_id ?? null,
        texto: r.texto,
        nota: b.nota?.trim() || null,
        manual: b.registrado_en !== undefined,
      });
    }
    res.status(r.repetido ? 200 : 201).json(r.despues);
  },

  descansoMio: marcaDeDescanso("inicio", true),
  terminarDescansoMio: marcaDeDescanso("fin", true),
  descanso: marcaDeDescanso("inicio", false),
  terminarDescanso: marcaDeDescanso("fin", false),
  entregarMando: marcaDeMando("entregar"),
  aceptarMando: marcaDeMando("aceptar"),
  retirarEntrega: marcaDeMando("retirar"),

  /** La oficina corrige un cambio de mando que nadie marcó (con motivo). */
  async corregirMando(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    const id = Number(req.params.viajeId);
    const data = req.validatedBody as CorregirMandoInput;
    const { r, alertaCambio } = await withTenant(tenantId, async (c) => {
      const r = await viajes.corregirMando(c, tenantId, req.usuario!.id, id, data);
      // Quién manejaba cambió: una detención puede haber dejado de frenar la unidad (o al revés).
      return { r, alertaCambio: await alertaDeDetencion(c, tenantId, id) };
    });
    if (alertaCambio) await avisarCampanita(tenantId);
    await auditar(req, "viaje_mando_corregir", {
      viajeId: id,
      numero: r.antes.numero,
      por: "oficina",
      a_dni: data.a_dni,
      cambio_en: data.cambio_en,
      medidor: data.medidor ?? null,
      motivo: data.motivo,
    });
    res.json(r.despues);
  },
  async corregirMarca(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    const id = Number(req.params.viajeId);
    const orden = Number(req.params.orden);
    const data = req.validatedBody as CorregirMarcaDeParadaInput;
    const r = await withTenant(tenantId, (c) =>
      viajes.corregirMarcaDeParada(c, tenantId, id, orden, data)
    );
    await auditar(req, "viaje_marca_corregir", {
      viajeId: id,
      numero: r.antes.numero,
      por: "oficina",
      parada: orden,
      marca: data.que,
      antes: r.previo,
      hora: data.hora ?? null,
      medidor: data.medidor ?? null,
      motivo: data.motivo,
    });
    res.json(r.despues);
  },
  /** El resumen del Control TV (gerencia): flota por estado y, si la empresa tiene Combustible,
   *  inventario, alertas y urea. Sin ese módulo el bloque falta, no es un error. */
  async controlTvResumen(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    const u = req.usuario!;
    const tieneCombustible = u.modulosPermitidos.includes("combustible");
    const alcance = ambitoDe(req).alcance;
    res.json(
      await withTenant(tenantId, (c) =>
        resumenControlTv(
          c,
          tenantId,
          {
            alcance,
            combustible: tieneCombustible,
            urea: tieneCombustible && pestanaPermitida(u, "combustible", "urea:vista"),
            usuarioId: u.id,
          },
          combustible
        )
      )
    );
  },

  /** El consumo y la entrada de combustible del período (24 h, 7 o 30 días) para el Control TV. Sin
   *  el módulo Combustible no hay nada que calcular: responde vacío, no 403. */
  async controlTvConsumo(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    if (!req.usuario!.modulosPermitidos.includes("combustible")) return res.json({});
    const periodo = req.validatedQuery as { periodo: PeriodoTv };
    res.json(
      await withTenant(tenantId, (c) =>
        consumoControlTv(c, tenantId, periodo.periodo, ambitoDe(req), combustible)
      )
    );
  },

  /** La pestaña «Detalle» del Control TV: el consumo anterior, la urea, las últimas recepciones
   *  contra su factura, las unidades que más se desvían y lo que cuesta comprar en ruta. Sin
   *  Combustible responde vacío, no 403. */
  async controlTvDetalle(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    const u = req.usuario!;
    if (!u.modulosPermitidos.includes("combustible")) return res.json({});
    const q = req.validatedQuery as { periodo: PeriodoTv };
    res.json(
      await withTenant(tenantId, (c) =>
        detalleControlTv(
          c,
          tenantId,
          q.periodo,
          ambitoDe(req),
          combustible,
          pestanaPermitida(u, "combustible", "urea:vista")
        )
      )
    );
  },

  /** El resumen de una unidad en el Control TV: viajes de su conductor, rendimiento, estadía normal
   *  de la ruta, últimas cargas y alertas abiertas. Fuera del alcance es un 404. Sin Combustible
   *  responde vacío, no 403. */
  async controlTvUnidad(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    if (!req.usuario!.modulosPermitidos.includes("combustible")) return res.json({});
    const id = Number(req.params.viajeId);
    const r = await withTenant(tenantId, (c) =>
      resumenDeUnidad(c, tenantId, id, ambitoDe(req), combustible)
    );
    if (!r) return res.status(404).json({ error: "El viaje no existe" });
    res.json(r);
  },

  /** La oficina marca cualquier parada sin orden; cambiar una marca puesta queda auditado con su
   *  hora anterior y el motivo. */
  async marcarSinOrden(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    const id = Number(req.params.viajeId);
    const b = req.validatedBody as MarcaSinOrdenInput;
    const { r, alertaCambio } = await withTenant(tenantId, async (c) => {
      const r = await viajes.marcarParadaSinOrden(c, tenantId, req.usuario!.id, id, b);
      const cierra = b.que === "llegada" && !r.repetido;
      const detencion =
        b.descanso && !r.repetido ? await alertaDeDetencion(c, tenantId, id) : false;
      return {
        r,
        alertaCambio: (cierra ? await cerrarAlertasDelViaje(c, tenantId, id) : false) || detencion,
      };
    });
    if (alertaCambio) await avisarCampanita(tenantId);
    if (!r.repetido) {
      await auditar(req, r.cierra ? "viaje_cerrar" : `viaje_${b.que}`, {
        viajeId: id,
        numero: r.antes.numero,
        parada: r.orden,
        por: "oficina",
        medidor: b.medidor ?? null,
        motivo: b.motivo ?? null,
        manual: b.hora !== undefined,
        reemplazo: b.reemplazar ? { antes: r.previo } : undefined,
        descanso: b.descanso
          ? { desde: b.descanso.desde, hasta: b.descanso.hasta ?? null }
          : undefined,
      });
    }
    res.json(r.despues);
  },
  llegadaMia: marcaDeParada("llegada", true),
  salidaMia: marcaDeParada("salida", true),
  llegada: marcaDeParada("llegada", false),
  salida: marcaDeParada("salida", false),

  /** La oficina pone al día lo que nadie marcó: llegadas, salidas y descansos con sus horas reales,
   *  todo o nada. Cada paso queda en la auditoría como si se hubiera marcado por separado. */
  async ponerAlDia(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    const id = Number(req.params.viajeId);
    const b = req.validatedBody as PonerAlDiaInput;
    const { r, alertaCambio } = await withTenant(tenantId, async (c) => {
      const r = await viajes.ponerAlDiaViaje(c, tenantId, req.usuario!.id, id, b);
      // Igual que las marcas sueltas: llegar termina el tramo (y la demora de su alerta), y un
      // descanso abre o cierra la alerta de unidad detenida.
      const cierraDemora = r.pasos.some((p) => p.clase === "llegada")
        ? await cerrarAlertasDelViaje(c, tenantId, id)
        : false;
      const cambiaDetencion = r.pasos.some((p) => p.clase.startsWith("descanso"))
        ? await alertaDeDetencion(c, tenantId, id)
        : false;
      return { r, alertaCambio: cierraDemora || cambiaDetencion };
    });
    if (alertaCambio) await avisarCampanita(tenantId);
    for (const p of r.pasos) {
      const accion =
        p.clase === "llegada"
          ? p.cierra
            ? "viaje_cerrar"
            : "viaje_llegada"
          : p.clase === "salida"
            ? "viaje_salida"
            : p.clase === "descanso_inicio"
              ? "viaje_descanso_iniciar"
              : "viaje_descanso_terminar";
      await auditar(req, accion, {
        viajeId: id,
        numero: r.antes.numero,
        parada: p.orden,
        por: "oficina",
        medidor: p.medidor,
        motivo: p.motivo ?? b.motivo,
        manual: true,
        puestoAlDia: true,
      });
    }
    res.json(r.despues);
  },

  async cerrar(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    const id = Number(req.params.viajeId);
    const data = req.validatedBody as CerrarViajeInput;
    const { antes, despues, alertaCambio } = await withTenant(tenantId, async (c) => {
      const r = await viajes.cerrarViaje(c, tenantId, req.usuario!.id, id, data);
      return { ...r, alertaCambio: await cerrarAlertasDelViaje(c, tenantId, id) };
    });
    if (alertaCambio) await avisarCampanita(tenantId);
    await auditar(req, "viaje_cerrar", {
      viajeId: id,
      numero: antes.numero,
      manual: data.fin_en !== undefined,
      ...data,
    });
    res.json(despues);
  },

  async editar(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    const id = Number(req.params.viajeId);
    const data = req.validatedBody as EditarViajeInput;
    const { antes, despues, alertaCambio } = await withTenant(tenantId, async (c) => {
      const r = await viajes.editarViaje(c, tenantId, id, data, req.usuario!.id);
      // Ponerle llegada a un viaje en curso lo cierra: sus alertas se cierran con él.
      const cierra = r.antes.estado === "en_curso" && r.despues?.estado === "cerrado";
      return { ...r, alertaCambio: cierra ? await cerrarAlertasDelViaje(c, tenantId, id) : false };
    });
    if (alertaCambio) await avisarCampanita(tenantId);
    const { motivo, ...cambios } = data;
    await auditar(req, "viaje_editar", {
      viajeId: id,
      numero: antes.numero,
      motivo,
      antes: {
        origen_id: antes.origen_id,
        destino_id: antes.destino_id,
        inicio_en: antes.inicio_en,
        fin_en: antes.fin_en,
        medidor_inicio: antes.medidor_inicio,
        medidor_fin: antes.medidor_fin,
        conductor_nombre: antes.conductor_nombre,
        salida_programada_en: antes.salida_programada_en,
        desfase_tolerancia_min: antes.desfase_tolerancia_min,
      },
      cambios,
    });
    res.json(despues);
  },

  async anular(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    const id = Number(req.params.viajeId);
    const { motivo } = req.validatedBody as AnularViajeInput;
    const { antes, alertaCambio } = await withTenant(tenantId, async (c) => {
      const antes = await viajes.anularViaje(c, tenantId, req.usuario!.id, id, motivo);
      return { antes, alertaCambio: await cerrarAlertasDelViaje(c, tenantId, id) };
    });
    if (alertaCambio) await avisarCampanita(tenantId);
    await auditar(req, "viaje_anular", { viajeId: id, numero: antes.numero, motivo });
    res.json({ ok: true });
  },
};
