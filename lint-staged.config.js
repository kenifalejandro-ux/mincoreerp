import path from "node:path";

// client/ es un paquete npm separado (eslint.config.js, tsconfig y
// node_modules propios) -- eslint/prettier de la raíz lo ignoran a
// propósito (ver globalIgnores en eslint.config.js), así que sus archivos
// necesitan correr con los binarios instalados dentro de client/.
export default {
  "client/**/*.{js,jsx,ts,tsx}": (filenames) => {
    const clientDir = path.join(process.cwd(), "client");
    const relative = filenames.map((f) => path.relative(clientDir, f)).join(" ");
    return [`sh -c "cd client && eslint --fix ${relative} && prettier --write ${relative}"`];
  },
  // Una sola regla para todo lo que NO es client/. Antes eran dos ("!(client)/**"
  // y "*.{ts,js}") que se pisaban: los archivos de subcarpetas corrían eslint y
  // prettier dos veces, y "*.{ts,js}" además atrapaba los de client/, que la
  // raíz ignora a propósito.
  "*.{ts,js}": (filenames) => {
    const fuera = filenames
      .filter((f) => !path.relative(process.cwd(), f).startsWith(`client${path.sep}`))
      .map((f) => JSON.stringify(f))
      .join(" ");
    return fuera ? [`eslint --fix ${fuera}`, `prettier --write ${fuera}`] : [];
  },
};
