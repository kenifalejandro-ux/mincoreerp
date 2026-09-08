/**src/modules/combutible/combustible.controller.ts */

import { Request, Response } from "express";
import { withTenant } from "../../server/config/database";
import { getTenantId } from "../../server/shared/utils/request";
import { parsePaginacion, armarRespuestaPaginada } from "../../server/shared/utils/pagination";
import { contextoAuditoriaModulo } from "../../server/shared/utils/moduleAudit";
import {
  registrarAuditoria,
  listarAuditoriaService,
} from "../../server/services/platformAudit.service";
import { publicarEventoTenant } from "../../server/services/realtimeEvents.service";
import { logger } from "../../server/config/logger";
import {
  enviarCorreoAlertaHueco,
  enviarCorreoAlertaAnulacion,
  enviarCorreoAlertaSobredespacho,
  enviarCorreoAlertaMedidor,
  enviarCorreoAlertaNivelBajo,
  enviarCorreoAlertaDescuadre,
  enviarCorreoAlertaDescuadreCiclo,
  enviarCorreoVigilanciaReducida,
  enviarCorreoTopeDiario,
  enviarCorreoLecturaRetroactiva,
} from "./combustibleAlertas.mailer";
import type {
  RegistrarLecturaCombustibleInput,
  ActualizarNivelCombustibleInput,
  CrearTanqueCombustibleInput,
  ActualizarTanqueCombustibleInput,
  CargaMasivaTanquesCombustibleInput,
  AnularLecturaCombustibleInput,
  CrearDespachoCombustibleInput,
  CrearGrifoCombustibleInput,
  ActualizarGrifoCombustibleInput,
  CrearPrecioCombustibleInput,
  AnularPrecioCombustibleInput,
  CrearRecepcionCombustibleInput,
  AnularRecepcionCombustibleInput,
  AnularDespachoCombustibleInput,
  MarcarAlertasLeidasCombustibleInput,
  BajaTanqueCombustibleInput,
  ResolverAlertaCombustibleInput,
  ConfigCombustibleInput,
} from "../../server/schemas/combustible.schema";
import { CombustibleService } from "./combustible.service";

const service = new CombustibleService();

export class CombustibleController {
  async getAll(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const data = await withTenant(tenantId, (client) => service.getAll(client, tenantId));
      res.json(data);
    } catch {
      res.status(500).json({ error: "Error al obtener combustible" });
    }
  }

  async getById(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);
      const data = await withTenant(tenantId, (client) => service.getById(client, tenantId, id));

      if (!data) {
        return res.status(404).json({ error: "No encontrado" });
      }

      res.json(data);
    } catch {
      res.status(500).json({ error: "Error al obtener combustible" });
    }
  }

  async create(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const data = req.validatedBody as CrearTanqueCombustibleInput;
      const nuevo = await withTenant(tenantId, (client) => service.create(client, tenantId, data));
      await registrarAuditoria({
        accion: "combustible.tanque_crear",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: {
          combustibleId: nuevo.id,
          codigo: nuevo.codigo,
          // Cómo se decidió vigilarlo, y con qué números quedó. Sin esto, un
          // tanque que nace ciego es indistinguible en el log de uno bien
          // configurado -- y "nadie lo vigilaba" es justo lo que hay que
          // poder responder después.
          modoVigilancia: data.modo_vigilancia ?? null,
          umbrales: {
            descuadre: data.umbral_descuadre_pct,
            ciclo: data.umbral_descuadre_ciclo_pct,
            diferencia: data.umbral_diferencia_pct,
          },
        },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "combustible.tanque_creado", {
        combustibleId: nuevo.id,
      });
      res.status(201).json(nuevo);
    } catch (err) {
      if (err instanceof Error && err.message.includes("supera la capacidad del tanque")) {
        res.status(400).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: "Error al crear el tanque" });
    }
  }

  async update(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);
      const data = req.validatedBody as ActualizarTanqueCombustibleInput;

      // El estado ANTES del cambio, para saber si este PUT afloja alguna
      // vigilancia. Se lee en su propia transacción y no dentro del update
      // porque el resultado decide si el update llega a ocurrir.
      const antes = await withTenant(tenantId, (client) => service.getById(client, tenantId, id));
      if (!antes) {
        return res.status(404).json({ error: "No encontrado" });
      }

      const aflojados = service.evaluarAflojamiento(antes, data);
      if (aflojados.length > 0 && !data.motivo_ajuste) {
        // 400 y no un guardado silencioso: aflojar un control anti-fraude es
        // una acción correctiva, y el módulo ya exige motivo para las otras
        // (anular una lectura, anular un vale). El mensaje enumera QUÉ se
        // está aflojando para que quien lo lea sepa a qué está diciendo que
        // sí -- puede estar tocando un umbral sin haberse dado cuenta.
        const detalle = aflojados.map((c) => `${c.control}: ${c.de} → ${c.a}`).join("; ");
        return res.status(400).json({
          error:
            `Este cambio reduce la vigilancia del tanque (${detalle}). ` +
            `Indicá el motivo para dejarlo registrado.`,
          requiere_motivo: true,
          aflojados,
        });
      }

      const actualizado = await withTenant(tenantId, (client) =>
        service.update(client, tenantId, id, data)
      );

      if (!actualizado) {
        return res.status(404).json({ error: "No encontrado" });
      }

      await registrarAuditoria({
        accion:
          aflojados.length > 0
            ? "combustible.tanque_vigilancia_reducida"
            : "combustible.tanque_actualizar",
        tenantId,
        usuarioId: req.usuario!.id,
        // Cuando se afloja, el detalle lleva QUÉ cambió y POR QUÉ. Una acción
        // distinta (`tanque_vigilancia_reducida`) además la hace filtrable:
        // buscar quién apagó un control ya no obliga a leer todos los
        // cambios de tanque uno por uno.
        detalle:
          aflojados.length > 0
            ? { combustibleId: id, aflojados, motivo: data.motivo_ajuste }
            : { combustibleId: id },
        contexto: contextoAuditoriaModulo(req),
      });
      if (aflojados.length > 0) {
        // Nunca bloquea la respuesta: el cambio ya está guardado y auditado.
        // Que falle el SMTP no puede deshacer eso ni devolverle un error al
        // admin por algo que sí se aplicó.
        try {
          const admins = await withTenant(tenantId, (client) =>
            service.findAdminsConCombustibleHabilitado(client, tenantId)
          );
          await enviarCorreoVigilanciaReducida(admins, {
            quien: req.usuario!.nombre ?? req.usuario!.email ?? "Un administrador",
            objeto: `${actualizado.codigo} — ${actualizado.tanque_nombre}`,
            motivo: data.motivo_ajuste ?? "",
            cambios: aflojados,
          });
        } catch (err) {
          logger.warn({ err, tenantId, combustibleId: id }, "No se pudo avisar del aflojamiento");
        }
      }

      await publicarEventoTenant(tenantId, "combustible.tanque_actualizado", {
        combustibleId: id,
      });
      res.json(actualizado);
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.includes("supera la capacidad que estás por guardar")
      ) {
        res.status(400).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: "Error al actualizar el tanque" });
    }
  }

  /** Soft-delete exclusivamente -- ver CombustibleRepository.softDelete: un
   *  DELETE real borraría en cascada el historial de combustible_lecturas. */
  async delete(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);
      const { motivo } = req.validatedBody as BajaTanqueCombustibleInput;

      const desactivado = await withTenant(tenantId, (client) =>
        service.softDelete(client, tenantId, id)
      );

      if (!desactivado) {
        return res.status(404).json({ error: "No encontrado" });
      }

      // Dar de baja un tanque APAGA su vigilancia: sale de la alerta de "sin
      // medir" y deja de balancearse. Por eso va con la misma acción de
      // auditoría que aflojar un umbral y con el mismo correo -- pedía menos
      // que subir un porcentaje, que era exactamente al revés.
      await registrarAuditoria({
        accion: "combustible.tanque_vigilancia_reducida",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: {
          combustibleId: id,
          aflojados: [
            { control: "Tanque dado de baja", de: "activo", a: "desactivado (no se vigila)" },
          ],
          motivo,
        },
        contexto: contextoAuditoriaModulo(req),
      });
      try {
        const admins = await withTenant(tenantId, (client) =>
          service.findAdminsConCombustibleHabilitado(client, tenantId)
        );
        await enviarCorreoVigilanciaReducida(admins, {
          quien: req.usuario!.nombre ?? req.usuario!.email ?? "Un administrador",
          objeto: `${desactivado.codigo} — ${desactivado.tanque_nombre}`,
          motivo,
          cambios: [
            { control: "Tanque dado de baja", de: "activo", a: "desactivado (no se vigila)" },
          ],
        });
      } catch (err) {
        logger.warn({ err, tenantId, combustibleId: id }, "No se pudo avisar de la baja");
      }
      await publicarEventoTenant(tenantId, "combustible.tanque_eliminado", {
        combustibleId: id,
      });
      res.json({ message: "Tanque desactivado" });
    } catch {
      res.status(500).json({ error: "Error al desactivar el tanque" });
    }
  }

  async bulk(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const rows = req.validatedBody as CargaMasivaTanquesCombustibleInput;
      const result = await withTenant(tenantId, (client) =>
        service.createBulk(client, tenantId, rows)
      );
      // La carga masiva es la puerta de atrás del alta: el formulario obliga
      // a elegir cómo se vigila el tanque, pero una planilla sin esas
      // columnas entra igual y deja los umbrales en NULL. No se bloquea --
      // pedir tres porcentajes por fila en un Excel garantiza que se llenen
      // con cualquier cosa -- pero SÍ se cuenta y se devuelve, para que el
      // cliente lo diga en pantalla y quede en la auditoría.
      const sinVigilancia = rows.filter(
        (f) =>
          f.umbral_descuadre_pct === null &&
          f.umbral_descuadre_ciclo_pct === null &&
          f.umbral_diferencia_pct === null
      ).length;

      // UNA fila de auditoría con el conteo, no una por tanque -- mismo
      // criterio que repuestos.carga_masiva (RepuestosController.bulk).
      await registrarAuditoria({
        accion: "combustible.tanques_carga_masiva",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { cantidad: result.length, sinVigilancia },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "combustible.tanques_carga_masiva", {
        cantidad: result.length,
      });
      res.status(201).json({ insertados: result.length, sinVigilancia, data: result });
    } catch {
      res.status(500).json({ error: "Error en importación masiva" });
    }
  }

  /** GET /:id/lecturas -- el histórico de aforos del tanque, que hasta acá
   *  era dato muerto (se guardaba en cada lectura pero no había forma de
   *  consultarlo salvo entrar a la base directo). */
  async getLecturas(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);

      const tanque = await withTenant(tenantId, (client) => service.getById(client, tenantId, id));
      if (!tanque) {
        return res.status(404).json({ error: "No encontrado" });
      }

      const paginacion = parsePaginacion(req.query);
      const filas = await withTenant(tenantId, (client) =>
        service.getLecturas(client, tenantId, id, paginacion)
      );
      res.json(armarRespuestaPaginada(filas, paginacion));
    } catch {
      res.status(500).json({ error: "Error al obtener el histórico de lecturas" });
    }
  }

  /** GET /:id/sugerencia-umbral -- entrega 3 de Fase D, el asistente de
   *  calibración de `umbral_diferencia_pct`. Nunca guarda nada: devuelve
   *  el número sugerido y la muestra que lo justifica, y es el admin quien
   *  decide (guardando desde PUT /:id, que ya existe) si lo usa tal cual,
   *  lo ajusta, o lo descarta. */
  async getSugerenciaUmbral(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);

      const tanque = await withTenant(tenantId, (client) => service.getById(client, tenantId, id));
      if (!tanque) {
        return res.status(404).json({ error: "No encontrado" });
      }

      // Las tres sugerencias juntas: el formulario las muestra al lado de sus
      // respectivos campos y el usuario decide cuál acepta. Van en un solo
      // request porque las tres salen del mismo historial del tanque, y
      // partirlas en tres endpoints haría tres pasadas sobre lo mismo.
      //
      // La forma de la respuesta cambió: antes era el objeto de la sugerencia
      // de diferencia en la raíz, ahora es `{ diferencia, descuadre, ciclo }`.
      // El único consumidor es el panel, que va en el mismo commit.
      const [diferencia, descuadre, ciclo] = await withTenant(tenantId, (client) =>
        Promise.all([
          service.sugerirUmbralDiferencia(client, tenantId, id),
          service.sugerirUmbralDescuadre(client, tenantId, id),
          service.sugerirUmbralCiclo(client, tenantId, id),
        ])
      );
      res.json({ diferencia, descuadre, ciclo });
    } catch {
      res.status(500).json({ error: "Error al calcular la sugerencia de umbral" });
    }
  }

  /** PATCH /lecturas/:lecturaId/anular -- marca una lectura mal cargada
   *  como anulada (con motivo obligatorio) y recalcula el nivel del tanque.
   *  La fila NUNCA se borra ni se edita: queda como evidencia de que hubo
   *  un error y quién lo corrigió. Ver migrations/0058. */
  async anularLectura(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const lecturaId = Number(req.params.lecturaId);
      const { motivo } = req.validatedBody as AnularLecturaCombustibleInput;

      const resultado = await withTenant(tenantId, async (client) => {
        const anulada = await service.anularLectura(
          client,
          tenantId,
          lecturaId,
          req.usuario!.id,
          motivo
        );
        if (anulada) return { estado: "anulada" as const, ...anulada };

        // El UPDATE no afectó nada: o la lectura no existe en este tenant,
        // o ya estaba anulada. Hay que distinguirlo para no responder 404
        // ante algo que sí existe (y viceversa).
        const existente = await service.getLecturaPorId(client, tenantId, lecturaId);
        return existente ? { estado: "ya_anulada" as const } : { estado: "inexistente" as const };
      });

      if (resultado.estado === "inexistente") {
        return res.status(404).json({ error: "Lectura no encontrada" });
      }
      if (resultado.estado === "ya_anulada") {
        // 409 y no 400: no es un dato mal formado, es un rechazo por el
        // ESTADO actual del recurso -- mismo criterio que el stock
        // insuficiente de repuestos.
        return res.status(409).json({ error: "Esta lectura ya estaba anulada" });
      }

      await registrarAuditoria({
        accion: "combustible.anular_lectura",
        tenantId,
        usuarioId: req.usuario!.id,
        // Solo ids y la referencia, nunca el contenido de negocio -- mismo
        // criterio que el resto de moduleAudit. El motivo SÍ va: es la
        // razón de una acción correctiva, justo lo que la auditoría tiene
        // que poder responder después.
        detalle: {
          lecturaId,
          combustibleId: resultado.lectura.combustible_id,
          motivo,
        },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "combustible.lectura_anulada", {
        lecturaId,
        combustibleId: resultado.lectura.combustible_id,
      });

      res.json({ lectura: resultado.lectura, tanque: resultado.tanque });
    } catch {
      res.status(500).json({ error: "Error al anular la lectura" });
    }
  }

  /** Legacy: mismo contrato de siempre (body `{ nivel_actual }`, responde el
   *  tanque). Ya no sobreescribe `nivel_actual` directo por dentro -- ver
   *  `CombustibleService.actualizarNivelLegacy`. */
  async updateNivel(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);
      const { nivel_actual } = req.validatedBody as ActualizarNivelCombustibleInput;

      const updated = await withTenant(tenantId, (client) =>
        service.actualizarNivelLegacy(client, tenantId, req.usuario!.id, id, nivel_actual)
      );

      if (!updated) {
        return res.status(404).json({ error: "No encontrado" });
      }

      await registrarAuditoria({
        accion: "combustible.actualizar_nivel",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { combustibleId: id },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "combustible.nivel_actualizado", {
        combustibleId: id,
        nivelActual: nivel_actual,
      });
      res.json(updated);
    } catch (err) {
      // El tanque no existe en este tenant -- mismo motivo que el 404 de
      // siempre (`updated` null), solo que acá llega como excepción porque
      // registrarLectura() valida la FK antes de insertar. Se preserva el
      // 404 histórico de este endpoint, NO el 400 del endpoint nuevo (ver
      // registrarLectura más abajo) -- no romper el contrato existente.
      if (err instanceof Error && err.message.includes("no existe en este tenant")) {
        res.status(404).json({ error: "No encontrado" });
        return;
      }
      // Este SÍ es 400 incluso en el endpoint legacy: no es "no encontrado",
      // es un dato imposible para un tanque que sí existe.
      if (err instanceof Error && err.message.includes("supera la capacidad del tanque")) {
        res.status(400).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: "Error al actualizar nivel" });
    }
  }

  /** POST /combustible/lecturas -- crea una lectura histórica y, si es la
   *  más reciente, actualiza `nivel_actual` (ver
   *  CombustibleRepository.registrarLectura). Único endpoint de Combustible
   *  que participa de la cola offline: `combustible_id` viaja en el body a
   *  propósito, no en la URL -- el motor offline del cliente
   *  (rutasOffline.ts) solo matchea rutas literales, sin parámetros. */
  async registrarLectura(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const data = req.validatedBody as RegistrarLecturaCombustibleInput;
      const { fila, creado } = await withTenant(tenantId, (client) =>
        service.registrarLectura(client, tenantId, req.usuario!.id, data)
      );

      // Reintento de un envío que ya se había guardado (la respuesta
      // original se perdió en la red). No se publica el evento de nuevo --
      // eso ya pasó la primera vez. 200 y no 201 porque esta llamada no
      // creó nada, pero sí es un éxito para la cola offline del dispositivo.
      if (!creado) {
        res.status(200).json(fila ?? { error: "Esta lectura ya se había registrado" });
        return;
      }

      await registrarAuditoria({
        accion: "combustible.registrar_lectura",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { lecturaId: fila!.lectura.id, combustibleId: data.combustible_id },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "combustible.lectura_registrada", {
        lecturaId: fila!.lectura.id,
        combustibleId: data.combustible_id,
        nivel: data.nivel,
      });
      await this.procesarAlertaNivelBajo(tenantId, data.combustible_id, data.nivel);
      await this.procesarAlertaDescuadre(
        tenantId,
        data.combustible_id,
        Number(fila!.lectura.id),
        data.nivel,
        // pg devuelve TIMESTAMPTZ como Date; el balance necesita el mismo
        // instante exacto que quedó guardado (no `data.leido_en`, que es
        // opcional en el body y puede venir sin definir).
        new Date(fila!.lectura.leido_en).toISOString()
      );
      await this.procesarAlertaDescuadreCiclo(
        tenantId,
        data.combustible_id,
        Number(fila!.lectura.id),
        data.nivel,
        new Date(fila!.lectura.leido_en).toISOString()
      );
      await this.procesarAlertaLecturaRetroactiva(
        tenantId,
        data.combustible_id,
        Number(fila!.lectura.id),
        data.nivel,
        new Date(fila!.lectura.leido_en).toISOString()
      );
      res.status(201).json(fila);
    } catch (err) {
      // Los dos casos van con 400: son datos que se contradicen a sí mismos
      // (un tanque que no existe, un nivel imposible para ese tanque), no
      // fallas del servidor. El 4xx además hace que la cola offline los
      // descarte sin reintentar y los reporte, en vez de reintentar para
      // siempre algo que nunca va a entrar (ver esErrorPermanente() en
      // client/src/offline/offlineSync.ts).
      if (
        err instanceof Error &&
        (err.message.includes("no existe en este tenant") ||
          err.message.includes("supera la capacidad del tanque"))
      ) {
        res.status(400).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: "Error al registrar lectura de combustible" });
    }
  }

  // ── Despachos (Fase B) ─────────────────────────────────────────────────

  /** POST /despachos -- crea el vale digital. Único endpoint de despachos
   *  que participa de la cola offline (ver registry.ts): equipo_id/
   *  combustible_id viajan en el body a propósito, mismo motivo que
   *  combustible_id en /lecturas (rutasOffline.ts solo matchea rutas
   *  literales, sin parámetros). */
  async crearDespacho(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const data = req.validatedBody as CrearDespachoCombustibleInput;
      const { fila, creado } = await withTenant(tenantId, (client) =>
        service.crearDespacho(client, tenantId, req.usuario!.id, data)
      );

      // Reintento de un envío que ya se había guardado -- mismo criterio
      // que registrarLectura: 200 (no 201, no creó nada) para que la cola
      // offline lo dé por sincronizado sin duplicar auditoría ni evento.
      if (!creado) {
        res.status(200).json(fila ?? { error: "Este despacho ya se había registrado" });
        return;
      }

      await registrarAuditoria({
        accion: "combustible.despacho_crear",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: {
          despachoId: fila!.id,
          origen: data.origen,
          serieTalonario: data.serie_talonario,
          nVale: data.n_vale,
        },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "combustible.despacho_creado", {
        despachoId: fila!.id,
      });
      await this.procesarAlertasDespachoCreado(tenantId, fila!.id, data);
      res.status(201).json(fila);
    } catch (err) {
      if (err instanceof Error && err.message.includes("ya está registrado")) {
        // 409: no es un dato mal formado, es el mismo vale tipeado dos
        // veces -- mismo criterio que el vale duplicado del punto 5.
        res.status(409).json({ error: err.message });
        return;
      }
      if (
        err instanceof Error &&
        (err.message.includes("el contómetro marcó") ||
          err.message.includes("no existe en este tenant") ||
          err.message.includes("no tiene tipo de medidor configurado") ||
          err.message.includes("se mide por") ||
          err.message.includes("está desactivado y no puede despachar") ||
          // Grifo del rol equivocado (migrations/0065).
          err.message.includes("no está marcado como"))
      ) {
        // Todos estos son datos que se contradicen a sí mismos o a una
        // fila que el propio request referenció mal -- 400, corregible ahí
        // mismo con el papel en la mano (ver el punto 5 del documento).
        res.status(400).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: "Error al registrar el despacho" });
    }
  }

  /** PATCH /despachos/:despachoId/anular -- la válvula de escape del punto 3
   *  del documento de diseño. Mismo mecanismo exacto que anularLectura y
   *  anularPrecio: 404 si no existe en este tenant, 409 si ya estaba anulada
   *  (para no pisar el motivo y el autor de la anulación original, que son la
   *  evidencia de quién corrigió qué). */
  async anularDespacho(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const despachoId = Number(req.params.despachoId);
      const { motivo } = req.validatedBody as AnularDespachoCombustibleInput;

      const resultado = await withTenant(tenantId, async (client) => {
        const anulado = await service.anularDespacho(
          client,
          tenantId,
          despachoId,
          req.usuario!.id,
          motivo
        );
        if (anulado) return { estado: "anulada" as const, despacho: anulado };

        const existente = await service.getDespachoPorId(client, tenantId, despachoId);
        return existente ? { estado: "ya_anulada" as const } : { estado: "inexistente" as const };
      });

      if (resultado.estado === "inexistente") {
        res.status(404).json({ error: "Despacho no encontrado" });
        return;
      }
      if (resultado.estado === "ya_anulada") {
        res.status(409).json({ error: "Este despacho ya estaba anulado" });
        return;
      }

      await registrarAuditoria({
        accion: "combustible.despacho_anular",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: {
          despachoId,
          serieTalonario: resultado.despacho.serie_talonario,
          nVale: resultado.despacho.n_vale,
          motivo,
        },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "combustible.despacho_anulado", { despachoId });
      await this.procesarAlertaAnulacion(
        tenantId,
        despachoId,
        resultado.despacho.serie_talonario,
        resultado.despacho.n_vale,
        motivo
      );
      res.json(resultado.despacho);
    } catch {
      res.status(500).json({ error: "Error al anular el despacho" });
    }
  }

  /** Best-effort, mismo contrato "nunca lanza" que publicarEventoTenant():
   *  corre después de que la transacción de crearDespacho ya confirmó, así
   *  que un fallo acá no puede convertir un 201 real en un 500. */
  private async procesarAlertasDespachoCreado(
    tenantId: string,
    despachoId: number,
    data: CrearDespachoCombustibleInput
  ) {
    const serieTalonario = data.serie_talonario;
    const nVale = data.n_vale;
    try {
      const { huecos, exceso, medidor, fueraDeOrden, tope, admins } = await withTenant(
        tenantId,
        async (client) => {
          // El vale que acaba de llegar puede estar llenando un hueco ya
          // alertado (offline que sincronizó) -- esto corre siempre, sin
          // condicionar, y no hace nada si no había ninguna alerta abierta.
          //
          // Si el hueco YA se había congelado como anomalía, no lo resuelve
          // (la anomalía es inmutable): devuelve `llegoTarde` y se registra
          // el despacho_tardio del punto 4 -- que alguien se acuerde de un
          // vale dos días después es una señal, no algo a corregir en
          // silencio.
          const { llegoTarde } = await service.resolverAlertaHuecoSiExiste(
            client,
            tenantId,
            serieTalonario,
            nVale
          );

          const huecos = await service.detectarHuecosRevelados(
            client,
            tenantId,
            serieTalonario,
            despachoId,
            nVale
          );

          // Vale cargado POR DEBAJO del máximo de su serie (0077). Si venía a
          // llenar un hueco alertado, `llegoTarde`/el UPDATE de arriba ya lo
          // explicaron y no hay nada que reportar: lo sospechoso es el vale
          // desordenado que NADIE estaba esperando.
          const maxAnterior = await service.detectarValeFueraDeOrden(
            client,
            tenantId,
            serieTalonario,
            despachoId,
            nVale
          );
          const huecoLoEsperaba = await service.existioHuecoPara(
            client,
            tenantId,
            serieTalonario,
            nVale
          );
          const fueraDeOrden = maxAnterior !== null && !huecoLoEsperaba ? maxAnterior : null;

          // Sobredespacho (0069/0070): solo aplica si el vale fue a un equipo.
          // Devuelve null en el caso normal -- sin capacidad configurada, sin
          // unidad conocida, o sin exceso (ver evaluarSobredespacho).
          const exceso = data.equipo_id
            ? await service.evaluarSobredespacho(
                client,
                tenantId,
                data.equipo_id,
                data.combustible_id ?? null,
                data.cantidad
              )
            : null;

          // Medidor que no cierra con el anterior (punto 5 del documento,
          // migración 0073). Igual que el sobredespacho: no bloquea el vale,
          // solo lo marca. Se evalúa contra el ÚLTIMO despacho vigente de ese
          // equipo, así que el primero de cada equipo nunca alerta.
          const medidor = data.equipo_id
            ? await service.evaluarMedidorInconsistente(client, tenantId, data.equipo_id, {
                lecturaHorometro: data.lectura_horometro ?? null,
                lecturaOdometro: data.lectura_odometro ?? null,
                despachadoEn: data.despachado_en ?? new Date().toISOString(),
                despachoId,
              })
            : null;

          // Tope diario por actor (0079): lo que le faltaba al sobredespacho,
          // que mira UN vale. Acá el problema es la SUMA de 24 h, así que
          // aplica también a los destinos sin equipo -- planta y reserva no
          // tenían ningún techo hasta ahora.
          const tope = await service.evaluarTopeDiario(client, tenantId, {
            despachoId,
            equipoId: data.equipo_id ?? null,
            tipoDestino: data.tipo_destino,
            despachadoEn: data.despachado_en ?? new Date().toISOString(),
          });

          const nuevas = [
            ...huecos.map((n) => ({
              tipo: "hueco_detectado" as const,
              serieTalonario,
              nVale: n,
              despachoId,
              detalle: { revelado_por_vale: nVale } as Record<string, unknown>,
            })),
            ...(exceso
              ? [
                  {
                    tipo: "sobredespacho" as const,
                    serieTalonario,
                    nVale,
                    despachoId,
                    detalle: { ...exceso, equipoId: data.equipo_id } as Record<string, unknown>,
                  },
                ]
              : []),
            ...(tope
              ? [
                  {
                    tipo: "tope_diario_excedido" as const,
                    serieTalonario,
                    nVale,
                    despachoId,
                    detalle: { ...tope } as Record<string, unknown>,
                  },
                ]
              : []),
            ...(fueraDeOrden !== null
              ? [
                  {
                    tipo: "vale_fuera_de_orden" as const,
                    serieTalonario,
                    nVale,
                    despachoId,
                    detalle: { maxAnteriorDeLaSerie: fueraDeOrden } as Record<string, unknown>,
                  },
                ]
              : []),
            ...(medidor
              ? [
                  {
                    tipo: "medidor_inconsistente" as const,
                    serieTalonario,
                    nVale,
                    despachoId,
                    detalle: { ...medidor, equipoId: data.equipo_id } as Record<string, unknown>,
                  },
                ]
              : []),
            ...(llegoTarde
              ? [
                  {
                    tipo: "despacho_tardio" as const,
                    serieTalonario,
                    nVale,
                    despachoId,
                    detalle: {
                      nota: "El vale llegó después de que el hueco se congelara como anomalía",
                    } as Record<string, unknown>,
                  },
                ]
              : []),
          ];

          if (nuevas.length === 0) {
            return {
              huecos,
              exceso,
              medidor,
              fueraDeOrden,
              tope,
              admins: [] as { email: string; nombre: string }[],
            };
          }

          await service.crearAlertas(client, tenantId, nuevas);
          const admins = await service.findAdminsConCombustibleHabilitado(client, tenantId);
          return { huecos, exceso, medidor, fueraDeOrden, tope, admins };
        }
      );

      if (huecos.length > 0) {
        await publicarEventoTenant(tenantId, "combustible.alerta_creada", {
          tipo: "hueco_detectado",
          serieTalonario,
          valesFaltantes: huecos,
        });
        await enviarCorreoAlertaHueco(admins, {
          serieTalonario,
          valesFaltantes: huecos,
          nValeQueLoRevelo: nVale,
        });
      }

      if (exceso) {
        await publicarEventoTenant(tenantId, "combustible.alerta_creada", {
          tipo: "sobredespacho",
          serieTalonario,
          nVale,
        });
        await enviarCorreoAlertaSobredespacho(admins, {
          serieTalonario,
          nVale,
          ...exceso,
        });
      }

      if (fueraDeOrden !== null) {
        await publicarEventoTenant(tenantId, "combustible.alerta_creada", {
          tipo: "vale_fuera_de_orden",
          serieTalonario,
          nVale,
        });
      }

      if (tope) {
        await publicarEventoTenant(tenantId, "combustible.alerta_creada", {
          tipo: "tope_diario_excedido",
          serieTalonario,
          nVale,
        });
        await enviarCorreoTopeDiario(admins, {
          actor: tope.equipoId ? `El equipo #${tope.equipoId}` : `El destino "${tope.tipoDestino}"`,
          acumuladoL: tope.acumuladoL,
          topeL: tope.topeL,
          vales: tope.valesEnLaVentana,
          base: tope.base,
          serieTalonario,
          nVale,
        });
      }

      if (medidor) {
        await publicarEventoTenant(tenantId, "combustible.alerta_creada", {
          tipo: "medidor_inconsistente",
          serieTalonario,
          nVale,
        });
        await enviarCorreoAlertaMedidor(admins, { serieTalonario, nVale, ...medidor });
      }
    } catch (err) {
      logger.warn(
        { err, tenantId, despachoId },
        "No se pudieron procesar las alertas del despacho creado"
      );
    }
  }

  /** Nivel bajo de tanque (migración 0073). Mismo contrato best-effort que
   *  los demás: corre después de que la lectura ya se guardó, así que un
   *  fallo acá no puede convertir un 201 real en un 500.
   *
   *  `evaluarNivelBajo` devuelve null en el caso normal -- tanque sin
   *  mínimo configurado, nivel por encima, o ya con una alerta abierta (la
   *  deduplicación). Y si el nivel volvió a subir, resuelve la alerta
   *  anterior por dentro, sin que nadie la cierre a mano. */
  private async procesarAlertaNivelBajo(tenantId: string, combustibleId: number, nivel: number) {
    try {
      const { bajo, admins } = await withTenant(tenantId, async (client) => {
        const bajo = await service.evaluarNivelBajo(client, tenantId, combustibleId, nivel);
        if (!bajo) return { bajo, admins: [] as { email: string; nombre: string }[] };

        await service.crearAlertas(client, tenantId, [
          {
            tipo: "nivel_bajo",
            combustibleId,
            detalle: { ...bajo },
          },
        ]);
        const admins = await service.findAdminsConCombustibleHabilitado(client, tenantId);
        return { bajo, admins };
      });

      if (!bajo) return;

      await publicarEventoTenant(tenantId, "combustible.alerta_creada", {
        tipo: "nivel_bajo",
        combustibleId,
      });
      await enviarCorreoAlertaNivelBajo(admins, bajo);
    } catch (err) {
      logger.warn({ err, tenantId, combustibleId }, "No se pudo procesar la alerta de nivel bajo");
    }
  }

  /** Descuadre de inventario (migración 0074). Mismo contrato "nunca lanza"
   *  que el resto de los procesar*: la lectura ya se guardó y se respondió
   *  201 -- que falle el correo o la alerta no puede tirar abajo un dato que
   *  el operario ya dio por cargado, sobre todo viniendo de la cola offline.
   *
   *  `evaluarDescuadre` devuelve null en el caso normal: tanque sin umbral
   *  configurado (el default), primera lectura del tanque, o descuadre
   *  dentro de la tolerancia. */
  private async procesarAlertaDescuadre(
    tenantId: string,
    combustibleId: number,
    lecturaId: number,
    nivel: number,
    leidoEn: string
  ) {
    try {
      const { descuadre, admins } = await withTenant(tenantId, async (client) => {
        const descuadre = await service.evaluarDescuadre(
          client,
          tenantId,
          combustibleId,
          lecturaId,
          nivel,
          leidoEn
        );
        if (!descuadre) return { descuadre, admins: [] as { email: string; nombre: string }[] };

        await service.crearAlertas(client, tenantId, [
          {
            tipo: "descuadre_inventario",
            combustibleId,
            detalle: { ...descuadre },
          },
        ]);
        const admins = await service.findAdminsConCombustibleHabilitado(client, tenantId);
        return { descuadre, admins };
      });

      if (!descuadre) return;

      await publicarEventoTenant(tenantId, "combustible.alerta_creada", {
        tipo: "descuadre_inventario",
        combustibleId,
      });
      await enviarCorreoAlertaDescuadre(admins, descuadre);
    } catch (err) {
      logger.warn({ err, tenantId, combustibleId }, "No se pudo procesar la alerta de descuadre");
    }
  }

  /** Saldo acumulado del ciclo (migración 0076). Corre junto al descuadre
   *  por tramo y con el mismo contrato "nunca lanza": son dos preguntas
   *  distintas sobre la misma lectura -- "¿cerró este tramo?" y "¿cierra el
   *  ciclo desde que se cargó el tanque?" -- y la segunda es la que atrapa
   *  el faltante repartido en pedazos chicos.
   *
   *  También resuelve la alerta de "sin medir" si había una abierta: acaba
   *  de llegar una lectura, así que el problema que esa alerta reportaba
   *  dejó de existir. */
  private async procesarAlertaDescuadreCiclo(
    tenantId: string,
    combustibleId: number,
    lecturaId: number,
    nivel: number,
    leidoEn: string
  ) {
    try {
      const { ciclo, admins } = await withTenant(tenantId, async (client) => {
        await service.resolverAlertaSinMedirSiExiste(client, tenantId, combustibleId);

        const ciclo = await service.evaluarDescuadreCiclo(
          client,
          tenantId,
          combustibleId,
          lecturaId,
          nivel,
          leidoEn
        );
        if (!ciclo) return { ciclo, admins: [] as { email: string; nombre: string }[] };

        await service.crearAlertas(client, tenantId, [
          { tipo: "descuadre_ciclo", combustibleId, detalle: { ...ciclo } },
        ]);
        const admins = await service.findAdminsConCombustibleHabilitado(client, tenantId);
        return { ciclo, admins };
      });

      if (!ciclo) return;

      await publicarEventoTenant(tenantId, "combustible.alerta_creada", {
        tipo: "descuadre_ciclo",
        combustibleId,
      });
      await enviarCorreoAlertaDescuadreCiclo(admins, ciclo);
    } catch (err) {
      logger.warn(
        { err, tenantId, combustibleId },
        "No se pudo procesar la alerta de descuadre del ciclo"
      );
    }
  }

  /** Varilla cargada hacia atrás (migración 0078). Mismo contrato "nunca
   *  lanza" que el resto: la lectura ya se guardó y se respondió 201. */
  private async procesarAlertaLecturaRetroactiva(
    tenantId: string,
    combustibleId: number,
    lecturaId: number,
    nivel: number,
    leidoEn: string
  ) {
    try {
      const { retro, tanque, admins } = await withTenant(tenantId, async (client) => {
        const retro = await service.detectarLecturaRetroactiva(
          client,
          tenantId,
          combustibleId,
          lecturaId,
          leidoEn
        );
        if (!retro) {
          return { retro, tanque: null, admins: [] as { email: string; nombre: string }[] };
        }
        const tanque = await service.getById(client, tenantId, combustibleId);
        await service.crearAlertas(client, tenantId, [
          {
            tipo: "lectura_retroactiva",
            combustibleId,
            detalle: {
              tanqueNombre: tanque?.tanque_nombre ?? "",
              unidad: tanque?.unidad ?? "",
              nivel,
              leidoEn,
              posteriores: retro.posteriores,
            },
          },
        ]);
        const admins = await service.findAdminsConCombustibleHabilitado(client, tenantId);
        return { retro, tanque, admins };
      });

      if (!retro) return;

      await publicarEventoTenant(tenantId, "combustible.alerta_creada", {
        tipo: "lectura_retroactiva",
        combustibleId,
      });
      await enviarCorreoLecturaRetroactiva(admins, {
        tanqueNombre: tanque?.tanque_nombre ?? "",
        unidad: tanque?.unidad ?? "",
        nivel,
        leidoEn,
        posteriores: retro.posteriores,
      });
    } catch (err) {
      logger.warn(
        { err, tenantId, combustibleId },
        "No se pudo procesar la alerta de lectura retroactiva"
      );
    }
  }

  /** Mismo contrato "nunca lanza" que procesarAlertasDespachoCreado(). */
  private async procesarAlertaAnulacion(
    tenantId: string,
    despachoId: number,
    serieTalonario: string,
    nVale: number,
    motivo: string
  ) {
    try {
      const admins = await withTenant(tenantId, async (client) => {
        await service.crearAlertas(client, tenantId, [
          {
            tipo: "vale_anulado",
            serieTalonario,
            nVale,
            despachoId,
            detalle: { motivo },
          },
        ]);
        return service.findAdminsConCombustibleHabilitado(client, tenantId);
      });

      await publicarEventoTenant(tenantId, "combustible.alerta_creada", {
        tipo: "vale_anulado",
        serieTalonario,
        nVale,
      });
      await enviarCorreoAlertaAnulacion(admins, { serieTalonario, nVale, motivo });
    } catch (err) {
      logger.warn({ err, tenantId, despachoId }, "No se pudo procesar la alerta de vale anulado");
    }
  }

  /** GET /despachos -- listado paginado, con filtro opcional por equipo o
   *  serie de talonario. Sin conciliación ni anomalías acá: eso es Fase D. */
  async listarDespachos(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const paginacion = parsePaginacion(req.query);
      const equipoIdRaw = req.query.equipo_id;
      const equipoId =
        typeof equipoIdRaw === "string" && equipoIdRaw.trim() !== ""
          ? Number(equipoIdRaw)
          : undefined;
      const serieTalonario =
        typeof req.query.serie_talonario === "string" ? req.query.serie_talonario : undefined;

      const filas = await withTenant(tenantId, (client) =>
        service.listarDespachos(client, tenantId, { equipoId, serieTalonario }, paginacion)
      );
      res.json(armarRespuestaPaginada(filas, paginacion));
    } catch {
      res.status(500).json({ error: "Error al listar despachos" });
    }
  }

  /** GET /despachos/huecos?serie_talonario=XXX -- punto 1 reescrito: una
   *  consulta bajo demanda, sin paginar ni filtrar por fecha (a propósito,
   *  ver el diseño de Fase B). `validate()` solo parsea el body, así que
   *  el query param se valida acá a mano, mismo patrón que el resto del
   *  repo (ver ordenes_trabajo.controller.ts / documentos.controller.ts). */
  async getHuecosTalonario(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const serieTalonario = req.query.serie_talonario;
      if (typeof serieTalonario !== "string" || serieTalonario.trim() === "") {
        res.status(400).json({ error: "El query param serie_talonario es obligatorio" });
        return;
      }

      const resultado = await withTenant(tenantId, (client) =>
        service.detectarHuecos(client, tenantId, serieTalonario)
      );
      res.json(resultado);
    } catch {
      res.status(500).json({ error: "Error al calcular huecos de talonario" });
    }
  }

  // ── Alertas (migrations/0068) ─────────────────────────────────────────

  /** GET /alertas -- pantalla y campanita comparten este mismo listado
   *  (la campanita solo pide ?solo_no_leidas=true). Visibilidad de
   *  gerencia, no del operador (ver combustible.routes.ts). */
  async listarAlertas(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const paginacion = parsePaginacion(req.query);
      const soloNoLeidas = req.query.solo_no_leidas === "true";

      const filas = await withTenant(tenantId, (client) =>
        service.listarAlertas(client, tenantId, { soloNoLeidas }, paginacion)
      );
      res.json(armarRespuestaPaginada(filas, paginacion));
    } catch {
      res.status(500).json({ error: "Error al listar alertas" });
    }
  }

  /** PATCH /alertas/leidas -- sin `ids` marca TODAS las no leídas del
   *  tenant (el botón "marcar todas como leídas" de la campanita). Estado
   *  compartido entre admins, no por usuario (ver migrations/0068). */
  async marcarAlertasLeidas(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const { ids } = req.validatedBody as MarcarAlertasLeidasCombustibleInput;
      await withTenant(tenantId, (client) => service.marcarAlertasLeidas(client, tenantId, ids));
      res.status(204).send();
    } catch {
      res.status(500).json({ error: "Error al marcar alertas como leídas" });
    }
  }

  /** PATCH /alertas/:alertaId/resolver -- revisión manual, con MOTIVO
   *  obligatorio (0077). Aplica a los siete tipos que necesitan que alguien
   *  los mire; los que se resuelven solos (hueco, nivel bajo, sin medir) no
   *  están en la lista -- ver TIPOS_REVISABLES en el repository.
   *
   *  404 si no existe o es de otro tipo/ya estaba resuelta: el repository no
   *  distingue esos casos porque acá no hace falta, no hay nada que corregir
   *  aparte de reintentar. */
  async resolverAlertaManual(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const alertaId = Number(req.params.alertaId);
      const { motivo } = req.validatedBody as ResolverAlertaCombustibleInput;

      const resuelta = await withTenant(tenantId, (client) =>
        service.resolverAlertaManual(client, tenantId, alertaId, req.usuario!.id, motivo)
      );
      if (!resuelta) {
        res
          .status(404)
          .json({ error: "Alerta no encontrada, ya revisada, o no es de tipo revisable" });
        return;
      }
      res.json(resuelta);
    } catch {
      res.status(500).json({ error: "Error al resolver la alerta" });
    }
  }

  /** GET /bitacora -- el historial de cambios del módulo, para el PROPIO
   *  tenant.
   *
   *  Hasta acá todo quedaba registrado pero solo lo podía ver el dueño del
   *  software desde el panel de plataforma. Un control que únicamente puede
   *  revisar el proveedor no es un control de la empresa: gerencia tiene que
   *  poder responder "¿quién cambió esto?" sin pedirle nada a nadie.
   *
   *  Reusa `listarAuditoriaService` en vez de consultar `platform_audit_log`
   *  desde acá, y no es casualidad: esa tabla NO tiene RLS, y el servicio ya
   *  resuelve bien las dos trampas que trae -- filtrar por tenant a mano, y
   *  resolver los nombres de `usuarios` (que SÍ tiene RLS) agrupando por
   *  tenant dentro de withTenant(). Duplicar esa lógica acá era la forma
   *  segura de equivocarse. El lint del repo directamente prohíbe importar
   *  `pool` en un controller de módulo, por este mismo motivo.
   *
   *  El `tenantId` sale de la sesión, nunca del query: si viniera del
   *  cliente, un admin podría pedir la bitácora de otra empresa.
   *
   *  Solo admin, como el resto de la visibilidad de gerencia. */
  async listarBitacora(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const paginacion = parsePaginacion(req.query);
      const desde = typeof req.query.desde === "string" ? req.query.desde : undefined;
      const hasta = typeof req.query.hasta === "string" ? req.query.hasta : undefined;

      const pagina = await listarAuditoriaService({
        tenantId,
        accionPrefijo: "combustible.",
        desde,
        hasta,
        limit: paginacion.pageSize,
      });

      // Se traduce a la forma que ya usa el resto del módulo (snake_case y
      // un `usuario` legible) en vez de filtrar el shape del panel de
      // plataforma hacia la pantalla del tenant.
      const filas = pagina.entradas.map((e) => ({
        id: e.id,
        accion: e.accion,
        // null = lo hizo el sistema (un worker), no una persona. Decirlo
        // explícitamente evita que se lea como un dato faltante.
        usuario: e.usuarioId ? (e.usuarioEmail ?? "Usuario eliminado") : "Sistema",
        detalle: e.detalle,
        creado_en: e.creadoEn,
      }));

      // Sin `armarRespuestaPaginada`: ese helper espera un `total_count` que
      // la auditoría no calcula (pagina por cursor, no por offset). La forma
      // `{ data }` es la que el panel ya consume.
      res.json({ data: filas, pagination: { pageSize: paginacion.pageSize } });
    } catch {
      res.status(500).json({ error: "Error al obtener la bitácora" });
    }
  }

  // ── Conciliación (migraciones 0071/0072) ──────────────────────────────

  /** GET /config -- hoy solo la ventana de gracia. Un tenant que nunca la
   *  tocó igual recibe el default (72h), no un 404: para quien consulta no
   *  hay diferencia entre "no configurada" y "configurada en el default". */
  async getConfig(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const config = await withTenant(tenantId, (client) => service.getConfig(client, tenantId));
      res.json(config);
    } catch {
      res.status(500).json({ error: "Error al obtener la configuración de combustible" });
    }
  }

  /** PUT /config -- subir la ventana AFLOJA el control (los hallazgos
   *  tardan más en congelarse), así que se audita con el "quién" como
   *  cualquier acción correctiva. */
  async guardarConfig(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const nueva = req.validatedBody as ConfigCombustibleInput;

      // Qué se afloja hay que medirlo ANTES de guardar, contra lo que había.
      // Subir la ventana o los días sin medir, y subir o apagar cualquiera de
      // los dos topes de 0079, debilitan la vigilancia sin tocar un solo vale
      // ni un solo tanque -- que era la forma más cómoda de robar que quedaba.
      const { guardada, aflojados } = await withTenant(tenantId, async (client) => {
        const antes = await service.getConfig(client, tenantId);
        const aflojados = service.evaluarAflojamientoConfig(antes, nueva);
        const guardada = await service.guardarConfig(
          client,
          tenantId,
          {
            ventanaGraciaHoras: nueva.ventana_gracia_horas,
            diasSinMedir: nueva.dias_sin_medir,
            llenadosPorDiaMax: nueva.llenados_por_dia_max,
            topeSinCapacidadL: nueva.tope_diario_sin_capacidad_l,
          },
          req.usuario!.id
        );
        return { guardada, aflojados };
      });

      await registrarAuditoria({
        // Misma distinción que en el tanque (#143): una acción propia para
        // "acá se redujo la vigilancia" hace que buscar quién apagó un
        // control no obligue a leer todos los cambios de config uno por uno.
        accion:
          aflojados.length > 0
            ? "combustible.config_vigilancia_reducida"
            : "combustible.config_actualizar",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle:
          aflojados.length > 0
            ? { ...nueva, aflojados }
            : { ventanaGraciaHoras: nueva.ventana_gracia_horas },
        contexto: contextoAuditoriaModulo(req),
      });

      if (aflojados.length > 0) {
        // Nunca bloquea: el cambio ya está guardado y auditado (mismo
        // criterio que el aflojamiento del tanque).
        try {
          const admins = await withTenant(tenantId, (client) =>
            service.findAdminsConCombustibleHabilitado(client, tenantId)
          );
          await enviarCorreoVigilanciaReducida(admins, {
            quien: req.usuario!.nombre ?? req.usuario!.email ?? "Un administrador",
            objeto: "la configuración del módulo de combustible",
            motivo: "",
            cambios: aflojados,
          });
        } catch (err) {
          logger.warn({ err, tenantId }, "No se pudo avisar del aflojamiento de configuración");
        }
      }
      await publicarEventoTenant(tenantId, "combustible.config_actualizada", {
        ventanaGraciaHoras: nueva.ventana_gracia_horas,
      });
      res.json(guardada);
    } catch {
      res.status(500).json({ error: "Error al guardar la configuración de combustible" });
    }
  }

  /** GET /anomalias -- los hallazgos ya congelados. Solo lectura: la tabla
   *  es append-only a propósito (ver migrations/0072), no hay endpoint para
   *  editarlas ni borrarlas. */
  async listarAnomalias(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const paginacion = parsePaginacion(req.query);
      const filas = await withTenant(tenantId, (client) =>
        service.listarAnomalias(client, tenantId, paginacion)
      );
      res.json(armarRespuestaPaginada(filas, paginacion));
    } catch {
      res.status(500).json({ error: "Error al listar anomalías" });
    }
  }

  // ── Grifos externos (migrations/0063) ─────────────────────────────────

  async listarGrifos(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const grifos = await withTenant(tenantId, (client) => service.listarGrifos(client, tenantId));
      res.json(grifos);
    } catch {
      res.status(500).json({ error: "Error al listar grifos" });
    }
  }

  async crearGrifo(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const data = req.validatedBody as CrearGrifoCombustibleInput;
      const grifo = await withTenant(tenantId, (client) =>
        service.crearGrifo(client, tenantId, req.usuario!.id, data)
      );
      await registrarAuditoria({
        accion: "combustible.grifo_crear",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: {
          grifoId: grifo.id,
          nombre: data.nombre,
          abasteceRuta: data.abastece_ruta,
          abasteceTanque: data.abastece_tanque,
        },
        contexto: contextoAuditoriaModulo(req),
      });
      res.status(201).json(grifo);
    } catch (err) {
      if (err instanceof Error && err.message.includes("ya existe un grifo")) {
        res.status(409).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: "Error al crear el grifo" });
    }
  }

  async actualizarGrifo(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);
      const data = req.validatedBody as ActualizarGrifoCombustibleInput;
      const grifo = await withTenant(tenantId, (client) =>
        service.actualizarGrifo(client, tenantId, id, data)
      );
      if (!grifo) {
        res.status(404).json({ error: "Grifo no encontrado" });
        return;
      }
      await registrarAuditoria({
        accion: "combustible.grifo_actualizar",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: {
          grifoId: id,
          abasteceRuta: data.abastece_ruta,
          abasteceTanque: data.abastece_tanque,
        },
        contexto: contextoAuditoriaModulo(req),
      });
      res.json(grifo);
    } catch (err) {
      if (err instanceof Error && err.message.includes("ya existe un grifo")) {
        res.status(409).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: "Error al actualizar el grifo" });
    }
  }

  // ── Precios de combustible (migrations/0063) ──────────────────────────

  async listarPrecios(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const precios = await withTenant(tenantId, (client) =>
        service.listarPrecios(client, tenantId)
      );
      res.json(precios);
    } catch {
      res.status(500).json({ error: "Error al listar precios" });
    }
  }

  async crearPrecio(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const data = req.validatedBody as CrearPrecioCombustibleInput;
      const precio = await withTenant(tenantId, (client) =>
        service.crearPrecio(client, tenantId, req.usuario!.id, data)
      );
      await registrarAuditoria({
        accion: "combustible.precio_crear",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: {
          precioId: precio.id,
          tipoCombustible: data.tipo_combustible,
          precioUnitario: data.precio_unitario,
        },
        contexto: contextoAuditoriaModulo(req),
      });
      res.status(201).json(precio);
    } catch (err) {
      if (
        err instanceof Error &&
        (err.message.includes("no existe en este tenant") ||
          err.message.includes("ya existe un grifo"))
      ) {
        res.status(400).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: "Error al crear el precio" });
    }
  }

  /** GET /precios/vigente -- el que el frontend llama para autocompletar
   *  el C.U del despacho ANTES de mandar el POST. Devuelve 200 con
   *  `precio: null` si no hay ninguno cargado todavía -- no es un error,
   *  el operador simplemente tipea el costo a mano esta vez. */
  async getPrecioVigente(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const tipoCombustible = req.query.tipo_combustible;
      const combustibleIdRaw = req.query.combustible_id;
      const grifoIdRaw = req.query.grifo_id;
      const fecha = typeof req.query.fecha === "string" ? req.query.fecha : undefined;

      if (typeof tipoCombustible !== "string" || !fecha) {
        res
          .status(400)
          .json({ error: "Los query params tipo_combustible y fecha son obligatorios" });
        return;
      }
      const combustibleId =
        typeof combustibleIdRaw === "string" && combustibleIdRaw !== ""
          ? Number(combustibleIdRaw)
          : null;
      const grifoId =
        typeof grifoIdRaw === "string" && grifoIdRaw !== "" ? Number(grifoIdRaw) : null;
      if ((combustibleId === null) === (grifoId === null)) {
        res
          .status(400)
          .json({ error: "Mandá exactamente uno de combustible_id o grifo_id, nunca los dos" });
        return;
      }

      const precio = await withTenant(tenantId, (client) =>
        service.obtenerPrecioVigente(
          client,
          tenantId,
          tipoCombustible,
          { combustibleId, grifoId },
          fecha
        )
      );
      res.json({ precio });
    } catch {
      res.status(500).json({ error: "Error al buscar el precio vigente" });
    }
  }

  async anularPrecio(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const precioId = Number(req.params.precioId);
      const { motivo } = req.validatedBody as AnularPrecioCombustibleInput;

      const resultado = await withTenant(tenantId, async (client) => {
        const anulado = await service.anularPrecio(
          client,
          tenantId,
          precioId,
          req.usuario!.id,
          motivo
        );
        if (anulado) return { estado: "anulada" as const, precio: anulado };

        const existente = await service.getPrecioPorId(client, tenantId, precioId);
        return existente ? { estado: "ya_anulada" as const } : { estado: "inexistente" as const };
      });

      if (resultado.estado === "inexistente") {
        res.status(404).json({ error: "Precio no encontrado" });
        return;
      }
      if (resultado.estado === "ya_anulada") {
        res.status(409).json({ error: "Este precio ya estaba anulado" });
        return;
      }

      await registrarAuditoria({
        accion: "combustible.precio_anular",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { precioId, motivo },
        contexto: contextoAuditoriaModulo(req),
      });
      res.json(resultado.precio);
    } catch {
      res.status(500).json({ error: "Error al anular el precio" });
    }
  }

  // ── Recepciones (Fase C, ver migrations/0064) ─────────────────────────

  /** POST /recepciones -- registra cuánto ENTRÓ al tanque propio y a qué
   *  costo. Es lo único que escribe `combustible.costo_promedio` (el
   *  recálculo va adentro del service, en la misma transacción).
   *
   *  NO mueve el nivel del tanque: eso sigue siendo exclusivo de una
   *  lectura de varilla (migración 0059). Ver el encabezado de 0064 sobre
   *  por qué esa independencia es deliberada. */
  async crearRecepcion(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const data = req.validatedBody as CrearRecepcionCombustibleInput;
      const { fila, creado } = await withTenant(tenantId, (client) =>
        service.crearRecepcion(client, tenantId, req.usuario!.id, data)
      );

      // Reintento de un envío ya guardado (doble clic sobre el mismo
      // formulario) -- 200, no 201: no creó nada, y así el costo promedio
      // no se vuelve a tocar ni se duplica la auditoría.
      if (!creado) {
        res.status(200).json(fila ?? { error: "Esta recepción ya se había registrado" });
        return;
      }

      await registrarAuditoria({
        accion: "combustible.recepcion_crear",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: {
          recepcionId: fila!.id,
          combustibleId: data.combustible_id,
          cantidad: data.cantidad,
          costoUnitario: data.costo_unitario,
        },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "combustible.recepcion_creada", {
        recepcionId: fila!.id,
        combustibleId: data.combustible_id,
      });
      res.status(201).json(fila);
    } catch (err) {
      if (
        err instanceof Error &&
        (err.message.includes("no existe en este tenant") ||
          err.message.includes("exige factura o guía") ||
          err.message.includes("no tiene ninguna lectura vigente") ||
          err.message.includes("supera la capacidad del tanque") ||
          // Grifo del rol equivocado (migrations/0065).
          err.message.includes("no está marcado como"))
      ) {
        // Todos son datos que se contradicen a sí mismos o a la
        // configuración del tanque que el propio request referenció -- 400,
        // corregible en el momento (punto 5 del documento de diseño).
        res.status(400).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: "Error al registrar la recepción" });
    }
  }

  /** GET /recepciones -- historial paginado, con filtro opcional por
   *  tanque. Incluye las anuladas (marcadas): son evidencia, no ruido. */
  async listarRecepciones(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const paginacion = parsePaginacion(req.query);
      const combustibleIdRaw = req.query.combustible_id;
      const combustibleId =
        typeof combustibleIdRaw === "string" && combustibleIdRaw.trim() !== ""
          ? Number(combustibleIdRaw)
          : undefined;

      const filas = await withTenant(tenantId, (client) =>
        service.listarRecepciones(client, tenantId, { combustibleId }, paginacion)
      );
      res.json(armarRespuestaPaginada(filas, paginacion));
    } catch {
      res.status(500).json({ error: "Error al listar recepciones" });
    }
  }

  /** PATCH /recepciones/:recepcionId/anular -- mismo mecanismo exacto que
   *  anularLectura/anularPrecio (404 vs 409), con una diferencia: acá el
   *  costo promedio del tanque se recalcula sin la fila anulada, así que la
   *  respuesta devuelve también el tanque con su promedio ya actualizado. */
  async anularRecepcion(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const recepcionId = Number(req.params.recepcionId);
      const { motivo } = req.validatedBody as AnularRecepcionCombustibleInput;

      const resultado = await withTenant(tenantId, async (client) => {
        const anulada = await service.anularRecepcion(
          client,
          tenantId,
          recepcionId,
          req.usuario!.id,
          motivo
        );
        if (anulada) return { estado: "anulada" as const, ...anulada };

        const existente = await service.getRecepcionPorId(client, tenantId, recepcionId);
        return existente ? { estado: "ya_anulada" as const } : { estado: "inexistente" as const };
      });

      if (resultado.estado === "inexistente") {
        res.status(404).json({ error: "Recepción no encontrada" });
        return;
      }
      if (resultado.estado === "ya_anulada") {
        res.status(409).json({ error: "Esta recepción ya estaba anulada" });
        return;
      }

      await registrarAuditoria({
        accion: "combustible.recepcion_anular",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { recepcionId, motivo },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "combustible.recepcion_anulada", {
        recepcionId,
      });
      res.json({ recepcion: resultado.recepcion, tanque: resultado.tanque });
    } catch {
      res.status(500).json({ error: "Error al anular la recepción" });
    }
  }
}
