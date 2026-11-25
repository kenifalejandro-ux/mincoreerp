/** src/modules/mantenimiento/mantenimiento.routes.ts
 *
 * Ecosistema «Gestión de mantenimiento». Equipos (lista, alta, edición, quitar, importar desde Excel), áreas
 * (lista, alta, quitar), el resumen del Centro y la configuración (reglas y metas). Los equipos son del maestro
 * de unidades (`equipos`, tabla base de la empresa): ver mantenimiento.service.ts.
 *
 * Sin permiso de pestaña a propósito (igual que Proveedores): el acceso lo da el MÓDULO asignado a cada
 * persona, y el perfil Lectura mira pero no escribe (requireNivelParaEscribir corta los métodos de
 * escritura). Escribir es de admin y operador, salvo la configuración, que solo la cambia el admin. Una pestaña
 * más agrandaría la cookie de sesión, que ya está cerca de su tope.
 *
 * Cada cambio deja quién lo hizo y qué ids toca en la auditoría de la empresa (sin copiar los datos del
 * equipo); quitar un equipo guarda además el motivo.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";

import { withTenant } from "../../server/config/database";
import { validate, validateQuery } from "../../server/middleware/validate";
import {
  actualizarEquipoMantenimientoSchema,
  crearAreaMantenimientoSchema,
  completarEquiposMantenimientoSchema,
  crearEquipoMantenimientoSchema,
  guardarConfigMantenimientoSchema,
  importarEquiposMantenimientoSchema,
  quitarEquipoMantenimientoSchema,
  type ActualizarEquipoMantenimientoInput,
  type CompletarEquiposMantenimientoInput,
  type CrearAreaMantenimientoInput,
  type CrearEquipoMantenimientoInput,
  type GuardarConfigMantenimientoInput,
  type ImportarEquiposMantenimientoInput,
  type QuitarEquipoMantenimientoInput,
} from "../../server/schemas/mantenimiento.schema";
import { registrarAuditoria } from "../../server/services/platformAudit.service";
import { AppError } from "../../server/shared/middlewares/error.middleware";
import { requireRole } from "../../server/shared/middlewares/roles.middleware";
import { asyncHandler } from "../../server/shared/utils/asyncHandler";
import { contextoAuditoriaModulo } from "../../server/shared/utils/moduleAudit";
import { getTenantId } from "../../server/shared/utils/request";
import { MantenimientoService } from "./mantenimiento.service";

const router = Router();
const service = new MantenimientoService();
const escribe = requireRole("admin", "operador");
/** Las reglas y las metas las decide el administrador; las demás personas con el módulo las miran. */
const soloAdmin = requireRole("admin");

const filtrosEquiposSchema = z.object({
  q: z.string().trim().max(80).optional(),
  tipo: z.string().trim().max(60).optional(),
  area: z
    .string()
    .trim()
    .regex(/^(\d{1,12}|sin_area)$/)
    .optional(),
});

/** Dos personas guardando la misma placa a la vez: la comprobación previa no las ve, el índice único sí. */
async function sinChoques<T>(trabajo: () => Promise<T>, mensaje: string): Promise<T> {
  try {
    return await trabajo();
  } catch (error) {
    if ((error as { code?: string }).code === "23505") throw new AppError(409, mensaje);
    throw error;
  }
}

const idDe = (req: Request) => Number(req.params.id);

router.get(
  "/equipos",
  validateQuery(filtrosEquiposSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    const filtros = req.validatedQuery as z.infer<typeof filtrosEquiposSchema>;
    res.json(
      await withTenant(tenantId, (client) => service.listarEquipos(client, tenantId, filtros))
    );
  })
);

router.post(
  "/equipos",
  escribe,
  validate(crearEquipoMantenimientoSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    const data = req.validatedBody as CrearEquipoMantenimientoInput;
    const { equipo, creado } = await sinChoques(
      () =>
        withTenant(tenantId, (client) =>
          service.crearEquipo(client, tenantId, req.usuario!.id, data)
        ),
      "Ya hay un equipo con esa placa o código"
    );
    if (creado && equipo) {
      await registrarAuditoria({
        accion: "mantenimiento.equipo_crear",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { equipoId: equipo.id },
        contexto: contextoAuditoriaModulo(req),
      });
    }
    // `equipo` es null solo si el reintento de un alta cuyo equipo ya se quitó: el pedido se cumplió.
    res.status(creado ? 201 : 200).json(equipo ?? { ok: true });
  })
);

// La ruta termina en /bulk: app.ts le amplía el tamaño del cuerpo a las cargas masivas (esRutaDeCargaMasiva).
router.post(
  "/equipos/bulk",
  escribe,
  validate(importarEquiposMantenimientoSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    const filas = req.validatedBody as ImportarEquiposMantenimientoInput;
    const resultado = await sinChoques(
      () =>
        withTenant(tenantId, (client) =>
          service.importarEquipos(client, tenantId, req.usuario!.id, filas)
        ),
      "Algún equipo del archivo ya existe: vuelve a intentarlo"
    );
    // Mismo formato de error que `validate` (campo = «fila.columna»): la pantalla de importación ya lo lee.
    if ("errores" in resultado) return res.status(400).json({ errors: resultado.errores });
    await registrarAuditoria({
      accion: "mantenimiento.equipos_importar",
      tenantId,
      usuarioId: req.usuario!.id,
      detalle: { cantidad: resultado.importados, areasCreadas: resultado.areasCreadas.length },
      contexto: contextoAuditoriaModulo(req),
    });
    res.status(201).json(resultado);
  })
);

// «Desde Operaciones»: las unidades que registró Flota y Mantenimiento aún no completó. ANTES de /:id.
router.get(
  "/equipos/pendientes",
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    res.json({
      equipos: await withTenant(tenantId, (client) =>
        service.pendientesDeOperaciones(client, tenantId)
      ),
    });
  })
);

router.post(
  "/equipos/completar",
  escribe,
  validate(completarEquiposMantenimientoSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    const data = req.validatedBody as CompletarEquiposMantenimientoInput;
    const resultado = await withTenant(tenantId, (client) =>
      service.completarEquipos(client, tenantId, req.usuario!.id, data)
    );
    // Solo ids y cuántas: no se copian los datos de las unidades.
    if (resultado.completados > 0) {
      await registrarAuditoria({
        accion: "mantenimiento.equipos_completar",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { cantidad: resultado.completados, ids: resultado.ids },
        contexto: contextoAuditoriaModulo(req),
      });
    }
    res.json(resultado);
  })
);

router.put(
  "/equipos/:id(\\d+)",
  escribe,
  validate(actualizarEquipoMantenimientoSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    const data = req.validatedBody as ActualizarEquipoMantenimientoInput;
    const { equipo, campos } = await sinChoques(
      () =>
        withTenant(tenantId, (client) =>
          service.actualizarEquipo(client, tenantId, req.usuario!.id, idDe(req), data)
        ),
      "Ya hay un equipo con esa placa o código"
    );
    // Solo los NOMBRES de lo que cambió, no los valores.
    await registrarAuditoria({
      accion: "mantenimiento.equipo_actualizar",
      tenantId,
      usuarioId: req.usuario!.id,
      detalle: { equipoId: equipo.id, campos },
      contexto: contextoAuditoriaModulo(req),
    });
    res.json(equipo);
  })
);

router.patch(
  "/equipos/:id(\\d+)/quitar",
  escribe,
  validate(quitarEquipoMantenimientoSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    const { motivo } = req.validatedBody as QuitarEquipoMantenimientoInput;
    await withTenant(tenantId, (client) => service.quitarEquipo(client, tenantId, idDe(req)));
    await registrarAuditoria({
      accion: "mantenimiento.equipo_quitar",
      tenantId,
      usuarioId: req.usuario!.id,
      detalle: { equipoId: idDe(req), motivo },
      contexto: contextoAuditoriaModulo(req),
    });
    res.json({ ok: true });
  })
);

router.get(
  "/resumen",
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    res.json(await withTenant(tenantId, (client) => service.resumen(client, tenantId)));
  })
);

router.get(
  "/config",
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    res.json(await withTenant(tenantId, (client) => service.obtenerConfig(client, tenantId)));
  })
);

router.put(
  "/config",
  soloAdmin,
  validate(guardarConfigMantenimientoSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    const cambios = req.validatedBody as GuardarConfigMantenimientoInput;
    const { config, campos } = await withTenant(tenantId, (client) =>
      service.guardarConfig(client, tenantId, req.usuario!.id, cambios)
    );
    // Solo los NOMBRES de lo que cambió. Guardar lo mismo no deja rastro: no cambió nada.
    if (campos.length > 0) {
      await registrarAuditoria({
        accion: "mantenimiento.config_actualizar",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { campos },
        contexto: contextoAuditoriaModulo(req),
      });
    }
    res.json(config);
  })
);

router.get(
  "/areas",
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    res.json(await withTenant(tenantId, (client) => service.listarAreas(client, tenantId)));
  })
);

router.post(
  "/areas",
  escribe,
  validate(crearAreaMantenimientoSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    const { nombre } = req.validatedBody as CrearAreaMantenimientoInput;
    const area = await sinChoques(
      () =>
        withTenant(tenantId, (client) =>
          service.crearArea(client, tenantId, req.usuario!.id, nombre)
        ),
      `Ya hay un área llamada «${nombre}»`
    );
    await registrarAuditoria({
      accion: "mantenimiento.area_crear",
      tenantId,
      usuarioId: req.usuario!.id,
      detalle: { areaId: area.id },
      contexto: contextoAuditoriaModulo(req),
    });
    res.status(201).json(area);
  })
);

router.delete(
  "/areas/:id(\\d+)",
  escribe,
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    await withTenant(tenantId, (client) => service.quitarArea(client, tenantId, idDe(req)));
    await registrarAuditoria({
      accion: "mantenimiento.area_quitar",
      tenantId,
      usuarioId: req.usuario!.id,
      detalle: { areaId: idDe(req) },
      contexto: contextoAuditoriaModulo(req),
    });
    res.json({ ok: true });
  })
);

export default router;
