import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Relative base so the build works at https://<org>.github.io/<repo>/ without knowing the repo name.
// Routing uses HashRouter, so GitHub Pages never needs to serve deep links.
export default defineConfig({
  base: "./",
  plugins: [react()],
  server: { port: 5173 },
});
