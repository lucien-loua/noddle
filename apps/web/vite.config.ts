import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  define: {
    "process.env.NODDLE_COMMIT": JSON.stringify(
      process.env.NODDLE_COMMIT ?? ""
    ),
    "process.env.NODDLE_VERSION": JSON.stringify(
      process.env.NODDLE_VERSION ?? ""
    ),
  },
  optimizeDeps: {
    exclude: ["@noddle/ssh-executor", "ssh2", "cpu-features"],
  },
  plugins: [tailwindcss(), tanstackStart(), viteReact()],
  resolve: { tsconfigPaths: true },
  server: {
    hmr: {
      clientPort: Number(process.env.VITE_HMR_PORT ?? 24_678),
      host: "localhost",
      port: Number(process.env.VITE_HMR_PORT ?? 24_678),
    },
    host: "127.0.0.1",
    port: Number(process.env.VITE_DEV_PORT ?? 5173),
    strictPort: true,
  },
  ssr: {
    external: ["ssh2", "cpu-features"],
    optimizeDeps: { exclude: ["ssh2", "cpu-features"] },
  },
});
