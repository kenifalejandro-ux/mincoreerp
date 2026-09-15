/** src/server/routes/administracion.ts
 *
 * El menú **Administración** de cada empresa, tal como Kenif lo pidió sobre
 * el telebanking de su banco:
 *
 *   Administración de usuarios  ->  /api/erp/usuarios      (usuariosTenant.ts)
 *   Configuración (autonomías)  ->  /api/erp/usuarios/:id/permisos
 *   Log de eventos              ->  acá
 *   Órdenes                     ->  acá (entrega 5)
 *
 * Todo exige rol admin. Es el menú que decide quién entra al sistema y con
 * qué: ni `operador` ni `lectura` lo ven siquiera en el sidebar.
 */
import { Router } from "express";
import { z } from "zod";

import { validate } from "../middleware/validate";
import { requireRole } from "../shared/middlewares/roles.middleware";
import { asyncHandler } from "../shared/utils/asyncHandler";
import { contextoAuditoriaModulo } from "../shared/utils/moduleAudit";
import { getTenantId } from "../shared/utils/request";
import {
  listarBitacoraTenantService,
  accionesDeBitacoraService,
} from "../services/bitacoraTenant.service";
import {
  aprobarOrdenService,
  estadoDobleFirmaService,
  listarOrdenesService,
  rechazarOrdenService,
  solicitarOrdenService,
  type EstadoDeOrden,
} from "../services/ordenesAdmin.service";

/** Firmar sin decir por qué no es firmar: la orden queda con las dos razones,
 *  la de quien la pidió y la de quien la resolvió. Al aprobar es opcional
 *  (el motivo de la orden ya está); al rechazar es obligatorio, porque quien
 *  la pidió necesita saber qué corregir. */
const aprobarSchema = z.object({
  motivo: z.string().trim().max(500).optional(),
});

const rechazarSchema = z.object({
  motivo: z.string().trim().min(1, "Decile por qué la rechazás").max(500),
});

const dobleFirmaSchema = z.object({
  dobleFirma: z.boolean(),
  motivo: z.string().trim().min(1, "Indicá el motivo").max(500),
});

export function createAdministracionRouter() {
  const router = Router();

  router.use(requireRole("admin"));

  // ── Log de eventos ───────────────────────────────────────────────────

  router.get(
    "/eventos",
    asyncHandler(async (req, res) => {
      res.json(
        await listarBitacoraTenantService(getTenantId(req), {
          desde: req.query.desde as string | undefined,
          hasta: req.query.hasta as string | undefined,
          accion: req.query.accion as string | undefined,
          usuarioId: req.query.usuarioId as string | undefined,
          antesDe: req.query.antesDe as string | undefined,
          // Un tope duro además del que manda la pantalla: sin él, un
          // `?limite=999999` se trae media tabla en una sola consulta.
          limite: Math.min(Number(req.query.limite) || 100, 500),
        })
      );
    })
  );

  router.get(
    "/eventos/acciones",
    asyncHandler(async (req, res) => {
      res.json({ acciones: await accionesDeBitacoraService(getTenantId(req)) });
    })
  );

  // ── Órdenes administrativas ──────────────────────────────────────────

  router.get(
    "/ordenes",
    asyncHandler(async (req, res) => {
      res.json({
        ordenes: await listarOrdenesService(getTenantId(req), {
          estado: req.query.estado as EstadoDeOrden | undefined,
          limite: Number(req.query.limite) || undefined,
        }),
      });
    })
  );

  router.post(
    "/ordenes/:id/aprobar",
    validate(aprobarSchema),
    asyncHandler(async (req, res) => {
      const { motivo } = req.validatedBody as { motivo?: string };
      const { orden, resultado } = await aprobarOrdenService(
        getTenantId(req),
        { id: req.usuario!.id, nombre: req.usuario!.nombre },
        req.params.id,
        motivo,
        contextoAuditoriaModulo(req)
      );
      res.json({ orden, resultado });
    })
  );

  router.post(
    "/ordenes/:id/rechazar",
    validate(rechazarSchema),
    asyncHandler(async (req, res) => {
      const { motivo } = req.validatedBody as { motivo: string };
      res.json({
        orden: await rechazarOrdenService(
          getTenantId(req),
          { id: req.usuario!.id, nombre: req.usuario!.nombre },
          req.params.id,
          motivo,
          contextoAuditoriaModulo(req)
        ),
      });
    })
  );

  // ── Doble firma ──────────────────────────────────────────────────────

  router.get(
    "/doble-firma",
    asyncHandler(async (req, res) => {
      res.json(await estadoDobleFirmaService(getTenantId(req)));
    })
  );

  // Encenderla es endurecer: una firma. Apagarla necesita dos, y lo decide
  // firmasRequeridas() -- acá no se replica esa regla.
  router.put(
    "/doble-firma",
    validate(dobleFirmaSchema),
    asyncHandler(async (req, res) => {
      const { dobleFirma, motivo } = req.validatedBody as {
        dobleFirma: boolean;
        motivo: string;
      };

      const { orden } = await solicitarOrdenService(
        getTenantId(req),
        { id: req.usuario!.id, nombre: req.usuario!.nombre },
        { tipo: "cambiar_doble_firma", payload: { dobleFirma }, motivo },
        contextoAuditoriaModulo(req)
      );

      if (orden.estado === "pendiente") {
        return res.status(202).json({
          orden,
          message: `Queda pendiente de la firma de otro administrador (${orden.correlativo})`,
        });
      }
      res.json({ orden, ...(await estadoDobleFirmaService(getTenantId(req))) });
    })
  );

  return router;
}
