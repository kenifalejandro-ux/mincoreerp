// client/src/services/recaptcha.ts

/** reCAPTCHA v3: sin checkbox ni desafío visible, solo un token por acción
 *  que el backend valida contra Google (ver verifyRecaptcha.ts). El sitio
 *  y el secreto ya estaban configurados (RECAPTCHA_SITE_KEY/SECRET_KEY y
 *  los dominios en la consola de Google) desde antes -- lo que faltaba era
 *  este lado: cargar el script y pedirle el token al enviar el formulario.
 *
 *  Sin `VITE_RECAPTCHA_SITE_KEY` (por ejemplo en desarrollo local) no se
 *  genera token y el login sigue sin él -- el servidor solo lo exige en
 *  producción (`env.isProduction` en auth.ts). */
const siteKey = import.meta.env.VITE_RECAPTCHA_SITE_KEY as string | undefined;

declare global {
  interface Window {
    grecaptcha?: {
      ready(cb: () => void): void;
      execute(siteKey: string, options: { action: string }): Promise<string>;
    };
  }
}

let cargaScript: Promise<void> | null = null;

function cargarScriptRecaptcha(): Promise<void> {
  if (cargaScript) return cargaScript;

  cargaScript = new Promise((resolve, reject) => {
    if (window.grecaptcha) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = `https://www.google.com/recaptcha/api.js?render=${siteKey}`;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("No se pudo cargar reCAPTCHA"));
    document.head.appendChild(script);
  });

  return cargaScript;
}

/** `action` tiene que coincidir con `RECAPTCHA_EXPECTED_ACTION` del servidor
 *  (default "submit", ver env.ts) para que la validación de Google no la
 *  rechace por acción distinta. */
export async function obtenerTokenRecaptcha(action = "submit"): Promise<string | null> {
  if (!siteKey) return null;

  try {
    await cargarScriptRecaptcha();
    return await new Promise<string>((resolve, reject) => {
      window.grecaptcha!.ready(() => {
        window.grecaptcha!.execute(siteKey, { action }).then(resolve).catch(reject);
      });
    });
  } catch {
    // Sin token el servidor responde 400 con un mensaje claro -- mejor eso
    // que dejar el formulario colgado si Google/el script fallan.
    return null;
  }
}
