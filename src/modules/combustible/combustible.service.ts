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
  CrearConteoUreaInput,
  CrearPuntoPrecintoInput,
  CambiarPrecintoInput,
} from "../../server/schemas/combustible.schema";
import type { MoverDeGrifoInput } from "../../server/schemas/sedes.schema";
import { FACTOR_LITROS_UREA } from "../../server/schemas/combustible.schema";
import type { UsuarioPayload } from "../../server/services/auth.service";
import { idempotentInsert } from "../../server/shared/utils/idempotentInsert";
import { CombustibleRepository } from "./combustible.repository";
import type { PeriodoHistorial } from "./combustible.repository";
import { EquiposRepository } from "../equipos/equipos.repository";
import {
  listarMovimientosDeGrifo,
  motivoFaltaGrifo,
  moverDeGrifo,
} from "../../server/services/sedes.service";

/** Un tramo de la muestra de calibración, tal como lo devuelve el repositorio. */
type IntervaloCalibracion = Awaited<
  ReturnType<CombustibleRepository["findMuestraDescuadresParaCalibracion"]>
>[number];

/** Resumen del consumo anterior a la primera varilla, o null si no hay. */
function resumirHistorico(
  filas: {
    historico: boolean;
    anulada: boolean;
    entrada: number;
    salida: number;
    ocurrido_en: Date;
  }[]
) {
  const h = filas.filter((f) => f.historico && !f.anulada);
  if (h.length === 0) return null;
  const fechas = h.map((f) => new Date(f.ocurrido_en).getTime());
  return {
    movimientos: h.length,
    litros_salida: Number(h.reduce((a, f) => a + f.salida, 0).toFixed(2)),
    litros_entrada: Number(h.reduce((a, f) => a + f.entrada, 0).toFixed(2)),
    desde: new Date(Math.min(...fechas)).toISOString(),
    hasta: new Date(Math.max(...fechas)).toISOString(),
  };
}

export class CombustibleService {
  private repository = new CombustibleRepository();

  async getAll(client: PoolClient, tenantId: string) {
    return this.repository.findAll(client, tenantId);
  }

  async getById(client: PoolClient, tenantId: string, id: number) {
    return this.repository.findById(client, tenantId, id);
  }

  async create(client: PoolClient, tenantId: string, data: CrearTanqueCombustibleInput) {
    // Con más de un grifo interno, el tanque tiene que decir en cuál está
    // (0097). La base también lo rechaza, pero con un error de trigger.
    const falta = await motivoFaltaGrifo(client, tenantId, data.grifo_interno_id, "tanque");
    if (falta) throw new Error(falta);
    return this.repository.create(client, tenantId, data);
  }

  findDespachadoEntre(
    client: PoolClient,
    tenantId: string,
    desde: string,
    hasta: string,
    combustibleId?: number | null
  ) {
    return this.repository.findDespachadoEntre(client, tenantId, desde, hasta, combustibleId);
  }

  findSegregacion(client: PoolClient, tenantId: string, desde: string, hasta: string) {
    return this.repository.findSegregacion(client, tenantId, desde, hasta);
  }

  findDescuadreEntre(
    client: PoolClient,
    tenantId: string,
    desde: string,
    hasta: string,
    combustibleId?: number | null
  ) {
    return this.repository.findDescuadreEntre(client, tenantId, desde, hasta, combustibleId);
  }

  findEstadoVigilancia(client: PoolClient, tenantId: string) {
    return this.repository.findEstadoVigilancia(client, tenantId);
  }

  tieneMovimientos(client: PoolClient, tenantId: string, id: number) {
    return this.repository.tieneMovimientos(client, tenantId, id);
  }

  async update(
    client: PoolClient,
    tenantId: string,
    id: number,
    data: ActualizarTanqueCombustibleInput
  ) {
    await this.validarCambioDeUnidad(client, tenantId, id, data.unidad);
    return this.repository.update(client, tenantId, id, data);
  }

  /** CAMBIAR LA UNIDAD DE UN TANQUE CON HISTORIAL NO SE PERMITE.
   *
   *  Es el hallazgo más potente de la tercera auditoría adversaria, y el que
   *  menos parecía un control. Pasar un tanque de `L` a `gal` con un PUT
   *  devolvía 200, no se auditaba como aflojamiento y no avisaba a nadie --
   *  pero:
   *
   *  1. La capacidad no se convierte: el 20.000 que significaba litros pasa a
   *     significar GALONES, o sea 75.708 L. Y como los cuatro umbrales son
   *     porcentaje de la capacidad, TODAS las bandas se multiplican por
   *     3,785 de golpe. Un umbral del 1% pasa de tolerar 200 L a tolerar 757.
   *  2. Todo el historial se reinterpreta. Los despachos guardados en litros
   *     se leen como galones al convertir (ver findAcumuladoDiario), así que
   *     el techo diario también se ensancha ×3,785.
   *
   *  Comprobado en la simulación: con el techo en 500 L, después de cambiar
   *  la unidad se despacharon 400 "gal" (1.514 L reales) sin una sola alerta.
   *
   *  Por qué se BLOQUEA en vez de pedir motivo, que es lo que se hizo con los
   *  umbrales: porque no hay un cambio legítimo que hacer. Cambiar la unidad
   *  no CONVIERTE nada -- reinterpreta miles de filas ya escritas, y la única
   *  conversión correcta sería reescribir el historial, que es justo lo que
   *  un módulo anti-fraude nunca debe hacer. Si de verdad se cargó el tanque
   *  con la unidad equivocada, el camino es un tanque nuevo bien cargado.
   *
   *  Mientras el tanque NO tiene movimientos sí se puede: ahí es corregir un
   *  tipeo recién hecho, no reinterpretar nada. */
  private async validarCambioDeUnidad(
    client: PoolClient,
    tenantId: string,
    id: number,
    unidadNueva: string
  ) {
    const actual = await this.repository.findById(client, tenantId, id);
    if (!actual || actual.unidad === unidadNueva) return;

    if (await this.repository.tieneMovimientos(client, tenantId, id)) {
      throw new Error(
        `no se puede cambiar la unidad de ${actual.unidad} a ${unidadNueva}: el tanque ya tiene ` +
          `movimientos registrados en ${actual.unidad} y cambiarla reinterpretaría todo ese ` +
          `historial (capacidad, umbrales y topes incluidos). Si la unidad quedó mal cargada, ` +
          `dá de alta el tanque de nuevo con la unidad correcta.`
      );
    }
  }

  /** TODO cambio de ficha, con sus valores. La otra mitad de la regla.
   *
   *  ── Por qué existe ────────────────────────────────────────────────────
   *
   *  `evaluarAflojamiento` mantiene A MANO la lista de qué campo es un
   *  control. Eso funcionó mientras la lista estuvo completa, pero las tres
   *  auditorías adversarias encontraron lo mismo tres veces: un campo que
   *  nadie había clasificado como control, y que por eso se editaba dejando
   *  `{ combustibleId }` en la auditoría -- ni qué cambió, ni de cuánto a
   *  cuánto. Pasó con la capacidad del tanque, con la unidad, con la
   *  tolerancia y con `activo`.
   *
   *  El problema no era la lista: era el DEFECTO. Un campo sin clasificar
   *  nacía invisible.
   *
   *  Acá se invierte: **la visibilidad es automática, la escalada es
   *  declarada.** Todo campo que cambia queda registrado con su valor viejo y
   *  nuevo, sin que nadie tenga que acordarse. Los que además exigen motivo y
   *  mandan correo siguen siendo una lista explícita
   *  (`evaluarAflojamiento`) -- eso SÍ tiene que decidirlo una persona,
   *  porque frenar un formulario y despertar a gerencia no puede ser
   *  automático.
   *
   *  Consecuencia práctica: el próximo campo que se le agregue al tanque
   *  nace auditado con sus valores. Si además es un control, hay que
   *  clasificarlo; si nadie lo hace, al menos se ve QUÉ cambió. */
  diffFicha(
    antes: Record<string, unknown>,
    ahora: ActualizarTanqueCombustibleInput
  ): { campo: string; de: string; a: string }[] {
    // `nivel_actual` no está: no se edita por acá (va por /lecturas).
    // `motivo_ajuste` tampoco: es el motivo del cambio, no un dato del tanque.
    const CAMPOS = [
      "codigo",
      "tanque_nombre",
      "tipo_combustible",
      "unidad",
      "tipo_punto",
      "ubicacion",
      "capacidad_total",
      "nivel_minimo",
      "moneda",
      "activo",
      "tolerancia_capacidad_pct",
      "requiere_documento",
      "umbral_diferencia_pct",
      "umbral_descuadre_pct",
      "umbral_descuadre_ciclo_pct",
      "umbral_descuadre_ventana_pct",
      "usa_totalizador",
      "totalizador_tolerancia",
      "usa_precintos",
    ] as const;

    const cambios: { campo: string; de: string; a: string }[] = [];

    for (const campo of CAMPOS) {
      const viejo = (antes as Record<string, unknown>)[campo];
      const nuevo = (ahora as unknown as Record<string, unknown>)[campo];
      // Opcionales en el PUT: omitirlos conserva el valor, no es un cambio.
      if (
        (campo === "usa_totalizador" ||
          campo === "totalizador_tolerancia" ||
          campo === "usa_precintos") &&
        nuevo === undefined
      ) {
        continue;
      }

      // NUMERIC vuelve de Postgres como string ("20000.00"), así que
      // comparar crudo marcaría como cambio lo que no cambió. Se comparan
      // como números cuando los dos lo son.
      const numViejo = viejo === null || viejo === "" ? null : Number(viejo);
      const numNuevo = nuevo === null || nuevo === undefined ? null : Number(nuevo);
      const sonNumeros =
        numViejo !== null &&
        numNuevo !== null &&
        !Number.isNaN(numViejo) &&
        !Number.isNaN(numNuevo);

      const iguales = sonNumeros
        ? numViejo === numNuevo
        : (viejo ?? null) === (nuevo ?? null) || String(viejo ?? "") === String(nuevo ?? "");
      if (iguales) continue;

      cambios.push({
        campo,
        de: viejo === null || viejo === undefined ? "(vacío)" : String(viejo),
        a: nuevo === null || nuevo === undefined ? "(vacío)" : String(nuevo),
      });
    }

    return cambios;
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
      umbral_descuadre_ventana_pct: string | null;
      requiere_documento: boolean;
      capacidad_total: string;
      nivel_minimo: string;
      tolerancia_capacidad_pct: string;
      activo: boolean;
      tipo_combustible: string;
      usa_totalizador?: boolean;
      usa_precintos?: boolean;
    },
    ahora: ActualizarTanqueCombustibleInput,
    /** Si el tanque ya tiene historial. Lo resuelve el controlador porque es
     *  una consulta y esto es una comparación pura. Solo cambia el criterio
     *  del tipo de combustible: en un tanque vacío y sin usar, cambiarlo es
     *  terminar de darlo de alta. */
    tieneMovimientos = false
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
      [
        "umbral_descuadre_ventana_pct",
        "Umbral acumulado de la ventana",
        antes.umbral_descuadre_ventana_pct,
        ahora.umbral_descuadre_ventana_pct,
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

    // SUBIR LA TOLERANCIA DE CAPACIDAD. No es cosmética: es el techo real
    // para aceptar una recepción (ver validarFormaRecepcion). Con 90%,
    // alguien puede declarar que entraron 38.000 L en un tanque de 20.000.
    // La 3ª auditoría la encontró pasando como edición común.
    const toleranciaAntes = Number(antes.tolerancia_capacidad_pct);
    if (ahora.tolerancia_capacidad_pct > toleranciaAntes) {
      cambios.push({
        control: "Tolerancia de capacidad (acepta recepciones más grandes)",
        de: `${toleranciaAntes}%`,
        a: `${ahora.tolerancia_capacidad_pct}%`,
      });
    }

    // DESACTIVAR EL TANQUE POR PUT. El DELETE exige motivo y avisa desde el
    // PR de las fechas y la baja; `activo` es además un campo del PUT, y por
    // ahí no pedía nada. Mismo acto, misma consecuencia --el tanque sale del
    // aviso por falta de medición-- así que mismo trato, entre por donde
    // entre.
    if (antes.activo && !ahora.activo) {
      cambios.push({
        control: "Tanque activo (sale de la vigilancia por falta de medición)",
        de: "activo",
        a: "desactivado",
      });
    }

    // CAMBIAR EL TIPO DE COMBUSTIBLE DE UN TANQUE CON HISTORIAL. A diferencia
    // de la unidad --que se BLOQUEA porque multiplica por 3,785 todas las
    // bandas-- esto no mueve ningún número: el despacho guarda su propio
    // tipo. Lo que rompe es el significado del registro: quedan vales de
    // diésel colgando de un tanque que ahora dice gasolina, y el kardex suma
    // entradas y salidas a través del cambio como si nada. Por eso escala en
    // vez de bloquear.
    if (tieneMovimientos && antes.tipo_combustible !== ahora.tipo_combustible) {
      cambios.push({
        control: "Tipo de combustible (el tanque ya tiene movimientos)",
        de: antes.tipo_combustible,
        a: ahora.tipo_combustible,
      });
    }

    // Apagar el totalizador es apagar el segundo testigo independiente de la
    // varilla: afloja la vigilancia como cualquier umbral.
    if (antes.usa_totalizador && ahora.usa_totalizador === false) {
      cambios.push({
        control: "Totalizador del surtidor en cada vale",
        de: "exigido",
        a: "no exigido",
      });
    }

    // Apagar los precintos (0095) deja de verificar el sello en cada varilla:
    // la boca y el drenaje vuelven a poder abrirse sin que nadie se entere.
    if (antes.usa_precintos && ahora.usa_precintos === false) {
      cambios.push({
        control: "Precintos verificados en cada varilla",
        de: "exigidos",
        a: "no exigidos",
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
    // La misma regla que el alta de a uno, fila por fila, antes de insertar
    // nada: una planilla a medias es peor que una rechazada entera.
    const grifos = new Set(items.map((i) => i.grifo_interno_id));
    for (const grifo of grifos) {
      const falta = await motivoFaltaGrifo(client, tenantId, grifo, "tanque");
      if (falta) {
        const codigos = items.filter((i) => i.grifo_interno_id === grifo).map((i) => i.codigo);
        throw new Error(`${falta} (filas: ${codigos.slice(0, 10).join(", ")})`);
      }
    }
    return this.repository.createBulk(client, tenantId, items);
  }

  /** Mover el tanque a otro grifo interno (0097). Null si el tanque no existe
   *  en esta empresa. */
  moverDeGrifo(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    id: number,
    data: MoverDeGrifoInput
  ) {
    return moverDeGrifo(client, tenantId, {
      tabla: "combustible",
      id,
      grifoDestinoId: data.grifo_interno_id,
      motivo: data.motivo,
      usuarioId,
    });
  }

  listarMovimientosDeGrifo(client: PoolClient, tenantId: string, id: number) {
    return listarMovimientosDeGrifo(client, tenantId, "combustible_id", id);
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
    paginacion: Paginacion,
    periodo: PeriodoHistorial = {}
  ) {
    return this.repository.findLecturas(client, tenantId, combustibleId, paginacion, periodo);
  }

  /** Devuelve `creado: false` cuando esta lectura ya se había registrado con
   *  el mismo `cliente_uuid` -- el reintento de un envío cuya respuesta se
   *  perdió. El controller usa ese flag para no publicar el evento de nuevo.
   *  Sin `cliente_uuid` en el body, se comporta igual que antes: siempre
   *  crea. */
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
        const leidoEn = data.leido_en ?? new Date().toISOString();
        const totalizadores = await this.resolverTotalizadoresDeLectura(
          client,
          tenantId,
          data.combustible_id,
          leidoEn,
          data
        );
        // Antes del INSERT: un precinto que falta es un 400, y la varilla no
        // tiene que quedar guardada a medias.
        const verificaciones = await this.prepararVerificacionPrecintos(
          client,
          tenantId,
          data.combustible_id,
          leidoEn,
          data.precintos
        );
        const fila = await this.repository.registrarLectura(client, tenantId, {
          combustibleId: data.combustible_id,
          nivel: data.nivel,
          leidoEn,
          usuarioId,
          metadata: data.metadata ?? {},
        });
        let respuesta = fila;
        if (totalizadores.length > 0) {
          await this.repository.insertarTotalizadoresDeLectura(
            client,
            tenantId,
            Number(fila.lectura.id),
            totalizadores
          );
          // Se relee para que la respuesta traiga lo leído (el
          // `totalizador_lectura` que usan la pantalla y los tests de 0096).
          respuesta =
            (await this.repository.findLecturaConTanque(
              client,
              tenantId,
              Number(fila.lectura.id)
            )) ?? fila;
        }
        if (verificaciones.length > 0) {
          await this.repository.insertarVerificacionesPrecinto(
            client,
            tenantId,
            Number(fila.lectura.id),
            verificaciones
          );
        }
        return { id: Number(fila.lectura.id), fila: respuesta };
      },
      recuperar: (filaId) => this.repository.findLecturaConTanque(client, tenantId, filaId),
    });
  }

  /** Lo que la varilla leyó en cada surtidor del tanque (0096, 0098).
   *
   *  - Cada surtidor que alimentaba al tanque AL MOMENTO DE MEDIR, activo y con
   *    la casilla del totalizador, es OBLIGATORIO. Dejarlo opcional sería
   *    dejar que quien mide no lo anote, y el hueco de "después del último
   *    vale" seguiría abierto.
   *  - Sin ninguno así, lo que venga se IGNORA en vez de rechazar: es la
   *    varilla que se cargó sin red cuando el control estaba prendido y llega
   *    después de apagarlo (mismo criterio que los precintos).
   *  - `totalizador_lectura` (el campo de 0096) sigue valiendo cuando hay UN
   *    solo surtidor con totalizador: es lo que manda la app vieja que quedó
   *    en el caché del celular. Con varios no se puede saber de cuál es.
   *
   *  Un tanque que no existe lo rechaza registrarLectura con su propio 400. */
  private async resolverTotalizadoresDeLectura(
    client: PoolClient,
    tenantId: string,
    combustibleId: number,
    leidoEn: string,
    data: Pick<RegistrarLecturaCombustibleInput, "totalizadores" | "totalizador_lectura">
  ): Promise<{ surtidorId: number; valor: number }[]> {
    const tanque = await this.repository.findById(client, tenantId, combustibleId);
    if (!tanque) return [];
    const { surtidores } = await this.repository.findSurtidoresDelTanqueEn(
      client,
      tenantId,
      combustibleId,
      leidoEn
    );
    const conTotalizador = surtidores.filter((s) => s.activo && s.usa_totalizador);
    if (conTotalizador.length === 0) return [];

    let dados = data.totalizadores;
    if (dados === undefined && data.totalizador_lectura !== undefined) {
      if (conTotalizador.length !== 1) {
        throw new Error(
          `el tanque ${tanque.codigo} usa totalizador en ${conTotalizador.length} surtidores: ` +
            `anotá la lectura de cada uno`
        );
      }
      dados = [{ surtidor_id: conTotalizador[0].id, valor: data.totalizador_lectura }];
    }
    const porSurtidor = new Map((dados ?? []).map((d) => [d.surtidor_id, d.valor]));
    for (const id of porSurtidor.keys()) {
      if (!surtidores.some((s) => s.id === id)) {
        throw new Error(`el surtidor ${id} no alimenta a este tanque`);
      }
    }
    const faltan = conTotalizador.filter((s) => !porSurtidor.has(s.id));
    if (faltan.length > 0) {
      throw new Error(
        `el tanque ${tanque.codigo} usa totalizador: anotá la lectura del totalizador de ` +
          faltan.map((s) => `"${s.nombre}"`).join(", ") +
          ` al medir`
      );
    }
    return conTotalizador.map((s) => ({ surtidorId: s.id, valor: porSurtidor.get(s.id)! }));
  }

  /** De qué surtidor sale un vale de tanque propio (0098), y si tiene que
   *  traer el totalizador.
   *
   *  - Con `surtidor_id`: tiene que haber alimentado al tanque EN LA FECHA DEL
   *    VALE (la conexión tiene historia: un vale sin red que llega tarde se
   *    valida contra la de su día).
   *  - Sin él: el único surtidor del tanque a esa fecha. Con más de uno, el
   *    vale tiene que decir de cuál salió.
   *  - Un tanque que NUNCA tuvo surtidor (insertado por SQL, backup viejo): la
   *    base le crea el suyo al insertar el vale, con la casilla del tanque.
   *
   *  El totalizador es OBLIGATORIO si ese surtidor lo usa (dejarlo opcional
   *  sería dejar que el que oculta una salida no lo anote) y un error de forma
   *  si no lo usa. Devuelve el id, o null si lo va a crear la base. */
  private async resolverSurtidorDelVale(
    client: PoolClient,
    tenantId: string,
    data: CrearDespachoCombustibleInput,
    despachadoEn: string
  ): Promise<number | null> {
    if (data.producto !== "combustible" || data.origen !== "tanque_propio") return null;
    const tanque = await this.repository.findById(client, tenantId, data.combustible_id!);
    if (!tanque) return null;
    const { surtidores, algunaVez } = await this.repository.findSurtidoresDelTanqueEn(
      client,
      tenantId,
      data.combustible_id!,
      despachadoEn
    );

    let surtidor: { id: number; nombre: string; usa_totalizador: boolean } | null;
    if (data.surtidor_id !== undefined) {
      surtidor = surtidores.find((x) => x.id === data.surtidor_id) ?? null;
      if (!surtidor) {
        throw new Error(
          `el surtidor indicado no alimentaba al tanque ${tanque.codigo} en la fecha del vale`
        );
      }
    } else if (surtidores.length === 1) {
      surtidor = surtidores[0];
    } else if (surtidores.length === 0 && !algunaVez) {
      surtidor = null;
    } else if (surtidores.length === 0) {
      throw new Error(
        `el tanque ${tanque.codigo} no tenía ningún surtidor conectado en la fecha del vale`
      );
    } else {
      throw new Error(`el tanque ${tanque.codigo} tiene más de un surtidor: indicá de cuál salió`);
    }

    // Sin surtidor (el tanque nunca tuvo uno), la base le crea uno sin la
    // casilla del totalizador.
    const usa = surtidor ? surtidor.usa_totalizador : false;
    const nombre = surtidor?.nombre ?? `Surtidor ${tanque.codigo}`;
    if (usa && data.totalizador_lectura === undefined) {
      throw new Error(
        `el tanque ${tanque.codigo} usa totalizador: anotá la lectura del totalizador de "${nombre}"`
      );
    }
    if (!usa && data.totalizador_lectura !== undefined) {
      throw new Error(
        `el tanque ${tanque.codigo} no usa totalizador en "${nombre}" -- activalo en el surtidor o quitá la lectura`
      );
    }
    return surtidor?.id ?? null;
  }

  // ── Despachos (Fase B) ───────────────────────────────────────────────

  /** Qué tipo de despacho puede registrar cada rol (migración 0085).
   *
   *  Existe porque `requireRole` no alcanza: el vale del tanque propio y la
   *  compra en grifo de ruta entran por el MISMO endpoint
   *  (POST /despachos) y se distinguen por el campo `origen` del body.
   *  Un middleware que decide por ruta no puede separarlos, así que sin esto
   *  el `conductor_ruta` --que solo debería poder cargar en grifos externos--
   *  podría despachar del tanque de la empresa, y el rol parecería
   *  restringido sin serlo.
   *
   *  Es una función pura y sin acceso a base a propósito: se ejecuta ANTES de
   *  abrir la transacción, y así se puede probar el reparto de permisos sin
   *  levantar medio módulo.
   *
   *  Los roles de oficina (admin, operador) pueden los dos orígenes: son los
   *  que cargan lo que llega en papel desde cualquiera de los dos circuitos.
   *
   *  Devuelve el motivo del rechazo, o null si está permitido. */
  motivoOrigenNoPermitido(
    rol: UsuarioPayload["rol"],
    origen: "tanque_propio" | "compra_externa"
  ): string | null {
    if (rol === "grifero" && origen !== "tanque_propio") {
      return "Tu usuario registra vales del tanque, no compras en grifos de ruta";
    }
    if (rol === "conductor_ruta" && origen !== "compra_externa") {
      return "Tu usuario registra compras en grifos de ruta, no despachos del tanque";
    }
    return null;
  }

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
        if (
          await this.repository.existeVale(
            client,
            tenantId,
            data.producto,
            data.serie_talonario,
            data.n_vale
          )
        ) {
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

        await this.validarSaltoDeTalonario(
          client,
          tenantId,
          data.producto,
          data.serie_talonario,
          data.n_vale
        );

        await this.validarFormaDespacho(client, tenantId, data);

        const despachadoEn = data.despachado_en ?? new Date().toISOString();
        const esUrea = data.producto === "urea";

        // UREA: la cantidad en litros NUNCA la tipea el cargador -- el
        // servidor la calcula (bultos × factor de la presentación) y
        // congela el factor usado en la fila (ver FACTOR_LITROS_UREA en el
        // schema y el encabezado de la migración 0092). El costo, si no
        // vino en el vale, se deriva promediando las recepciones vigentes.
        const factorLitros = esUrea ? FACTOR_LITROS_UREA[data.presentacion!] : null;
        const cantidad = esUrea ? data.cantidad_bultos! * factorLitros! : data.cantidad!;

        // EL COSTO DEL VALE DEL TANQUE PROPIO LO PONE EL SERVIDOR.
        //
        // Venía tal cual del body, también en tanque_propio, así que cualquiera
        // podía declarar S/ 0,01 por litro y dejar sin sentido el costo por
        // equipo, por centro de costo y el kardex valorizado -- sin tocar un
        // solo litro. El precio de un litro del tanque no es un dato del vale:
        // es el precio vigente del catálogo o, si no hay, el costo promedio
        // ponderado del propio tanque (Fase C).
        //
        // Si no hay ninguno de los dos (tanque nuevo, sin compras ni catálogo)
        // se respeta lo que vino: es el único caso en que el cargador sabe
        // más que el sistema.
        const costoUnitario = esUrea
          ? (data.costo_unitario ?? (await this.resolverCostoUrea(client, tenantId, despachadoEn)))
          : data.origen === "tanque_propio"
            ? await this.resolverCostoDelTanque(
                client,
                tenantId,
                data.combustible_id!,
                data.tipo_combustible!,
                despachadoEn,
                data.costo_unitario!
              )
            : data.costo_unitario!;

        const surtidorId = await this.resolverSurtidorDelVale(client, tenantId, data, despachadoEn);

        const fila = await this.repository.crearDespacho(client, tenantId, usuarioId, {
          producto: data.producto,
          origen: data.origen,
          combustibleId: data.combustible_id ?? null,
          grifoId: data.grifo_id ?? null,
          tipoCombustible: esUrea ? null : data.tipo_combustible!,
          tipoDestino: data.tipo_destino,
          equipoId: data.equipo_id ?? null,
          serieTalonario: data.serie_talonario,
          nVale: data.n_vale,
          cantidad,
          lecturaContometro: data.lectura_contometro ?? null,
          totalizadorLectura: data.totalizador_lectura ?? null,
          surtidorId,
          lecturaHorometro: data.lectura_horometro ?? null,
          lecturaOdometro: data.lectura_odometro ?? null,
          horasAbastecidas: data.horas_abastecidas ?? null,
          presentacion: esUrea ? data.presentacion! : null,
          factorLitros,
          cantidadBultos: esUrea ? data.cantidad_bultos! : null,
          costoUnitario,
          observaciones: data.observaciones ?? null,
          despachadoEn,
        });
        return { id: Number(fila.id), fila };
      },
      recuperar: (filaId) => this.repository.findDespachoPorId(client, tenantId, filaId),
    });
  }

  /** Cuánto puede saltar el número de vale respecto del último de su serie.
   *
   *  300 es holgado para la operación real --un talonario tiene 50 o 100
   *  vales, y dos talonarios de la misma serie usados en paralelo se cruzan
   *  por decenas-- y corta en seco el error de tipeo que genera miles de
   *  alertas: un 1234 que se escribe 12340 salta 11.106 números.
   *
   *  Por qué acá SÍ se bloquea, si la regla del módulo es "alertar, no
   *  bloquear": porque el daño no es una alerta de más, es el control entero.
   *  Cada número salteado genera su propia alerta de hueco, y a las 72 h cada
   *  una se congela como anomalía permanente. Un dígito de más deja 11.000
   *  hallazgos que nadie va a revisar -- y entre esos se pierde el hueco real.
   *  Verificado en la 5ª auditoría: UN vale con n=5001 creó 5.000 alertas.
   *
   *  El mensaje dice qué hacer, porque quien lo lee está en cancha: si el
   *  número es correcto (talonario nuevo que arranca mucho más arriba), la
   *  serie es otra y se carga como serie nueva. */
  static readonly MAX_SALTO_TALONARIO = 300;

  private async validarSaltoDeTalonario(
    client: PoolClient,
    tenantId: string,
    producto: string,
    serieTalonario: string,
    nVale: number
  ) {
    const maximo = await this.repository.findMaxNValeDeSerie(
      client,
      tenantId,
      producto,
      serieTalonario
    );
    if (maximo === null) return; // Primer vale de la serie: no hay contra qué comparar.
    const salto = nVale - maximo;
    if (salto <= CombustibleService.MAX_SALTO_TALONARIO) return;
    throw new Error(
      `el vale ${nVale} salta ${salto - 1} números desde el último cargado de la serie ` +
        `${serieTalonario} (${maximo}). Revisá el número: un dígito de más deja miles de vales ` +
        `marcados como faltantes. Si el talonario realmente arranca en ${nVale}, cargalo como una ` +
        `serie nueva`
    );
  }

  /** El precio de un litro que sale del tanque propio: catálogo vigente a la
   *  fecha del vale, si no el costo promedio ponderado del tanque, y si no lo
   *  declarado. Ver el comentario en crearDespacho. */
  private async resolverCostoDelTanque(
    client: PoolClient,
    tenantId: string,
    combustibleId: number,
    tipoCombustible: string,
    fecha: string,
    declarado: number
  ): Promise<number> {
    const precio = await this.repository.findPrecioVigente(
      client,
      tenantId,
      tipoCombustible,
      { combustibleId, grifoId: null },
      fecha
    );
    if (precio) return Number(precio.precio_unitario);

    const tanque = await this.repository.findById(client, tenantId, combustibleId);
    const promedio = tanque ? Number(tanque.costo_promedio) : 0;
    return promedio > 0 ? promedio : declarado;
  }

  /** El costo de un litro de urea que sale a un vale, cuando el vale no
   *  trae el suyo propio (ver el comentario de `costo_unitario` en el
   *  schema: para urea es opcional, es un movimiento interno, no una
   *  compra).
   *
   *  A diferencia del tanque de combustible, la urea NO tiene un costo
   *  promedio PONDERADO que se mantenga como estado (la Fase C pondera
   *  porque el combustible que ya había en el tanque se MEZCLA físicamente
   *  con el que entra; las cajas de urea no se mezclan, cada una es
   *  discreta). Se DERIVA en el momento -- promedio simple de las
   *  recepciones de urea vigentes hasta la fecha del vale -- sin guardar
   *  ninguna columna de estado mutable (mismo principio que 0059: no
   *  guardes lo que podés calcular).
   *
   *  Sin ninguna recepción todavía (urea recién arrancada, el cliente
   *  respondió "de cero" a la pregunta 18), devuelve 0 -- mismo criterio
   *  que un tanque de combustible sin costo_promedio: el kardex queda sin
   *  valorizar hasta que exista al menos una entrada real. */
  private async resolverCostoUrea(
    client: PoolClient,
    tenantId: string,
    fecha: string
  ): Promise<number> {
    const promedio = await this.repository.findCostoPromedioUrea(client, tenantId, fecha);
    return promedio ?? 0;
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
    // ── UREA: rama separada, mismo criterio que el schema ────────────────
    // Solo lo que se contradice a sí mismo bloquea acá (grifo del rol
    // equivocado, equipo inexistente) -- que el equipo NO use urea
    // (usa_urea=false) es sospechoso pero no autocontradictorio, así que
    // eso queda para el lado de las ALERTAS (evaluarUreaEquipoNoHabilitado,
    // llamado desde el controller después de confirmar la transacción,
    // mismo patrón que evaluarSobredespacho).
    if (data.producto === "urea") {
      await this.validarRolGrifo(client, tenantId, data.grifo_id!, "urea");
      const equipoId = data.equipo_id!;
      const equipo = await EquiposRepository.findTipoMedidor(client, tenantId, equipoId);
      if (!equipo) {
        throw new Error(`equipo_id ${equipoId} no existe en este tenant`);
      }
      return;
    }

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

      // El totalizador (0094) ahora es del SURTIDOR (0098): lo valida
      // resolverSurtidorDelVale, que sabe de qué surtidor salió el vale.
      if (tanque && !tanque.activo) {
        throw new Error(
          `el tanque ${tanque.codigo} está desactivado y no puede despachar -- reactivalo si sigue en uso`
        );
      }

      // DE UN TANQUE DE DIÉSEL NO SALE GASOLINA. Suena a perogrullada y el
      // sistema lo aceptaba: el vale guardaba su propio `tipo_combustible` y
      // nadie lo comparaba contra el del tanque. Lo encontró la tercera
      // auditoría adversaria.
      //
      // No es una fuga por sí solo --la cantidad igual se descuenta del
      // tanque-- pero rompe lo único que hace auditable un vale: que diga la
      // verdad. Un puñado de vales de "gasolina" saliendo del tanque de
      // diésel es una explicación lista para cualquier faltante, y el kardex
      // los suma igual sin poder distinguirlos.
      //
      // BLOQUEA, no alerta: acá no hay caso legítimo que perder. El operador
      // eligió mal en un desplegable y el mensaje se lo dice.
      if (tanque && tanque.tipo_combustible !== data.tipo_combustible) {
        throw new Error(
          `el tanque ${tanque.codigo} es de ${tanque.tipo_combustible} y el vale dice ` +
            `${data.tipo_combustible} -- corregí el tipo o elegí el tanque correcto`
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
    filtros: {
      equipoId?: number;
      serieTalonario?: string;
      origen?: string;
      producto?: string;
    } & PeriodoHistorial,
    paginacion: Paginacion
  ) {
    return this.repository.findDespachos(client, tenantId, filtros, paginacion);
  }

  /** Las tres vistas de agregación de la pestaña del cliente (Histórico ->
   *  Consumo por conductor / por vehículo / por grifo). Sin paginar, ver el
   *  porqué en el repository. `agruparPor` es opcional (día/semana/mes/año)
   *  -- sin él, una fila por entidad para todo el rango.
   *
   *  `producto` es OBLIGATORIO (no opcional con default) a propósito: las
   *  tres sumaban litros de combustible y de urea juntos porque nadie
   *  filtraba por producto (bug encontrado 2026-09-17, después de que la
   *  urea empezara a compartir `combustible_despachos`). Forzar el
   *  parámetro en vez de dejarlo opcional es lo que evita que un llamador
   *  nuevo se olvide de decidirlo -- el mismo error no puede repetirse en
   *  silencio. */
  listarConsumoPorConductor(
    client: PoolClient,
    tenantId: string,
    producto: string,
    periodo: PeriodoHistorial,
    agruparPor?: string
  ) {
    return this.repository.findConsumoPorConductor(client, tenantId, producto, periodo, agruparPor);
  }

  listarConsumoPorEquipo(
    client: PoolClient,
    tenantId: string,
    producto: string,
    periodo: PeriodoHistorial,
    agruparPor?: string
  ) {
    return this.repository.findConsumoPorEquipo(client, tenantId, producto, periodo, agruparPor);
  }

  listarConsumoPorGrifo(
    client: PoolClient,
    tenantId: string,
    producto: string,
    periodo: PeriodoHistorial,
    agruparPor?: string
  ) {
    return this.repository.findConsumoPorGrifo(client, tenantId, producto, periodo, agruparPor);
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
   *  CombustibleRepository.findHuecosTalonario. `producto` default
   *  'combustible' -- ningún llamador existente lo mandaba antes de 0092. */
  detectarHuecos(
    client: PoolClient,
    tenantId: string,
    serieTalonario: string,
    producto: string = "combustible"
  ) {
    return this.repository.findHuecosTalonario(client, tenantId, producto, serieTalonario);
  }

  // ── Alertas (migrations/0068) ─────────────────────────────────────────

  detectarHuecosRevelados(
    client: PoolClient,
    tenantId: string,
    producto: string,
    serieTalonario: string,
    despachoId: number,
    nuevoNVale: number
  ) {
    return this.repository.detectarHuecosRevelados(
      client,
      tenantId,
      producto,
      serieTalonario,
      despachoId,
      nuevoNVale
    );
  }

  resolverAlertaHuecoSiExiste(
    client: PoolClient,
    tenantId: string,
    producto: string,
    serieTalonario: string,
    nVale: number
  ) {
    return this.repository.resolverAlertaHuecoSiExiste(
      client,
      tenantId,
      producto,
      serieTalonario,
      nVale
    );
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
    filtros: { soloNoLeidas?: boolean; producto?: string },
    paginacion: Paginacion
  ) {
    return this.repository.findAlertas(client, tenantId, filtros, paginacion);
  }

  marcarAlertasLeidas(client: PoolClient, tenantId: string, ids?: number[]) {
    return this.repository.marcarAlertasLeidas(client, tenantId, ids);
  }

  /** Cerrar una alerta a mano. Devuelve además si fue AUTORREVISIÓN: el que
   *  cierra es el mismo que cargó el movimiento que la disparó.
   *
   *  No se BLOQUEA. En una operación chica puede haber un solo admin, y un
   *  sistema que no deja cerrar nada es un sistema que se apaga. Lo que sí
   *  hace falta es que quede dicho: la segregación de funciones no se
   *  resuelve con una validación, se resuelve mostrándosela a quien audita. */
  async resolverAlertaManual(
    client: PoolClient,
    tenantId: string,
    alertaId: number,
    usuarioId: string,
    motivo: string
  ) {
    // ¿El que cierra participó del hecho (lo cargó, lo anuló, midió la
    // varilla o validó la recepción)? Se resuelve ACÁ y no en el controlador
    // porque la respuesta tiene que viajar con el UPDATE: si se preguntara
    // después, ya no se sabría contra qué fila.
    const participantes = await this.repository.findParticipantesDelHecho(
      client,
      tenantId,
      alertaId
    );
    const autorevision = participantes.includes(usuarioId);

    const fila = await this.repository.resolverAlertaManual(
      client,
      tenantId,
      alertaId,
      usuarioId,
      motivo,
      autorevision
    );
    return fila ? { ...fila, autorevision } : null;
  }

  findAdminsConCombustibleHabilitado(client: PoolClient, tenantId: string) {
    return this.repository.findAdminsConCombustibleHabilitado(client, tenantId);
  }

  // ── Conciliación (migraciones 0071/0072) ──────────────────────────────

  getConfig(client: PoolClient, tenantId: string) {
    return this.repository.getConfig(client, tenantId);
  }

  /** Política del tenant: si el rol `grifero` puede tomar varilla (0085). */
  grifieroRegistraVarilla(client: PoolClient, tenantId: string) {
    return this.repository.getGrifieroRegistraVarilla(client, tenantId);
  }

  guardarConfig(
    client: PoolClient,
    tenantId: string,
    valores: {
      ventanaGraciaHoras: number;
      diasSinMedir: number;
      diasVentanaDescuadre: number;
      diasCargaRetroactiva: number;
      diasSinVigilancia: number;
      llenadosPorDiaMax: number | null;
      topeSinCapacidadL: number | null;
      grifieroRegistraVarilla: boolean;
      recepcionRequiereValidacion: boolean;
      horasParaValidarRecepcion: number;
      diasSinVarillaDeControl: number | null;
      topeDiarioUreaL: number | null;
      ratioUreaDieselMaxPct: number | null;
      diasSinConteoUrea: number;
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
      dias_ventana_descuadre: number;
      dias_carga_retroactiva: number;
      dias_sin_vigilancia: number;
      llenados_por_dia_max: number | null;
      tope_diario_sin_capacidad_l: number | null;
      grifero_registra_varilla: boolean;
      recepcion_requiere_validacion: boolean;
      horas_para_validar_recepcion: number;
      dias_sin_varilla_de_control: number | null;
      tope_diario_urea_l: number | null;
      ratio_urea_diesel_max_pct: number | null;
      dias_sin_conteo_urea: number;
    },
    ahora: {
      ventana_gracia_horas: number;
      dias_sin_medir: number;
      dias_ventana_descuadre: number;
      dias_carga_retroactiva: number;
      dias_sin_vigilancia: number;
      llenados_por_dia_max: number | null;
      tope_diario_sin_capacidad_l: number | null;
      grifero_registra_varilla: boolean;
      recepcion_requiere_validacion: boolean;
      horas_para_validar_recepcion: number;
      dias_sin_varilla_de_control: number | null;
      tope_diario_urea_l: number | null;
      ratio_urea_diesel_max_pct: number | null;
      dias_sin_conteo_urea: number;
    }
  ) {
    const cambios: { control: string; de: string; a: string }[] = [];

    // Devolverle la varilla al grifero afloja: el que despacha vuelve a ser
    // el que mide, y la medición deja de ser un control independiente del
    // despacho. No se bloquea --es una decisión legítima de la empresa, y de
    // hecho es el default-- pero apagarla y volver a prenderla no puede pasar
    // en silencio: es exactamente el movimiento que haría alguien que necesita
    // que la varilla "cuadre" con lo que declaró.
    if (ahora.grifero_registra_varilla && !antes.grifero_registra_varilla) {
      cambios.push({
        control: "Varilla a cargo del grifero",
        de: "solo admin y operador",
        a: "también el grifero",
      });
    }

    // APAGAR LA VALIDACIÓN DE RECEPCIONES es el aflojamiento más caro que
    // existe en la config: deja otra vez a una sola persona escribiendo el
    // único número que dice cuánto entró (5ª auditoría).
    if (antes.recepcion_requiere_validacion && !ahora.recepcion_requiere_validacion) {
      cambios.push({
        control: "Validación de recepciones contra la guía",
        de: "exigida",
        a: "no exigida",
      });
    }

    // Quedarse sin varilla de control: la varilla vuelve a ser cosa de quien
    // despacha, y deja de poder contradecirlo.
    if (
      antes.dias_sin_varilla_de_control !== null &&
      (ahora.dias_sin_varilla_de_control === null ||
        ahora.dias_sin_varilla_de_control > antes.dias_sin_varilla_de_control)
    ) {
      cambios.push({
        control: "Días tolerados sin varilla de control",
        de: `${antes.dias_sin_varilla_de_control} días`,
        a:
          ahora.dias_sin_varilla_de_control === null
            ? "sin configurar (no alerta)"
            : `${ahora.dias_sin_varilla_de_control} días`,
      });
    }

    const subir = [
      ["Ventana de gracia", antes.ventana_gracia_horas, ahora.ventana_gracia_horas, "h"],
      ["Días sin medir tolerados", antes.dias_sin_medir, ahora.dias_sin_medir, " días"],
      [
        "Plazo para validar una recepción",
        antes.horas_para_validar_recepcion,
        ahora.horas_para_validar_recepcion,
        "h",
      ],
    ] as const;

    // BAJAR la ventana deslizante afloja, al revés que los de arriba: mirar
    // 7 días para atrás en vez de 30 le devuelve al que roba de a poco casi
    // todo lo que 0080 le sacó -- el acumulado nunca junta lo suficiente.
    // SUBIR los días de carga retroactiva afloja: se toleran vales fechados
    // más atrás sin que nadie se entere. Va con los de arriba, no con la
    // ventana de descuadre, porque acá subir es lo que debilita.
    // Subir los días sin vigilancia deja al tanque ciego más tiempo antes de
    // que el sistema insista.
    if (ahora.dias_sin_vigilancia > antes.dias_sin_vigilancia) {
      cambios.push({
        control: "Días tolerados sin vigilancia",
        de: `${antes.dias_sin_vigilancia} días`,
        a: `${ahora.dias_sin_vigilancia} días`,
      });
    }

    if (ahora.dias_carga_retroactiva > antes.dias_carga_retroactiva) {
      cambios.push({
        control: "Días de carga retroactiva tolerados",
        de: `${antes.dias_carga_retroactiva} días`,
        a: `${ahora.dias_carga_retroactiva} días`,
      });
    }

    if (ahora.dias_ventana_descuadre < antes.dias_ventana_descuadre) {
      cambios.push({
        control: "Ventana de descuadre acumulado",
        de: `${antes.dias_ventana_descuadre} días`,
        a: `${ahora.dias_ventana_descuadre} días`,
      });
    }

    for (const [control, viejo, nuevo, sufijo] of subir) {
      if (nuevo > viejo) {
        cambios.push({ control, de: `${viejo}${sufijo}`, a: `${nuevo}${sufijo}` });
      }
    }

    // Subir los días tolerados sin conteo físico de urea afloja -- mismo
    // criterio que dias_sin_vigilancia: el reemplazo de la varilla deja de
    // insistir antes.
    if (ahora.dias_sin_conteo_urea > antes.dias_sin_conteo_urea) {
      cambios.push({
        control: "Días tolerados sin conteo físico de urea",
        de: `${antes.dias_sin_conteo_urea} días`,
        a: `${ahora.dias_sin_conteo_urea} días`,
      });
    }

    const topes = [
      ["Llenados por día por equipo", antes.llenados_por_dia_max, ahora.llenados_por_dia_max, ""],
      [
        "Tope diario sin capacidad",
        antes.tope_diario_sin_capacidad_l,
        ahora.tope_diario_sin_capacidad_l,
        " L",
      ],
      ["Tope diario de urea por equipo", antes.tope_diario_urea_l, ahora.tope_diario_urea_l, " L"],
      [
        "Ratio máximo urea/diésel",
        antes.ratio_urea_diesel_max_pct,
        ahora.ratio_urea_diesel_max_pct,
        "%",
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
  ): Promise<{
    congeladas: number;
    ventanaHoras: number;
    errores: { alertaId: string; tipo: string; error: unknown }[];
  }> {
    const ventanaHoras = await this.repository.getVentanaGraciaHoras(client, tenantId);
    const vencidas = await this.repository.findAlertasPorCongelar(client, tenantId, ventanaHoras);

    let congeladas = 0;
    const errores: { alertaId: string; tipo: string; error: unknown }[] = [];
    for (const alerta of vencidas) {
      // UN SAVEPOINT POR ALERTA. Sin esto, una sola alerta que no se pudiera
      // congelar abortaba la transacción entera -- y con ella todo lo que la
      // corrida ya había detectado para este tenant. Así pasó con los tres
      // tipos que el CHECK de anomalías no conocía (5ª auditoría, migración
      // 0086): una alerta sin revisar apagaba la alerta de "tanque sin medir".
      // Una falla puntual queda puntual: se reporta y las demás siguen.
      await client.query("SAVEPOINT congelar_alerta");
      try {
        const anomaliaId = await this.repository.congelarAlerta(
          client,
          tenantId,
          alerta,
          ventanaHoras
        );
        await client.query("RELEASE SAVEPOINT congelar_alerta");
        // null = ya estaba congelada (ON CONFLICT DO NOTHING); no la cuento
        // como trabajo nuevo para que el log no mienta.
        if (anomaliaId) congeladas++;
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT congelar_alerta");
        errores.push({ alertaId: alerta.id, tipo: alerta.tipo, error });
      }
    }
    return { congeladas, ventanaHoras, errores };
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
        // Contra lo recibido por TODO el grupo: con dos cisternas entre las
        // mismas varillas, la diferencia es de las dos (ver
        // LATERAL_DIFERENCIA_RECEPCION en el repository).
        const cantidad = Number(r.cantidad_del_grupo);
        const entregas = Number(r.entregas_en_grupo);
        return {
          tipo: "diferencia_recepcion" as const,
          recepcionId: r.id,
          combustibleId: r.combustible_id,
          detalle: {
            diferenciaLitros: litros,
            cantidadFacturada: cantidad,
            entregasCombinadas: entregas,
            recepcionesDelGrupo: r.recepciones_del_grupo.map(Number),
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

  /** EL TOTALIZADOR CONTRA LOS VALES (0094). Se evalúa DESPUÉS de crear el vale
   *  y no lo bloquea: puede ser un tipeo, pero también un medidor manipulado.
   *
   *  Por VALOR y no por hora: el vecino anterior es el vale con el mayor
   *  totalizador que no lo supera, así que un vale offline que llega tarde se
   *  ubica donde le toca. Lo único que se mira en el tiempo es el retroceso.
   *
   *  - retroceso: existe un vale ANTERIOR EN EL TIEMPO con un totalizador
   *    MAYOR. Un contador acumulativo no vuelve atrás.
   *  - salto: (totalizador − totalizador del vecino) − litros del vale. Positivo
   *    = salió combustible por el surtidor SIN vale; negativo = el vale declara
   *    más de lo que el surtidor entregó.
   *
   *  Límite conocido: si un vale intermedio llega DESPUÉS (offline), el salto
   *  que se calculó antes ya quedó alertado y se cierra a mano con motivo. Es
   *  el precio de no reescribir alertas ya emitidas.
   *
   *  Devuelve null si el tanque no usa totalizador, si el vale no lo trae o si
   *  es el primero de la cadena. */
  async evaluarTotalizador(
    client: PoolClient,
    tenantId: string,
    data: {
      despachoId: number;
      combustibleId: number | null;
      totalizador: number | null;
      cantidad: number;
      despachadoEn: string;
    }
  ) {
    if (data.combustibleId === null || data.totalizador === null) return null;
    // El surtidor lo pudo haber asignado la base (el único del tanque).
    const despacho = await this.repository.findDespachoPorId(client, tenantId, data.despachoId);
    if (!despacho?.surtidor_id) return null;
    return this.evaluarCadenaTotalizador(client, tenantId, {
      combustibleId: data.combustibleId,
      surtidorId: Number(despacho.surtidor_id),
      excluir: { tipo: "despacho", id: data.despachoId },
      totalizador: data.totalizador,
      litros: data.cantidad,
      instante: data.despachadoEn,
    });
  }

  /** LA VARILLA EN LA CADENA (0096), una vez por cada surtidor que leyó
   *  (0098). Mismo cálculo que un vale, con 0 litros: el punto anterior más
   *  cercano por valor en la cadena de ESE surtidor, y lo que avanzó desde ahí
   *  es, entero, combustible que salió por él SIN vale.
   *
   *  Cierra el hueco de "después del último vale" y es una segunda lectura
   *  independiente: la hace quien mide, no quien despacha. Devuelve una
   *  alerta por surtidor que no cierra (puede ser ninguna). */
  async evaluarTotalizadoresDeLectura(
    client: PoolClient,
    tenantId: string,
    data: { lecturaId: number; combustibleId: number; leidoEn: string }
  ) {
    const leidos = await this.repository.findTotalizadoresDeLectura(
      client,
      tenantId,
      data.lecturaId
    );
    const hallazgos = [];
    for (const l of leidos) {
      const r = await this.evaluarCadenaTotalizador(client, tenantId, {
        combustibleId: data.combustibleId,
        surtidorId: l.surtidorId,
        excluir: { tipo: "lectura", id: data.lecturaId },
        totalizador: l.valor,
        litros: 0,
        instante: data.leidoEn,
      });
      if (r) hallazgos.push({ ...r, ancla: "varilla" as const, lecturaId: data.lecturaId });
    }
    return hallazgos;
  }

  private async evaluarCadenaTotalizador(
    client: PoolClient,
    tenantId: string,
    data: {
      combustibleId: number;
      surtidorId: number;
      excluir: { tipo: "despacho" | "lectura"; id: number };
      totalizador: number;
      litros: number;
      instante: string;
    }
  ) {
    const surtidor = await this.repository.findSurtidorPorId(client, tenantId, data.surtidorId);
    if (!surtidor?.usa_totalizador) return null;
    const tanque = await this.repository.findById(client, tenantId, data.combustibleId);
    if (!tanque) return null;

    const v = await this.repository.findVecinosTotalizador(
      client,
      tenantId,
      data.surtidorId,
      data.excluir,
      data.totalizador,
      data.instante
    );
    // Lo que el correo y la pantalla necesitan para decir DE QUÉ surtidor es.
    const base = {
      tanque: tanque.codigo,
      unidad: tanque.unidad,
      surtidor: surtidor.nombre,
      surtidorId: surtidor.id,
      totalizador: data.totalizador,
    };

    if (v.retroceso_id !== null) {
      return {
        motivo: "retroceso" as const,
        ...base,
        totalizadorMayorPrevio: Number(v.retroceso_totalizador),
      };
    }
    if (v.anterior_id === null) return null;

    const avance = Number((data.totalizador - Number(v.anterior_totalizador)).toFixed(3));
    const diferencia = Number((avance - data.litros).toFixed(3));
    if (Math.abs(diferencia) <= Number(surtidor.totalizador_tolerancia)) return null;

    return {
      motivo: "salto" as const,
      ...base,
      totalizadorAnterior: Number(v.anterior_totalizador),
      avance,
      declarado: data.litros,
      diferencia,
      sobra: diferencia > 0,
    };
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

    // EL VALE SIN MEDIDOR, pudiendo tenerlo (5ª auditoría). Desde 0088 el vale
    // del tanque propio acepta horómetro, y el formulario lo pide; pero la API
    // no lo puede exigir sin romper la cola offline de una app vieja, y un
    // despacho sin registrar es peor que uno marcado. Entonces entra, y queda
    // dicho: sin la lectura no hay forma de calcular el consumo, que es el
    // único control del combustible que sale CON vale.
    if (valorNuevo === undefined || valorNuevo === null) {
      const equipo = await this.repository.getConsumoMaximoEquipo(client, tenantId, equipoId);
      if (!equipo?.tipoMedidor) return null;
      return {
        medidor: equipo.tipoMedidor as "horometro" | "odometro",
        motivo: "sin_lectura" as const,
        equipo: equipo.placa,
      };
    }

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
      // De dónde salió la diferencia, si las dos varillas leyeron el
      // totalizador de todos los surtidores del tanque.
      ...(await this.desglosarDescuadre(client, tenantId, {
        combustibleId,
        lecturaAnteriorId: Number(datos.lectura_anterior_id),
        leidoEnAnterior: new Date(datos.leido_en_anterior).toISOString(),
        lecturaId,
        leidoEn,
        nivelAnterior,
        nivelMedido: nivel,
        despachos,
        recepciones,
      })),
    };
  }

  /** DE DÓNDE SALIÓ LA DIFERENCIA (0096, por surtidor desde 0098). Con el
   *  totalizador de las dos varillas del tramo, el faltante se separa en dos
   *  causas que se leen distinto:
   *
   *      faltante = salió del tanque − lo que declaran los vales
   *               = (avance − vales)        <- por la manguera, SIN vale
   *               + (salió del tanque − avance)   <- por FUERA del surtidor
   *
   *  - `mangueraSinVale`: el avance es exacto (±2 L) y los vales también, así
   *    que esta parte es firme.
   *  - `fueraDelSurtidor`: la resta de dos medidas, con el error de la varilla
   *    (±150 L). No baja el piso de robo invisible; dice dónde mirar.
   *
   *  El avance es la SUMA de los surtidores del tanque, y solo se calcula en
   *  el caso limpio: los mismos surtidores conectados en las dos varillas,
   *  todos con totalizador, ninguno compartido con otro tanque (su avance no
   *  se podría repartir) y los dos valores de cada uno. Si no, devuelve {}. */
  private async desglosarDescuadre(
    client: PoolClient,
    tenantId: string,
    tramo: {
      combustibleId: number;
      lecturaAnteriorId: number;
      leidoEnAnterior: string;
      lecturaId: number;
      leidoEn: string;
      nivelAnterior: number;
      nivelMedido: number;
      despachos: number;
      recepciones: number;
    }
  ) {
    const antes = await this.repository.findSurtidoresDelTanqueEn(
      client,
      tenantId,
      tramo.combustibleId,
      tramo.leidoEnAnterior
    );
    const ahora = await this.repository.findSurtidoresDelTanqueEn(
      client,
      tenantId,
      tramo.combustibleId,
      tramo.leidoEn
    );
    const ids = (l: { id: number }[]) =>
      l
        .map((x) => x.id)
        .sort((a, b) => a - b)
        .join(",");
    const limpio = (l: { usa_totalizador: boolean; compartido: boolean }[]) =>
      l.length > 0 && l.every((x) => x.usa_totalizador && !x.compartido);
    if (
      ids(antes.surtidores) !== ids(ahora.surtidores) ||
      !limpio(antes.surtidores) ||
      !limpio(ahora.surtidores)
    ) {
      return {};
    }
    const valoresAntes = new Map(
      (
        await this.repository.findTotalizadoresDeLectura(client, tenantId, tramo.lecturaAnteriorId)
      ).map((x) => [x.surtidorId, x.valor])
    );
    const valoresAhora = new Map(
      (await this.repository.findTotalizadoresDeLectura(client, tenantId, tramo.lecturaId)).map(
        (x) => [x.surtidorId, x.valor]
      )
    );
    let avance = 0;
    for (const s of ahora.surtidores) {
      const a = valoresAntes.get(s.id);
      const b = valoresAhora.get(s.id);
      if (a === undefined || b === undefined || b < a) return {};
      avance += b - a;
    }
    const salioDelTanque = tramo.nivelAnterior + tramo.recepciones - tramo.nivelMedido;
    return {
      desglose: {
        avanceTotalizador: Number(avance.toFixed(3)),
        mangueraSinVale: Number((avance - tramo.despachos).toFixed(3)),
        fueraDelSurtidor: Number((salioDelTanque - avance).toFixed(3)),
      },
    };
  }

  /** Vale cargado por debajo del máximo de su serie (migración 0077).
   *  Devuelve ese máximo, o null si la carga fue en orden. */
  detectarValeFueraDeOrden(
    client: PoolClient,
    tenantId: string,
    producto: string,
    serieTalonario: string,
    despachoId: number,
    nVale: number
  ) {
    return this.repository.detectarValeFueraDeOrden(
      client,
      tenantId,
      producto,
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
  existioHuecoPara(
    client: PoolClient,
    tenantId: string,
    producto: string,
    serieTalonario: string,
    nVale: number
  ) {
    return this.repository.existioHuecoPara(client, tenantId, producto, serieTalonario, nVale);
  }

  /** Saldo acumulado del ciclo (migración 0076): el mismo balance que
   *  `evaluarDescuadre`, pero medido desde la última recepción en vez de
   *  desde la lectura anterior.
   *
   *  Existe porque el de tramo tiene un agujero explotable: un faltante
   *  repartido en pedazos chicos, cada uno debajo de la banda, no dispara
   *  nunca. La auditoría lo demostró con 600 L en cuatro tramos de 150.
   *
   *  Umbral SEPARADO del de tramo a propósito, pero no porque el error de la
   *  varilla se acumule: no se acumula, se cancela entre tramos seguidos (ver
   *  `calibrarConSigno`). Lo que sí se acumula es el error del contómetro de
   *  cada despacho, y el ciclo suma los despachos de varios días. Con el mismo
   *  porcentaje que el de tramo podría alertar por ruido de medidor y morir por
   *  ruidoso -- el riesgo que nombra el punto 4 del documento de diseño. */
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

  /** Descuadre acumulado en la ventana deslizante (migración 0080).
   *
   *  El hermano que le faltaba a evaluarDescuadreCiclo, y el que de verdad
   *  cierra el robo de a poco: el del ciclo se reinicia en cada recepción,
   *  así que 50 L/día en un tanque que se carga seguido nunca acumulaban
   *  nada. Esta ventana no se reinicia con nada -- solo se corre con el
   *  tiempo.
   *
   *  Devuelve null en el caso normal: sin umbral configurado, sin tramos
   *  todavía, o con el acumulado dentro de la tolerancia. */
  async evaluarDescuadreVentana(
    client: PoolClient,
    tenantId: string,
    combustibleId: number,
    leidoEn: string
  ) {
    const dias = await this.repository.getDiasVentanaDescuadre(client, tenantId);
    const datos = await this.repository.findDescuadreVentana(
      client,
      tenantId,
      combustibleId,
      leidoEn,
      dias
    );
    if (!datos) return null;
    if (datos.umbral_descuadre_ventana_pct === null) return null;

    const tramos = Number(datos.tramos);
    // Un solo tramo no es una ventana: sería el descuadre entre dos varillas
    // con otro nombre, y ese control ya existe (0074). El acumulado dice algo
    // recién cuando hay varias mediciones para que el ruido se cancele.
    if (tramos < 2) return null;

    const umbralPct = Number(datos.umbral_descuadre_ventana_pct);
    const capacidad = Number(datos.capacidad_total);
    const descuadre = Number(datos.descuadre_total);
    const toleradoLitros = (capacidad * umbralPct) / 100;

    if (Math.abs(descuadre) <= toleradoLitros) return null;

    return {
      tanqueNombre: datos.tanque_nombre,
      unidad: datos.unidad,
      diasVentana: dias,
      desde: datos.desde_en ? new Date(datos.desde_en).toISOString() : null,
      tramos,
      descuadreLitros: Number(descuadre.toFixed(2)),
      sentido: descuadre < 0 ? ("falta" as const) : ("sobra" as const),
      umbralPct,
      toleradoLitros: Number(toleradoLitros.toFixed(2)),
      // El promedio por tramo es el número que hace entendible el hallazgo:
      // "se fueron 1.500 L" asusta, "50 L por medición durante un mes"
      // explica QUÉ pasó y por qué ningún control por tramo lo vio.
      promedioPorTramo: Number((descuadre / tramos).toFixed(2)),
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
  /** El tanque que OPERA ciego (migración 0082).
   *
   *  Nació de una propuesta de Kenif --"que no se pueda crear el tanque sin
   *  umbrales"-- y de por qué eso sale peor: el número correcto no existe el
   *  día uno, así que obligarlo obliga a inventarlo, y un umbral inventado o
   *  alerta con el trabajo normal (y se ignora) o no atrapa nada pero deja el
   *  tanque figurando como configurado. Eso último es peor que la etiqueta
   *  roja, que al menos dice la verdad.
   *
   *  El hueco real no estaba en el alta --que ya obliga a elegir y avisa por
   *  correo si nace ciego-- sino en que después nadie insiste. Un tanque
   *  puede despachar miles de litros durante meses con los tres umbrales en
   *  NULL, y lo único que lo dice es una etiqueta pasiva.
   *
   *  Para cuando esta alerta salta, el tanque YA TIENE historial: el
   *  asistente de calibración puede sugerir el número de verdad. */
  async evaluarTanquesSinVigilancia(client: PoolClient, tenantId: string) {
    const dias = await this.repository.getDiasSinVigilancia(client, tenantId);
    const tanques = await this.repository.findTanquesOperandoSinVigilancia(client, tenantId, dias);
    if (tanques.length === 0) return { alertas: [], dias };

    await this.repository.crearAlertas(
      client,
      tenantId,
      tanques.map((t) => ({
        tipo: "tanque_sin_vigilancia" as const,
        combustibleId: t.id,
        detalle: {
          tanqueNombre: t.tanque_nombre,
          codigo: t.codigo,
          unidad: t.unidad,
          // El daño ya hecho, que es lo que convierte el aviso en un número:
          // no es "falta configurar", es "salieron 12.000 L sin que nada los
          // vigilara".
          valesEnLaVentana: Number(t.vales),
          litrosEnLaVentana: Number(t.litros),
          plazoDias: dias,
        },
      }))
    );
    return { alertas: tanques, dias };
  }

  resolverSinVigilanciaSiExiste(client: PoolClient, tenantId: string, combustibleId: number) {
    return this.repository.resolverSinVigilanciaSiExiste(client, tenantId, combustibleId);
  }

  // ── 5ª auditoría: controles sobre la varilla y la recepción ────────────

  /** Ver CombustibleRepository.registrarAlertaDeEstadoAcumulado. */
  registrarAlertaDeEstadoAcumulado(
    client: PoolClient,
    tenantId: string,
    fila: Parameters<CombustibleRepository["registrarAlertaDeEstadoAcumulado"]>[2]
  ) {
    return this.repository.registrarAlertaDeEstadoAcumulado(client, tenantId, fila);
  }

  resolverVarillaSinControlSiExiste(client: PoolClient, tenantId: string, combustibleId: number) {
    return this.repository.resolverVarillaSinControlSiExiste(client, tenantId, combustibleId);
  }

  /** Cuántas varillas SEGUIDAS tienen que cuadrar al litro para sospechar que
   *  se copió el teórico. Cuatro: una varilla se lee en centímetros y se
   *  convierte con la tabla de aforo, así que aun con el tanque en perfecto
   *  orden cuadrar exacto una vez es raro, y cuatro veces seguidas con
   *  movimiento de por medio no pasa midiendo. No es un umbral de la
   *  operación (lo sabría el cliente): es un límite físico del instrumento,
   *  por eso es constante y no configuración. */
  static readonly VARILLAS_EXACTAS_SEGUIDAS = 4;
  static readonly TOLERANCIA_VARILLA_EXACTA_L = 1;

  /** ¿Las últimas varillas cuadran con el teórico al litro, una detrás de
   *  otra? (5ª auditoría, V2)
   *
   *  El ataque que cierra: el grifero despacha, mide y conoce los vales, así
   *  que puede anotar como varilla el número que el sistema espera en vez de
   *  medir. Así los cuatro umbrales ven descuadre cero para siempre, y el robo
   *  aparece recién cuando mide otra persona.
   *
   *  Solo cuentan los tramos con MOVIMIENTO (despacho o recepción): dos
   *  varillas seguidas sin nada en el medio pueden dar lo mismo con toda
   *  honestidad -- el tanque no se movió. */
  async evaluarVarillaExacta(
    client: PoolClient,
    tenantId: string,
    combustibleId: number,
    lecturaId: number
  ) {
    const n = CombustibleService.VARILLAS_EXACTAS_SEGUIDAS;
    const tramos = await this.repository.findUltimosTramos(
      client,
      tenantId,
      combustibleId,
      lecturaId,
      n
    );
    if (tramos.length < n) return null;
    // El último tramo tiene que ser el de ESTA varilla: si la lectura entró
    // hacia atrás, la racha que se evalúa no es la suya.
    if (tramos[tramos.length - 1].lecturaId !== lecturaId) return null;
    const exactos = tramos.every(
      (t) =>
        t.despachos + t.recepciones > 0 &&
        Math.abs(t.descuadre) <= CombustibleService.TOLERANCIA_VARILLA_EXACTA_L
    );
    if (!exactos) return null;
    const tanque = await this.repository.findById(client, tenantId, combustibleId);
    return {
      tanqueNombre: tanque?.tanque_nombre ?? "",
      unidad: tanque?.unidad ?? "",
      varillasSeguidas: n,
      toleranciaLitros: CombustibleService.TOLERANCIA_VARILLA_EXACTA_L,
      tramos: tramos.map((t) => ({
        leidoEn: new Date(t.leidoEn).toISOString(),
        descuadreLitros: Number(t.descuadre.toFixed(2)),
        movidoLitros: Number((t.despachos + t.recepciones).toFixed(2)),
      })),
    };
  }

  /** Los controles del worker que agregó la 5ª auditoría. Devuelve lo que
   *  creó, para que el worker avise por correo fuera de la transacción.
   *
   *  - `recepcion_sin_validar`: la recepción espera la validación contra la
   *    guía más que el plazo de la política.
   *  - `varilla_sin_control`: el tanque lleva N días medido solo por los que
   *    despachan. */
  async evaluarControlesPeriodicos(client: PoolClient, tenantId: string) {
    const creadas: {
      tipo: "recepcion_sin_validar" | "varilla_sin_control";
      detalle: Record<string, unknown>;
    }[] = [];

    const politica = await this.repository.getPoliticaValidacionRecepcion(client, tenantId);
    // Se evalúa aunque la política esté apagada HOY: una recepción que se
    // registró cuando validar era obligatorio sigue debiendo su validación.
    // Apagar la política no puede ser la forma de borrar las pendientes.
    const sinValidar = await this.repository.findRecepcionesSinValidar(
      client,
      tenantId,
      politica.horas
    );
    if (sinValidar.length > 0) {
      const filas = sinValidar.map((r) => ({
        tipo: "recepcion_sin_validar" as const,
        recepcionId: r.id,
        combustibleId: r.combustible_id,
        detalle: {
          tanqueNombre: r.tanque_nombre,
          unidad: r.unidad,
          registradaEn: new Date(r.creado_en).toISOString(),
          numeroDocumento: r.numero_documento,
          plazoHoras: politica.horas,
        },
      }));
      await this.repository.crearAlertas(client, tenantId, filas);
      creadas.push(...filas);
    }

    const dias = await this.repository.getDiasSinVarillaDeControl(client, tenantId);
    if (dias !== null) {
      const tanques = await this.repository.findTanquesSinVarillaDeControl(client, tenantId, dias);
      if (tanques.length > 0) {
        const filas = tanques.map((t) => ({
          tipo: "varilla_sin_control" as const,
          combustibleId: t.id,
          detalle: {
            tanqueNombre: t.tanque_nombre,
            codigo: t.codigo,
            varillasEnLaVentana: Number(t.varillas),
            ultimaVarillaDeControl: t.ultima_de_control
              ? new Date(t.ultima_de_control).toISOString()
              : null,
            plazoDias: dias,
          },
        }));
        await this.repository.crearAlertas(client, tenantId, filas);
        creadas.push(...filas);
      }
    }

    return { creadas };
  }

  /** Avisa, UNA vez por tanque, que hay consumo anterior a su primera varilla
   *  (0093). El kardex ya lo muestra como "consumo histórico" sin mover el
   *  saldo; esto es para que nadie lo lea como auditado. */
  async evaluarHistorialSinContrastar(client: PoolClient, tenantId: string) {
    const tanques = await this.repository.findTanquesConHistorialPrevio(client, tenantId);
    if (tanques.length === 0) return { alertas: [] };

    await this.repository.crearAlertas(
      client,
      tenantId,
      tanques.map((t) => ({
        tipo: "historial_sin_contrastar" as const,
        combustibleId: t.id,
        detalle: {
          tanqueNombre: t.tanque_nombre,
          codigo: t.codigo,
          unidad: t.unidad,
          vales: Number(t.vales),
          litrosDespachados: Number(t.litros_despachados),
          recepciones: Number(t.recepciones),
          litrosRecibidos: Number(t.litros_recibidos),
          desde: new Date(t.desde).toISOString(),
          hasta: new Date(t.hasta).toISOString(),
          primeraVarilla: new Date(t.primera_varilla).toISOString(),
        },
      }))
    );
    return { alertas: tanques };
  }

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

  /** Cuántas cargas anteriores se promedian para el consumo. Tres: una sola
   *  carga mide "lo que entró en este llenado dividido las horas desde el
   *  anterior", y eso es ruidoso cuando se carga a medio tanque. Tres
   *  llenados suavizan el llenado parcial sin diluir un robo sostenido. */
  static readonly CARGAS_PARA_CONSUMO = 3;

  /** CONSUMO POR HORA DE MOTOR (o por km): el control que veía faltar.
   *
   *  El robo que sale CON vale --se declaran 400 L, el volquete recibe 380--
   *  no lo puede ver ningún control del tanque: el tanque cuadra perfecto y
   *  el papel dice 400. Lo único que no cuadra es el TRABAJO que ese
   *  combustible debería haber hecho.
   *
   *  Hasta la migración 0088 esto era imposible para el tanque propio: el
   *  vale ni siquiera aceptaba el horómetro. Ahora sí, y acá se compara.
   *
   *      consumo = litros cargados desde la lectura base / (medidor actual − base)
   *
   *  Devuelve null en el caso normal: sin medidor en este vale, sin
   *  `consumo_maximo_l` configurado en el equipo (el default), sin cargas
   *  previas con medidor, o con el consumo dentro del máximo.
   *
   *  NO bloquea el vale: la explicación más probable no es robo (una máquina
   *  trabajando en barro consume más), pero alguien tiene que mirarlo. */
  async evaluarConsumoExcedido(
    client: PoolClient,
    tenantId: string,
    equipoId: number,
    data: {
      despachoId: number;
      lecturaHorometro?: number | null;
      lecturaOdometro?: number | null;
    }
  ) {
    const esHorometro = data.lecturaHorometro !== undefined && data.lecturaHorometro !== null;
    const medidorActual = esHorometro ? data.lecturaHorometro! : data.lecturaOdometro;
    if (medidorActual === undefined || medidorActual === null) return null;

    const equipo = await this.repository.getConsumoMaximoEquipo(client, tenantId, equipoId);
    if (!equipo || equipo.consumoMaximo === null) return null;

    const previos = await this.repository.findValesConMedidor(
      client,
      tenantId,
      equipoId,
      data.despachoId,
      CombustibleService.CARGAS_PARA_CONSUMO
    );
    // La base es la carga más vieja de la ventana que tenga el MISMO medidor:
    // un equipo al que le cambiaron el tipo de medidor tiene lecturas que no
    // son comparables entre sí.
    const comparables = previos.filter((p) =>
      esHorometro ? p.lectura_horometro !== null : p.lectura_odometro !== null
    );
    if (comparables.length === 0) return null;
    const base = comparables[comparables.length - 1];
    const medidorBase = Number(esHorometro ? base.lectura_horometro : base.lectura_odometro);

    const recorrido = medidorActual - medidorBase;
    // Un medidor que no avanzó (o que retrocedió) no permite dividir. El
    // retroceso ya lo reporta `medidor_inconsistente`, que es su alerta.
    if (!(recorrido > 0)) return null;

    const litros = await this.repository.findLitrosDesde(
      client,
      tenantId,
      equipoId,
      base.despachado_en
    );
    if (litros <= 0) return null;

    const consumo = litros / recorrido;
    if (consumo <= equipo.consumoMaximo) return null;

    return {
      equipo: equipo.placa,
      medidor: esHorometro ? ("horometro" as const) : ("odometro" as const),
      unidadMedida: esHorometro ? "h" : "km",
      consumo: Number(consumo.toFixed(2)),
      consumoMaximo: equipo.consumoMaximo,
      litros: Number(litros.toFixed(2)),
      recorrido: Number(recorrido.toFixed(2)),
      cargasPromediadas: comparables.length,
      medidorBase,
      medidorActual,
      desdeEn: new Date(base.despachado_en).toISOString(),
    };
  }

  /** La sugerencia de `consumo_maximo_l` desde el historial del propio
   *  equipo, con el MISMO estadístico que los umbrales del tanque (promedio +
   *  2 desvíos, mínimo 10 muestras) y la misma regla: se muestra con la
   *  muestra entera y NUNCA se aplica sola. La muestra puede contener robo, y
   *  eso solo lo puede ver una persona.
   *
   *  Kenif (2026-09-14) sobre el tope diario y este: "hay que ponerle un tope
   *  pero igual hay que guiarnos por el historial luego para que nos
   *  recomiende". */
  async sugerirConsumoMaximo(client: PoolClient, tenantId: string, equipoId: number) {
    const equipo = await this.repository.getConsumoMaximoEquipo(client, tenantId, equipoId);
    if (!equipo) return null;
    const esHorometro = equipo.tipoMedidor !== "odometro";

    // Todas las cargas de combustible del equipo, CON y SIN medidor, de la
    // más vieja a la más nueva. Antes solo entraban las que traían medidor y
    // el punto usaba los litros de ese único vale: una carga sin horómetro en
    // el medio se perdía y el consumo salía más bajo que el real -- una
    // sugerencia floja justo en el equipo que peor anota.
    const vales = await this.repository.findValesParaConsumo(client, tenantId, {
      equipoId,
      desde: null,
      hasta: new Date().toISOString(),
      limite: 2000,
    });
    const medidorDe = (v: (typeof vales)[number]) => {
      const crudo = esHorometro ? v.lectura_horometro : v.lectura_odometro;
      return crudo === null ? null : Number(crudo);
    };

    const puntos: {
      desdeEn: string;
      hastaEn: string;
      litros: number;
      recorrido: number;
      consumo: number;
    }[] = [];
    let base = vales.findIndex((v) => medidorDe(v) !== null);
    for (let k = base + 1; base >= 0 && k < vales.length; k++) {
      const mActual = medidorDe(vales[k]);
      if (mActual === null) continue;
      const recorrido = mActual - medidorDe(vales[base])!;
      // Misma lectura: dos cargas en la misma hora de motor. Se acumulan en
      // el tramo siguiente en vez de perderse.
      if (recorrido === 0) continue;
      // El medidor retrocedió (cambio de tablero, tipeo): esa base no sirve.
      // Lo reporta medidor_inconsistente, acá solo se arranca de nuevo.
      if (recorrido < 0) {
        base = k;
        continue;
      }
      let litros = 0;
      for (let t = base + 1; t <= k; t++) litros += Number(vales[t].litros);
      puntos.push({
        desdeEn: new Date(vales[base].despachado_en).toISOString(),
        hastaEn: new Date(vales[k].despachado_en).toISOString(),
        litros: Number(litros.toFixed(2)),
        recorrido: Number(recorrido.toFixed(2)),
        consumo: Number((litros / recorrido).toFixed(3)),
      });
      base = k;
    }

    const consumos = puntos.map((p) => p.consumo);
    if (consumos.length < CombustibleService.MINIMO_MUESTRA) {
      return {
        unidadMedida: esHorometro ? "h" : "km",
        configurado: equipo.consumoMaximo,
        ...CombustibleService.muestraInsuficiente(consumos.length, puntos),
      };
    }
    const promedio = consumos.reduce((a, b) => a + b, 0) / consumos.length;
    const varianza =
      consumos.reduce((acc, v) => acc + (v - promedio) ** 2, 0) / (consumos.length - 1);
    const desviacion = Math.sqrt(varianza);
    return {
      unidadMedida: esHorometro ? "h" : "km",
      configurado: equipo.consumoMaximo,
      muestraSuficiente: true as const,
      tamanioMuestra: consumos.length,
      minimoRequerido: CombustibleService.MINIMO_MUESTRA,
      sugerido: Number((promedio + 2 * desviacion).toFixed(2)),
      promedio: Number(promedio.toFixed(2)),
      desviacion: Number(desviacion.toFixed(2)),
      muestra: puntos,
    };
  }

  // ── Precintos numerados (migración 0095) ─────────────────────────────

  /** El mismo sello tipeado de dos formas tiene que dar el mismo número:
   *  mayúsculas, sin espacios ni separadores, y sin ceros a la izquierda si
   *  es solo número ("00-1234" y "1234" son el mismo precinto). Sin esto,
   *  cada diferencia de tipeo sería una alerta de sello alterado. */
  static normalizarNumeroPrecinto(crudo: string) {
    const limpio = crudo.toUpperCase().replace(/[^0-9A-Z]/g, "");
    if (/^[0-9]+$/.test(limpio)) return limpio.replace(/^0+(?=.)/, "");
    return limpio;
  }

  /** Lo que la varilla vio contra lo que tendría que haber visto.
   *
   *  - Tanque sin precintos: no se verifica nada y lo que venga se ignora. Es
   *    la varilla que se cargó offline cuando el control estaba prendido y
   *    llega después de apagarlo: perderla por eso sería peor.
   *  - Con precintos: cada punto que tenía un sello registrado AL MOMENTO DE
   *    LA MEDICIÓN y sigue activo es obligatorio. Un punto que no es de este
   *    tanque es un 400.
   *
   *  Lanza con mensajes que el controller traduce a 400. */
  async prepararVerificacionPrecintos(
    client: PoolClient,
    tenantId: string,
    combustibleId: number,
    leidoEn: string,
    vistos: { punto_id: number; numero: string | null }[] | undefined
  ) {
    const tanque = await this.repository.findById(client, tenantId, combustibleId);
    // Un tanque que no existe lo rechaza registrarLectura con su propio 400.
    if (!tanque?.usa_precintos) return [];

    const vigentes = await this.repository.findPrecintosVigentesEn(
      client,
      tenantId,
      combustibleId,
      leidoEn
    );
    const porPunto = new Map(vigentes.map((v) => [v.punto_id, v]));
    const anotados = new Map((vistos ?? []).map((v) => [v.punto_id, v.numero]));

    for (const puntoId of anotados.keys()) {
      if (!porPunto.has(puntoId)) {
        throw new Error(`el punto de precinto ${puntoId} no es de este tanque`);
      }
    }
    const faltan = vigentes.filter(
      (v) => v.activo && v.numero !== null && !anotados.has(v.punto_id)
    );
    if (faltan.length > 0) {
      throw new Error(
        `el tanque ${tanque.codigo} usa precintos: anotá el número que ves en ` +
          faltan.map((f) => `"${f.nombre}"`).join(", ") +
          ` (o marcá que no hay precinto)`
      );
    }

    const filas: { puntoId: number; visto: string | null; esperado: string; coincide: boolean }[] =
      [];
    for (const [puntoId, crudo] of anotados) {
      const esperado = porPunto.get(puntoId)!.numero;
      // El punto todavía no tenía sello cuando se midió: no hay contra qué.
      if (esperado === null) continue;
      const visto = crudo === null ? null : CombustibleService.normalizarNumeroPrecinto(crudo);
      filas.push({ puntoId, visto, esperado, coincide: visto === esperado });
    }
    return filas;
  }

  /** Los puntos que se abren al recibir exigen su precinto nuevo en la
   *  misma recepción. Los demás puntos pueden venir (se abrió otro) pero no
   *  son obligatorios. */
  private async validarPrecintosDeRecepcion(
    client: PoolClient,
    tenantId: string,
    data: CrearRecepcionCombustibleInput
  ) {
    const tanque = await this.repository.findById(client, tenantId, data.combustible_id!);
    if (!tanque) return;
    const enviados = data.precintos ?? [];
    if (!tanque.usa_precintos) {
      if (enviados.length > 0) {
        throw new Error(
          `el tanque ${tanque.codigo} no usa precintos -- activalos en el tanque o quitá los precintos`
        );
      }
      return;
    }
    const puntos = await this.repository.listarPuntosPrecinto(
      client,
      tenantId,
      data.combustible_id!
    );
    const ids = new Set(enviados.map((p) => p.punto_id));
    if (ids.size !== enviados.length) {
      throw new Error("el mismo punto de precinto vino dos veces");
    }
    for (const p of enviados) {
      const punto = puntos.find((x: { id: number }) => x.id === p.punto_id);
      if (!punto) throw new Error(`el punto de precinto ${p.punto_id} no es de este tanque`);
      if (!punto.activo) throw new Error(`el punto "${punto.nombre}" está dado de baja`);
    }
    const faltan = puntos.filter(
      (x: { activo: boolean; se_abre_en_recepcion: boolean; id: number }) =>
        x.activo && x.se_abre_en_recepcion && !ids.has(x.id)
    );
    if (faltan.length > 0) {
      throw new Error(
        `el tanque ${tanque.codigo} usa precintos: anotá el precinto nuevo de ` +
          faltan.map((f: { nombre: string }) => `"${f.nombre}"`).join(", ")
      );
    }
  }

  getSurtidor(client: PoolClient, tenantId: string, surtidorId: number) {
    return this.repository.findSurtidorPorId(client, tenantId, surtidorId);
  }

  listarPuntosPrecinto(client: PoolClient, tenantId: string, combustibleId: number) {
    return this.repository.listarPuntosPrecinto(client, tenantId, combustibleId);
  }

  historialPrecintos(client: PoolClient, tenantId: string, combustibleId: number) {
    return this.repository.historialPrecintos(client, tenantId, combustibleId);
  }

  /** Alta de un punto con su primer precinto, en una sola transacción. */
  async crearPuntoPrecinto(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    combustibleId: number,
    data: CrearPuntoPrecintoInput
  ) {
    const tanque = await this.repository.findById(client, tenantId, combustibleId);
    if (!tanque) return null;
    const puntoId = await this.repository.crearPuntoPrecinto(client, tenantId, {
      combustibleId,
      nombre: data.nombre,
      seAbreEnRecepcion: data.se_abre_en_recepcion,
      usuarioId,
    });
    await this.repository.colocarPrecinto(client, tenantId, {
      puntoId,
      numero: CombustibleService.normalizarNumeroPrecinto(data.numero),
      colocadoEn: new Date().toISOString(),
      usuarioId,
      motivo: "Instalación del punto",
      recepcionId: null,
    });
    return { puntoId, tanque };
  }

  /** Cambio de precinto FUERA de una recepción. Devuelve null si el punto no
   *  existe en este tenant; lanza si está dado de baja o si el número ya se
   *  usó. */
  async cambiarPrecinto(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    puntoId: number,
    data: CambiarPrecintoInput
  ) {
    const punto = await this.repository.findPuntoPrecinto(client, tenantId, puntoId);
    if (!punto) return null;
    if (!punto.activo) throw new Error(`el punto "${punto.nombre}" está dado de baja`);
    const tanque = await this.repository.findById(client, tenantId, punto.combustible_id);
    const { precinto, numeroAnterior } = await this.repository.colocarPrecinto(client, tenantId, {
      puntoId,
      numero: CombustibleService.normalizarNumeroPrecinto(data.numero),
      colocadoEn: data.colocado_en ?? new Date().toISOString(),
      usuarioId,
      motivo: data.motivo,
      recepcionId: null,
    });
    return { punto, tanque, precinto, numeroAnterior };
  }

  bajaPuntoPrecinto(client: PoolClient, tenantId: string, puntoId: number, motivo: string) {
    return this.repository.bajaPuntoPrecinto(client, tenantId, puntoId, motivo);
  }

  findVerificacionesFallidas(client: PoolClient, tenantId: string, lecturaId: number) {
    return this.repository.findVerificacionesFallidas(client, tenantId, lecturaId);
  }

  // ── Reporte de consumo por equipo ─────────────────────────────────────
  //
  // El que distingue "le roban" de "traga mucho". El máximo configurado del
  // equipo (consumo_excedido) solo compara al equipo contra SU propia
  // historia, y eso tiene un punto ciego: si le roban desde el primer día, el
  // robo ya está adentro de su "normal" y nunca se ve. Por eso dos preguntas
  // separadas, y de la combinación sale la lectura:
  //   - contra sus PARES (mismo tipo, marca y modelo, en el mismo período, o
  //     sea con el mismo clima y el mismo frente de trabajo);
  //   - contra SU PASADO (el año anterior al período).

  /** Cuánto se aparta, para arriba o para abajo, antes de marcarlo. Fijo a
   *  propósito: el reporte muestra los porcentajes, y el que decide es una
   *  persona que mira la tabla, no el número. */
  static readonly TOLERANCIA_CONSUMO_PCT = 15;
  /** Cargas mínimas en un tramo para dar un consumo. El tramo telescopa (el
   *  llenado parcial de una punta se compensa en la siguiente), así que el
   *  error no crece con las cargas, pero con una o dos el tramo es tan corto
   *  que el llenado parcial de las puntas lo domina. */
  static readonly MIN_CARGAS_TRAMO_CONSUMO = 3;
  /** Cuánta historia hacia atrás cuenta como "su pasado". */
  static readonly DIAS_PASADO_CONSUMO = 365;
  /** Con menos pares que esto, la "mediana" sería la de un solo equipo. */
  static readonly MIN_PARES_CONSUMO = 2;

  /** Consumo de un tramo: litros cargados / (medidor final − medidor base).
   *
   *  La base es la última carga con medidor ANTES del tramo (si se permite) y
   *  el final es la última carga con medidor DENTRO. Los litros son TODAS las
   *  cargas después de la base hasta el final inclusive, tengan medidor o no:
   *  el combustible de la carga base se quemó antes del tramo, y el de cada
   *  carga posterior, durante.
   *
   *  `vales` tiene que venir ordenado del más viejo al más nuevo. */
  static consumoDelTramo(
    vales: {
      litros: string | number;
      lectura_horometro: string | null;
      lectura_odometro: string | null;
      despachado_en: Date;
    }[],
    medidor: "horometro" | "odometro",
    desdeMs: number,
    hastaMs: number,
    baseAnterior: boolean
  ):
    | { ok: true; consumo: number; litros: number; recorrido: number; cargas: number }
    | { ok: false; motivo: "pocas_cargas" | "medidor_retrocede" } {
    const m = (i: number) => {
      const crudo =
        medidor === "horometro" ? vales[i].lectura_horometro : vales[i].lectura_odometro;
      return crudo === null ? null : Number(crudo);
    };
    const t = (i: number) => new Date(vales[i].despachado_en).getTime();

    let base = -1;
    let fin = -1;
    let primeraDentro = -1;
    for (let i = 0; i < vales.length; i++) {
      if (m(i) === null) continue;
      const ti = t(i);
      if (ti < desdeMs) {
        if (baseAnterior) base = i;
      } else if (ti <= hastaMs) {
        if (primeraDentro < 0) primeraDentro = i;
        fin = i;
      }
    }
    if (base < 0) base = primeraDentro;
    if (base < 0 || fin <= base) return { ok: false, motivo: "pocas_cargas" };

    // Un medidor que retrocede adentro del tramo (tablero cambiado, tipeo)
    // hace que la resta final no signifique nada. No se adivina: se avisa.
    let previo = m(base)!;
    for (let i = base + 1; i <= fin; i++) {
      const mi = m(i);
      if (mi === null) continue;
      if (mi < previo) return { ok: false, motivo: "medidor_retrocede" };
      previo = mi;
    }

    const recorrido = m(fin)! - m(base)!;
    const cargas = fin - base;
    if (!(recorrido > 0) || cargas < CombustibleService.MIN_CARGAS_TRAMO_CONSUMO) {
      return { ok: false, motivo: "pocas_cargas" };
    }
    let litros = 0;
    for (let i = base + 1; i <= fin; i++) litros += Number(vales[i].litros);
    return {
      ok: true,
      consumo: Number((litros / recorrido).toFixed(3)),
      litros: Number(litros.toFixed(2)),
      recorrido: Number(recorrido.toFixed(2)),
      cargas,
    };
  }

  /** La lectura de la combinación. Orden = urgencia: lo que CAMBIÓ va
   *  primero, porque es un robo nuevo o una falla que se está pagando hoy;
   *  lo que siempre fue alto ya se viene pagando y admite una semana más. */
  static diagnosticarConsumo(
    vsPares: "alto" | "normal" | "bajo" | null,
    vsPasado: "subio" | "estable" | "bajo" | null
  ) {
    if (vsPasado === "subio" && vsPares === "alto") {
      return {
        diagnostico: "subio_y_alto" as const,
        lectura:
          "Consume más que antes y más que sus pares: robo nuevo o falla mecánica. Revisar ya.",
      };
    }
    if (vsPasado === "subio") {
      return {
        diagnostico: "subio" as const,
        lectura:
          "Subió contra su propio pasado: robo nuevo o falla mecánica (inyectores, filtros). Revisar ya.",
      };
    }
    if (vsPares === "alto") {
      return {
        diagnostico: "alto" as const,
        lectura:
          "Consume más que sus pares desde siempre: traga por cómo trabaja o por su estado, o le roban desde el inicio.",
      };
    }
    if (vsPares === "bajo" || vsPasado === "bajo") {
      return {
        diagnostico: "bajo" as const,
        lectura:
          "Consume menos de lo esperable: revisar que el horómetro u odómetro no esté adelantado. Inflar el medidor esconde un robo.",
      };
    }
    if (vsPares === null && vsPasado === null) {
      return {
        diagnostico: "sin_referencia" as const,
        lectura:
          "Sin pares del mismo modelo ni historia previa: todavía no hay con qué compararlo.",
      };
    }
    return { diagnostico: "normal" as const, lectura: "Dentro de lo esperable." };
  }

  async reporteConsumoEquipos(client: PoolClient, tenantId: string, desde: string, hasta: string) {
    const desdeMs = Date.parse(desde);
    const hastaMs = Date.parse(hasta);
    const pasadoDesdeMs = desdeMs - CombustibleService.DIAS_PASADO_CONSUMO * 24 * 3600 * 1000;
    const tol = CombustibleService.TOLERANCIA_CONSUMO_PCT;

    const vales = await this.repository.findValesParaConsumo(client, tenantId, {
      equipoId: null,
      desde: new Date(pasadoDesdeMs).toISOString(),
      hasta,
      limite: 200_000,
    });
    const porEquipo = new Map<number, typeof vales>();
    for (const v of vales) {
      const lista = porEquipo.get(v.equipo_id) ?? [];
      lista.push(v);
      porEquipo.set(v.equipo_id, lista);
    }
    // Solo los equipos que cargaron en el período: el que estuvo parado no
    // tiene nada que explicar.
    const idsConCargas = [...porEquipo.entries()]
      .filter(([, lista]) =>
        lista.some((v) => {
          const tv = new Date(v.despachado_en).getTime();
          return tv >= desdeMs && tv <= hastaMs;
        })
      )
      .map(([id]) => id);
    const equipos = await this.repository.findEquiposParaConsumo(client, tenantId, idsConCargas);

    const norm = (x: string | null) => (x ?? "").trim().toLowerCase();
    const filas = equipos.map((e) => {
      const lista = porEquipo.get(e.id) ?? [];
      // El medidor del equipo; si no está configurado, el que traen sus vales.
      const medidor: "horometro" | "odometro" =
        e.tipo_medidor === "odometro" ||
        (e.tipo_medidor === null &&
          !lista.some((v) => v.lectura_horometro !== null) &&
          lista.some((v) => v.lectura_odometro !== null))
          ? "odometro"
          : "horometro";
      const periodo = CombustibleService.consumoDelTramo(lista, medidor, desdeMs, hastaMs, true);
      const pasado = CombustibleService.consumoDelTramo(
        lista,
        medidor,
        pasadoDesdeMs,
        desdeMs - 1,
        false
      );
      const litrosPeriodo = lista
        .filter((v) => {
          const tv = new Date(v.despachado_en).getTime();
          return tv >= desdeMs && tv <= hastaMs;
        })
        .reduce((a, v) => a + Number(v.litros), 0);
      return {
        equipo_id: e.id,
        placa_codigo: e.placa_codigo,
        tipo: e.tipo,
        marca: e.marca,
        modelo: e.modelo,
        activo: e.activo,
        medidor,
        unidad_medida: medidor === "horometro" ? "h" : "km",
        // Clave de pares: sin marca Y modelo no hay con quién compararlo --
        // "todos los volquetes" mezcla motores que no tienen nada que ver.
        clavePares:
          norm(e.marca) && norm(e.modelo)
            ? [medidor, norm(e.tipo), norm(e.marca), norm(e.modelo)].join("|")
            : null,
        litros_cargados: Number(litrosPeriodo.toFixed(2)),
        consumo_maximo_l: e.consumo_maximo_l === null ? null : Number(e.consumo_maximo_l),
        periodo: periodo.ok ? periodo : null,
        sin_datos_motivo: periodo.ok ? null : periodo.motivo,
        pasado: pasado.ok ? pasado : null,
      };
    });

    const pct = (a: number, b: number) => Number((((a - b) / b) * 100).toFixed(1));
    const resultado = filas.map((f) => {
      let pares: { cantidad: number; mediana: number } | null = null;
      if (f.periodo && f.clavePares) {
        const otros = filas
          .filter((o) => o.equipo_id !== f.equipo_id && o.clavePares === f.clavePares && o.periodo)
          .map((o) => o.periodo!.consumo)
          .sort((a, b) => a - b);
        // Mediana y no promedio: si uno de los pares es justo el que traga
        // (o al que le roban), el promedio lo arrastra y esconde al resto.
        if (otros.length >= CombustibleService.MIN_PARES_CONSUMO) {
          const medio = Math.floor(otros.length / 2);
          const mediana =
            otros.length % 2 === 0 ? (otros[medio - 1] + otros[medio]) / 2 : otros[medio];
          pares = { cantidad: otros.length, mediana: Number(mediana.toFixed(3)) };
        }
      }
      const vsParesPct = f.periodo && pares ? pct(f.periodo.consumo, pares.mediana) : null;
      const vsPasadoPct = f.periodo && f.pasado ? pct(f.periodo.consumo, f.pasado.consumo) : null;
      const clasif = <A extends string, B extends string>(v: number | null, alto: A, bajo: B) =>
        v === null ? null : v > tol ? alto : v < -tol ? bajo : null;
      const vsPares =
        vsParesPct === null
          ? null
          : (clasif(vsParesPct, "alto" as const, "bajo" as const) ?? "normal");
      const vsPasado =
        vsPasadoPct === null
          ? null
          : (clasif(vsPasadoPct, "subio" as const, "bajo" as const) ?? "estable");
      const { diagnostico, lectura } = f.periodo
        ? CombustibleService.diagnosticarConsumo(vsPares, vsPasado)
        : {
            diagnostico: "sin_datos" as const,
            lectura:
              f.sin_datos_motivo === "medidor_retrocede"
                ? "El medidor retrocede dentro del período: no se puede calcular. Revisar las alertas de medidor."
                : `Menos de ${CombustibleService.MIN_CARGAS_TRAMO_CONSUMO} cargas con medidor en el período: no alcanza para medir el consumo.`,
          };
      const { clavePares: _clave, sin_datos_motivo: _motivo, ...resto } = f;
      return {
        ...resto,
        pares,
        vs_pares_pct: vsParesPct,
        vs_pasado_pct: vsPasadoPct,
        supera_maximo:
          f.periodo && f.consumo_maximo_l !== null ? f.periodo.consumo > f.consumo_maximo_l : null,
        diagnostico,
        lectura,
      };
    });

    const URGENCIA = [
      "subio_y_alto",
      "subio",
      "alto",
      "bajo",
      "sin_referencia",
      "normal",
      "sin_datos",
    ];
    resultado.sort(
      (a, b) =>
        URGENCIA.indexOf(a.diagnostico) - URGENCIA.indexOf(b.diagnostico) ||
        Math.abs(b.vs_pasado_pct ?? b.vs_pares_pct ?? 0) -
          Math.abs(a.vs_pasado_pct ?? a.vs_pares_pct ?? 0)
    );

    const resumen: Record<string, number> = {};
    for (const r of resultado) resumen[r.diagnostico] = (resumen[r.diagnostico] ?? 0) + 1;

    return {
      periodo: { desde, hasta },
      criterio: {
        tolerancia_pct: tol,
        min_cargas: CombustibleService.MIN_CARGAS_TRAMO_CONSUMO,
        dias_pasado: CombustibleService.DIAS_PASADO_CONSUMO,
        min_pares: CombustibleService.MIN_PARES_CONSUMO,
      },
      equipos: resultado,
      resumen,
    };
  }

  // ── Urea (migración 0092) -- los controles que la urea permite y el
  // combustible no ────────────────────────────────────────────────────────

  /** El vale de urea fue a un equipo marcado con `usa_urea = false`
   *  (respuesta 15 del cliente: camionetas y maquinaria amarilla no usan
   *  urea). No es autocontradictorio -- por eso ALERTA, no bloquea (mismo
   *  criterio que el sobredespacho): el dato del equipo podría estar mal
   *  cargado, o la unidad cambiar de flota. Pero un vale a un equipo que
   *  "no usa urea" es sospechoso por definición, y el dato es gratis: ya
   *  se consultó el equipo en validarFormaDespacho. */
  async evaluarUreaEquipoNoHabilitado(client: PoolClient, tenantId: string, equipoId: number) {
    const equipo = await EquiposRepository.findTipoMedidor(client, tenantId, equipoId);
    if (!equipo || equipo.usa_urea) return null;
    return { equipoId, placaCodigo: equipo.placa_codigo };
  }

  /** Ventana del ratio urea/diésel -- 30 días fijos, no configurable.
   *  Una ventana de 24 h (como el tope diario) es demasiado corta: un
   *  volquete puede cargar diésel un día y urea al siguiente sin que se
   *  vean juntos nunca. El ratio busca un patrón CRÓNICO por equipo, no un
   *  pico de un día -- para eso alcanza con el tope diario de arriba. */
  static readonly DIAS_VENTANA_RATIO_UREA = 30;

  /** RATIO UREA/DIÉSEL POR EQUIPO -- el control que la urea permite y el
   *  combustible solo no tiene: un motor SCR consume urea en proporción
   *  más o menos estable a lo que quema de diésel (~3-5% típico). Los dos
   *  movimientos viven en la MISMA tabla con el MISMO equipo_id, así que
   *  el cruce no necesita ningún dato nuevo -- es la ventaja de compartir
   *  tabla, no un accidente.
   *
   *  Arranca en NULL (sin `ratio_urea_diesel_max_pct` configurado, ver
   *  0092): el cliente todavía no dio un número real, y un ratio inventado
   *  o alerta por trabajo normal (se ignora) o queda tan holgado que no
   *  atrapa nada -- mismo criterio que todos los umbrales del módulo desde
   *  0075/0079.
   *
   *  Sin litros de diésel en la ventana no se puede calcular un ratio
   *  honesto (dividir por cero, o un equipo que recién empieza a cargar
   *  diésel de este tanque) -- se devuelve null, no se alerta por falta de
   *  dato de comparación. */
  async evaluarUreaRatioExcedido(
    client: PoolClient,
    tenantId: string,
    equipoId: number,
    despachadoEn: string
  ) {
    const maxPct = (await this.repository.getTopesUrea(client, tenantId)).ratioUreaDieselMaxPct;
    if (maxPct === null) return null;

    const { litrosUrea, litrosDiesel } = await this.repository.findRatioUreaDiesel(
      client,
      tenantId,
      equipoId,
      despachadoEn,
      CombustibleService.DIAS_VENTANA_RATIO_UREA
    );
    if (litrosDiesel <= 0) return null;

    const ratioPct = (litrosUrea / litrosDiesel) * 100;
    if (ratioPct <= maxPct) return null;

    return {
      equipoId,
      litrosUrea: Number(litrosUrea.toFixed(2)),
      litrosDiesel: Number(litrosDiesel.toFixed(2)),
      ratioPct: Number(ratioPct.toFixed(1)),
      maxPct,
      diasVentana: CombustibleService.DIAS_VENTANA_RATIO_UREA,
    };
  }

  /** TOPE DIARIO DE UREA POR EQUIPO -- mismo motor que el tope diario de
   *  combustible (0079, `findAcumuladoDiario`), pero sin la rama de
   *  "llenados × capacidad del tanque del equipo": la urea no tiene una
   *  capacidad de tanque por equipo de la que derivar un múltiplo, así que
   *  el único techo posible es el valor absoluto (`tope_diario_urea_l`).
   *  Un vale de urea siempre va a un equipo (ver la forma en 0092), así
   *  que no hace falta la rama "sin equipo" del tope de combustible. */
  async evaluarTopeDiarioUrea(
    client: PoolClient,
    tenantId: string,
    despacho: { despachoId: number; equipoId: number; despachadoEn: string }
  ) {
    const topeL = (await this.repository.getTopesUrea(client, tenantId)).topeDiarioUreaL;
    if (topeL === null) return null;

    const actor = { equipoId: despacho.equipoId } as const;
    const [conEste, sinEste] = await Promise.all([
      this.repository.findAcumuladoDiario(client, tenantId, "urea", actor, despacho.despachadoEn),
      this.repository.findAcumuladoDiario(
        client,
        tenantId,
        "urea",
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
      ventanaDesde: conEste.desdeEn ? new Date(conEste.desdeEn).toISOString() : null,
      ventanaHasta: conEste.hastaEn ? new Date(conEste.hastaEn).toISOString() : null,
      ventanaHoras: 24,
      equipoId: despacho.equipoId,
    };
  }

  // ── Conteo físico de urea (migración 0092) ────────────────────────────

  crearConteoUrea(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    data: CrearConteoUreaInput
  ) {
    return idempotentInsert({
      client,
      tenantId,
      modulo: "combustible",
      clienteUuid: data.cliente_uuid,
      insertar: async () => {
        const cantidadLitros = data.cantidad_bultos * FACTOR_LITROS_UREA[data.presentacion];
        const fila = await this.repository.crearConteoUrea(client, tenantId, usuarioId, {
          cantidadLitros,
          contadoEn: data.contado_en ?? new Date().toISOString(),
          observaciones: data.observaciones ?? null,
        });
        return { id: Number(fila.id), fila };
      },
      recuperar: (filaId) => this.repository.findConteoUreaPorId(client, tenantId, filaId),
    });
  }

  listarConteosUrea(client: PoolClient, tenantId: string, paginacion: Paginacion) {
    return this.repository.findConteosUrea(client, tenantId, paginacion);
  }

  getConteoUreaPorId(client: PoolClient, tenantId: string, id: number) {
    return this.repository.findConteoUreaPorId(client, tenantId, id);
  }

  anularConteoUrea(
    client: PoolClient,
    tenantId: string,
    id: number,
    usuarioId: string,
    motivo: string
  ) {
    return this.repository.anularConteoUrea(client, tenantId, id, usuarioId, motivo);
  }

  /** EL DESCUADRE DE UREA -- el equivalente exacto del descuadre de
   *  inventario del tanque (0074), pero contra el conteo físico de cajas en
   *  vez de la varilla. `esperado` = stock teórico A LA FECHA DEL CONTEO
   *  (entradas - salidas vigentes hasta ese momento); `descuadre` =
   *  contado - esperado.
   *
   *  Arranca en NULL (`ratio_urea_diesel_max_pct` reusa el mismo criterio,
   *  pero acá el umbral es el de RATIO -- no hay un umbral propio de
   *  descuadre de urea todavía: el cliente nunca dio un número, y este
   *  control recién nace con esta migración. Se alerta con un criterio
   *  conservador fijo (cualquier diferencia > 0) hasta que haya una
   *  calibración real -- mismo espíritu que "estricto por default" de
   *  0088, nunca al revés. */
  async evaluarUreaDescuadreConteo(
    client: PoolClient,
    tenantId: string,
    conteoId: number,
    cantidadLitros: number,
    contadoEn: string
  ) {
    const esperado = await this.repository.findStockTeoricoUrea(client, tenantId, contadoEn);
    const descuadre = Number((cantidadLitros - esperado).toFixed(2));
    if (descuadre === 0) return null;
    return {
      conteoId,
      contadoL: cantidadLitros,
      esperadoL: Number(esperado.toFixed(2)),
      descuadreL: descuadre,
    };
  }

  /** ¿Hace cuánto que nadie cuenta la urea? Mismo criterio que
   *  findTanquesSinMedir (0076): alerta si pasaron más días que
   *  `dias_sin_conteo_urea` desde el último conteo VIGENTE, o si nunca hubo
   *  ninguno. */
  async evaluarUreaSinConteo(client: PoolClient, tenantId: string) {
    const dias = await this.repository.getDiasSinConteoUrea(client, tenantId);
    const ultimo = await this.repository.findUltimoConteoUreaVigente(client, tenantId);
    if (ultimo === null) return { diasSinConteo: null, limiteDias: dias };
    const diasTranscurridos = Math.floor(
      (Date.now() - new Date(ultimo.contadoEn).getTime()) / (24 * 3600 * 1000)
    );
    if (diasTranscurridos <= dias) return null;
    return { diasSinConteo: diasTranscurridos, limiteDias: dias };
  }

  /** Días de historial que mira la sugerencia de topes. Noventa: suficiente
   *  para tener los picos de un mes de trabajo fuerte sin arrastrar una
   *  operación que ya cambió. */
  static readonly DIAS_HISTORIAL_TOPES = 90;

  /** SUGERENCIA DE LOS DOS TOPES DIARIOS desde el historial del tenant.
   *
   *  Kenif (2026-09-14): "hay que ponerle un tope pero igual hay que guiarnos
   *  por el historial luego para que nos recomiende". Mismo contrato que el
   *  asistente de umbrales del tanque: promedio + 2 desvíos, mínimo 10 días
   *  con movimiento, la muestra entera en la respuesta y NUNCA se aplica solo.
   *
   *  ── Por qué el tope sin capacidad se calcula POR ACTOR y se toma el mayor ─
   *
   *  `tope_diario_sin_capacidad_l` es UN número para todos los actores sin
   *  capacidad: planta, reserva y cada equipo que no tenga capacidad cargada.
   *  Mezclar sus días en una sola muestra daría un número entre el consumo de
   *  planta y el de un equipo chico: planta alertaría todos los días por
   *  trabajo normal y el control moriría por ruidoso. Se calcula el tope de
   *  cada actor por separado y se sugiere el del actor que más consume
   *  legítimamente -- con el aviso de que para los chicos queda holgado.
   *
   *  `llenados_por_dia_max` sí se puede juntar: es litros / capacidad, un
   *  número sin unidades que se compara entre equipos distintos.
   *
   *  LA MUESTRA PUEDE TENER ROBO. Si alguien ya venía sacando de más por
   *  planta, su promedio lo incluye y el tope sugerido lo tolera. Por eso la
   *  respuesta trae el día máximo de cada actor: un día muy por encima del
   *  resto es lo primero que una persona tiene que mirar antes de aceptar. */
  async sugerirTopesDiarios(client: PoolClient, tenantId: string) {
    const filas = await this.repository.findDespachadoPorDiaYActor(
      client,
      tenantId,
      CombustibleService.DIAS_HISTORIAL_TOPES
    );

    const estadistico = (valores: number[]) => {
      const n = valores.length;
      const promedio = valores.reduce((a, b) => a + b, 0) / n;
      const varianza = n > 1 ? valores.reduce((a, v) => a + (v - promedio) ** 2, 0) / (n - 1) : 0;
      return { promedio, desviacion: Math.sqrt(varianza), maximo: Math.max(...valores) };
    };

    // ── Tope sin capacidad: por actor ─────────────────────────────────────
    const sinCapacidad = new Map<string, number[]>();
    for (const f of filas) {
      if (f.capacidadL !== null) continue;
      const lista = sinCapacidad.get(f.actor) ?? [];
      lista.push(f.litros);
      sinCapacidad.set(f.actor, lista);
    }
    const porActor = [...sinCapacidad.entries()].map(([actor, litros]) => {
      if (litros.length < CombustibleService.MINIMO_MUESTRA) {
        return { actor, diasConMovimiento: litros.length, muestraSuficiente: false as const };
      }
      const e = estadistico(litros);
      return {
        actor,
        diasConMovimiento: litros.length,
        muestraSuficiente: true as const,
        promedioL: Number(e.promedio.toFixed(0)),
        diaMaximoL: Number(e.maximo.toFixed(0)),
        topeSugeridoL: Number((e.promedio + 2 * e.desviacion).toFixed(0)),
      };
    });
    const conMuestra = porActor.filter((a) => a.muestraSuficiente) as Extract<
      (typeof porActor)[number],
      { muestraSuficiente: true }
    >[];
    const mayor = conMuestra.sort((a, b) => b.topeSugeridoL - a.topeSugeridoL)[0];

    // ── Llenados por día: juntos, porque es una proporción ────────────────
    const proporciones = filas
      .filter((f) => f.capacidadL !== null && f.capacidadL > 0)
      .map((f) => f.litros / f.capacidadL!);
    const llenados =
      proporciones.length < CombustibleService.MINIMO_MUESTRA
        ? {
            muestraSuficiente: false as const,
            tamanioMuestra: proporciones.length,
            minimoRequerido: CombustibleService.MINIMO_MUESTRA,
          }
        : (() => {
            const e = estadistico(proporciones);
            return {
              muestraSuficiente: true as const,
              tamanioMuestra: proporciones.length,
              promedio: Number(e.promedio.toFixed(2)),
              maximoObservado: Number(e.maximo.toFixed(2)),
              // Nunca por debajo de 1: un equipo tiene que poder llenar su
              // tanque una vez por día sin que eso sea un hallazgo.
              sugerido: Number(Math.max(1, e.promedio + 2 * e.desviacion).toFixed(1)),
            };
          })();

    return {
      diasHistorial: CombustibleService.DIAS_HISTORIAL_TOPES,
      minimoRequerido: CombustibleService.MINIMO_MUESTRA,
      topeSinCapacidad: {
        muestraSuficiente: mayor !== undefined,
        sugeridoL: mayor?.topeSugeridoL ?? null,
        // A qué actor corresponde el número: el que más consume. Para los
        // demás el tope queda holgado, y eso se dice.
        actorQueLoDefine: mayor?.actor ?? null,
        porActor,
      },
      llenadosPorDia: llenados,
    };
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

  /** EL VALE RETRO-FECHADO (migración 0081).
   *
   *  `despachado_en` lo escribe quien carga; `creado_en` lo pone el servidor.
   *  La distancia entre los dos es el dato: la cola offline produce horas, a
   *  veces un par de días --un tanque sin señal sincroniza cuando el operador
   *  vuelve a base-- pero un vale cargado tres semanas después de su fecha no
   *  es sincronización, es alguien eligiendo una fecha.
   *
   *  El red team lo usó para sacar un despacho de la cuenta de "lo que se
   *  movió con la vigilancia baja": fechándolo antes del aflojamiento, salía
   *  del filtro del reporte de controles.
   *
   *  Devuelve null en el caso normal, que es la enorme mayoría: el vale se
   *  carga el mismo día o al día siguiente. */
  async evaluarDespachoRetroactivo(
    client: PoolClient,
    tenantId: string,
    combustibleId: number | null,
    despachoId: number,
    despachadoEn: string
  ) {
    const dias = await this.repository.getDiasCargaRetroactiva(client, tenantId);
    const atraso = (Date.now() - Date.parse(despachadoEn)) / 864e5;
    if (!Number.isFinite(atraso) || atraso <= dias) return null;

    // ── La segunda condición, que es la que saca el ruido ────────────────
    //
    // La primera versión solo miraba los días de atraso, y eso confundía dos
    // cosas distintas. Se vio corriendo la simulación contra el ERP real: de
    // 33 vales, 29 dispararon la alerta -- porque una operación cargada desde
    // el papel tiene TODOS los vales viejos, y son todos legítimos.
    //
    // Un control que se enciende con la carga inicial de cualquier cliente
    // nuevo se ignora en una semana, y ahí se pierde también el día que
    // importaba. Misma lección que dejó "marcar todas leídas".
    //
    // Lo que separa la carga inicial del vale metido atrás NO es la edad del
    // vale: es si el tanque YA TIENE movimiento más reciente. Cargando el
    // historial en orden, cada vale es el más nuevo y no hay nada detrás de
    // qué esconderse. Metiendo uno de hace tres semanas entre el tráfico de
    // hoy, sí lo hay.
    //
    // Es exactamente el criterio de `lectura_retroactiva` (0078), que nunca
    // alertó por ser vieja sino por estar insertada detrás de algo.
    if (!combustibleId) return null;
    const ultimo = await this.repository.findUltimoMovimiento(
      client,
      tenantId,
      combustibleId,
      despachoId
    );
    if (!ultimo) return null;
    if (new Date(ultimo).getTime() <= Date.parse(despachadoEn) + dias * 864e5) return null;

    return {
      // Contra qué se lo comparó: el movimiento que ya estaba y es más nuevo.
      // Sin ese dato la alerta no se puede evaluar sin abrir el historial.
      ultimoMovimientoPrevio: new Date(ultimo).toISOString(),
      diasDeAtraso: Number(atraso.toFixed(1)),
      diasTolerados: dias,
      despachadoEn,
      cargadoEn: new Date().toISOString(),
    };
  }

  /** EL VALE QUE SE VUELVE A CARGAR (migración 0081).
   *
   *  La unicidad de 0067 es parcial a propósito: anular un vale mal tipeado y
   *  volver a cargarlo con el número correcto es la corrección, y prohibirla
   *  borraría del sistema un despacho que sí ocurrió. Esa migración anticipó
   *  que el patrón sería la señal; esto es el detector que faltaba.
   *
   *  Lo que importa NO es que el número se reutilice --eso es la corrección
   *  funcionando-- sino QUE LA CANTIDAD CAMBIE. Cargar 900 L, anular con
   *  "error de tipeo" y volver a cargar 240 deja el talonario impecable y 660
   *  L fuera del sistema.
   *
   *  Por eso una recarga con la MISMA cantidad no alerta: ahí se corrigió
   *  otra cosa (el equipo, la hora, el contómetro) y el combustible declarado
   *  no se movió. */
  async evaluarValeRecargado(
    client: PoolClient,
    tenantId: string,
    producto: string,
    serieTalonario: string,
    nVale: number,
    cantidadNueva: number
  ) {
    const previas = await this.repository.findAnulacionesDelVale(
      client,
      tenantId,
      producto,
      serieTalonario,
      nVale
    );
    if (previas.length === 0) return null;

    const ultima = previas[previas.length - 1];
    if (ultima.cantidad === cantidadNueva) return null;

    const diferencia = Number((cantidadNueva - ultima.cantidad).toFixed(2));
    return {
      anulacionesPrevias: previas.length,
      cantidadAnulada: ultima.cantidad,
      cantidadNueva,
      diferencia,
      // La dirección importa: recargar por MENOS es declarar que salió menos
      // combustible del que el vale original decía.
      sentido: diferencia < 0 ? ("declara_menos" as const) : ("declara_mas" as const),
      motivosPrevios: previas.map((p) => p.motivo).filter(Boolean),
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
      this.repository.findAcumuladoDiario(
        client,
        tenantId,
        "combustible",
        actor,
        despacho.despachadoEn
      ),
      this.repository.findAcumuladoDiario(
        client,
        tenantId,
        "combustible",
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
      // Qué ventana de 24 h es la que no cierra. Con la ventana simétrica ya
      // no es "las 24 h antes del vale", así que hay que decirlo o el aviso
      // no se puede verificar contra el talonario.
      ventanaDesde: conEste.desdeEn ? new Date(conEste.desdeEn).toISOString() : null,
      ventanaHasta: conEste.hastaEn ? new Date(conEste.hastaEn).toISOString() : null,
      base: base!,
      ventanaHoras: 24,
      equipoId: despacho.equipoId,
      tipoDestino: despacho.tipoDestino,
    };
  }

  /** Arma el kardex del tanque a partir de las filas crudas del repositorio.
   *
   *  El SQL ya trae el saldo teórico corriente; acá se agregan las DOS
   *  diferencias, que contestan preguntas distintas y por eso van las dos:
   *
   *  - `difTramo`: medido - teórico contra la varilla ANTERIOR. Ubica CUÁNDO
   *    pasó: aísla el movimiento entre dos mediciones.
   *  - `difAcumulada`: medido - teórico contra el arranque del período. Dice
   *    CUÁNTO falta en total, y es el número que va al informe.
   *
   *  Las dos solo tienen sentido en las filas de varilla -- en un despacho o
   *  una recepción no hay nada medido con qué contrastar.
   *
   *  Ojo con la varilla ANULADA: no contrasta nada. Su nivel no es un dato
   *  bueno (por eso se anuló), así que no genera diferencia ni mueve el
   *  ancla del tramo siguiente. Aparece en la lista como evidencia y nada
   *  más. */
  async armarKardex(
    client: PoolClient,
    tenantId: string,
    combustibleId: number,
    desde: string,
    hasta: string
  ) {
    const tanque = await this.repository.findById(client, tenantId, combustibleId);
    if (!tanque) return null;

    const crudas = await this.repository.findKardex(client, tenantId, combustibleId, desde, hasta);

    // Diferencia acumulada del período: se mide contra el saldo teórico, que
    // arrastra desde el ancla sin corregirse nunca (ver findKardex).
    // La del tramo necesita recordar dónde quedó la última varilla buena.
    let ultimaDifValida: number | null = null;

    const filas = crudas.map((f) => {
      const anulada = f.anulada_en !== null;
      const esLectura = f.tipo === "lectura";
      const nivelMedido = f.nivel_medido === null ? null : Number(f.nivel_medido);
      const saldoTeorico = Number(f.saldo_teorico);

      let difAcumulada: number | null = null;
      let difTramo: number | null = null;

      if (esLectura && !anulada && nivelMedido !== null) {
        difAcumulada = Number((nivelMedido - saldoTeorico).toFixed(2));
        difTramo = Number((difAcumulada - (ultimaDifValida ?? 0)).toFixed(2));
        ultimaDifValida = difAcumulada;
      }

      return {
        ocurrido_en: f.ocurrido_en,
        tipo: f.tipo,
        referencia_id: f.referencia_id,
        documento: f.documento,
        detalle: f.detalle,
        entrada: Number(f.entrada),
        salida: Number(f.salida),
        nivel_medido: nivelMedido,
        // Un movimiento anulado no mueve el saldo, así que mostrar la columna
        // sería sugerir que sí participó de la cuenta.
        saldo_teorico: anulada || f.historico ? null : saldoTeorico,
        historico: f.historico,
        dif_tramo: difTramo,
        dif_acumulada: difAcumulada,
        usuario: f.usuario ?? "Sistema",
        anulada: anulada,
        motivo_anulacion: f.motivo_anulacion,
        // El contador acumulativo del surtidor en ese vale o varilla (0094,
        // 0096). null si el punto no lo lleva.
        totalizador: f.totalizador === null ? null : Number(f.totalizador),
        // Una varilla que leyó varios surtidores (0098): "S1: 100 · S2: 200".
        totalizador_texto: f.totalizador_texto,
      };
    });

    return {
      tanque: {
        id: tanque.id,
        codigo: tanque.codigo,
        tanque_nombre: tanque.tanque_nombre,
        unidad: tanque.unidad,
        capacidad_total: Number(tanque.capacidad_total),
      },
      periodo: { desde, hasta },
      // El saldo con el que arranca la cuenta. Sale del SQL: es el saldo
      // teórico de la primera fila menos lo que esa fila movió.
      // La primera fila que SÍ movió el saldo: las anuladas y el histórico
      // no tienen saldo teórico y no sirven de punto de partida.
      saldo_inicial: (() => {
        const f = filas.find((x) => x.saldo_teorico !== null);
        return f ? Number((f.saldo_teorico! - f.entrada + f.salida).toFixed(2)) : null;
      })(),
      filas,
      // El cierre del período, que es lo que un auditor copia al informe.
      resumen: {
        entradas: Number(
          filas.reduce((a, f) => a + (f.anulada || f.historico ? 0 : f.entrada), 0).toFixed(2)
        ),
        salidas: Number(
          filas.reduce((a, f) => a + (f.anulada || f.historico ? 0 : f.salida), 0).toFixed(2)
        ),
        // Lo previo a la primera varilla: se ve, pero no entra a la cuenta.
        historico: resumirHistorico(filas),
        mediciones: filas.filter((f) => f.tipo === "lectura" && !f.anulada).length,
        anulados: filas.filter((f) => f.anulada).length,
        // La última diferencia acumulada del período: el número que hay que
        // explicar. null si no hubo ninguna varilla -- sin medición no hay
        // nada que contrastar, y decir "0" sería mentir.
        descuadre_final: ultimaDifValida,
      },
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
      // Los pasos de la cuenta, para la exportación. La pantalla no los usa.
      recibidoEn: m.recibido_en,
      documento: m.documento,
      nivelAntes: m.nivel_antes,
      nivelDespues: m.nivel_despues,
      salidas: m.salidas,
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
  static readonly MINIMO_MUESTRA = 10;
  static readonly PISO_PCT = 1;

  /** Con menos filas que el mínimo no se calcula ningún número. */
  static muestraInsuficiente<T>(tamanio: number, muestra: T[]) {
    return {
      muestraSuficiente: false as const,
      tamanioMuestra: tamanio,
      minimoRequerido: CombustibleService.MINIMO_MUESTRA,
      // La muestra viaja aunque no alcance para sugerir. No es para la
      // pantalla -- ahí sigue sin mostrarse ningún número, que es el punto
      // del mínimo -- sino para que la exportación pueda mostrar las pocas
      // mediciones que hay. "Todavía no puedo sugerir, pero esto es lo que
      // llevo medido" es información útil; esconderla no protege de nada.
      muestra,
    };
  }

  /** Los valores que están MUY fuera de escala respecto del resto.
   *
   *  Por qué hace falta, y es el punto ciego que la 5ª auditoría dejó
   *  anotado: la muestra con la que se calibra puede contener el robo que se
   *  quiere detectar, y basta con ensuciar unas pocas mediciones para que el
   *  desvío se dispare y la sugerencia proponga tolerar justo lo que no hay
   *  que tolerar. Ya había pasado sin mala intención: en el tenant de pruebas,
   *  dos mediciones fuera de escala llevaban la sugerencia de 1,8 % a 14,5 %.
   *
   *  Se usa la MEDIANA y la desviación absoluta mediana (MAD), no el promedio
   *  y el desvío: el promedio y el desvío los MUEVEN los propios valores
   *  atípicos, así que usarlos para detectarlos es pedirle al contaminado que
   *  se denuncie solo. La mediana casi no se mueve.
   *
   *  El 1,4826 convierte la MAD en algo comparable a un desvío estándar
   *  cuando los datos son normales; el corte en 3 de esos es el criterio
   *  clásico. Con MAD 0 (casi todas las mediciones idénticas) no se marca
   *  nada: ahí no hay dispersión contra la cual comparar. */
  private static detectarAtipicos(valores: number[]): { indices: number[]; corte: number | null } {
    if (valores.length < CombustibleService.MINIMO_MUESTRA) return { indices: [], corte: null };
    const mediana = (xs: number[]) => {
      const o = [...xs].sort((a, b) => a - b);
      const m = Math.floor(o.length / 2);
      return o.length % 2 ? o[m] : (o[m - 1] + o[m]) / 2;
    };
    const med = mediana(valores);
    const mad = mediana(valores.map((v) => Math.abs(v - med))) * 1.4826;
    if (!(mad > 0)) return { indices: [], corte: null };
    const corte = 3 * mad;
    const indices = valores
      .map((v, i) => (Math.abs(v - med) > corte ? i : -1))
      .filter((i) => i >= 0);
    return { indices, corte };
  }

  /** Vuelve a calcular la sugerencia SIN los valores atípicos, y devuelve las
   *  dos cifras. La pantalla muestra las dos y deja elegir: quien decide tiene
   *  que ver que hay mediciones fuera de escala ANTES de aceptar un número que
   *  esas mediciones inflaron. */
  private static conAtipicos<T>(
    valoresPct: number[],
    muestra: T[],
    calcular: (v: number[]) => number
  ) {
    const { indices } = CombustibleService.detectarAtipicos(valoresPct);
    if (indices.length === 0) return { atipicos: null };
    const limpios = valoresPct.filter((_, i) => !indices.includes(i));
    return {
      atipicos: {
        cantidad: indices.length,
        // En porcentaje, que es la unidad de la sugerencia.
        valoresPct: indices.map((i) => Number(valoresPct[i].toFixed(2))),
        // Las filas completas, para poder mirarlas sin abrir la planilla.
        mediciones: indices.map((i) => muestra[i]),
        sugeridoSinEllos:
          limpios.length >= CombustibleService.MINIMO_MUESTRA
            ? Number(calcular(limpios).toFixed(1))
            : null,
      },
    };
  }

  private static calibrar<T>(valoresPct: number[], muestra: T[]) {
    if (valoresPct.length < CombustibleService.MINIMO_MUESTRA) {
      return CombustibleService.muestraInsuficiente(valoresPct.length, muestra);
    }

    const formula = (valores: number[]) => {
      const abs = valores.map((v) => Math.abs(v));
      const promedio = abs.reduce((a, b) => a + b, 0) / abs.length;
      const varianza = abs.reduce((acc, v) => acc + (v - promedio) ** 2, 0) / (abs.length - 1);
      const desviacion = Math.sqrt(varianza);
      return {
        promedio,
        desviacion,
        sugerido: Math.min(100, Math.max(CombustibleService.PISO_PCT, promedio + 2 * desviacion)),
      };
    };
    const { promedio, desviacion, sugerido } = formula(valoresPct);

    return {
      muestraSuficiente: true as const,
      tamanioMuestra: valoresPct.length,
      minimoRequerido: CombustibleService.MINIMO_MUESTRA,
      sugerido: Number(sugerido.toFixed(1)),
      promedio: Number(promedio.toFixed(2)),
      desviacion: Number(desviacion.toFixed(2)),
      ...CombustibleService.conAtipicos(valoresPct, muestra, (v) => formula(v).sugerido),
      muestra,
    };
  }

  /** El estadístico de la VENTANA: 2 desviaciones de la diferencia CON SIGNO,
   *  sin sumar el promedio y sin multiplicar por la cantidad de tramos.
   *
   *  Por qué no se multiplica por √n aunque la ventana sume decenas de tramos:
   *  los tramos no son independientes. Cada uno arranca en la varilla donde
   *  terminó el anterior, así que el error de una varilla entra dos veces con
   *  signo contrario (+e en el tramo que termina en ella, −e en el que arranca)
   *  y se cancela. La suma de la ventana telescopa a
   *  `medido_final − medido_inicial − recepciones + despachos`: arrastra el error
   *  de DOS varillas, igual que un tramo solo. Con √n la sugerencia salía varias
   *  veces más grande que el ruido real, y un umbral así deja pasar el robo de a
   *  poco que este control existe para agarrar.
   *
   *  Por qué la desviación respecto del promedio CON SIGNO, y no de |x| como los
   *  otros tres: un robo sistemático (siempre falta lo mismo) corre el promedio
   *  pero no agranda la desviación, así que no infla la sugerencia. Con |x| el
   *  robo pasaría por ruido y la fórmula propondría tolerarlo.
   *
   *  Lo que NO modela: el error del contómetro o del vale, que no telescopa y sí
   *  crece con los despachos de la ventana. Sumarlo bien pide la tolerancia real
   *  del medidor, que es un dato del cliente y no un número para inventar. Hasta
   *  entonces lo cubre el piso de 1 %. */
  private static calibrarConSigno<T>(valoresPct: number[], muestra: T[]) {
    const n = valoresPct.length;
    if (n < CombustibleService.MINIMO_MUESTRA) {
      return CombustibleService.muestraInsuficiente(n, muestra);
    }

    const formula = (valores: number[]) => {
      const prom = valores.reduce((a, b) => a + b, 0) / valores.length;
      const varianza = valores.reduce((acc, v) => acc + (v - prom) ** 2, 0) / (valores.length - 1);
      const desv = Math.sqrt(varianza);
      return {
        promedio: prom,
        desviacion: desv,
        sugerido: Math.min(100, Math.max(CombustibleService.PISO_PCT, 2 * desv)),
      };
    };
    const { promedio, desviacion, sugerido } = formula(valoresPct);

    return {
      muestraSuficiente: true as const,
      tamanioMuestra: n,
      minimoRequerido: CombustibleService.MINIMO_MUESTRA,
      sugerido: Number(sugerido.toFixed(1)),
      // Con signo: la tendencia por tramo. No entra en la sugerencia, pero lejos
      // de 0 dice que algo falta (o sobra) siempre para el mismo lado.
      promedio: Number(promedio.toFixed(2)),
      desviacion: Number(desviacion.toFixed(2)),
      ...CombustibleService.conAtipicos(valoresPct, muestra, (v) => formula(v).sugerido),
      muestra,
    };
  }

  /** Las cuatro sugerencias del tanque, en secuencia sobre el mismo cliente: pg
   *  no admite dos consultas a la vez sobre un cliente (hoy lo avisa con un
   *  DeprecationWarning, en pg@9 lo va a rechazar).
   *
   *  Descuadre, ciclo y ventana salen de la MISMA muestra de tramos, así que se
   *  consulta una sola vez. Antes cada una hacía su propia pasada sobre todo el
   *  historial de lecturas del tanque. */
  async sugerirUmbrales(client: PoolClient, tenantId: string, combustibleId: number) {
    const diferencia = await this.sugerirUmbralDiferencia(client, tenantId, combustibleId);
    const intervalos = await this.repository.findMuestraDescuadresParaCalibracion(
      client,
      tenantId,
      combustibleId
    );
    const diasVentana = await this.repository.getDiasVentanaDescuadre(client, tenantId);

    return {
      diferencia,
      descuadre: CombustibleService.calibrarDescuadre(intervalos),
      ciclo: CombustibleService.calibrarCiclo(intervalos),
      // Los días no entran en la cuenta (ver calibrarConSigno): viajan para que
      // la exportación diga sobre cuántos días suma la alerta.
      ventana: { ...CombustibleService.calibrarVentana(intervalos), diasVentana },
    };
  }

  /** Un punto por tramo, medido contra la capacidad del tanque (la base que usa
   *  la alerta en vivo). Lo comparten el umbral por tramo y el de la ventana. */
  private static puntosDeTramo(intervalos: IntervaloCalibracion[]) {
    return intervalos
      .filter((i) => i.capacidad > 0)
      .map((i) => ({
        descuadreLitros: Number(i.descuadre.toFixed(2)),
        descuadrePct: (i.descuadre / i.capacidad) * 100,
        leidoEn: i.leido_en,
        // Los pasos de la cuenta, para la exportación: con esto cada fila del
        // archivo muestra de dónde sale su descuadre, no solo el resultado.
        leidoEnAnterior: i.leido_en_anterior,
        nivelAnterior: i.nivel_anterior,
        despachos: i.despachos,
        recepciones: i.recepciones,
        nivelMedido: i.nivel,
        origen: i.origen,
      }));
  }

  /** Umbral de descuadre POR TRAMO: un punto por cada intervalo entre dos
   *  lecturas consecutivas (ver `evaluarDescuadre`). */
  private static calibrarDescuadre(intervalos: IntervaloCalibracion[]) {
    const puntos = CombustibleService.puntosDeTramo(intervalos);
    return CombustibleService.calibrar(
      puntos.map((p) => p.descuadrePct),
      puntos
    );
  }

  /** Umbral acumulado de la VENTANA: los mismos tramos que el de descuadre,
   *  con otro estadístico (ver `calibrarConSigno`). */
  private static calibrarVentana(intervalos: IntervaloCalibracion[]) {
    const puntos = CombustibleService.puntosDeTramo(intervalos);
    return CombustibleService.calibrarConSigno(
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
  private static calibrarCiclo(intervalos: IntervaloCalibracion[]) {
    type Ciclo = {
      descuadreLitros: number;
      capacidad: number;
      intervalos: number;
      desde: Date;
      hasta: Date;
    };
    const ciclos: Ciclo[] = [];
    let actual: Ciclo | null = null;

    for (const i of intervalos) {
      // Solo una carga de verdad abre un ciclo (ver findSaldoCiclo): una
      // recepción de 1 L no cierra un período de consumo.
      if (i.recepcionesAncla > 0) {
        // Entró combustible: cierra el ciclo anterior y arranca uno nuevo.
        if (actual) ciclos.push(actual);
        actual = {
          descuadreLitros: 0,
          capacidad: i.capacidad,
          intervalos: 0,
          desde: i.leido_en,
          hasta: i.leido_en,
        };
        continue;
      }
      if (!actual) continue; // Todavía no hubo ninguna recepción: sin ciclo que medir.
      actual.descuadreLitros += i.descuadre;
      actual.intervalos += 1;
      actual.hasta = i.leido_en;
    }
    // `actual` queda afuera a propósito: es el ciclo en curso.

    const puntos = ciclos
      .filter((c) => c.capacidad > 0 && c.intervalos > 0)
      .map((c) => ({
        descuadreLitros: Number(c.descuadreLitros.toFixed(2)),
        descuadrePct: (c.descuadreLitros / c.capacidad) * 100,
        intervalos: c.intervalos,
        // Para que la exportación diga QUÉ ciclo es cada fila.
        desde: c.desde,
        hasta: c.hasta,
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
      abasteceUrea: data.abastece_urea,
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
      abasteceUrea: data.abastece_urea,
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
    rol: "ruta" | "tanque" | "urea"
  ) {
    const grifo = await this.repository.findGrifoPorId(client, tenantId, grifoId);
    if (!grifo) {
      throw new Error(`el proveedor ${grifoId} no existe en este tenant`);
    }
    if (rol === "ruta" && !grifo.abastece_ruta) {
      throw new Error(
        `el proveedor "${grifo.nombre}" no está marcado como proveedor de ruta -- marcalo en Proveedores o elegí otro`
      );
    }
    if (rol === "tanque" && !grifo.abastece_tanque) {
      throw new Error(
        `el proveedor "${grifo.nombre}" no está marcado como proveedor de tanque -- marcalo en Proveedores o elegí otro`
      );
    }
    // Tercer rol (migración 0092): el proveedor de urea, confirmado por el
    // cliente como "aparte" de los grifos de combustible (pregunta 9). Un
    // grifo de ruta o de tanque que NO vende urea no puede colarse acá solo
    // porque también está en el mismo catálogo.
    if (rol === "urea" && !grifo.abastece_urea) {
      throw new Error(
        `el proveedor "${grifo.nombre}" no está marcado como proveedor de urea -- marcalo en Proveedores o elegí otro`
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
        const esUrea = data.producto === "urea";

        if (esUrea) {
          // El grifo tiene que estar marcado como proveedor de UREA (0092) --
          // el proveedor "aparte" que confirmó el cliente. No hay tanque que
          // validar ni documento condicional a `requiere_documento` (esa
          // columna es del tanque de combustible, la urea no tiene uno).
          await this.validarRolGrifo(client, tenantId, data.grifo_id, "urea");
        } else {
          await this.validarDatosDeRecepcion(client, tenantId, data, recibidoEn);
          await this.validarPrecintosDeRecepcion(client, tenantId, data);
        }

        // La política vigente HOY queda estampada en la fila (0088): si
        // mañana la empresa apaga la validación, esta recepción sigue
        // debiendo la suya. Aplica igual a urea -- es una política del
        // tenant, no del tanque.
        const politica = await this.repository.getPoliticaValidacionRecepcion(client, tenantId);

        const factorLitros = esUrea ? FACTOR_LITROS_UREA[data.presentacion!] : null;
        const cantidad = esUrea ? data.cantidad_bultos! * factorLitros! : data.cantidad!;

        const fila = await this.repository.crearRecepcion(client, tenantId, usuarioId, {
          producto: data.producto,
          combustibleId: esUrea ? null : data.combustible_id!,
          grifoId: data.grifo_id,
          cantidad,
          presentacion: esUrea ? data.presentacion! : null,
          factorLitros,
          cantidadBultos: esUrea ? data.cantidad_bultos! : null,
          costoUnitario: data.costo_unitario,
          tipoDocumento: data.tipo_documento ?? null,
          numeroDocumento: data.numero_documento ?? null,
          recibidoEn,
          requiereValidacion: politica.requiere,
        });

        // El costo promedio PONDERADO es un concepto del TANQUE (Fase C): la
        // urea no se mezcla físicamente, cada recepción guarda su propio
        // costo y el promedio se deriva al vuelo (ver resolverCostoUrea) --
        // no hay nada que recalcular acá.
        if (!esUrea) {
          await this.repository.recalcularCostoPromedio(client, tenantId, data.combustible_id!);
          // Los sellos nuevos de los puntos que se abrieron para recibir
          // (0095). Misma transacción: una recepción sin su cambio de
          // precinto dejaría la próxima varilla alertando en falso.
          for (const p of data.precintos ?? []) {
            await this.repository.colocarPrecinto(client, tenantId, {
              puntoId: p.punto_id,
              numero: CombustibleService.normalizarNumeroPrecinto(p.numero),
              colocadoEn: recibidoEn,
              usuarioId,
              motivo: `Recepción #${fila.id}`,
              recepcionId: Number(fila.id),
            });
          }
        }
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
  private async validarDatosDeRecepcion(
    client: PoolClient,
    tenantId: string,
    data: CrearRecepcionCombustibleInput,
    recibidoEn: string
  ) {
    const tanque = await this.repository.findTanqueParaRecepcion(
      client,
      tenantId,
      data.combustible_id!
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
      data.combustible_id!,
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
    const totalTrasRecepcion = nivelMedido + data.cantidad!;

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
    filtros: { combustibleId?: number; producto?: string } & PeriodoHistorial,
    paginacion: Paginacion
  ) {
    return this.repository.findRecepciones(client, tenantId, filtros, paginacion);
  }

  getRecepcionPorId(client: PoolClient, tenantId: string, id: number) {
    return this.repository.findRecepcionPorId(client, tenantId, id);
  }

  /** VALIDAR la recepción contra la guía (5ª auditoría, 0088).
   *
   *  El hueco que cierra, verificado atacando la API: el grifero registró
   *  9.000 L de una entrega de 10.000, se llevó la diferencia antes de medir
   *  y NO saltó ninguna alerta -- ni la de diferencia, que dio exactamente 0.
   *  No había forma de que saltara: `cantidad` era a la vez lo que dice la
   *  guía y lo que entró, y la escribía una sola persona.
   *
   *  La validación es el segundo testigo. Devuelve la recepción actualizada y,
   *  si la cantidad de la guía no coincide con la registrada, el detalle de la
   *  discrepancia para que el controller cree la alerta.
   *
   *  Compara con tolerancia de 0,01 porque son NUMERIC con dos decimales: sin
   *  eso, 9000 y 9000.00 podrían leerse como distintos.
   *
   *  LÍMITE CONOCIDO, y hay que decirlo: si quien valida es el mismo que
   *  registró, esto no prueba nada -- por eso queda marcado como
   *  autovalidación y se ve en el reporte de segregación. Ningún software
   *  resuelve que una sola persona haga las dos puntas. */
  async validarRecepcion(
    client: PoolClient,
    tenantId: string,
    recepcionId: number,
    usuarioId: string,
    cantidadDocumento: number
  ) {
    const fila = await this.repository.validarRecepcion(
      client,
      tenantId,
      recepcionId,
      usuarioId,
      cantidadDocumento
    );
    if (!fila) return null;

    await this.repository.resolverRecepcionSinValidarSiExiste(client, tenantId, recepcionId);

    const cantidadRegistrada = Number(fila.cantidad);
    const diferencia = Number((cantidadDocumento - cantidadRegistrada).toFixed(2));
    const autovalidacion = fila.usuario_id !== null && fila.usuario_id === usuarioId;

    return {
      recepcion: fila,
      autovalidacion,
      discrepancia:
        Math.abs(diferencia) < 0.01
          ? null
          : {
              cantidadRegistrada,
              cantidadDocumento,
              diferencia,
              // La dirección importa: si la guía dice MÁS de lo registrado,
              // entró combustible que el sistema no cuenta, y ese sobrante se
              // puede sacar sin que ninguna varilla lo note.
              sentido:
                diferencia > 0 ? ("registrada_de_menos" as const) : ("registrada_de_mas" as const),
            },
    };
  }

  /** La recepción fechada hacia atrás, detrás de movimientos que ya existían
   *  (5ª auditoría). Mismo criterio exacto que `evaluarDespachoRetroactivo`:
   *  no importa que sea vieja --cargar el historial es legítimo-- sino que
   *  haya algo MÁS RECIENTE detrás de lo cual esconderla. Una recepción
   *  insertada atrás mueve el arranque del ciclo y la cuenta de tramos que ya
   *  se evaluaron. */
  async evaluarRecepcionRetroactiva(
    client: PoolClient,
    tenantId: string,
    combustibleId: number,
    recepcionId: number,
    recibidoEn: string
  ) {
    const dias = await this.repository.getDiasCargaRetroactiva(client, tenantId);
    const atraso = (Date.now() - Date.parse(recibidoEn)) / 864e5;
    if (!Number.isFinite(atraso) || atraso <= dias) return null;

    const ultimo = await this.repository.findUltimoMovimientoSinRecepcion(
      client,
      tenantId,
      combustibleId,
      recepcionId
    );
    if (!ultimo) return null;
    if (new Date(ultimo).getTime() <= Date.parse(recibidoEn) + dias * 864e5) return null;

    return {
      ultimoMovimientoPrevio: new Date(ultimo).toISOString(),
      diasDeAtraso: Number(atraso.toFixed(1)),
      diasTolerados: dias,
      recibidoEn,
      cargadaEn: new Date().toISOString(),
    };
  }

  resolverRecepcionSinValidarSiExiste(client: PoolClient, tenantId: string, recepcionId: number) {
    return this.repository.resolverRecepcionSinValidarSiExiste(client, tenantId, recepcionId);
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
