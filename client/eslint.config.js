import js from "@eslint/js";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import { defineConfig, globalIgnores } from "eslint/config";
import eslintConfigPrettier from "eslint-config-prettier";
import importPlugin from "eslint-plugin-import";
import jsxA11y from "eslint-plugin-jsx-a11y";
import prettierPlugin from "eslint-plugin-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";

export default defineConfig([
  // meshoptimizer/ es una librería de terceros vendorizada (C++/WASM,
  // ~130MB) que el código de la app no importa en ningún lado -- sin este
  // ignore, eslint intenta parsear sus .ts (algunos ni son TypeScript real,
  // son archivos de dependencias de CMake) y se cuelga.
  globalIgnores(["dist", "meshoptimizer"]),
  {
    // Configs de build en la raíz de client/ -- corren en Node (CommonJS),
    // no en el browser, así que necesitan `require`/`__dirname` como
    // globals conocidos.
    files: ["*.config.js"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["**/*.{js,jsx}"],
    extends: [
      js.configs.recommended,
      reactRefresh.configs.vite,
      eslintConfigPrettier, // desactiva reglas en conflicto con Prettier
    ],
    plugins: {
      "react-hooks": reactHooks,
      "jsx-a11y": jsxA11y,
      import: importPlugin,
      prettier: prettierPlugin,
    },
    languageOptions: {
      ecmaVersion: "latest",
      globals: globals.browser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        sourceType: "module",
      },
    },
    rules: {
      // eslint-plugin-react-hooks@7.1.1 exporta `recommended-latest` con
      // `plugins: ["react-hooks"]` en formato viejo (array de strings),
      // que eslint@10 rechaza en flat config -- por eso no va en
      // `extends` de arriba, tomamos solo sus reglas acá.
      ...reactHooks.configs["recommended-latest"].rules,

      // Errores comunes
      "no-unused-vars": ["error", { varsIgnorePattern: "^[A-Z_]" }],
      "no-console": ["warn", { allow: ["warn", "error"] }],

      // Estilo básico
      quotes: "off",
      semi: ["error", "always"],

      // Accesibilidad
      "jsx-a11y/alt-text": "warn",

      // Orden de imports
      "import/order": [
        "warn",
        {
          groups: [["builtin", "external", "internal"]],
          "newlines-between": "always",
          alphabetize: { order: "asc", caseInsensitive: true },
        },
      ],

      // Forzar a que Prettier valide formato
      "prettier/prettier": "error",
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [js.configs.recommended, reactRefresh.configs.vite, eslintConfigPrettier],
    plugins: {
      "react-hooks": reactHooks,
      "@typescript-eslint": tsPlugin,
      "jsx-a11y": jsxA11y,
      import: importPlugin,
      prettier: prettierPlugin,
    },
    languageOptions: {
      ecmaVersion: "latest",
      globals: globals.browser,
      parser: tsParser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        sourceType: "module",
      },
    },
    rules: {
      // Mismo motivo que arriba: tomamos solo las reglas, no el objeto
      // `extends` completo (su `plugins` en formato viejo revienta con
      // eslint@10).
      ...reactHooks.configs["recommended-latest"].rules,

      "no-undef": "off",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { varsIgnorePattern: "^[A-Z_]", argsIgnorePattern: "^_" },
      ],
      "no-console": ["warn", { allow: ["warn", "error"] }],
      quotes: "off",
      semi: ["error", "always"],
      "jsx-a11y/alt-text": "warn",
      "import/order": [
        "warn",
        {
          groups: [["builtin", "external", "internal"]],
          "newlines-between": "always",
          alphabetize: { order: "asc", caseInsensitive: true },
        },
      ],
      "prettier/prettier": "error",
    },
  },
  {
    // eslint-plugin-import@2.x + eslint@10 (flat config): el autofix de
    // import/order crashea con TypeError en ciertos archivos con imports
    // multi-línea mezclados (bug de compatibilidad de herramientas, no del
    // código -- el orden en estos dos está verificado a mano). Mientras no
    // se actualice eslint-plugin-import, se apaga solo acá.
    files: ["src/components/UreaPanel.tsx", "src/components/combustible/CombustiblePanel.tsx"],
    rules: {
      "import/order": "off",
    },
  },
]);
