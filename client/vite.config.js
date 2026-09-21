import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react-swc"; // Si ya lo cambiaste, genial; si no, hacelo ahora
import path from "path";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import svgr from "vite-plugin-svgr"; // ← Nueva importación

function manualChunks(id) {
  if (!id.includes("node_modules")) return;

  if (id.includes("/react/") || id.includes("/react-dom/") || id.includes("/scheduler/")) {
    return "vendor-react";
  }

  if (id.includes("/recharts/")) {
    return "vendor-charts";
  }

  // xlsx solo se importa dinámicamente (carga masiva de repuestos): se deja
  // fuera de vendor-misc para que Rollup le arme su propio chunk on-demand,
  // en vez de agruparlo con código que sí viaja en la carga inicial.
  if (id.includes("/xlsx/")) {
    return;
  }

  return "vendor-misc";
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    svgr({ exportAsDefault: true }), // ⚡ Esto asegura que default export sea componente React
    VitePWA({
      // Registro manual en src/main.tsx vía virtual:pwa-register, no
      // inyectado automáticamente por el plugin.
      injectRegister: null,
      registerType: "autoUpdate",
      includeAssets: ["favicon.ico", "favicon.svg", "apple-touch-icon-180x180.png"],
      manifest: {
        name: "MinCore ERP",
        short_name: "MinCore",
        lang: "es-PE",
        description:
          "ERP para el sector minero: gestión de repuestos, combustible y documentos de vencimiento",
        theme_color: "#C9E600",
        background_color: "#0A1014",
        start_url: "/",
        display: "standalone",
        icons: [
          { src: "pwa-64x64.png", sizes: "64x64", type: "image/png" },
          { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png" },
          {
            src: "maskable-icon-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        // navigateFallback es lo único que podría interceptar una URL no
        // precacheada al navegar offline, así que se excluye /api
        // explícitamente aunque Workbox solo lo aplica a navegaciones de
        // documento, no a los fetch() de apiClient.ts.
        navigateFallbackDenylist: [/^\/api\//],
        // ── Catálogos para poder llenar un checklist sin señal ──────────
        //
        // Sin esto, el motor offline sirve de poco: el operario puede
        // guardar el checklist en la cola, pero no puede ARMARLO — los
        // selectores de equipo y plantilla salen vacíos porque sus GET
        // fallan. Estas son las tres lecturas que necesita el formulario.
        //
        // NetworkFirst y no StaleWhileRevalidate: con red, siempre gana el
        // dato fresco (un equipo dado de baja no debe seguir apareciendo
        // porque quedó en caché). El caché es la red de contención para
        // cuando no hay señal, no la fuente preferida.
        //
        // Alcance deliberadamente angosto: SOLO estos tres GET de catálogo.
        // No hay ninguna regla que toque /api/auth/* (nunca cachear
        // sesión), /api/eventos/stream (una entrada de caché rompe el SSE)
        // ni el listado de checklists llenados (dato vivo, no catálogo).
        // Todo lo demás sigue yendo a la red sin intermediarios.
        //
        // El nombre del caché arranca con "erp-catalogos" porque
        // offline/sesionOffline.ts lo borra por prefijo al cerrar sesión:
        // el caché es por ORIGEN, así que en una tablet compartida los
        // equipos de un tenant se le servirían al siguiente que entre.
        runtimeCaching: [
          {
            urlPattern: ({ url, request }) =>
              request.method === "GET" &&
              (url.pathname === "/api/erp/equipos" ||
                /^\/api\/erp\/checklists\/plantillas(\/\d+)?$/.test(url.pathname) ||
                // IPERC reutiliza este mismo caché: solo lectura del
                // catálogo de líneas base aprobadas, no participa de la
                // cola offline (esa es config de oficina, ver ADR-0002).
                /^\/api\/erp\/iperc\/lineas-base(\/\d+)?$/.test(url.pathname) ||
                // Los puntos precintados de un tanque (0095): la varilla se
                // toma en cancha sin señal y el formulario los necesita para
                // saber qué sellos pedir.
                /^\/api\/erp\/combustible\/\d+\/precintos$/.test(url.pathname) ||
                // Las sedes y grifos internos (0097): el alta de equipo, que
                // funciona sin red, necesita la lista para su selector.
                url.pathname === "/api/erp/sedes"),
            handler: "NetworkFirst",
            options: {
              cacheName: "erp-catalogos-v1",
              // Sin esto, offline el fetch queda colgado hasta el timeout
              // del sistema operativo antes de caer al caché — con señal
              // intermitente eso es una espera larga con la pantalla
              // vacía.
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 100, maxAgeSeconds: 60 * 60 * 24 * 30 },
              // Solo respuestas OK: cachear un 401/403 dejaría al operario
              // viendo "sin permiso" en modo offline hasta que expire.
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    host: true, // 🔥 ESTO ES LA CLAVE
    port: 5174,
    open: false,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks,
      },
    },
  },
});
