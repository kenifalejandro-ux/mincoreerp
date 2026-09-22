import type { Logger } from "pino";
import type { UsuarioPayload } from "../../services/auth.service";
import type { AlcanceCombustible } from "../../../modules/combustible/alcance";

declare module "express-serve-static-core" {
  interface Request {
    id?: string;
    validatedBody?: unknown;
    validatedQuery?: unknown;
    log?: Logger;
    usuario?: UsuarioPayload;
    tenantId?: string;
    /** Qué sedes, grifos y surtidores ve en Combustible (0100). */
    alcanceCombustible?: AlcanceCombustible;
  }
}

export {};
