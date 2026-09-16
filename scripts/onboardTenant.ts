/** scripts/onboardTenant.ts
 *
 * CLI de aprovisionamiento de un tenant nuevo — mismo servicio que usa
 * POST /api/platform/tenants/onboard (tenantOnboardingService.ts), sin
 * pasar por HTTP: útil para levantar un cliente nuevo desde una terminal
 * con acceso directo a la base (deploy inicial, soporte), sin necesitar el
 * token de super-admin de plataforma.
 *
 * Uso:
 *   npm run tenant:create -- --tenantNombre="Minera Cushuro" --tenantSlug=cushuro \
 *     --adminNombre="Admin Cushuro" --adminEmail=admin@cushuro.com --adminPassword=... \
 *     [--planCodigo=mediana] [--sinCambioObligatorio]
 *
 * (El "--" después de "tenant:create" es necesario: sin él, npm se queda
 * con los flags para sí mismo en vez de pasárselos al script.)
 *
 * --sinCambioObligatorio: por default, el admin creado acá arranca con
 * debe_cambiar_password=true igual que cualquier alta de usuario (ver
 * crearUsuarioService) -- correcto para un onboarding real, donde la
 * contraseña que se pasa acá es tan "temporal" como cualquier otra que un
 * admin le ponga a alguien. Este flag es la salida para cuentas
 * descartables que nunca la van a cambiar (el tenant de prueba que arma
 * CI para los e2e de Playwright, que esperan llegar al dashboard directo
 * después del login).
 */
import { closeDatabase, pool, withTenant } from "../src/server/config/database";
import { onboardTenantService } from "../src/server/services/tenantOnboardingService";
import type { OnboardTenantInput } from "../src/server/schemas/platform.schema";

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...resto] = arg.replace(/^--/, "").split("=");
    return [key, resto.join("=")];
  })
);

const CAMPOS_REQUERIDOS = [
  "tenantNombre",
  "tenantSlug",
  "adminNombre",
  "adminEmail",
  "adminPassword",
] as const;

function leerInput(): OnboardTenantInput {
  const faltantes = CAMPOS_REQUERIDOS.filter((campo) => !args.get(campo));
  if (faltantes.length > 0) {
    console.error(`Faltan argumentos requeridos: ${faltantes.join(", ")}`);
    console.error(
      "Uso: npm run tenant:create -- --tenantNombre=... --tenantSlug=... --adminNombre=... --adminEmail=... --adminPassword=... [--planCodigo=...]"
    );
    process.exit(1);
  }

  return {
    tenantNombre: args.get("tenantNombre")!,
    tenantSlug: args.get("tenantSlug")!,
    adminNombre: args.get("adminNombre")!,
    adminEmail: args.get("adminEmail")!,
    adminPassword: args.get("adminPassword")!,
    planCodigo: args.get("planCodigo"),
  };
}

async function main() {
  const input = leerInput();

  const resultado = await onboardTenantService(input, {
    ip: "127.0.0.1",
    actorType: "system",
    actorLabel: "cli:tenant:create",
  });

  if (args.has("sinCambioObligatorio")) {
    // Las DOS filas. Desde la migración 0087 la sesión de quien entra con
    // correo lee esta bandera de su CUENTA, no de su perfil: apagarla solo en
    // `usuarios` deja al admin sembrado en la pantalla de "Poné tu propia
    // contraseña", que es exactamente lo que este flag existe para evitar.
    // El perfil se apaga igual, por si alguna vez se siembra alguien sin
    // correo (personal de cancha por DNI), que no tiene cuenta.
    await withTenant(resultado.tenant.id, (client) =>
      client.query(`UPDATE usuarios SET debe_cambiar_password = false WHERE id = $1`, [
        resultado.usuario.id,
      ])
    );
    await pool.query(
      `UPDATE cuentas SET debe_cambiar_password = false, actualizado_en = now()
        WHERE email = $1`,
      [input.adminEmail.trim().toLowerCase()]
    );
  }

  console.log("Tenant aprovisionado correctamente:");
  console.log(JSON.stringify(resultado, null, 2));
}

main()
  .then(() => closeDatabase())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error("Error al aprovisionar el tenant:", err instanceof Error ? err.message : err);
    await closeDatabase().catch(() => {});
    process.exit(1);
  });
