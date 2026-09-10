import { z } from "zod";
import { MODULOS_ERP as MODULOS_ERP_REGISTRY } from "../../modules/registry";

export const crearTenantSchema = z.object({
  tenantNombre: z.string().trim().min(1, "Nombre de tenant requerido").max(200),
  tenantSlug: z
    .string()
    .trim()
    .toLowerCase()
    .min(2)
    .max(60)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "El slug solo admite minúsculas, números y guiones"),
  adminNombre: z.string().trim().min(1, "Nombre del admin requerido").max(100),
  adminEmail: z.string().trim().toLowerCase().email("Correo inválido").max(150),
  adminPassword: z.string().min(8, "La contraseña debe tener al menos 8 caracteres").max(200),
});

export type CrearTenantInput = z.infer<typeof crearTenantSchema>;

// Onboarding completo (POST /api/platform/tenants/onboard, gateado a
// super-admin): mismos campos que crearTenantSchema + un plan opcional.
// planCodigo separado de tenantOnboardingService.ts porque acá se valida
// SOLO la forma del dato (string no vacío); si el código corresponde a un
// plan que existe y está activo es responsabilidad del service, no del
// schema.
export const onboardTenantSchema = crearTenantSchema.extend({
  planCodigo: z.string().trim().min(1).max(50).optional(),
});

export type OnboardTenantInput = z.infer<typeof onboardTenantSchema>;

export const cambiarEstadoTenantSchema = z.object({
  activo: z.boolean(),
  motivo: z.string().trim().max(500).optional(),
});

export type CambiarEstadoTenantInput = z.infer<typeof cambiarEstadoTenantSchema>;

// Derivado de src/modules/registry.ts — la fuente única de qué módulos
// existen (ver docs/adr/0002-contrato-de-modulo.md). El cast solo satisface
// la forma que z.enum() exige (tupla no vacía); tests/module-registry.test.ts
// verifica que este set siga coincidiendo con el enum modulo_erp de Postgres.
export const MODULOS_ERP = MODULOS_ERP_REGISTRY as [string, ...string[]];

// Para /tenants/:tenantId/usuarios/:usuarioId/modulos — asignación cruda,
// sin estado propio (ver usuario_modulos, sigue siendo solo presencia).
export const actualizarModulosSchema = z.object({
  modulos: z.array(z.enum(MODULOS_ERP)),
});

export type ActualizarModulosInput = z.infer<typeof actualizarModulosSchema>;

// Para /tenants/:id/modulos — configuración granular por módulo (ver
// migrations/0021_tenant_modulos_granular.sql). rolloutPorcentaje solo se
// exige junto con estado "rollout" (refine abajo); en cualquier otro
// estado, si viene, se ignora en la lectura (obtenerModulosPermitidos)
// pero no rompe la validación — más simple no prohibirlo que tener que
// explicar por qué un campo "extra" hace fallar el request.
export const configuracionModuloSchema = z
  .object({
    modulo: z.enum(MODULOS_ERP),
    estado: z.enum(["habilitado", "deshabilitado", "rollout"]),
    rolloutPorcentaje: z.number().int().min(0).max(100).nullable().optional(),
    version: z.string().trim().max(20).nullable().optional(),
  })
  .refine((c) => c.estado !== "rollout" || typeof c.rolloutPorcentaje === "number", {
    message: "rolloutPorcentaje es requerido cuando el estado es 'rollout'",
    path: ["rolloutPorcentaje"],
  });

export const actualizarModulosTenantSchema = z.object({
  configuraciones: z.array(configuracionModuloSchema),
});

export type ActualizarModulosTenantInput = z.infer<typeof actualizarModulosTenantSchema>;

// Para PUT /modulos/:modulo/global — mismo shape que un ítem de
// configuraciones, pero el módulo va en la URL, no en el body.
export const actualizarModuloGlobalSchema = z
  .object({
    estado: z.enum(["habilitado", "deshabilitado", "rollout"]),
    rolloutPorcentaje: z.number().int().min(0).max(100).nullable().optional(),
    version: z.string().trim().max(20).nullable().optional(),
  })
  .refine((c) => c.estado !== "rollout" || typeof c.rolloutPorcentaje === "number", {
    message: "rolloutPorcentaje es requerido cuando el estado es 'rollout'",
    path: ["rolloutPorcentaje"],
  });

export type ActualizarModuloGlobalInput = z.infer<typeof actualizarModuloGlobalSchema>;

/** Desde 0084 el correo es OPCIONAL y puede reemplazarse por un DNI: el
 *  grifero y los conductores de ruta no tienen correo corporativo, y exigirles
 *  uno significa inventarlo -- un correo inventado no recibe nada, así que la
 *  recuperación de contraseña no funcionaría, solo lo parecería.
 *
 *  Al menos uno de los dos tiene que venir: un usuario sin correo NI DNI no
 *  podría entrar nunca. El mismo CHECK existe a nivel de base. */
export const crearUsuarioEnTenantSchema = z
  .object({
    nombre: z.string().trim().min(1, "Nombre requerido").max(100),
    email: z.string().trim().toLowerCase().email("Correo inválido").max(150).optional(),
    // Sin formato fijo: el DNI peruano son 8 dígitos, pero un extranjero usa
    // carné de extranjería y un tercero puede tener pasaporte. Validar "8
    // dígitos" dejaría afuera gente que trabaja en la mina.
    dni: z.string().trim().min(6, "DNI demasiado corto").max(15).optional(),
    password: z.string().min(8, "La contraseña debe tener al menos 8 caracteres").max(200),
    rol: z.enum(["admin", "operador", "lectura"]).optional(),
  })
  .refine((v) => Boolean(v.email) || Boolean(v.dni), {
    message: "Indicá un correo o un DNI: sin ninguno de los dos no podría entrar",
    path: ["email"],
  });

export type CrearUsuarioEnTenantInput = z.infer<typeof crearUsuarioEnTenantSchema>;

export const cambiarEstadoUsuarioSchema = z.object({
  activo: z.boolean(),
  motivo: z.string().trim().max(500).optional(),
});

export type CambiarEstadoUsuarioInput = z.infer<typeof cambiarEstadoUsuarioSchema>;

// null = quitarle el dominio propio al tenant (vuelve a depender del
// subdominio de la plataforma o del campo manual).
export const actualizarDominioSchema = z.object({
  dominioPersonalizado: z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(255)
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, "Dominio inválido")
    .nullable(),
});

export type ActualizarDominioInput = z.infer<typeof actualizarDominioSchema>;

export const platformSesionSchema = z.object({
  token: z.string().min(1, "Token requerido"),
});

export type PlatformSesionInput = z.infer<typeof platformSesionSchema>;

export const platformAdminLoginSchema = z.object({
  email: z.string().trim().toLowerCase().email("Correo inválido").max(150),
  password: z.string().min(1, "Contraseña requerida").max(200),
});

export type PlatformAdminLoginInput = z.infer<typeof platformAdminLoginSchema>;

export const crearPlatformAdminSchema = z.object({
  email: z.string().trim().toLowerCase().email("Correo inválido").max(150),
  password: z.string().min(8, "La contraseña debe tener al menos 8 caracteres").max(200),
  nombre: z.string().trim().min(1, "Nombre requerido").max(100),
  rol: z.enum(["super_admin", "admin"]).default("admin"),
});

export type CrearPlatformAdminInput = z.infer<typeof crearPlatformAdminSchema>;

export const cambiarEstadoPlatformAdminSchema = z.object({
  activo: z.boolean(),
  motivo: z.string().trim().max(500).optional(),
});

export type CambiarEstadoPlatformAdminInput = z.infer<typeof cambiarEstadoPlatformAdminSchema>;

export const cambiarMiPasswordSchema = z.object({
  passwordActual: z.string().min(1, "Contraseña actual requerida").max(200),
  passwordNueva: z.string().min(8, "La contraseña debe tener al menos 8 caracteres").max(200),
});

export type CambiarMiPasswordInput = z.infer<typeof cambiarMiPasswordSchema>;

// confirmar: true es obligatorio a propósito (no un boolean cualquiera) —
// restaurar vacía primero los datos actuales del tenant destino, no hay
// vuelta atrás. Un body sin ese campo (ej. un cliente viejo, o un test
// que se olvidó) nunca pasa la validación por accidente.
export const restaurarBackupSchema = z.object({
  targetTenantId: z.string().uuid("targetTenantId debe ser un UUID válido"),
  confirmar: z.literal(true, { message: "Hay que mandar confirmar: true para restaurar" }),
});

export type RestaurarBackupInput = z.infer<typeof restaurarBackupSchema>;

// Restaurar un backup de plataforma es aditivo (nunca borra, ver
// restaurarBackupPlataformaService) — pero igual exige confirmar:true,
// mismo criterio que el restore de tenant: reinsertar tenants/admins que
// alguien borró a propósito tiene que ser una decisión explícita. No lleva
// targetTenantId porque no aplica a ningún tenant en particular.
export const restaurarBackupPlataformaSchema = z.object({
  confirmar: z.literal(true, { message: "Hay que mandar confirmar: true para restaurar" }),
});

export type RestaurarBackupPlataformaInput = z.infer<typeof restaurarBackupPlataformaSchema>;

// SSO por tenant (ver tenant_sso_config, migrations/0026). clientSecret es
// obligatorio en cada guardado a propósito — ver el comentario en
// configurarSsoTenantService (tenantSso.service.ts) sobre por qué no hay
// un flujo de "dejar en blanco para no cambiarlo".
export const configurarSsoTenantSchema = z.object({
  issuerUrl: z.string().trim().url("issuerUrl debe ser una URL válida").max(500),
  clientId: z.string().trim().min(1, "clientId requerido").max(300),
  clientSecret: z.string().trim().min(1, "clientSecret requerido").max(2000),
  dominioEmailPermitido: z.string().trim().toLowerCase().max(255).nullable().optional(),
  activo: z.boolean(),
});

export type ConfigurarSsoTenantInput = z.infer<typeof configurarSsoTenantSchema>;

// Cuotas por tenant (ver tenant_cuotas, migración 0033). Los tres estados
// posibles se expresan así en el body:
//   { limite: 500 }   → ese tenant tiene 500
//   { limite: null }  → ese tenant es ILIMITADO (override explícito)
//   omitir `limite`   → borra el override y vuelve al default del código
// Por eso `limite` es .optional().nullable() y no un simple number: los tres
// casos tienen que poder distinguirse, y "sin límite" no es lo mismo que
// "sin override".
export const fijarCuotaTenantSchema = z.object({
  recurso: z.string().trim().min(1, "Recurso requerido").max(60),
  limite: z.number().int().min(0).nullable().optional(),
  motivo: z.string().trim().max(500).optional(),
});

export type FijarCuotaTenantInput = z.infer<typeof fijarCuotaTenantSchema>;

// Asignar plan a un tenant (ver planes, migración 0034). Acepta el `codigo`
// del plan ("mype", "pequena", ...) o su UUID; `null` desasigna y devuelve
// al tenant a los defaults del registry.
export const asignarPlanTenantSchema = z.object({
  plan: z.string().trim().min(1).max(80).nullable(),
  motivo: z.string().trim().max(500).optional(),
});

export type AsignarPlanTenantInput = z.infer<typeof asignarPlanTenantSchema>;

// ── Billing / suscripciones (migración 0041) ────────────────────────────

export const crearSuscripcionSchema = z.object({
  plan: z.string().trim().min(1, "Plan requerido").max(80),
  ciclo: z.enum(["mensual", "anual"]),
  metodoFacturacion: z.enum(["tarjeta", "transferencia"]),
  // Ausente = usa el precio de lista del plan (planes.precio_*_referencia).
  precioReferencia: z.number().min(0).optional(),
  // No es un trial de producto (nadie se autosuscribe al ERP) -- es una
  // exoneración comercial negociada caso por caso con un cliente que YA
  // contrató (ej. cobró la implementación aparte y exoneró la suscripción
  // mensual por un tiempo). En MESES (no días): así es como se negocia
  // ("le exonero 6 meses"), y evita el redondeo de aproximar un mes a 30
  // días -- make_interval(months => N) calcula el calendario real.
  trialMeses: z.number().int().min(0).max(12).optional(),
  // Tasa pactada fija para este cliente -- excepción, no la norma. Ausente
  // = usa el TC global de plataforma. El service rechaza esto si
  // metodoFacturacion no es 'tarjeta'.
  tipoCambioOverride: z.number().positive().optional(),
});

export type CrearSuscripcionInput = z.infer<typeof crearSuscripcionSchema>;

export const cambiarPlanSuscripcionSchema = z.object({
  plan: z.string().trim().min(1, "Plan requerido").max(80),
  precioReferencia: z.number().min(0).optional(),
  motivo: z.string().trim().max(500).optional(),
});

export type CambiarPlanSuscripcionInput = z.infer<typeof cambiarPlanSuscripcionSchema>;

export const extenderGraciaSchema = z.object({
  dias: z.number().int().min(1).max(90),
  motivo: z.string().trim().max(500).optional(),
});

export type ExtenderGraciaInput = z.infer<typeof extenderGraciaSchema>;

export const motivoOpcionalSchema = z.object({
  motivo: z.string().trim().max(500).optional(),
});

// Cobro único de implementación, independiente de la suscripción -- ver
// registrarCobroImplementacionService. estado ausente = 'exitoso' (ya se
// cobró); 'pendiente' es para cuotas pactadas todavía no cobradas (ej. el
// saldo que se abona cuando el tenant arranca en producción).
export const registrarCobroImplementacionSchema = z.object({
  monto: z.number().positive(),
  moneda: z.enum(["USD", "PEN"]),
  descripcion: z.string().trim().max(200).optional(),
  estado: z.enum(["pendiente", "exitoso"]).optional(),
  // Cuándo pasó el pago (YYYY-MM-DD) -- default hoy si no se manda.
  fecha: z.string().trim().min(1).optional(),
  // Obligatorio si moneda='PEN', rechazado si 'USD' (el servicio lo valida).
  tipoCambioAplicado: z.number().positive().optional(),
});

export type RegistrarCobroImplementacionInput = z.infer<typeof registrarCobroImplementacionSchema>;

export type MotivoOpcionalInput = z.infer<typeof motivoOpcionalSchema>;

// Recalcula el arranque de la cortesía desde hoy -- ver iniciarCortesiaService.
export const iniciarCortesiaSchema = z.object({
  trialMeses: z.number().int().min(1).max(12),
});

export type IniciarCortesiaInput = z.infer<typeof iniciarCortesiaSchema>;

// Editar un cobro ya cargado -- ver editarCobroService (monto/moneda solo
// se aceptan si el cobro sigue 'pendiente', el servicio lo valida).
export const editarCobroSchema = z.object({
  monto: z.number().positive().optional(),
  moneda: z.enum(["USD", "PEN"]).optional(),
  descripcion: z.string().trim().max(200).optional(),
  fecha: z.string().trim().min(1).optional(),
  tipoCambioAplicado: z.number().positive().nullable().optional(),
});

export type EditarCobroInput = z.infer<typeof editarCobroSchema>;

// Pago parcial o total sobre un cobro 'pendiente' -- ver
// registrarPagoCobroService (el servicio valida que no supere el saldo).
export const registrarPagoCobroSchema = z.object({
  montoPagado: z.number().positive(),
  // Cuándo pasó ESTE pago -- default hoy si no se manda.
  fecha: z.string().trim().min(1).optional(),
});

export type RegistrarPagoCobroInput = z.infer<typeof registrarPagoCobroSchema>;

// Tipo de cambio USD -> PEN, global de plataforma (migración 0053) -- ver
// platformTipoCambio.service.ts.
export const actualizarTipoCambioSchema = z.object({
  valor: z.number().positive(),
});

export type ActualizarTipoCambioInput = z.infer<typeof actualizarTipoCambioSchema>;

// Override de tipo de cambio de UNA suscripción puntual -- `valor: null`
// lo quita y vuelve a usar el TC global. Se distingue de "ausente" (que
// también valdría "no cambiar nada") exigiendo la clave siempre presente,
// para que el frontend tenga que decidir explícitamente entre un número o
// null en vez de poder omitir el campo por error.
export const actualizarTipoCambioOverrideSchema = z.object({
  valor: z.number().positive().nullable(),
});

export type ActualizarTipoCambioOverrideInput = z.infer<typeof actualizarTipoCambioOverrideSchema>;
