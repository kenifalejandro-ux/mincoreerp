// client/src/components/combustible/borradorCompraRuta.ts
//
// El borrador de "Compra en ruta": lo que el conductor lleva escrito se guarda
// en SU dispositivo, para que no lo pierda si se le cierra la pantalla, se le va
// la señal o el celular se queda sin batería a mitad de la boleta.
//
// ── Qué se guarda y qué no ────────────────────────────────────────────────
//
// Se guardan los campos del formulario y el uuid de la compra. El uuid importa:
// si la compra SÍ se había enviado pero la pantalla murió antes de limpiar, al
// reintentar con el mismo uuid el servidor responde "ya registrada" en vez de
// duplicar (y el comprobante repetido también se rechaza).
//
// La FOTO no se guarda: pesa, y un localStorage lleno falla en silencio. Al
// recuperar el borrador la pantalla avisa que hay que volver a elegirla.
//
// ── Por usuario y con vencimiento ─────────────────────────────────────────
//
// La clave lleva el id del usuario: dos personas con el mismo celular no se ven
// el borrador. Un borrador de hace más de 24 h se descarta: coincide con el
// plazo de la foto, y un precio o una fecha de ayer ya no son de fiar.
//
// Todo el acceso al almacenamiento va en try/catch: en modo privado, con los
// datos del sitio bloqueados o sin espacio, falla, y la pantalla tiene que
// funcionar igual sin borrador.

export const VENCIMIENTO_BORRADOR_MS = 24 * 60 * 60 * 1000;

export interface RenglonBorrador {
  clave: string;
  presentacion: string;
  cantidad: string;
  precio: string;
  precioAuto: boolean;
}

export interface BorradorCompraRuta {
  clienteUuid: string;
  equipoId: string;
  grifoId: string;
  comprobanteTipo: "boleta" | "factura";
  comprobanteNumero: string;
  fecha: string;
  fechaEditada: boolean;
  incluyeCombustible: boolean;
  incluyeUrea: boolean;
  tipoCombustible: string;
  galones: string;
  costoUnitario: string;
  costoEditado: boolean;
  horometro: string;
  odometro: string;
  horas: string;
  horasEditadas: boolean;
  renglones: RenglonBorrador[];
  totalBoleta: string;
  motivo: string;
  observaciones: string;
}

interface Guardado {
  version: 1;
  guardadoEn: number;
  datos: BorradorCompraRuta;
}

/** Lo mínimo de `Storage` que se usa: permite probarlo sin navegador. */
export type Almacen = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const clave = (usuarioId: string) => `mincore:compra-ruta-borrador:${usuarioId}`;

function almacenDelNavegador(): Almacen | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    // Acceder a localStorage puede lanzar (datos del sitio bloqueados).
    return null;
  }
}

/** ¿Hay algo escrito que valga la pena guardar? Un formulario recién abierto
 *  (o recién limpiado) no deja borrador: no hay nada que recuperar y sí habría
 *  un aviso de "recuperamos tu borrador" sin sentido. */
export function borradorTieneContenido(b: BorradorCompraRuta): boolean {
  return (
    b.equipoId !== "" ||
    b.grifoId !== "" ||
    b.comprobanteNumero.trim() !== "" ||
    b.galones !== "" ||
    b.costoUnitario !== "" ||
    b.horometro !== "" ||
    b.odometro !== "" ||
    b.horas !== "" ||
    b.totalBoleta !== "" ||
    b.motivo.trim() !== "" ||
    b.observaciones.trim() !== "" ||
    b.renglones.some((r) => r.cantidad !== "")
  );
}

export function guardarBorrador(
  usuarioId: string,
  datos: BorradorCompraRuta,
  almacen: Almacen | null = almacenDelNavegador(),
  ahora: number = Date.now()
): void {
  if (!almacen) return;
  try {
    if (!borradorTieneContenido(datos)) {
      almacen.removeItem(clave(usuarioId));
      return;
    }
    const guardado: Guardado = { version: 1, guardadoEn: ahora, datos };
    almacen.setItem(clave(usuarioId), JSON.stringify(guardado));
  } catch {
    // Sin espacio o sin acceso: la pantalla sigue funcionando sin borrador.
  }
}

export function borrarBorrador(
  usuarioId: string,
  almacen: Almacen | null = almacenDelNavegador()
): void {
  if (!almacen) return;
  try {
    almacen.removeItem(clave(usuarioId));
  } catch {
    // Igual que arriba.
  }
}

/** El borrador guardado, o null si no hay, venció, o está dañado (un JSON roto
 *  o de otra versión se descarta y se borra: nunca debe romper la pantalla). */
export function leerBorrador(
  usuarioId: string,
  almacen: Almacen | null = almacenDelNavegador(),
  ahora: number = Date.now()
): { datos: BorradorCompraRuta; guardadoEn: number } | null {
  if (!almacen) return null;
  try {
    const crudo = almacen.getItem(clave(usuarioId));
    if (!crudo) return null;
    const g = JSON.parse(crudo) as Partial<Guardado> | null;
    const valido =
      g !== null &&
      typeof g === "object" &&
      g.version === 1 &&
      typeof g.guardadoEn === "number" &&
      g.datos !== undefined &&
      typeof g.datos === "object" &&
      typeof g.datos.clienteUuid === "string" &&
      Array.isArray(g.datos.renglones);
    if (
      !valido ||
      ahora - g.guardadoEn! > VENCIMIENTO_BORRADOR_MS ||
      ahora < g.guardadoEn! - 60_000
    ) {
      almacen.removeItem(clave(usuarioId));
      return null;
    }
    return { datos: g.datos as BorradorCompraRuta, guardadoEn: g.guardadoEn! };
  } catch {
    try {
      almacen.removeItem(clave(usuarioId));
    } catch {
      // Nada más que hacer.
    }
    return null;
  }
}
