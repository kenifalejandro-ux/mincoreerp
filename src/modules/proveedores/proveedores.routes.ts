/** src/modules/proveedores/proveedores.routes.ts
 *
 * Ecosistema «Gestión de proveedores» (PR1, solo lectura): resumen del Centro de gestión, listado del
 * Directorio y ficha; el PR2 suma el alta y la edición (POST y PUT); el PR5b, registrar, habilitar y
 * anular compras de cisterna.
 *
 * Sin permiso de pestaña a propósito: el acceso lo da el MÓDULO asignado a cada persona (los perfiles
 * de cancha no lo reciben por su rol, ver MODULOS_POR_ROL) y el perfil Lectura mira pero no escribe
 * (requireNivelParaEscribir corta los métodos de escritura). Una pestaña más agrandaría la cookie de
 * sesión, que ya está cerca de su tope (tests/combustible-historial-compras-conductor.test.ts, A-4).
 */
import { Router, type Request, type RequestHandler, type Response } from "express";

import { withTenant } from "../../server/config/database";
import { validate } from "../../server/middleware/validate";
import {
  anularCompraCisternaSchema,
  crearCompraCisternaSchema,
  type AnularCompraCisternaInput,
  type CrearCompraCisternaInput,
} from "../../server/schemas/combustible.schema";
import {
  actualizarProveedorSchema,
  crearProveedorSchema,
  type ActualizarProveedorInput,
  type CrearProveedorInput,
} from "../../server/schemas/proveedores.schema";
import { registrarAuditoria } from "../../server/services/platformAudit.service";
import { publicarEventoTenant } from "../../server/services/realtimeEvents.service";
import { AppError } from "../../server/shared/middlewares/error.middleware";
import { pestanaPermitida } from "../../server/services/permisosPestanas.service";
import { requirePestana } from "../../server/shared/middlewares/pestana.middleware";
import { requireRole } from "../../server/shared/middlewares/roles.middleware";
import { asyncHandler } from "../../server/shared/utils/asyncHandler";
import { contextoAuditoriaModulo } from "../../server/shared/utils/moduleAudit";
import { getTenantId } from "../../server/shared/utils/request";
import { cargarAlcance, alcanceDe } from "../combustible/alcance";
import { tieneModulo } from "../../server/shared/utils/modulos";
import { ProveedoresService } from "./proveedores.service";

const router = Router();
const service = new ProveedoresService();

router.get(
  "/resumen",
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    res.json(await withTenant(tenantId, (client) => service.resumen(client, tenantId)));
  })
);

router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    res.json(await withTenant(tenantId, (client) => service.listar(client, tenantId)));
  })
);

// Gestión comercial (PR4): precios de proveedores, solo lectura. Reutiliza los permisos de Precios de
// Combustible (`tanques:precios` y `urea:precios`): quien tiene uno ve ese producto; sin ninguno, 403.
// Sin pestaña propia a propósito (cada pestaña agranda la cookie de sesión).
router.get(
  "/precios",
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    const usuario = req.usuario!;
    const ver = {
      combustible: pestanaPermitida(usuario, "combustible", "tanques:precios"),
      urea: pestanaPermitida(usuario, "combustible", "urea:precios"),
    };
    if (!ver.combustible && !ver.urea) {
      throw new AppError(403, "Pestaña no disponible para este perfil");
    }
    const filas = await withTenant(tenantId, (client) => service.precios(client, tenantId, ver));
    res.json({ ...ver, filas });
  })
);

// Compras y recepciones (PR5): las compras de cisterna de Combustible, solo lectura. Mismas reglas que
// allá: ve quien tiene la pestaña `cisternas`; quien no gestiona compras (`cisternas:registrar_compra`)
// solo recibe las ya por llegar; y con Combustible en la empresa rige el alcance por sede (sin él no hay
// alcance que cargar). Registrar, habilitar y anular siguen en Combustible → Cisternas.
const alcanceSiHayCombustible: RequestHandler = (req, res, next) =>
  tieneModulo(req.usuario, "combustible") ? cargarAlcance(req, res, next) : next();

router.get(
  "/compras",
  alcanceSiHayCombustible,
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    const usuario = req.usuario!;
    if (!pestanaPermitida(usuario, "combustible", "cisternas")) {
      throw new AppError(403, "Pestaña no disponible para este perfil");
    }
    const gestiona = pestanaPermitida(usuario, "combustible", "cisternas:registrar_compra");
    res.json(
      await withTenant(tenantId, (client) =>
        service.compras(client, tenantId, alcanceDe(req), gestiona)
      )
    );
  })
);

// PR5b: registrar, habilitar y anular compras desde el ecosistema. Mismas reglas que en Combustible →
// Cisternas: solo quien gestiona compras (`cisternas:registrar_compra`, admin por defecto) y con rol admin
// u operador; Lectura y los módulos en «Consultas» los corta requireNivelParaEscribir. Cada cambio deja su
// auditoría (ids, sin el contenido) y avisa en vivo a las pantallas de Cisternas abiertas.
const gestionaCompras = [
  alcanceSiHayCombustible,
  requirePestana("combustible", "cisternas:registrar_compra"),
  requireRole("admin", "operador"),
];
const avisarCambioDeCompras = (tenantId: string) =>
  publicarEventoTenant(tenantId, "combustible.compra_cisterna_actualizada", {});
const idDeCompra = (req: Request): number => {
  const id = Number(req.params.compraId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new AppError(400, "El identificador de la compra no es válido");
  }
  return id;
};

router.get(
  "/compras/formulario",
  ...gestionaCompras,
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    res.json(
      await withTenant(tenantId, (client) =>
        service.datosParaElFormulario(client, tenantId, alcanceDe(req))
      )
    );
  })
);

router.post(
  "/compras",
  ...gestionaCompras,
  validate(crearCompraCisternaSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    const data = req.validatedBody as CrearCompraCisternaInput;
    const { compra, creado } = await withTenant(tenantId, (client) =>
      service.registrarCompra(client, tenantId, req.usuario!.id, data, alcanceDe(req))
    );
    // Un reintento ya guardado: 200, sin duplicar auditoría ni evento.
    if (!creado) {
      res.status(200).json(compra);
      return;
    }
    await registrarAuditoria({
      accion: "proveedores.compra_crear",
      tenantId,
      usuarioId: req.usuario!.id,
      detalle: { compraId: compra.id, proveedorId: compra.proveedorId },
      contexto: contextoAuditoriaModulo(req),
    });
    await avisarCambioDeCompras(tenantId);
    res.status(201).json(compra);
  })
);

router.patch(
  "/compras/:compraId(\\d+)/habilitar",
  ...gestionaCompras,
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    const id = idDeCompra(req);
    const compra = await withTenant(tenantId, (client) =>
      service.habilitarCompra(client, tenantId, req.usuario!.id, id, alcanceDe(req))
    );
    await registrarAuditoria({
      accion: "proveedores.compra_habilitar",
      tenantId,
      usuarioId: req.usuario!.id,
      detalle: { compraId: id },
      contexto: contextoAuditoriaModulo(req),
    });
    await avisarCambioDeCompras(tenantId);
    res.json(compra);
  })
);

router.patch(
  "/compras/:compraId(\\d+)/anular",
  ...gestionaCompras,
  validate(anularCompraCisternaSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    const id = idDeCompra(req);
    const data = req.validatedBody as AnularCompraCisternaInput;
    const compra = await withTenant(tenantId, (client) =>
      service.anularCompra(client, tenantId, req.usuario!.id, id, data, alcanceDe(req))
    );
    await registrarAuditoria({
      accion: "proveedores.compra_anular",
      tenantId,
      usuarioId: req.usuario!.id,
      detalle: { compraId: id },
      contexto: contextoAuditoriaModulo(req),
    });
    await avisarCambioDeCompras(tenantId);
    res.json(compra);
  })
);

router.get(
  "/:id(\\d+)",
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) throw new AppError(400, "Proveedor inválido");
    res.json(await withTenant(tenantId, (client) => service.detalle(client, tenantId, id)));
  })
);

// PR2: alta y edición. Solo admin y operador (Lectura y los módulos en «Consultas» los corta
// requireNivelParaEscribir al montar el router). La auditoría lleva ids y banderas, no el contenido.
router.post(
  "/",
  requireRole("admin", "operador"),
  validate(crearProveedorSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    const data = req.validatedBody as CrearProveedorInput;
    const proveedor = await withTenant(tenantId, (client) =>
      service.crear(client, tenantId, req.usuario!.id, data)
    );
    await registrarAuditoria({
      accion: "proveedores.crear",
      tenantId,
      usuarioId: req.usuario!.id,
      detalle: {
        proveedorId: proveedor.id,
        conRuc: proveedor.ruc !== null,
        tipos: proveedor.tipos,
      },
      contexto: contextoAuditoriaModulo(req),
    });
    res.status(201).json(proveedor);
  })
);

router.put(
  "/:id(\\d+)",
  requireRole("admin", "operador"),
  validate(actualizarProveedorSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) throw new AppError(400, "Proveedor inválido");
    const data = req.validatedBody as ActualizarProveedorInput;
    const proveedor = await withTenant(tenantId, (client) =>
      service.actualizar(client, tenantId, id, data)
    );
    await registrarAuditoria({
      accion: "proveedores.actualizar",
      tenantId,
      usuarioId: req.usuario!.id,
      detalle: { proveedorId: id, activo: proveedor.activo, tipos: proveedor.tipos },
      contexto: contextoAuditoriaModulo(req),
    });
    res.json(proveedor);
  })
);

export default router;
