import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    tailwindcss(),
    // L'ordre compte : le plugin de Start doit précéder celui de React.
    tanstackStart(),
    viteReact(),
  ],
  resolve: { tsconfigPaths: true },
  server: { port: 3000 },
});
