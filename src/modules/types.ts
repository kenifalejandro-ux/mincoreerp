/** src/modules/types.ts
 *
 * Tipos que respalda el Contrato de Módulo (docs/adr/0002-contrato-de-modulo.md).
 */
import type { Router } from "express";

/** Metadata de una tabla de negocio propia de un módulo, para
 *  backup/restore self-service (ver platformBackup.service.ts). Mismo
 *  shape que ya usaba TABLAS_TENANT antes de este cambio — ahora vive
 *  junto a la definición del módulo en vez de mantenerse a mano en un
 *  archivo aparte que nadie se acuerda de actualizar. */
export interface TablaBackupMeta {
  nombre: string;
  pk: "serial" | "uuid";
  /** Columnas GENERATED ALWAYS AS (...) STORED — Postgres rechaza un
   *  INSERT que las mencione explícitamente al restaurar. */
  columnasExcluidasAlRestaurar?: string[];
  /** FK hacia otra tabla de ESTE MISMO backup (de cualquier módulo, no
   *  solo el propio) — solo hace falta cuando se restaura con remapeo de
   *  ids (clonar a otro tenant): { columnaFK: tablaReferenciada }. */
  fks?: Record<string, string>;
  /** La tabla se restaura al MISMO tenant (recuperación ante desastre)
   *  pero se SALTEA al clonar hacia otro tenant.
   *
   *  Es para tablas que guardan un puntero a algo que vive fuera de
   *  Postgres (hoy: documentos_versiones.storage_key → un objeto en
   *  R2/disco). Restaurar sobre el mismo tenant es seguro porque la key
   *  sigue apuntando al archivo correcto, que nunca se movió. Clonar NO lo
   *  es: restaurarTablas() reescribe `tenant_id` pero copia el resto de
   *  las columnas tal cual, así que el tenant destino terminaría con filas
   *  legítimamente suyas cuyo storage_key apunta al archivo del tenant
   *  ORIGEN — y RLS no lo detiene, porque la fila le pertenece de verdad.
   *  Un usuario del clon pidiendo la descarga se bajaría el documento del
   *  otro cliente.
   *
   *  Sacar este flag exige, primero, copiar los objetos en el storage y
   *  reescribir las keys durante el clonado — que no es gratis: el restore
   *  corre dentro de una transacción que el write-drill hace rollback, y
   *  una copia en S3 no se rollbackea con ella. */
  omitirAlClonar?: boolean;
}

export interface ModuloDefinicion {
  /** Debe coincidir con un valor del enum `modulo_erp` (migrations/0008 en
   *  adelante) — ver tests/module-registry.test.ts, que falla si diverge. */
  id: string;
  label: string;
  /** Dónde se monta bajo /api/erp. Omitido = el id. Existe para que un módulo
   *  pueda cambiar de id sin cambiar su URL (ver `flota`, que sigue en
   *  /api/erp/equipos). Mismo valor que el cliente declara en
   *  RUTA_DE_MODULO (client/src/modules/offlineRegistry.ts). */
  ruta?: string;
  /** Módulos que la EMPRESA tiene que tener habilitados para que este se vea
   *  (ej. `viajes` exige `flota`). Se decide por empresa, no por usuario: a
   *  un usuario no se le pide el módulo del que depende. */
  requiere?: string[];
  icono: string;
  /** Puramente informativo hoy (ver tenant_modulos.version, migrations/0021)
   *  — ningún consumidor de modulosPermitidos lo lee todavía. */
  version: string;
  router: Router;
  /** Tablas propias de este módulo, en orden seguro de INSERT (padres
   *  antes que hijos) — así se restaura un backup respetando las FK. Un
   *  módulo sin tablas propias (ej. dashboard, que solo agrega datos de
   *  otros módulos) declara un array vacío. */
  tablas: TablaBackupMeta[];
  /** Subconjunto de `tablas` (mismos nombres) que necesita un DELETE
   *  explícito al vaciar/restaurar un tenant — las que NO están acá se
   *  asume que tienen ON DELETE CASCADE desde alguna de las declaradas
   *  aquí. Mismo orden que `tablas` (padres antes que hijos); el wipe se
   *  ejecuta en el orden inverso automáticamente. */
  raices: string[];
  /** Límite de volumen por tenant para este módulo (ver
   *  docs/architecture/cuotas-por-tenant.md). Omitirlo = el módulo no
   *  tiene cuota: es lo correcto para uno que no crea registros propios
   *  (dashboard solo agrega datos de otros).
   *
   *  `tabla` es cuál de las tablas del módulo se cuenta. Hace falta
   *  declararla explícitamente porque un módulo suele tener varias y solo
   *  una representa "el volumen del cliente": en checklists se cuentan los
   *  checklists llenados, no las plantillas (que son configuración y son
   *  pocas); en iperc se cuentan los IPERC, no las líneas base.
   *
   *  `porDefecto` aplica a todos los tenants salvo override en
   *  tenant_cuotas (migración 0033). Subirlo para todos = cambiar este
   *  número y desplegar. */
  cuota?: { tabla: string; porDefecto: number };
  /** Cuotas ADICIONALES, atadas a rutas específicas del módulo -- para
   *  cuando una escritura de este módulo crece un recurso DISTINTO del
   *  que cuenta `cuota` (ej. Repuestos: el catálogo vs. el histórico de
   *  movimientos de stock). `requireCuota()` (cuota.middleware.ts) se
   *  monta una sola vez por módulo sobre TODO el router -- sin esto, un
   *  solo `cuota.tabla` gobernaría cada POST del módulo por igual, y
   *  mover ese `tabla` a la tabla hija dejaría las altas del recurso
   *  original sin límite real (ver el comentario largo en el registry,
   *  entrada de Repuestos).
   *
   *  `ruta` es relativa al montaje del módulo, mismo formato que
   *  `offline.escrituras` (soporta un segmento comodín `:id`). El recurso
   *  BASE (`cuota`, si existe) sigue aplicando a cualquier POST del
   *  módulo que no matchee ninguna entrada de acá.
   *
   *  `recurso` es un id nuevo, NO el id del módulo -- así
   *  `recursosConCuota()`/`tenant_cuotas`/`plan_limites` lo tratan como un
   *  recurso aparte, con su propio override y su propio límite por plan. */
  cuotasPorRuta?: {
    ruta: string;
    metodo: "POST" | "PUT" | "PATCH";
    recurso: string;
    tabla: string;
    porDefecto: number;
  }[];
  /** Qué escrituras de este módulo se pueden reintentar sin duplicar, y
   *  por lo tanto son elegibles para la cola offline del cliente (ver
   *  client/src/offline/). Omitirlo = el módulo no participa del offline:
   *  sus escrituras fallan como siempre cuando no hay red.
   *
   *  Es explícito y no automático a propósito. Una escritura solo califica
   *  si el servicio que la atiende pasa por idempotentInsert() con el
   *  `cliente_uuid` del body — encolar cualquier POST a ciegas haría que un
   *  reintento cree duplicados, que es justo lo contrario de lo que se
   *  busca. `ruta` es relativa al montaje del módulo (routes/index.ts monta
   *  cada uno bajo /api/erp/<id>), igual que en su archivo de rutas.
   *
   *  Este bloque es el ÚNICO lugar que hay que tocar para sumar un módulo
   *  al offline — el motor del cliente lo lee del registry, no tiene
   *  ninguna lista propia. Ver el checklist de "Nuevo Módulo" en
   *  docs/adr/0002-contrato-de-modulo.md. */
  offline?: {
    escrituras: { metodo: "POST" | "PUT" | "PATCH"; ruta: string }[];
  };
}
