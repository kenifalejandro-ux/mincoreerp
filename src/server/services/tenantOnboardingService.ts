/** src/server/services/tenantOnboardingService.ts
 *
 * Aprovisionamiento de un tenant nuevo en un solo paso — ver
 * docs/architecture/onboarding-automatizado.md. Orquesta piezas que ya
 * existían por separado, no las reimplementa:
 *
 *   - Tenant + módulos habilitados + admin inicial (hash seguro de
 *     contraseña, vía bcrypt en auth.service.ts): crearTenantConAdminService,
 *     que YA hace esto en una sola transacción con idempotencia + auditoría
 *     (era lo que ya usaba POST /api/platform/tenants, y lo que usa
 *     tests/helpers.ts para armar tenants de prueba).
 *   - Validación de que el plan exista y esté activo: obtenerPlanService
 *     (platformPlanes.service.ts) — la misma validación que ya hacía
 *     asignarPlanATenantService.
 *
 * La asignación de plan en sí NO se delega a asignarPlanATenantService: esa
 * función corre contra `pool` directo (su propia transacción implícita), y
 * comprometerse a que el plan quede asignado ATÓMICAMENTE con la creación
 * del tenant (que un tenant "a medio crear" nunca sea un estado posible)
 * significa que el UPDATE tiene que correr en el mismo client/transacción
 * que el INSERT del tenant — por eso crearTenantConAdminService acepta un
 * `planId` ya resuelto y lo aplica ella misma, adentro de su propia
 * transacción, en vez de que este archivo llame a dos funciones separadas
 * una atrás de la otra.
 *
 * ── Qué NO hace, a propósito ─────────────────────────────────────────────
 * El pedido original de onboarding automatizado incluía dos pasos más que
 * no tienen equivalente real en este sistema (evaluado antes de escribir
 * código, no asumido):
 *
 *   - "Aprovisionar particiones iniciales": el particionado de
 *     checklists/ipercs (migración 0037) es por MES, no por tenant — todos
 *     los tenants comparten las mismas particiones mensuales, ya
 *     garantizadas por particionado.worker.ts. No hay nada que crear por
 *     tenant acá.
 *   - "Sembrar datos maestras (roles, permisos, catálogos base)": los
 *     roles son un enum fijo (admin/operador/lectura), y ningún módulo
 *     tiene un concepto de "catálogo base" por tenant — cada cliente arma
 *     su propio catálogo de equipos/plantillas/línea base desde cero, a
 *     propósito (son mineras distintas, con equipos y procesos distintos).
 *     Sembrar datos de ejemplo acá sería inventar un requisito que ningún
 *     módulo pide.
 */
import { AppError } from "../shared/middlewares/error.middleware";
import {
  crearTenantConAdminService,
  type TenantCreado,
  type ContextoAuditoria,
} from "./platform.service";
import { obtenerPlanService } from "./platformPlanes.service";
import type { OnboardTenantInput } from "../schemas/platform.schema";
import type { UsuarioPublico } from "./auth.service";

export interface TenantOnboardResultado {
  tenant: TenantCreado & { planCodigo: string | null };
  usuario: UsuarioPublico;
}

export async function onboardTenantService(
  input: OnboardTenantInput,
  contexto: ContextoAuditoria,
  idempotencyKey?: string
): Promise<TenantOnboardResultado> {
  let planId: string | undefined;
  let planCodigo: string | null = null;

  if (input.planCodigo) {
    const plan = await obtenerPlanService(input.planCodigo);
    if (!plan.activo) {
      throw new AppError(400, `El plan "${plan.codigo}" está desactivado y no puede asignarse`);
    }
    planId = plan.id;
    planCodigo = plan.codigo;
  }

  const { tenantNombre, tenantSlug, adminNombre, adminEmail, adminPassword } = input;
  const { tenant, usuario } = await crearTenantConAdminService(
    { tenantNombre, tenantSlug, adminNombre, adminEmail, adminPassword },
    contexto,
    idempotencyKey,
    planId
  );

  return { tenant: { ...tenant, planCodigo }, usuario };
}
