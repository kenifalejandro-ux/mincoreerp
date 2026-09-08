/**src/modules/combutible/combustible.service.ts */

import type { PoolClient } from "pg";
import type { Paginacion } from "../../server/shared/utils/pagination";
import type {
  RegistrarLecturaCombustibleInput,
  CrearTanqueCombustibleInput,
  ActualizarTanqueCombustibleInput,
  CrearDespachoCombustibleInput,
  CrearPrecioCombustibleInput,
  CrearRecepcionCombustibleInput,
  CrearGrifoCombustibleInput,
  ActualizarGrifoCombustibleInput,
} from "../../server/schemas/combustible.schema";
import { idempotentInsert } from "../../server/shared/utils/idempotentInsert";
import { CombustibleRepository } from "./combustible.repository";
import { EquiposRepository } from "../equipos/equipos.repository";

export class CombustibleService {
  private repository = new CombustibleRepository();

  async getAll(client: PoolClient, tenantId: string) {
    return this.repository.findAll(client, tenantId);
  }

  async getById(client: PoolClient, tenantId: string, id: number) {
    return this.repository.findById(client, tenantId, id);
  }

  async create(client: PoolClient, tenantId: string, data: CrearTanqueCombustibleInput) {
    return this.repository.create(client, tenantId, data);
  }

  async update(
    client: PoolClient,
    tenantId: string,
    id: number,
    data: ActualizarTanqueCombustibleInput
  ) {
    return this.repository.update(client, tenantId, id, data);
  }

  /** Compara la vigilancia ANTES y DESPUÉS de un PUT de tanque y devuelve
   *  qué controles se aflojan, con el valor viejo y el nuevo.
   *
   *  Existe porque la auditoría adversaria encontró que subir
   *  `umbral_descuadre_pct` de 1% a 90% -- o sea, apagar la detección de
   *  fraude -- se registraba EXACTAMENTE igual que renombrar el tanque:
   *  `{ combustibleId }` y nada más. En un módulo cuyo propósito es detectar
   *  robo, el acto de desactivar el control tiene que ser lo MÁS visible del
   *  registro, no lo menos.
   *
   *  Qué cuenta como aflojar, para los tres umbrales: NULL es el estado más
   *  débil de todos (no alerta nunca), así que pasar de un número a NULL
   *  afloja siempre; y entre dos números, el más alto tolera más. Ojo con el
   *  orden de esas dos reglas: preguntar por el número antes que por el NULL
   *  haría que apagar el control (5 → null) se leyera como endurecerlo.
   *
   *  Devuelve [] cuando el cambio no toca ninguna vigilancia (renombrar,
   *  mover de ubicación) o cuando la endurece -- esos no piden motivo. */
  evaluarAflojamiento(
    antes: {
      umbral_diferencia_pct: string | null;
      umbral_descuadre_pct: string | null;
      umbral_descuadre_ciclo_pct: string | null;
      requiere_documento: boolean;
      capacidad_total: string;
      nivel_minimo: string;
    },
    ahora: ActualizarTanqueCombustibleInput
  ) {
    const cambios: { control: string; de: string; a: string }[] = [];

    const umbrales = [
      [
        "umbral_diferencia_pct",
        "Umbral de diferencia",
        antes.umbral_diferencia_pct,
        ahora.umbral_diferencia_pct,
      ],
      [
        "umbral_descuadre_pct",
        "Umbral de descuadre",
        antes.umbral_descuadre_pct,
        ahora.umbral_descuadre_pct,
      ],
      [
        "umbral_descuadre_ciclo_pct",
        "Umbral acumulado del ciclo",
        antes.umbral_descuadre_ciclo_pct,
        ahora.umbral_descuadre_ciclo_pct,
      ],
    ] as const;

    for (const [control, etiqueta, viejoRaw, nuevo] of umbrales) {
      const viejo = viejoRaw === null ? null : Number(viejoRaw);
      if (viejo === nuevo) continue;

      const afloja =
        // Apagarlo del todo: el estado más débil que existe.
        nuevo === null
          ? viejo !== null
          : // Encenderlo (null -> número) siempre endurece, nunca afloja.
            viejo !== null && nuevo > viejo;

      if (afloja) {
        cambios.push({
          control,
          de: viejo === null ? "sin configurar" : `${viejo}%`,
          a: nuevo === null ? "sin configurar (no alerta)" : `${nuevo}%`,
        });
        // La etiqueta legible viaja aparte para el mensaje de error, que lo
        // lee una persona parada frente al formulario.
        cambios[cambios.length - 1].control = etiqueta;
      }
    }

    // SUBIR LA CAPACIDAD AFLOJA, aunque el porcentaje no se toque.
    //
    // Los tres umbrales se miden como % de la capacidad, así que pasar un
    // tanque de 20.000 a 200.000 L convierte una banda de 200 L en una de
    // 2.000 sin que ningún umbral haya cambiado de número. Es la forma más
    // discreta de apagar la vigilancia que tiene este modelo, y no la cubría
    // nada: en la auditoría se veía como una corrección de ficha.
    const capacidadAntes = Number(antes.capacidad_total);
    if (ahora.capacidad_total > capacidadAntes) {
      cambios.push({
        control: "Capacidad del tanque (ensancha todos los umbrales)",
        de: `${capacidadAntes}`,
        a: `${ahora.capacidad_total}`,
      });
    }

    // Bajar el mínimo retrasa el aviso de reposición. No es anti-fraude, pero
    // es vigilancia operativa y se afloja igual.
    const minimoAntes = Number(antes.nivel_minimo);
    if (minimoAntes > 0 && ahora.nivel_minimo < minimoAntes) {
      cambios.push({
        control: "Nivel mínimo (avisa más tarde)",
        de: `${minimoAntes}`,
        a: `${ahora.nivel_minimo}`,
      });
    }

    if (antes.requiere_documento && !ahora.requiere_documento) {
      cambios.push({
        control: "Exigir factura o guía en las recepciones",
        de: "exigido",
        a: "no exigido",
      });
    }

    return cambios;
  }

  async softDelete(client: PoolClient, tenantId: string, id: number) {
    return this.repository.softDelete(client, tenantId, id);
  }

  async createBulk(client: PoolClient, tenantId: string, items: CrearTanqueCombustibleInput[]) {
    return this.repository.createBulk(client, tenantId, items);
  }

  /** Devuelve null si la lectura no existe en este tenant o si ya estaba
   *  anulada -- el controller distingue los dos casos con
   *  `findLecturaPorId` para responder 404 o 409. */
  async anularLectura(
    client: PoolClient,
    tenantId: string,
    lecturaId: number,
    usuarioId: string,
    motivo: string
  ) {
    return this.repository.anularLectura(client, tenantId, lecturaId, usuarioId, motivo);
  }

  async getLecturaPorId(client: PoolClient, tenantId: string, lecturaId: number) {
    return this.repository.findLecturaPorId(client, tenantId, lecturaId);
  }

  async getLecturas(
    client: PoolClient,
    tenantId: string,
    combustibleId: number,
    paginacion: Paginacion
  ) {
    return this.repository.findLecturas(client, tenantId, combustibleId, paginacion);
  }

  /** Devuelve `creado: false` cuando esta lectura ya se había registrado con
   *  el mismo `cliente_uuid` -- el reintento de un envío cuya respuesta se
   *  perdió. El controller usa ese flag para no publicar el evento de nuevo.
   *  Sin `cliente_uuid` en el body, se comporta igual que antes: siempre
   *  crea (ver PUT /:id/nivel legacy más abajo). */
  registrarLectura(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    data: RegistrarLecturaCombustibleInput
  ) {
    return idempotentInsert({
      client,
      tenantId,
      modulo: "combustible",
      clienteUuid: data.cliente_uuid,
      insertar: async () => {
        const fila = await this.repository.registrarLectura(client, tenantId, {
          combustibleId: data.combustible_id,
          nivel: data.nivel,
          leidoEn: data.leido_en ?? new Date().toISOString(),
          usuarioId,
          metadata: data.metadata ?? {},
        });
        return { id: Number(fila.lectura.id), fila };
      },
      recuperar: (filaId) => this.repository.findLecturaConTanque(client, tenantId, filaId),
    });
  }

  /** PUT /:id/nivel de siempre, mantenido como wrapper mientras existan
   *  consumidores -- pero ya NUNCA sobreescribe nivel_actual directo: pasa
   *  por el mismo camino que una lectura nueva (leido_en = now(), sin
   *  cliente_uuid, así que siempre crea). El historial queda completo
   *  también para las lecturas cargadas por esta vía. */
  async actualizarNivelLegacy(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    id: number,
    nivelActual: number
  ) {
    const { tanque } = await this.repository.registrarLectura(client, tenantId, {
      combustibleId: id,
      nivel: nivelActual,
      leidoEn: new Date().toISOString(),
      usuarioId,
      metadata: {},
    });
    return tanque;
  }

  // ── Despachos (Fase B) ───────────────────────────────────────────────

  /** Valida lo que el schema Zod no puede (necesita consultar otras filas)
   *  y crea el despacho envuelto en idempotentInsert -- mismo `modulo:
   *  "combustible"` que registrarLectura(), así un reintento con el mismo
   *  cliente_uuid no duplica sin importar si fue una lectura o un
   *  despacho lo que se reintentó. */
  crearDespacho(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    data: CrearDespachoCombustibleInput
  ) {
    return idempotentInsert({
      client,
      tenantId,
      modulo: "combustible",
      clienteUuid: data.cliente_uuid,
      insertar: async () => {
        // El duplicado le gana a cualquier otro 400 -- ver el comentario de
        // CombustibleRepository.existeVale. El constraint único de 0062
        // sigue siendo la red de seguridad real contra una carrera entre
        // dos requests simultáneos; esto es solo para dar la señal correcta
        // en el caso común (no concurrente).
        if (await this.repository.existeVale(client, tenantId, data.serie_talonario, data.n_vale)) {
          // El mensaje dice qué hacer, no solo qué pasó: quien lo lee está
          // parado frente al surtidor con la máquina esperando. Y nombra el
          // caso que más lo confunde -- que otro dispositivo lo haya cargado
          // sin red y recién ahora haya sincronizado, así que el número que
          // el operario tiene en la mano ya está ocupado sin que él lo sepa.
          throw new Error(
            `el vale ${data.n_vale} de la serie ${data.serie_talonario} ya está registrado. ` +
              `Puede haberlo cargado otra persona, u otro dispositivo que estaba sin red y ` +
              `recién sincronizó. Verificá el talonario y usá el siguiente número libre`
          );
        }

        await this.validarFormaDespacho(client, tenantId, data);

        const fila = await this.repository.crearDespacho(client, tenantId, usuarioId, {
          origen: data.origen,
          combustibleId: data.combustible_id ?? null,
          grifoId: data.grifo_id ?? null,
          tipoCombustible: data.tipo_combustible,
          tipoDestino: data.tipo_destino,
          equipoId: data.equipo_id ?? null,
          serieTalonario: data.serie_talonario,
          nVale: data.n_vale,
          cantidad: data.cantidad,
          lecturaContometro: data.lectura_contometro ?? null,
          lecturaHorometro: data.lectura_horometro ?? null,
          lecturaOdometro: data.lectura_odometro ?? null,
          horasAbastecidas: data.horas_abastecidas ?? null,
          costoUnitario: data.costo_unitario,
          observaciones: data.observaciones ?? null,
          despachadoEn: data.despachado_en ?? new Date().toISOString(),
        });
        return { id: Number(fila.id), fila };
      },
      recuperar: (filaId) => this.repository.findDespachoPorId(client, tenantId, filaId),
    });
  }

  /** Reglas que dependen de OTRA fila, así que Zod (que solo ve el body)
   *  no las puede validar:
   *
   *  - tanque_propio: el contómetro tiene que coincidir con la cantidad
   *    declarada (punto 5, control de calidad de dato -- el aparato
   *    resetea a 0,0 en cada despacho, así que no depende de ningún otro
   *    vale, solo de ESTE). No es anti-fraude: agarra el tipeo, no a
   *    alguien que declara a propósito un número falso -- eso lo detecta
   *    el hueco de talonario (punto 1), no este chequeo.
   *  - compra_externa: el equipo tiene que existir en este tenant, tener
   *    `tipo_medidor` configurado, y el campo que llegó lleno
   *    (horómetro/odómetro) tiene que ser el que corresponde a ESE
   *    equipo -- cruce que ningún CHECK de la migración puede hacer
   *    (0062 solo puede exigir "exactamente uno de los dos", nunca "el
   *    correcto para este equipo", porque eso vive en otra tabla). */
  private async validarFormaDespacho(
    client: PoolClient,
    tenantId: string,
    data: CrearDespachoCombustibleInput
  ) {
    if (data.origen === "tanque_propio") {
      if (Number(data.lectura_contometro) !== Number(data.cantidad)) {
        throw new Error(
          `el contómetro marcó ${data.lectura_contometro} pero se declararon ${data.cantidad} -- revisá el vale`
        );
      }

      // Un tanque DESACTIVADO no puede seguir despachando. Parece obvio y no
      // lo era: la simulación de robo dio de baja un tanque -- lo que además
      // lo saca de la alerta de "sin medir" -- y siguió sacándole 5.000 L sin
      // una queja. "Desactivado" tiene que significar algo.
      const tanque = await this.repository.findById(client, tenantId, data.combustible_id!);
      if (tanque && !tanque.activo) {
        throw new Error(
          `el tanque ${tanque.codigo} está desactivado y no puede despachar -- reactivalo si sigue en uso`
        );
      }
      return;
    }

    // El grifo tiene que estar marcado como grifo de RUTA (migrations/0065) --
    // un proveedor que solo llena el tanque propio no es donde una unidad
    // carga camino a Bambamarca.
    await this.validarRolGrifo(client, tenantId, data.grifo_id!, "ruta");

    // compra_externa: el schema ya garantiza equipo_id presente (exige
    // tipo_destino='equipo' en este origen).
    const equipoId = data.equipo_id!;
    const equipo = await EquiposRepository.findTipoMedidor(client, tenantId, equipoId);
    if (!equipo) {
      throw new Error(`equipo_id ${equipoId} no existe en este tenant`);
    }
    if (!equipo.tipo_medidor) {
      throw new Error(
        `el equipo ${equipoId} no tiene tipo de medidor configurado -- asignale horómetro u odómetro en Equipos antes de registrar un despacho de compra externa`
      );
    }
    if (equipo.tipo_medidor === "horometro" && data.lectura_horometro === undefined) {
      throw new Error(`el equipo ${equipoId} se mide por horómetro, no por odómetro`);
    }
    if (equipo.tipo_medidor === "odometro" && data.lectura_odometro === undefined) {
      throw new Error(`el equipo ${equipoId} se mide por odómetro, no por horómetro`);
    }
  }

  listarDespachos(
    client: PoolClient,
    tenantId: string,
    filtros: { equipoId?: number; serieTalonario?: string },
    paginacion: Paginacion
  ) {
    return this.repository.findDespachos(client, tenantId, filtros, paginacion);
  }

  /** Devuelve null si el despacho no existe en este tenant o si ya estaba
   *  anulado -- el controller distingue los dos casos con
   *  getDespachoPorId para responder 404 o 409, igual que en lecturas,
   *  precios y recepciones. */
  anularDespacho(
    client: PoolClient,
    tenantId: string,
    despachoId: number,
    usuarioId: string,
    motivo: string
  ) {
    return this.repository.anularDespacho(client, tenantId, despachoId, usuarioId, motivo);
  }

  getDespachoPorId(client: PoolClient, tenantId: string, id: number) {
    return this.repository.findDespachoPorId(client, tenantId, id);
  }

  /** Punto 1 reescrito: consulta bajo demanda -- ver el comentario de
   *  CombustibleRepository.findHuecosTalonario. */
  detectarHuecos(client: PoolClient, tenantId: string, serieTalonario: string) {
    return this.repository.findHuecosTalonario(client, tenantId, serieTalonario);
  }

  // ── Alertas (migrations/0068) ─────────────────────────────────────────

  detectarHuecosRevelados(
    client: PoolClient,
    tenantId: string,
    serieTalonario: string,
    despachoId: number,
    nuevoNVale: number
  ) {
    return this.repository.detectarHuecosRevelados(
      client,
      tenantId,
      serieTalonario,
      despachoId,
      nuevoNVale
    );
  }

  resolverAlertaHuecoSiExiste(
    client: PoolClient,
    tenantId: string,
    serieTalonario: string,
    nVale: number
  ) {
    return this.repository.resolverAlertaHuecoSiExiste(client, tenantId, serieTalonario, nVale);
  }

  crearAlertas(
    client: PoolClient,
    tenantId: string,
    filas: Parameters<CombustibleRepository["crearAlertas"]>[2]
  ) {
    return this.repository.crearAlertas(client, tenantId, filas);
  }

  listarAlertas(
    client: PoolClient,
    tenantId: string,
    filtros: { soloNoLeidas?: boolean },
    paginacion: Paginacion
  ) {
    return this.repository.findAlertas(client, tenantId, filtros, paginacion);
  }

  marcarAlertasLeidas(client: PoolClient, tenantId: string, ids?: number[]) {
    return this.repository.marcarAlertasLeidas(client, tenantId, ids);
  }

  resolverAlertaManual(
    client: PoolClient,
    tenantId: string,
    alertaId: number,
    usuarioId: string,
    motivo: string
  ) {
    return this.repository.resolverAlertaManual(client, tenantId, alertaId, usuarioId, motivo);
  }

  findAdminsConCombustibleHabilitado(client: PoolClient, tenantId: string) {
    return this.repository.findAdminsConCombustibleHabilitado(client, tenantId);
  }

  // ── Conciliación (migraciones 0071/0072) ──────────────────────────────

  getConfig(client: PoolClient, tenantId: string) {
    return this.repository.getConfig(client, tenantId);
  }

  guardarConfig(
    client: PoolClient,
    tenantId: string,
    valores: {
      ventanaGraciaHoras: number;
      diasSinMedir: number;
      llenadosPorDiaMax: number | null;
      topeSinCapacidadL: number | null;
    },
    usuarioId: string
  ) {
    return this.repository.guardarConfig(client, tenantId, valores, usuarioId);
  }

  /** Qué cambios de la configuración del tenant AFLOJAN la vigilancia.
   *
   *  Hermano de evaluarAflojamiento(), que hace lo mismo con el tanque. La
   *  diferencia es qué significa "más débil" en cada campo: en la ventana de
   *  gracia y los días sin medir, subir afloja (los hallazgos tardan más en
   *  congelarse, se mide menos seguido); en los dos topes de 0079, aflojan
   *  tanto subirlos como apagarlos.
   *
   *  Existe porque los topes nuevos son, si nadie los mira, la forma más
   *  cómoda de robar que quedaba: no hace falta tocar ningún tanque ni
   *  ningún vale, alcanza con subir un número en una pantalla de
   *  configuración. Igual que con el tanque: no se bloquea el cambio, se
   *  deja escrito quién lo hizo y se le avisa al resto de los admins. */
  evaluarAflojamientoConfig(
    antes: {
      ventana_gracia_horas: number;
      dias_sin_medir: number;
      llenados_por_dia_max: number | null;
      tope_diario_sin_capacidad_l: number | null;
    },
    ahora: {
      ventana_gracia_horas: number;
      dias_sin_medir: number;
      llenados_por_dia_max: number | null;
      tope_diario_sin_capacidad_l: number | null;
    }
  ) {
    const cambios: { control: string; de: string; a: string }[] = [];

    const subir = [
      ["Ventana de gracia", antes.ventana_gracia_horas, ahora.ventana_gracia_horas, "h"],
      ["Días sin medir tolerados", antes.dias_sin_medir, ahora.dias_sin_medir, " días"],
    ] as const;

    for (const [control, viejo, nuevo, sufijo] of subir) {
      if (nuevo > viejo) {
        cambios.push({ control, de: `${viejo}${sufijo}`, a: `${nuevo}${sufijo}` });
      }
    }

    const topes = [
      ["Llenados por día por equipo", antes.llenados_por_dia_max, ahora.llenados_por_dia_max, ""],
      [
        "Tope diario sin capacidad",
        antes.tope_diario_sin_capacidad_l,
        ahora.tope_diario_sin_capacidad_l,
        " L",
      ],
    ] as const;

    for (const [control, viejo, nuevo, sufijo] of topes) {
      if (viejo === nuevo) continue;
      // Encenderlo (null -> número) endurece; apagarlo o subirlo afloja.
      const afloja = nuevo === null ? viejo !== null : viejo !== null && nuevo > viejo;
      if (afloja) {
        cambios.push({
          control,
          de: viejo === null ? "sin configurar" : `${viejo}${sufijo}`,
          a: nuevo === null ? "sin configurar (no alerta)" : `${nuevo}${sufijo}`,
        });
      }
    }

    return cambios;
  }

  listarAnomalias(client: PoolClient, tenantId: string, paginacion: Paginacion) {
    return this.repository.findAnomalias(client, tenantId, paginacion);
  }

  /** Congela todas las alertas de ESTE tenant que ya pasaron su ventana de
   *  gracia. Devuelve cuántas congeló -- el worker lo usa para loguear solo
   *  cuando hubo trabajo real (una corrida vacía es lo normal y no debe
   *  ensuciar el log cada hora).
   *
   *  El `client` tiene que venir con `app.tenant_id` seteado para este
   *  tenant: todo lo que toca acá (combustible_alertas,
   *  combustible_anomalias, combustible_config) tiene RLS forzado. */
  async congelarAlertasVencidas(
    client: PoolClient,
    tenantId: string
  ): Promise<{ congeladas: number; ventanaHoras: number }> {
    const ventanaHoras = await this.repository.getVentanaGraciaHoras(client, tenantId);
    const vencidas = await this.repository.findAlertasPorCongelar(client, tenantId, ventanaHoras);

    let congeladas = 0;
    for (const alerta of vencidas) {
      const anomaliaId = await this.repository.congelarAlerta(
        client,
        tenantId,
        alerta,
        ventanaHoras
      );
      // null = ya estaba congelada (ON CONFLICT DO NOTHING); no la cuento
      // como trabajo nuevo para que el log no mienta.
      if (anomaliaId) congeladas++;
    }
    return { congeladas, ventanaHoras };
  }

  /** Diferencia de recepción (migración 0073): el proveedor facturó más de
   *  lo que descargó, por encima del umbral del tanque.
   *
   *  Corre en el worker y no al crear la recepción porque en ese momento
   *  todavía no se puede calcular: hace falta la lectura de varilla
   *  POSTERIOR a la descarga. Y tampoco se engancha al registrar esa
   *  lectura, porque la diferencia también cambia si se anula un despacho
   *  del medio, o la propia lectura, o entra otra recepción -- habría que
   *  acordarse en cada una de esas mutaciones. El worker la recalcula sola
   *  sin importar qué la movió.
   *
   *  Devuelve cuántas alertas creó. El `NOT EXISTS` de la consulta hace que
   *  no se repita: una recepción alerta una sola vez. */
  async alertarDiferenciasDeRecepcion(
    client: PoolClient,
    tenantId: string
  ): Promise<{ creadas: number }> {
    const excedidas = await this.repository.findRecepcionesConDiferenciaExcedida(client, tenantId);
    if (excedidas.length === 0) return { creadas: 0 };

    await this.repository.crearAlertas(
      client,
      tenantId,
      excedidas.map((r) => {
        const litros = Number(r.diferencia_litros);
        const cantidad = Number(r.cantidad);
        return {
          tipo: "diferencia_recepcion" as const,
          recepcionId: r.id,
          combustibleId: r.combustible_id,
          detalle: {
            diferenciaLitros: litros,
            cantidadFacturada: cantidad,
            diferenciaPct: Number(((litros / cantidad) * 100).toFixed(2)),
            umbralPct: Number(r.umbral_diferencia_pct),
            unidad: r.unidad,
            tanqueNombre: r.tanque_nombre,
          },
        };
      })
    );
    return { creadas: excedidas.length };
  }

  /** Medidor que no cierra con el anterior (punto 5 del documento). NO
   *  bloquea el vale: devuelve los datos para que el controller cree la
   *  alerta, o `null` si no hay nada que reportar.
   *
   *  Las dos condiciones son FÍSICAMENTE IMPOSIBLES, no umbrales elegidos:
   *
   *  - **Retroceso**: un medidor no vuelve atrás. Vale para horómetro y
   *    odómetro por igual.
   *  - **Horómetro que excede el calendario**: una máquina no puede sumar
   *    más horas de motor que las horas que pasaron en el reloj.
   *
   *  Para el ODÓMETRO solo se mira el retroceso: no existe un límite de
   *  km/día defendible sin inventarlo (un tráiler hace 1.000 km sin
   *  problema), y alertar por un número inventado es peor que no alertar --
   *  mismo criterio que `capacidad_tanque` en NULL (0069).
   *
   *  Devuelve null también cuando el equipo no tiene ningún despacho previo
   *  con medidor: ahí no hay contra qué comparar. */
  async evaluarMedidorInconsistente(
    client: PoolClient,
    tenantId: string,
    equipoId: number,
    data: {
      lecturaHorometro?: number | null;
      lecturaOdometro?: number | null;
      despachadoEn: string;
      /** El despacho recién creado, para NO compararlo contra sí mismo. */
      despachoId: number;
    }
  ) {
    const esHorometro = data.lecturaHorometro !== undefined && data.lecturaHorometro !== null;
    const valorNuevo = esHorometro ? data.lecturaHorometro! : data.lecturaOdometro;
    if (valorNuevo === undefined || valorNuevo === null) return null;

    const anterior = await this.repository.findUltimoMedidorEquipo(
      client,
      tenantId,
      equipoId,
      data.despachoId
    );
    if (!anterior) return null;

    const crudo = esHorometro ? anterior.lectura_horometro : anterior.lectura_odometro;
    // El equipo tenía despachos, pero medidos con el OTRO instrumento (por
    // ejemplo si se le cambió el tipo_medidor): no son comparables.
    if (crudo === null) return null;

    const valorAnterior = Number(crudo);
    const medidor = esHorometro ? ("horometro" as const) : ("odometro" as const);

    if (valorNuevo < valorAnterior) {
      return {
        medidor,
        motivo: "retroceso" as const,
        valorAnterior,
        valorNuevo,
        leidoAnteriorEn: anterior.despachado_en,
      };
    }

    if (esHorometro) {
      const horasCalendario =
        (new Date(data.despachadoEn).getTime() - new Date(anterior.despachado_en).getTime()) /
        3_600_000;
      const horasDeclaradas = valorNuevo - valorAnterior;
      // Solo si el calendario avanzó: dos vales con la misma marca de tiempo
      // (una carga masiva, por ejemplo) darían 0 horas disponibles y
      // cualquier avance parecería imposible sin serlo.
      if (horasCalendario > 0 && horasDeclaradas > horasCalendario) {
        return {
          medidor,
          motivo: "excede_calendario" as const,
          valorAnterior,
          valorNuevo,
          horasDeclaradas: Number(horasDeclaradas.toFixed(2)),
          horasCalendario: Number(horasCalendario.toFixed(2)),
          leidoAnteriorEn: anterior.despachado_en,
        };
      }
    }

    return null;
  }

  /** Nivel bajo de tanque (migración 0073). Se evalúa al registrar cada
   *  lectura, que es el único momento en que el nivel cambia (desde 0059 el
   *  nivel se deriva de las lecturas, no es una columna).
   *
   *  Devuelve `{ alertar: true }` solo si el nivel cruzó el mínimo Y no hay
   *  ya una alerta abierta para ese tanque -- sin esa deduplicación, cada
   *  lectura con el tanque bajo generaría una alerta nueva y la pantalla se
   *  llenaría de repetidos (el control que muere por ruidoso, punto 4).
   *
   *  Si el nivel volvió a estar por encima, resuelve la alerta abierta:
   *  el problema se arregló reponiendo, nadie tiene que cerrarla a mano. */
  async evaluarNivelBajo(
    client: PoolClient,
    tenantId: string,
    combustibleId: number,
    nivel: number
  ) {
    const tanque = await this.repository.findEstadoNivelTanque(client, tenantId, combustibleId);
    if (!tanque) return null;

    const minimo = Number(tanque.nivel_minimo);
    // 0 = sin configurar, sin el dato no se alerta -- mismo criterio que
    // capacidad_tanque (0069).
    //
    // OJO: los dos UMBRALES ya no siguen esta convención. Desde 0075
    // distinguen NULL (sin configurar) de 0 (estricto), porque ahí el 0
    // tenía un significado legítimo que no se podía expresar. Acá no se
    // migró porque "avisame cuando el tanque baje de 0 litros" no es un
    // pedido que alguien vaya a hacer -- el tanque vacío ya se ve solo.
    // Si algún día lo es, este es el mismo cambio que hizo 0075.
    if (minimo <= 0) return null;

    if (nivel >= minimo) {
      await this.repository.resolverAlertaNivelSiExiste(client, tenantId, combustibleId);
      return null;
    }

    if (tanque.alerta_abierta) return null;

    return {
      nivel,
      nivelMinimo: minimo,
      unidad: tanque.unidad,
      tanqueNombre: tanque.tanque_nombre,
    };
  }

  /** Descuadre de inventario (migración 0074): el balance del tanque entre
   *  dos lecturas de varilla consecutivas.
   *
   *      esperado  = nivel_anterior + recepciones − despachos
   *      descuadre = nivel_medido − esperado
   *
   *  Negativo = falta (salió más de lo que los papeles explican: robo, fuga,
   *  o un despacho que nadie registró). Positivo = sobra (los vales dicen
   *  más de lo que realmente salió: mal tipeo, o combustible cargado en el
   *  papel a una máquina que nunca lo recibió). Las dos son anomalía.
   *
   *  Corre al registrar la lectura y NO bloquea: la duda depende de otras
   *  filas -- todos los movimientos del intervalo -- así que se marca, no se
   *  rechaza. Misma regla que el sobredespacho (ver 0070).
   *
   *  **El umbral se mide contra la capacidad del tanque**, no contra lo que
   *  se movió. La fuente de ruido dominante es la varilla, y su error escala
   *  con el tamaño del tanque, no con cuánto entró o salió ese día. Además
   *  nunca divide por cero, cosa que sí pasaría con un intervalo sin
   *  movimientos. El costo conocido de esa elección: un descuadre chico en
   *  términos del tanque pero grande respecto de lo que se movió (50 L
   *  perdidos de 100 L despachados en un tanque de 20.000) pasa por debajo.
   *  Se revisa cuando haya datos reales con qué calibrar. */
  async evaluarDescuadre(
    client: PoolClient,
    tenantId: string,
    combustibleId: number,
    lecturaId: number,
    nivel: number,
    leidoEn: string
  ) {
    const datos = await this.repository.findDatosDescuadre(
      client,
      tenantId,
      combustibleId,
      lecturaId,
      leidoEn
    );
    if (!datos) return null;

    // NULL = sin configurar, no alertar (migración 0075). El 0 SÍ alerta:
    // es tolerancia cero de verdad, cualquier descuadre cuenta. Ojo con
    // Number(null), que da 0 -- hay que preguntar por el null antes de
    // convertir, o el tanque sin configurar terminaría siendo el más
    // estricto de todos.
    if (datos.umbral_descuadre_pct === null) return null;
    const umbralPct = Number(datos.umbral_descuadre_pct);

    const nivelAnterior = Number(datos.nivel_anterior);
    const despachos = Number(datos.despachos);
    const recepciones = Number(datos.recepciones);
    const capacidad = Number(datos.capacidad_total);

    const esperado = nivelAnterior + recepciones - despachos;
    const descuadre = nivel - esperado;
    const toleradoLitros = (capacidad * umbralPct) / 100;

    if (Math.abs(descuadre) <= toleradoLitros) return null;

    return {
      tanqueNombre: datos.tanque_nombre,
      unidad: datos.unidad,
      nivelAnterior,
      nivelMedido: nivel,
      despachos,
      recepciones,
      esperado,
      descuadreLitros: descuadre,
      // Lo que el correo y la pantalla necesitan para explicarse sin
      // recalcular nada del lado del que lee.
      sentido: descuadre < 0 ? ("falta" as const) : ("sobra" as const),
      umbralPct,
      toleradoLitros,
      lecturaAnteriorId: Number(datos.lectura_anterior_id),
      lecturaId,
    };
  }

  /** Vale cargado por debajo del máximo de su serie (migración 0077).
   *  Devuelve ese máximo, o null si la carga fue en orden. */
  detectarValeFueraDeOrden(
    client: PoolClient,
    tenantId: string,
    serieTalonario: string,
    despachoId: number,
    nVale: number
  ) {
    return this.repository.detectarValeFueraDeOrden(
      client,
      tenantId,
      serieTalonario,
      despachoId,
      nVale
    );
  }

  /** ¿Alguna vez se alertó un hueco por este número de vale?
   *
   *  Es lo que distingue el vale tardío legítimo -- el que sincronizó desde
   *  la cola offline y viene a llenar un hueco que el sistema ya había
   *  reportado -- del vale desordenado que nadie estaba esperando. Sin esta
   *  pregunta, cada vale que llega tarde generaría una alerta de desorden
   *  además de resolver su hueco, y el control moriría por ruidoso.
   *
   *  Mira también las resueltas y las congeladas a propósito: el hueco
   *  EXISTIÓ, y que ya esté cerrado no lo vuelve sospechoso. */
  existioHuecoPara(client: PoolClient, tenantId: string, serieTalonario: string, nVale: number) {
    return this.repository.existioHuecoPara(client, tenantId, serieTalonario, nVale);
  }

  /** Saldo acumulado del ciclo (migración 0076): el mismo balance que
   *  `evaluarDescuadre`, pero medido desde la última recepción en vez de
   *  desde la lectura anterior.
   *
   *  Existe porque el de tramo tiene un agujero explotable: un faltante
   *  repartido en pedazos chicos, cada uno debajo de la banda, no dispara
   *  nunca. La auditoría lo demostró con 600 L en cuatro tramos de 150.
   *
   *  Umbral SEPARADO del de tramo a propósito. El ruido de la varilla se
   *  acumula a lo largo del ciclo, así que reusar el mismo porcentaje haría
   *  que esto alertara todos los días y muriera por ruidoso -- el riesgo
   *  que nombra el punto 4 del documento de diseño. */
  async evaluarDescuadreCiclo(
    client: PoolClient,
    tenantId: string,
    combustibleId: number,
    lecturaId: number,
    nivel: number,
    leidoEn: string
  ) {
    const datos = await this.repository.findSaldoCiclo(
      client,
      tenantId,
      combustibleId,
      lecturaId,
      leidoEn
    );
    if (!datos) return null;
    if (datos.umbral_descuadre_ciclo_pct === null) return null;

    const umbralPct = Number(datos.umbral_descuadre_ciclo_pct);
    const nivelInicio = Number(datos.nivel_inicio);
    const despachos = Number(datos.despachos);
    const recepciones = Number(datos.recepciones);
    const capacidad = Number(datos.capacidad_total);

    const esperado = nivelInicio + recepciones - despachos;
    const descuadre = nivel - esperado;
    const toleradoLitros = (capacidad * umbralPct) / 100;

    if (Math.abs(descuadre) <= toleradoLitros) return null;

    return {
      tanqueNombre: datos.tanque_nombre,
      unidad: datos.unidad,
      cicloDesde: new Date(datos.inicio_en).toISOString(),
      nivelInicio,
      nivelMedido: nivel,
      despachos,
      recepciones,
      esperado,
      descuadreLitros: descuadre,
      sentido: descuadre < 0 ? ("falta" as const) : ("sobra" as const),
      umbralPct,
      toleradoLitros,
      lecturaId,
    };
  }

  /** Lectura insertada hacia atrás dentro del ciclo vivo (migración 0078).
   *  Devuelve null en el caso normal -- la lectura nueva es la más reciente. */
  detectarLecturaRetroactiva(
    client: PoolClient,
    tenantId: string,
    combustibleId: number,
    lecturaId: number,
    leidoEn: string
  ) {
    return this.repository.detectarLecturaRetroactiva(
      client,
      tenantId,
      combustibleId,
      lecturaId,
      leidoEn
    );
  }

  /** Llegó una lectura: si el tanque tenía una alerta de "sin medir"
   *  abierta, se cierra sola. Mismo mecanismo que el nivel bajo cuando se
   *  repone -- nadie tiene que acordarse de cerrarla a mano. */
  async resolverAlertaSinMedirSiExiste(
    client: PoolClient,
    tenantId: string,
    combustibleId: number
  ) {
    return this.repository.resolverAlertaSinMedirSiExiste(client, tenantId, combustibleId);
  }

  /** Tanques que dejaron de medirse (migración 0076). Corre en el worker,
   *  no event-driven: el hecho que hay que detectar es justamente que NO
   *  pasó nada, y un evento que no ocurre no dispara ningún handler.
   *
   *  Es la evasión más simple del módulo entero, y no requiere entender
   *  nada: sin lecturas no hay descuadre que calcular ni diferencia de
   *  recepción que comparar. Las dos detecciones se apagan solas. */
  async evaluarTanquesSinMedir(client: PoolClient, tenantId: string) {
    const dias = await this.repository.getDiasSinMedir(client, tenantId);
    const tanques = await this.repository.findTanquesSinMedir(client, tenantId, dias);
    if (tanques.length === 0) return { alertas: [], dias };

    await this.repository.crearAlertas(
      client,
      tenantId,
      tanques.map((t) => ({
        tipo: "tanque_sin_medir" as const,
        combustibleId: t.id,
        detalle: {
          tanqueNombre: t.tanque_nombre,
          unidad: t.unidad,
          diasSinMedir: t.dias_sin_medir === null ? null : Number(t.dias_sin_medir),
          ultimaLectura: t.ultima_lectura ? new Date(t.ultima_lectura).toISOString() : null,
          plazoDias: dias,
        },
      }))
    );
    return { alertas: tanques, dias };
  }

  /** Sobredespacho (migraciones 0069/0070): se despachó más de lo que el
   *  tanque de esa unidad puede contener. NO bloquea el vale -- devuelve
   *  los datos para que el controller cree una alerta, o `null` si no hay
   *  nada que reportar. Ver el encabezado de 0070 para el porqué.
   *
   *  Devuelve null (= no se evalúa, y eso es correcto) en tres casos:
   *
   *  - **El equipo no tiene capacidad configurada.** El caso normal hoy:
   *    todos arrancan en NULL a propósito (0069). Sin el dato real no se
   *    inventa uno.
   *  - **No se sabe en qué unidad está `cantidad`.** Pasa en
   *    compra_externa: no hay tanque propio del cual heredar la unidad, y
   *    el despacho no la guarda por su cuenta. Comparar 48 (¿litros?
   *    ¿galones?) contra 40 gal sin saberlo daría alertas falsas -- 48 L
   *    son 12,7 gal, ni cerca de llenar ese tanque. Queda pendiente
   *    resolverlo con un dato de unidad propio del despacho.
   *  - **No hay exceso.** Lo esperable en la enorme mayoría de los vales. */
  async evaluarSobredespacho(
    client: PoolClient,
    tenantId: string,
    equipoId: number,
    combustibleId: number | null,
    cantidad: number
  ) {
    const datos = await this.repository.findDatosSobredespacho(
      client,
      tenantId,
      equipoId,
      combustibleId
    );
    if (!datos?.capacidad_tanque || !datos.capacidad_tanque_unidad) return null;
    if (!datos.unidad_tanque) return null;

    // Litros como unidad canónica interna, solo para comparar -- lo que se
    // guarda y se muestra sigue siendo el número en su unidad original.
    const aLitros = (valor: number, unidad: string) =>
      unidad === "gal" ? valor * 3.785411784 : valor;

    const capacidad = Number(datos.capacidad_tanque);
    const capacidadL = aLitros(capacidad, datos.capacidad_tanque_unidad);
    const despachadoL = aLitros(cantidad, datos.unidad_tanque);

    if (despachadoL <= capacidadL) return null;

    return {
      cantidad,
      unidadDespacho: datos.unidad_tanque,
      capacidad,
      unidadCapacidad: datos.capacidad_tanque_unidad,
      excesoPct: Number((((despachadoL - capacidadL) / capacidadL) * 100).toFixed(1)),
    };
  }

  /** Tope diario por actor (migración 0079): cuánto puede recibir UNO en las
   *  últimas 24 horas, sin importar en cuántos vales venga repartido.
   *
   *  Es el control que le faltaba a `evaluarSobredespacho`, que mira UN vale
   *  contra la capacidad del equipo. En la simulación alcanzó con partir el
   *  robo en tres vales de 400 L a un volquete de tanque 500: ninguno
   *  excedía solo. Y `planta`/`reserva_cubeta` directamente no tenían techo.
   *
   *  Devuelve null en el caso normal, que es la enorme mayoría:
   *  - El tope que le corresponde a este actor está sin configurar (NULL).
   *  - El acumulado no llega al techo.
   *  - El techo YA estaba superado antes de este vale. Ahí la alerta ya se
   *    creó en el vale que cruzó la línea; repetirla en cada vale posterior
   *    del mismo día sería el ruido que hace que nadie las mire. */
  async evaluarTopeDiario(
    client: PoolClient,
    tenantId: string,
    despacho: {
      despachoId: number;
      equipoId: number | null;
      tipoDestino: string;
      despachadoEn: string;
    }
  ) {
    const topes = await this.repository.getTopesDiarios(client, tenantId);
    if (topes.llenadosPorDiaMax === null && topes.topeSinCapacidadL === null) return null;

    const actor = despacho.equipoId
      ? ({ equipoId: despacho.equipoId } as const)
      : ({ tipoDestino: despacho.tipoDestino } as const);

    // Qué techo le toca a este actor. El del equipo solo existe si el equipo
    // tiene capacidad cargada -- hoy están todas en NULL a propósito: sin el
    // dato no se inventa un límite (mismo criterio que el sobredespacho).
    let topeL: number | null = null;
    let base: string;

    if (despacho.equipoId && topes.llenadosPorDiaMax !== null) {
      const datos = await this.repository.findDatosSobredespacho(
        client,
        tenantId,
        despacho.equipoId,
        null
      );
      if (datos?.capacidad_tanque && datos.capacidad_tanque_unidad) {
        const capacidad = Number(datos.capacidad_tanque);
        const capacidadL =
          datos.capacidad_tanque_unidad === "gal" ? capacidad * 3.785411784 : capacidad;
        topeL = capacidadL * topes.llenadosPorDiaMax;
        base = `${topes.llenadosPorDiaMax} llenado(s) de ${capacidad} ${datos.capacidad_tanque_unidad}`;
      }
    }

    // Sin capacidad cargada, o destino sin equipo: cae al techo absoluto.
    if (topeL === null) {
      if (topes.topeSinCapacidadL === null) return null;
      topeL = topes.topeSinCapacidadL;
      base = despacho.equipoId
        ? "tope diario para equipos sin capacidad cargada"
        : `tope diario para destino "${despacho.tipoDestino}"`;
    }

    const [conEste, sinEste] = await Promise.all([
      this.repository.findAcumuladoDiario(client, tenantId, actor, despacho.despachadoEn),
      this.repository.findAcumuladoDiario(
        client,
        tenantId,
        actor,
        despacho.despachadoEn,
        despacho.despachoId
      ),
    ]);

    if (conEste.totalL <= topeL) return null;
    if (sinEste.totalL > topeL) return null; // Ya estaba pasado: no es un hallazgo nuevo.

    return {
      acumuladoL: Number(conEste.totalL.toFixed(2)),
      topeL: Number(topeL.toFixed(2)),
      excesoL: Number((conEste.totalL - topeL).toFixed(2)),
      valesEnLaVentana: conEste.vales,
      base: base!,
      ventanaHoras: 24,
      equipoId: despacho.equipoId,
      tipoDestino: despacho.tipoDestino,
    };
  }

  /** Entrega 3 de Fase D: asistente de calibración de `umbral_diferencia_pct`.
   *
   *  Nunca se aplica solo -- devuelve el número sugerido JUNTO con la
   *  muestra completa que lo justifica, para que un admin la revise antes
   *  de guardar (mismo criterio que sugerirRateLimitTenant() en
   *  platformRateLimitCuota.ts: una sugerencia explicable, no una fórmula
   *  que se aplica en silencio).
   *
   *  Por qué PROMEDIO + 2 DESVÍOS y no percentil: la migración 0066 avisa
   *  que la muestra puede estar contaminada con robos reales -- un
   *  percentil alto (p90) terminaría fijando el umbral A LA ALTURA del
   *  robo, dejándolo invisible la próxima vez. Ningún estadístico solo
   *  puede blindarse solo contra eso: por eso la respuesta siempre incluye
   *  la muestra fila por fila, para que un humano la mire antes de aceptar
   *  el número.
   *
   *  MINIMO_MUESTRA = 10 -- con menos, cualquier sugerencia sería
   *  inventada (ver el recordatorio operativo de la Fase D). */
  async sugerirUmbralDiferencia(client: PoolClient, tenantId: string, combustibleId: number) {
    const muestra = await this.repository.findMuestraDiferenciasParaCalibracion(
      client,
      tenantId,
      combustibleId
    );

    const puntos = muestra.map((m) => ({
      cantidad: m.cantidad,
      diferenciaLitros: m.diferencia_litros,
      diferenciaPct: (m.diferencia_litros / m.cantidad) * 100,
    }));

    return CombustibleService.calibrar(
      puntos.map((p) => p.diferenciaPct),
      puntos
    );
  }

  /** El estadístico compartido por los TRES umbrales. Estaba embebido en la
   *  sugerencia de diferencia; se factorizó al extenderlo, para no terminar
   *  con tres fórmulas distintas calibrando el mismo módulo.
   *
   *  Promedio de |x| + 2 desvíos, y NO un percentil: la migración 0066 avisa
   *  que la muestra puede estar contaminada con robos reales, y un p90
   *  fijaría el umbral A LA ALTURA del robo, dejándolo invisible la próxima
   *  vez. Ningún estadístico se blinda solo contra eso -- por eso la
   *  respuesta siempre incluye la muestra fila por fila, para que un humano
   *  la mire antes de aceptar el número.
   *
   *  El piso de 1% es ruido físico conocido: dilatación térmica más error de
   *  varilla. Por debajo de eso, el umbral alertaría por la temperatura del
   *  día.
   *
   *  MINIMO_MUESTRA = 10 para los tres. Es alto para el ciclo -- un ciclo es
   *  una carga completa de tanque, así que llegar a diez puede llevar meses
   *  -- pero bajarlo solo para ese caso sería inventar un criterio para que
   *  el número aparezca antes, que es exactamente lo que este módulo no
   *  hace. Mientras tanto queda el valor provisional del alta, que protege. */
  private static calibrar<T>(valoresPct: number[], muestra: T[]) {
    const MINIMO_MUESTRA = 10;
    const PISO_PCT = 1;

    if (valoresPct.length < MINIMO_MUESTRA) {
      return {
        muestraSuficiente: false as const,
        tamanioMuestra: valoresPct.length,
        minimoRequerido: MINIMO_MUESTRA,
      };
    }

    const abs = valoresPct.map((v) => Math.abs(v));
    const promedio = abs.reduce((a, b) => a + b, 0) / abs.length;
    const varianza = abs.reduce((acc, v) => acc + (v - promedio) ** 2, 0) / (abs.length - 1);
    const desviacion = Math.sqrt(varianza);
    const sugerido = Math.min(100, Math.max(PISO_PCT, promedio + 2 * desviacion));

    return {
      muestraSuficiente: true as const,
      tamanioMuestra: valoresPct.length,
      minimoRequerido: MINIMO_MUESTRA,
      sugerido: Number(sugerido.toFixed(1)),
      promedio: Number(promedio.toFixed(2)),
      desviacion: Number(desviacion.toFixed(2)),
      muestra,
    };
  }

  /** Umbral de descuadre POR TRAMO: un punto por cada intervalo entre dos
   *  lecturas consecutivas, medido contra la capacidad del tanque (que es la
   *  base que usa la alerta en vivo -- ver `evaluarDescuadre`). */
  async sugerirUmbralDescuadre(client: PoolClient, tenantId: string, combustibleId: number) {
    const intervalos = await this.repository.findMuestraDescuadresParaCalibracion(
      client,
      tenantId,
      combustibleId
    );

    const puntos = intervalos
      .filter((i) => i.capacidad > 0)
      .map((i) => ({
        descuadreLitros: Number(i.descuadre.toFixed(2)),
        descuadrePct: (i.descuadre / i.capacidad) * 100,
        leidoEn: i.leido_en,
      }));

    return CombustibleService.calibrar(
      puntos.map((p) => p.descuadrePct),
      puntos
    );
  }

  /** Umbral de descuadre del CICLO. La muestra es un punto por ciclo cerrado
   *  (de una recepción a la siguiente), no por lectura.
   *
   *  No hace falta volver a la base: el descuadre acumulado de un ciclo es la
   *  SUMA de los descuadres de sus intervalos -- telescopan, porque el nivel
   *  final de un intervalo es el inicial del siguiente. Un intervalo que
   *  contiene una recepción es el que abre el ciclo nuevo.
   *
   *  El ciclo en curso NO entra en la muestra: todavía puede moverse, y un
   *  ciclo a medias mediría menos acumulación de la que va a terminar
   *  teniendo, tirando la sugerencia para abajo. */
  async sugerirUmbralCiclo(client: PoolClient, tenantId: string, combustibleId: number) {
    const intervalos = await this.repository.findMuestraDescuadresParaCalibracion(
      client,
      tenantId,
      combustibleId
    );

    const ciclos: { descuadreLitros: number; capacidad: number; intervalos: number }[] = [];
    let actual: { descuadreLitros: number; capacidad: number; intervalos: number } | null = null;

    for (const i of intervalos) {
      if (i.recepciones > 0) {
        // Entró combustible: cierra el ciclo anterior y arranca uno nuevo.
        if (actual) ciclos.push(actual);
        actual = { descuadreLitros: 0, capacidad: i.capacidad, intervalos: 0 };
        continue;
      }
      if (!actual) continue; // Todavía no hubo ninguna recepción: sin ciclo que medir.
      actual.descuadreLitros += i.descuadre;
      actual.intervalos += 1;
    }
    // `actual` queda afuera a propósito: es el ciclo en curso.

    const puntos = ciclos
      .filter((c) => c.capacidad > 0 && c.intervalos > 0)
      .map((c) => ({
        descuadreLitros: Number(c.descuadreLitros.toFixed(2)),
        descuadrePct: (c.descuadreLitros / c.capacidad) * 100,
        intervalos: c.intervalos,
      }));

    return CombustibleService.calibrar(
      puntos.map((p) => p.descuadrePct),
      puntos
    );
  }

  // ── Grifos externos (migrations/0063) ───────────────────────────────

  /** Devuelve TODOS los grifos, de los dos roles -- el ABM los necesita así.
   *  El filtro por rol para cada desplegable lo hace el cliente (igual que ya
   *  hace con `activo`): el catálogo es chico y el panel lo carga entero al
   *  montar, así que partir esto en endpoints por rol no compraría nada. Lo
   *  que SÍ impide elegir el rol equivocado es `validarRolGrifo`, del lado del
   *  servidor -- ver migrations/0065. */
  listarGrifos(client: PoolClient, tenantId: string) {
    return this.repository.findGrifos(client, tenantId);
  }

  crearGrifo(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    data: CrearGrifoCombustibleInput
  ) {
    return this.repository.crearGrifo(client, tenantId, usuarioId, {
      nombre: data.nombre,
      abasteceRuta: data.abastece_ruta,
      abasteceTanque: data.abastece_tanque,
    });
  }

  actualizarGrifo(
    client: PoolClient,
    tenantId: string,
    id: number,
    data: ActualizarGrifoCombustibleInput
  ) {
    return this.repository.actualizarGrifo(client, tenantId, id, {
      nombre: data.nombre,
      activo: data.activo,
      abasteceRuta: data.abastece_ruta,
      abasteceTanque: data.abastece_tanque,
    });
  }

  /** Un grifo solo sirve para el rol con el que está marcado (migrations/0065).
   *
   *  Esto NO puede vivir solo en el filtro del desplegable: un frontend con el
   *  estado viejo en memoria, o una llamada directa a la API, adjuntarían igual
   *  el grifo del rol equivocado -- y ese es justamente el error que la
   *  migración existe para cerrar, porque es silencioso (nada falla, el costo
   *  simplemente queda atribuido al proveedor que no fue, y de ahí sale
   *  `combustible.costo_promedio`).
   *
   *  Mismo patrón que la validación de `equipos.tipo_medidor` en
   *  `validarFormaDespacho`: un cruce entre filas que ningún CHECK de la
   *  migración puede hacer, porque el dato vive en otra tabla. */
  private async validarRolGrifo(
    client: PoolClient,
    tenantId: string,
    grifoId: number,
    rol: "ruta" | "tanque"
  ) {
    const grifo = await this.repository.findGrifoPorId(client, tenantId, grifoId);
    if (!grifo) {
      throw new Error(`grifo_id ${grifoId} no existe en este tenant`);
    }
    if (rol === "ruta" && !grifo.abastece_ruta) {
      throw new Error(
        `el grifo "${grifo.nombre}" no está marcado como grifo de ruta -- marcalo en Grifos / Proveedores o elegí otro`
      );
    }
    if (rol === "tanque" && !grifo.abastece_tanque) {
      throw new Error(
        `el grifo "${grifo.nombre}" no está marcado como proveedor de tanque -- marcalo en Grifos / Proveedores o elegí otro`
      );
    }
  }

  // ── Precios de combustible (migrations/0063) ─────────────────────────

  listarPrecios(client: PoolClient, tenantId: string) {
    return this.repository.findPrecios(client, tenantId);
  }

  crearPrecio(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    data: CrearPrecioCombustibleInput
  ) {
    return this.repository.crearPrecio(client, tenantId, usuarioId, {
      tipoCombustible: data.tipo_combustible,
      combustibleId: data.combustible_id ?? null,
      grifoId: data.grifo_id ?? null,
      precioUnitario: data.precio_unitario,
      vigenteDesde: data.vigente_desde ?? new Date().toISOString(),
    });
  }

  /** Precio vigente a una fecha, para un tanque O un grifo (nunca los
   *  dos) -- el frontend lo consulta para autocompletar el C.U del
   *  despacho antes de mostrar el formulario; ver el comentario en
   *  CombustibleRepository.findPrecioVigente sobre por qué ignora los
   *  anulados. */
  obtenerPrecioVigente(
    client: PoolClient,
    tenantId: string,
    tipoCombustible: string,
    destino: { combustibleId: number | null; grifoId: number | null },
    fecha: string
  ) {
    return this.repository.findPrecioVigente(client, tenantId, tipoCombustible, destino, fecha);
  }

  getPrecioPorId(client: PoolClient, tenantId: string, id: number) {
    return this.repository.findPrecioPorId(client, tenantId, id);
  }

  /** Devuelve null si el precio no existe en este tenant o si ya estaba
   *  anulado -- mismo criterio que anularLectura: el controller distingue
   *  los dos casos con getPrecioPorId para responder 404 o 409. */
  anularPrecio(
    client: PoolClient,
    tenantId: string,
    precioId: number,
    usuarioId: string,
    motivo: string
  ) {
    return this.repository.anularPrecio(client, tenantId, precioId, usuarioId, motivo);
  }

  // ── Recepciones (Fase C, ver migrations/0064) ────────────────────────

  /** Crea la recepción y recalcula el costo promedio del tanque, todo
   *  dentro de la misma transacción (la abre `withTenant` en el
   *  controller): si el recálculo fallara, la recepción tampoco queda --
   *  nunca puede haber una recepción cuyo costo no se haya incorporado.
   *
   *  Envuelto en idempotentInsert con el mismo `modulo: "combustible"` que
   *  lecturas y despachos. Acá no es por la cola offline sino por el doble
   *  clic (ver el comentario de `cliente_uuid` en el schema): sin esto, dos
   *  envíos del mismo formulario cargarían la compra dos veces y el
   *  promedio ponderado la contaría dos veces. */
  crearRecepcion(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    data: CrearRecepcionCombustibleInput
  ) {
    return idempotentInsert({
      client,
      tenantId,
      modulo: "combustible",
      clienteUuid: data.cliente_uuid,
      insertar: async () => {
        const recibidoEn = data.recibido_en ?? new Date().toISOString();
        await this.validarRecepcion(client, tenantId, data, recibidoEn);

        const fila = await this.repository.crearRecepcion(client, tenantId, usuarioId, {
          combustibleId: data.combustible_id,
          grifoId: data.grifo_id,
          cantidad: data.cantidad,
          costoUnitario: data.costo_unitario,
          tipoDocumento: data.tipo_documento ?? null,
          numeroDocumento: data.numero_documento ?? null,
          recibidoEn,
        });

        await this.repository.recalcularCostoPromedio(client, tenantId, data.combustible_id);
        return { id: Number(fila.id), fila };
      },
      recuperar: (filaId) => this.repository.findRecepcionPorId(client, tenantId, filaId),
    });
  }

  /** Las tres reglas que dependen de otra fila, así que Zod (que solo ve el
   *  body) no las puede validar. Todas responden 400: son datos que se
   *  contradicen a sí mismos o a la configuración del propio tanque que el
   *  request referenció -- corregibles en el momento, mismo criterio que el
   *  punto 5 de docs/architecture/control-de-combustible.md.
   *
   *  1. El tanque tiene que existir en este tenant.
   *  2. El documento (factura/guía) es obligatorio o no según
   *     `combustible.requiere_documento` de ESE tanque -- por eso el campo
   *     es nullable en la base y opcional en Zod (ver migrations/0064).
   *  3. La capacidad, con el margen de tolerancia del tanque. Y para poder
   *     chequearla hace falta saber cuánto había: si no hay lectura vigente
   *     a esa fecha, la recepción se rechaza en vez de adivinar. */
  private async validarRecepcion(
    client: PoolClient,
    tenantId: string,
    data: CrearRecepcionCombustibleInput,
    recibidoEn: string
  ) {
    const tanque = await this.repository.findTanqueParaRecepcion(
      client,
      tenantId,
      data.combustible_id
    );
    if (!tanque) {
      throw new Error(`combustible_id ${data.combustible_id} no existe en este tenant`);
    }

    // El grifo tiene que estar marcado como proveedor de TANQUE
    // (migrations/0065) -- un grifo de ruta no es quien manda la cisterna.
    // Va antes de las demás validaciones porque es la que más caro sale
    // equivocarse: el costo quedaría atribuido al proveedor que no fue.
    await this.validarRolGrifo(client, tenantId, data.grifo_id, "tanque");

    if (tanque.requiere_documento && data.tipo_documento === undefined) {
      throw new Error(
        "este tanque exige factura o guía de remisión para registrar una recepción -- cargá el documento, o desactivá la exigencia en la ficha del tanque"
      );
    }

    // Sin nivel medido no se puede ni validar la capacidad ni ponderar el
    // costo. Devolver 0 sería mentir: la migración 0059 estableció que un
    // tanque sin lectura vigente tiene nivel DESCONOCIDO, no cero -- y
    // valorizar sobre un cero inventado deja el inventario mal costeado sin
    // que nadie se entere. Pedir la lectura primero es 30 segundos de
    // trabajo y es coherente con todo el módulo: la varilla manda.
    const nivelMedido = await this.repository.findNivelVigenteA(
      client,
      tenantId,
      data.combustible_id,
      recibidoEn
    );
    if (nivelMedido === null) {
      throw new Error(
        "el tanque no tiene ninguna lectura vigente anterior a la fecha de la recepción -- registrá primero la lectura de varilla"
      );
    }

    const capacidad = Number(tanque.capacidad_total);
    const toleranciaPct = Number(tanque.tolerancia_capacidad_pct);
    const techo = capacidad * (1 + toleranciaPct / 100);
    const totalTrasRecepcion = nivelMedido + data.cantidad;

    if (totalTrasRecepcion > techo) {
      // El mensaje incluye los tres números porque el operario tiene que
      // poder ver de un vistazo cuál está mal: puede ser la cantidad
      // tipeada, o una lectura vieja que ya no refleja lo que hay.
      const detalleTolerancia =
        toleranciaPct > 0 ? ` + ${toleranciaPct}% de tolerancia (${techo.toFixed(2)})` : "";
      throw new Error(
        `la recepción de ${data.cantidad} sobre un nivel medido de ${nivelMedido} supera la capacidad del tanque (${capacidad}${detalleTolerancia})`
      );
    }
  }

  listarRecepciones(
    client: PoolClient,
    tenantId: string,
    filtros: { combustibleId?: number },
    paginacion: Paginacion
  ) {
    return this.repository.findRecepciones(client, tenantId, filtros, paginacion);
  }

  getRecepcionPorId(client: PoolClient, tenantId: string, id: number) {
    return this.repository.findRecepcionPorId(client, tenantId, id);
  }

  /** Devuelve null si la recepción no existe en este tenant o si ya estaba
   *  anulada -- mismo criterio que anularLectura/anularPrecio: el controller
   *  distingue los dos casos para responder 404 o 409. El recálculo del
   *  costo promedio va adentro (ver el repository). */
  anularRecepcion(
    client: PoolClient,
    tenantId: string,
    recepcionId: number,
    usuarioId: string,
    motivo: string
  ) {
    return this.repository.anularRecepcion(client, tenantId, recepcionId, usuarioId, motivo);
  }
}
