import type { Logger } from "pino";
import type { UsuarioPayload } from "../../services/auth.service";

declare module "express-serve-static-core" {
  interface Request {
    id?: string;
    validatedBody?: unknown;
    validatedQuery?: unknown;
    log?: Logger;
    usuario?: UsuarioPayload;
    tenantId?: string;
  }
}

export {};
