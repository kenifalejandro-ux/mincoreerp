// client/src/components/bandeja/bandejaAcceso.ts
//
// Quién ve qué en la Bandeja de alertas. Va aparte de BandejaView.tsx para que
// App.tsx y el menú puedan preguntar "¿ve la Bandeja?" sin importar la vista
// (que se carga perezosa, ver App.tsx).

export interface UsuarioParaBandeja {
  rol: string;
  modulosPermitidos: string[];
  permisosPestanas?: Record<string, boolean>;
}

/** Las pantallas de la Bandeja y quién ve cada una: una pestaña por módulo que tiene sus alertas.
 *  Combustible (con Urea) y Viajes (0188) tienen la suya, cada una de su propia tabla y su propio
 *  endpoint. Cuando otro módulo tenga las suyas, se agrega una entrada acá y su pantalla en
 *  BandejaView. */
export const MODULOS_CON_BANDEJA: {
  id: string;
  etiqueta: string;
  visiblePara: (usuario: UsuarioParaBandeja) => boolean;
}[] = [
  {
    id: "combustible",
    etiqueta: "Combustible",
    // Las mismas alertas que la pestaña "Alertas" de Tanques: el servidor
    // exige admin u operador (y ese permiso por usuario si se lo cambiaron).
    visiblePara: (u) => {
      if (!u.modulosPermitidos.includes("combustible")) return false;
      const override = u.permisosPestanas?.["combustible:tanques:alertas"];
      if (override !== undefined) return override;
      return u.rol === "admin" || u.rol === "operador";
    },
  },
  {
    id: "viajes",
    etiqueta: "Viajes",
    // Mismo permiso que la de Combustible (la clave de siempre, `combustible:tanques:alertas`) pero
    // con el módulo Viajes: funciona sin Combustible. El servidor exige lo mismo.
    visiblePara: (u) => {
      if (!u.modulosPermitidos.includes("viajes")) return false;
      const override = u.permisosPestanas?.["combustible:tanques:alertas"];
      if (override !== undefined) return override;
      return u.rol === "admin" || u.rol === "operador";
    },
  },
];

/** ¿Ve este usuario alguna pestaña de la Bandeja? Lo usan el menú y el ruteo. */
export function puedeVerBandeja(usuario: UsuarioParaBandeja | null | undefined): boolean {
  return !!usuario && MODULOS_CON_BANDEJA.some((m) => m.visiblePara(usuario));
}
