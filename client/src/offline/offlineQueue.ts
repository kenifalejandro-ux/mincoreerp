// client/src/offline/offlineQueue.ts
//
// Cola durable de escrituras pendientes, en IndexedDB.
//
// IndexedDB y no localStorage: localStorage es síncrono (bloquea el hilo
// de UI), tiene ~5MB y guarda solo strings — un checklist con 30 ítems por
// varios equipos lo llena rápido. IndexedDB es asíncrono, guarda objetos
// y tiene cuota de disco real.
//
// Wrapper a mano en vez de idb/dexie: son ~80 líneas contra una dependencia
// nueva en el bundle que viaja a un celular con señal mala. Ver la nota de
// dependencias en dependabot.yml sobre no sumar paquetes al stack sin
// necesidad real.
//
// La cola NO tiene vencimiento propio a propósito: un equipo puede estar
// días sin señal y sus checklists deben seguir ahí cuando vuelva. Lo que sí
// vence es la clave de idempotencia del SERVIDOR (72h, migración 0044),
// que es otra cosa — cubre la ventana entre "el servidor ya lo guardó" y
// "llega el reintento porque la respuesta se perdió".

import { usuarioActivo } from "./sesionOffline";

const DB_NOMBRE = "mincore-offline";
const DB_VERSION = 1;
const STORE = "cola";

/** Un campo de un FormData tal como lo reconstruye offlineSync.ts al
 *  reenviar (ver Caso B, ADR-0002 §8: archivo adjunto de Documentos). Un
 *  `FormData` real no es serializable a JSON de forma trivial (los
 *  `File`/`Blob` que contiene no sobreviven un `JSON.stringify`), así que
 *  se guarda como un array de entradas explícitas en vez del objeto
 *  `FormData` tal cual. */
export type CampoFormData =
  { campo: string; valor: string } | { campo: string; archivo: Blob; nombreArchivo: string };

export interface EntradaCola {
  /** El uuid que generó el dispositivo (crypto.randomUUID()) al armar la
   *  request. Es también la clave primaria del store: reencolar el mismo
   *  envío lo pisa en vez de duplicarlo, y es el mismo valor que viaja en
   *  el body (o en `formData`) como `cliente_uuid` para que el servidor lo
   *  deduplique. */
  clienteUuid: string;
  /** Quién la creó. El servidor toma el autor del JWT de quien sincroniza,
   *  no del body — así que sin esto, en una tablet compartida, la cola de
   *  un operario se drenaría firmada por el que entre después. Ver
   *  sesionOffline.ts. */
  usuarioId: string | null;
  moduloId: string;
  url: string;
  metodo: string;
  /** Ya serializado — el body original puede tener tipos que IndexedDB no
   *  clona bien; guardarlo como string lo hace inmune a eso. Ausente
   *  cuando esta entrada es un archivo adjunto (ver `formData`): las dos
   *  formas son mutuamente excluyentes. */
  body?: string;
  /** Presente solo cuando la request original mandaba `FormData` (subir un
   *  archivo). IndexedDB clona `Blob` nativamente (structured clone), así
   *  que el archivo entero viaja tal cual dentro de esta entrada, sin
   *  pasar por base64. */
  formData?: CampoFormData[];
  creadoEn: number;
  intentos: number;
  ultimoError?: string;
}

let dbPromesa: Promise<IDBDatabase> | null = null;

function abrirDb(): Promise<IDBDatabase> {
  if (dbPromesa) return dbPromesa;
  dbPromesa = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NOMBRE, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "clienteUuid" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  // Si falló al abrir, no cachear el rechazo para siempre: un reintento
  // más adelante (otra pestaña cerró la conexión, se liberó cuota) debe
  // poder volver a intentarlo.
  dbPromesa.catch(() => {
    dbPromesa = null;
  });
  return dbPromesa;
}

function conStore<T>(
  modo: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest
): Promise<T> {
  return abrirDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, modo);
        const req = fn(tx.objectStore(STORE));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error);
      })
  );
}

// ── Suscripción para la UI ─────────────────────────────────────────────
// El badge de "N pendientes" necesita enterarse cuando algo entra o sale
// de la cola. Un emisor propio de 5 líneas alcanza; no hace falta traer
// un store de estado para esto.
type Oyente = (pendientes: number) => void;
const oyentes = new Set<Oyente>();

export function suscribirseACola(oyente: Oyente): () => void {
  oyentes.add(oyente);
  contarPendientes()
    .then(oyente)
    .catch(() => {});
  return () => oyentes.delete(oyente);
}

async function notificar(): Promise<void> {
  const total = await contarPendientes().catch(() => 0);
  for (const oyente of oyentes) oyente(total);
}

// ── Operaciones ────────────────────────────────────────────────────────

/** Dos entradas encoladas en el mismo milisegundo (la compra en ruta y su foto,
 *  una tras otra) empatarían en `creadoEn`, y el orden entre ellas pasaría a ser
 *  el de la clave -- un uuid al azar --: la foto podría salir ANTES de su
 *  compra, dar 404 y descartarse. Cada entrada nueva queda estrictamente
 *  después de la anterior. */
let ultimoCreadoEn = 0;

export async function encolar(entrada: EntradaCola): Promise<void> {
  ultimoCreadoEn = Math.max(entrada.creadoEn, ultimoCreadoEn + 1);
  await conStore("readwrite", (store) => store.put({ ...entrada, creadoEn: ultimoCreadoEn }));
  await notificar();
}

/** Solo las del usuario que está en sesión ahora (ver sesionOffline.ts).
 *  Las de otro operario quedan intactas esperando a que vuelva a entrar. */
export async function listarPendientes(): Promise<EntradaCola[]> {
  const todas = await conStore<EntradaCola[]>("readonly", (store) => store.getAll());
  const actual = usuarioActivo();
  return (
    todas
      .filter((e) => e.usuarioId === actual)
      // FIFO: se sincroniza en el orden en que el operario las llenó, no en
      // el orden arbitrario en que IndexedDB devuelva las claves.
      .sort((a, b) => a.creadoEn - b.creadoEn)
  );
}

/** Cuenta solo las del usuario en sesión — es lo que muestra el badge, y
 *  mostrarle a María "3 pendientes" que son de Carlos y que ella no puede
 *  sincronizar sería peor que no mostrar nada. */
export async function contarPendientes(): Promise<number> {
  return (await listarPendientes()).length;
}

export async function quitarDeLaCola(clienteUuid: string): Promise<void> {
  await conStore("readwrite", (store) => store.delete(clienteUuid));
  await notificar();
}

export async function registrarIntentoFallido(entrada: EntradaCola, error: string): Promise<void> {
  await conStore("readwrite", (store) =>
    store.put({ ...entrada, intentos: entrada.intentos + 1, ultimoError: error })
  );
  await notificar();
}
