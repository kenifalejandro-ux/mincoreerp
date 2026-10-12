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

/** Los módulos que alimentan la Bandeja y quién ve las alertas de cada uno.
 *  Hoy solo Combustible genera alertas; cuando otro módulo las tenga, se agrega
 *  una entrada acá y su pantalla en BandejaView. */
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
];

/** ¿Ve este usuario alguna pestaña de la Bandeja? Lo usan el menú y el ruteo. */
export function puedeVerBandeja(usuario: UsuarioParaBandeja | null | undefined): boolean {
  return !!usuario && MODULOS_CON_BANDEJA.some((m) => m.visiblePara(usuario));
}
