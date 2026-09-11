// client/src/components/comunes/VentanaFlotante.tsx
//
// Un panel que se comporta como una ventana: se arrastra, se redimensiona,
// convive con otros abiertos al mismo tiempo y puede DESPRENDERSE a una
// ventana real del navegador para llevarlo a otro monitor.
//
// Es lo contrario de un modal, y la diferencia es de criterio, no de estilo:
// un formulario merece bloquear la pantalla porque hay algo a medio cargar
// que se puede perder. Una consulta -- un historial, un kardex, una bandeja
// de alertas -- no: mientras se la mira hay que poder seguir trabajando
// atrás, y a veces mirar dos a la vez. Por eso acá NO hay backdrop.
//
// OJO con los imports: este archivo y ventanasFlotantesEstado.ts son
// HERMANOS, y eslint-plugin-import + ESLint 10 crashea cuando un archivo
// mezcla imports padre (../../x) con hermanos (./x). Si algún día hace
// falta traer algo de más arriba, hay que meterlo por props o duplicarlo,
// como se hizo en components/combustible/gravedadAlertas.ts.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { PointerEvent as PointerEventReact, ReactNode } from "react";
import { createPortal } from "react-dom";

import {
  guardarGeometria,
  leerGeometria,
  liberarSlotCascada,
  olvidarDocumento,
  olvidarPanel,
  recordarDocumento,
  registrarPanel,
  reservarSlotCascada,
  suscribirseAlFoco,
  traerAlFrente,
  Z_BASE,
  zIndexDe,
  type GeometriaPanel,
} from "./ventanasFlotantesEstado";

const ANCHO_MIN = 380;
const ALTO_MIN = 240;
const ANCHO_POR_DEFECTO = 760;
const ALTO_POR_DEFECTO = 560;

/** Cuánto del panel tiene que quedar SIEMPRE dentro de la pantalla. Sin
 *  este tope se lo puede arrastrar hasta perderlo del todo, y como no hay
 *  barra de tareas donde recuperarlo, el único remedio sería borrar
 *  localStorage a mano. */
const MARGEN_VISIBLE = 140;
const ALTO_BARRA = 56;

const X_INICIAL = 96;
const Y_INICIAL = 88;
const PASO_CASCADA = 30;

/** Lee una medida que el gesto dejó escrita en el style del nodo.
 *
 *  NO cambiar esto por `parseFloat(valor) || anterior`, que es la forma
 *  corta y tentadora: `parseFloat("0px")` da 0, que es falsy, así que el
 *  `||` descarta el cero y devuelve el valor viejo. Y acá el cero no es un
 *  caso de borde raro: es EXACTAMENTE la coordenada en la que queda un
 *  panel empujado contra el borde de arriba o de la izquierda, donde lo
 *  frena el tope. Con el `||`, arrastrar un panel contra el borde superior
 *  y recargar lo devolvía a donde estaba antes del arrastre. */
function medidaDelStyle(valor: string, siNoSePuede: number): number {
  const numero = parseFloat(valor);
  return Number.isFinite(numero) ? numero : siNoSePuede;
}

function limitar(valor: number, minimo: number, maximo: number): number {
  return Math.min(Math.max(valor, minimo), Math.max(minimo, maximo));
}

function limitarPosicion(x: number, y: number, ancho: number) {
  return {
    x: limitar(x, MARGEN_VISIBLE - ancho, window.innerWidth - MARGEN_VISIBLE),
    y: limitar(y, 0, window.innerHeight - ALTO_BARRA),
  };
}

/** Mete una geometría dentro de la pantalla actual. Hace falta porque lo
 *  guardado pudo quedar de un monitor que ya no está conectado, o de antes
 *  de achicar la ventana del navegador. */
function acomodarAPantalla(geometria: GeometriaPanel): GeometriaPanel {
  const ancho = limitar(geometria.ancho, ANCHO_MIN, window.innerWidth - 24);
  const alto = limitar(geometria.alto, ALTO_MIN, window.innerHeight - 24);
  return { ...limitarPosicion(geometria.x, geometria.y, ancho), ancho, alto };
}

/** Copia los estilos de esta página al documento de la ventana desprendida,
 *  y los mantiene al día.
 *
 *  Una ventana nueva es un `document` nuevo: no hereda NADA del padre, así
 *  que sin esto el panel sale como HTML crudo. Hay que cubrir los dos
 *  formatos en los que aparece el CSS de la app: en `npm run dev` Vite
 *  inyecta <style> por JavaScript (y los reescribe en caliente con cada
 *  HMR), mientras que en el build son <link rel="stylesheet">.
 *
 *  El MutationObserver es lo que hace que un cambio de CSS en dev llegue
 *  también a la ventana desprendida, en vez de dejarla con el CSS que había
 *  en el momento de abrirla. */
function espejarEstilos(destino: Document): () => void {
  const clones = new Map<HTMLElement, HTMLElement>();

  const sincronizar = () => {
    document.head.querySelectorAll<HTMLElement>("style, link[rel='stylesheet']").forEach((nodo) => {
      const clon = clones.get(nodo);
      if (!clon) {
        const nuevo = destino.importNode(nodo, true) as HTMLElement;
        clones.set(nodo, nuevo);
        destino.head.appendChild(nuevo);
      } else if (clon.textContent !== nodo.textContent) {
        // Un <style> que Vite reescribió en caliente. En un <link> los dos
        // textContent son "" y esta rama no se toca.
        clon.textContent = nodo.textContent;
      }
    });

    clones.forEach((clon, nodo) => {
      if (!nodo.isConnected) {
        clon.remove();
        clones.delete(nodo);
      }
    });
  };

  sincronizar();
  const observador = new MutationObserver(sincronizar);
  observador.observe(document.head, { childList: true, subtree: true, characterData: true });
  return () => observador.disconnect();
}

interface VentanaDesprendida {
  win: Window;
  host: HTMLElement;
  limpiar: () => void;
}

/** Deja el documento de la ventana recién abierta en condiciones de recibir
 *  el portal de React, y devuelve el nodo donde montarlo. */
function prepararVentana(win: Window, titulo: string, alCerrarse: () => void): VentanaDesprendida {
  const doc = win.document;
  doc.title = titulo;

  const viewport = doc.createElement("meta");
  viewport.name = "viewport";
  viewport.content = "width=device-width, initial-scale=1";
  doc.head.appendChild(viewport);

  const base = doc.createElement("style");
  base.textContent = "html,body{height:100%;margin:0;overflow:hidden;}";
  doc.head.appendChild(base);

  const detenerEstilos = espejarEstilos(doc);

  // El tema oscuro de Tailwind es por clase en <html> (darkMode: "class").
  doc.documentElement.className = document.documentElement.className;
  doc.body.className = document.body.className;

  const host = doc.createElement("div");
  host.className = "flex h-full w-full flex-col bg-white text-slate-900";
  doc.body.appendChild(host);

  // El usuario cierra la ventana con la X del sistema: el panel vuelve a la
  // página en vez de desaparecer.
  win.addEventListener("pagehide", alCerrarse);

  // Y al revés: si el padre se recarga o se cierra, la hija no puede quedar
  // viva. Su contenido lo renderiza React desde ACÁ, así que sin padre
  // quedaría una ventana vacía que el usuario tiene que cerrar a mano.
  const cerrarConElPadre = () => win.close();
  window.addEventListener("pagehide", cerrarConElPadre);

  recordarDocumento(doc);

  return {
    win,
    host,
    limpiar: () => {
      win.removeEventListener("pagehide", alCerrarse);
      window.removeEventListener("pagehide", cerrarConElPadre);
      detenerEstilos();
      olvidarDocumento(doc);
    },
  };
}

export interface VentanaFlotanteProps {
  /** Identifica al panel en la pila de foco y en localStorage. Estable: si
   *  cambia, el panel se olvida de dónde estaba. */
  id: string;
  titulo: string;
  subtitulo?: string;
  onCerrar: () => void;
  anchoInicial?: number;
  altoInicial?: number;
  /** Los bloques del panel, tal como iban dentro del modal: las barras
   *  fijas con `shrink-0` y el área que scrollea con `flex-1 min-h-0`. */
  children: ReactNode;
}

export default function VentanaFlotante({
  id,
  titulo,
  subtitulo,
  onCerrar,
  anchoInicial = ANCHO_POR_DEFECTO,
  altoInicial = ALTO_POR_DEFECTO,
  children,
}: VentanaFlotanteProps) {
  const marcoRef = useRef<HTMLDivElement | null>(null);
  const desprendidaRef = useRef<VentanaDesprendida | null>(null);
  const cierreDiferidoRef = useRef<number | null>(null);

  // `host` es el nodo del documento hijo donde va el portal. Vive en estado
  // -- y no solo en el ref -- porque el render depende de él.
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [avisoDesprender, setAvisoDesprender] = useState<string | null>(null);

  const [geometria, setGeometria] = useState<GeometriaPanel>(() => {
    const guardada = leerGeometria(id);
    if (guardada) return acomodarAPantalla(guardada);
    // Sin nada guardado, cascada: cada panel nuevo baja y corre un poco
    // respecto de los que ya están abiertos, para que el de abajo no quede
    // escondido justo detrás del de arriba.
    const paso = reservarSlotCascada(id) * PASO_CASCADA;
    return acomodarAPantalla({
      x: X_INICIAL + paso,
      y: Y_INICIAL + paso,
      ancho: anchoInicial,
      alto: altoInicial,
    });
  });

  const zIndex = useSyncExternalStore(
    suscribirseAlFoco,
    () => zIndexDe(id),
    () => Z_BASE
  );

  useEffect(() => {
    registrarPanel(id);
    return () => olvidarPanel(id);
  }, [id]);

  // Al achicar la ventana del navegador, un panel puede quedar fuera de la
  // pantalla. Se lo trae de vuelta en lugar de darlo por perdido.
  useEffect(() => {
    const alRedimensionar = () => setGeometria((actual) => acomodarAPantalla(actual));
    window.addEventListener("resize", alRedimensionar);
    return () => window.removeEventListener("resize", alRedimensionar);
  }, []);

  useEffect(() => {
    const desprendida = desprendidaRef.current;
    if (desprendida && !desprendida.win.closed) desprendida.win.document.title = titulo;
  }, [titulo, host]);

  // Cerrar la ventana desprendida cuando este componente se va del todo
  // (por ejemplo, si el usuario cambia de módulo con un panel afuera).
  //
  // El cierre va DIFERIDO un tick a propósito: en dev, <React.StrictMode>
  // monta, desmonta y vuelve a montar cada componente, y un cierre directo
  // acá haría que desprender "no funcione" con `npm run dev` pero sí en
  // producción. Al re-montar, el efecto cancela el cierre pendiente; en un
  // desmontaje de verdad no lo cancela nadie y la ventana se cierra.
  useEffect(() => {
    if (cierreDiferidoRef.current !== null) {
      window.clearTimeout(cierreDiferidoRef.current);
      cierreDiferidoRef.current = null;
    }
    return () => {
      cierreDiferidoRef.current = window.setTimeout(() => {
        cierreDiferidoRef.current = null;
        liberarSlotCascada(id);
        const desprendida = desprendidaRef.current;
        desprendidaRef.current = null;
        if (!desprendida) return;
        desprendida.limpiar();
        if (!desprendida.win.closed) desprendida.win.close();
      }, 0);
    };
  }, [id]);

  const fijarGeometria = (nueva: GeometriaPanel) => {
    setGeometria(nueva);
    guardarGeometria(id, nueva);
  };

  /** Arrastre y redimensión comparten esto: mientras dura el gesto se
   *  escribe directo sobre el style del nodo, sin pasar por el estado de
   *  React. Con tablas de cien filas adentro, un re-render por cada
   *  `pointermove` se nota. El estado se actualiza una sola vez, al
   *  soltar. */
  const seguirGesto = (
    evento: PointerEventReact,
    alMover: (dx: number, dy: number) => void,
    alSoltar: () => void
  ) => {
    evento.preventDefault();
    const xInicial = evento.clientX;
    const yInicial = evento.clientY;
    const seleccionPrevia = document.body.style.userSelect;
    document.body.style.userSelect = "none";

    const mover = (ev: globalThis.PointerEvent) =>
      alMover(ev.clientX - xInicial, ev.clientY - yInicial);

    const terminar = () => {
      window.removeEventListener("pointermove", mover);
      window.removeEventListener("pointerup", terminar);
      window.removeEventListener("pointercancel", terminar);
      document.body.style.userSelect = seleccionPrevia;
      alSoltar();
    };

    window.addEventListener("pointermove", mover);
    window.addEventListener("pointerup", terminar);
    window.addEventListener("pointercancel", terminar);
  };

  const iniciarArrastre = (evento: PointerEventReact<HTMLDivElement>) => {
    // Desprendida, la que manda es la ventana del sistema operativo.
    if (host) return;
    // Un clic en "Desprender" o en la X no es el comienzo de un arrastre.
    if ((evento.target as HTMLElement).closest("button")) return;

    const marco = marcoRef.current;
    if (!marco) return;
    const inicial = geometria;

    seguirGesto(
      evento,
      (dx, dy) => {
        const { x, y } = limitarPosicion(inicial.x + dx, inicial.y + dy, inicial.ancho);
        marco.style.left = `${x}px`;
        marco.style.top = `${y}px`;
      },
      () => {
        fijarGeometria({
          ...inicial,
          x: medidaDelStyle(marco.style.left, inicial.x),
          y: medidaDelStyle(marco.style.top, inicial.y),
        });
      }
    );
  };

  const iniciarRedimension = (evento: PointerEventReact<HTMLDivElement>) => {
    const marco = marcoRef.current;
    if (!marco) return;
    const inicial = geometria;

    // Agrandar no puede empujar la barra de título fuera de la pantalla:
    // los botones de desprender y cerrar viven en su punta derecha, y si
    // salen del borde no hay forma de cerrar el panel salvo achicarlo de
    // nuevo a ciegas. El tope del ARRASTRE es otra cosa y a propósito: ahí
    // el usuario está corriendo el panel y lo puede traer de vuelta.
    const anchoMaximo = Math.max(window.innerWidth - inicial.x, ANCHO_MIN);
    const altoMaximo = Math.max(window.innerHeight - inicial.y, ALTO_MIN);

    seguirGesto(
      evento,
      (dx, dy) => {
        marco.style.width = `${limitar(inicial.ancho + dx, ANCHO_MIN, anchoMaximo)}px`;
        marco.style.height = `${limitar(inicial.alto + dy, ALTO_MIN, altoMaximo)}px`;
      },
      () => {
        fijarGeometria({
          ...inicial,
          ancho: medidaDelStyle(marco.style.width, inicial.ancho),
          alto: medidaDelStyle(marco.style.height, inicial.alto),
        });
      }
    );
  };

  const volverALaPagina = () => {
    const desprendida = desprendidaRef.current;
    desprendidaRef.current = null;
    setHost(null);
    if (!desprendida) return;
    desprendida.limpiar();
    if (!desprendida.win.closed) desprendida.win.close();
  };

  const desprender = () => {
    if (desprendidaRef.current) return;
    setAvisoDesprender(null);

    // `window.open` va acá, en el handler del clic, y no dentro de un
    // efecto: los navegadores solo dejan abrir ventanas mientras dura la
    // interacción del usuario, y desde un efecto el bloqueador de popups
    // corta.
    const win = window.open(
      "",
      `panel-flotante-${id}`,
      [
        "popup=yes",
        `width=${Math.round(geometria.ancho)}`,
        `height=${Math.round(geometria.alto)}`,
        `left=${Math.round(window.screenX + geometria.x)}`,
        `top=${Math.round(window.screenY + geometria.y)}`,
      ].join(",")
    );

    if (!win) {
      setAvisoDesprender("El navegador bloqueó la ventana. Permití las ventanas emergentes.");
      return;
    }

    const desprendida = prepararVentana(win, titulo, volverALaPagina);
    desprendidaRef.current = desprendida;
    setHost(desprendida.host);
  };

  const barra = (
    <div
      onPointerDown={iniciarArrastre}
      className={`flex shrink-0 items-start justify-between gap-3 border-b bg-slate-50 px-5 py-3 ${
        host ? "" : "cursor-move select-none"
      }`}
    >
      <div className="min-w-0">
        <h3 className="truncate text-base font-bold" title={titulo}>
          {titulo}
        </h3>
        {subtitulo && (
          <p className="truncate text-xs text-slate-500" title={subtitulo}>
            {subtitulo}
          </p>
        )}
        {avisoDesprender && <p className="text-xs font-medium text-red-600">{avisoDesprender}</p>}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <button
          onClick={host ? volverALaPagina : desprender}
          className="rounded-lg px-2 py-1 text-lg leading-none text-slate-400 transition-colors hover:bg-slate-200 hover:text-slate-900"
          title={host ? "Traer el panel de vuelta a la página" : "Desprender a otra ventana"}
          aria-label={host ? "Traer el panel de vuelta a la página" : "Desprender a otra ventana"}
        >
          {host ? "⊞" : "⧉"}
        </button>
        <button
          onClick={onCerrar}
          className="rounded-lg px-2 py-1 text-2xl leading-none text-slate-400 transition-colors hover:bg-slate-200 hover:text-slate-900"
          title="Cerrar"
          aria-label="Cerrar"
        >
          ×
        </button>
      </div>
    </div>
  );

  if (host) {
    return createPortal(
      <>
        {barra}
        {children}
      </>,
      host
    );
  }

  return (
    <div
      ref={marcoRef}
      // Cualquier clic dentro lo trae al frente. En `capture` para que
      // llegue igual si un hijo corta la propagación.
      onPointerDownCapture={() => traerAlFrente(id)}
      style={{
        left: geometria.x,
        top: geometria.y,
        width: geometria.ancho,
        height: geometria.alto,
        zIndex,
      }}
      className="fixed flex flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
      role="dialog"
      aria-label={titulo}
    >
      {barra}
      {children}
      {/* La esquina para agrandar. Es de 20px y no de 16 porque el
          `overflow-hidden` del marco, combinado con las esquinas
          redondeadas, recorta justo la punta -- que es adonde apunta el
          usuario. Los píxeles de más van hacia adentro, donde no hay
          recorte, y ahí es donde queda el área agarrable de verdad. */}
      <div
        onPointerDown={iniciarRedimension}
        className="absolute bottom-0 right-0 h-5 w-5 cursor-nwse-resize text-slate-300"
        aria-hidden="true"
      >
        <svg viewBox="0 0 20 20" className="h-5 w-5 fill-current">
          <path d="M20 20h-9l9-9z" />
        </svg>
      </div>
    </div>
  );
}
