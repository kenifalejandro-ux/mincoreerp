/** src/modules/equipos/equipos.controller.ts */

import { Request, Response } from "express";
import { withTenant } from "../../server/config/database";
import { getTenantId } from "../../server/shared/utils/request";
import { parsePaginacion, armarRespuestaPaginada } from "../../server/shared/utils/pagination";
import { contextoAuditoriaModulo } from "../../server/shared/utils/moduleAudit";
import { registrarAuditoria } from "../../server/services/platformAudit.service";
import { publicarEventoTenant } from "../../server/services/realtimeEvents.service";
import type {
  CrearEquipoInput,
  ActualizarEquipoInput,
  CargaMasivaEquiposInput,
  EliminarMasivoEquiposInput,
} from "../../server/schemas/equipos.schema";
import type { MoverDeGrifoInput } from "../../server/schemas/sedes.schema";
import { findDestinatariosAlertas } from "../../server/shared/utils/destinatariosAlertas";
import { enviarCorreoAlerta } from "../../server/shared/utils/alertaMailer";
import { logger } from "../../server/config/logger";
import { armarXlsx, CONTENT_TYPE_XLSX } from "../../server/shared/utils/xlsx.util";
import { AppError } from "../../server/shared/middlewares/error.middleware";
import { estadoDeUnidad } from "./equipos.estado";
import { EquiposService, type CambiosHistorial } from "./equipos.service";

/** Un AppError (p. ej. "falta el motivo") sale con su código y su mensaje; lo
 *  demás sigue siendo un 500 genérico. Devuelve true si ya respondió. */
function responderAppError(err: unknown, res: Response): boolean {
  if (!(err instanceof AppError)) return false;
  res.status(err.statusCode).json({ message: err.message, error: err.message });
  return true;
}

/** ¿Este PUT le AMPLÍA el techo diario de combustible al equipo?
 *
 *  El techo sale de `capacidad_tanque × llenados_por_dia_max` (migración
 *  0079), así que subir la capacidad lo sube en la misma proporción, y
 *  BORRARLA lo deja sin techo propio -- cae al tope genérico, que puede
 *  estar sin configurar y entonces no hay techo ninguno.
 *
 *  Encenderlo (null → número) NO cuenta como ampliar: es configurar algo
 *  que no estaba configurado. Es la misma regla que ya rige para los
 *  umbrales del tanque ("encender un control nunca es aflojar"), y bajarla
 *  tampoco, porque estrecha.
 *
 *  Compara en LITROS: un equipo puede tener la capacidad cargada en galones
 *  y comparar los números crudos diría cualquier cosa. */
function detectarAmpliacionDeTecho(
  antes: {
    capacidad_tanque?: string | number | null;
    capacidad_tanque_unidad?: string | null;
  } | null,
  ahora: { capacidad_tanque?: number | null; capacidad_tanque_unidad?: string | null }
): { de: string; a: string } | null {
  if (!antes) return null;

  const aLitros = (valor: number, unidad?: string | null) =>
    unidad === "gal" ? valor * 3.785411784 : valor;

  const viejoNum = antes.capacidad_tanque == null ? null : Number(antes.capacidad_tanque);
  const nuevoNum = ahora.capacidad_tanque ?? null;

  const texto = (v: number | null, u?: string | null) =>
    v === null ? "sin capacidad cargada" : `${v} ${u ?? "L"}`;

  // Nunca la tuvo, o la está cargando por primera vez: no había techo propio
  // que ampliar.
  if (viejoNum === null) return null;

  // Se la quitaron: pierde su techo propio.
  if (nuevoNum === null) {
    return { de: texto(viejoNum, antes.capacidad_tanque_unidad), a: texto(null) };
  }

  const viejoL = aLitros(viejoNum, antes.capacidad_tanque_unidad);
  const nuevoL = aLitros(nuevoNum, ahora.capacidad_tanque_unidad);
  if (nuevoL <= viejoL) return null;

  return {
    de: texto(viejoNum, antes.capacidad_tanque_unidad),
    a: texto(nuevoNum, ahora.capacidad_tanque_unidad),
  };
}

/** Subir el consumo máximo, o quitarlo, afloja el control de consumo del
 *  equipo (migración 0088). Cargarlo por primera vez lo ENCIENDE: eso nunca
 *  es aflojar -- mismo criterio que la capacidad del tanque. */
function detectarAflojamientoDeConsumo(
  antes: { consumo_maximo_l?: string | number | null } | null,
  ahora: { consumo_maximo_l?: number | null }
): { de: string; a: string } | null {
  if (!antes) return null;
  const viejo = antes.consumo_maximo_l == null ? null : Number(antes.consumo_maximo_l);
  const nuevo = ahora.consumo_maximo_l ?? null;
  if (viejo === null) return null;
  const texto = (v: number | null) => (v === null ? "sin configurar (no alerta)" : `${v} L`);
  if (nuevo === null) return { de: texto(viejo), a: texto(null) };
  if (nuevo <= viejo) return null;
  return { de: texto(viejo), a: texto(nuevo) };
}

export const EquiposController = {
  async getAll(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const paginacion = parsePaginacion(req.query);
      const filas = await withTenant(tenantId, (client) =>
        EquiposService.getAll(client, tenantId, paginacion)
      );
      res.json(armarRespuestaPaginada(filas, paginacion));
    } catch {
      res.status(500).json({ message: "Error al obtener equipos" });
    }
  },

  async create(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const data = req.validatedBody as CrearEquipoInput;
      const { fila: nuevo, creado } = await withTenant(tenantId, (client) =>
        EquiposService.create(client, tenantId, req.usuario!.id, data)
      );

      // Reintento de un envío que ya se había guardado (la respuesta
      // original se perdió en la red). No se audita ni se publica el
      // evento de nuevo -- eso ya pasó la primera vez. 200 y no 201 porque
      // esta llamada no creó nada, pero sigue siendo 2xx a propósito: la
      // cola offline del dispositivo puede darlo por sincronizado.
      if (!creado) {
        res
          .status(200)
          .json(nuevo ?? { message: "Este equipo ya se había registrado y luego se eliminó" });
        return;
      }

      await registrarAuditoria({
        accion: "equipos.crear",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { equipoId: nuevo!.id },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "equipos.creado", { equipoId: nuevo!.id });
      res.status(201).json(nuevo);
    } catch (err) {
      // Grifo interno (0097): falta con más de un grifo, no existe o está dado
      // de baja. 400 y no 500: la cola offline descarta los 4xx y los reporta
      // en vez de reintentarlos para siempre.
      if (responderAppError(err, res)) return;
      if (err instanceof Error && err.message.includes("grifo interno")) {
        res.status(400).json({ message: err.message, error: err.message });
        return;
      }
      res.status(500).json({ message: "Error al crear equipo" });
    }
  },

  /** POST /:id/mover-grifo -- el único camino para cambiar el grifo interno
   *  de un equipo (0097). Solo admin, con motivo. Vive en Equipos porque este
   *  módulo es el dueño de la fila. */
  async moverDeGrifo(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    const id = Number(req.params.id);
    const data = req.validatedBody as MoverDeGrifoInput;
    const movido = await withTenant(tenantId, (client) =>
      EquiposService.moverDeGrifo(client, tenantId, req.usuario!.id, id, data)
    );
    if (!movido) {
      res.status(404).json({ message: "Equipo no encontrado", error: "Equipo no encontrado" });
      return;
    }
    await registrarAuditoria({
      accion: "equipos.mover_grifo",
      tenantId,
      usuarioId: req.usuario!.id,
      detalle: {
        equipoId: id,
        grifoOrigenId: movido.grifoOrigenId,
        grifoDestinoId: data.grifo_interno_id,
        motivo: data.motivo,
      },
      contexto: contextoAuditoriaModulo(req),
    });
    await publicarEventoTenant(tenantId, "equipos.actualizado", { equipoId: id });
    res.json({ ok: true });
  },

  /** GET /:id/movimientos-grifo -- el historial de ubicación del equipo. */
  async listarMovimientosDeGrifo(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    const filas = await withTenant(tenantId, (client) =>
      EquiposService.listarMovimientosDeGrifo(client, tenantId, Number(req.params.id))
    );
    res.json(filas);
  },

  async update(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);
      const data = req.validatedBody as ActualizarEquipoInput;

      // La capacidad del tanque del equipo (migración 0069) existe SOLO para
      // combustible: es el multiplicando del techo diario por equipo
      // (`capacidad × llenados_por_dia_max`, migración 0079). Subirla anula
      // ese techo -- y hasta la tercera auditoría adversaria eso se hacía
      // desde esta pantalla, en otro módulo, con la auditoría registrando
      // `{ equipoId }` y nada más. Se comprobó en vivo: con capacidad 500 L
      // un despacho de 700 alertaba; después de subirla a 50.000, uno de
      // 5.000 no alertaba nada.
      //
      // Por eso hace falta el estado ANTERIOR: sin él no hay forma de saber
      // si el cambio amplió o estrechó el techo.
      const resultado = await withTenant(tenantId, async (client) => {
        const antes = await EquiposService.getById(client, tenantId, id);
        const actualizado = await EquiposService.update(
          client,
          tenantId,
          req.usuario!.id,
          id,
          data
        );
        return { actualizado, antes };
      });
      const { antes } = resultado;

      if (!resultado.actualizado) {
        res.status(404).json({ message: "Equipo no encontrado" });
        return;
      }
      const { fila: actualizado, cambios } = resultado.actualizado as {
        fila: Record<string, unknown> & { placa_codigo: string };
        cambios: CambiosHistorial;
      };

      const ampliacion = detectarAmpliacionDeTecho(antes, data);
      // Subir (o quitar) el consumo máximo afloja igual que subir la
      // capacidad: es el techo del único control que ve el combustible que
      // sale con vale y no llega al equipo (migración 0088).
      const consumoAflojado = detectarAflojamientoDeConsumo(antes, data);

      await registrarAuditoria({
        // Acción propia cuando se amplía, igual que
        // `combustible.tanque_vigilancia_reducida`: buscar quién le levantó
        // el techo a un equipo no puede obligar a leer todas las ediciones
        // de ficha una por una.
        accion:
          ampliacion || consumoAflojado
            ? ampliacion
              ? "equipos.capacidad_tanque_ampliada"
              : "equipos.consumo_maximo_ampliado"
            : "equipos.actualizar",
        tenantId,
        usuarioId: req.usuario!.id,
        // El detalle lleva los VALORES, no solo el id. Sin el "de cuánto a
        // cuánto" la bitácora dice que algo cambió pero no si eso aflojó un
        // control -- que es exactamente lo que la auditoría encontró.
        detalle: {
          equipoId: id,
          ...(ampliacion ?? {}),
          ...(consumoAflojado ? { consumo: consumoAflojado } : {}),
        },
        contexto: contextoAuditoriaModulo(req),
      });

      // Cambiar el conductor o las rutas de una unidad es un hecho propio en la
      // bitácora, con el "de qué a qué" y el motivo: es lo que gerencia busca
      // cuando investiga una incidencia.
      if (cambios.conductor) {
        await registrarAuditoria({
          accion: "equipos.cambiar_conductor",
          tenantId,
          usuarioId: req.usuario!.id,
          detalle: { equipoId: id, ...cambios.conductor, motivo: cambios.motivo },
          contexto: contextoAuditoriaModulo(req),
        });
      }
      if (cambios.rutas) {
        await registrarAuditoria({
          accion: "equipos.cambiar_rutas",
          tenantId,
          usuarioId: req.usuario!.id,
          detalle: { equipoId: id, ...cambios.rutas, motivo: cambios.motivo },
          contexto: contextoAuditoriaModulo(req),
        });
      }

      if (consumoAflojado) {
        try {
          const admins = await withTenant(tenantId, (client) =>
            findDestinatariosAlertas(client, tenantId, "combustible")
          );
          await enviarCorreoAlerta({
            destinatarios: admins,
            asunto: `Combustible: se aflojó el consumo máximo de ${actualizado.placa_codigo}`,
            titulo:
              `${req.usuario!.nombre ?? req.usuario!.email ?? "Un administrador"} cambió el ` +
              `consumo máximo de ${actualizado.placa_codigo}`,
            lineas: [
              `Consumo máximo: ${consumoAflojado.de} → ${consumoAflojado.a}.`,
              "Es el techo del control que compara los litros cargados contra el trabajo del " +
                "equipo (horas de motor o km). Aflojarlo deja pasar vales por más combustible " +
                "del que la máquina pudo haber consumido.",
            ],
          });
        } catch (err) {
          logger.warn(
            { err, tenantId, equipoId: id },
            "No se pudo avisar del cambio de consumo máximo"
          );
        }
      }

      if (ampliacion) {
        // Nunca bloquea: el cambio ya está guardado y auditado. Y se avisa a
        // los destinatarios de COMBUSTIBLE, no a los de equipos: el control
        // que se acaba de ensanchar es de ellos.
        try {
          const admins = await withTenant(tenantId, (client) =>
            findDestinatariosAlertas(client, tenantId, "combustible")
          );
          await enviarCorreoAlerta({
            destinatarios: admins,
            asunto: `Combustible: se amplió el techo diario de ${actualizado.placa_codigo}`,
            titulo:
              `${req.usuario!.nombre ?? req.usuario!.email ?? "Un administrador"} amplió la ` +
              `capacidad de tanque de ${actualizado.placa_codigo}`,
            lineas: [
              `Capacidad: ${ampliacion.de} → ${ampliacion.a}.`,
              "El tope diario de combustible de ese equipo sale de multiplicar su capacidad " +
                "por los llenados por día permitidos, así que este cambio ensancha ese tope " +
                "en la misma proporción.",
              "Si el equipo no cambió físicamente, revertilo y revisá lo que se le despachó " +
                "desde este momento.",
            ],
          });
        } catch (err) {
          logger.warn({ err, tenantId, equipoId: id }, "No se pudo avisar de la ampliación");
        }
      }
      await publicarEventoTenant(tenantId, "equipos.actualizado", { equipoId: id });
      res.json(actualizado);
    } catch (err) {
      if (responderAppError(err, res)) return;
      res.status(500).json({ message: "Error al actualizar equipo" });
    }
  },

  /** GET /:id/historial -- quién manejó la unidad y con qué rutas, y cuándo. */
  async historial(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    const h = await withTenant(tenantId, (client) =>
      EquiposService.historial(client, tenantId, Number(req.params.id))
    );
    if (!h) {
      res.status(404).json({ message: "Equipo no encontrado", error: "Equipo no encontrado" });
      return;
    }
    res.json(h);
  },

  /** GET /conductor/:dni -- las unidades que maneja o manejó ese conductor. */
  async unidadesDeConductor(req: Request, res: Response) {
    const dni = String(req.params.dni ?? "").trim();
    if (!/^[0-9A-Za-z-]{1,15}$/.test(dni)) {
      res.status(400).json({ message: "DNI inválido", error: "DNI inválido" });
      return;
    }
    const tenantId = getTenantId(req);
    const filas = await withTenant(tenantId, (client) =>
      EquiposService.unidadesDeConductor(client, tenantId, dni)
    );
    res.json(filas);
  },

  /** GET /lugares -- el catálogo de Viajes, de solo lectura, para el selector
   *  de ruta de la unidad. */
  async lugares(req: Request, res: Response) {
    const tenantId = getTenantId(req);
    const filas = await withTenant(tenantId, (client) => EquiposService.lugares(client, tenantId));
    res.json(filas);
  },

  async delete(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);
      const eliminado = await withTenant(tenantId, (client) =>
        EquiposService.delete(client, tenantId, id)
      );

      if (!eliminado) {
        res.status(404).json({ message: "Equipo no encontrado" });
        return;
      }
      await registrarAuditoria({
        accion: "equipos.eliminar",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { equipoId: id },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "equipos.eliminado", { equipoId: id });
      res.json({ message: "Eliminado" });
    } catch {
      res.status(500).json({ message: "Error al eliminar equipo" });
    }
  },

  /** POST /bulk -- importar la planilla de flota (placa/tipo/marca/modelo).
   *  Upsert por placa: reimportar la misma planilla corrige datos, no
   *  duplica. Auditoría con el CONTEO, no fila por fila -- mismo criterio
   *  que repuestos.controller.ts#bulk. */
  async bulk(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const rows = req.validatedBody as CargaMasivaEquiposInput;
      const result = await withTenant(tenantId, (client) =>
        EquiposService.createBulk(client, tenantId, rows)
      );
      await registrarAuditoria({
        accion: "equipos.carga_masiva",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { cantidad: result.length },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "equipos.carga_masiva", { cantidad: result.length });
      res.status(201).json({ insertados: result.length, data: result });
    } catch {
      res.status(500).json({ message: "Error en importación masiva" });
    }
  },

  /** DELETE /bulk -- borrar varios de una, para el "seleccionar todo" de la
   *  tabla. Mismo requireRole("admin") que el delete de a uno: no se
   *  relaja el permiso solo porque son varios a la vez. */
  async deleteMany(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const { ids } = req.validatedBody as EliminarMasivoEquiposInput;
      const eliminados = await withTenant(tenantId, (client) =>
        EquiposService.deleteMany(client, tenantId, ids)
      );
      await registrarAuditoria({
        accion: "equipos.eliminar_masivo",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { cantidad: eliminados.length, equipoIds: eliminados },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "equipos.eliminado_masivo", {
        cantidad: eliminados.length,
      });
      res.json({ eliminados: eliminados.length });
    } catch {
      res.status(500).json({ message: "Error al eliminar equipos" });
    }
  },

  /** GET /export/xlsx -- la flota del tenant, en el mismo orden de columnas que
   *  se ve en pantalla. Con `?ids=1,2,3` exporta solo esas unidades (lo que la
   *  pantalla tiene filtrado, hasta 1000: van en la URL); ids de otra empresa
   *  simplemente no aparecen. */
  async exportXlsx(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      let ids: number[] | undefined;
      if (typeof req.query.ids === "string" && req.query.ids !== "") {
        const partes = req.query.ids.split(",");
        if (partes.length > 1000 || !partes.every((p) => /^\d{1,9}$/.test(p))) {
          res
            .status(400)
            .json({ message: "Lista de ids inválida", error: "Lista de ids inválida" });
          return;
        }
        ids = partes.map(Number);
      }
      const filas = await withTenant(tenantId, (client) =>
        EquiposService.getAllParaExportar(client, tenantId, ids)
      );

      const libro = armarXlsx([
        {
          nombre: "Equipos",
          anchos: [16, 14, 22, 18, 22, 14, 14, 28, 14, 40, 14],
          filas: [
            [
              { valor: "Placa", negrita: true },
              { valor: "Código", negrita: true },
              { valor: "Tipo", negrita: true },
              { valor: "Marca", negrita: true },
              { valor: "Modelo", negrita: true },
              { valor: "Medidor", negrita: true },
              { valor: "Tanque", negrita: true },
              { valor: "Conductor", negrita: true },
              { valor: "DNI", negrita: true },
              { valor: "Rutas", negrita: true },
              { valor: "Estado", negrita: true },
            ],
            ...filas.map((e) => [
              e.placa_codigo,
              e.codigo_interno ?? "",
              e.tipo,
              e.marca ?? "",
              e.modelo ?? "",
              e.tipo_medidor === "horometro"
                ? "Horómetro"
                : e.tipo_medidor === "odometro"
                  ? "Odómetro"
                  : "",
              e.capacidad_tanque !== null
                ? `${Number(e.capacidad_tanque)} ${e.capacidad_tanque_unidad ?? ""}`.trim()
                : "",
              e.conductor_nombre ?? "",
              e.conductor_dni ?? "",
              ((e.rutas ?? []) as { origen: string; destino: string }[])
                .map((r) => `${r.origen} → ${r.destino}`)
                .join("; "),
              estadoDeUnidad(e),
            ]),
          ],
        },
      ]);

      res.setHeader("Content-Type", CONTENT_TYPE_XLSX);
      res.setHeader("Content-Disposition", `attachment; filename="equipos.xlsx"`);
      res.send(libro);
    } catch {
      res.status(500).json({ message: "Error al exportar equipos" });
    }
  },
};
