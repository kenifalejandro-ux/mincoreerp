/** src/modules/proveedores/proveedores.routes.ts
 *
 * Ecosistema «Gestión de proveedores» (PR1, solo lectura): resumen del Centro de gestión, listado del
 * Directorio y ficha; el PR2 suma el alta y la edición (POST y PUT); el PR5b, registrar, habilitar y
 * anular compras de cisterna; el PR4b, cargar y anular precios de proveedores; el PR3a, la ficha del
 * proveedor (datos de contacto, condiciones de pago y contactos); el PR3b, sus cuentas bancarias (con
 * permisos aparte, número cifrado y bitácora).
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
  anularPrecioCombustibleSchema,
  crearCompraCisternaSchema,
  crearPrecioUreaSchema,
  type AnularCompraCisternaInput,
  type AnularPrecioCombustibleInput,
  type CrearCompraCisternaInput,
  type CrearPrecioUreaInput,
} from "../../server/schemas/combustible.schema";
import {
  actualizarCuentaProveedorSchema,
  actualizarProveedorSchema,
  contactoProveedorSchema,
  crearCuentaProveedorSchema,
  crearPreciosProveedoresSchema,
  crearProveedorSchema,
  guardarDatosProveedorSchema,
  quitarCuentaProveedorSchema,
  type ActualizarCuentaProveedorInput,
  type ActualizarProveedorInput,
  type ContactoProveedorInput,
  type CrearCuentaProveedorInput,
  type CrearPreciosProveedoresInput,
  type CrearProveedorInput,
  type GuardarDatosProveedorInput,
  type QuitarCuentaProveedorInput,
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
import { PATRON_DE_CATEGORIA, type CategoriaDeHistorial } from "./proveedores.historial";
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

// PR4b: cargar y anular precios de PROVEEDORES desde el ecosistema (combustible de ruta y urea). Mismas
// reglas y mismos permisos que Combustible → Precios: `tanques:precios` (combustible) o `urea:precios`
// (urea) y rol admin u operador; Lectura y los módulos en «Consultas» los corta requireNivelParaEscribir.
// El precio se apila con su `vigente_desde`, nunca se edita; uno mal cargado se anula con motivo. Los
// precios de tanque (venta interna) siguen siendo de Combustible.
const preciosDeCombustible = [
  requirePestana("combustible", "tanques:precios"),
  requireRole("admin", "operador"),
];
const preciosDeUrea = [
  requirePestana("combustible", "urea:precios"),
  requireRole("admin", "operador"),
];
const idDePrecio = (req: Request): number => {
  const id = Number(req.params.precioId);
  if (!Number.isSafeInteger(id) || id <= 0 || id > 2147483647) {
    throw new AppError(400, "El identificador del precio no es válido");
  }
  return id;
};

router.get(
  "/precios/formulario",
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    const usuario = req.usuario!;
    const puedeCargar = usuario.rol === "admin" || usuario.rol === "operador";
    const ver = {
      combustible: puedeCargar && pestanaPermitida(usuario, "combustible", "tanques:precios"),
      urea: puedeCargar && pestanaPermitida(usuario, "combustible", "urea:precios"),
    };
    if (!ver.combustible && !ver.urea) {
      throw new AppError(403, "Pestaña no disponible para este perfil");
    }
    res.json(
      await withTenant(tenantId, (client) =>
        service.datosParaFormularioDePrecios(client, tenantId, ver)
      )
    );
  })
);

router.post(
  "/precios/combustible",
  ...preciosDeCombustible,
  validate(crearPreciosProveedoresSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    const data = req.validatedBody as CrearPreciosProveedoresInput;
    const creados = await withTenant(tenantId, (client) =>
      service.crearPreciosCombustible(client, tenantId, req.usuario!.id, data)
    );
    // Mover un precio es mover el control: queda quién y qué (el valor del precio es el hecho auditado).
    for (const precio of creados) {
      await registrarAuditoria({
        accion: "proveedores.precio_crear",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: {
          precioId: precio.id,
          proveedorId: precio.grifo_id,
          producto: "combustible",
          tipoCombustible: data.tipo_combustible,
          precioUnitario: data.precio_unitario,
          ...(data.vigente_hasta ? { vigenteHasta: data.vigente_hasta } : {}),
          masivo: creados.length > 1,
        },
        contexto: contextoAuditoriaModulo(req),
      });
    }
    res.status(201).json(creados);
  })
);

router.post(
  "/precios/urea",
  ...preciosDeUrea,
  validate(crearPrecioUreaSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    const data = req.validatedBody as CrearPrecioUreaInput;
    const fila = await withTenant(tenantId, (client) =>
      service.crearPrecioUrea(client, tenantId, req.usuario!.id, data)
    );
    await registrarAuditoria({
      accion: "proveedores.precio_crear",
      tenantId,
      usuarioId: req.usuario!.id,
      detalle: {
        precioId: fila.id,
        proveedorId: data.grifo_id,
        producto: "urea",
        presentacion: data.presentacion,
        precioPorBulto: data.precio_por_bulto,
        vigenteDesde: fila.vigente_desde,
        ...(data.vigente_hasta ? { vigenteHasta: data.vigente_hasta } : {}),
      },
      contexto: contextoAuditoriaModulo(req),
    });
    await publicarEventoTenant(tenantId, "combustible.urea_precios_cambiaron", {
      precioId: fila.id,
    });
    res.status(201).json(fila);
  })
);

router.patch(
  "/precios/combustible/:precioId(\\d+)/anular",
  ...preciosDeCombustible,
  validate(anularPrecioCombustibleSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    const id = idDePrecio(req);
    const data = req.validatedBody as AnularPrecioCombustibleInput;
    const precio = await withTenant(tenantId, (client) =>
      service.anularPrecioCombustible(client, tenantId, req.usuario!.id, id, data)
    );
    await registrarAuditoria({
      accion: "proveedores.precio_anular",
      tenantId,
      usuarioId: req.usuario!.id,
      detalle: {
        precioId: id,
        proveedorId: precio.grifo_id,
        producto: "combustible",
        motivo: data.motivo,
      },
      contexto: contextoAuditoriaModulo(req),
    });
    res.json(precio);
  })
);

router.patch(
  "/precios/urea/:precioId(\\d+)/anular",
  ...preciosDeUrea,
  validate(anularPrecioCombustibleSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    const id = idDePrecio(req);
    const data = req.validatedBody as AnularPrecioCombustibleInput;
    const fila = await withTenant(tenantId, (client) =>
      service.anularPrecioUrea(client, tenantId, req.usuario!.id, id, data)
    );
    await registrarAuditoria({
      accion: "proveedores.precio_anular",
      tenantId,
      usuarioId: req.usuario!.id,
      detalle: { precioId: id, proveedorId: fila.grifo_id, producto: "urea", motivo: data.motivo },
      contexto: contextoAuditoriaModulo(req),
    });
    await publicarEventoTenant(tenantId, "combustible.urea_precios_cambiaron", {
      precioId: id,
    });
    res.json(fila);
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
      detalle: { compraId: id, proveedorId: compra.proveedorId },
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
      detalle: { compraId: id, proveedorId: compra.proveedorId },
      contexto: contextoAuditoriaModulo(req),
    });
    await avisarCambioDeCompras(tenantId);
    res.json(compra);
  })
);

// PR3a: la ficha del proveedor (datos de contacto, condiciones de pago y personas de contacto). Se ve con
// el módulo; escribir es de admin y operador (Lectura y «Consultas» los corta requireNivelParaEscribir). La
// auditoría dice qué campos cambiaron y los ids, no los valores. Las cuentas bancarias, que sí son
// sensibles, no están acá: van en su propio PR con permiso aparte.
const idDeProveedor = (req: Request): number => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0 || id > 2147483647) {
    throw new AppError(400, "Proveedor inválido");
  }
  return id;
};
const idDeContacto = (req: Request): number => {
  const id = Number(req.params.contactoId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new AppError(400, "Contacto inválido");
  return id;
};

router.get(
  "/:id(\\d+)/ficha",
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    const id = idDeProveedor(req);
    res.json(await withTenant(tenantId, (client) => service.ficha(client, tenantId, id)));
  })
);

router.put(
  "/:id(\\d+)/ficha",
  requireRole("admin", "operador"),
  validate(guardarDatosProveedorSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    const id = idDeProveedor(req);
    const data = req.validatedBody as GuardarDatosProveedorInput;
    const { datos, campos } = await withTenant(tenantId, (client) =>
      service.guardarDatos(client, tenantId, req.usuario!.id, id, data)
    );
    await registrarAuditoria({
      accion: "proveedores.datos_editar",
      tenantId,
      usuarioId: req.usuario!.id,
      detalle: { proveedorId: id, campos },
      contexto: contextoAuditoriaModulo(req),
    });
    res.json(datos);
  })
);

router.post(
  "/:id(\\d+)/contactos",
  requireRole("admin", "operador"),
  validate(contactoProveedorSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    const id = idDeProveedor(req);
    const data = req.validatedBody as ContactoProveedorInput;
    const { contacto, creado } = await withTenant(tenantId, (client) =>
      service.crearContacto(client, tenantId, req.usuario!.id, id, data)
    );
    // Un reintento ya guardado: 200, sin duplicar la auditoría.
    if (!creado) {
      res.status(200).json(contacto);
      return;
    }
    await registrarAuditoria({
      accion: "proveedores.contacto_crear",
      tenantId,
      usuarioId: req.usuario!.id,
      detalle: { proveedorId: id, contactoId: contacto.id, principal: contacto.principal },
      contexto: contextoAuditoriaModulo(req),
    });
    res.status(201).json(contacto);
  })
);

router.put(
  "/:id(\\d+)/contactos/:contactoId(\\d+)",
  requireRole("admin", "operador"),
  validate(contactoProveedorSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    const id = idDeProveedor(req);
    const contactoId = idDeContacto(req);
    const data = req.validatedBody as ContactoProveedorInput;
    const contacto = await withTenant(tenantId, (client) =>
      service.actualizarContacto(client, tenantId, req.usuario!.id, id, contactoId, data)
    );
    await registrarAuditoria({
      accion: "proveedores.contacto_editar",
      tenantId,
      usuarioId: req.usuario!.id,
      detalle: { proveedorId: id, contactoId, principal: contacto.principal },
      contexto: contextoAuditoriaModulo(req),
    });
    res.json(contacto);
  })
);

router.patch(
  "/:id(\\d+)/contactos/:contactoId(\\d+)/quitar",
  requireRole("admin", "operador"),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    const id = idDeProveedor(req);
    const contactoId = idDeContacto(req);
    await withTenant(tenantId, (client) =>
      service.quitarContacto(client, tenantId, req.usuario!.id, id, contactoId)
    );
    await registrarAuditoria({
      accion: "proveedores.contacto_quitar",
      tenantId,
      usuarioId: req.usuario!.id,
      detalle: { proveedorId: id, contactoId },
      contexto: contextoAuditoriaModulo(req),
    });
    res.json({ ok: true });
  })
);

// PR3b: cuentas bancarias del proveedor. A qué cuenta se le paga es el dato que más se defrauda, así que
// tiene permisos aparte y nacen solo para el admin: `cuentas` (ver la lista, con el número enmascarado),
// `cuentas:ver_completa` (ver el número entero) y `cuentas:editar` (agregar, editar y quitar). El número
// se guarda cifrado y NUNCA viaja en una lista, un alta o una edición: solo «ver completo» lo devuelve, y
// cada vez queda en la bitácora. Toda la bitácora de este grupo lleva ids y los últimos 4 dígitos, jamás
// el número.
const idDeCuenta = (req: Request): number => {
  const id = Number(req.params.cuentaId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new AppError(400, "Cuenta inválida");
  return id;
};
const veCuentas = requirePestana("proveedores", "cuentas");
const veNumeroCompleto = [
  requirePestana("proveedores", "cuentas:ver_completa"),
  requireRole("admin", "operador"),
];
const editaCuentas = [
  requirePestana("proveedores", "cuentas:editar"),
  requireRole("admin", "operador"),
];

router.get(
  "/:id(\\d+)/cuentas",
  veCuentas,
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    const id = idDeProveedor(req);
    const usuario = req.usuario!;
    const cuentas = await withTenant(tenantId, (client) => service.cuentas(client, tenantId, id));
    res.setHeader("Cache-Control", "no-store");
    res.json({
      verCompleta: pestanaPermitida(usuario, "proveedores", "cuentas:ver_completa"),
      puedeEditar:
        (usuario.rol === "admin" || usuario.rol === "operador") &&
        pestanaPermitida(usuario, "proveedores", "cuentas:editar"),
      cuentas,
    });
  })
);

// POST y no GET: ver el número completo deja constancia, y un GET no debe escribir.
router.post(
  "/:id(\\d+)/cuentas/:cuentaId(\\d+)/ver-completa",
  ...veNumeroCompleto,
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    const id = idDeProveedor(req);
    const cuentaId = idDeCuenta(req);
    const numero = await withTenant(tenantId, (client) =>
      service.numeroCompleto(client, tenantId, id, cuentaId)
    );
    await registrarAuditoria({
      accion: "proveedores.cuenta_ver",
      tenantId,
      usuarioId: req.usuario!.id,
      detalle: { proveedorId: id, cuentaId, ultimos4: numero.slice(-4) },
      contexto: contextoAuditoriaModulo(req),
    });
    res.setHeader("Cache-Control", "no-store");
    res.json({ numero });
  })
);

router.post(
  "/:id(\\d+)/cuentas",
  ...editaCuentas,
  validate(crearCuentaProveedorSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    const id = idDeProveedor(req);
    const data = req.validatedBody as CrearCuentaProveedorInput;
    const { cuenta, creado } = await withTenant(tenantId, (client) =>
      service.crearCuenta(client, tenantId, req.usuario!.id, id, data)
    );
    res.setHeader("Cache-Control", "no-store");
    // Un reintento ya guardado: 200, sin duplicar la bitácora.
    if (!creado) {
      res.status(200).json(cuenta);
      return;
    }
    await registrarAuditoria({
      accion: "proveedores.cuenta_crear",
      tenantId,
      usuarioId: req.usuario!.id,
      detalle: {
        proveedorId: id,
        cuentaId: cuenta.id,
        banco: cuenta.banco,
        ultimos4: cuenta.numeroEnmascarado.slice(-4),
        principal: cuenta.principal,
      },
      contexto: contextoAuditoriaModulo(req),
    });
    res.status(201).json(cuenta);
  })
);

router.put(
  "/:id(\\d+)/cuentas/:cuentaId(\\d+)",
  ...editaCuentas,
  validate(actualizarCuentaProveedorSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    const id = idDeProveedor(req);
    const cuentaId = idDeCuenta(req);
    const data = req.validatedBody as ActualizarCuentaProveedorInput;
    const { cuenta, cambioElNumero, ultimos4Anteriores } = await withTenant(tenantId, (client) =>
      service.actualizarCuenta(client, tenantId, req.usuario!.id, id, cuentaId, data)
    );
    // Cambiar el NÚMERO de una cuenta es redirigir un pago: queda con los últimos 4 de antes y de después.
    await registrarAuditoria({
      accion: cambioElNumero ? "proveedores.cuenta_cambiar_numero" : "proveedores.cuenta_editar",
      tenantId,
      usuarioId: req.usuario!.id,
      detalle: {
        proveedorId: id,
        cuentaId,
        banco: cuenta.banco,
        ...(cambioElNumero
          ? { ultimos4Anteriores, ultimos4Nuevos: cuenta.numeroEnmascarado.slice(-4) }
          : { ultimos4: cuenta.numeroEnmascarado.slice(-4) }),
        principal: cuenta.principal,
      },
      contexto: contextoAuditoriaModulo(req),
    });
    res.setHeader("Cache-Control", "no-store");
    res.json(cuenta);
  })
);

router.patch(
  "/:id(\\d+)/cuentas/:cuentaId(\\d+)/quitar",
  ...editaCuentas,
  validate(quitarCuentaProveedorSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    const id = idDeProveedor(req);
    const cuentaId = idDeCuenta(req);
    const data = req.validatedBody as QuitarCuentaProveedorInput;
    await withTenant(tenantId, (client) =>
      service.quitarCuenta(client, tenantId, req.usuario!.id, id, cuentaId, data)
    );
    await registrarAuditoria({
      accion: "proveedores.cuenta_quitar",
      tenantId,
      usuarioId: req.usuario!.id,
      detalle: { proveedorId: id, cuentaId, motivo: data.motivo },
      contexto: contextoAuditoriaModulo(req),
    });
    res.json({ ok: true });
  })
);

// Historial y auditoría: lo que se hizo con los proveedores (bitácora de la empresa, acciones
// `proveedores.*`). Solo el admin: ahí aparece quién vio un número de cuenta o cambió un precio. La misma
// bitácora se ve completa en Administración → Log de eventos; esto es su vista dentro del ecosistema.
router.get(
  "/historial",
  requireRole("admin"),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getTenantId(req);
    const q = req.query;
    const categoria = typeof q.categoria === "string" ? q.categoria : undefined;
    if (categoria !== undefined && !(categoria in PATRON_DE_CATEGORIA)) {
      throw new AppError(400, "Categoría de historial inválida");
    }
    const fecha = (v: unknown) =>
      typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;
    const antesDe =
      typeof q.antesDe === "string" && /^\d{1,18}$/.test(q.antesDe) ? q.antesDe : undefined;
    res.setHeader("Cache-Control", "no-store");
    res.json(
      await withTenant(tenantId, (client) =>
        service.historial(client, tenantId, {
          categoria: categoria as CategoriaDeHistorial | undefined,
          desde: fecha(q.desde),
          hasta: fecha(q.hasta),
          proveedor: typeof q.proveedor === "string" ? q.proveedor.slice(0, 100) : undefined,
          antesDe,
          // Un tope duro: sin él, `?limite=999999` se trae media bitácora en una consulta.
          limite: Math.min(Math.max(Number(q.limite) || 50, 1), 100),
        })
      )
    );
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
