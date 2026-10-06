/** tests/permisos-por-perfil.test.ts
 *
 * Las **autonomías** (entrega 3, migración 0089): un perfil = tipo de usuario
 * + qué módulos ve + con qué nivel. Diseño: docs/architecture/
 * cuentas-perfiles-y-administracion.md §10.
 *
 * Lo que se fija acá:
 *
 * 1. Que "consultas" signifique de verdad no poder escribir, en TODOS los
 *    módulos y sin que nadie tenga que acordarse de proteger un endpoint
 *    nuevo.
 * 2. Que un administrador no pueda darle a nadie --ni a sí mismo-- un módulo
 *    que su empresa no contrató, ni editar sus propios permisos.
 * 3. Que quitar acceso sea INMEDIATO (se cierran las sesiones) y darlo no
 *    necesite echar a nadie.
 * 4. Que dar de alta a alguien con correo no le ponga una clave: la define
 *    ella desde la invitación.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { pool, withTenant, closeDatabase } from "../src/server/config/database";
import { env } from "../src/server/config/env";

const PASSWORD = "ClaveDePrueba123";

describe("permisos por perfil (autonomías)", () => {
  let empresa: Awaited<ReturnType<typeof crearTenantDePrueba>>;
  let admin: ReturnType<typeof request.agent>;
  let plataforma: ReturnType<typeof request.agent>;
  /** Una persona de oficina a la que se le mueven los permisos. */
  let operadorId: string;
  const emailOperador = () => `operador-${empresa.tenant.slug}@test.local`;

  const sesionDe = async (email: string, password: string) => {
    const agente = request.agent(app);
    const res = await agente
      .post("/api/auth/login")
      .send({ tenantSlug: empresa.tenant.slug, email, password });
    expect(res.status).toBe(200);
    return agente;
  };

  const permisos = async (usuarioId: string) => {
    const res = await admin.get(`/api/erp/usuarios/${usuarioId}/permisos`);
    expect(res.status).toBe(200);
    return res.body as {
      rol: string;
      modulos: { modulo: string; asignado: boolean; nivel: string }[];
    };
  };

  /** Deja los módulos como están salvo el que se indica. */
  const ponerNivel = async (
    usuarioId: string,
    modulo: string,
    cambio: { asignado: boolean; nivel?: "operar" | "consultas" }
  ) => {
    const actuales = await permisos(usuarioId);
    return admin.put(`/api/erp/usuarios/${usuarioId}/permisos`).send({
      modulos: actuales.modulos.map((m) =>
        m.modulo === modulo
          ? { modulo, asignado: cambio.asignado, nivel: cambio.nivel ?? m.nivel }
          : { modulo: m.modulo, asignado: m.asignado, nivel: m.nivel }
      ),
      motivo: "prueba automatizada",
    });
  };

  beforeAll(async () => {
    empresa = await crearTenantDePrueba(PASSWORD);
    admin = await sesionDe(empresa.usuario.email, PASSWORD);
    plataforma = request.agent(app);

    const alta = await admin.post("/api/erp/usuarios").send({
      nombre: "Operador de prueba",
      email: emailOperador(),
      password: PASSWORD,
      rol: "operador",
    });
    expect(alta.status).toBe(201);
    operadorId = alta.body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(empresa.tenant.id);
    await closeDatabase();
  });

  // ── 1. Qué significa cada nivel ───────────────────────────────────────

  it("por defecto un módulo asignado es para operar", async () => {
    const actuales = await permisos(operadorId);
    const combustible = actuales.modulos.find((m) => m.modulo === "combustible");

    expect(combustible).toBeDefined();
    expect(combustible!.asignado).toBe(true);
    expect(combustible!.nivel).toBe("operar");
  });

  it("con nivel 'consultas' puede ver pero no escribir", async () => {
    const cambio = await ponerNivel(operadorId, "combustible", {
      asignado: true,
      nivel: "consultas",
    });
    expect(cambio.status).toBe(200);

    // Sesión nueva: el nivel viaja en el token, así que hay que tomar uno.
    const operador = await sesionDe(emailOperador(), PASSWORD);

    const consulta = await operador.get("/api/erp/combustible");
    expect(consulta.status).toBe(200);

    const escritura = await operador.post("/api/erp/combustible").send({
      nombre: "Tanque que no debería crearse",
      capacidad_litros: 1000,
    });
    expect(escritura.status).toBe(403);
    expect(escritura.body.message).toMatch(/consultar/i);
  });

  it("sin acceso no ve el módulo en absoluto", async () => {
    const cambio = await ponerNivel(operadorId, "combustible", { asignado: false });
    expect(cambio.status).toBe(200);

    const operador = await sesionDe(emailOperador(), PASSWORD);
    const consulta = await operador.get("/api/erp/combustible");

    expect(consulta.status).toBe(403);
    // "No disponible", no "solo podés consultar": el segundo mensaje ya
    // admitiría que el módulo existe y que alguien más lo usa.
    expect(consulta.body.message).toMatch(/no disponible/i);
  });

  it("volver a darle el módulo lo deja operar de nuevo", async () => {
    const cambio = await ponerNivel(operadorId, "combustible", {
      asignado: true,
      nivel: "operar",
    });
    expect(cambio.status).toBe(200);

    const operador = await sesionDe(emailOperador(), PASSWORD);
    expect((await operador.get("/api/erp/combustible")).status).toBe(200);
  });

  it("el admin puede habilitar una pestaña por usuario y revocarla inmediatamente", async () => {
    const antes = await permisos(operadorId);
    const pestanas = (
      antes as typeof antes & {
        pestanas: {
          modulo: string;
          pestana: string;
          permitido: boolean;
          predeterminado: boolean;
        }[];
      }
    ).pestanas;
    // "historico" ya es default para Operador (combustible-alcance.test.ts
    // depende de que pueda consultar consumo-por-vehículo sin overrides);
    // lo que demuestra este test es habilitar Facturación, que sí es
    // admin-only por defecto.
    expect(pestanas.find((p) => p.pestana === "historico")?.predeterminado).toBe(true);
    expect(pestanas.find((p) => p.modulo === "facturacion")?.predeterminado).toBe(false);
    expect(
      (await (await sesionDe(emailOperador(), PASSWORD)).get("/api/facturacion/comprobantes"))
        .status
    ).toBe(403);

    const cambio = await admin.put(`/api/erp/usuarios/${operadorId}/permisos`).send({
      modulos: antes.modulos.map((m) => ({
        modulo: m.modulo,
        asignado: m.asignado,
        nivel: m.nivel,
      })),
      pestanas: pestanas.map((p) => ({
        modulo: p.modulo,
        pestana: p.pestana,
        permitido: p.pestana === "historico" || p.modulo === "facturacion" ? true : p.permitido,
      })),
      motivo: "Habilitar histórico para revisión",
    });
    expect(cambio.status).toBe(200);

    const operadorConHistorico = await sesionDe(emailOperador(), PASSWORD);
    expect(
      (await operadorConHistorico.get("/api/erp/combustible/consumo-por-conductor")).status
    ).toBe(200);
    expect((await operadorConHistorico.get("/api/facturacion/comprobantes")).status).toBe(200);

    const actualizado = (await permisos(operadorId)) as typeof antes & {
      pestanas: { modulo: string; pestana: string; permitido: boolean }[];
    };
    const quitar = await admin.put(`/api/erp/usuarios/${operadorId}/permisos`).send({
      modulos: actualizado.modulos.map((m) => ({
        modulo: m.modulo,
        asignado: m.asignado,
        nivel: m.nivel,
      })),
      pestanas: actualizado.pestanas.map((p) => ({
        modulo: p.modulo,
        pestana: p.pestana,
        permitido: p.pestana === "historico" || p.modulo === "facturacion" ? false : p.permitido,
      })),
      motivo: "Retirar histórico",
    });
    expect(quitar.status).toBe(200);
    expect(quitar.body.recorta).toBe(true);
    expect((await operadorConHistorico.get("/api/auth/me")).status).toBe(401);

    const operadorSinHistorico = await sesionDe(emailOperador(), PASSWORD);
    expect(
      (await operadorSinHistorico.get("/api/erp/combustible/consumo-por-conductor")).status
    ).toBe(403);
    expect((await operadorSinHistorico.get("/api/facturacion/comprobantes")).status).toBe(403);
  });

  // ── 2. Lo que un administrador NO puede hacer ─────────────────────────

  it("no puede asignar un módulo que la empresa no contrató", async () => {
    await withTenant(empresa.tenant.id, (client) =>
      client.query(
        `UPDATE tenant_modulos SET estado = 'deshabilitado' WHERE tenant_id = $1 AND modulo = 'documentos'`,
        [empresa.tenant.id]
      )
    );

    try {
      // Ni siquiera aparece en la lista de lo que se puede repartir.
      const lista = await permisos(operadorId);
      expect(lista.modulos.some((m) => m.modulo === "documentos")).toBe(false);

      // El alta le había asignado todos los módulos del tenant; se saca la
      // fila para que lo que se mide sea si el PUT la vuelve a crear.
      await withTenant(empresa.tenant.id, (client) =>
        client.query(
          `DELETE FROM usuario_modulos WHERE usuario_id = $1 AND modulo = 'documentos'`,
          [operadorId]
        )
      );

      // Mandarlo a mano no lo asigna.
      const res = await admin.put(`/api/erp/usuarios/${operadorId}/permisos`).send({
        modulos: [{ modulo: "documentos", asignado: true, nivel: "operar" }],
      });
      expect(res.status).toBe(200);

      const despues = await withTenant(empresa.tenant.id, (client) =>
        client.query(
          `SELECT 1 FROM usuario_modulos WHERE usuario_id = $1 AND modulo = 'documentos'`,
          [operadorId]
        )
      );
      expect(despues.rowCount).toBe(0);
    } finally {
      await withTenant(empresa.tenant.id, (client) =>
        client.query(
          `UPDATE tenant_modulos SET estado = 'habilitado' WHERE tenant_id = $1 AND modulo = 'documentos'`,
          [empresa.tenant.id]
        )
      );
    }
  });

  it("no puede cambiarse los permisos a sí mismo", async () => {
    const res = await admin.put(`/api/erp/usuarios/${empresa.usuario.id}/permisos`).send({
      modulos: [],
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/otro administrador/i);
  });

  it("quien no es admin no puede tocar permisos de nadie", async () => {
    const operador = await sesionDe(emailOperador(), PASSWORD);

    expect((await operador.get(`/api/erp/usuarios/${operadorId}/permisos`)).status).toBe(403);
    expect(
      (await operador.put(`/api/erp/usuarios/${operadorId}/permisos`).send({ modulos: [] })).status
    ).toBe(403);
  });

  // ── 3. Quitar es inmediato; dar puede esperar ─────────────────────────

  it("quitar acceso cierra las sesiones abiertas de esa persona", async () => {
    const operador = await sesionDe(emailOperador(), PASSWORD);
    expect((await operador.get("/api/auth/me")).status).toBe(200);

    const cambio = await ponerNivel(operadorId, "equipos", { asignado: false });
    expect(cambio.body.recorta).toBe(true);

    // Sin esto, alguien a quien le acaban de quitar el acceso lo conserva
    // hasta que su token se renueve solo.
    expect((await operador.get("/api/auth/me")).status).toBe(401);
  });

  it("darle un módulo más no lo echa de su sesión", async () => {
    const operador = await sesionDe(emailOperador(), PASSWORD);

    const cambio = await ponerNivel(operadorId, "equipos", { asignado: true, nivel: "operar" });
    expect(cambio.body.recorta).toBe(false);

    expect((await operador.get("/api/auth/me")).status).toBe(200);
  });

  it("el cambio queda en la bitácora con el antes y el después", async () => {
    await ponerNivel(operadorId, "repuestos", { asignado: true, nivel: "consultas" });

    const fila = await pool.query(
      `SELECT detalle FROM platform_audit_log
        WHERE accion = 'cambiar_permisos_usuario' AND tenant_id = $1
        ORDER BY creado_en DESC LIMIT 1`,
      [empresa.tenant.id]
    );

    const detalle = fila.rows[0].detalle;
    expect(
      detalle.antes.modulos.find((m: { modulo: string }) => m.modulo === "repuestos").nivel
    ).toBe("operar");
    expect(
      detalle.despues.modulos.find((m: { modulo: string }) => m.modulo === "repuestos").nivel
    ).toBe("consultas");
    expect(detalle.motivo).toBe("prueba automatizada");
  });

  // ── 4. Alta por invitación ────────────────────────────────────────────

  describe("alta de alguien con correo", () => {
    const emailNuevo = () => `invitado-${empresa.tenant.slug}@test.local`;

    it("no le pone clave: le manda una invitación", async () => {
      const alta = await admin.post("/api/erp/usuarios").send({
        nombre: "Persona invitada",
        email: emailNuevo(),
        rol: "operador",
      });

      expect(alta.status).toBe(201);
      expect(alta.body.modo).toBe("invitacion-enviada");

      // La cuenta existe pero todavía no tiene clave, así que no puede entrar.
      const cuenta = (
        await pool.query(`SELECT id, password_hash FROM cuentas WHERE email = $1`, [emailNuevo()])
      ).rows[0];
      expect(cuenta).toBeDefined();
      expect(cuenta.password_hash).toBeNull();

      const intento = await request(app).post("/api/auth/login").send({
        tenantSlug: empresa.tenant.slug,
        email: emailNuevo(),
        password: "LoQueSea12345",
      });
      expect(intento.status).toBe(401);

      // Y hay un enlace esperándola, que es lo que le deja definir la suya.
      const invitacion = await pool.query(
        `SELECT expira_en FROM reset_tokens WHERE cuenta_id = $1 AND usado_en IS NULL`,
        [cuenta.id]
      );
      expect(invitacion.rowCount).toBe(1);
      // Una semana, no una hora: la pide un admin, no la persona.
      const horas =
        (new Date(invitacion.rows[0].expira_en).getTime() - Date.now()) / (60 * 60 * 1000);
      expect(horas).toBeGreaterThan(24);
    });

    it("sin correo (personal de cancha) sigue siendo clave para dictar", async () => {
      const alta = await admin.post("/api/erp/usuarios").send({
        nombre: "Grifero de cancha",
        dni: "11223344",
        password: "ClaveDeCancha123",
        rol: "grifero",
      });

      expect(alta.status).toBe(201);
      expect(alta.body.modo).toBe("clave-temporal");
    });

    it("sin correo y sin clave, el alta se rechaza", async () => {
      const alta = await admin.post("/api/erp/usuarios").send({
        nombre: "Nadie",
        dni: "99887766",
        rol: "grifero",
      });

      expect(alta.status).toBe(400);
    });
  });

  // ── 4. Cada perfil nace con lo suyo ───────────────────────────────────
  //
  // Matriz robusta de perfiles (profile_user.xlsx). Lo de acá es el DEFAULT:
  // el punto de partida que le ahorra la configuración inicial a la empresa,
  // no el límite -- el admin del tenant lo cambia después.
  describe("predeterminados del perfil", () => {
    // Nunca `admin.put(...).send({ x: await permisosDe(...) })`: supertest
    // levanta el server efímero al construir el PUT, el GET anidado del mismo
    // agent se mete en el medio y en CI el PUT sale contra un server ya
    // cerrado (ECONNREFUSED). Leer primero, armar el request después.
    const permisosDe = async (usuarioId: string) =>
      (await permisos(usuarioId)) as Awaited<ReturnType<typeof permisos>> & {
        pestanas: { modulo: string; pestana: string; permitido: boolean }[];
      };
    const alta = async (rol: string, nombre: string) => {
      const res = await admin.post("/api/erp/usuarios").send({
        nombre,
        email: `${idUnico(rol)}@test.local`,
        password: PASSWORD,
        rol,
      });
      expect(res.status).toBe(201);
      return res.body.id as string;
    };
    const nivelDe = (
      p: { modulos: { modulo: string; asignado: boolean; nivel: string }[] },
      m: string
    ) => {
      const fila = p.modulos.find((x) => x.modulo === m);
      return !fila || !fila.asignado ? "sin-acceso" : fila.nivel;
    };

    it("Lectura entra a todo en consultas; los perfiles de cancha solo a Combustible", async () => {
      const lecturaId = await alta("lectura", "Perfil de consulta");
      const lectura = await permisosDe(lecturaId);
      expect(nivelDe(lectura, "combustible")).toBe("consultas");
      expect(nivelDe(lectura, "equipos")).toBe("consultas");

      const griferoId = await alta("grifero", "Perfil de cancha");
      const grifero = await permisosDe(griferoId);
      expect(nivelDe(grifero, "combustible")).toBe("operar");
      expect(nivelDe(grifero, "equipos")).toBe("sin-acceso");
    });

    it("las vistas del Histórico nacen apagadas para los perfiles de cancha", async () => {
      const conductorId = await alta("conductor_ruta", "Conductor de ruta");
      const conductor = await permisosDe(conductorId);
      const vistas = conductor.pestanas.filter((p) => p.pestana.startsWith("historico:"));
      expect(vistas).toHaveLength(7);
      expect(vistas.every((v) => !v.permitido)).toBe(true);

      const lecturaId = await alta("lectura", "Consulta con histórico");
      const lectura = await permisosDe(lecturaId);
      expect(
        lectura.pestanas.filter((p) => p.pestana.startsWith("historico:")).every((v) => v.permitido)
      ).toBe(true);
    });

    it("cambiar de perfil hereda los predeterminados del perfil NUEVO", async () => {
      // Pasa por Lectura (todo en consultas) y después a Encargado de Urea:
      // sin el reset se quedaba con los módulos del perfil viejo, que es lo
      // que se veía en el panel del admin.
      const usuarioId = await alta("lectura", "Cambia de perfil");
      expect(nivelDe(await permisosDe(usuarioId), "equipos")).toBe("consultas");

      const { modulos } = await permisosDe(usuarioId);
      const cambio = await admin.put(`/api/erp/usuarios/${usuarioId}/permisos`).send({
        rol: "encargado_urea",
        modulos,
        motivo: "Pasa a manejar urea",
      });
      expect(cambio.status).toBe(200);

      const despues = await permisosDe(usuarioId);
      expect(despues.rol).toBe("encargado_urea");
      expect(nivelDe(despues, "combustible")).toBe("operar");
      expect(nivelDe(despues, "equipos")).toBe("sin-acceso");
      // Y las pestañas también son las del perfil nuevo: Urea sí, Tanques no.
      const pestana = (clave: string) =>
        despues.pestanas.find((p) => p.pestana === clave)?.permitido;
      expect(pestana("urea:registrar_vale")).toBe(true);
      expect(pestana("tanques:registrar_despacho")).toBe(false);
    });

    it("el 'Cambiar perfil' de plataforma también reinicia módulos al perfil nuevo", async () => {
      // La ruta de plataforma solo cambiaba el rol: un Grifero pasado a
      // Operador se quedaba solo con Combustible.
      const usuarioId = await alta("grifero", "Pasa de cancha a oficina");
      expect(nivelDe(await permisosDe(usuarioId), "equipos")).toBe("sin-acceso");

      const cambiarA = async (rol: string) => {
        const res = await plataforma
          .patch(`/api/platform/tenants/${empresa.tenant.id}/usuarios/${usuarioId}/rol`)
          .set("Authorization", `Bearer ${env.platformAdminToken}`)
          .send({ rol, motivo: "Prueba de perfiles" });
        expect(res.status).toBe(200);
        return permisosDe(usuarioId);
      };

      const operador = await cambiarA("operador");
      expect(operador.rol).toBe("operador");
      for (const m of ["equipos", "combustible", "dashboard", "checklists", "iperc"]) {
        expect(nivelDe(operador, m)).toBe("operar");
      }

      const lectura = await cambiarA("lectura");
      for (const m of ["equipos", "combustible", "dashboard", "checklists", "iperc"]) {
        expect(nivelDe(lectura, m)).toBe("consultas");
      }

      const admin2 = await cambiarA("admin");
      for (const m of ["equipos", "combustible", "dashboard"]) {
        expect(nivelDe(admin2, m)).toBe("operar");
      }

      const urea = await cambiarA("encargado_urea");
      expect(nivelDe(urea, "combustible")).toBe("operar");
      expect(nivelDe(urea, "equipos")).toBe("sin-acceso");
    });

    // Un usuario que cambia de perfil tiene que quedar IDÉNTICO a uno recién
    // creado con ese perfil: mismos módulos, mismos niveles, mismas pestañas.
    // Se prueba en las 30 transiciones posibles y por los dos caminos que
    // existen para cambiar el perfil (plataforma y Administración del tenant).
    describe("cambiar de perfil deja al usuario igual a uno nuevo de ese perfil", () => {
      const ROLES = [
        "admin",
        "operador",
        "lectura",
        "grifero",
        "conductor_ruta",
        "encargado_urea",
      ] as const;

      const huella = (p: Awaited<ReturnType<typeof permisosDe>>) => ({
        modulos: Object.fromEntries(
          p.modulos.filter((m) => m.asignado).map((m) => [m.modulo, m.nivel])
        ),
        pestanas: Object.fromEntries(
          p.pestanas.map((x) => [`${x.modulo}:${x.pestana}`, x.permitido])
        ),
      });

      const referencias = async () => {
        const fuera: Record<string, ReturnType<typeof huella>> = {};
        for (const rol of ROLES)
          fuera[rol] = huella(await permisosDe(await alta(rol, `Ref ${rol}`)));
        return fuera;
      };

      const porPlataforma = (usuarioId: string) => async (rol: string) => {
        const res = await plataforma
          .patch(`/api/platform/tenants/${empresa.tenant.id}/usuarios/${usuarioId}/rol`)
          .set("Authorization", `Bearer ${env.platformAdminToken}`)
          .send({ rol, motivo: "Prueba de perfiles" });
        expect(res.status).toBe(200);
      };

      const porTenant = (usuarioId: string) => async (rol: string) => {
        const { modulos } = await permisosDe(usuarioId);
        const res = await admin.put(`/api/erp/usuarios/${usuarioId}/permisos`).send({
          rol,
          modulos,
          motivo: "Prueba de perfiles",
        });
        expect(res.status).toBe(200);
      };

      for (const [camino, cambiador] of [
        ["plataforma", porPlataforma],
        ["tenant", porTenant],
      ] as const) {
        it(`por ${camino}: las 30 transiciones`, async () => {
          const ref = await referencias();
          const usuarioId = await alta("operador", `Recorre perfiles ${camino}`);
          const cambiarA = cambiador(usuarioId);

          for (const desde of ROLES) {
            for (const hasta of ROLES) {
              if (desde === hasta) continue;
              await cambiarA(desde);
              await cambiarA(hasta);
              const ahora = await permisosDe(usuarioId);
              expect(ahora.rol, `${desde} -> ${hasta}`).toBe(hasta);
              expect(huella(ahora), `${desde} -> ${hasta}`).toEqual(ref[hasta]);
            }
          }
        }, 120_000);
      }

      it("una empresa que no contrató un módulo no se lo entrega a nadie al cambiar de perfil", async () => {
        await pool.query(
          `UPDATE tenant_modulos SET estado = 'deshabilitado' WHERE tenant_id = $1 AND modulo = 'iperc'`,
          [empresa.tenant.id]
        );
        try {
          const usuarioId = await alta("grifero", "Empresa sin IPERC");
          await porPlataforma(usuarioId)("operador");
          const operador = await permisosDe(usuarioId);
          expect(nivelDe(operador, "iperc")).toBe("sin-acceso");
          expect(nivelDe(operador, "equipos")).toBe("operar");
        } finally {
          await pool.query(
            `UPDATE tenant_modulos SET estado = 'habilitado' WHERE tenant_id = $1 AND modulo = 'iperc'`,
            [empresa.tenant.id]
          );
        }
      });
    });

    it("el override del perfil viejo no sobrevive al cambio de perfil", async () => {
      const usuarioId = await alta("operador", "Con permiso a mano");
      const antes = await permisosDe(usuarioId);
      // El admin le quita una pestaña a mano...
      const recorte = await admin.put(`/api/erp/usuarios/${usuarioId}/permisos`).send({
        modulos: antes.modulos,
        pestanas: antes.pestanas.map((p) => ({
          modulo: p.modulo,
          pestana: p.pestana,
          permitido: p.pestana === "tanques:precios" ? false : p.permitido,
        })),
        motivo: "Sin precios",
      });
      expect(recorte.status).toBe(200);
      expect(
        (await permisosDe(usuarioId)).pestanas.find((p) => p.pestana === "tanques:precios")
          ?.permitido
      ).toBe(false);

      // ...y al cambiarle el perfil, ese recorte se va con el perfil viejo.
      const { modulos } = await permisosDe(usuarioId);
      const cambio = await admin.put(`/api/erp/usuarios/${usuarioId}/permisos`).send({
        rol: "admin",
        modulos,
        motivo: "Pasa a administrar",
      });
      expect(cambio.status).toBe(200);
      expect(
        (await permisosDe(usuarioId)).pestanas.find((p) => p.pestana === "tanques:precios")
          ?.permitido
      ).toBe(true);
    });
  });
});
